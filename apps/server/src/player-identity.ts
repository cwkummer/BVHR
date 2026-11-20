/**
 * Trust-boundary types for `GameRoom`:
 *  - The Worker forwards only the verified user id, in the `X-Player-Id` header, after it has checked the
 *    ticket. Nothing else about the player crosses that boundary.
 *  - The room then reads that user's `username` and combat stats from D1 itself, in one query, when the
 *    player joins (`parsePlayerRecord`), and reads stats again at battle start (`parseCombatStats`), so
 *    the room always uses the account's current values.
 * Everything read from the header or from D1 is range-checked before use.
 */
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

const isIntInRange = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/**
 * Validates the raw `X-Player-Id` header value; null if it is missing, empty or too long.
 */
export function parsePlayerIdHeader(rawHeader: string | null): string | null {
  if (!rawHeader || rawHeader.length > MAX_ID_LENGTH) return null;
  return rawHeader;
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

/**
 * Validates a D1 `users` row (selected as `username`, `maxHp`, `attack`, `defense`) for user `id` into the
 * identity and combat stats the room needs, or null if the row is absent or holds an impossible value.
 */
export function parsePlayerRecord(
  id: string,
  row: unknown
): { identity: PlayerIdentity; stats: CombatStats } | null {
  const stats = parseCombatStats(row);
  if (!stats) return null;
  const { username } = row as Record<string, unknown>;
  if (typeof username !== "string" || username.length < 1 || username.length > MAX_USERNAME_LENGTH) return null;
  return { identity: { id, username }, stats };
}
