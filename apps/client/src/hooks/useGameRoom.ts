/**
 * React hook managing the WebSocket connection to a `GameRoom` Durable Object shard.
 * Handles:
 *  - One-shot initial ticket consumption scoped to `roomId` and fresh ticket minting on reconnect.
 *  - Application-level ping/pong liveness monitoring alongside DO auto-response ping/pong.
 *  - Exponential backoff with jitter and shard failover (`onShardUnavailable`) when a shard cannot be reached.
 *  - Session supersession handling (close code 4001) when another tab opens the same player session.
 *  - Server clock offset estimation (`clockOffsetMs`), synced `roster` state, active `battle` state,
 *    and mutable `positionsRef` read directly by `GameSceneController` each animation frame.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import type { ClientMessage, ServerMessage, PlayerSnapshot, BattleState, BattleAction } from "../../../../shared/protocol";

/**
 * Mutable client-side entity position record updated on `SYNC_STATE`, `SNAPSHOT`, and `PLAYER_JOINED`
 * and consumed directly inside the PixiJS render ticker without triggering React re-renders.
 */
export type EntityPos = {
  id: string;
  username: string;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  currentZoneId: string | null;
};

// Reconnection backoff, shard failover threshold, and application heartbeat timing constants.
const BASE_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 15_000;
const MAX_CONSECUTIVE_FAILURES_BEFORE_REMATCH = 3;
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;

