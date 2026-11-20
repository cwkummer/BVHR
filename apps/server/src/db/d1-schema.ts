/**
 * Drizzle SQLite schema for the global Cloudflare D1 database.
 * Stores persistent player accounts (`users`) and an idempotency ledger (`reward_claims`)
 * so battle XP/gold rewards cannot be double-credited across retries or Durable Object restarts.
 */
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  googleSub: text("google_sub").notNull().unique(),
  email: text("email").notNull(),
  username: text("username").notNull(),
  level: integer("level").notNull().default(1),
  xp: integer("xp").notNull().default(0),
  gold: integer("gold").notNull().default(50),
  maxHp: integer("max_hp").notNull().default(100),
  attack: integer("attack").notNull().default(15),
  defense: integer("defense").notNull().default(6)
});

export type UserProfile = typeof users.$inferSelect;

export const rewardClaims = sqliteTable("reward_claims", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  xp: integer("xp").notNull(),
  gold: integer("gold").notNull(),
  createdAt: integer("created_at").notNull()
});

export type RewardClaim = typeof rewardClaims.$inferSelect;
