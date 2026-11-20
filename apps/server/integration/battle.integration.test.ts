/**
 * Encounters, turn-based combat, rewards and rematch rules against a real Worker, Durable Object and D1.
 * Every test uses its own pair of users so reward assertions are independent.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GameClient, sleep } from "./support/client";
import { startServer, type TestServer } from "./support/server";

let server: TestServer;
let clients: GameClient[] = [];
const track = <T extends GameClient>(c: T): T => (clients.push(c), c);

const ids = ["1", "2", "3", "4", "5", "6"].flatMap((n) => [`alice${n}`, `bob${n}`, `cara${n}`]);

beforeAll(async () => {
  server = await startServer(ids.map((id) => ({ id, username: id[0].toUpperCase() + id.slice(1) })));
}, 120_000);

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
  await sleep(200);
});

afterAll(async () => {
  await server?.stop();
});

const user = (id: string) =>
  server.db.query("SELECT xp, gold FROM users WHERE id = ?").get(id) as { xp: number; gold: number };
const claimsFor = (id: string) =>
  server.db.query("SELECT xp, gold FROM reward_claims WHERE user_id = ?").all(id) as { xp: number; gold: number }[];

/** Joins two players and walks the first, then the second, into the tavern. */
async function meetInTavern(first: string, second: string, autoplay = true) {
  const a = track(await GameClient.join(server, first));
  const b = track(await GameClient.join(server, second));
  a.autoplay = b.autoplay = autoplay;
  await a.walkInto("tavern");
  await b.walkInto("tavern");
  return { a, b };
}

describe("encounters", () => {
  test("a lone player in a building starts nothing; a second player entering starts a battle they lead", async () => {
    const a = track(await GameClient.join(server, "alice1"));
    const b = track(await GameClient.join(server, "bob1"));
    await a.walkInto("tavern");
    await sleep(1_000);
    expect(a.all("BATTLE_STARTED")).toHaveLength(0);

    await b.walkInto("tavern");
    const forA = await a.waitFor("BATTLE_STARTED");
    const forB = await b.waitFor("BATTLE_STARTED");
    expect(forA.battle.id).toBe(forB.battle.id);
    expect(forA.battle).toMatchObject({ zoneId: "tavern", status: "ACTIVE", turnNumber: 1, p1Timeouts: 0, p2Timeouts: 0 });
    // The player who walked in leads, and HP is shown only as percentages.
    expect(forA.battle.player1Id).toBe("bob1");
    expect(forA.battle.activeTurnPlayerId).toBe("bob1");
    expect(forA.battle.hpPercentByPlayerId).toEqual({ alice1: 100, bob1: 100 });
  });

  test("players in different buildings do not fight", async () => {
    const a = track(await GameClient.join(server, "alice2"));
    const b = track(await GameClient.join(server, "bob2"));
    await a.walkInto("tavern");
    await b.walkInto("bank");
    await sleep(2_500);
    expect(a.all("BATTLE_STARTED")).toHaveLength(0);
    expect(b.all("BATTLE_STARTED")).toHaveLength(0);
  });
});

