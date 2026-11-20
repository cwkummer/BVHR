/**
 * Google ID token verification and session/ticket JWT hardening. Tokens are signed with a locally
 * generated RSA key and Google's JWKS endpoint is faked, so every rejection path is exercised for real.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sign } from "hono/jwt";
import {
  GoogleKeysUnavailableError,
  mintSessionToken,
  mintWsTicket,
  resetGoogleKeyCache,
  verifyGoogleIdTokenWithJwks,
  verifySessionToken,
  verifyWsTicket
} from "../auth";

const CLIENT_ID = "test-client.apps.googleusercontent.com";
const KID = "test-key-1";
const enc = new TextEncoder();
const b64url = (data: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof data === "string" ? enc.encode(data) : new Uint8Array(data);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

let privateKey: CryptoKey;
let jwksFetches = 0;
let jwksResponse: () => Response | Promise<Response>;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  privateKey = pair.privateKey;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: KID, use: "sig", alg: "RS256" };
  jwksResponse = () =>
    new Response(JSON.stringify({ keys: [jwk] }), { headers: { "Cache-Control": "public, max-age=3600" } });
  globalThis.fetch = (async () => {
    jwksFetches++;
    return jwksResponse();
  }) as unknown as typeof fetch;
});

const nowSec = () => Math.floor(Date.now() / 1000);

/** Builds a Google-style ID token signed with the test key (or a custom signing step). */
async function idToken(
  claims: Record<string, unknown> = {},
  opts: { header?: Record<string, unknown>; tamper?: boolean } = {}
): Promise<string> {
  const header = { alg: "RS256", kid: KID, typ: "JWT", ...opts.header };
  const payload = {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "google-sub-123",
    email: "Player@Example.com",
    email_verified: true,
    name: "Player One",
    exp: nowSec() + 3600,
    ...claims
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, enc.encode(signingInput));
  const token = `${signingInput}.${b64url(sig)}`;
  if (!opts.tamper) return token;
  // Same signature, different payload.
  const [h, , s] = token.split(".");
  return `${h}.${b64url(JSON.stringify({ ...payload, sub: "someone-else" }))}.${s}`;
}

