/**
 * Cloudflare Worker HTTP/WebSocket entry point built with Hono.
 * Responsibilities:
 *  - Health check (`/api/health`) and authenticated profile lookup (`/api/me`).
 *  - Google OAuth sign-in (`/api/auth/google`) with unique username assignment (`Hero-xxxxxxxx` fallback).
 *  - Regional shard selection, resume lookup, and WebSocket ticket issuance (`/api/join`, `/api/ws-ticket`).
 *  - WebSocket upgrade routing (`/ws/:roomId`) with ticket verification and forwarding of the verified user id (`X-Player-Id`)
 *    to the target `GameRoom` Durable Object shard.
 */
import { Hono, type Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { users, type UserProfile } from "./db/d1-schema";
import {
  MAX_SHARDS_PER_REGION,
  ROOM_HARD_CAP,
  ROOM_SOFT_CAP,
  isContinent,
  parseShardId,
  regionalShardId,
  type Continent
} from "shared/shard-config";
import { d1UserStore, findOrCreateUser, type GoogleUser } from "./user-provisioning";
import { requireGoogleClientId, requireJwtSecret } from "./config";
import { canReconnectToShard, pickFirstOpenShard, type ShardStats } from "./shard-routing";
import {
  GoogleKeysUnavailableError,
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

// Soft cap (shared) triggers shard rollover during matchmaking; the hard cap is enforced inside GameRoom.
const SHARD_CACHE_TTL_MS = 3_000;

// Maps continent codes to Cloudflare Durable Object location hints for lower-latency shard placement.
const CONTINENT_TO_HINT: Record<Continent, DurableObjectLocationHint> = {
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
 * Normalizes a Cloudflare request continent code to a supported region prefix, defaulting to `"na"`.
 */
function resolveContinent(cfContinent: unknown): Continent {
  const raw = typeof cfContinent === "string" ? cfContinent.toLowerCase() : "na";
  return isContinent(raw) ? raw : "na";
}

/**
 * Obtains a `GameRoom` Durable Object stub for `regionalRoomId` using the continent's location hint.
 */
function getRoomStub(env: Env, regionalRoomId: string, continent: Continent) {
  return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(regionalRoomId), {
    locationHint: CONTINENT_TO_HINT[continent]
  });
}

/**
 * Validates and normalizes a requested shard name (e.g. `"overworld-1"` or `"eu-overworld-3"`)
 * into its full regional room ID and target continent.
 */
function normalizeRegionalRoomId(rawRoomId: string, defaultContinent: Continent): {
  regionalRoomId: string;
  targetContinent: Continent;
} | null {
  const parsed = parseShardId(rawRoomId.trim().toLowerCase());
  if (!parsed) return null;
  const targetContinent = parsed.continent ?? defaultContinent;
  return { regionalRoomId: regionalShardId(targetContinent, parsed.shard), targetContinent };
}

/**
 * Returns cached player occupancy for `regionalRoomId` if fresh, deduplicates in-flight
 * `/internal/stats` calls, or queries the `GameRoom` DO and caches the clamped result.
 */
async function getShardCount(
  env: Env,
  regionalRoomId: string,
  continent: Continent,
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
  continent: Continent,
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
      hardCap: stats.hardCap ?? ROOM_HARD_CAP
    };
  })().finally(() => {
    inFlightPlayerStats.delete(key);
  });

  inFlightPlayerStats.set(key, task);
  return task;
}

/**
 * Selects the first shard in `continent` under `ROOM_SOFT_CAP` (fill-first, see `pickFirstOpenShard`),
 * trusting fresh cache entries and probing stale shards one at a time.
 */