describe("combat and rewards", () => {
  test("the winner is rewarded exactly once and the loser is not", async () => {
    const { a, b } = await meetInTavern("alice3", "bob3");
    const endA = await a.waitFor("BATTLE_ENDED", undefined, 20_000);
    const endB = await b.waitFor("BATTLE_ENDED", undefined, 20_000);
    expect(endA.winnerId).toBe(endB.winnerId);
    expect(endA.participantIds.sort()).toEqual(["alice3", "bob3"]);
    const winner = endA.winnerId;
    const loser = winner === "alice3" ? "bob3" : "alice3";

    // Rewards are credited to D1 just after the result is sent.
    await Bun.sleep(500);
    expect(claimsFor(winner)).toEqual([{ xp: 50, gold: 25 }]);
    expect(user(winner)).toEqual({ xp: 50, gold: 75 });
    expect(claimsFor(loser)).toEqual([]);
    expect(user(loser)).toEqual({ xp: 0, gold: 50 });
  });

  test("combat uses the player's current stats from D1, not the stats they had when they joined", async () => {
    const a = track(await GameClient.join(server, "alice4"));
    const b = track(await GameClient.join(server, "bob4"));
    a.autoplay = b.autoplay = true;
    // Changed after both are connected: attack 15 -> 40 and defense 6 -> 20.
    server.db.run("UPDATE users SET attack = 40 WHERE id = 'alice4'");
    server.db.run("UPDATE users SET defense = 20 WHERE id = 'bob4'");
    await a.walkInto("tavern");
    await b.walkInto("tavern");
    await a.waitFor("BATTLE_ENDED", undefined, 20_000);

    const logs = [...a.all("TURN_RESOLVED").map((m) => m.log), ...a.all("BATTLE_ENDED").map((m) => m.log)];
    expect(logs).toContain("Alice4 strikes for 30 DMG!"); // 40 attack - floor(20 / 2)
    expect(logs).toContain("Bob4 strikes for 12 DMG!"); // 15 attack - floor(6 / 2)
  });

  test("turn rules: out-of-turn and stale actions are ignored; HEAL and FLEE work", async () => {
    const { a, b } = await meetInTavern("alice5", "bob5", false);
    const started = await a.waitFor("BATTLE_STARTED");
    const battleId = started.battle.id;
    const mark = a.mark();

    // Alice acting out of turn does nothing.
    a.send({ type: "BATTLE_ACTION", battleId, turnNumber: 1, action: "ATTACK" });
    // Bob (whose turn it is) with a stale turn number or a wrong battle id does nothing either.
    b.send({ type: "BATTLE_ACTION", battleId, turnNumber: 99, action: "ATTACK" });
    b.send({ type: "BATTLE_ACTION", battleId: "not-this-battle", turnNumber: 1, action: "ATTACK" });
    await sleep(600);
    expect(a.all("TURN_RESOLVED", mark)).toHaveLength(0);

    // A valid HEAL passes the turn to Alice.
    b.send({ type: "BATTLE_ACTION", battleId, turnNumber: 1, action: "HEAL" });
    const healed = await a.waitFor("TURN_RESOLVED", undefined, 5_000, mark);
    expect(healed).toMatchObject({ turnNumber: 2, nextTurnPlayerId: "alice5", log: "Bob5 recovers 20 HP!" });
    expect(healed.hpPercentByPlayerId).toEqual({ alice5: 100, bob5: 100 });

    // Alice fleeing ends the battle in Bob's favour (and pays him).
    a.send({ type: "BATTLE_ACTION", battleId, turnNumber: 2, action: "FLEE" });
    const ended = await b.waitFor("BATTLE_ENDED", undefined, 5_000);
    expect(ended.winnerId).toBe("bob5");
    expect(ended.log).toBe("Alice5 fled the battle!");
    await Bun.sleep(500);
    expect(claimsFor("bob5")).toEqual([{ xp: 50, gold: 25 }]);
  });
});

describe("rematches", () => {
  test("finished opponents standing together do not fight again, but a newcomer fights one of them", async () => {
    const { a, b } = await meetInTavern("alice6", "bob6");
    await a.waitFor("BATTLE_ENDED", undefined, 20_000);
    const startedBefore = a.all("BATTLE_STARTED").length;

    // Past the 3s post-battle immunity, nothing happens while both just stand there.
    await sleep(5_000);
    expect(a.all("BATTLE_STARTED")).toHaveLength(startedBefore);
    expect(b.all("BATTLE_STARTED")).toHaveLength(startedBefore);

    // A newcomer walking in is matched with one of the idle players.
    const c = track(await GameClient.join(server, "cara6"));
    c.autoplay = true;
    await c.walkInto("tavern");
    const started = await c.waitFor("BATTLE_STARTED");
    expect([started.battle.player1Id, started.battle.player2Id]).toContain("cara6");
    await c.waitFor("BATTLE_ENDED", undefined, 20_000);
  });
});
