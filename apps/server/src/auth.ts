/**
 * Authentication and token utilities for Google OAuth ID token verification (via Google's
 * public JWKS with caching and single-flight refresh) and scoped HS256 JWT minting/verification
 * for long-lived session tokens vs. short-lived room-bound WebSocket tickets.
 */
import { sign, verify } from "hono/jwt";

type GoogleJwk = JsonWebKey & {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
};

type JwksCache = {
  keys: Map<string, CryptoKey>;
  expiresAt: number;
};

type GoogleJwtHeader = {
  alg?: string;
  kid?: string;
  typ?: string;
};

type GoogleJwtPayload = {
  iss?: string;
  aud?: string;
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  exp?: number;
  nbf?: number;
};

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const JWKS_CACHE_TTL_MS = 3_600_000;
const JWKS_MIN_TTL_MS = 300_000;
const JWKS_MAX_TTL_MS = 21_600_000;
const JWKS_MIN_REFRESH_INTERVAL_MS = 30_000;
const JWT_CLOCK_SKEW_SEC = 60;
const WS_TICKET_TTL_SEC = 60;
const SESSION_TTL_SEC = 60 * 60 * 24 * 7;

// Module-level JWKS key cache and single-flight fetch promise to avoid thundering herds.
let jwksCache: JwksCache | null = null;
let inFlightJwks: Promise<Map<string, CryptoKey>> | null = null;
let lastJwksFetchAt = 0;

/**
 * Decodes a base64url-encoded string (JWT header, payload, or signature) into raw bytes.
 */
export function base64UrlDecodeToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Decodes a base64url-encoded JSON segment into a typed object.
 */
export function base64UrlDecodeJson<T>(segment: string): T {
  const jsonText = new TextDecoder().decode(base64UrlDecodeToBytes(segment));
  return JSON.parse(jsonText) as T;
}

/**
 * Extracts `max-age` from a `Cache-Control` header and clamps it between `JWKS_MIN_TTL_MS`
 * and `JWKS_MAX_TTL_MS`, falling back to `JWKS_CACHE_TTL_MS` if absent.
 */
export function parseCacheMaxAgeMs(cacheControl: string | null): number {
  const match = cacheControl?.match(/max-age=(\d+)/i);
  if (!match) return JWKS_CACHE_TTL_MS;
  const parsedMs = Number(match[1]) * 1000;
  return Math.min(JWKS_MAX_TTL_MS, Math.max(JWKS_MIN_TTL_MS, parsedMs));
}

/**
 * Retrieves Google's RSA signing keys indexed by `kid`, using cached keys when fresh and
 * deduplicating concurrent network refreshes. Respects `JWKS_MIN_REFRESH_INTERVAL_MS` when
 * `forceRefresh` is requested for an unknown `kid` (e.g., after key rotation).
 */
async function getGoogleKeyMap(forceRefresh = false): Promise<Map<string, CryptoKey>> {
  const now = Date.now();
  if (jwksCache && now < jwksCache.expiresAt) {
    if (!forceRefresh || now - lastJwksFetchAt < JWKS_MIN_REFRESH_INTERVAL_MS) {
      return jwksCache.keys;
    }
  }
  if (inFlightJwks) {
    return inFlightJwks;
  }

  inFlightJwks = (async () => {
    const res = await fetch(GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) {
      throw new Error(`Failed to fetch Google JWKS (${res.status})`);
    }

    const data = (await res.json()) as { keys?: GoogleJwk[] };
    const rawKeys = Array.isArray(data.keys) ? data.keys : [];
    const keyMap = new Map<string, CryptoKey>();

    for (const jwk of rawKeys) {
      if (!jwk.kid || jwk.kty !== "RSA") continue;
      if (jwk.use && jwk.use !== "sig") continue;
      const imported = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"]
      );
      keyMap.set(jwk.kid, imported);
    }

    const fetchedAt = Date.now();
    const ttlMs = parseCacheMaxAgeMs(res.headers.get("Cache-Control"));
    lastJwksFetchAt = fetchedAt;
    jwksCache = {
      keys: keyMap,
      expiresAt: fetchedAt + ttlMs
    };
    return keyMap;
  })().finally(() => {
    inFlightJwks = null;
  });

  return inFlightJwks;
}

/**
 * Verifies a Google ID token JWT against Google's JWKS public keys and validates standard claims
 * (`iss`, `aud`, `exp`, `nbf`, `sub`, `email`, `email_verified`). Also normalizes a display name
 * and flags whether a fallback "Adventurer" name was used.
 */
