/**
 * Starts a real `wrangler dev` Worker (with the GameRoom Durable Object and a local D1) against a
 * throwaway persistence directory, so integration tests exercise the actual runtime, routes, SQLite
 * and WebSockets without touching anyone's dev state or needing network access or secrets.
 *
 * Each test file starts its own server, so every file begins with an empty room and database.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mintSessionToken } from "../../src/auth";

const SERVER_DIR = resolve(import.meta.dir, "../..");
const SECRET = "integration-test-secret";
const DB_NAME = "rpg-global-db-dev";

export type SeedUser = {
  id: string;
  username: string;
  maxHp?: number;
  attack?: number;
  defense?: number;
};

export type TestServer = {
  baseUrl: string;
  wsUrl: string;
  /** A valid session token for a seeded user. */
  token(userId: string): Promise<string>;
  /** Direct access to the Worker's local D1 database (for assertions and for changing a user's stats). */
  db: Database;
  /** Recent Worker log output, for diagnosing a failing test. */
  logs(): string;
  stop(): Promise<void>;
};

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port as number;
  await probe.stop(true);
  return port;
}

function run(cmd: string[]): void {
  const r = Bun.spawnSync(cmd, { cwd: SERVER_DIR, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed:\n${r.stdout.toString()}\n${r.stderr.toString()}`);
  }
}

/**
 * Boots a Worker with a fresh, migrated and seeded local database and resolves once it answers
 * `/api/health`. Call `stop()` in `afterAll`.
 */
export async function startServer(users: SeedUser[]): Promise<TestServer> {
  const stateDir = mkdtempSync(join(tmpdir(), "bvhr-it-"));

  run(["bunx", "wrangler", "d1", "migrations", "apply", DB_NAME, "--local", "--persist-to", stateDir]);

  const d1Dir = join(stateDir, "v3", "d1", "miniflare-D1DatabaseObject");
  const dbFile = readdirSync(d1Dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  if (!dbFile) throw new Error(`No D1 database file found in ${d1Dir}`);
  const db = new Database(join(d1Dir, dbFile));
  db.run("PRAGMA busy_timeout = 5000");

  const insert = db.prepare(
    "INSERT INTO users (id, google_sub, email, username, max_hp, attack, defense) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  for (const u of users) {
    insert.run(u.id, `sub-${u.id}`, `${u.id}@example.test`, u.username, u.maxHp ?? 100, u.attack ?? 15, u.defense ?? 6);
  }

  const port = await freePort();
  const output: string[] = [];
  const proc = Bun.spawn(
    [
      "bunx", "wrangler", "dev",
      "--port", String(port),
      "--inspector-port", "0",
      "--persist-to", stateDir,
      "--var", `JWT_SECRET:${SECRET}`,
      "--var", "GOOGLE_CLIENT_ID:integration-test",
      "--show-interactive-dev-session=false"
    ],
    { cwd: SERVER_DIR, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } }
  );
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output.push(decoder.decode(chunk));
      if (output.length > 400) output.splice(0, output.length - 400);
    }
  };
  void drain(proc.stdout as ReadableStream<Uint8Array>);
  void drain(proc.stderr as ReadableStream<Uint8Array>);

  const baseUrl = `http://localhost:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) break;
    } catch {
      // Not listening yet.
    }
    if (proc.exitCode !== null) throw new Error(`wrangler dev exited early:\n${output.join("")}`);
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`wrangler dev did not become healthy in time:\n${output.join("")}`);
    }
    await Bun.sleep(250);
  }

  return {
    baseUrl,
    wsUrl: `ws://localhost:${port}`,
    token: (userId) => mintSessionToken(SECRET, userId, userId),
    db,
    logs: () => output.join(""),
    async stop() {
      db.close();
      proc.kill();
      await Promise.race([proc.exited, Bun.sleep(8_000)]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
      rmSync(stateDir, { recursive: true, force: true });
    }
  };
}
