/**
 * Cloudflare Worker HTTP/WebSocket entry point built with Hono.
 * Responsibilities:
 *  - Health check (`/api/health`) and authenticated profile lookup (`/api/me`).
 *  - Google OAuth sign-in (`/api/auth/google`) with unique fallback Adventurer username assignment.
 *  - Regional shard selection, resume lookup, and WebSocket ticket issuance (`/api/join`, `/api/ws-ticket`).
 *  - WebSocket upgrade routing (`/ws/:roomId`) with ticket verification and profile forwarding (`X-Player-Data`)
 *    to the target `GameRoom` Durable Object shard.
 */
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, like } from "drizzle-orm";
import { users, type UserProfile } from "./db/d1-schema";
import { canReconnectToShard, type ShardStats } from "./shard-routing";
import {
  mintSessionToken,
  mintWsTicket,
  verifyGoogleIdTokenWithJwks,
  verifySessionToken,
  verifyWsTicket
} from "./auth";
export { GameRoom } from "./game-room";

export type Env = {
  DB: D1Database;
  GAME_ROOM: DurableObjectNamespace;
  JWT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
};

type ShardCountCacheEntry = {
  count: number;
  expiresAt: number;
};

// Soft cap triggers shard rollover during matchmaking; hard cap is enforced inside GameRoom.
const ROOM_SOFT_CAP = 40;
const MAX_SHARDS_PER_REGION = 16;
const SHARD_PROBE_BATCH_SIZE = 4;
const SHARD_CACHE_TTL_MS = 3_000;
// Mirrors the hard cap enforced inside GameRoom; used only if a shard omits `hardCap` in its stats.
const DEFAULT_ROOM_HARD_CAP = 50;

const VALID_CONTINENTS = new Set(["na", "eu", "as", "oc", "sa", "af"]);
const SHARD_ID_RE = /^(?:(na|eu|as|oc|sa|af)-)?overworld-([1-9]|1[0-6])$/;

// Maps continent codes to Cloudflare Durable Object location hints for lower-latency shard placement.
const CONTINENT_TO_HINT: Record<string, DurableObjectLocationHint> = {
  na: "wnam",
  eu: "weur",
  as: "apac",
  oc: "oc",
  sa: "sam",
  af: "afr"
};

// Isolate-level caches and single-flight maps to coalesce concurrent shard occupancy probes.
const shardCountCache = new Map<string, ShardCountCacheEntry>();
const inFlightShardStats = new Map<string, Promise<number>>();
const inFlightPlayerStats = new Map<string, Promise<ShardStats>>();

/**
 * Ensures `JWT_SECRET` is configured with a minimum length before signing or verifying tokens.
 */
function requireJwtSecret(env: Env): string {
  if (!env.JWT_SECRET || env.JWT_SECRET.trim().length < 8) {
    throw new Error("JWT_SECRET is missing or too short");
  }
  return env.JWT_SECRET;
}

/**
 * Ensures `GOOGLE_CLIENT_ID` is configured before verifying Google ID token audiences.
 */
function requireGoogleClientId(env: Env): string {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_ID.trim()) {
    throw new Error("GOOGLE_CLIENT_ID is missing");
  }
  return env.GOOGLE_CLIENT_ID.trim();
}

/**
 * Normalizes a Cloudflare request continent code to a supported region prefix, defaulting to `"na"`.
 */
function resolveContinent(cfContinent: unknown): string {
  const raw = typeof cfContinent === "string" ? cfContinent.toLowerCase() : "na";
  return VALID_CONTINENTS.has(raw) ? raw : "na";
}

/**
 * Obtains a `GameRoom` Durable Object stub for `regionalRoomId` using the continent's location hint.
 */
function getRoomStub(env: Env, regionalRoomId: string, continent: string) {
  const hint = CONTINENT_TO_HINT[continent] ?? "wnam";
  return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(regionalRoomId), { locationHint: hint });
}

/**
 * Validates and normalizes a requested shard name (e.g. `"overworld-1"` or `"eu-overworld-3"`)
 * into its full regional room ID and target continent.
 */
function normalizeRegionalRoomId(rawRoomId: string, defaultContinent: string): {
  regionalRoomId: string;
  targetContinent: string;
} | null {
  const normalized = rawRoomId.trim().toLowerCase();
  const match = SHARD_ID_RE.exec(normalized);
  if (!match) return null;
  const targetContinent = match[1] || defaultContinent;
  const regionalRoomId = match[1] ? normalized : `${defaultContinent}-${normalized}`;
  return { regionalRoomId, targetContinent };
}

