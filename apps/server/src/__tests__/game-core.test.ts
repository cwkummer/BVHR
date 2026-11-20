/**
 * Unit tests covering core shared physics, combat formulas, timeout forfeiture rules,
 * JWT scope isolation between session tokens and WebSocket tickets, and JWKS cache TTL clamping.
 */
import { parseCombatStats, parsePlayerIdHeader, parsePlayerRecord } from "../player-identity";
import { canReconnectToShard, pickFirstOpenShard } from "../shard-routing";
import { pickEncounterPairs, type EncounterCandidate } from "../encounters";
import { describe, expect, test } from "bun:test";
import { stepMovement, MAP_WIDTH, MAP_HEIGHT, PLAYER_RADIUS, WALLS } from "shared/map-zones";
import {
  computeBasicAttackDamage,
  computeHealedHp,
  shouldForfeitOnTimeout
} from "../combat";
import {
  mintSessionToken,
  mintWsTicket,
  parseCacheMaxAgeMs,
  verifySessionToken,
  verifyWsTicket
} from "../auth";

describe("movement and collision physics", () => {
  test("clamps movement inside world bounds", () => {
    const topLeft = stepMovement(PLAYER_RADIUS, PLAYER_RADIUS, -1, -1, 1);
    expect(topLeft.x).toBe(PLAYER_RADIUS);
    expect(topLeft.y).toBe(PLAYER_RADIUS);

    const bottomRight = stepMovement(MAP_WIDTH - PLAYER_RADIUS, MAP_HEIGHT - PLAYER_RADIUS, 1, 1, 1);
    expect(bottomRight.x).toBe(MAP_WIDTH - PLAYER_RADIUS);
    expect(bottomRight.y).toBe(MAP_HEIGHT - PLAYER_RADIUS);
  });

  test("pushes player out of solid wall rectangles", () => {
    const rock = WALLS[0];
    const startX = rock.x - PLAYER_RADIUS - 2;
    const startY = rock.y + rock.h / 2;
    const moved = stepMovement(startX, startY, 1, 0, 0.2);
    expect(moved.x).toBeLessThanOrEqual(rock.x - PLAYER_RADIUS + 0.01);
  });
});

describe("combat math and timeout rules", () => {
  test("computes basic attack damage with minimum 1 DMG floor", () => {
    expect(computeBasicAttackDamage(15, 6)).toBe(12);
    expect(computeBasicAttackDamage(2, 20)).toBe(1);
  });

  test("caps healing at maxHp", () => {
    expect(computeHealedHp(70, 100)).toBe(90);
    expect(computeHealedHp(95, 100)).toBe(100);
  });

  test("forfeits only on 2nd consecutive timeout while disconnected", () => {
    expect(shouldForfeitOnTimeout(0, false)).toBe(false);
    expect(shouldForfeitOnTimeout(1, true)).toBe(false);
    expect(shouldForfeitOnTimeout(1, false)).toBe(true);
  });
});

describe("JWT scope isolation and JWKS cache parsing", () => {
  const secret = "unit-test-secret-key-12345";

  test("prevents ws tickets from authenticating session endpoints and binds tickets to roomId", async () => {
    const sessionJwt = await mintSessionToken(secret, "user-1", "Hero");
    const wsTicket = await mintWsTicket(secret, "user-1", "na-overworld-1");

    // Session token passes session verification; wsTicket must be rejected as a session Bearer token.
    expect(await verifySessionToken(`Bearer ${sessionJwt}`, secret)).toBe("user-1");
    expect(await verifySessionToken(`Bearer ${wsTicket}`, secret)).toBeNull();

    // WebSocket ticket is valid only for the bound regional room ID.
    expect(await verifyWsTicket(wsTicket, secret, "na-overworld-1")).toBe("user-1");
    expect(await verifyWsTicket(wsTicket, secret, "na-overworld-2")).toBeNull();
  });

  test("clamps Cache-Control max-age within safe bounds", () => {
    expect(parseCacheMaxAgeMs("public, max-age=1800")).toBe(1_800_000);
    expect(parseCacheMaxAgeMs("public, max-age=10")).toBe(300_000);
    expect(parseCacheMaxAgeMs("public, max-age=999999")).toBe(21_600_000);
  });
});

