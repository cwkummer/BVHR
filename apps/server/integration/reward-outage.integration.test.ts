/**
 * Reward delivery while D1 is down: the winner is still told about the reward, the reward is kept and
 * retried by the room's alarm with backoff, and once D1 recovers it is credited exactly once.
 *
 * The local D1 cannot be made to fail on demand, so the outage is simulated by renaming the
 * `reward_claims` table in the Worker's database file: every claim then fails inside D1 with "no such table"
 * (the same code path as a D1 error), and renaming it back is the recovery.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GameClient, sleep, waitUntil } from "./support/client";
import { startServer, type TestServer } from "./support/server";

let server: TestServer;
let clients: GameClient[] = [];
const track = <T extends GameClient>(c: T): T => (clients.push(c), c);

beforeAll(async () => {
  server = await startServer(["alice", "bob", "cara", "dan", "eve", "fay"].map((id) => ({ id, username: id })));
}, 120_000);

afterEach(async () => {
  // Never leave the outage in place for the next test.
  restoreRewardTable();
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
  await sleep(200);
});

afterAll(async () => {
  await server?.stop();
});

const breakRewardTable = () => server.db.run("ALTER TABLE reward_claims RENAME TO reward_claims_offline");
function restoreRewardTable() {
  const offline = server.db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reward_claims_offline'")
    .get();
  if (offline) server.db.run("ALTER TABLE reward_claims_offline RENAME TO reward_claims");
}

const account = (id: string) =>
  server.db.query("SELECT xp, gold FROM users WHERE id = ?").get(id) as { xp: number; gold: number };
const claimsFor = (id: string) =>
  server.db.query("SELECT xp, gold FROM reward_claims WHERE user_id = ?").all(id) as { xp: number; gold: number }[];

/** Plays a full battle between two fresh players and returns who won and the winner's reward message. */
async function playBattle(first: string, second: string) {
  const a = track(await GameClient.join(server, first));
  const b = track(await GameClient.join(server, second));
  a.autoplay = b.autoplay = true;
  await a.walkInto("tavern");
  await b.walkInto("tavern");
  const endA = await a.waitFor("BATTLE_ENDED", undefined, 20_000);
  const endB = await b.waitFor("BATTLE_ENDED", undefined, 20_000);
  return { winner: endA.winnerId, loser: endA.winnerId === first ? second : first, endA, endB };
}

describe("reward delivery during a D1 outage", () => {
  test("the result still reaches players, the reward is retried after D1 recovers and credited exactly once", async () => {
    breakRewardTable();
    const { winner, loser, endA, endB } = await playBattle("alice", "bob");

    // Players are told the outcome and the reward immediately; D1 being down does not delay or hide it.
    expect(endA.reward).toEqual({ xp: 50, gold: 25 });
    expect(endB.reward).toEqual({ xp: 50, gold: 25 });

    // The first delivery failed: nothing was credited. The retry timer (5 s) fires while D1 is still down and
    // fails too, so the reward must survive more than one failed attempt.
    await sleep(8_000);
    expect(account(winner)).toEqual({ xp: 0, gold: 50 });

    restoreRewardTable();

    // The next retry is backed off (about 20 s after the second failure), then the reward is credited.
    await waitUntil(() => account(winner).xp === 50, 45_000, `${winner}'s reward to be credited after D1 recovered`, 500);
    expect(account(winner)).toEqual({ xp: 50, gold: 75 });
    expect(claimsFor(winner)).toEqual([{ xp: 50, gold: 25 }]);

    // Nothing is credited twice later on, and the loser never receives anything.
    await sleep(6_000);
    expect(account(winner)).toEqual({ xp: 50, gold: 75 });
    expect(claimsFor(winner)).toHaveLength(1);
    expect(account(loser)).toEqual({ xp: 0, gold: 50 });
    expect(claimsFor(loser)).toEqual([]);
  }, 100_000);

  test("a reward stuck during an outage survives its players leaving and does not block other battles", async () => {
    // First battle: its reward is stuck while D1 is down, and then both players leave the room.
    breakRewardTable();
    const first = await playBattle("cara", "dan");
    expect(account(first.winner).xp).toBe(0);
    await Promise.all(clients.map((c) => c.close()));
    clients = [];
    restoreRewardTable();

    // D1 is back. A different pair fights and is paid right away, while the first reward is still waiting
    // for its backed-off retry.
    const second = await playBattle("eve", "fay");
    await waitUntil(() => account(second.winner).xp === 50, 5_000, "the second battle's reward to be credited");
    expect(account(first.winner).xp).toBe(0);

    // The first reward is credited by a later retry even though nobody from that battle is connected.
    await waitUntil(() => account(first.winner).xp === 50, 45_000, "the first reward to be credited", 500);
    expect(account(first.winner)).toEqual({ xp: 50, gold: 75 });
    expect(claimsFor(first.winner)).toEqual([{ xp: 50, gold: 25 }]);
    expect(claimsFor(second.winner)).toEqual([{ xp: 50, gold: 25 }]);
    expect(account(first.loser)).toEqual({ xp: 0, gold: 50 });
    expect(account(second.loser)).toEqual({ xp: 0, gold: 50 });
  }, 120_000);
});
