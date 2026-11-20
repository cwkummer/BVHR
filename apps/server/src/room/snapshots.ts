/**
 * Pure projections of room state into the compact values sent to clients.
 */
import type { PlayerSnapshot } from "shared/protocol";
import type { LivePlayer } from "./live-player";

/**
 * Lean overworld snapshot of a player for roster sync messages (no HP or stats).
 */
export function toPlayerSnapshot(p: LivePlayer): PlayerSnapshot {
  return {
    id: p.id,
    username: p.username,
    x: p.x,
    y: p.y,
    currentZoneId: p.currentZoneId,
    battleId: p.battleId
  };
}

/**
 * Converts raw `hp` and `maxHp` into a clamped integer percentage in `[0, 100]` so clients can render
 * health without receiving exact HP or max HP values.
 */
export function toHpPercent(hp: number, maxHp: number): number {
  if (maxHp <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((hp / maxHp) * 100)));
}
