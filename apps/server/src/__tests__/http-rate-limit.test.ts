/**
 * HTTP rate limiting helpers: the limiter's answer is respected, and a broken or missing limiter never
 * locks players out.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { clientIpKey, isWithinRateLimit } from "../http-rate-limit";

const limiter = (impl: (key: string) => Promise<{ success: boolean }>): RateLimit => ({
  limit: ({ key }) => impl(key)
});

describe("isWithinRateLimit", () => {
  test("passes the key to the limiter and returns its verdict", async () => {
    const seen: string[] = [];
    const allow = limiter(async (key) => (seen.push(key), { success: true }));
    const deny = limiter(async () => ({ success: false }));
    expect(await isWithinRateLimit(allow, "join:u1")).toBe(true);
    expect(seen).toEqual(["join:u1"]);
    expect(await isWithinRateLimit(deny, "join:u1")).toBe(false);
  });

  test("allows the request when there is no limiter binding", async () => {
    expect(await isWithinRateLimit(undefined, "auth:1.2.3.4")).toBe(true);
  });

  test("allows the request, and logs, when the limiter itself fails", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    const broken = limiter(async () => {
      throw new Error("limiter unavailable");
    });
    expect(await isWithinRateLimit(broken, "auth:1.2.3.4")).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});

describe("clientIpKey", () => {
  test("uses Cloudflare's client IP header", () => {
    expect(clientIpKey(new Headers({ "CF-Connecting-IP": " 203.0.113.9 " }))).toBe("203.0.113.9");
  });

  test("falls back to one shared bucket when the header is missing or blank", () => {
    expect(clientIpKey(new Headers())).toBe("unknown");
    expect(clientIpKey(new Headers({ "CF-Connecting-IP": "  " }))).toBe("unknown");
  });
});
