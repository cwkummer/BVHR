/**
 * Per-player token-bucket rate limiting for inbound WebSocket messages.
 */
export const MAX_MSGS_PER_SEC = 30;

export type TokenBucket = { msgTokens: number; lastTokenRefill: number };

/**
 * Refills `bucket` for the time elapsed since its last refill (up to `MAX_MSGS_PER_SEC` tokens), then
 * tries to spend one token. A `free` message (e.g. a movement stop, which must never be dropped) is
 * always allowed and costs nothing. Returns whether the message may be processed.
 */
export function tryConsumeMessageToken(bucket: TokenBucket, now: number, free: boolean): boolean {
  const elapsedSec = (now - bucket.lastTokenRefill) / 1000;
  if (elapsedSec > 0) {
    bucket.msgTokens = Math.min(MAX_MSGS_PER_SEC, bucket.msgTokens + elapsedSec * MAX_MSGS_PER_SEC);
    bucket.lastTokenRefill = now;
  }
  if (free) return true;
  if (bucket.msgTokens < 1) return false;
  bucket.msgTokens -= 1;
  return true;
}
