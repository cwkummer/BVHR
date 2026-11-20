/**
 * The minimal player identity the Worker forwards to a `GameRoom` in the `X-Player-Data` header, plus
 * strict parsing of that header on the room side. The room never needs a user's email or Google id, so
 * they are not forwarded, and every field is range-checked because the header is a trust boundary.
 */
import type { UserProfile } from "./db/d1-schema";

export type PlayerIdentity = {
  id: string;
  username: string;
  maxHp: number;
  attack: number;
  defense: number;
};

const MAX_ID_LENGTH = 64;
const MAX_USERNAME_LENGTH = 32;
const MAX_STAT = 1_000_000;

/**
 * Projects a D1 user row down to the identity fields a room needs.
 */
export function toPlayerIdentity(profile: UserProfile): PlayerIdentity {
  return {
    id: profile.id,
    username: profile.username,
    maxHp: profile.maxHp,
    attack: profile.attack,
    defense: profile.defense
  };
}

const isIntInRange = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/**
 * Validates untrusted JSON into a `PlayerIdentity`, returning only the known fields (extras are
 * dropped) or null if any field is missing, mistyped or out of range.
 */
export function parsePlayerIdentity(raw: unknown): PlayerIdentity | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const { id, username, maxHp, attack, defense } = o;
  if (typeof id !== "string" || id.length < 1 || id.length > MAX_ID_LENGTH) return null;
  if (typeof username !== "string" || username.length < 1 || username.length > MAX_USERNAME_LENGTH) return null;
  if (!isIntInRange(maxHp, 1, MAX_STAT)) return null;
  if (!isIntInRange(attack, 0, MAX_STAT)) return null;
  if (!isIntInRange(defense, 0, MAX_STAT)) return null;
  return { id, username, maxHp, attack, defense };
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
