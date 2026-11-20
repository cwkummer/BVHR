/**
 * Shared WebSocket client-to-server and server-to-client message protocol for BHVR Edge RPG.
 * Intentionally excludes raw `hp` and `maxHp` from overworld `PlayerSnapshot` broadcasts to keep
 * room sync payloads compact and prevent exposing exact combat stats in general roster updates.
 */

export type BattleAction = "ATTACK" | "HEAL" | "FLEE";

/**
 * Lifecycle states of a persisted battle. A battle row exists only while it is `ACTIVE`; it is deleted
 * when it ends. Add a state here (and handle it) before writing any other value.
 */
export const BATTLE_STATUSES = ["ACTIVE"] as const;
export type BattleStatus = (typeof BATTLE_STATUSES)[number];

/** XP and gold granted to a battle winner. */
export type BattleReward = { xp: number; gold: number };

/**
 * Lightweight overworld presence and identity snapshot sent for players in a shard room.
 */
export type PlayerSnapshot = {
  id: string;
  username: string;
  x: number;
  y: number;
  currentZoneId: string | null;
  battleId: string | null;
};

/**
 * Active turn-based encounter state synchronized to participating players.
 * `hpPercentByPlayerId` carries server-computed 0-100 percentages rather than raw HP/maxHp.
 */
export type BattleState = {
  id: string;
  zoneId: string;
  player1Id: string;
  player2Id: string;
  activeTurnPlayerId: string;
  turnNumber: number;
  turnDeadlineAt: number;
  p1Timeouts: number;
  p2Timeouts: number;
  status: BattleStatus;
  hpPercentByPlayerId?: Record<string, number>;
};

/**
 * Messages sent by connected clients over the room WebSocket.
 */
export type ClientMessage =
  | { type: "WASD"; dx: -1 | 0 | 1; dy: -1 | 0 | 1 }
  | { type: "BATTLE_ACTION"; battleId: string; turnNumber: number; action: BattleAction };

/**
 * Messages broadcast or unicast by `GameRoom` to connected clients.
 */
export type ServerMessage =
  | { type: "SYNC_STATE"; serverNow: number; selfId: string; players: PlayerSnapshot[]; battle: BattleState | null }
  | { type: "SNAPSHOT"; players: Array<{ id: string; x: number; y: number; currentZoneId: string | null }> }
  | { type: "PLAYER_JOINED"; player: PlayerSnapshot }
  | { type: "PLAYER_LEFT"; playerId: string }
  | { type: "BATTLE_STARTED"; serverNow: number; battle: BattleState }
  | {
      type: "TURN_RESOLVED";
      serverNow: number;
      turnNumber: number;
      nextTurnPlayerId: string;
      turnDeadlineAt: number;
      p1Timeouts: number;
      p2Timeouts: number;
      hpPercentByPlayerId: Record<string, number>;
      log: string;
    }
  // A battle could not start because valid player data could not be read; the server retries automatically.
  | { type: "BATTLE_START_FAILED"; reason: "STATS_UNAVAILABLE"; retryInMs: number }
  | {
      type: "BATTLE_ENDED";
      winnerId: string;
      participantIds: [string, string];
      log: string;
      /** What the winner was paid, or null when the battle ended without a reward (e.g. an opponent vanished). */
      reward: BattleReward | null;
    };
