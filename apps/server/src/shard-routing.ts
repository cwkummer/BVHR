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

/**
 * Fill-first shard selection: walks `shardIds` in order and returns the first shard under `softCap`,
 * so a small population shares one room instead of being scattered across many.
 *
 * A shard with a fresh cached count is judged from the cache (full ones are skipped without waking
 * the Durable Object). A shard with no fresh count is probed on its own, one at a time, and the walk
 * stops at the first open shard, so shards past it are never probed. A shard whose probe fails is
 * skipped. Returns null when every shard is full or unreachable.
 */
export async function pickFirstOpenShard(
  shardIds: string[],
  softCap: number,
  getFreshCount: (roomId: string) => number | undefined,
  probe: (roomId: string) => Promise<number>,
  onProbeError?: (roomId: string, err: unknown) => void
): Promise<{ roomId: string; count: number } | null> {
  for (const roomId of shardIds) {
    let count = getFreshCount(roomId);
    if (count === undefined) {
      try {
        count = await probe(roomId);
      } catch (err) {
        onProbeError?.(roomId, err);
        continue;
      }
    }
    if (count < softCap) return { roomId, count };
  }
  return null;
}