/**
 * Returns cached player occupancy for `regionalRoomId` if fresh, deduplicates in-flight
 * `/internal/stats` calls, or queries the `GameRoom` DO and caches the clamped result.
 */
async function getShardCount(
  env: Env,
  regionalRoomId: string,
  continent: string,
  now: number
): Promise<number> {
  const cached = shardCountCache.get(regionalRoomId);
  if (cached && now < cached.expiresAt) {
    return cached.count;
  }
  const existing = inFlightShardStats.get(regionalRoomId);
  if (existing) {
    return existing;
  }

  const task = (async () => {
    const stub = getRoomStub(env, regionalRoomId, continent);
    const res = await stub.fetch("https://internal/internal/stats");
    if (!res.ok) {
      throw new Error(`Shard stats failed (${res.status}) for ${regionalRoomId}`);
    }
    const { count } = (await res.json()) as { count: number };

    shardCountCache.set(regionalRoomId, {
      count: Math.min(ROOM_SOFT_CAP, Math.max(0, count)),
      expiresAt: Date.now() + SHARD_CACHE_TTL_MS
    });

    return count;
  })().finally(() => {
    inFlightShardStats.delete(regionalRoomId);
  });

  inFlightShardStats.set(regionalRoomId, task);
  return task;
}

/**
 * Queries `/internal/stats?playerId=...` on a shard to check both occupancy and whether
 * `playerId` is currently active/in-battle in that room, deduplicating per `${regionalRoomId}:${playerId}`.
 */
async function fetchShardStatsWithPlayer(
  env: Env,
  regionalRoomId: string,
  continent: string,
  playerId: string
): Promise<ShardStats> {
  const key = `${regionalRoomId}:${playerId}`;
  const existing = inFlightPlayerStats.get(key);
  if (existing) {
    return existing;
  }

  const task = (async () => {
    const stub = getRoomStub(env, regionalRoomId, continent);
    const res = await stub.fetch(
      `https://internal/internal/stats?playerId=${encodeURIComponent(playerId)}`
    );
    if (!res.ok) {
      throw new Error(`Shard stats failed (${res.status}) for ${regionalRoomId}`);
    }
    const stats = (await res.json()) as { count: number; hasPlayer?: boolean; hardCap?: number };
    shardCountCache.set(regionalRoomId, {
      count: Math.min(ROOM_SOFT_CAP, Math.max(0, stats.count)),
      expiresAt: Date.now() + SHARD_CACHE_TTL_MS
    });
    return {
      count: stats.count,
      hasPlayer: Boolean(stats.hasPlayer),
      hardCap: stats.hardCap ?? DEFAULT_ROOM_HARD_CAP
    };
  })().finally(() => {
    inFlightPlayerStats.delete(key);
  });

  inFlightPlayerStats.set(key, task);
  return task;
}

/**
 * Selects the lowest-occupancy shard under `ROOM_SOFT_CAP` in `continent`:
 *  1. Checks warm cache entries first so already-known open shards avoid waking cold DOs.
 *  2. Probes uncached shards in small batches (`SHARD_PROBE_BATCH_SIZE`), stopping as soon as a
 *     batch yields at least one open shard below `ROOM_SOFT_CAP`.
 */
