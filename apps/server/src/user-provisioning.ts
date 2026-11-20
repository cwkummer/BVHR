/**
 * First-sign-in account creation. A user row is created the first time a Google account signs in, with a
 * username that is unique (case-insensitively; enforced by the `users_username_lower_unique` index).
 *
 * Names are never checked by scanning existing rows. Instead the insert is attempted and, if the unique
 * index rejects it, retried with a fresh random suffix, so two sign-ups racing for the same name cannot
 * both succeed and the cost does not grow with the number of users.
 */
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { users, type UserProfile } from "./db/d1-schema";

/** Longest username (and the length Google names are truncated to). */
export const USERNAME_MAX_LENGTH = 20;
/** Random suffix length: 8 hex characters (32 bits). */
const SUFFIX_HEX_LENGTH = 8;
/** `-` plus the hex suffix. */
const SUFFIX_LENGTH = 1 + SUFFIX_HEX_LENGTH;
/** Insert attempts before giving up; a retry only happens on a 1-in-4-billion name collision. */
const MAX_PROVISION_ATTEMPTS = 5;

export type GoogleUser = {
  googleSub: string;
  email: string;
  /** Google's display name (or e-mail prefix), or "Hero" when `isDefaultHero`. */
  name: string;
  /** True when Google gave us no usable name, so a generated `Hero-xxxxxxxx` name is used. */
  isDefaultHero: boolean;
};

export type NewUser = typeof users.$inferInsert;

/** The two database operations provisioning needs, so the retry logic can be tested without D1. */
export type UserStore = {
  findByGoogleSub(googleSub: string): Promise<UserProfile | undefined>;
  /** Inserts the user; a unique-constraint conflict (username, Google id or id) is silently ignored. */
  insertIgnoringConflicts(user: NewUser): Promise<void>;
};

/** Eight random lowercase hex characters. */
export function randomHexSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SUFFIX_HEX_LENGTH / 2));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The username to try on a given attempt. A generated default is always `Hero-<hex>`. A name from Google is
 * tried as is first, and falls back to `<name>-<hex>` (name shortened to fit 20 characters) if it is taken.
 */
export function candidateUsername(
  user: Pick<GoogleUser, "name" | "isDefaultHero">,
  attempt: number,
  hex: () => string = randomHexSuffix
): string {
  if (!user.isDefaultHero && attempt === 0) return user.name;
  const base = user.name.slice(0, USERNAME_MAX_LENGTH - SUFFIX_LENGTH).trimEnd();
  return `${base}-${hex()}`;
}

/**
 * Returns the user for this Google account, creating it on first sign-in. Returns null if no free username
 * could be inserted after several attempts.
 *
 * `insertIgnoringConflicts` cannot tell *why* an insert was ignored, so success is detected by reading the
 * row back: it exists if this insert won or if a concurrent sign-in of the same account created it, and
 * it is missing only when the username (or id) was taken, in which case we retry with a new suffix.
 */
export async function findOrCreateUser(
  store: UserStore,
  googleUser: GoogleUser,
  newId: () => string = () => crypto.randomUUID(),
  hex: () => string = randomHexSuffix
): Promise<UserProfile | null> {
  const existing = await store.findByGoogleSub(googleUser.googleSub);
  if (existing) return existing;

  for (let attempt = 0; attempt < MAX_PROVISION_ATTEMPTS; attempt++) {
    await store.insertIgnoringConflicts({
      id: newId(),
      googleSub: googleUser.googleSub,
      email: googleUser.email,
      username: candidateUsername(googleUser, attempt, hex),
      level: 1,
      xp: 0,
      gold: 50,
      maxHp: 100,
      attack: 15,
      defense: 6
    });
    const created = await store.findByGoogleSub(googleUser.googleSub);
    if (created) return created;
  }
  return null;
}

/** Backs `UserStore` with the global D1 `users` table. */
export function d1UserStore(db: DrizzleD1Database): UserStore {
  return {
    async findByGoogleSub(googleSub) {
      const [row] = await db.select().from(users).where(eq(users.googleSub, googleSub));
      return row;
    },
    async insertIgnoringConflicts(user) {
      await db.insert(users).values(user).onConflictDoNothing();
    }
  };
}
