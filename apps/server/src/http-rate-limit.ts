/**
 * Request rate limiting for the HTTP API, using Cloudflare's Workers Rate Limiting bindings
 * (`AUTH_LIMITER`, `TICKET_LIMITER` in wrangler.jsonc). WebSocket messages are limited separately,
 * inside the room (`room/rate-limit.ts`).
 *
 * Limits are counted per Cloudflare location and per key, and are approximate by design: they exist to stop
 * floods that would otherwise cost a Google key check and D1 writes (sign-in) or Durable Object calls
 * (matchmaking and tickets) per request, not to meter normal use.
 */

/** Shown to clients when a request is refused; `Retry-After` is the limiter's window in seconds. */
export const RATE_LIMITED_MESSAGE = "Too many requests. Please wait a moment and try again.";
export const RATE_LIMIT_RETRY_AFTER_SEC = "60";

/**
 * Whether the request identified by `key` is within its limit. Fails open: a missing binding or a limiter
 * error lets the request through (and logs), because refusing every player when the limiter is unhealthy
 * would be a worse outage than the abuse it guards against.
 */
export async function isWithinRateLimit(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch (err) {
    console.error("Rate limiter failed; allowing the request:", err);
    return true;
  }
}

/** The caller's IP as seen by Cloudflare, or a shared bucket if it is absent (local development). */
export function clientIpKey(headers: { get(name: string): string | null }): string {
  return headers.get("CF-Connecting-IP")?.trim() || "unknown";
}
