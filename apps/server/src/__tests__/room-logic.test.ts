/**
 * Unit tests for the logic extracted from GameRoom into `src/room/*`: movement, turn resolution,
 * rate limiting, per-battle queueing, alarm scheduling and reward retry backoff.
 */
import { describe, expect, test } from "bun:test";
import { findZoneId, BUILDINGS } from "shared/map-zones";
import { advanceMovement, anyPlayerMoving, tickDeltaSeconds, toDirection } from "../room/movement";
import { resolveTurn, timeoutAction } from "../room/turns";
import { MAX_MSGS_PER_SEC, tryConsumeMessageToken } from "../room/rate-limit";
import { KeyedSerialQueue } from "../room/keyed-queue";
import { AlarmScheduler, earliestCooldownExpiry, earliestTime } from "../room/alarm-schedule";
import { INITIAL_REWARD_RETRY_MS, nextRewardRetry } from "../room/reward-outbox";
import { toHpPercent } from "../room/snapshots";

describe("zones", () => {
  test("findZoneId matches building bounds inclusively and returns null outside", () => {
    const t = BUILDINGS.find((b) => b.id === "tavern")!;
    expect(findZoneId(t.x, t.y)).toBe("tavern");
    expect(findZoneId(t.x + t.w, t.y + t.h)).toBe("tavern");
    expect(findZoneId(t.x - 1, t.y)).toBeNull();
    expect(findZoneId(0, 0)).toBeNull();
  });
});

describe("movement", () => {
  const mk = (over: Record<string, unknown> = {}) => ({
    id: "p",
    x: 100,
    y: 100,
    dx: 0,
    dy: 0,
    dirty: false,
    battleId: null as string | null,
    encounterPending: false,
    currentZoneId: null as string | null,
    zoneArmed: false,
    zoneEnteredAt: 0,
    startFailureNotified: false,
    ...over
  });

  test("toDirection clamps and rejects garbage", () => {
    expect(toDirection(5)).toBe(1);
    expect(toDirection(-0.2)).toBe(-1);
    expect(toDirection("1")).toBe(1);
    expect(toDirection(Number.NaN)).toBe(0);
    expect(toDirection(undefined)).toBe(0);
    expect(toDirection(Infinity)).toBe(0);
  });

  test("tickDeltaSeconds is clamped to [0.01, 0.1]", () => {
    expect(tickDeltaSeconds(1000, 1000)).toBe(0.01);
    expect(tickDeltaSeconds(1050, 1000)).toBeCloseTo(0.05);
    expect(tickDeltaSeconds(9000, 1000)).toBe(0.1);
  });

  test("a moving player advances, becomes dirty and is reported", () => {
    const p = mk({ dx: 1 });
    const { anyoneMoving, moved } = advanceMovement([p], 0.1, 5000);
    expect(anyoneMoving).toBe(true);
    expect(p.x).toBeGreaterThan(100);
    expect(p.dirty).toBe(true);
    expect(moved).toEqual([{ id: "p", x: p.x, y: p.y, currentZoneId: null }]);
  });

  test("idle, in-battle and encounter-pending players do not move", () => {
    const players = [mk({ id: "idle" }), mk({ id: "b", dx: 1, battleId: "x" }), mk({ id: "e", dx: 1, encounterPending: true })];
    const { anyoneMoving, moved } = advanceMovement(players, 0.1, 0);
    expect(anyoneMoving).toBe(false);
    expect(moved).toHaveLength(0);
    expect(players.every((p) => p.x === 100 && !p.dirty)).toBe(true);
  });

  test("entering a building arms the player and clears the start-failure notice; leaving disarms", () => {
    const t = BUILDINGS.find((b) => b.id === "tavern")!;
    const p = mk({ x: t.x - 1, y: t.y + 10, dx: 1, startFailureNotified: true });
    advanceMovement([p], 0.1, 5000);
    expect(p.currentZoneId).toBe("tavern");
    expect(p.zoneArmed).toBe(true);
    expect(p.zoneEnteredAt).toBe(5000);
    expect(p.startFailureNotified).toBe(false);

    p.dx = -1;
    p.x = t.x + 1;
    advanceMovement([p], 1, 6000);
    expect(p.currentZoneId).toBeNull();
    expect(p.zoneArmed).toBe(false);
  });

  test("staying in the same zone does not re-arm", () => {
    const t = BUILDINGS.find((b) => b.id === "tavern")!;
    const p = mk({ x: t.x + 50, y: t.y + 50, dx: 0, dy: 1, currentZoneId: "tavern", zoneArmed: false });
    advanceMovement([p], 0.05, 7000);
    expect(p.zoneArmed).toBe(false);
  });

  test("anyPlayerMoving ignores players in battle", () => {
    expect(anyPlayerMoving([{ battleId: null, dx: 0, dy: 0 }])).toBe(false);
    expect(anyPlayerMoving([{ battleId: "b", dx: 1, dy: 0 }])).toBe(false);
    expect(anyPlayerMoving([{ battleId: null, dx: 0, dy: -1 }])).toBe(true);
  });
});

