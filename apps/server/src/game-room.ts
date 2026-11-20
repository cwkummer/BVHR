/**
 * Stateful regional shard Durable Object (`GameRoom`) managing real-time player movement,
 * encounter zone triggers, serialized turn-based combat with turn timeouts, and durable
 * outbox synchronization (`pending_rewards` -> D1 `users` + `reward_claims`).
 *
 * Concurrency & durability guarantees:
 *  - `ctx.blockConcurrencyWhile(...)` runs DO SQLite migrations, recovers active players/battles,
 *    prunes orphaned rows, restores unexpired post-battle cooldowns, and arms the next alarm.
 *  - Movement runs on a 50ms on-demand loop while players hold non-zero WASD vectors and flushes
 *    dirty coordinates to DO SQLite at most once per second or when movement stops.
 *  - Per-battle promises (`battleLocks`) serialize player actions and timeout resolutions so turns
 *    never race or double-apply.
 *  - Battle rewards are recorded in DO `pending_rewards` and idempotently credited to D1 via
 *    `reward_claims` + `users`, retrying with exponential backoff via `alarm()` on failure (never dropped).
 */
import { DurableObject } from "cloudflare:workers";
import { drizzle, DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../drizzle-do/migrations/migrations";
import { players, battles, pendingRewards, PlayerRow } from "./db/do-schema";
import { parseCombatStats, parsePlayerIdentityHeader, type CombatStats, type PlayerIdentity } from "./player-identity";
import { ROOM_HARD_CAP, ROOM_SOFT_CAP } from "../../../shared/shard-config";
import { BUILDINGS, stepMovement } from "../../../shared/map-zones";
import type { ClientMessage, ServerMessage, BattleAction, BattleState, PlayerSnapshot } from "../../../shared/protocol";
import type { Env } from "./index";
import {
  BATTLE_REWARD_GOLD,
  BATTLE_REWARD_XP,
  POST_BATTLE_IMMUNITY_MS,
  TURN_TIMEOUT_MS,
  computeBasicAttackDamage,
  computeHealedHp,
  shouldForfeitOnTimeout
} from "./combat";
import { pickEncounterPairs } from "./encounters";
import { and, eq, lte, min } from "drizzle-orm";

/**
 * In-memory runtime extension of a persisted `PlayerRow` holding input vectors, dirty flag,
 * per-connection token-bucket rate limit state, and post-battle encounter immunity timestamp.
 */
type LivePlayer = PlayerRow & {
  dx: number;
  dy: number;
  dirty: boolean;
  msgTokens: number;
  lastTokenRefill: number;
  /** True after entering a zone until a battle ends; see `pickEncounterPairs`. */
  zoneArmed: boolean;
  /** True while combat stats are being read from D1 for an imminent battle; blocks movement and re-matching. */
  encounterPending: boolean;
};

const ENCOUNTER_RETRY_MS = 2_000;
const MAX_MSGS_PER_SEC = 30;
const INITIAL_REWARD_RETRY_MS = 5_000;
const MAX_REWARD_RETRY_MS = 300_000;
const MAX_REWARD_ATTEMPTS = 10;
const VALID_BATTLE_ACTIONS = new Set<BattleAction>(["ATTACK", "HEAL", "FLEE"]);

export class GameRoom extends DurableObject<Env> {
  db: DrizzleSqliteDODatabase;
  private state = new Map<string, LivePlayer>();
  private loop: ReturnType<typeof setTimeout> | null = null;
  private loopTickActive = false;
  private lastTickAt = 0;
  private lastPositionFlushAt = 0;
  private lastScheduledAlarmAt: number | null | undefined = undefined;
  private battleLocks = new Map<string, Promise<void>>();
  private inFlightRewardIds = new Set<string>();
  // Earliest time a failed encounter start (D1 stats unavailable) may be retried; null when not backing off.
  private encounterRetryAt: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    // Respond automatically to lightweight "ping" frames without waking or running full message handlers.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

    ctx.blockConcurrencyWhile(async () => {
      migrate(this.db, migrations);
      const now = Date.now();
      this.lastTickAt = now;
      this.lastPositionFlushAt = now;
      this.lastScheduledAlarmAt = undefined;

      // Collect player IDs that already have an open WebSocket across hibernation/restart.
      const openPlayerIds = new Set<string>();
      for (const ws of this.ctx.getWebSockets()) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        const session = ws.deserializeAttachment() as { playerId?: string } | null;
        if (session?.playerId) openPlayerIds.add(session.playerId);
      }

      const playerRows = this.db.select().from(players).all();
      const persistedPlayerIds = new Set(playerRows.map((p) => p.id));
      const activeBattles = this.db
        .select()
        .from(battles)
        .where(eq(battles.status, "ACTIVE"))
        .all();

      const validBattleIds = new Set<string>();
      this.ctx.storage.transactionSync(() => {
        // Remove any active battle whose participants are missing from persisted players.
        for (const b of activeBattles) {
          if (persistedPlayerIds.has(b.player1Id) && persistedPlayerIds.has(b.player2Id)) {
            validBattleIds.add(b.id);
          } else {
            this.db.delete(battles).where(eq(battles.id, b.id)).run();
          }
        }

        // Clear dangling battle references, prune idle disconnected players, and hydrate live state.
        for (const p of playerRows) {
          let battleId = p.battleId;
          let hp = p.hp;

          if (battleId && !validBattleIds.has(battleId)) {
            battleId = null;
            hp = p.maxHp;
            this.db.update(players).set({ battleId: null, hp }).where(eq(players.id, p.id)).run();
          }

          if (!battleId && !openPlayerIds.has(p.id)) {
            this.db.delete(players).where(eq(players.id, p.id)).run();
            continue;
          }

          this.state.set(p.id, {
            ...p,
            battleId,
            hp,
            dx: 0,
            dy: 0,
            dirty: false,
            msgTokens: MAX_MSGS_PER_SEC,
            lastTokenRefill: now,
            zoneArmed: false,
            encounterPending: false
          });
        }
      });

      await this.syncNextAlarm();
    });
  }

  /**
   * Handles internal occupancy/player queries (`/internal/stats`) and WebSocket upgrade
   * requests forwarded by the Worker entry point.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/stats") {
      return this.handleInternalStats(url);
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return Response.json({ error: "Expected WebSocket upgrade" }, { status: 426 });
    }

    const profile = this.parsePlayerProfileHeader(request);
    if (!profile) {
      return Response.json({ error: "Missing or invalid player profile header" }, { status: 400 });
    }

    // Read combat stats from D1 before touching any room state: the await lets other events interleave,
    // so the capacity check and player creation below must run after it, synchronously.
    let stats: CombatStats | undefined;
    try {
      stats = (await this.loadCombatStats([profile.id])).get(profile.id);
    } catch (err) {
      console.error("Failed to load player stats from D1:", err);
      return Response.json({ error: "Player stats are temporarily unavailable" }, { status: 503 });
    }
    if (!stats) {
      return Response.json({ error: "Player not found" }, { status: 404 });
    }

    const existingPlayer = this.state.get(profile.id);
    // Reject brand-new joins once the shard reaches ROOM_HARD_CAP; allow existing players to reconnect.
    if (!existingPlayer && this.getCurrentOccupancy() >= ROOM_HARD_CAP) {
      return Response.json(
        { error: "Room is at hard capacity", maxPlayers: ROOM_HARD_CAP },
        { status: 503 }
      );
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ playerId: profile.id });

    this.closeSupersededSockets(profile.id, server);

    const { player, isNewJoin } = this.hydrateOrCreatePlayer(profile, stats);
    this.sendInitialSync(server, profile.id, player, isNewJoin);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Computes current shard occupancy as the max of tracked `LivePlayer` records and open sockets.
   */
  private getCurrentOccupancy(): number {
    const activeSockets = this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN).length;
    return Math.max(this.state.size, activeSockets);
  }

  /**
   * Responds to `/internal/stats` probes from the Worker router with current occupancy and
   * optional player membership (`hasPlayer`) for shard resume checks.
   */
  private handleInternalStats(url: URL): Response {
    const count = this.getCurrentOccupancy();
    const playerId = url.searchParams.get("playerId");
    const hasPlayer = playerId ? this.state.has(playerId) : false;
    return Response.json({
      count,
      hasPlayer,
      maxPlayers: ROOM_SOFT_CAP,
      softCap: ROOM_SOFT_CAP,
      hardCap: ROOM_HARD_CAP
    });
  }

  /**
   * Reads current `maxHp`/`attack`/`defense` for each user from D1 in a single batch. Users that are
   * missing or hold invalid values are absent from the result.
   */
  private async loadCombatStats(userIds: string[]): Promise<Map<string, CombatStats>> {
    const statements = userIds.map((id) =>
      this.env.DB.prepare("SELECT max_hp AS maxHp, attack, defense FROM users WHERE id = ?").bind(id)
    );
    const results = await this.env.DB.batch<Record<string, unknown>>(statements);
    const out = new Map<string, CombatStats>();
    results.forEach((result, i) => {
      const stats = parseCombatStats(result.results[0]);
      if (stats) out.set(userIds[i], stats);
    });
    return out;
  }

  /**
   * Extracts and validates the `X-Player-Data` identity header forwarded by the Worker entry point.
   * Returns null (rejecting the connection) if it is absent, malformed or out of range.
   */
  private parsePlayerProfileHeader(request: Request): PlayerIdentity | null {
    return parsePlayerIdentityHeader(request.headers.get("X-Player-Data"));
  }

  /**
   * Closes any prior open WebSocket belonging to `playerId` with close code 4001 so only one
   * active tab remains connected per player.
   */
  private closeSupersededSockets(playerId: string, activeWs: WebSocket): void {
    for (const existingWs of this.ctx.getWebSockets()) {
      if (existingWs === activeWs) continue;
      const session = existingWs.deserializeAttachment() as { playerId?: string } | null;
      if (session?.playerId === playerId) {
        try {
          existingWs.close(4001, "Superseded by new session");
        } catch {
          // Ignore already-closing sockets.
        }
      }
    }
  }

  /**
   * Re-syncs an existing `LivePlayer` on reconnect (resetting movement/dirty state and refreshing
   * D1 stats when outside combat) or inserts and registers a brand-new player row.
   */
  private hydrateOrCreatePlayer(profile: PlayerIdentity, stats: CombatStats): { player: LivePlayer; isNewJoin: boolean } {
    let player = this.state.get(profile.id);
    const isNewJoin = !player;

    if (player) {
      // Reset stale movement vectors and dirty flag when a socket reconnects.
      player.dx = 0;
      player.dy = 0;
      player.dirty = false;

      // Sync username and stats from D1 when reconnecting outside of an active battle.
      if (!player.battleId) {
        player.username = profile.username;
        player.maxHp = stats.maxHp;
        player.hp = Math.min(player.hp, stats.maxHp);
        player.attack = stats.attack;
        player.defense = stats.defense;
        this.db
          .update(players)
          .set({
            username: player.username,
            maxHp: player.maxHp,
            hp: player.hp,
            attack: player.attack,
            defense: player.defense
          })
          .where(eq(players.id, player.id))
          .run();
      }
      return { player, isNewJoin };
    }

    const row: PlayerRow = {
      id: profile.id,
      username: profile.username,
      x: 120,
      y: 120,
      hp: stats.maxHp,
      maxHp: stats.maxHp,
      attack: stats.attack,
      defense: stats.defense,
      currentZoneId: null,
      battleId: null,
      battleCooldownUntil: 0
    };
    this.db.insert(players).values(row).run();
    player = {
      ...row,
      dx: 0,
      dy: 0,
      dirty: false,
      msgTokens: MAX_MSGS_PER_SEC,
      lastTokenRefill: Date.now(),
      zoneArmed: false,
      encounterPending: false
    };
    this.state.set(profile.id, player);
    return { player, isNewJoin };
  }

  /**
   * Sends the initial `SYNC_STATE` snapshot (including active battle HP percentages if mid-fight)
   * to the newly connected socket and broadcasts `PLAYER_JOINED` to other players on fresh joins.
   */
  private sendInitialSync(
    server: WebSocket,
    selfId: string,
    player: LivePlayer,
    isNewJoin: boolean
  ): void {
    // Re-hydrate active battle state (with server-computed HP percentages) if reconnecting mid-fight.
    const rawBattle = player.battleId
      ? this.db.select().from(battles).where(eq(battles.id, player.battleId)).get() ?? null
      : null;
    const activeBattle: BattleState | null = rawBattle
      ? {
          ...rawBattle,
          hpPercentByPlayerId: this.buildHpPercentMap([rawBattle.player1Id, rawBattle.player2Id])
        }
      : null;

    const syncMsg: ServerMessage = {
      type: "SYNC_STATE",
      serverNow: Date.now(),
      selfId,
      players: Array.from(this.state.values(), (p) => this.toPlayerSnapshot(p)),
      battle: activeBattle
    };
    server.send(JSON.stringify(syncMsg));

    if (isNewJoin) {
      this.broadcast({ type: "PLAYER_JOINED", player: this.toPlayerSnapshot(player) }, server);
    }
  }

  /**
   * Projects a `LivePlayer` into a lean `PlayerSnapshot` for room roster sync messages.
   */
  private toPlayerSnapshot(p: LivePlayer): PlayerSnapshot {
    return {
      id: p.id,
      username: p.username,
      x: p.x,
      y: p.y,
      currentZoneId: p.currentZoneId,
      battleId: p.battleId
    };
  }

  /**
   * Converts raw `hp` and `maxHp` into a clamped integer percentage in `[0, 100]` on the server
   * so clients can render health percentages without receiving exact HP or max HP values.
   */
  private toHpPercent(hp: number, maxHp: number): number {
    if (maxHp <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((hp / maxHp) * 100)));
  }

  /**
   * Builds a map of player ID to server-computed HP percentage for a list of battle participants.
   */
  private buildHpPercentMap(playerIds: string[]): Record<string, number> {
    const result: Record<string, number> = {};
    for (const id of playerIds) {
      const live = this.state.get(id);
      if (live) {
        result[id] = this.toHpPercent(live.hp, live.maxHp);
        continue;
      }
      const row = this.db.select().from(players).where(eq(players.id, id)).get();
      if (row) {
        result[id] = this.toHpPercent(row.hp, row.maxHp);
      }
    }
    return result;
  }

  /**
   * Processes incoming client WebSocket frames (`WASD` movement vectors and `BATTLE_ACTION` turns),
   * enforcing per-player token-bucket rate limiting (allowing stop `{ dx: 0, dy: 0 }` inputs through).
   */
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string") return;
    const session = ws.deserializeAttachment() as { playerId?: string } | null;
    if (!session?.playerId) return;
    const p = this.state.get(session.playerId!);
    if (!p) return;

    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }

    const isStopInput = msg.type === "WASD" && Number(msg.dx) === 0 && Number(msg.dy) === 0;
    const now = Date.now();
    const elapsedSec = (now - p.lastTokenRefill) / 1000;
    if (elapsedSec > 0) {
      p.msgTokens = Math.min(MAX_MSGS_PER_SEC, p.msgTokens + elapsedSec * MAX_MSGS_PER_SEC);
      p.lastTokenRefill = now;
    }
    if (!isStopInput) {
      if (p.msgTokens < 1) return;
      p.msgTokens -= 1;
    }

    if (msg.type === "WASD" && !p.battleId && !p.encounterPending) {
      const rawDx = Number(msg.dx);
      const rawDy = Number(msg.dy);
      p.dx = (Number.isFinite(rawDx) ? Math.sign(rawDx) : 0) as -1 | 0 | 1;
      p.dy = (Number.isFinite(rawDy) ? Math.sign(rawDy) : 0) as -1 | 0 | 1;

      if (p.dx !== 0 || p.dy !== 0) {
        this.ensureLoopRunning();
      }
    }

    if (
      msg.type === "BATTLE_ACTION" &&
      p.battleId &&
      msg.battleId === p.battleId &&
      typeof msg.turnNumber === "number" &&
      VALID_BATTLE_ACTIONS.has(msg.action)
    ) {
      const battleId = p.battleId;
      const action = msg.action;
      const expectedTurn = msg.turnNumber;
      await this.enqueueBattleTurn(battleId, async () => {
        await this.resolveTurnLocked(p.id, action, false, expectedTurn);
      });
    }
  }

  /**
   * Returns true if at least one player outside of combat currently has a non-zero movement input.
   */
  private hasMovingPlayers(): boolean {
    for (const p of this.state.values()) {
      if (!p.battleId && (p.dx !== 0 || p.dy !== 0)) return true;
    }
    return false;
  }

  /**
   * Advances movement for active non-battle players, checks building zone entry for PvP encounters,
   * flushes dirty positions periodically, and broadcasts position `SNAPSHOT` updates.
   */
  private async runMovementTick(): Promise<void> {
    const now = Date.now();
    const dt = Math.min(0.1, Math.max(0.01, (now - this.lastTickAt) / 1000));
    this.lastTickAt = now;

    let anyoneMoving = false;
    const movedPlayers: Array<{ id: string; x: number; y: number; currentZoneId: string | null }> = [];

    for (const p of this.state.values()) {
      if (p.battleId || p.encounterPending || (p.dx === 0 && p.dy === 0)) continue;
      anyoneMoving = true;
      p.dirty = true;

      const nextPos = stepMovement(p.x, p.y, p.dx, p.dy, dt);
      p.x = nextPos.x;
      p.y = nextPos.y;

      const zone = BUILDINGS.find((b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h);
      const newZoneId = zone ? zone.id : null;
      movedPlayers.push({ id: p.id, x: p.x, y: p.y, currentZoneId: newZoneId });

      if (p.currentZoneId !== newZoneId) {
        p.currentZoneId = newZoneId;

        // Entering a building arms this player to trigger an encounter; matching runs after the loop.
        p.zoneArmed = newZoneId !== null;
      }
    }

    // Not awaited: reading stats from D1 must not delay this tick's position broadcast.
    void this.startDueEncounters(now);

    const flushNow = Date.now();

    if (!anyoneMoving || flushNow - this.lastPositionFlushAt >= 1_000) {
      this.flushDirtyPositions();
      this.lastPositionFlushAt = flushNow;
    }

    if (movedPlayers.length > 0) {
      this.broadcast({
        type: "SNAPSHOT",
        players: movedPlayers
      });
    }
  }

  /**
   * Schedules the next 50ms movement loop tick if no timer is already pending.
   */
  private scheduleNextTick() {
    if (this.loop) return;
    this.loop = setTimeout(() => {
      this.loop = null;
      this.loopTickActive = true;
      void this.runMovementTick()
        .catch((err) => {
          console.error("Movement tick error:", err);
        })
        .finally(() => {
          this.loopTickActive = false;
          if (this.hasMovingPlayers()) {
            this.scheduleNextTick();
          }
        });
    }, 50);
  }

  /**
   * Starts the movement loop if idle and not currently mid-tick.
   */
  private ensureLoopRunning() {
    if (this.loop || this.loopTickActive) return;
    this.lastTickAt = Date.now();
    this.scheduleNextTick();
  }

  /**
   * Persists coordinates and `currentZoneId` for all players flagged `dirty` in a single DO transaction.
   */
  private flushDirtyPositions() {
    const dirtyPlayers = Array.from(this.state.values()).filter((p) => p.dirty);
    if (dirtyPlayers.length === 0) return;

    this.ctx.storage.transactionSync(() => {
      for (const p of dirtyPlayers) {
        this.db
          .update(players)
          .set({ x: p.x, y: p.y, currentZoneId: p.currentZoneId })
          .where(eq(players.id, p.id))
          .run();
        p.dirty = false;
      }
    });
  }

  /**
   * Begins every currently due zone encounter (see `pickEncounterPairs`). Matched players are frozen and
   * flagged pending synchronously, then each battle starts once their combat stats have been read from
   * D1. Skipped while backing off after a failed stats read. Never rejects; failures are logged.
   */
  private async startDueEncounters(now: number): Promise<void> {
    if (this.encounterRetryAt !== null) {
      if (now < this.encounterRetryAt) return;
      this.encounterRetryAt = null;
    }
    const candidates = Array.from(this.state.values()).filter((p) => !p.encounterPending);
    const tasks = pickEncounterPairs(candidates, now).map(({ zoneId, first, second }) => {
      for (const p of [first, second]) {
        p.dx = 0;
        p.dy = 0;
        p.encounterPending = true;
      }
      return this.beginEncounter(first, second, zoneId);
    });
    const settled = await Promise.allSettled(tasks);
    for (const r of settled) {
      if (r.status === "rejected") console.error("Failed to begin encounter:", r.reason);
    }
  }

  /**
   * Reads both players' combat stats from D1, re-checks that the pair is still eligible after the await,
   * then starts the battle at full HP. D1 is the only source of combat stats, so if either player's stats
   * cannot be read (outage, missing user, invalid values) no battle starts: the players stay where they
   * are and the match is retried after `ENCOUNTER_RETRY_MS` via the alarm.
   */
  private async beginEncounter(first: LivePlayer, second: LivePlayer, zoneId: string): Promise<void> {
    try {
      let fresh: Map<string, CombatStats>;
      try {
        fresh = await this.loadCombatStats([first.id, second.id]);
      } catch (err) {
        console.error("Battle not started: could not read stats from D1:", err);
        await this.deferEncounterRetry();
        return;
      }
      const firstStats = fresh.get(first.id);
      const secondStats = fresh.get(second.id);
      if (!firstStats || !secondStats) {
        console.error(`Battle not started: missing or invalid D1 stats for ${first.id} / ${second.id}`);
        await this.deferEncounterRetry();
        return;
      }

      const now = Date.now();
      const stillEligible = [first, second].every(
        (p) =>
          this.state.get(p.id) === p &&
          !p.battleId &&
          p.currentZoneId === zoneId &&
          now >= p.battleCooldownUntil
      );
      if (!stillEligible) return;

      Object.assign(first, firstStats, { hp: firstStats.maxHp });
      Object.assign(second, secondStats, { hp: secondStats.maxHp });
      this.startEncounterSync(first, second, zoneId);
      await this.syncNextAlarm();
    } finally {
      first.encounterPending = false;
      second.encounterPending = false;
    }
  }

  /**
   * Backs off encounter matching and arms the alarm so the failed start is retried automatically.
   */
  private async deferEncounterRetry(): Promise<void> {
    this.encounterRetryAt = Date.now() + ENCOUNTER_RETRY_MS;
    await this.syncNextAlarm().catch((err) => console.error("Failed to arm encounter retry alarm:", err));
  }

  /**
   * Creates an active `battles` record, assigns `battleId` to both participants, and sends `BATTLE_STARTED`.
   */
  private startEncounterSync(p1: LivePlayer, p2: LivePlayer, zoneId: string) {
    this.flushDirtyPositions();
    const now = Date.now();
    const battleId = crypto.randomUUID();
    const turnDeadlineAt = now + TURN_TIMEOUT_MS;
    const battle = {
      id: battleId,
      zoneId,
      player1Id: p1.id,
      player2Id: p2.id,
      activeTurnPlayerId: p1.id,
      turnNumber: 1,
      turnDeadlineAt,
      p1Timeouts: 0,
      p2Timeouts: 0,
      status: "ACTIVE"
    };

    p1.battleId = battleId;
    p2.battleId = battleId;

    this.ctx.storage.transactionSync(() => {
      this.db.insert(battles).values(battle).run();
      for (const p of [p1, p2]) {
        // Persist the stats just read from D1 together with the battle assignment.
        this.db
          .update(players)
          .set({ battleId, maxHp: p.maxHp, hp: p.hp, attack: p.attack, defense: p.defense })
          .where(eq(players.id, p.id))
          .run();
      }
    });

    this.sendToPlayers([p1.id, p2.id], {
      type: "BATTLE_STARTED",
      serverNow: now,
      battle: {
        ...battle,
        hpPercentByPlayerId: this.buildHpPercentMap([p1.id, p2.id])
      }
    });
  }

  /**
   * Serializes async operations on `battleId` via a promise chain so concurrent player actions
   * and alarm timeouts for the same battle execute strictly in order.
   */
  private async enqueueBattleTurn(battleId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.battleLocks.get(battleId) ?? Promise.resolve();
    const current = prev
      .catch(() => {
        // Prior failed turn should not block subsequent serialized turns.
      })
      .then(fn);

    this.battleLocks.set(battleId, current);
    try {
      await current;
    } finally {
      if (this.battleLocks.get(battleId) === current) {
        this.battleLocks.delete(battleId);
      }
    }
  }

  /**
   * Executes a single turn (`ATTACK`, `HEAL`, or `FLEE`) or timeout resolution inside `enqueueBattleTurn`.
   * Validates battle status, active turn owner, and optional `expectedTurnNumber`, updates HP/timeouts,
   * settles battle end + reward outbox + cooldowns when defeated or fled, or advances the turn and arms
   * the next deadline alarm.
   */
  private async resolveTurnLocked(
    actorId: string,
    action: BattleAction,
    isTimeout = false,
    expectedTurnNumber?: number
  ) {
    const actor = this.state.get(actorId);
    if (!actor?.battleId) return;

    const battle = this.db.select().from(battles).where(eq(battles.id, actor.battleId)).get();
    if (!battle || battle.status !== "ACTIVE" || battle.activeTurnPlayerId !== actor.id) return;
    if (expectedTurnNumber !== undefined && battle.turnNumber !== expectedTurnNumber) return;

    const opponentId = battle.player1Id === actor.id ? battle.player2Id : battle.player1Id;
    const opponent = this.state.get(opponentId);
    if (!opponent) {
      actor.battleId = null;
      actor.hp = actor.maxHp;
      actor.battleCooldownUntil = Date.now() + POST_BATTLE_IMMUNITY_MS;
      actor.zoneArmed = false;
      this.ctx.storage.transactionSync(() => {
        this.db.delete(battles).where(eq(battles.id, battle.id)).run();
        this.db
          .update(players)
          .set({ battleId: null, hp: actor.maxHp, battleCooldownUntil: actor.battleCooldownUntil })
          .where(eq(players.id, actor.id))
          .run();
        this.db.delete(players).where(eq(players.id, opponentId)).run();
      });
      try {
        await this.syncNextAlarm();
      } finally {
        this.sendToPlayers([actor.id], {
          type: "BATTLE_ENDED",
          winnerId: actor.id,
          participantIds: [battle.player1Id, battle.player2Id],
          log: "Opponent was unavailable; battle ended."
        });
        this.pruneDisconnectedPlayers([actor.id, opponentId]);
      }
      return;
    }

    let log = "";
    let updatedActorHp = actor.hp;
    let updatedOpponentHp = opponent.hp;

    if (action === "ATTACK") {
      const dmg = computeBasicAttackDamage(actor.attack, opponent.defense);
      updatedOpponentHp = Math.max(0, opponent.hp - dmg);
      log = isTimeout
        ? `${actor.username} timed out and used a basic attack for ${dmg} DMG!`
        : `${actor.username} strikes for ${dmg} DMG!`;
    } else if (action === "HEAL") {
      updatedActorHp = computeHealedHp(actor.hp, actor.maxHp);
      log = `${actor.username} recovers 20 HP!`;
    } else {
      log = isTimeout
        ? `${actor.username} missed 2 turns while disconnected and fled!`
        : `${actor.username} fled the battle!`;
    }

    if (updatedOpponentHp === 0 || action === "FLEE") {
      const winnerId = action === "FLEE" ? opponent.id : actor.id;
      const endNow = Date.now();
      const cooldownUntil = endNow + POST_BATTLE_IMMUNITY_MS;
      const rewardId = crypto.randomUUID();
      actor.battleId = null;
      opponent.battleId = null;
      actor.hp = actor.maxHp;
      opponent.hp = opponent.maxHp;
      for (const p of [actor, opponent]) {
        p.battleCooldownUntil = cooldownUntil;
        p.zoneArmed = false;
      }

      // Atomically remove the battle, reset player battle/HP/immunity state, and enqueue the reward in DO SQLite.
      this.ctx.storage.transactionSync(() => {
        this.db.delete(battles).where(eq(battles.id, battle.id)).run();
        for (const p of [actor, opponent]) {
          this.db
            .update(players)
            .set({ battleId: null, hp: p.maxHp, battleCooldownUntil: cooldownUntil })
            .where(eq(players.id, p.id))
            .run();
        }
        this.db
          .insert(pendingRewards)
          .values({
            id: rewardId,
            userId: winnerId,
            xp: BATTLE_REWARD_XP,
            gold: BATTLE_REWARD_GOLD,
            attempts: 1,
            nextRetryAt: endNow + INITIAL_REWARD_RETRY_MS
          })
          .run();
      });

      // Tell players the battle is over before touching D1 so a slow D1 call never delays the result.
      try {
        await this.syncNextAlarm();
      } finally {
        this.sendToPlayers([actor.id, opponent.id], {
          type: "BATTLE_ENDED",
          winnerId,
          participantIds: [battle.player1Id, battle.player2Id],
          log
        });
        this.pruneDisconnectedPlayers([actor.id, opponent.id]);
      }

      try {
        await this.applyBattleRewardToD1(rewardId, winnerId, BATTLE_REWARD_XP, BATTLE_REWARD_GOLD);
      } catch (err) {
        console.error("Failed to award D1 battle rewards; retained in outbox for retry:", err);
      }
      await this.syncNextAlarm().catch((err) => console.error("Failed to resync alarm:", err));
      return;
    }

    actor.hp = updatedActorHp;
    opponent.hp = updatedOpponentHp;

    const isActorP1 = battle.player1Id === actor.id;
    const nextP1Timeouts = isActorP1 ? (isTimeout ? battle.p1Timeouts + 1 : 0) : battle.p1Timeouts;
    const nextP2Timeouts = !isActorP1 ? (isTimeout ? battle.p2Timeouts + 1 : 0) : battle.p2Timeouts;

    const now = Date.now();
    const nextTurnNumber = battle.turnNumber + 1;
    const turnDeadlineAt = now + TURN_TIMEOUT_MS;
    this.ctx.storage.transactionSync(() => {
      if (action === "ATTACK") {
        this.db.update(players).set({ hp: opponent.hp }).where(eq(players.id, opponent.id)).run();
      } else if (action === "HEAL") {
        this.db.update(players).set({ hp: actor.hp }).where(eq(players.id, actor.id)).run();
      }
      this.db
        .update(battles)
        .set({
          activeTurnPlayerId: opponent.id,
          turnNumber: nextTurnNumber,
          turnDeadlineAt,
          p1Timeouts: nextP1Timeouts,
          p2Timeouts: nextP2Timeouts
        })
        .where(eq(battles.id, battle.id))
        .run();
    });

    await this.syncNextAlarm();

    this.sendToPlayers([actor.id, opponent.id], {
      type: "TURN_RESOLVED",
      serverNow: now,
      turnNumber: nextTurnNumber,
      nextTurnPlayerId: opponent.id,
      turnDeadlineAt,
      p1Timeouts: nextP1Timeouts,
      p2Timeouts: nextP2Timeouts,
      hpPercentByPlayerId: {
        [actor.id]: this.toHpPercent(actor.hp, actor.maxHp),
        [opponent.id]: this.toHpPercent(opponent.hp, opponent.maxHp)
      },
      log
    });
  }

  /**
   * Checks whether `playerId` currently has at least one open WebSocket (optionally excluding `excludeWs`).
   */
  private hasOpenSocket(playerId: string, excludeWs?: WebSocket): boolean {
    return this.ctx.getWebSockets().some((ws) => {
      if (ws === excludeWs || ws.readyState !== WebSocket.OPEN) return false;
      const session = ws.deserializeAttachment() as { playerId?: string } | null;
      return session?.playerId === playerId;
    });
  }

  /**
   * Removes disconnected players that have no open sockets and are not currently in an active battle,
   * notifying remaining room clients via `PLAYER_LEFT`.
   */
  private pruneDisconnectedPlayers(playerIds: string[]) {
    for (const playerId of playerIds) {
      if (this.hasOpenSocket(playerId)) continue;
      const p = this.state.get(playerId);
      if (p) {
        p.dx = 0;
        p.dy = 0;
        if (!p.battleId) {
          this.state.delete(playerId);
          this.db.delete(players).where(eq(players.id, playerId)).run();
          this.broadcast({ type: "PLAYER_LEFT", playerId });
        }
      }
    }
  }

  /**
   * Handles WebSocket close frames: closes the socket with a valid code and prunes the player
   * if they have no other open sockets and are not in an active battle (in-battle players remain
   * so combat/timeout alarms can still resolve).
   */
  async webSocketClose(ws: WebSocket, code: number) {
    const session = ws.deserializeAttachment() as { playerId?: string } | null;
    const safeCode = code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
    try {
      ws.close(safeCode, "Closed");
    } catch {
      // Ignore already-closed sockets.
    }

    if (session?.playerId) {
      if (this.hasOpenSocket(session.playerId!, ws)) return;

      const p = this.state.get(session.playerId);
      if (p) {
        p.dx = 0;
        p.dy = 0;
        if (!p.battleId) {
          this.state.delete(session.playerId);
          this.db.delete(players).where(eq(players.id, session.playerId!)).run();
          this.broadcast({ type: "PLAYER_LEFT", playerId: session.playerId! });
        }
      }
    }
  }

  /**
   * Handles WebSocket error events by delegating to `webSocketClose` with code 1011.
   */
  async webSocketError(ws: WebSocket, error: unknown) {
    console.error("WebSocket error:", error);
    await this.webSocketClose(ws, 1011);
  }

  /**
   * Schedules or clears the Durable Object alarm for the earliest active battle turn deadline
   * or due `pending_rewards` retry timestamp, avoiding redundant storage calls when unchanged.
   */
  private async syncNextAlarm() {
    const battleRow = this.db
      .select({ nextDeadline: min(battles.turnDeadlineAt) })
      .from(battles)
      .where(eq(battles.status, "ACTIVE"))
      .get();

    const rewardRow = this.db
      .select({ nextRetry: min(pendingRewards.nextRetryAt) })
      .from(pendingRewards)
      .get();

    // Wake when a standing player's post-battle immunity expires so a waiting encounter can start.
    const nowTs = Date.now();
    let nextCooldown: number | undefined;
    for (const p of this.state.values()) {
      if (p.currentZoneId && !p.battleId && p.battleCooldownUntil > nowTs) {
        nextCooldown = nextCooldown === undefined ? p.battleCooldownUntil : Math.min(nextCooldown, p.battleCooldownUntil);
      }
    }

    const candidates = [battleRow?.nextDeadline, rewardRow?.nextRetry, nextCooldown, this.encounterRetryAt].filter(
      (ts): ts is number => ts != null
    );

    if (candidates.length > 0) {
      const nextAlarmAt = Math.min(...candidates);
      if (this.lastScheduledAlarmAt === nextAlarmAt) return;
      await this.ctx.storage.setAlarm(nextAlarmAt);
      this.lastScheduledAlarmAt = nextAlarmAt;
    } else {
      if (this.lastScheduledAlarmAt === null) return;
      await this.ctx.storage.deleteAlarm();
      this.lastScheduledAlarmAt = null;
    }
  }

  /**
   * Idempotently applies battle XP and gold rewards to D1 by inserting a unique `reward_claims`
   * row and incrementing `users.xp`/`users.gold` in a D1 batch, then deleting the DO outbox row.
   */
  private async applyBattleRewardToD1(
    rewardId: string,
    userId: string,
    xp: number,
    gold: number
  ): Promise<void> {
    if (this.inFlightRewardIds.has(rewardId)) return;
    this.inFlightRewardIds.add(rewardId);

    try {
      // `INSERT OR IGNORE` makes a repeated claim a no-op, and the credit only applies when that insert
      // actually added a row (`changes()` is 1), so the pair is idempotent without parsing error text.
      const insertClaim = this.env.DB.prepare(
        "INSERT OR IGNORE INTO reward_claims (id, user_id, xp, gold, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(rewardId, userId, xp, gold, Date.now());

      const creditUser = this.env.DB.prepare(
        "UPDATE users SET xp = xp + ?, gold = gold + ? WHERE id = ? AND (SELECT changes()) > 0"
      ).bind(xp, gold, userId);

      await this.env.DB.batch([insertClaim, creditUser]);

      this.db.delete(pendingRewards).where(eq(pendingRewards.id, rewardId)).run();
    } finally {
      this.inFlightRewardIds.delete(rewardId);
    }
  }

  /**
   * Retries due rows in `pending_rewards` with exponential backoff up to `MAX_REWARD_ATTEMPTS`.
   */
  private async flushPendingRewards(now: number) {
    const dueRewards = this.db
      .select()
      .from(pendingRewards)
      .where(lte(pendingRewards.nextRetryAt, now))
      .all();
    if (dueRewards.length === 0) return;

    for (const reward of dueRewards) {
      if (this.inFlightRewardIds.has(reward.id)) continue;
      try {
        await this.applyBattleRewardToD1(reward.id, reward.userId, reward.xp, reward.gold);
      } catch (err) {
        // Never drop a reward: keep retrying at the capped backoff and surface persistent failures in logs.
        const nextAttempts = reward.attempts + 1;
        const backoffMs = Math.min(MAX_REWARD_RETRY_MS, INITIAL_REWARD_RETRY_MS * 2 ** Math.min(nextAttempts, 16));
        this.db
          .update(pendingRewards)
          .set({ attempts: nextAttempts, nextRetryAt: now + backoffMs })
          .where(eq(pendingRewards.id, reward.id))
          .run();
        if (nextAttempts >= MAX_REWARD_ATTEMPTS) {
          console.error(`D1 reward ${reward.id} still failing after ${nextAttempts} attempts; will keep retrying:`, reward);
        }
        console.error("Retry D1 reward update failed:", err);
      }
    }
  }

  /**
   * Durable Object alarm handler: resolves expired active battle turn deadlines (auto-attacking
   * or forfeiting disconnected/repeat-AFK players), retries due `pending_rewards`, prunes
   * disconnected players, and schedules the next alarm.
   */
  async alarm() {
    this.lastScheduledAlarmAt = undefined;
    const now = Date.now();
    const expiredBattles = this.db
      .select()
      .from(battles)
      .where(and(eq(battles.status, "ACTIVE"), lte(battles.turnDeadlineAt, now)))
      .all();

    const participantIds = new Set<string>();
    await Promise.allSettled(
      expiredBattles.map(async (b) => {
        participantIds.add(b.player1Id);
        participantIds.add(b.player2Id);
        const afkPlayer = this.state.get(b.activeTurnPlayerId);
        if (afkPlayer) {
          await this.enqueueBattleTurn(b.id, async () => {
            const currentBattle = this.db.select().from(battles).where(eq(battles.id, b.id)).get();
            if (!currentBattle || currentBattle.status !== "ACTIVE") return;
            if (currentBattle.activeTurnPlayerId !== afkPlayer.id || currentBattle.turnDeadlineAt > Date.now()) return;

            const prevTimeouts =
              currentBattle.player1Id === afkPlayer.id ? currentBattle.p1Timeouts : currentBattle.p2Timeouts;
            const shouldForfeit = shouldForfeitOnTimeout(prevTimeouts, this.hasOpenSocket(afkPlayer.id));

            await this.resolveTurnLocked(afkPlayer.id, shouldForfeit ? "FLEE" : "ATTACK", true);
          });
        } else {
          await this.enqueueBattleTurn(b.id, async () => {
            const currentBattle = this.db.select().from(battles).where(eq(battles.id, b.id)).get();
            if (!currentBattle || currentBattle.status !== "ACTIVE" || currentBattle.turnDeadlineAt > Date.now()) {
              return;
            }
            const winnerId =
              currentBattle.player1Id === currentBattle.activeTurnPlayerId
                ? currentBattle.player2Id
                : currentBattle.player1Id;
            const cooldownUntil = Date.now() + POST_BATTLE_IMMUNITY_MS;
            this.ctx.storage.transactionSync(() => {
              this.db.delete(battles).where(eq(battles.id, currentBattle.id)).run();
              for (const pid of [currentBattle.player1Id, currentBattle.player2Id]) {
                const p = this.state.get(pid);
                if (p) {
                  p.battleId = null;
                  p.hp = p.maxHp;
                  p.battleCooldownUntil = cooldownUntil;
                  p.zoneArmed = false;
                  this.db
                    .update(players)
                    .set({ battleId: null, hp: p.maxHp, battleCooldownUntil: cooldownUntil })
                    .where(eq(players.id, pid))
                    .run();
                }
              }
            });
            this.sendToPlayers([currentBattle.player1Id, currentBattle.player2Id], {
              type: "BATTLE_ENDED",
              winnerId,
              participantIds: [currentBattle.player1Id, currentBattle.player2Id],
              log: "Opponent disconnected unexpectedly; battle ended."
            });
          });
        }
      })
    );

    await this.flushPendingRewards(Date.now());
    this.pruneDisconnectedPlayers(Array.from(participantIds));
    await this.startDueEncounters(Date.now());
    await this.syncNextAlarm();
  }

  /**
   * Broadcasts a serialized `ServerMessage` to all open WebSockets in the room except `exclude`.
   * Isolates per-socket `send()` failures so one broken socket cannot stop delivery to others.
   */
  private broadcast(payload: ServerMessage, exclude?: WebSocket) {
    const msg = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== exclude && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(msg);
        } catch (err) {
          console.warn("Failed to broadcast WebSocket message:", err);
        }
      }
    }
  }

  /**
   * Sends a serialized `ServerMessage` to open WebSockets belonging to any ID in `playerIds`.
   */
  private sendToPlayers(playerIds: string[], payload: ServerMessage) {
    const msg = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const session = ws.deserializeAttachment() as { playerId?: string } | null;
      if (session?.playerId && playerIds.includes(session.playerId)) {
        try {
          ws.send(msg);
        } catch (err) {
          console.warn(`Failed to send WebSocket message to ${session.playerId}:`, err);
        }
      }
    }
  }
}
