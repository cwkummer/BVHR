/**
 * Authoritative overworld movement for one simulation tick, free of any I/O so it can be unit tested.
 */
import { stepMovement, findZoneId } from "shared/map-zones";
import type { LivePlayer } from "./live-player";

type Movable = Pick<
  LivePlayer,
  "id" | "x" | "y" | "dx" | "dy" | "dirty" | "battleId" | "encounterPending" | "currentZoneId" | "zoneArmed" | "startFailureNotified"
>;

export type MovedPlayer = { id: string; x: number; y: number; currentZoneId: string | null };

const MIN_TICK_SEC = 0.01;
const MAX_TICK_SEC = 0.1;

/**
 * Seconds to simulate for a tick, clamped so a stalled timer cannot teleport players and a burst of
 * ticks cannot stall them.
 */
export function tickDeltaSeconds(now: number, lastTickAt: number): number {
  return Math.min(MAX_TICK_SEC, Math.max(MIN_TICK_SEC, (now - lastTickAt) / 1000));
}

/**
 * Normalizes untrusted client input to a direction in {-1, 0, 1}; non-finite values count as 0.
 */
export function toDirection(raw: unknown): -1 | 0 | 1 {
  const n = Number(raw);
  return (Number.isFinite(n) ? Math.sign(n) : 0) as -1 | 0 | 1;
}

/**
 * True if at least one player outside combat currently has a non-zero movement input.
 */
export function anyPlayerMoving(players: Iterable<Pick<LivePlayer, "battleId" | "dx" | "dy">>): boolean {
  for (const p of players) {
    if (!p.battleId && (p.dx !== 0 || p.dy !== 0)) return true;
  }
  return false;
}

/**
 * Advances every moving, non-battle, non-pending player by `dt` seconds, marking them dirty and
 * updating their zone. Entering a different zone arms the player for an encounter (only if it is a
 * building) and resets their start-failure notice. Mutates `players`; returns who moved.
 */
export function advanceMovement(
  players: Iterable<Movable>,
  dt: number
): { anyoneMoving: boolean; moved: MovedPlayer[] } {
  let anyoneMoving = false;
  const moved: MovedPlayer[] = [];

  for (const p of players) {
    if (p.battleId || p.encounterPending || (p.dx === 0 && p.dy === 0)) continue;
    anyoneMoving = true;
    p.dirty = true;

    const next = stepMovement(p.x, p.y, p.dx, p.dy, dt);
    p.x = next.x;
    p.y = next.y;

    const newZoneId = findZoneId(p.x, p.y);
    moved.push({ id: p.id, x: p.x, y: p.y, currentZoneId: newZoneId });

    if (p.currentZoneId !== newZoneId) {
      p.currentZoneId = newZoneId;
      p.zoneArmed = newZoneId !== null;
      p.startFailureNotified = false;
    }
  }

  return { anyoneMoving, moved };
}
