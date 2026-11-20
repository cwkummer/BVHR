/**
 * Stateful regional shard Durable Object (`GameRoom`): the orchestrator that wires real-time movement,
 * zone encounters, serialized turn-based combat and the reward outbox to the Durable Object runtime
 * (sockets, SQLite, alarms). The logic that does not need the runtime lives in `./room/*` so it can be
 * unit tested on its own:
 *   movement.ts, turns.ts, rate-limit.ts, snapshots.ts  - pure game rules
 *   encounters.ts                                       - who fights whom
 *   keyed-queue.ts                                      - per-battle serialization
 *   recovery.ts, reward-outbox.ts, combat-stats.ts      - SQLite / D1 persistence
 *   socket-hub.ts, alarm-schedule.ts                    - runtime wrappers
 *
 * Concurrency & durability guarantees:
 *  - `ctx.blockConcurrencyWhile(...)` runs DO SQLite migrations, recovers active players/battles,
 *    prunes orphaned rows, and arms the next alarm.
 *  - Movement runs on a 50ms on-demand loop while players hold non-zero WASD vectors and flushes
 *    dirty coordinates to DO SQLite at most once per second or when movement stops.
 *  - A per-battle queue serializes player actions and timeout resolutions so turns never race or
 *    double-apply.
 *  - Battle rewards are recorded in DO `pending_rewards` and idempotently credited to D1, retrying with
 *    exponential backoff via `alarm()` on failure (never dropped).
 */