describe("encounter matching", () => {
  const mk = (id: string, over: Partial<EncounterCandidate> = {}): EncounterCandidate => ({
    id,
    currentZoneId: "tavern",
    battleId: null,
    battleCooldownUntil: 0,
    zoneArmed: false,
    zoneEnteredAt: 0,
    ...over
  });

  test("armed entrant fights an idle player and takes the first turn", () => {
    const [pair] = pickEncounterPairs([mk("idle"), mk("entrant", { zoneArmed: true })], 1000);
    expect(pair.first.id).toBe("entrant");
    expect(pair.second.id).toBe("idle");
  });

  test("when both players are armed, the one who entered most recently leads", () => {
    const early = mk("early", { zoneArmed: true, zoneEnteredAt: 100 });
    const late = mk("late", { zoneArmed: true, zoneEnteredAt: 900 });
    // Order in the list must not matter.
    for (const list of [[early, late], [late, early]]) {
      const [pair] = pickEncounterPairs(list, 1000);
      expect(pair.first.id).toBe("late");
      expect(pair.second.id).toBe("early");
    }
  });

  test("two disarmed players standing together do not rematch", () => {
    expect(pickEncounterPairs([mk("a"), mk("b")], 1000)).toHaveLength(0);
  });

  test("armed player waits out immunity, then fights once it expires", () => {
    const players = [mk("a", { zoneArmed: true, battleCooldownUntil: 2000 }), mk("b")];
    expect(pickEncounterPairs(players, 1999)).toHaveLength(0);
    expect(pickEncounterPairs(players, 2000)).toHaveLength(1);
  });

  test("ignores players in battle or in different zones", () => {
    const players = [
      mk("a", { zoneArmed: true }),
      mk("b", { battleId: "x" }),
      mk("c", { currentZoneId: "bank" }),
      mk("d", { currentZoneId: null })
    ];
    expect(pickEncounterPairs(players, 1000)).toHaveLength(0);
  });

  test("pairs are disjoint when a zone has several players", () => {
    const pairs = pickEncounterPairs(
      [mk("a", { zoneArmed: true }), mk("b"), mk("c", { zoneArmed: true }), mk("d")],
      1000
    );
    const ids = pairs.flatMap((p) => [p.first.id, p.second.id]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(pairs).toHaveLength(2);
  });
});

describe("shard reconnect routing", () => {
  test("allows a tracked player back even when the shard is at its hard cap", () => {
    expect(canReconnectToShard({ count: 50, hasPlayer: true, hardCap: 50 })).toBe(true);
  });

  test("allows an untracked player while the shard is under its hard cap", () => {
    expect(canReconnectToShard({ count: 49, hasPlayer: false, hardCap: 50 })).toBe(true);
  });

  test("rejects an untracked player once the shard is at its hard cap", () => {
    expect(canReconnectToShard({ count: 50, hasPlayer: false, hardCap: 50 })).toBe(false);
  });
});

describe("fill-first shard selection", () => {
  const ids = ["s1", "s2", "s3", "s4"];
  const noCache = () => undefined;

  test("a burst of joins shares shard 1 until it is full", async () => {
    const cache = new Map<string, number>();
    const picks: string[] = [];
    for (let i = 0; i < 3; i++) {
      const open = await pickFirstOpenShard(ids, 40, (id) => cache.get(id), async () => 0);
      picks.push(open!.roomId);
      cache.set(open!.roomId, open!.count + 1); // optimistic bump as in issueShardSessionTicket
    }
    expect(picks).toEqual(["s1", "s1", "s1"]);
  });

  test("moves to the next shard once the first reaches the soft cap", async () => {
    const cache = new Map([["s1", 40]]);
    const open = await pickFirstOpenShard(ids, 40, (id) => cache.get(id), async () => 5);
    expect(open).toEqual({ roomId: "s2", count: 5 });
  });

  test("probes stale shards one at a time and stops at the first open one", async () => {
    const probed: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const counts: Record<string, number> = { s1: 40, s2: 40, s3: 7, s4: 0 };
    const open = await pickFirstOpenShard(ids, 40, noCache, async (id) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      probed.push(id);
      await Promise.resolve();
      inFlight--;
      return counts[id];
    });
    expect(open).toEqual({ roomId: "s3", count: 7 });
    expect(probed).toEqual(["s1", "s2", "s3"]);
    expect(maxInFlight).toBe(1);
  });

  test("skips shards whose probe fails and reports them", async () => {
    const failed: string[] = [];
    const open = await pickFirstOpenShard(
      ids,
      40,
      noCache,
      async (id) => {
        if (id === "s1") throw new Error("down");
        return 1;
      },
      (id) => failed.push(id)
    );
    expect(open?.roomId).toBe("s2");
    expect(failed).toEqual(["s1"]);
  });

  test("returns null when every shard is full or unreachable", async () => {
    const open = await pickFirstOpenShard(ids, 40, (id) => (id === "s1" ? 40 : undefined), async (id) => {
      if (id === "s2") throw new Error("down");
      return 40;
    });
    expect(open).toBeNull();
  });
});

