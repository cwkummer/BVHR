/**
 * Drizzle Kit configuration for the global Cloudflare D1 SQLite database (`users` and `reward_claims`).
 * Used by `drizzle-kit generate` to produce SQL migrations under `drizzle-d1/migrations`.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/d1-schema.ts",
  out: "./drizzle-d1/migrations",
  dialect: "sqlite",
  driver: "d1-http"
});
