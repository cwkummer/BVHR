/**
 * Pure decision logic for reconnecting a player to a specific shard, unit-tested in `game-core.test.ts`.
 */
export type ShardStats = { count: number; hasPlayer: boolean; hardCap: number };

/**
 * A reconnect to a named shard is allowed when the player is still tracked there or the shard has
 * room under its hard cap. Anything else must be rejected explicitly so the client can re-matchmake,
 * rather than silently handing back a ticket for a different shard.
 */
export function canReconnectToShard(stats: ShardStats): boolean {
  return stats.hasPlayer || stats.count < stats.hardCap;
}
