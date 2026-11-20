/**
 * Matchmaking, shard routing, reconnecting and connection security against a real Worker.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GameClient, post, sleep, upgradeStatus, waitUntil } from "./support/client";
import { startServer, type TestServer } from "./support/server";

let server: TestServer;
let clients: GameClient[] = [];
const track = <T extends GameClient>(c: T): T => (clients.push(c), c);

beforeAll(async () => {
  server = await startServer(
    ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, username: id.toUpperCase() }))
  );
}, 120_000);

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
  await sleep(150);
});

afterAll(async () => {
  await server?.stop();
});

describe("authentication", () => {
  test("API routes reject a missing or invalid session token", async () => {
    for (const path of ["/api/join", "/api/ws-ticket"]) {
      const none = await fetch(server.baseUrl + path, { method: "POST", body: "{}" });
      expect(none.status).toBe(401);
      const bad = await fetch(server.baseUrl + path, { method: "POST", headers: { Authorization: "Bearer nope" }, body: "{}" });
      expect(bad.status).toBe(401);
    }
  });

  test("the profile endpoint returns game data but not the e-mail address or Google id", async () => {
    const res = await fetch(server.baseUrl + "/api/me", {
      headers: { Authorization: `Bearer ${await server.token("a")}` }
    });
    expect(res.status).toBe(200);
    const { profile } = (await res.json()) as { profile: Record<string, unknown> };
    expect(profile).toMatchObject({ id: "a", username: "A", level: 1, maxHp: 100 });
    expect(Object.keys(profile).sort()).toEqual(
      ["attack", "defense", "gold", "id", "level", "maxHp", "username", "xp"]
    );
  });

  test("a WebSocket upgrade needs a valid ticket for that exact room", async () => {
    expect(await upgradeStatus(server, "na-overworld-1", "garbage")).toBe(401);
    const ticket = (await post(server, "/api/ws-ticket", "a", { roomId: "na-overworld-1" })).json.wsTicket;
    // A ticket is bound to one room and cannot be replayed against another.
    expect(await upgradeStatus(server, "na-overworld-2", ticket)).toBe(401);
    expect(await upgradeStatus(server, "not-a-room", ticket)).toBe(400);
  });

  test("a client-supplied X-Player-Id header cannot change who you are", async () => {
    const res = await post(server, "/api/join", "a");
    const client = track(new GameClient(server, "a"));
    await client.connect(res.json.roomId, res.json.wsTicket, { "X-Player-Id": "b", "X-Player-Data": '{"id":"b"}' });
    expect(client.selfId).toBe("a");
    const me = client.all("SYNC_STATE")[0].players.find((p) => p.id === "a");
    expect(me?.username).toBe("A");
  });
});

describe("matchmaking", () => {
  test("players who join close together share one shard (fill-first)", async () => {
    const rooms: string[] = [];
    for (const id of ["a", "b", "c"]) {
      const c = track(await GameClient.join(server, id));
      rooms.push(c.roomId);
    }
    expect(rooms).toEqual(["na-overworld-1", "na-overworld-1", "na-overworld-1"]);
  });

  test("an existing player is told about newcomers, and newcomers get the full roster", async () => {
    const first = track(await GameClient.join(server, "a"));
    const second = track(await GameClient.join(server, "b"));
    const joined = await first.waitFor("PLAYER_JOINED");
    expect(joined.player).toMatchObject({ id: "b", username: "B", x: 120, y: 120, currentZoneId: null, battleId: null });
    expect(second.all("SYNC_STATE")[0].players.map((p) => p.id).sort()).toEqual(["a", "b"]);
    // Nothing sensitive in the roster.
    expect(Object.keys(joined.player).sort()).toEqual(["battleId", "currentZoneId", "id", "username", "x", "y"]);
  });

  test("a player is removed for everyone else when they disconnect", async () => {
    const first = track(await GameClient.join(server, "a"));
    const second = track(await GameClient.join(server, "b"));
    await first.waitFor("PLAYER_JOINED");
    await second.close();
    const left = await first.waitFor("PLAYER_LEFT");
    expect(left.playerId).toBe("b");
  });

  test("a valid room can be requested directly; shards are isolated from each other", async () => {
    const inThree = track(await GameClient.joinRoom(server, "a", "na-overworld-3"));
    const inOne = track(await GameClient.join(server, "b"));
    expect(inThree.roomId).toBe("na-overworld-3");
    expect(inOne.roomId).toBe("na-overworld-1");
    expect(inOne.all("SYNC_STATE")[0].players.map((p) => p.id)).toEqual(["b"]);
  });

  test("an invalid room id is rejected with 400", async () => {
    const res = await post(server, "/api/ws-ticket", "a", { roomId: "bogus" });
    expect(res.status).toBe(400);
  });

  test("/api/join resumes a player's current room instead of starting fresh", async () => {
    track(await GameClient.joinRoom(server, "a", "na-overworld-3"));
    const res = await post(server, "/api/join", "a", { resumeRoomId: "na-overworld-3" });
    expect(res.status).toBe(200);
    expect(res.json.roomId).toBe("na-overworld-3");
  });
});

describe("reconnecting", () => {
  test("after a dropped connection a player gets a ticket for the SAME room, even when other shards are emptier", async () => {
    // Regression: the player is pruned from the room on disconnect, and the server used to hand back a
    // ticket for the lowest-occupancy shard, which the client then could not use for its own room.
    const stayer = track(await GameClient.joinRoom(server, "a", "na-overworld-2"));
    const dropper = track(await GameClient.joinRoom(server, "b", "na-overworld-2"));
    await stayer.waitFor("PLAYER_JOINED");
    await dropper.close();
    await stayer.waitFor("PLAYER_LEFT");

    const res = await post(server, "/api/ws-ticket", "b", { roomId: "na-overworld-2" });
    expect(res.status).toBe(200);
    expect(res.json.roomId).toBe("na-overworld-2");

    const back = track(new GameClient(server, "b"));
    await back.connect(res.json.roomId, res.json.wsTicket);
    expect(back.all("SYNC_STATE")[0].players.map((p) => p.id).sort()).toEqual(["a", "b"]);
  });

  test("a second tab supersedes the first, which is closed with code 4001", async () => {
    const first = track(await GameClient.joinRoom(server, "a", "na-overworld-1"));
    const second = track(new GameClient(server, "a"));
    await second.reconnect("na-overworld-1");
    // The server closes the old socket immediately; it is no longer open and gets no more messages.
    await waitUntil(() => !first.isOpen, 2_000, "first tab to stop being open");
    expect(second.isOpen).toBe(true);
    // Bun's WebSocket client only reports the close event after its ~10s closing-handshake timeout
    // (Chromium reports code 4001 after ~2s), so allow for that here.
    await waitUntil(() => first.closeCode === 4001, 15_000, "first tab to be closed with 4001");
    expect(second.closeCode).toBeNull();
    // The player is still in the room exactly once.
    expect(second.all("SYNC_STATE")[0].players.filter((p) => p.id === "a")).toHaveLength(1);
  });
});