export async function verifyGoogleIdTokenWithJwks(
  idToken: string,
  expectedClientId: string
): Promise<{ googleSub: string; email: string; name: string; isDefaultAdventurer: boolean }> {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed ID token");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = base64UrlDecodeJson<GoogleJwtHeader>(encodedHeader);
  const payload = base64UrlDecodeJson<GoogleJwtPayload>(encodedPayload);

  if (header.alg !== "RS256" || !header.kid) {
    throw new Error("Unsupported token algorithm or missing kid");
  }

  let keyMap = await getGoogleKeyMap(false);
  let cryptoKey = keyMap.get(header.kid);
  // If the token references a kid not in cache, attempt one forced refresh in case keys rotated.
  if (!cryptoKey) {
    keyMap = await getGoogleKeyMap(true);
    cryptoKey = keyMap.get(header.kid);
  }
  if (!cryptoKey) {
    throw new Error("No matching Google JWK found");
  }

  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signatureBytes = base64UrlDecodeToBytes(encodedSignature);
  const validSig = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signatureBytes as Uint8Array<ArrayBuffer>, signingInput);
  if (!validSig) {
    throw new Error("Invalid Google ID token signature");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const validIssuer =
    payload.iss === "https://accounts.google.com" || payload.iss === "accounts.google.com";
  const validAud = payload.aud === expectedClientId;
  const validExp = typeof payload.exp === "number" && payload.exp > nowSec;
  const validNbf = payload.nbf === undefined || payload.nbf <= nowSec + JWT_CLOCK_SKEW_SEC;

  if (
    !validIssuer ||
    !validAud ||
    !validExp ||
    !validNbf ||
    !payload.sub ||
    !payload.email ||
    payload.email_verified !== true
  ) {
    throw new Error("Invalid Google ID token claims");
  }

  const emailPrefix = payload.email.split("@")[0]?.trim() || "";
  const explicitOrEmailName = (payload.name || emailPrefix).trim().slice(0, 20);
  const isDefaultAdventurer = explicitOrEmailName.length === 0;
  const cleanName = isDefaultAdventurer ? "Adventurer" : explicitOrEmailName;

  return {
    googleSub: payload.sub,
    email: payload.email.toLowerCase(),
    name: cleanName,
    isDefaultAdventurer
  };
}

/**
 * Mints a 7-day HS256 session JWT scoped to `scope: "session"` for REST/RPC API authentication.
 */
export async function mintSessionToken(
  secret: string,
  userId: string,
  username: string,
  nowMs = Date.now()
): Promise<string> {
  return sign(
    {
      sub: userId,
      username,
      scope: "session",
      exp: Math.floor(nowMs / 1000) + SESSION_TTL_SEC
    },
    secret
  );
}

/**
 * Verifies a `Bearer <token>` header for a session JWT and returns `sub` (`userId`),
 * or `null` if missing, malformed, expired, or not carrying `scope: "session"`.
 */
export async function verifySessionToken(authHeader: string | undefined, secret: string): Promise<string | null> {
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return null;

  try {
    const payload = (await verify(token, secret, "HS256")) as { sub?: string; scope?: string };
    if (payload.scope !== "session" || !payload.sub) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

/**
 * Mints a short-lived (60s) HS256 WebSocket upgrade ticket scoped to `scope: "ws"`
 * and bound to a specific `roomId`.
 */
export async function mintWsTicket(
  secret: string,
  userId: string,
  roomId: string,
  nowMs = Date.now()
): Promise<string> {
  const nowSec = Math.floor(nowMs / 1000);
  return sign(
    {
      sub: userId,
      roomId,
      scope: "ws",
      exp: nowSec + WS_TICKET_TTL_SEC
    },
    secret
  );
}

/**
 * Verifies a WebSocket ticket and checks that its `scope` is `"ws"` and its `roomId`
 * matches `expectedRoomId`, returning `sub` (`userId`) or `null` if invalid/expired.
 */
export async function verifyWsTicket(
  ticket: string,
  secret: string,
  expectedRoomId: string
): Promise<string | null> {
  try {
    const payload = (await verify(ticket, secret, "HS256")) as {
      sub?: string;
      roomId?: string;
      scope?: string;
    };
    if (payload.scope !== "ws" || !payload.sub || payload.roomId !== expectedRoomId) {
      return null;
    }
    return payload.sub;
  } catch {
    return null;
  }
}