async function selectLowestOccupancyRegionalShard(
  env: Env,
  continent: string,
  now: number
): Promise<{ roomId: string; count: number } | null> {
  const regionShardIds: string[] = [];
  for (let shard = 1; shard <= MAX_SHARDS_PER_REGION; shard++) {
    regionShardIds.push(`${continent}-overworld-${shard}`);
  }

  // 1. Poll warm cache entries first before waking DOs.
  let bestCachedOpen: { roomId: string; count: number } | null = null;
  let allCachedFull = true;
  const uncachedIds: string[] = [];

  for (const roomId of regionShardIds) {
    const cached = shardCountCache.get(roomId);
    if (cached && now < cached.expiresAt) {
      if (cached.count < ROOM_SOFT_CAP) {
        allCachedFull = false;
        if (!bestCachedOpen || cached.count < bestCachedOpen.count) {
          bestCachedOpen = { roomId, count: cached.count };
        }
      }
    } else {
      uncachedIds.push(roomId);
    }
  }

  if (bestCachedOpen) {
    return bestCachedOpen;
  }

  // If every shard in the region is freshly cached at or above soft cap and none are uncached, return full.
  if (allCachedFull && uncachedIds.length === 0) {
    return null;
  }

  // 2. Probe remaining/uncached shards in small batches, stopping early once an open shard is found.
  let bestLiveOpen: { roomId: string; count: number } | null = null;

  for (let start = 0; start < uncachedIds.length; start += SHARD_PROBE_BATCH_SIZE) {
    const batchIds = uncachedIds.slice(start, start + SHARD_PROBE_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batchIds.map(async (roomId) => ({
        roomId,
        count: await getShardCount(env, roomId, continent, now)
      }))
    );

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status !== "fulfilled") {
        console.warn(`Skipping unhealthy shard ${batchIds[i]}:`, result.reason);
        continue;
      }
      const candidate = result.value;
      if (candidate.count < ROOM_SOFT_CAP && (!bestLiveOpen || candidate.count < bestLiveOpen.count)) {
        bestLiveOpen = candidate;
      }
    }

    if (bestLiveOpen) {
      return bestLiveOpen;
    }
  }

  return null;
}

type ShardTicketSuccess = {
  roomId: string;
  wsTicket: string;
  count: number;
  cap: number;
};

type ShardTicketResult =
  | { status: 200; body: ShardTicketSuccess }
  | { status: 400 | 409 | 503; body: { error: string } };

/**
 * Resolves a player's target regional shard—honoring `preferredRoomId` when the player is already
 * present in that shard (e.g., reconnecting or resuming a battle), otherwise choosing the lowest-occupancy
 * shard—and mints a room-bound WebSocket ticket.
 */
async function issueShardSessionTicket(
  env: Env,
  secret: string,
  userId: string,
  continent: string,
  now: number,
  preferredRoomId?: unknown
): Promise<ShardTicketResult> {
  if (typeof preferredRoomId === "string") {
    const parsed = normalizeRegionalRoomId(preferredRoomId, continent);
    if (parsed) {
      try {
        const stats = await fetchShardStatsWithPlayer(
          env,
          parsed.regionalRoomId,
          parsed.targetContinent,
          userId
        );
        if (stats.hasPlayer) {
          const wsTicket = await mintWsTicket(secret, userId, parsed.regionalRoomId, now);
          return {
            status: 200,
            body: {
              roomId: parsed.regionalRoomId,
              wsTicket,
              count: stats.count,
              cap: ROOM_SOFT_CAP
            }
          };
        }
      } catch (err) {
        console.warn(`Resume check failed for ${parsed.regionalRoomId}:`, err);
      }
    }
  }

  const lowestShard = await selectLowestOccupancyRegionalShard(env, continent, now);
  if (!lowestShard) {
    return { status: 503, body: { error: "All regional shards are currently full" } };
  }

  // Optimistically increment cached occupancy (clamped to ROOM_SOFT_CAP) to spread bursty joins.
  const current = shardCountCache.get(lowestShard.roomId);
  const baseCount = current ? current.count : lowestShard.count;
  const nextCount = Math.min(ROOM_SOFT_CAP, Math.max(0, baseCount) + 1);
  shardCountCache.set(lowestShard.roomId, {
    count: nextCount,
    expiresAt: current ? current.expiresAt : now + SHARD_CACHE_TTL_MS
  });

  const wsTicket = await mintWsTicket(secret, userId, lowestShard.roomId, now);
  return {
    status: 200,
    body: {
      roomId: lowestShard.roomId,
      wsTicket,
      count: nextCount,
      cap: ROOM_SOFT_CAP
    }
  };
}

/**
 * Mints a ticket for exactly `requestedRoomId` (reconnect semantics). Unlike `/api/join`, this never
 * substitutes another shard: if the room is unavailable the caller gets 409 (or 503 if the shard cannot
 * be reached) and is expected to re-run matchmaking. With no room id, falls back to normal matchmaking.
 */
