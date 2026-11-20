/**
 * Drizzle SQLite schema for each `GameRoom` Durable Object instance.
 * Holds per-shard ephemeral/active runtime state so a room can survive hibernation or restarts:
 *  - `players`: currently active or in-battle players in this shard and their last persisted coordinates/HP.
 *  - `battles`: active turn-based encounters and turn deadlines.
 *  - `pending_rewards`: transactional outbox of D1 XP/gold grants awaiting confirmation.
 */
import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";

export const players = sqliteTable("players", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  x: real("x").notNull().default(120),
  y: real("y").notNull().default(120),
  hp: integer("hp").notNull().default(100),
  maxHp: integer("max_hp").notNull().default(100),
  attack: integer("attack").notNull().default(15),
  defense: integer("defense").notNull().default(6),
  currentZoneId: text("current_zone_id"),
  battleId: text("battle_id"),
  // Post-battle encounter immunity deadline (epoch ms), persisted atomically with battle settlement.
  battleCooldownUntil: integer("battle_cooldown_until").notNull().default(0)
});

export const battles = sqliteTable(
  "battles",
  {
    id: text("id").primaryKey(),
    zoneId: text("zone_id").notNull(),
    player1Id: text("player1_id").notNull(),
    player2Id: text("player2_id").notNull(),
    activeTurnPlayerId: text("active_turn_player_id").notNull(),
    turnNumber: integer("turn_number").notNull().default(1),
    turnDeadlineAt: integer("turn_deadline_at").notNull(),
    p1Timeouts: integer("p1_timeouts").notNull().default(0),
    p2Timeouts: integer("p2_timeouts").notNull().default(0),
    status: text("status").notNull().default("ACTIVE")
  },
  (table) => [index("idx_battles_status_deadline").on(table.status, table.turnDeadlineAt)]
);

export const pendingRewards = sqliteTable(
  "pending_rewards",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    xp: integer("xp").notNull(),
    gold: integer("gold").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextRetryAt: integer("next_retry_at").notNull()
  },
  (table) => [index("idx_pending_rewards_retry").on(table.nextRetryAt)]
);

export type PlayerRow = typeof players.$inferSelect;
export type BattleRow = typeof battles.$inferSelect;
export type PendingRewardRow = typeof pendingRewards.$inferSelect;