describe("Google ID token verification", () => {
  test("accepts a valid token and normalizes the result", async () => {
    const r = await verifyGoogleIdTokenWithJwks(await idToken(), CLIENT_ID);
    expect(r).toEqual({ googleSub: "google-sub-123", email: "player@example.com", name: "Player One", isDefaultAdventurer: false });
  });

  test("accepts the bare `accounts.google.com` issuer", async () => {
    await expect(verifyGoogleIdTokenWithJwks(await idToken({ iss: "accounts.google.com" }), CLIENT_ID)).resolves.toBeDefined();
  });

  test("display name is capped at 20 characters, and falls back to the email prefix when there is no name", async () => {
    const long = await verifyGoogleIdTokenWithJwks(await idToken({ name: "x".repeat(50) }), CLIENT_ID);
    expect(long.name).toHaveLength(20);
    const noName = await verifyGoogleIdTokenWithJwks(await idToken({ name: undefined }), CLIENT_ID);
    expect(noName.name).toBe("Player");
  });

  const rejected: Array<[string, Record<string, unknown>]> = [
    ["wrong audience", { aud: "someone-elses-client-id" }],
    ["array audience", { aud: [CLIENT_ID] }],
    ["wrong issuer", { iss: "https://evil.example.com" }],
    ["expired", { exp: nowSec() - 10 }],
    ["missing exp", { exp: undefined }],
    ["not yet valid (nbf far in the future)", { nbf: nowSec() + 3600 }],
    ["unverified email", { email_verified: false }],
    ["email_verified as a string", { email_verified: "true" }],
    ["missing email", { email: undefined }],
    ["missing sub", { sub: undefined }]
  ];
  for (const [name, claims] of rejected) {
    test(`rejects: ${name}`, async () => {
      await expect(verifyGoogleIdTokenWithJwks(await idToken(claims), CLIENT_ID)).rejects.toThrow();
    });
  }

  test("rejects a token whose payload was changed after signing", async () => {
    await expect(verifyGoogleIdTokenWithJwks(await idToken({}, { tamper: true }), CLIENT_ID)).rejects.toThrow("signature");
  });

  test("rejects other algorithms and a missing or unknown key id", async () => {
    await expect(verifyGoogleIdTokenWithJwks(await idToken({}, { header: { alg: "HS256" } }), CLIENT_ID)).rejects.toThrow();
    await expect(verifyGoogleIdTokenWithJwks(await idToken({}, { header: { alg: "none" } }), CLIENT_ID)).rejects.toThrow();
    await expect(verifyGoogleIdTokenWithJwks(await idToken({}, { header: { kid: undefined } }), CLIENT_ID)).rejects.toThrow();
    await expect(verifyGoogleIdTokenWithJwks(await idToken({}, { header: { kid: "unknown-key" } }), CLIENT_ID)).rejects.toThrow();
  });

  test("rejects malformed tokens without crashing", async () => {
    for (const bad of ["", "a.b", "a.b.c.d", "not a token", "!!!.???.***", `${b64url("null")}.${b64url("null")}.x`]) {
      await expect(verifyGoogleIdTokenWithJwks(bad, CLIENT_ID)).rejects.toThrow();
    }
  });

  test("Google's keys are fetched once and cached across verifications", async () => {
    const before = jwksFetches;
    await verifyGoogleIdTokenWithJwks(await idToken(), CLIENT_ID);
    await verifyGoogleIdTokenWithJwks(await idToken(), CLIENT_ID);
    expect(jwksFetches).toBe(before);
  });
});

describe("Google key outage", () => {
  const realNow = Date.now;
  const healthy = () => jwksResponse;
  afterEach(() => {
    Date.now = realNow;
  });

  test("with keys already cached, an outage does not stop sign-in, and Google is not hammered meanwhile", async () => {
    const working = healthy();
    resetGoogleKeyCache();
    await verifyGoogleIdTokenWithJwks(await idToken(), CLIENT_ID); // warms the cache
    // Two hours later the cached keys are stale, and Google is down.
    Date.now = () => realNow() + 2 * 3600 * 1000;
    jwksResponse = () => new Response("down", { status: 503 });
    const before = jwksFetches;
    await expect(verifyGoogleIdTokenWithJwks(await idToken({ exp: Math.floor(Date.now() / 1000) + 600 }), CLIENT_ID)).resolves.toBeDefined();
    expect(jwksFetches).toBe(before + 1);
    // The failed refresh is not retried on every request.
    await verifyGoogleIdTokenWithJwks(await idToken({ exp: Math.floor(Date.now() / 1000) + 600 }), CLIENT_ID);
    expect(jwksFetches).toBe(before + 1);
    jwksResponse = working;
  });

  test("with no keys at all, an outage is reported as such (not as a bad credential), and recovery is automatic", async () => {
    const working = healthy();
    resetGoogleKeyCache();
    jwksResponse = () => new Response("down", { status: 500 });
    await expect(verifyGoogleIdTokenWithJwks(await idToken(), CLIENT_ID)).rejects.toBeInstanceOf(GoogleKeysUnavailableError);
    jwksResponse = () => {
      throw new Error("network unreachable");
    };
    await expect(verifyGoogleIdTokenWithJwks(await idToken(), CLIENT_ID)).rejects.toBeInstanceOf(GoogleKeysUnavailableError);
    jwksResponse = working;
    await expect(verifyGoogleIdTokenWithJwks(await idToken(), CLIENT_ID)).resolves.toBeDefined();
  });

  test("a genuinely bad token is still a plain rejection while keys are available", async () => {
    resetGoogleKeyCache();
    const err = await verifyGoogleIdTokenWithJwks(await idToken({ aud: "other" }), CLIENT_ID).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GoogleKeysUnavailableError);
  });
});