import { DurableObject } from "cloudflare:workers";
import { drizzle, DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { and, eq, lte, min } from "drizzle-orm";
import migrations from "../drizzle-do/migrations/migrations";
import { players, battles, type PlayerRow } from "./db/do-schema";
import { parsePlayerIdentityHeader, type CombatStats, type PlayerIdentity } from "./player-identity";
import { ROOM_HARD_CAP, ROOM_SOFT_CAP } from "shared/shard-config";
import type { ClientMessage, ServerMessage, BattleAction, BattleState } from "shared/protocol";
import type { Env } from "./index";
import { BATTLE_REWARD_GOLD, BATTLE_REWARD_XP, POST_BATTLE_IMMUNITY_MS, TURN_TIMEOUT_MS } from "./combat";
import { pickEncounterPairs } from "./encounters";
import { AlarmScheduler, earliestCooldownExpiry, earliestTime } from "./room/alarm-schedule";
import { loadCombatStats } from "./room/combat-stats";
import { KeyedSerialQueue } from "./room/keyed-queue";
import { createLivePlayer, type LivePlayer } from "./room/live-player";
import { advanceMovement, anyPlayerMoving, tickDeltaSeconds, toDirection } from "./room/movement";
import { tryConsumeMessageToken } from "./room/rate-limit";
import { recoverRoomState, resetParticipantsAfterBattle } from "./room/recovery";
import { RewardOutbox } from "./room/reward-outbox";
import { toHpPercent, toPlayerSnapshot } from "./room/snapshots";
import { SocketHub } from "./room/socket-hub";
import { resolveTurn, timeoutAction } from "./room/turns";

const ENCOUNTER_RETRY_MS = 2_000;
const MOVEMENT_TICK_MS = 50;
const POSITION_FLUSH_MS = 1_000;
const VALID_BATTLE_ACTIONS = new Set<BattleAction>(["ATTACK", "HEAL", "FLEE"]);

export class GameRoom extends DurableObject<Env> {
  db: DrizzleSqliteDODatabase;
  private state = new Map<string, LivePlayer>();
  private readonly hub: SocketHub;
  private readonly alarms: AlarmScheduler;
  private readonly outbox: RewardOutbox;
  private readonly battleQueue = new KeyedSerialQueue();
  private loop: ReturnType<typeof setTimeout> | null = null;
  private loopTickActive = false;
  private lastTickAt = 0;
  private lastPositionFlushAt = 0;
  // Earliest time a failed encounter start (D1 stats unavailable) may be retried; null when not backing off.
  private encounterRetryAt: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    this.hub = new SocketHub(ctx);
    this.alarms = new AlarmScheduler(ctx.storage);
    this.outbox = new RewardOutbox(this.db, env.DB);
    // Respond automatically to lightweight "ping" frames without waking or running full message handlers.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

    ctx.blockConcurrencyWhile(async () => {
      migrate(this.db, migrations);
      const now = Date.now();
      this.lastTickAt = now;
      this.lastPositionFlushAt = now;
      this.alarms.reset();
      this.state = recoverRoomState(this.db, ctx.storage, this.hub.openPlayerIds(), now);
      await this.syncNextAlarm();
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Joining and leaving
  // ---------------------------------------------------------------------------------------------

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

    const profile = parsePlayerIdentityHeader(request.headers.get("X-Player-Data"));
    if (!profile) {
      return Response.json({ error: "Missing or invalid player profile header" }, { status: 400 });
    }

    // Read combat stats from D1 before touching any room state: the await lets other events interleave,
    // so the capacity check and player creation below must run after it, synchronously.
    let stats: CombatStats | undefined;
    try {
      stats = (await loadCombatStats(this.env.DB, [profile.id])).get(profile.id);
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
    this.hub.accept(server, profile.id);
    this.hub.closeSuperseded(profile.id, server);

    const { player, isNewJoin } = this.hydrateOrCreatePlayer(profile, stats);
    this.sendInitialSync(server, profile.id, player, isNewJoin);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Computes current shard occupancy as the max of tracked `LivePlayer` records and open sockets.
   */
  private getCurrentOccupancy(): number {
    return Math.max(this.state.size, this.hub.openCount());
  }

  /**
   * Responds to `/internal/stats` probes from the Worker router with current occupancy and
   * optional player membership (`hasPlayer`) for shard resume checks.
   */
  private handleInternalStats(url: URL): Response {
    const playerId = url.searchParams.get("playerId");
    return Response.json({
      count: this.getCurrentOccupancy(),
      hasPlayer: playerId ? this.state.has(playerId) : false,
      maxPlayers: ROOM_SOFT_CAP,
      softCap: ROOM_SOFT_CAP,
      hardCap: ROOM_HARD_CAP
    });
  }

  /**
   * Re-syncs an existing `LivePlayer` on reconnect (resetting movement/dirty state and refreshing
   * D1 stats when outside combat) or inserts and registers a brand-new player row.
   */
  private hydrateOrCreatePlayer(
    profile: PlayerIdentity,
    stats: CombatStats
  ): { player: LivePlayer; isNewJoin: boolean } {
    const existing = this.state.get(profile.id);

    if (existing) {
      // Reset stale movement vectors and dirty flag when a socket reconnects.
      existing.dx = 0;
      existing.dy = 0;
      existing.dirty = false;

      // Sync username and stats from D1 when reconnecting outside of an active battle.
      if (!existing.battleId) {
        existing.username = profile.username;
        existing.maxHp = stats.maxHp;
        existing.hp = Math.min(existing.hp, stats.maxHp);
        existing.attack = stats.attack;
        existing.defense = stats.defense;
        this.db
          .update(players)
          .set({
            username: existing.username,
            maxHp: existing.maxHp,
            hp: existing.hp,
            attack: existing.attack,
            defense: existing.defense
          })
          .where(eq(players.id, existing.id))
          .run();
      }
      return { player: existing, isNewJoin: false };
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
    const player = createLivePlayer(row, Date.now());
    this.state.set(profile.id, player);
    return { player, isNewJoin: true };
  }

  /**
   * Sends the initial `SYNC_STATE` snapshot (including active battle HP percentages if mid-fight)
   * to the newly connected socket and broadcasts `PLAYER_JOINED` to other players on fresh joins.
   */
  private sendInitialSync(server: WebSocket, selfId: string, player: LivePlayer, isNewJoin: boolean): void {
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
      players: Array.from(this.state.values(), toPlayerSnapshot),
      battle: activeBattle
    };
    server.send(JSON.stringify(syncMsg));

    if (isNewJoin) {
      this.hub.broadcast({ type: "PLAYER_JOINED", player: toPlayerSnapshot(player) }, server);
    }
  }

  /**
   * Builds a map of player ID to server-computed HP percentage for a list of battle participants.
   */
  private buildHpPercentMap(playerIds: string[]): Record<string, number> {
    const result: Record<string, number> = {};
    for (const id of playerIds) {
      const live = this.state.get(id);
      if (live) {
        result[id] = toHpPercent(live.hp, live.maxHp);
        continue;
      }
      const row = this.db.select().from(players).where(eq(players.id, id)).get();
      if (row) {
        result[id] = toHpPercent(row.hp, row.maxHp);
      }
    }
    return result;
  }

  /**
   * Removes a player who has no open socket and is not in a battle (in-battle players stay so combat and
   * timeout alarms can still resolve), notifying the room via `PLAYER_LEFT`. Always stops their movement.
   */
  private removeIfDisconnected(playerId: string): void {
    const p = this.state.get(playerId);
    if (!p) return;
    p.dx = 0;
    p.dy = 0;
    if (!p.battleId) {
      this.state.delete(playerId);
      this.db.delete(players).where(eq(players.id, playerId)).run();
      this.hub.broadcast({ type: "PLAYER_LEFT", playerId });
    }
  }

  /**
   * Removes each listed player that no longer has an open socket and is not in an active battle.
   */
  private pruneDisconnectedPlayers(playerIds: string[]) {
    for (const playerId of playerIds) {
      if (this.hub.hasOpenSocket(playerId)) continue;
      this.removeIfDisconnected(playerId);
    }
  }

  /**
   * Handles WebSocket close frames: closes the socket with a valid code and prunes the player
   * if they have no other open sockets and are not in an active battle.
   */
  async webSocketClose(ws: WebSocket, code: number) {
    const playerId = SocketHub.playerIdOf(ws);
    const safeCode = code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
    try {
      ws.close(safeCode, "Closed");
    } catch {
      // Ignore already-closed sockets.
    }

    if (playerId && !this.hub.hasOpenSocket(playerId, ws)) {
      this.removeIfDisconnected(playerId);
    }
  }

  /**
   * Handles WebSocket error events by delegating to `webSocketClose` with code 1011.
   */
  async webSocketError(ws: WebSocket, error: unknown) {
    console.error("WebSocket error:", error);
    await this.webSocketClose(ws, 1011);
  }

  // ---------------------------------------------------------------------------------------------
  // Client messages
  // ---------------------------------------------------------------------------------------------

  /**
   * Processes incoming client WebSocket frames (`WASD` movement vectors and `BATTLE_ACTION` turns),
   * enforcing per-player token-bucket rate limiting (allowing stop `{ dx: 0, dy: 0 }` inputs through).
   */
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string") return;
    const playerId = SocketHub.playerIdOf(ws);
    if (!playerId) return;
    const p = this.state.get(playerId);
    if (!p) return;

    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }

    const isStopInput = msg.type === "WASD" && Number(msg.dx) === 0 && Number(msg.dy) === 0;
    if (!tryConsumeMessageToken(p, Date.now(), isStopInput)) return;

    if (msg.type === "WASD" && !p.battleId && !p.encounterPending) {
      p.dx = toDirection(msg.dx);
      p.dy = toDirection(msg.dy);
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
      const action = msg.action;
      const expectedTurn = msg.turnNumber;
      await this.battleQueue.run(p.battleId, async () => {
        await this.resolveTurnLocked(p.id, action, false, expectedTurn);
      });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Movement loop
  // ---------------------------------------------------------------------------------------------

  /**
   * Advances movement for active non-battle players, starts any due encounters, flushes dirty positions
   * periodically, and broadcasts position `SNAPSHOT` updates.
   */
  private async runMovementTick(): Promise<void> {
    const now = Date.now();
    const dt = tickDeltaSeconds(now, this.lastTickAt);
    this.lastTickAt = now;

    const { anyoneMoving, moved } = advanceMovement(this.state.values(), dt, now);

    // Not awaited: reading stats from D1 must not delay this tick's position broadcast.
    void this.startDueEncounters(now);

    const flushNow = Date.now();
    if (!anyoneMoving || flushNow - this.lastPositionFlushAt >= POSITION_FLUSH_MS) {
      this.flushDirtyPositions();
      this.lastPositionFlushAt = flushNow;
    }

    if (moved.length > 0) {
      this.hub.broadcast({ type: "SNAPSHOT", players: moved });
    }
  }

  /**
   * Schedules the next movement loop tick if no timer is already pending.
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
          if (anyPlayerMoving(this.state.values())) {
            this.scheduleNextTick();
          }
        });
    }, MOVEMENT_TICK_MS);
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

  // ---------------------------------------------------------------------------------------------
  // Encounters
  // ---------------------------------------------------------------------------------------------

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
        fresh = await loadCombatStats(this.env.DB, [first.id, second.id]);
      } catch (err) {
        console.error("Battle not started: could not read stats from D1:", err);
        await this.deferEncounterRetry([first, second]);
        return;
      }
      const firstStats = fresh.get(first.id);
      const secondStats = fresh.get(second.id);
      if (!firstStats || !secondStats) {
        console.error(`Battle not started: missing or invalid D1 stats for ${first.id} / ${second.id}`);
        await this.deferEncounterRetry([first, second]);
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

      first.startFailureNotified = false;
      second.startFailureNotified = false;
      Object.assign(first, firstStats, { hp: firstStats.maxHp });
      Object.assign(second, secondStats, { hp: secondStats.maxHp });
      this.startBattle(first, second, zoneId);
      await this.syncNextAlarm();
    } finally {
      first.encounterPending = false;
      second.encounterPending = false;
    }
  }

  /**
   * Backs off encounter matching, tells the affected players (once per failure streak, not on every
   * retry) that the battle could not start, and arms the alarm so the start is retried automatically.
   */
  private async deferEncounterRetry(affected: LivePlayer[]): Promise<void> {
    this.encounterRetryAt = Date.now() + ENCOUNTER_RETRY_MS;
    const toNotify = affected.filter((p) => !p.startFailureNotified);
    if (toNotify.length > 0) {
      for (const p of toNotify) p.startFailureNotified = true;
      this.hub.sendToPlayers(
        toNotify.map((p) => p.id),
        { type: "BATTLE_START_FAILED", reason: "STATS_UNAVAILABLE", retryInMs: ENCOUNTER_RETRY_MS }
      );
    }
    await this.syncNextAlarm().catch((err) => console.error("Failed to arm encounter retry alarm:", err));
  }

  /**
   * Creates an active `battles` record, assigns `battleId` to both participants, and sends `BATTLE_STARTED`.
   */
  private startBattle(p1: LivePlayer, p2: LivePlayer, zoneId: string) {
    this.flushDirtyPositions();
    const now = Date.now();
    const battleId = crypto.randomUUID();
    const battle = {
      id: battleId,
      zoneId,
      player1Id: p1.id,
      player2Id: p2.id,
      activeTurnPlayerId: p1.id,
      turnNumber: 1,
      turnDeadlineAt: now + TURN_TIMEOUT_MS,
      p1Timeouts: 0,
      p2Timeouts: 0,
      status: "ACTIVE" as const
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

    this.hub.sendToPlayers([p1.id, p2.id], {
      type: "BATTLE_STARTED",
      serverNow: now,
      battle: { ...battle, hpPercentByPlayerId: this.buildHpPercentMap([p1.id, p2.id]) }
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Battle turns
  // ---------------------------------------------------------------------------------------------

  /**
   * Executes a single turn (`ATTACK`, `HEAL`, or `FLEE`) or timeout resolution inside the battle queue.
   * Validates battle status, active turn owner, and optional `expectedTurnNumber`, asks `resolveTurn`
   * for the outcome, then persists it: either settling the battle (reset players, immunity, reward
   * outbox) or advancing the turn and arming the next deadline alarm.
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

    const participantIds: [string, string] = [battle.player1Id, battle.player2Id];
    const opponentId = battle.player1Id === actor.id ? battle.player2Id : battle.player1Id;
    const opponent = this.state.get(opponentId);
    const now = Date.now();

    if (!opponent) {
      this.ctx.storage.transactionSync(() => {
        this.db.delete(battles).where(eq(battles.id, battle.id)).run();
        resetParticipantsAfterBattle(this.db, [actor], now + POST_BATTLE_IMMUNITY_MS);
        this.db.delete(players).where(eq(players.id, opponentId)).run();
      });
      try {
        await this.syncNextAlarm();
      } finally {
        this.hub.sendToPlayers([actor.id], {
          type: "BATTLE_ENDED",
          winnerId: actor.id,
          participantIds,
          log: "Opponent was unavailable; battle ended."
        });
        this.pruneDisconnectedPlayers([actor.id, opponentId]);
      }
      return;
    }

    const outcome = resolveTurn({ actor, opponent, battle, action, isTimeout, now });

    if (outcome.ended) {
      const reward = {
        id: crypto.randomUUID(),
        userId: outcome.winnerId,
        xp: BATTLE_REWARD_XP,
        gold: BATTLE_REWARD_GOLD
      };

      // Atomically remove the battle, reset player battle/HP/immunity state, and enqueue the reward.
      this.ctx.storage.transactionSync(() => {
        this.db.delete(battles).where(eq(battles.id, battle.id)).run();
        resetParticipantsAfterBattle(this.db, [actor, opponent], now + POST_BATTLE_IMMUNITY_MS);
        this.outbox.enqueue(reward, now);
      });

      // Tell players the battle is over before touching D1 so a slow D1 call never delays the result.
      try {
        await this.syncNextAlarm();
      } finally {
        this.hub.sendToPlayers([actor.id, opponent.id], {
          type: "BATTLE_ENDED",
          winnerId: outcome.winnerId,
          participantIds,
          log: outcome.log
        });
        this.pruneDisconnectedPlayers([actor.id, opponent.id]);
      }

      try {
        await this.outbox.apply(reward);
      } catch (err) {
        console.error("Failed to award D1 battle rewards; retained in outbox for retry:", err);
      }
      await this.syncNextAlarm().catch((err) => console.error("Failed to resync alarm:", err));
      return;
    }

    actor.hp = outcome.actorHp;
    opponent.hp = outcome.opponentHp;

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
          turnNumber: outcome.nextTurnNumber,
          turnDeadlineAt: outcome.turnDeadlineAt,
          p1Timeouts: outcome.p1Timeouts,
          p2Timeouts: outcome.p2Timeouts
        })
        .where(eq(battles.id, battle.id))
        .run();
    });

    await this.syncNextAlarm();

    this.hub.sendToPlayers([actor.id, opponent.id], {
      type: "TURN_RESOLVED",
      serverNow: now,
      turnNumber: outcome.nextTurnNumber,
      nextTurnPlayerId: opponent.id,
      turnDeadlineAt: outcome.turnDeadlineAt,
      p1Timeouts: outcome.p1Timeouts,
      p2Timeouts: outcome.p2Timeouts,
      hpPercentByPlayerId: {
        [actor.id]: toHpPercent(actor.hp, actor.maxHp),
        [opponent.id]: toHpPercent(opponent.hp, opponent.maxHp)
      },
      log: outcome.log
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Alarm
  // ---------------------------------------------------------------------------------------------

  /**
   * Arms (or clears) the alarm for the earliest of: an active battle's turn deadline, a due reward retry,
   * a standing player's post-battle immunity expiry, or a pending encounter retry.
   */
  private async syncNextAlarm() {
    const battleRow = this.db
      .select({ nextDeadline: min(battles.turnDeadlineAt) })
      .from(battles)
      .where(eq(battles.status, "ACTIVE"))
      .get();

    await this.alarms.schedule(
      earliestTime([
        battleRow?.nextDeadline,
        this.outbox.nextRetryAt(),
        earliestCooldownExpiry(this.state.values(), Date.now()),
        this.encounterRetryAt
      ])
    );
  }

  /**
   * Durable Object alarm handler: resolves expired active battle turn deadlines (auto-attacking
   * or forfeiting disconnected/repeat-AFK players), retries due rewards, prunes disconnected players,
   * starts any encounter that became possible, and schedules the next alarm.
   */
  async alarm() {
    this.alarms.reset();
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
        await this.battleQueue.run(b.id, async () => {
          const current = this.db.select().from(battles).where(eq(battles.id, b.id)).get();
          if (!current || current.status !== "ACTIVE") return;
          if (current.turnDeadlineAt > Date.now()) return;

          if (afkPlayer) {
            if (current.activeTurnPlayerId !== afkPlayer.id) return;
            const prevTimeouts = current.player1Id === afkPlayer.id ? current.p1Timeouts : current.p2Timeouts;
            const action = timeoutAction(prevTimeouts, this.hub.hasOpenSocket(afkPlayer.id));
            await this.resolveTurnLocked(afkPlayer.id, action, true);
          } else {
            this.endBattleForMissingPlayer(current);
          }
        });
      })
    );

    await this.outbox.flushDue(Date.now());
    this.pruneDisconnectedPlayers(Array.from(participantIds));
    await this.startDueEncounters(Date.now());
    await this.syncNextAlarm();
  }

  /**
   * Ends a battle whose timed-out player is no longer tracked in the room: the other player wins by
   * default (no reward), and any participants still present get full HP and post-battle immunity.
   */
  private endBattleForMissingPlayer(battle: { id: string; player1Id: string; player2Id: string; activeTurnPlayerId: string }) {
    const winnerId = battle.player1Id === battle.activeTurnPlayerId ? battle.player2Id : battle.player1Id;
    const present = [battle.player1Id, battle.player2Id]
      .map((id) => this.state.get(id))
      .filter((p): p is LivePlayer => p !== undefined);

    this.ctx.storage.transactionSync(() => {
      this.db.delete(battles).where(eq(battles.id, battle.id)).run();
      resetParticipantsAfterBattle(this.db, present, Date.now() + POST_BATTLE_IMMUNITY_MS);
    });
    this.hub.sendToPlayers([battle.player1Id, battle.player2Id], {
      type: "BATTLE_ENDED",
      winnerId,
      participantIds: [battle.player1Id, battle.player2Id],
      log: "Opponent disconnected unexpectedly; battle ended."
    });
  }
}