async function selectFirstOpenRegionalShard(
  env: Env,
  continent: Continent,
  now: number
): Promise<{ roomId: string; count: number } | null> {
  const regionShardIds: string[] = [];
  for (let shard = 1; shard <= MAX_SHARDS_PER_REGION; shard++) {
    regionShardIds.push(regionalShardId(continent, shard));
  }

  return pickFirstOpenShard(
    regionShardIds,
    ROOM_SOFT_CAP,
    (roomId) => {
      const cached = shardCountCache.get(roomId);
      return cached && now < cached.expiresAt ? cached.count : undefined;
    },
    (roomId) => getShardCount(env, roomId, continent, now),
    (roomId, err) => console.warn(`Skipping unhealthy shard ${roomId}:`, err)
  );
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
 * present in that shard (e.g., reconnecting or resuming a battle), otherwise choosing the first open
 * shard—and mints a room-bound WebSocket ticket.
 */
async function issueShardSessionTicket(
  env: Env,
  secret: string,
  userId: string,
  continent: Continent,
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

  const openShard = await selectFirstOpenRegionalShard(env, continent, now);
  if (!openShard) {
    return { status: 503, body: { error: "All regional shards are currently full" } };
  }

  // Optimistically increment cached occupancy (clamped to ROOM_SOFT_CAP) so a burst of joins cannot overfill one shard.
  const current = shardCountCache.get(openShard.roomId);
  const baseCount = current ? current.count : openShard.count;
  const nextCount = Math.min(ROOM_SOFT_CAP, Math.max(0, baseCount) + 1);
  shardCountCache.set(openShard.roomId, {
    count: nextCount,
    expiresAt: current ? current.expiresAt : now + SHARD_CACHE_TTL_MS
  });

  const wsTicket = await mintWsTicket(secret, userId, openShard.roomId, now);
  return {
    status: 200,
    body: {
      roomId: openShard.roomId,
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
  continent: Continent,
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
  "id" | "username" | "level" | "xp" | "gold" | "maxHp" | "attack" | "defense"
>;

/**
 * Projects a D1 `UserProfile` row into `PublicUserProfile` for API responses. The e-mail address and Google
 * account id are never sent to the client: it has no use for them, and keeping them server-side means a
 * stolen session token cannot be used to read them back.
 */
function toPublicProfile(profile: UserProfile): PublicUserProfile {
  return {
    id: profile.id,
    username: profile.username,
    level: profile.level,
    xp: profile.xp,
    gold: profile.gold,
    maxHp: profile.maxHp,
    attack: profile.attack,
    defense: profile.defense
  };
}

type ShardTicketRequest = {
  secret: string;
  userId: string;
  continent: Continent;
  /** Optional room hint from the request body (`resumeRoomId` for join, `roomId` for ws-ticket). */
  roomHint: unknown;
};

/**
 * Common front half of `/api/join` and `/api/ws-ticket`: authenticates the session token, resolves the
 * caller's continent and reads the optional room hint from the JSON body (an empty or invalid body is
 * valid and means no hint). Returns null when the session token is missing, invalid or expired.
 *
 * This deliberately returns data rather than a `Response`: each route builds its own `c.json(...)`
 * responses so Hono can infer the exact status codes and bodies the client's RPC types depend on.
 */
async function readShardTicketRequest(
  c: Context<{ Bindings: Env }>,
  hintKey: "resumeRoomId" | "roomId"
): Promise<ShardTicketRequest | null> {
  const secret = requireJwtSecret(c.env);
  const userId = await verifySessionToken(c.req.header("Authorization"), secret);
  if (!userId) return null;

  let roomHint: unknown;
  try {
    const body: unknown = await c.req.json();
    if (typeof body === "object" && body !== null) {
      roomHint = (body as Record<string, unknown>)[hintKey];
    }
  } catch {
    // Missing or malformed body: proceed without a room hint.
  }

  return { secret, userId, continent: resolveContinent(c.req.raw.cf?.continent), roomHint };
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
  // Verifies a Google ID token, provisions a new user row with a unique username if needed,
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

    let googleUser: GoogleUser;
    try {
      googleUser = await verifyGoogleIdTokenWithJwks(body.idToken, googleClientId);
    } catch (err) {
      // Google's signing keys being unreachable is our outage, not the user's bad credential.
      if (err instanceof GoogleKeysUnavailableError) {
        console.error("Google signing keys unavailable:", err);
        return c.json({ error: "Sign-in is temporarily unavailable. Please try again shortly." }, 503);
      }
      console.warn("Google ID token verification failed:", err);
      return c.json({ error: "Invalid or expired Google credential" }, 401);
    }

    const profile = await findOrCreateUser(d1UserStore(drizzle(c.env.DB)), googleUser);
    if (!profile) {
      return c.json({ error: "Unable to create user profile" }, 500);
    }

    const token = await mintSessionToken(secret, profile.id, profile.username);
    return c.json({ token, profile: toPublicProfile(profile) }, 200);
  })
  // Assigns or resumes a regional shard and issues a short-lived WebSocket ticket.
  .post("/api/join", async (c) => {
    const req = await readShardTicketRequest(c, "resumeRoomId");
    if (!req) return c.json({ error: "Invalid or expired session token" }, 401);

    const result = await issueShardSessionTicket(
      c.env,
      req.secret,
      req.userId,
      req.continent,
      Date.now(),
      req.roomHint
    );
    if (result.status === 200) return c.json(result.body, 200);
    return c.json(result.body, 503);
  })
  // Mints a fresh WebSocket ticket for reconnecting to the named room (409 if it cannot take the player back).
  .post("/api/ws-ticket", async (c) => {
    const req = await readShardTicketRequest(c, "roomId");
    if (!req) return c.json({ error: "Invalid or expired session token" }, 401);

    const result = await issueReconnectTicket(
      c.env,
      req.secret,
      req.userId,
      req.continent,
      Date.now(),
      req.roomHint
    );
    if (result.status === 200) return c.json(result.body, 200);
    if (result.status === 400) return c.json(result.body, 400);
    if (result.status === 409) return c.json(result.body, 409);
    return c.json(result.body, 503);
  })
  // Upgrades an authenticated WebSocket request after validating the room-bound ticket and
  // forwarding the verified user id via X-Player-Id to the GameRoom Durable Object.
  .get("/ws/:roomId", async (c) => {
    const secret = requireJwtSecret(c.env);
    if (c.req.header("Upgrade") !== "websocket") {
      return c.text("Expected WebSocket", 426);
    }

    const parsedRoom = normalizeRegionalRoomId(
      c.req.param("roomId"),
      resolveContinent(c.req.raw.cf?.continent)
    );
    if (!parsedRoom) {
      return c.text("Invalid room shard", 400);
    }
    const { regionalRoomId, targetContinent: shardContinent } = parsedRoom;

    const ticket = c.req.query("ticket");
    if (!ticket) return c.text("Missing WebSocket ticket", 401);

    const userId = await verifyWsTicket(ticket, secret, regionalRoomId);
    if (!userId) {
      return c.text("Invalid or expired WebSocket ticket", 401);
    }

    const stub = getRoomStub(c.env, regionalRoomId, shardContinent);
    const headers = new Headers(c.req.raw.headers);
    // `set` replaces any client-supplied value, and only the verified user id is forwarded. The room reads
    // everything else about the player from D1 itself (and 404s if the user no longer exists).
    headers.set("X-Player-Id", userId);

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