describe("session tokens and WebSocket tickets", () => {
  const SECRET = "unit-test-secret-of-sufficient-length";

  test("a session token verifies for its user; a bad, missing or foreign token does not", async () => {
    const token = await mintSessionToken(SECRET, "u1", "Alice");
    expect(await verifySessionToken(`Bearer ${token}`, SECRET)).toBe("u1");
    expect(await verifySessionToken(token, SECRET)).toBeNull(); // no Bearer prefix
    expect(await verifySessionToken(undefined, SECRET)).toBeNull();
    expect(await verifySessionToken(`Bearer ${token}`, "another-secret-entirely-different")).toBeNull();
    expect(await verifySessionToken(`Bearer ${token}x`, SECRET)).toBeNull();
  });

  test("an expired session token is rejected", async () => {
    const old = await mintSessionToken(SECRET, "u1", "Alice", Date.now() - 25 * 3600 * 1000);
    expect(await verifySessionToken(`Bearer ${old}`, SECRET)).toBeNull();
  });

  test("session tokens last 24 hours; tickets last 20 seconds", async () => {
    const claims = (t: string) => JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    const now = nowSec();
    const session = claims(await mintSessionToken(SECRET, "u1", "A"));
    expect(session.exp - now).toBeGreaterThan(24 * 3600 - 5);
    expect(session.exp - now).toBeLessThanOrEqual(24 * 3600);
    const ticket = claims(await mintWsTicket(SECRET, "u1", "na-overworld-1"));
    expect(ticket.exp - now).toBeGreaterThan(15);
    expect(ticket.exp - now).toBeLessThanOrEqual(20);
  });

  test("a ticket is accepted for its 20 seconds and rejected after", async () => {
    const minted = Date.now();
    const at = async (ageSec: number) => verifyWsTicket(await mintWsTicket(SECRET, "u1", "na-overworld-1", minted - ageSec * 1000), SECRET, "na-overworld-1");
    expect(await at(0)).toBe("u1");
    expect(await at(15)).toBe("u1");
    expect(await at(25)).toBeNull();
    expect(await at(60)).toBeNull();
  });

  test("a ticket only works for its own room and its own scope, and a session token is not a ticket", async () => {
    const ticket = await mintWsTicket(SECRET, "u1", "na-overworld-1");
    expect(await verifyWsTicket(ticket, SECRET, "na-overworld-1")).toBe("u1");
    expect(await verifyWsTicket(ticket, SECRET, "na-overworld-2")).toBeNull();
    expect(await verifySessionToken(`Bearer ${ticket}`, SECRET)).toBeNull();
    const session = await mintSessionToken(SECRET, "u1", "A");
    expect(await verifyWsTicket(session, SECRET, "na-overworld-1")).toBeNull();
  });

  test("only HS256 is accepted (no algorithm confusion, no unsigned tokens)", async () => {
    const hs512 = await sign({ sub: "u1", scope: "session", exp: nowSec() + 60 }, SECRET, "HS512");
    expect(await verifySessionToken(`Bearer ${hs512}`, SECRET)).toBeNull();
    const none = `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(JSON.stringify({ sub: "u1", scope: "session", exp: nowSec() + 60 }))}.`;
    expect(await verifySessionToken(`Bearer ${none}`, SECRET)).toBeNull();
  });

  test("a ticket can be replayed until it expires (it is not single-use)", async () => {
    const ticket = await mintWsTicket(SECRET, "u1", "na-overworld-1");
    expect(await verifyWsTicket(ticket, SECRET, "na-overworld-1")).toBe("u1");
    expect(await verifyWsTicket(ticket, SECRET, "na-overworld-1")).toBe("u1");
  });
});