describe("turn resolution", () => {
  const actor = { id: "a", username: "Alice", attack: 15, hp: 100, maxHp: 100 };
  const opp = { id: "b", defense: 6, hp: 100 };
  const battle = { player1Id: "a", turnNumber: 3, p1Timeouts: 1, p2Timeouts: 1 };
  const base = { actor, opponent: opp, battle, isTimeout: false, now: 1000 };

  test("attack deals damage and passes the turn", () => {
    const r = resolveTurn({ ...base, action: "ATTACK" });
    expect(r.ended).toBe(false);
    if (r.ended) return;
    expect(r.opponentHp).toBe(88);
    expect(r.actorHp).toBe(100);
    expect(r.nextTurnNumber).toBe(4);
    expect(r.turnDeadlineAt).toBeGreaterThan(1000);
    expect(r.log).toBe("Alice strikes for 12 DMG!");
  });

  test("a killing blow ends the battle with the attacker as winner", () => {
    const r = resolveTurn({ ...base, opponent: { ...opp, hp: 5 }, action: "ATTACK" });
    expect(r).toEqual({ ended: true, winnerId: "a", log: "Alice strikes for 12 DMG!" });
  });

  test("fleeing ends the battle with the opponent as winner", () => {
    const r = resolveTurn({ ...base, action: "FLEE" });
    expect(r).toEqual({ ended: true, winnerId: "b", log: "Alice fled the battle!" });
  });

  test("healing restores HP up to max and does not touch the opponent", () => {
    const r = resolveTurn({ ...base, actor: { ...actor, hp: 90 }, action: "HEAL" });
    if (r.ended) throw new Error("should not end");
    expect(r.actorHp).toBe(100);
    expect(r.opponentHp).toBe(100);
  });

  test("an acting player's timeout counter resets; the other's is unchanged", () => {
    const r = resolveTurn({ ...base, action: "ATTACK" });
    if (r.ended) throw new Error("should not end");
    expect([r.p1Timeouts, r.p2Timeouts]).toEqual([0, 1]);
  });

  test("a timed-out turn increments only the actor's counter and uses timeout wording", () => {
    const r = resolveTurn({ ...base, action: "ATTACK", isTimeout: true });
    if (r.ended) throw new Error("should not end");
    expect([r.p1Timeouts, r.p2Timeouts]).toEqual([2, 1]);
    expect(r.log).toBe("Alice timed out and used a basic attack for 12 DMG!");
    const p2 = resolveTurn({ ...base, actor: { ...actor, id: "b" }, opponent: { ...opp, id: "a" }, action: "ATTACK", isTimeout: true });
    if (p2.ended) throw new Error("should not end");
    expect([p2.p1Timeouts, p2.p2Timeouts]).toEqual([1, 2]);
  });

  test("timeoutAction forfeits only on a second timeout while disconnected", () => {
    expect(timeoutAction(0, false)).toBe("ATTACK");
    expect(timeoutAction(1, true)).toBe("ATTACK");
    expect(timeoutAction(1, false)).toBe("FLEE");
  });
});

