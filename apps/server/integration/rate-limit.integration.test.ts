/**
 * HTTP rate limits against a real Worker with its rate limit bindings: sign-in per client IP (10 a minute),
 * and joins and reconnect tickets per user and route (30 a minute each).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { post } from "./support/client";
import { startServer, type TestServer } from "./support/server";

let server: TestServer;

beforeAll(async () => {
  server = await startServer(["a", "b"].map((id) => ({ id, username: id.toUpperCase() })));
}, 120_000);

afterAll(async () => {
  await server?.stop();
});

const signIn = () =>
  fetch(`${server.baseUrl}/api/auth/google`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken: "not-a-real-token" })
  });

/**
 * Sends requests until one is refused with 429 (giving up after `2 * limit + 1`) and returns the statuses seen.
 * Limits are counted in fixed time windows, so a burst that happens to straddle a window boundary can get up
 * to twice the limit through; tests therefore assert the first refusal falls between `limit` and `2 * limit`,
 * which still proves the limit exists and is enforced, without depending on where the boundary falls.
 */
async function sendUntilRefused(limit: number, send: () => Promise<number>): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < 2 * limit + 1; i++) {
    statuses.push(await send());
    if (statuses[i] === 429) break;
  }
  return statuses;
}

describe("rate limits", () => {
  test("sign-in is limited per client; refused requests say how long to wait", async () => {
    // Bad credentials are rejected with 401 until the limit is reached, then with 429, before any Google or D1 work.
    const statuses = await sendUntilRefused(10, async () => (await signIn()).status);
    const refusedAt = statuses.indexOf(429);
    expect(refusedAt).toBeGreaterThanOrEqual(10);
    expect(refusedAt).toBeLessThanOrEqual(20);
    expect(statuses.slice(0, refusedAt).every((s) => s === 401)).toBe(true);

    const refused = await signIn();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
    expect(((await refused.json()) as { error: string }).error).toMatch(/too many requests/i);
  });

  test("joins are limited per user, and one user's limit does not affect another's", async () => {
    const statuses = await sendUntilRefused(30, async () => (await post(server, "/api/join", "a")).status);
    const refusedAt = statuses.indexOf(429);
    expect(refusedAt).toBeGreaterThanOrEqual(30);
    expect(refusedAt).toBeLessThanOrEqual(60);
    expect(statuses.slice(0, refusedAt).every((s) => s === 200)).toBe(true);

    expect((await post(server, "/api/join", "b")).status).toBe(200);
  });

  test("reconnect tickets have their own limit, separate from joins", async () => {
    // User "a" is out of joins, but its ticket allowance is untouched.
    expect((await post(server, "/api/join", "a")).status).toBe(429);
    expect((await post(server, "/api/ws-ticket", "a", { roomId: "na-overworld-1" })).status).toBe(200);

    const statuses = await sendUntilRefused(
      30,
      async () => (await post(server, "/api/ws-ticket", "b", { roomId: "na-overworld-1" })).status
    );
    const refusedAt = statuses.indexOf(429);
    expect(refusedAt).toBeGreaterThanOrEqual(30);
    expect(refusedAt).toBeLessThanOrEqual(60);
    expect(statuses.slice(0, refusedAt).every((s) => s === 200)).toBe(true);
  });
});
