/**
 * Thin wrapper over a Durable Object's hibernatable WebSockets. Sockets are tagged with their player id,
 * so per-player lookups use the runtime's index instead of scanning every connection.
 */
import type { ServerMessage } from "shared/protocol";

export class SocketHub {
  constructor(private readonly ctx: DurableObjectState) {}

  /** Accepts `server` as a hibernatable socket tagged and attributed to `playerId`. */
  accept(server: WebSocket, playerId: string): void {
    this.ctx.acceptWebSocket(server, [playerId]);
    server.serializeAttachment({ playerId });
  }

  /** The player a socket belongs to, from its attachment. */
  static playerIdOf(ws: WebSocket): string | undefined {
    return (ws.deserializeAttachment() as { playerId?: string } | null)?.playerId;
  }

  /** Ids of players that currently have an open socket (used to recover state after a restart). */
  openPlayerIds(): Set<string> {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const id = SocketHub.playerIdOf(ws);
      if (id) ids.add(id);
    }
    return ids;
  }

  /** Number of open sockets in the room. */
  openCount(): number {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN).length;
  }

  /** Whether `playerId` has at least one open socket, optionally ignoring `exclude`. */
  hasOpenSocket(playerId: string, exclude?: WebSocket): boolean {
    return this.ctx.getWebSockets(playerId).some((ws) => ws !== exclude && ws.readyState === WebSocket.OPEN);
  }

  /** Closes every other socket of `playerId` with code 4001 so only one tab stays connected. */
  closeSuperseded(playerId: string, active: WebSocket): void {
    for (const existing of this.ctx.getWebSockets(playerId)) {
      if (existing === active) continue;
      try {
        existing.close(4001, "Superseded by new session");
      } catch {
        // Ignore already-closing sockets.
      }
    }
  }

  /** Sends to every open socket except `exclude`; one broken socket cannot stop delivery to the rest. */
  broadcast(payload: ServerMessage, exclude?: WebSocket): void {
    const msg = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== exclude && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(msg);
        } catch (err) {
          console.warn("Failed to broadcast WebSocket message:", err);
        }
      }
    }
  }

  /** Sends to every open socket of each listed player. */
  sendToPlayers(playerIds: string[], payload: ServerMessage): void {
    const msg = JSON.stringify(payload);
    for (const playerId of playerIds) {
      for (const ws of this.ctx.getWebSockets(playerId)) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        try {
          ws.send(msg);
        } catch (err) {
          console.warn(`Failed to send WebSocket message to ${playerId}:`, err);
        }
      }
    }
  }
}