async function issueReconnectTicket(
  env: Env,
  secret: string,
  userId: string,
  continent: string,
  now: number,
  requestedRoomId?: unknown
): Promise<ShardTicketResult> {
  if (typeof requestedRoomId !== "string") {
    return issueShardSessionTicket(env, secret, userId, continent, now);
  }
  const parsed = normalizeRegionalRoomId(requestedRoomId, continent);
  if (!parsed) {
    return { status: 400, body: { error: "Invalid room shard" } };
  }

  let stats: ShardStats;
  try {
    stats = await fetchShardStatsWithPlayer(env, parsed.regionalRoomId, parsed.targetContinent, userId);
  } catch (err) {
    console.warn(`Reconnect stats failed for ${parsed.regionalRoomId}:`, err);
    return { status: 503, body: { error: "Room is temporarily unavailable" } };
  }
  if (!canReconnectToShard(stats)) {
    return { status: 409, body: { error: "Room is full; rejoin matchmaking" } };
  }

  const wsTicket = await mintWsTicket(secret, userId, parsed.regionalRoomId, now);
  return {
    status: 200,
    body: { roomId: parsed.regionalRoomId, wsTicket, count: stats.count, cap: ROOM_SOFT_CAP }
  };
}

type PublicUserProfile = Pick<
  UserProfile,
  "id" | "googleSub" | "username" | "email" | "level" | "xp" | "gold" | "maxHp" | "attack" | "defense"
>;

/**
 * Projects a D1 `UserProfile` row into `PublicUserProfile` for API responses and internal DO headers.
 */
function toPublicProfile(profile: UserProfile): PublicUserProfile {
  return {
    id: profile.id,
    googleSub: profile.googleSub,
    username: profile.username,
    email: profile.email,
    level: profile.level,
    xp: profile.xp,
    gold: profile.gold,
    maxHp: profile.maxHp,
    attack: profile.attack,
    defense: profile.defense
  };
}

const baseApp = new Hono<{ Bindings: Env }>();

