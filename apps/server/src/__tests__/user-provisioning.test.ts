/**
 * Username allocation on first sign-in: generated `Hero-xxxxxxxx` names, case-insensitive uniqueness
 * enforced by the real D1 migrations, and retry with a fresh suffix when a name is taken.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { UserProfile } from "../db/d1-schema";
import {
  USERNAME_MAX_LENGTH,
  candidateUsername,
  findOrCreateUser,
  randomHexSuffix,
  type GoogleUser,
  type NewUser,
  type UserStore
} from "../user-provisioning";

const D1_MIGRATIONS = join(import.meta.dir, "../../drizzle-d1/migrations");

/** A `users` table built from the real D1 migrations, so the unique index under test is the shipped one. */
function openUsersDb(): Database {
  const db = new Database(":memory:");
  const files = readdirSync(D1_MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    for (const statement of readFileSync(join(D1_MIGRATIONS, file), "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) db.run(statement);
    }
  }
  return db;
}

/** `UserStore` over SQLite with the same conflict behavior as D1's `INSERT ... ON CONFLICT DO NOTHING`. */
function sqliteStore(db: Database): UserStore {
  return {
    async findByGoogleSub(googleSub) {
      const row = db
        .query("SELECT id, google_sub AS googleSub, email, username FROM users WHERE google_sub = ?")
        .get(googleSub);
      return (row ?? undefined) as UserProfile | undefined;
    },
    async insertIgnoringConflicts(u: NewUser) {
      db.query(
        `INSERT OR IGNORE INTO users (id, google_sub, email, username, level, xp, gold, max_hp, attack, defense)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(u.id, u.googleSub, u.email, u.username, u.level ?? 1, u.xp ?? 0, u.gold ?? 50, u.maxHp ?? 100, u.attack ?? 15, u.defense ?? 6);
    }
  };
}

const named = (name: string, sub = `sub-${name}`): GoogleUser => ({
  googleSub: sub,
  email: `${sub}@example.com`,
  name,
  isDefaultHero: false
});
const noName = (sub: string): GoogleUser => ({ googleSub: sub, email: `${sub}@example.com`, name: "Hero", isDefaultHero: true });

/** Returns each given suffix in turn, then fails the test if more are requested. */
function sequence(...values: string[]): () => string {
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error("more suffixes requested than expected");
    return values[i++];
  };
}

describe("username candidates", () => {
  test("random suffixes are 8 lowercase hex characters", () => {
    for (let i = 0; i < 50; i++) expect(randomHexSuffix()).toMatch(/^[0-9a-f]{8}$/);
  });

  test("a default name is always Hero- plus a suffix", () => {
    expect(candidateUsername({ name: "Hero", isDefaultHero: true }, 0, () => "0a1b2c3d")).toBe("Hero-0a1b2c3d");
    expect(candidateUsername({ name: "Hero", isDefaultHero: true }, 3, () => "ffffffff")).toBe("Hero-ffffffff");
  });

  test("a Google name is used as is first, then gets a suffix", () => {
    expect(candidateUsername({ name: "Player One", isDefaultHero: false }, 0, () => "unused")).toBe("Player One");
    expect(candidateUsername({ name: "Player One", isDefaultHero: false }, 1, () => "0a1b2c3d")).toBe("Player One-0a1b2c3d");
  });

  test("a long Google name is shortened so the suffixed name still fits", () => {
    const long = "ABCDEFGHIJKLMNOPQRST"; // 20 characters
    const name = candidateUsername({ name: long, isDefaultHero: false }, 1, () => "0a1b2c3d");
    expect(name).toBe("ABCDEFGHIJK-0a1b2c3d");
    expect(name.length).toBeLessThanOrEqual(USERNAME_MAX_LENGTH);
    // No dangling space before the dash when the cut lands after a space.
    expect(candidateUsername({ name: "Ann Marie Smith Jr", isDefaultHero: false }, 1, () => "0a1b2c3d")).toBe("Ann Marie S-0a1b2c3d");
    expect(candidateUsername({ name: "John Smith Junior", isDefaultHero: false }, 1, () => "0a1b2c3d")).toBe("John Smith-0a1b2c3d");
  });
});

describe("unique username index", () => {
  test("rejects the same name ignoring case, but allows different names", () => {
    const db = openUsersDb();
    const insert = (id: string, sub: string, name: string) =>
      db.query("INSERT INTO users (id, google_sub, email, username) VALUES (?, ?, 'e@x.com', ?)").run(id, sub, name);
    insert("1", "s1", "Hero-0a1b2c3d");
    expect(() => insert("2", "s2", "hero-0A1B2C3D")).toThrow(/UNIQUE/);
    expect(() => insert("3", "s3", "Hero-0a1b2c3e")).not.toThrow();
  });
});

describe("findOrCreateUser", () => {
  test("creates a Hero-xxxxxxxx user for an account with no usable name", async () => {
    const store = sqliteStore(openUsersDb());
    const user = await findOrCreateUser(store, noName("a"), () => "id-a", sequence("0a1b2c3d"));
    expect(user?.username).toBe("Hero-0a1b2c3d");
  });

  test("returns the existing user and does not generate a name again", async () => {
    const store = sqliteStore(openUsersDb());
    const first = await findOrCreateUser(store, noName("a"), () => "id-a", sequence("0a1b2c3d"));
    const again = await findOrCreateUser(store, noName("a"), () => "id-other", sequence());
    expect(again?.id).toBe(first?.id);
    expect(again?.username).toBe("Hero-0a1b2c3d");
  });

  test("retries with a new suffix when the generated name is taken", async () => {
    const store = sqliteStore(openUsersDb());
    await findOrCreateUser(store, noName("a"), () => "id-a", sequence("0a1b2c3d"));
    const user = await findOrCreateUser(store, noName("b"), () => "id-b", sequence("0a1b2c3d", "0a1b2c3d", "11223344"));
    expect(user?.username).toBe("Hero-11223344");
  });

  test("a taken Google name falls back to a suffixed name, ignoring case", async () => {
    const store = sqliteStore(openUsersDb());
    const first = await findOrCreateUser(store, named("Player One", "a"), () => "id-a", sequence());
    const second = await findOrCreateUser(store, named("player one", "b"), () => "id-b", sequence("0a1b2c3d"));
    expect(first?.username).toBe("Player One");
    expect(second?.username).toBe("player one-0a1b2c3d");
  });

  test("gives up with null after repeated collisions instead of looping", async () => {
    const store = sqliteStore(openUsersDb());
    await findOrCreateUser(store, noName("a"), () => "id-a", sequence("0a1b2c3d"));
    let ids = 0;
    const user = await findOrCreateUser(store, noName("b"), () => `id-b${ids++}`, () => "0a1b2c3d");
    expect(user).toBeNull();
    expect(ids).toBe(5);
  });

  test("a concurrent sign-in of the same account creates one user, not a duplicate or an error", async () => {
    const store = sqliteStore(openUsersDb());
    const [x, y] = await Promise.all([
      findOrCreateUser(store, noName("same"), () => "id-x", sequence("aaaaaaaa")),
      findOrCreateUser(store, noName("same"), () => "id-y", sequence("bbbbbbbb"))
    ]);
    expect(x).not.toBeNull();
    expect(y?.id).toBe(x?.id);
  });
});
