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
