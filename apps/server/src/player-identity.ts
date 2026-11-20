/**
 * Two small trust-boundary types for `GameRoom`:
 *  - `PlayerIdentity`: who is connecting (`id`, `username`), forwarded by the Worker in the `X-Player-Data`
 *    header after it has verified the ticket. Deliberately excludes email, Google id and combat stats.
 *  - `CombatStats`: `maxHp`/`attack`/`defense`, which the room reads from D1 itself when a player joins
 *    and again at battle start, so combat always uses the account's current values.
 * Both are range-checked before use.
 */
import type { UserProfile } from "./db/d1-schema";

export type PlayerIdentity = {
  id: string;
  username: string;
};

export type CombatStats = {
  maxHp: number;
  attack: number;
  defense: number;
};

const MAX_ID_LENGTH = 64;
const MAX_USERNAME_LENGTH = 32;
const MAX_STAT = 1_000_000;

/**
 * Projects a D1 user row down to the identity the room needs.
 */
export function toPlayerIdentity(profile: UserProfile): PlayerIdentity {
  return { id: profile.id, username: profile.username };
}

const isIntInRange = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/**
 * Validates untrusted JSON into a `PlayerIdentity`, returning only the known fields (extras are
 * dropped) or null if any field is missing, mistyped or out of range.
 */
export function parsePlayerIdentity(raw: unknown): PlayerIdentity | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { id, username } = raw as Record<string, unknown>;
  if (typeof id !== "string" || id.length < 1 || id.length > MAX_ID_LENGTH) return null;
  if (typeof username !== "string" || username.length < 1 || username.length > MAX_USERNAME_LENGTH) return null;
  return { id, username };
}

/**
 * Parses the raw `X-Player-Data` header value; null for a missing header, bad JSON or invalid fields.
 */
export function parsePlayerIdentityHeader(rawHeader: string | null): PlayerIdentity | null {
  if (!rawHeader) return null;
  try {
    return parsePlayerIdentity(JSON.parse(rawHeader));
  } catch {
    return null;
  }
}

/**
 * Validates a D1 `users` row (selected as `maxHp`, `attack`, `defense`) into `CombatStats`, or null
 * if the row is absent or holds an impossible value.
 */
export function parseCombatStats(row: unknown): CombatStats | null {
  if (typeof row !== "object" || row === null) return null;
  const { maxHp, attack, defense } = row as Record<string, unknown>;
  if (!isIntInRange(maxHp, 1, MAX_STAT)) return null;
  if (!isIntInRange(attack, 0, MAX_STAT)) return null;
  if (!isIntInRange(defense, 0, MAX_STAT)) return null;
  return { maxHp, attack, defense };
}
