/**
 * A scripted game client over the real HTTP API and WebSocket protocol, plus small polling helpers.
 */
import { BUILDINGS } from "shared/map-zones";
import type { BattleState, ClientMessage, ServerMessage } from "shared/protocol";
import type { TestServer } from "./server";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls `cond` until it is true or `timeoutMs` elapses (then throws, naming `label`). */
export async function waitUntil(cond: () => boolean, timeoutMs: number, label: string, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
    await sleep(intervalMs);
  }
}

export type ApiResult = { status: number; json: any };

/** POSTs JSON to an API route with the user's session token. */
export async function post(server: TestServer, path: string, userId: string, body: unknown = {}): Promise<ApiResult> {
  const res = await fetch(server.baseUrl + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${await server.token(userId)}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/**
 * HTTP status of a WebSocket upgrade request, without completing the upgrade. Only meaningful for
 * requests the server refuses (any success would be a 101 that `fetch` cannot represent).
 */
export async function upgradeStatus(
  server: TestServer,
  roomId: string,
  ticket: string,
  extraHeaders: Record<string, string> = {}
): Promise<number> {
  const res = await fetch(`${server.baseUrl}/ws/${roomId}?ticket=${encodeURIComponent(ticket)}`, {
    headers: { Upgrade: "websocket", ...extraHeaders }
  });
  return res.status;
}

export class GameClient {
  readonly messages: ServerMessage[] = [];
  selfId = "";
  x = 0;
  y = 0;
  zone: string | null = null;
  battle: BattleState | null = null;
  closeCode: number | null = null;
  /** When true, attacks automatically whenever it is this client's turn. */
  autoplay = false;
  roomId = "";
  private ws!: WebSocket;

  constructor(
    private readonly server: TestServer,
    readonly userId: string
  ) {}

  /** Joins through matchmaking (`/api/join`) and connects. */
  static async join(server: TestServer, userId: string, body: unknown = {}): Promise<GameClient> {
    const client = new GameClient(server, userId);
    const res = await post(server, "/api/join", userId, body);
    if (res.status !== 200) throw new Error(`/api/join failed for ${userId}: ${res.status} ${JSON.stringify(res.json)}`);
    await client.connect(res.json.roomId, res.json.wsTicket);
    return client;
  }

  /** Connects to a specific room through `/api/ws-ticket`. */
  static async joinRoom(server: TestServer, userId: string, roomId: string): Promise<GameClient> {
    const client = new GameClient(server, userId);
    await client.reconnect(roomId);
    return client;
  }

  /** (Re)connects using a fresh ticket for `roomId` (defaults to the current room). */
  async reconnect(roomId = this.roomId): Promise<void> {
    const res = await post(this.server, "/api/ws-ticket", this.userId, { roomId });
    if (res.status !== 200) throw new Error(`/api/ws-ticket failed for ${this.userId}: ${res.status} ${JSON.stringify(res.json)}`);
    await this.connect(res.json.roomId, res.json.wsTicket);
  }

  /** Opens the socket and resolves after the first `SYNC_STATE`; rejects if the upgrade is refused. */
  async connect(roomId: string, ticket: string, headers?: Record<string, string>): Promise<void> {
    this.roomId = roomId;
    this.closeCode = null;
    const mark = this.messages.length;
    this.ws = new WebSocket(
      `${this.server.wsUrl}/ws/${roomId}?ticket=${encodeURIComponent(ticket)}`,
      headers ? ({ headers } as any) : undefined
    );
    this.ws.onmessage = (e) => this.onMessage(e.data as string);
    this.ws.onclose = (e) => {
      this.closeCode = e.code;
    };
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`WebSocket to ${roomId} failed for ${this.userId}`));
    });
    await this.waitFor("SYNC_STATE", undefined, 5_000, mark);
  }

  private onMessage(raw: string) {
    if (raw === "pong") return;
    const m = JSON.parse(raw) as ServerMessage;
    this.messages.push(m);
    switch (m.type) {
      case "SYNC_STATE": {
        this.selfId = m.selfId;
        this.battle = m.battle;
        const me = m.players.find((p) => p.id === m.selfId);
        if (me) [this.x, this.y, this.zone] = [me.x, me.y, me.currentZoneId];
        break;
      }
      case "SNAPSHOT": {
        const me = m.players.find((p) => p.id === this.selfId);
        if (me) [this.x, this.y, this.zone] = [me.x, me.y, me.currentZoneId];
        break;
      }
      case "BATTLE_STARTED":
        this.battle = m.battle;
        break;
      case "TURN_RESOLVED":
        if (this.battle) this.battle = { ...this.battle, turnNumber: m.turnNumber, activeTurnPlayerId: m.nextTurnPlayerId };
        break;
      case "BATTLE_ENDED":
        this.battle = null;
        break;
    }
    if (this.autoplay) this.playTurnIfMine();
  }

  /** Sends an ATTACK if a battle is active and it is this client's turn. */
  playTurnIfMine(): void {
    const b = this.battle;
    if (b && b.activeTurnPlayerId === this.selfId && this.ws.readyState === WebSocket.OPEN) {
      this.send({ type: "BATTLE_ACTION", battleId: b.id, turnNumber: b.turnNumber, action: "ATTACK" });
    }
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Index to pass as `from` so later waits ignore everything received so far. */
  mark(): number {
    return this.messages.length;
  }

  /** All received messages of a type. */
  all<T extends ServerMessage["type"]>(type: T, from = 0): Extract<ServerMessage, { type: T }>[] {
    return this.messages.slice(from).filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }

  /** Resolves with the first message of `type` (matching `pred`) at or after index `from`. */
  async waitFor<T extends ServerMessage["type"]>(
    type: T,
    pred?: (m: Extract<ServerMessage, { type: T }>) => boolean,
    timeoutMs = 5_000,
    from = 0
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const find = () => this.all(type, from).find((m) => !pred || pred(m));
    await waitUntil(() => find() !== undefined, timeoutMs, `${this.userId} to receive ${type}`);
    return find()!;
  }

  /**
   * Walks into a building zone: horizontally to the zone's centre line, then vertically until the server
   * reports the player inside. It stops as soon as the player is inside, because entering can immediately
   * start a battle, which freezes movement.
   */
  async walkInto(zoneId: string): Promise<void> {
    const b = BUILDINGS.find((z) => z.id === zoneId);
    if (!b) throw new Error(`Unknown zone ${zoneId}`);
    const tx = b.x + b.w / 2;

    if (Math.abs(this.x - tx) > 8) {
      const sign = this.x < tx ? 1 : -1;
      this.send({ type: "WASD", dx: sign, dy: 0 });
      await waitUntil(() => (sign === 1 ? this.x >= tx : this.x <= tx), 15_000, `${this.userId} to line up with ${zoneId}`, 20);
      this.send({ type: "WASD", dx: 0, dy: 0 });
      await sleep(80);
    }

    if (this.zone !== zoneId) {
      const sign = this.y < b.y ? 1 : -1;
      this.send({ type: "WASD", dx: 0, dy: sign });
      await waitUntil(() => this.zone === zoneId, 15_000, `${this.userId} to enter ${zoneId}`, 20);
      this.send({ type: "WASD", dx: 0, dy: 0 });
    }
  }

  /** Whether the socket is currently open. */
  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Closes the socket and waits for the close to be observed. */
  async close(code = 1000): Promise<void> {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.close(code);
      await waitUntil(() => this.closeCode !== null, 3_000, `${this.userId} socket to close`).catch(() => {});
    }
  }
}
