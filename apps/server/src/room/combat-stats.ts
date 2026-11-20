/**
 * Reads authoritative player data (username and combat stats) from D1.
 */
import { parseCombatStats, parsePlayerRecord, type CombatStats, type PlayerIdentity } from "../player-identity";

/**
 * Reads a player's username and combat stats with a single D1 query, for when they join the room.
 * Returns null if the user is missing or holds invalid values; a D1 failure rejects.
 */
export async function loadPlayerRecord(
  d1: D1Database,
  userId: string
): Promise<{ identity: PlayerIdentity; stats: CombatStats } | null> {
  const row = await d1
    .prepare("SELECT username, max_hp AS maxHp, attack, defense FROM users WHERE id = ?")
    .bind(userId)
    .first();
  return parsePlayerRecord(userId, row);
}

/**
 * Reads current `maxHp`/`attack`/`defense` for each user in a single D1 batch. Users that are missing
 * or hold invalid values are absent from the result; a D1 failure rejects.
 */
export async function loadCombatStats(d1: D1Database, userIds: string[]): Promise<Map<string, CombatStats>> {
  const statements = userIds.map((id) =>
    d1.prepare("SELECT max_hp AS maxHp, attack, defense FROM users WHERE id = ?").bind(id)
  );
  const results = await d1.batch<Record<string, unknown>>(statements);
  const out = new Map<string, CombatStats>();
  results.forEach((result, i) => {
    const stats = parseCombatStats(result.results[0]);
    if (stats) out.set(userIds[i], stats);
  });
  return out;
}
