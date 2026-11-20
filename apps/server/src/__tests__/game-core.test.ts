/**
 * Unit tests covering core shared physics, combat formulas, timeout forfeiture rules,
 * JWT scope isolation between session tokens and WebSocket tickets, and JWKS cache TTL clamping.
 */
import { pickEncounterPairs, type EncounterCandidate } from "../encounters";
import { describe, expect, test } from "bun:test";
import { stepMovement, MAP_WIDTH, MAP_HEIGHT, PLAYER_RADIUS, WALLS } from "../../../../shared/map-zones";
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
    ...over
  });

  test("armed entrant fights an idle player and takes the first turn", () => {
    const [pair] = pickEncounterPairs([mk("idle"), mk("entrant", { zoneArmed: true })], 1000);
    expect(pair.first.id).toBe("entrant");
    expect(pair.second.id).toBe("idle");
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
