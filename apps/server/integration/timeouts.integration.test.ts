/**
 * Turn timeouts, AFK and disconnect handling, driven by the Durable Object alarm. These wait on real
 * ten-second turn timers, so this file is the slowest (about a minute).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GameClient, post, sleep, waitUntil } from "./support/client";
import { startServer, type TestServer } from "./support/server";
import { TURN_TIMEOUT_MS } from "../src/combat";

let server: TestServer;
let clients: GameClient[] = [];
const track = <T extends GameClient>(c: T): T => (clients.push(c), c);

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

beforeAll(async () => {
  server = await startServer(
    ["afk1", "afk2", "gone1", "gone2", "drop1", "drop2"].map((id) => ({ id, username: cap(id) }))
  );
}, 120_000);

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
  await sleep(300);
});

afterAll(async () => {
  await server?.stop();
});

/** Joins two players and walks `first` then `second` (the challenger, who leads) into the tavern. */
async function startBattle(first: string, second: string) {
  const a = track(await GameClient.join(server, first));
  const b = track(await GameClient.join(server, second));
  await a.walkInto("tavern");
  await b.walkInto("tavern");
  await a.waitFor("BATTLE_STARTED");
  await b.waitFor("BATTLE_STARTED");
  return { a, b };
}

describe("turn timeouts", () => {
  test("a player who does nothing loses their turn to an automatic attack; their strike count resets when they act", async () => {
    const { a, b } = await startBattle("afk1", "afk2"); // afk2 entered last, so afk2 leads
    a.autoplay = true; // afk1 answers immediately; afk2 stays idle at first
    const mark = a.mark();

    const timedOut = await a.waitFor("TURN_RESOLVED", undefined, TURN_TIMEOUT_MS + 8_000, mark);
    expect(timedOut.log).toBe("Afk2 timed out and used a basic attack for 12 DMG!");
    expect(timedOut.p1Timeouts).toBe(1); // afk2 is player 1

    // afk1 replies; afk2's strike stays on the books until afk2 acts for themselves.
    const reply = await a.waitFor("TURN_RESOLVED", (m) => m.nextTurnPlayerId === "afk2", 5_000, mark);
    expect(reply.p1Timeouts).toBe(1);

    b.send({ type: "BATTLE_ACTION", battleId: b.battle!.id, turnNumber: reply.turnNumber, action: "ATTACK" });
    const acted = await a.waitFor("TURN_RESOLVED", (m) => m.turnNumber === reply.turnNumber + 1, 5_000, mark);
    expect(acted.p1Timeouts).toBe(0);
  }, 60_000);

  test("a disconnected player is forfeited after their second missed turn, and the other player is paid", async () => {
    const { a, b } = await startBattle("gone1", "gone2"); // gone2 leads
    a.autoplay = true;
    await b.close(); // gone2 drops and never comes back; they stay in the room while the battle is live
    const mark = a.mark();

    const ended = await a.waitFor("BATTLE_ENDED", undefined, 2 * TURN_TIMEOUT_MS + 15_000, mark);
    expect(ended.winnerId).toBe("gone1");
    expect(ended.log).toBe("Gone2 missed 2 turns while disconnected and fled!");
    // One automatic attack first, then the forfeit.
    expect(a.all("TURN_RESOLVED", mark).some((m) => m.log.includes("Gone2 timed out"))).toBe(true);

    await sleep(500);
    const claims = server.db.query("SELECT user_id, xp, gold FROM reward_claims").all();
    expect(claims).toContainEqual({ user_id: "gone1", xp: 50, gold: 25 });
    expect(claims.filter((c: any) => c.user_id === "gone2")).toHaveLength(0);
  }, 90_000);
});

describe("disconnects during a battle", () => {
  test("a player who drops mid-battle stays in the room and can resume the same battle", async () => {
    const { a, b } = await startBattle("drop1", "drop2");
    const battleId = b.battle!.id;
    const mark = a.mark();

    await b.close();
    await sleep(500);
    // Their opponent is not told they left: the battle is still live.
    expect(a.all("PLAYER_LEFT", mark)).toHaveLength(0);

    // A new ticket for the same room is issued (the room still has them) and the battle is restored.
    const ticket = await post(server, "/api/ws-ticket", "drop2", { roomId: b.roomId });
    expect(ticket.status).toBe(200);
    const mark2 = b.mark();
    await b.connect(ticket.json.roomId, ticket.json.wsTicket);
    const sync = b.all("SYNC_STATE", mark2)[0];
    expect(sync.battle?.id).toBe(battleId);
    expect(sync.battle?.hpPercentByPlayerId).toEqual({ drop1: 100, drop2: 100 });

    // Both play it out.
    a.autoplay = b.autoplay = true;
    a.playTurnIfMine();
    b.playTurnIfMine();
    const ended = await a.waitFor("BATTLE_ENDED", undefined, 25_000, mark);
    expect(["drop1", "drop2"]).toContain(ended.winnerId);
    await waitUntil(() => b.all("BATTLE_ENDED", mark2).length > 0, 5_000, "resumed player to see the result");
  }, 60_000);
});
