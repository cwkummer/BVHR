/**
 * Transactional outbox for battle rewards: a reward is first written to the room's SQLite
 * (`pending_rewards`) atomically with the battle result, then credited to D1 idempotently and retried
 * with capped exponential backoff until it succeeds. Rewards are never dropped.
 */
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { eq, lte, min } from "drizzle-orm";
import { pendingRewards } from "../db/do-schema";

export const INITIAL_REWARD_RETRY_MS = 5_000;
const MAX_REWARD_RETRY_MS = 300_000;
const MAX_REWARD_ATTEMPTS = 10;

/**
 * Attempt count and time of the next retry after a failed delivery of a reward that had `prevAttempts`.
 */
export function nextRewardRetry(prevAttempts: number, now: number): { attempts: number; nextRetryAt: number } {
  const attempts = prevAttempts + 1;
  const backoffMs = Math.min(MAX_REWARD_RETRY_MS, INITIAL_REWARD_RETRY_MS * 2 ** Math.min(attempts, 16));
  return { attempts, nextRetryAt: now + backoffMs };
}

export type RewardInput = { id: string; userId: string; xp: number; gold: number };

export class RewardOutbox {
  private inFlight = new Set<string>();

  constructor(
    private readonly db: DrizzleSqliteDODatabase,
    private readonly d1: D1Database
  ) {}

  /**
   * Records a reward for delivery. Call inside the same `transactionSync` as the battle result so both
   * commit or neither does. The first delivery attempt is expected immediately by the caller; the
   * recorded retry time is only the fallback if that attempt (or the object) dies.
   */
  enqueue(reward: RewardInput, now: number): void {
    this.db
      .insert(pendingRewards)
      .values({ ...reward, attempts: 1, nextRetryAt: now + INITIAL_REWARD_RETRY_MS })
      .run();
  }

  /**
   * Idempotently credits one reward to D1 and removes it from the outbox. `INSERT OR IGNORE` makes a
   * repeated claim a no-op, and the credit only applies when that insert actually added a row
   * (`changes()` is 1), so the pair is idempotent without parsing error text. Rejects if D1 fails.
   */
  async apply(reward: RewardInput): Promise<void> {
    if (this.inFlight.has(reward.id)) return;
    this.inFlight.add(reward.id);
    try {
      const insertClaim = this.d1
        .prepare("INSERT OR IGNORE INTO reward_claims (id, user_id, xp, gold, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(reward.id, reward.userId, reward.xp, reward.gold, Date.now());
      const creditUser = this.d1
        .prepare("UPDATE users SET xp = xp + ?, gold = gold + ? WHERE id = ? AND (SELECT changes()) > 0")
        .bind(reward.xp, reward.gold, reward.userId);
      await this.d1.batch([insertClaim, creditUser]);

      this.db.delete(pendingRewards).where(eq(pendingRewards.id, reward.id)).run();
    } finally {
      this.inFlight.delete(reward.id);
    }
  }

  /**
   * Retries every reward whose retry time has passed. A failure reschedules it with backoff instead of
   * dropping it, and is logged loudly once it has failed `MAX_REWARD_ATTEMPTS` times.
   */
  async flushDue(now: number): Promise<void> {
    const due = this.db.select().from(pendingRewards).where(lte(pendingRewards.nextRetryAt, now)).all();

    for (const reward of due) {
      if (this.inFlight.has(reward.id)) continue;
      try {
        await this.apply(reward);
      } catch (err) {
        const retry = nextRewardRetry(reward.attempts, now);
        this.db.update(pendingRewards).set(retry).where(eq(pendingRewards.id, reward.id)).run();
        if (retry.attempts >= MAX_REWARD_ATTEMPTS) {
          console.error(`D1 reward ${reward.id} still failing after ${retry.attempts} attempts; will keep retrying:`, reward);
        }
        console.error("Retry D1 reward update failed:", err);
      }
    }
  }

  /**
   * Earliest time any queued reward is due for retry, or undefined if the outbox is empty.
   */
  nextRetryAt(): number | undefined {
    const row = this.db.select({ next: min(pendingRewards.nextRetryAt) }).from(pendingRewards).get();
    return row?.next ?? undefined;
  }
}
