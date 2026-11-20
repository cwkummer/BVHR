/**
 * What happens when valid combat stats cannot be read from D1: no battle starts, players are told once,
 * and play resumes by itself when the data is valid again.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GameClient, post, sleep, upgradeStatus } from "./support/client";
import { startServer, type TestServer } from "./support/server";

let server: TestServer;
let clients: GameClient[] = [];
const track = <T extends GameClient>(c: T): T => (clients.push(c), c);

beforeAll(async () => {
  server = await startServer(
    ["alice", "bob", "cara"].map((id) => ({ id, username: id[0].toUpperCase() + id.slice(1) }))
  );
}, 120_000);

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
});

afterAll(async () => {
  await server?.stop();
});

describe("invalid stats in D1", () => {
  test("a battle does not start, each player is told once, and it starts by itself once the data is valid", async () => {
    const a = track(await GameClient.join(server, "alice"));
    const b = track(await GameClient.join(server, "bob"));
    a.autoplay = b.autoplay = true;
    server.db.run("UPDATE users SET max_hp = 0 WHERE id = 'bob'"); // impossible value

    await a.walkInto("tavern");
    await b.walkInto("tavern");
    await sleep(5_500); // several 2s retry cycles

    expect(a.all("BATTLE_STARTED")).toHaveLength(0);
    expect(b.all("BATTLE_STARTED")).toHaveLength(0);
    // One notice per player, not one per retry.
    for (const client of [a, b]) {
      const notices = client.all("BATTLE_START_FAILED");
      expect(notices).toEqual([{ type: "BATTLE_START_FAILED", reason: "STATS_UNAVAILABLE", retryInMs: 2000 }]);
    }

    server.db.run("UPDATE users SET max_hp = 100 WHERE id = 'bob'");
    await a.waitFor("BATTLE_STARTED", undefined, 8_000);
    await b.waitFor("BATTLE_STARTED", undefined, 8_000);
    await a.waitFor("BATTLE_ENDED", undefined, 20_000);
    expect(a.all("BATTLE_START_FAILED")).toHaveLength(1);
  });

  test("a player whose stats are invalid cannot join a room at all", async () => {
    server.db.run("UPDATE users SET attack = -5 WHERE id = 'cara'");
    // The Worker still issues a ticket (the account exists), but the room refuses to seat the player.
    const ticket = await post(server, "/api/ws-ticket", "cara", { roomId: "na-overworld-1" });
    expect(ticket.status).toBe(200);
    expect(await upgradeStatus(server, "na-overworld-1", ticket.json.wsTicket)).toBe(404);

    server.db.run("UPDATE users SET attack = 15 WHERE id = 'cara'");
    const retry = await post(server, "/api/ws-ticket", "cara", { roomId: "na-overworld-1" });
    const cara = track(new GameClient(server, "cara"));
    await cara.connect("na-overworld-1", retry.json.wsTicket);
    expect(cara.selfId).toBe("cara");
  });
});