// Global error boundary returning a uniform JSON 500 response on unhandled exceptions.
baseApp.onError((err, c) => {
  console.error("Unhandled worker error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

const app = baseApp
  // Lightweight liveness probe for health checks.
  .get("/api/health", (c) => {
    return c.json({ ok: true, service: "bhvr-rpg-game" }, 200);
  })
  // Returns the authenticated caller's current D1 profile projection.
  .get("/api/me", async (c) => {
    const secret = requireJwtSecret(c.env);
    const userId = await verifySessionToken(c.req.header("Authorization"), secret);
    if (!userId) {
      return c.json({ error: "Invalid or expired session token" }, 401);
    }
    const d1 = drizzle(c.env.DB);
    const [profile] = await d1.select().from(users).where(eq(users.id, userId));
    if (!profile) {
      return c.json({ error: "Player not found" }, 404);
    }
    return c.json({ profile: toPublicProfile(profile) }, 200);
  })
  // Verifies a Google ID token, provisions a new user row with a unique fallback name if needed,
  // and returns a scoped session JWT along with the user's public profile.
  .post("/api/auth/google", async (c) => {
    const secret = requireJwtSecret(c.env);
    const googleClientId = requireGoogleClientId(c.env);

    let body: { idToken?: string };
    try {
      body = await c.req.json<{ idToken?: string }>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.idToken || typeof body.idToken !== "string" || body.idToken.length > 8192) {
      return c.json({ error: "Missing or invalid Google idToken" }, 400);
    }

    let googleUser: { googleSub: string; email: string; name: string; isDefaultAdventurer: boolean };
    try {
      googleUser = await verifyGoogleIdTokenWithJwks(body.idToken, googleClientId);
    } catch (err) {
      console.warn("Google ID token verification failed:", err);
      return c.json({ error: "Invalid or expired Google credential" }, 401);
    }

    const d1 = drizzle(c.env.DB);
    let [profile] = await d1.select().from(users).where(eq(users.googleSub, googleUser.googleSub));

    if (!profile) {
      let resolvedUsername = googleUser.name;
      if (googleUser.isDefaultAdventurer) {
        // Assign a unique numbered "Adventurer<N>" name within 20 chars when no explicit name/prefix exists.
        const existing = await d1
          .select({ username: users.username })
          .from(users)
          .where(like(users.username, "Adventurer%"));
        const taken = new Set(existing.map((row) => row.username.toLowerCase()));
        let suffix = 1;
        while (suffix < 100_000) {
          const suffixStr = String(suffix);
          const prefix = googleUser.name.slice(0, Math.max(1, 20 - suffixStr.length));
          const candidateName = `${prefix}${suffixStr}`;
          if (!taken.has(candidateName.toLowerCase())) {
            resolvedUsername = candidateName;
            break;
          }
          suffix += 1;
        }
        if (suffix >= 100_000) {
          resolvedUsername = `${googleUser.name.slice(0, 10)}${crypto.randomUUID().slice(0, 8)}`;
        }
      }

      const candidate = {
        id: crypto.randomUUID(),
        googleSub: googleUser.googleSub,
        email: googleUser.email,
        username: resolvedUsername,
        level: 1,
        xp: 0,
        gold: 50,
        maxHp: 100,
        attack: 15,
        defense: 6
      };
      await d1.insert(users).values(candidate).onConflictDoNothing();
      [profile] = await d1.select().from(users).where(eq(users.googleSub, googleUser.googleSub));
      if (!profile) {
        return c.json({ error: "Unable to create user profile" }, 500);
      }
    }

    const token = await mintSessionToken(secret, profile.id, profile.username);
    return c.json({ token, profile: toPublicProfile(profile) }, 200);
  })
  // Assigns or resumes a regional shard and issues a short-lived WebSocket ticket.
  .post("/api/join", async (c) => {
    const secret = requireJwtSecret(c.env);
    const userId = await verifySessionToken(c.req.header("Authorization"), secret);
    if (!userId) return c.json({ error: "Invalid or expired session token" }, 401);

    const continent = resolveContinent(c.req.raw.cf?.continent);
    const now = Date.now();

    let resumeRoomId: unknown;
    try {
      const body = await c.req.json<{ resumeRoomId?: unknown }>();
      resumeRoomId = body.resumeRoomId;
    } catch {
      // Empty request body is valid when joining without a prior room hint.
    }

    const result = await issueShardSessionTicket(c.env, secret, userId, continent, now, resumeRoomId);
    if (result.status === 200) return c.json(result.body, 200);
    return c.json(result.body, 503);
  })
  // Mints a fresh WebSocket ticket for reconnecting to the named room (409 if it cannot take the player back).
  .post("/api/ws-ticket", async (c) => {
    const secret = requireJwtSecret(c.env);
    const userId = await verifySessionToken(c.req.header("Authorization"), secret);
    if (!userId) return c.json({ error: "Invalid or expired session token" }, 401);

    let requestedRoomId: unknown;
    try {
      const body = await c.req.json<{ roomId?: unknown }>();
      requestedRoomId = body.roomId;
    } catch {
      // Optional body; falls back to lowest-occupancy regional shard selection.
    }

    const continent = resolveContinent(c.req.raw.cf?.continent);
    const result = await issueReconnectTicket(c.env, secret, userId, continent, Date.now(), requestedRoomId);
    if (result.status === 200) return c.json(result.body, 200);
    if (result.status === 400) return c.json(result.body, 400);
    if (result.status === 409) return c.json(result.body, 409);
    return c.json(result.body, 503);
  })
  // Upgrades an authenticated WebSocket request after validating the room-bound ticket and
  // forwarding the player's projected profile via X-Player-Data to the GameRoom Durable Object.
  .get("/ws/:roomId", async (c) => {
    const secret = requireJwtSecret(c.env);
    if (c.req.header("Upgrade") !== "websocket") {
      return c.text("Expected WebSocket", 426);
    }

    const rawRoomId = c.req.param("roomId").toLowerCase();
    const match = SHARD_ID_RE.exec(rawRoomId);
    if (!match) {
      return c.text("Invalid room shard", 400);
    }

    const continent = resolveContinent(c.req.raw.cf?.continent);
    const regionalRoomId = match[1] ? rawRoomId : `${continent}-${rawRoomId}`;

    const ticket = c.req.query("ticket");
    if (!ticket) return c.text("Missing WebSocket ticket", 401);

    const userId = await verifyWsTicket(ticket, secret, regionalRoomId);
    if (!userId) {
      return c.text("Invalid or expired WebSocket ticket", 401);
    }

    const d1 = drizzle(c.env.DB);
    const [profile] = await d1.select().from(users).where(eq(users.id, userId));
    if (!profile) return c.text("Player not found", 404);

    const shardContinent = match[1] || continent;
    const stub = getRoomStub(c.env, regionalRoomId, shardContinent);
    const headers = new Headers(c.req.raw.headers);
    headers.set("X-Player-Data", JSON.stringify(toPublicProfile(profile)));

    const res = await stub.fetch(new Request(c.req.url, { headers }));
    if (res.status === 503) {
      shardCountCache.set(regionalRoomId, {
        count: ROOM_SOFT_CAP,
        expiresAt: Date.now() + SHARD_CACHE_TTL_MS
      });
    }
    return res;
  });

export type AppType = typeof app;
export default app;
