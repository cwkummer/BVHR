/**
 * Drizzle Kit configuration for Durable Object embedded SQLite storage (`players`, `battles`, `pending_rewards`).
 * Used by `drizzle-kit generate` to produce migrations bundled into each `GameRoom` instance.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/do-schema.ts",
  out: "./drizzle-do/migrations",
  dialect: "sqlite",
  driver: "durable-sqlite"
});
