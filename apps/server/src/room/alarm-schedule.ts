/**
 * Durable Object alarm scheduling: pure helpers for choosing the next wake-up time and a small wrapper
 * that avoids redundant storage calls.
 */

/**
 * Earliest of the given timestamps, ignoring null/undefined; null when there are none.
 */
export function earliestTime(candidates: ReadonlyArray<number | null | undefined>): number | null {
  let best: number | null = null;
  for (const c of candidates) {
    if (c != null && (best === null || c < best)) best = c;
  }
  return best;
}

/**
 * Earliest future post-battle immunity expiry among players standing in a zone outside battle, i.e.
 * the moment a waiting encounter may become possible. Undefined if there is none.
 */
export function earliestCooldownExpiry(
  players: Iterable<{ currentZoneId: string | null; battleId: string | null; battleCooldownUntil: number }>,
  now: number
): number | undefined {
  let next: number | undefined;
  for (const p of players) {
    if (p.currentZoneId && !p.battleId && p.battleCooldownUntil > now) {
      next = next === undefined ? p.battleCooldownUntil : Math.min(next, p.battleCooldownUntil);
    }
  }
  return next;
}

/**
 * Sets or clears the single Durable Object alarm, skipping the storage call when it already holds the
 * requested value.
 */
export class AlarmScheduler {
  private scheduledAt: number | null | undefined = undefined;

  constructor(private readonly storage: DurableObjectStorage) {}

  /** Forget the cached alarm; call when the alarm fires or the object restarts (the real value is unknown). */
  reset(): void {
    this.scheduledAt = undefined;
  }

  /** Arm the alarm for `at`, or clear it when `at` is null. */
  async schedule(at: number | null): Promise<void> {
    if (at !== null) {
      if (this.scheduledAt === at) return;
      await this.storage.setAlarm(at);
      this.scheduledAt = at;
    } else {
      if (this.scheduledAt === null) return;
      await this.storage.deleteAlarm();
      this.scheduledAt = null;
    }
  }
}
