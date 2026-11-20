/**
 * In-memory runtime representation of a player in a room: the persisted `PlayerRow` plus transient
 * input, rate-limit and encounter state that is never stored.
 */
import type { PlayerRow } from "../db/do-schema";
import { MAX_MSGS_PER_SEC } from "./rate-limit";

export type LivePlayer = PlayerRow & {
  dx: number;
  dy: number;
  dirty: boolean;
  msgTokens: number;
  lastTokenRefill: number;
  /** True after entering a zone until a battle ends; see `pickEncounterPairs`. */
  zoneArmed: boolean;
  /** True while combat stats are being read from D1 for an imminent battle; blocks movement and re-matching. */
  encounterPending: boolean;
  /** True once this player has been told a battle could not start; avoids repeating it on every retry. */
  startFailureNotified: boolean;
};

/**
 * Wraps a persisted row with fresh transient state (no input, full rate-limit bucket).
 */
export function createLivePlayer(row: PlayerRow, now: number): LivePlayer {
  return {
    ...row,
    dx: 0,
    dy: 0,
    dirty: false,
    msgTokens: MAX_MSGS_PER_SEC,
    lastTokenRefill: now,
    zoneArmed: false,
    encounterPending: false,
    startFailureNotified: false
  };
}