export function useGameRoom(
  roomId: string | null,
  initialWsTicket: string | null,
  fetchWsTicket: ((roomId: string) => Promise<string>) | null,
  onShardUnavailable?: () => void
) {
  const wsRef = useRef<WebSocket | null>(null);
  const positionsRef = useRef<Map<string, EntityPos>>(new Map());
  // Tracks whether `initialWsTicket` has already been consumed for the active `roomId`.
  const consumedInitialTicketRef = useRef<{ roomId: string; ticket: string } | null>(null);
  const onShardUnavailableRef = useRef(onShardUnavailable);
  onShardUnavailableRef.current = onShardUnavailable;

  const [connected, setConnected] = useState(false);
  const [synced, setSynced] = useState(false);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [superseded, setSuperseded] = useState(false);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [roster, setRoster] = useState<Record<string, PlayerSnapshot>>({});
  const [battle, setBattle] = useState<BattleState | null>(null);
  const [combatLog, setCombatLog] = useState<string[]>([]);
  // Transient overworld notice (e.g. a battle could not start); cleared on battle start or after a delay.
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!fetchWsTicket || !roomId) {
      setSynced(false);
      return;
    }

    // Reset ticket consumption tracking whenever the target room or initial ticket changes.
    if (
      consumedInitialTicketRef.current &&
      (consumedInitialTicketRef.current.roomId !== roomId ||
        consumedInitialTicketRef.current.ticket !== initialWsTicket)
    ) {
      consumedInitialTicketRef.current = null;
    }
    setSynced(false);

    let reconnectTimer: ReturnType<typeof setTimeout>;
    let pingTimer: ReturnType<typeof setInterval>;
    let pongTimeout: ReturnType<typeof setTimeout> | undefined;
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    let isUnmounted = false;
    let reconnectAttempt = 0;
    let openedOnce = false;
    let failedBeforeOpen = 0;

    /**
     * Acquires a WebSocket ticket (using `initialWsTicket` once for this `roomId`, then minting
     * new tickets via `fetchWsTicket`), opens the WebSocket, and wires message/close handlers.
     */
    const connect = async () => {
      if (isUnmounted) return;
      let ticket: string;
      const hasUnusedInitialTicket =
        Boolean(initialWsTicket) &&
        consumedInitialTicketRef.current?.roomId === roomId &&
        consumedInitialTicketRef.current?.ticket === initialWsTicket;
      if (hasUnusedInitialTicket && initialWsTicket) {
        consumedInitialTicketRef.current = { roomId, ticket: "" };
        ticket = initialWsTicket;
      } else if (initialWsTicket && consumedInitialTicketRef.current === null) {
        consumedInitialTicketRef.current = { roomId, ticket: "" };
        ticket = initialWsTicket;
      } else {
        try {
          ticket = await fetchWsTicket(roomId);
        } catch (err) {
          // Do not retry if the session token itself is expired/invalid.
          if (err instanceof Error && err.name === "AuthExpiredError") return;
          // The server cannot take us back into this room: re-matchmake instead of retrying it.
          if (err instanceof Error && err.name === "RoomUnavailableError" && onShardUnavailableRef.current) {
            onShardUnavailableRef.current();
            return;
          }
          if (!isUnmounted) {
            const expDelay = Math.min(MAX_RECONNECT_MS, BASE_RECONNECT_MS * 2 ** reconnectAttempt);
            const jitter = Math.floor(Math.random() * 400);
            reconnectAttempt += 1;
            reconnectTimer = setTimeout(() => void connect(), expDelay + jitter);
          }
          return;
        }
      }
      if (isUnmounted) return;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}/ws/${encodeURIComponent(roomId)}?ticket=${encodeURIComponent(ticket)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        openedOnce = true;
        failedBeforeOpen = 0;
        reconnectAttempt = 0;
        setSuperseded(false);
        setConnected(true);
        clearInterval(pingTimer);
        clearTimeout(pongTimeout);

        // Periodically send "ping" and close stalled sockets if no "pong" arrives within PONG_TIMEOUT_MS.
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send("ping");
            clearTimeout(pongTimeout);
            pongTimeout = setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) ws.close();
            }, PONG_TIMEOUT_MS);
          }
        }, PING_INTERVAL_MS);
      };

      ws.onmessage = (event) => {
        if (event.data === "pong") {
          clearTimeout(pongTimeout);
          return;
        }
        let msg: ServerMessage;
        try {
          msg = JSON.parse(event.data) as ServerMessage;
        } catch {
          // Ignore malformed JSON frames.
          return;
        }
        const posMap = positionsRef.current;

        switch (msg.type) {
          case "SYNC_STATE": {
            // Estimate clock offset so client turn countdowns align with server deadlines.
            setClockOffsetMs(msg.serverNow - Date.now());
            setSelfId(msg.selfId);
            posMap.clear();
            const nextRoster: Record<string, PlayerSnapshot> = {};
            for (const p of msg.players) {
              posMap.set(p.id, {
                id: p.id,
                username: p.username,
                x: p.x,
                y: p.y,
                targetX: p.x,
                targetY: p.y,
                currentZoneId: p.currentZoneId
              });
              nextRoster[p.id] = p;
            }
            setRoster(nextRoster);
            setBattle(msg.battle);
            setCombatLog(msg.battle ? [`Reconnected to battle in ${msg.battle.zoneId}!`] : []);
            setSynced(true);
            break;
          }

          case "SNAPSHOT": {
            // Update target coordinates for interpolation; newly joined players arrive via PLAYER_JOINED.
            for (const p of msg.players) {
              const entry = posMap.get(p.id);
              if (entry) {
                entry.targetX = p.x;
                entry.targetY = p.y;
                entry.currentZoneId = p.currentZoneId;
              }
            }
            break;
          }

          case "PLAYER_JOINED": {
            const p = msg.player;
            posMap.set(p.id, {
              id: p.id,
              username: p.username,
              x: p.x,
              y: p.y,
              targetX: p.x,
              targetY: p.y,
              currentZoneId: p.currentZoneId
            });
            setRoster((prev) => ({ ...prev, [p.id]: p }));
            break;
          }

          case "PLAYER_LEFT": {
            posMap.delete(msg.playerId);
            setRoster((prev) => {
              const copy = { ...prev };
              delete copy[msg.playerId];
              return copy;
            });
            break;
          }

          case "BATTLE_STARTED":
            setClockOffsetMs(msg.serverNow - Date.now());
            setBattle(msg.battle);
            setCombatLog([`Battle started in ${msg.battle.zoneId}!`]);
            clearTimeout(noticeTimer);
            setNotice(null);
            break;

          case "TURN_RESOLVED":
            setClockOffsetMs(msg.serverNow - Date.now());
            setBattle((prev) =>
              prev
                ? {
                    ...prev,
                    turnNumber: msg.turnNumber,
                    activeTurnPlayerId: msg.nextTurnPlayerId,
                    turnDeadlineAt: msg.turnDeadlineAt,
                    p1Timeouts: msg.p1Timeouts,
                    p2Timeouts: msg.p2Timeouts,
                    hpPercentByPlayerId: {
                      ...(prev.hpPercentByPlayerId ?? {}),
                      ...msg.hpPercentByPlayerId
                    }
                  }
                : null
            );
            setCombatLog((prev) => [...prev, msg.log]);
            break;

          case "BATTLE_START_FAILED":
            setNotice("Couldn't start the battle: player data is temporarily unavailable. Retrying...");
            clearTimeout(noticeTimer);
            noticeTimer = setTimeout(() => setNotice(null), 8_000);
            break;

          case "BATTLE_ENDED":
            setBattle(null);
            setCombatLog((prev) => [...prev, msg.log]);
            break;
        }
      };

      ws.onclose = (event) => {
        setConnected(false);
        setSynced(false);
        setSelfId(null);
        setBattle(null);
        clearInterval(pingTimer);
        clearTimeout(pongTimeout);
        if (isUnmounted) return;

        // Close code 4001 indicates the server closed this socket because a newer tab took over.
        if (event.code === 4001) {
          setSuperseded(true);
          return;
        }

        // If a connection never opened before closing, count toward shard failover threshold.
        if (!openedOnce) {
          failedBeforeOpen += 1;
          if (failedBeforeOpen >= MAX_CONSECUTIVE_FAILURES_BEFORE_REMATCH && onShardUnavailableRef.current) {
            failedBeforeOpen = 0;
            onShardUnavailableRef.current();
            return;
          }
        }

        const expDelay = Math.min(MAX_RECONNECT_MS, BASE_RECONNECT_MS * 2 ** reconnectAttempt);
        const jitter = Math.floor(Math.random() * 400);
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(() => void connect(), expDelay + jitter);
      };
    };

    void connect();
    return () => {
      isUnmounted = true;
      clearTimeout(reconnectTimer);
      clearInterval(pingTimer);
      clearTimeout(pongTimeout);
      clearTimeout(noticeTimer);
      setNotice(null);
      wsRef.current?.close();
      positionsRef.current.clear();
      setRoster({});
      setBattle(null);
      setCombatLog([]);
      setSynced(false);
      setSelfId(null);
    };
  }, [roomId, initialWsTicket, fetchWsTicket, reconnectNonce]);

  /**
   * Manually triggers a fresh connection attempt, clearing any superseded-tab banner.
   */
  const reconnectNow = useCallback(() => {
    setSuperseded(false);
    setReconnectNonce((n) => n + 1);
  }, []);

  /**
   * Sends a JSON-encoded client intent message only when the socket is open.
   */
  const sendMessage = useCallback((payload: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  /**
   * Emits a movement direction update (`dx`, `dy` in `{-1, 0, 1}`).
   */
  const sendWASD = useCallback(
    (dx: -1 | 0 | 1, dy: -1 | 0 | 1) => sendMessage({ type: "WASD", dx, dy }),
    [sendMessage]
  );

  /**
   * Emits a turn-based battle action (`ATTACK`, `HEAL`, or `FLEE`) for a specific battle and turn.
   */
  const sendBattleAction = useCallback(
    (battleId: string, turnNumber: number, action: BattleAction) =>
      sendMessage({ type: "BATTLE_ACTION", battleId, turnNumber, action }),
    [sendMessage]
  );

  return {
    connected,
    synced,
    selfId,
    superseded,
    clockOffsetMs,
    positionsRef,
    roster,
    battle,
    combatLog,
    notice,
    sendWASD,
    sendBattleAction,
    reconnectNow
  };
}