describe("rate limiting", () => {
  test("allows a full bucket of messages, then blocks until time passes", () => {
    const b = { msgTokens: MAX_MSGS_PER_SEC, lastTokenRefill: 0 };
    for (let i = 0; i < MAX_MSGS_PER_SEC; i++) expect(tryConsumeMessageToken(b, 0, false)).toBe(true);
    expect(tryConsumeMessageToken(b, 0, false)).toBe(false);
    expect(tryConsumeMessageToken(b, 100, false)).toBe(true); // 0.1s refills 3 tokens
  });

  test("free messages always pass and cost nothing", () => {
    const b = { msgTokens: 0, lastTokenRefill: 0 };
    expect(tryConsumeMessageToken(b, 0, true)).toBe(true);
    expect(b.msgTokens).toBe(0);
  });

  test("the bucket never refills past its maximum", () => {
    const b = { msgTokens: 0, lastTokenRefill: 0 };
    tryConsumeMessageToken(b, 3_600_000, true);
    expect(b.msgTokens).toBe(MAX_MSGS_PER_SEC);
  });
});

describe("per-key serial queue", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  test("tasks for one key run strictly in order, even when later ones are faster", async () => {
    const q = new KeyedSerialQueue();
    const order: string[] = [];
    const slow = q.run("k", async () => { await new Promise((r) => setTimeout(r, 20)); order.push("slow"); });
    const fast = q.run("k", async () => { order.push("fast"); });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["slow", "fast"]);
  });

  test("different keys do not block each other", async () => {
    const q = new KeyedSerialQueue();
    const order: string[] = [];
    const a = q.run("a", async () => { await new Promise((r) => setTimeout(r, 20)); order.push("a"); });
    const b = q.run("b", async () => { order.push("b"); });
    await Promise.all([a, b]);
    expect(order).toEqual(["b", "a"]);
  });

  test("a failed task rejects its caller but does not block later tasks", async () => {
    const q = new KeyedSerialQueue();
    const failing = q.run("k", async () => { throw new Error("boom"); });
    const next = q.run("k", async () => {});
    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBeUndefined();
    await tick();
  });
});

describe("alarm scheduling", () => {
  test("earliestTime ignores null and undefined", () => {
    expect(earliestTime([])).toBeNull();
    expect(earliestTime([undefined, null])).toBeNull();
    expect(earliestTime([50, undefined, 20, null, 30])).toBe(20);
  });

  test("earliestCooldownExpiry only counts standing, non-battle players with a future expiry", () => {
    const now = 1000;
    const players = [
      { currentZoneId: "tavern", battleId: null, battleCooldownUntil: 1500 },
      { currentZoneId: "tavern", battleId: null, battleCooldownUntil: 1200 },
      { currentZoneId: null, battleId: null, battleCooldownUntil: 1100 },
      { currentZoneId: "bank", battleId: "x", battleCooldownUntil: 1050 },
      { currentZoneId: "bank", battleId: null, battleCooldownUntil: 900 }
    ];
    expect(earliestCooldownExpiry(players, now)).toBe(1200);
    expect(earliestCooldownExpiry([], now)).toBeUndefined();
  });

  test("AlarmScheduler skips redundant storage calls and clears only when set", async () => {
    const calls: string[] = [];
    const storage = {
      setAlarm: async (t: number) => { calls.push(`set:${t}`); },
      deleteAlarm: async () => { calls.push("delete"); }
    } as unknown as DurableObjectStorage;
    const s = new AlarmScheduler(storage);
    await s.schedule(100);
    await s.schedule(100);
    await s.schedule(200);
    await s.schedule(null);
    await s.schedule(null);
    expect(calls).toEqual(["set:100", "set:200", "delete"]);
    s.reset();
    await s.schedule(null); // unknown state after reset: must clear again
    expect(calls.at(-1)).toBe("delete");
  });
});

describe("reward retry backoff", () => {
  test("grows exponentially from the initial delay and caps at five minutes", () => {
    const first = nextRewardRetry(1, 0);
    expect(first.attempts).toBe(2);
    expect(first.nextRetryAt).toBe(INITIAL_REWARD_RETRY_MS * 4);
    const delays = [1, 2, 3, 4, 5, 6, 7].map((a) => nextRewardRetry(a, 0).nextRetryAt);
    expect(delays).toEqual([...delays].sort((x, y) => x - y));
    expect(nextRewardRetry(40, 1000).nextRetryAt).toBe(1000 + 300_000);
  });
});

describe("hp percent", () => {
  test("rounds and clamps", () => {
    expect(toHpPercent(50, 100)).toBe(50);
    expect(toHpPercent(1, 3)).toBe(33);
    expect(toHpPercent(-5, 100)).toBe(0);
    expect(toHpPercent(500, 100)).toBe(100);
    expect(toHpPercent(10, 0)).toBe(0);
  });
});