describe("player id header validation", () => {
  test("accepts a normal id", () => {
    expect(parsePlayerIdHeader("3f2c1b7a-9d4e-4f6a-8c1d-2b5e7a9c0d1e")).toBe("3f2c1b7a-9d4e-4f6a-8c1d-2b5e7a9c0d1e");
  });

  test("rejects a missing, empty or oversized id", () => {
    expect(parsePlayerIdHeader(null)).toBeNull();
    expect(parsePlayerIdHeader("")).toBeNull();
    expect(parsePlayerIdHeader("x".repeat(65))).toBeNull();
    expect(parsePlayerIdHeader("x".repeat(64))).toBe("x".repeat(64));
  });
});

describe("player record rows from D1", () => {
  const row = { username: "Alice", maxHp: 100, attack: 15, defense: 6 };

  test("accepts a valid row, takes the id from the caller and drops unknown columns", () => {
    expect(parsePlayerRecord("u1", { ...row, email: "a@x.com", id: "someone-else" })).toEqual({
      identity: { id: "u1", username: "Alice" },
      stats: { maxHp: 100, attack: 15, defense: 6 }
    });
  });

  test("rejects an absent row, a bad username or invalid stats", () => {
    expect(parsePlayerRecord("u1", null)).toBeNull();
    expect(parsePlayerRecord("u1", { ...row, username: "" })).toBeNull();
    expect(parsePlayerRecord("u1", { ...row, username: "x".repeat(33) })).toBeNull();
    expect(parsePlayerRecord("u1", { ...row, username: 5 })).toBeNull();
    expect(parsePlayerRecord("u1", { maxHp: 100, attack: 15, defense: 6 })).toBeNull();
    expect(parsePlayerRecord("u1", { ...row, maxHp: 0 })).toBeNull();
  });
});

describe("combat stats rows from D1", () => {
  const ok = { maxHp: 100, attack: 15, defense: 6 };

  test("accepts a valid row and drops unknown columns", () => {
    expect(parseCombatStats({ ...ok, email: "a@x.com" })).toEqual(ok);
  });

  test("rejects absent rows and impossible values", () => {
    expect(parseCombatStats(undefined)).toBeNull();
    expect(parseCombatStats(null)).toBeNull();
    expect(parseCombatStats({ ...ok, maxHp: 0 })).toBeNull();
    expect(parseCombatStats({ ...ok, maxHp: 1e9 })).toBeNull();
    expect(parseCombatStats({ ...ok, attack: -1 })).toBeNull();
    expect(parseCombatStats({ ...ok, attack: 1.5 })).toBeNull();
    expect(parseCombatStats({ ...ok, defense: Number.NaN })).toBeNull();
    expect(parseCombatStats({ ...ok, defense: "6" })).toBeNull();
    const { maxHp, ...missing } = ok;
    expect(parseCombatStats(missing)).toBeNull();
  });
});
