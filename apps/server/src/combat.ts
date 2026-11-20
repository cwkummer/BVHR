/**
 * Pure turn-based combat constants and damage/healing/timeout helpers used by `GameRoom`
 * and unit-tested in `game-core.test.ts`.
 */

// Turn timer duration (10s), post-battle encounter immunity window (3s), victory rewards, and heal amount.
export const TURN_TIMEOUT_MS = 10_000;
export const POST_BATTLE_IMMUNITY_MS = 3_000;
export const BATTLE_REWARD_XP = 50;
export const BATTLE_REWARD_GOLD = 25;
export const HEAL_AMOUNT = 20;

/**
 * Computes basic attack damage from attacker `attack` and defender `defense`,
 * enforcing a minimum floor of 1 damage so weak attacks still make incremental progress.
 */
export function computeBasicAttackDamage(attack: number, defense: number): number {
  return Math.max(1, attack - Math.floor(defense / 2));
}

/**
 * Applies healing up to `amount` without exceeding `maxHp`.
 */
export function computeHealedHp(currentHp: number, maxHp: number, amount = HEAL_AMOUNT): number {
  return Math.min(maxHp, currentHp + amount);
}

/**
 * Determines whether an active turn player who timed out should forfeit (flee) rather than
 * perform a fallback basic attack: requires reaching 2 consecutive timeouts while having no open socket.
 */
export function shouldForfeitOnTimeout(prevTimeouts: number, hasOpenSocket: boolean): boolean {
  return prevTimeouts + 1 >= 2 && !hasOpenSocket;
}
