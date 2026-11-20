/**
 * Shard capacity limits shared by the Worker router (`index.ts`) and the `GameRoom` Durable Object,
 * so matchmaking and in-room enforcement can never disagree about how full a shard is.
 *
 * The soft cap is where matchmaking stops sending new players to a shard; the hard cap is the point
 * where the room itself refuses brand-new joins (existing players can still reconnect). The gap leaves
 * headroom for joins that race past a stale occupancy count.
 */
export const ROOM_SOFT_CAP = 40;
export const ROOM_HARD_CAP = 50;

/** How many shards (`overworld-1` ... `overworld-N`) each region can have. */
export const MAX_SHARDS_PER_REGION = 16;

/** Region prefixes, matching Cloudflare's `request.cf.continent` codes (lowercased). */
export const CONTINENTS = ["na", "eu", "as", "oc", "sa", "af"] as const;
export type Continent = (typeof CONTINENTS)[number];

/** True if `value` is one of the supported region codes. */
export function isContinent(value: string): value is Continent {
  return (CONTINENTS as readonly string[]).includes(value);
}

/** The full id of shard `shard` in `continent`, e.g. `na-overworld-3`. */
export function regionalShardId(continent: Continent, shard: number): string {
  return `${continent}-overworld-${shard}`;
}

/**
 * Parses a shard name, with or without its region prefix (`overworld-3` or `eu-overworld-3`), into its
 * parts. `continent` is null when the name has no prefix. Returns null for anything else: unknown regions,
 * shard numbers outside 1..MAX_SHARDS_PER_REGION, and non-canonical numbers such as `01`.
 */
export function parseShardId(raw: string): { continent: Continent | null; shard: number } | null {
  const match = /^(?:([a-z]+)-)?overworld-([1-9][0-9]*)$/.exec(raw);
  if (!match) return null;
  const [, prefix, number] = match;
  if (prefix !== undefined && !isContinent(prefix)) return null;
  const shard = Number(number);
  if (shard > MAX_SHARDS_PER_REGION) return null;
  return { continent: prefix === undefined ? null : (prefix as Continent), shard };
}
