/**
 * Shard capacity: fill-first rollover at the soft cap, and the room's hard cap for new joins versus
 * reconnects. Opens about fifty real WebSocket connections.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ROOM_HARD_CAP, ROOM_SOFT_CAP } from "shared/shard-config";
import { GameClient, post, upgradeStatus, waitUntil } from "./support/client";
import { startServer, type TestServer } from "./support/server";

let server: TestServer;
const clients: GameClient[] = [];

const uid = (n: number) => `u${String(n).padStart(2, "0")}`;
const USERS = ROOM_HARD_CAP + 8;

beforeAll(async () => {
  server = await startServer(Array.from({ length: USERS }, (_, n) => ({ id: uid(n), username: `User${n}` })));
}, 120_000);

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await server?.stop();
});

const SHARD_1 = "na-overworld-1";
const SHARD_2 = "na-overworld-2";

describe("shard capacity", () => {
  // The two tests share state on purpose: the second continues from the full shard the first builds.

  test("matchmaking fills shard 1 up to the soft cap, then rolls over to shard 2", async () => {
    const joins: { userId: string; roomId: string; ticket: string; count: number }[] = [];
    for (let n = 0; n <= ROOM_SOFT_CAP; n++) {
      const res = await post(server, "/api/join", uid(n));
      expect(res.status).toBe(200);
      joins.push({ userId: uid(n), roomId: res.json.roomId, ticket: res.json.wsTicket, count: res.json.count });
    }
    expect(joins.slice(0, ROOM_SOFT_CAP).every((j) => j.roomId === SHARD_1)).toBe(true);
    expect(joins[ROOM_SOFT_CAP].roomId).toBe(SHARD_2);
    expect(joins[ROOM_SOFT_CAP - 1].count).toBe(ROOM_SOFT_CAP);

    // Seat all of them for real straight away (tickets are only valid for 20 seconds).
    await Promise.all(
      joins.map(async (j) => {
        const c = new GameClient(server, j.userId);
        clients.push(c);
        await c.connect(j.roomId, j.ticket);
      })
    );
    const shard1 = clients.find((c) => c.roomId === SHARD_1)!;
    expect(shard1.all("SYNC_STATE")[0].players.length).toBeGreaterThan(0);
  }, 90_000);

  test("past the soft cap a room still takes reconnecting players, up to the hard cap, then refuses new ones", async () => {
    // Shard 1 holds u00..u39 (soft cap). Direct requests may fill it to the hard cap.
    const seat = async (n: number) => {
      const c = await GameClient.joinRoom(server, uid(n), SHARD_1);
      clients.push(c);
      return c;
    };
    for (let n = ROOM_SOFT_CAP + 1; n < ROOM_HARD_CAP; n++) await seat(n); // up to HARD_CAP - 1 players

    // With one slot left, a ticket can still be issued and used...
    const lateTicket = await post(server, "/api/ws-ticket", "u" + (ROOM_HARD_CAP), { roomId: SHARD_1 });
    expect(lateTicket.status).toBe(200);
    // ...but if someone else takes the last slot first, that ticket is refused at the door (503).
    await seat(ROOM_HARD_CAP + 1);
    expect(await upgradeStatus(server, SHARD_1, lateTicket.json.wsTicket)).toBe(503);

    // A full room refuses new tickets for it outright (409) so the client re-matchmakes.
    const full = await post(server, "/api/ws-ticket", uid(ROOM_HARD_CAP + 2), { roomId: SHARD_1 });
    expect(full.status).toBe(409);

    // A player already in the full room can reconnect (a new tab replaces their old one).
    const existing = clients.find((c) => c.userId === uid(0))!;
    const again = new GameClient(server, uid(0));
    clients.push(again);
    await again.reconnect(SHARD_1);
    await waitUntil(() => !existing.isOpen, 2_000, "the replaced tab to stop being open");

    // New players are sent elsewhere.
    const newcomer = await post(server, "/api/join", uid(ROOM_HARD_CAP + 3));
    expect(newcomer.status).toBe(200);
    expect(newcomer.json.roomId).not.toBe(SHARD_1);
  }, 90_000);
});
