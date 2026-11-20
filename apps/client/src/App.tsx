/**
 * Top-level client application shell for BHVR Edge RPG.
 * Coordinates:
 *  1. Google Identity Services sign-in and exchange of Google ID tokens for minimal session tokens.
 *  2. Session persistence in `sessionStorage` and background `/api/me` session verification.
 *  3. Regional shard matchmaking (/api/join) with resume support, epoch guarding, and in-flight deduplication.
 *  4. WebSocket room connection (useGameRoom), PixiJS overworld canvas (GameCanvas), and turn-based combat UI (BattleModal).
 */
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { useGameRoom } from "./hooks/useGameRoom";
// Loaded on demand so the sign-in screen does not download PixiJS until a player is in a room.
const GameCanvas = lazy(() => import("./components/GameCanvas").then((m) => ({ default: m.GameCanvas })));
import { BattleModal } from "./components/BattleModal";
import { BattleResultModal } from "./components/BattleResultModal";
import {
  createApiClient,
  publicApiClient,
  readApiError,
  type JoinRoomSuccess
} from "./api/client";

type RoomSession = JoinRoomSuccess;

/**
 * Sentinel error thrown when an authenticated API call receives HTTP 401,
 * allowing callers (such as `useGameRoom` ticket fetches) to distinguish expired sessions
 * from transient network or shard errors and stop background reconnect retries.
 */
class AuthExpiredError extends Error {
  constructor(message = "Session expired. Please sign in with Google again.") {
    super(message);
    this.name = "AuthExpiredError";
  }
}

/**
 * Thrown when the server cannot issue a ticket for the exact room requested, so reconnecting to it
 * is pointless and the client should re-run `/api/join` instead of retrying the same room.
 */
class RoomUnavailableError extends Error {
  constructor(message = "Room unavailable") {
    super(message);
    this.name = "RoomUnavailableError";
  }
}

/**
 * Minimal client-side session container. User identity and profile stats remain
 * server-authoritative and are retrieved via `/api/me` or WebSocket `SYNC_STATE`.
 */
type AuthSession = {
  token: string;
};

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential?: string }) => void;
            auto_select?: boolean;
            cancel_on_tap_outside?: boolean;
          }) => void;
          prompt: (
            onMoment?: (n: {
              isNotDisplayed: () => boolean;
              isSkippedMoment: () => boolean;
              isDismissedMoment: () => boolean;
            }) => void
          ) => void;
          cancel: () => void;
          renderButton: (
            parent: HTMLElement,
            options: { theme?: "outline" | "filled_blue" | "filled_black"; size?: "large" | "medium" | "small" }
          ) => void;
        };
      };
    };
  }
}

// Public Google OAuth client ID injected at build time by Vite.
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

const GSI_SCRIPT_ID = "google-gsi-script";
// How long to wait for Google to hand back a credential without any user interaction.
const SILENT_REAUTH_TIMEOUT_MS = 8000;

/** Loads Google Identity Services once; resolves when `window.google.accounts.id` is usable. */
function loadGsi(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.getElementById(GSI_SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("Could not load Google sign-in")), { once: true });
    if (!existing) {
      script.id = GSI_SCRIPT_ID;
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });
}

/** Reads the `sub` claim of a session token. Only used to compare identities, never to trust one. */
function sessionTokenSubject(token: string): string | null {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const sub = (JSON.parse(atob(payload)) as { sub?: unknown }).sub;
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}

/**
 * Asks Google for a credential without showing a sign-in screen (One Tap with auto-select, which
 * succeeds when the player is still signed in to Google and previously approved this app).
 * Resolves to null if Google shows nothing, the player dismisses it, or it takes too long.
 */
function requestSilentGoogleCredential(): Promise<string | null> {
  return new Promise((resolve) => {
    const gsi = window.google?.accounts?.id;
    if (!gsi || !GOOGLE_CLIENT_ID) {
      resolve(null);
      return;
    }
    const timer = window.setTimeout(() => {
      gsi.cancel();
      resolve(null);
    }, SILENT_REAUTH_TIMEOUT_MS);
    const finish = (credential: string | null) => {
      window.clearTimeout(timer);
      resolve(credential);
    };
    gsi.initialize({
      client_id: GOOGLE_CLIENT_ID,
      auto_select: true,
      cancel_on_tap_outside: false,
      callback: (resp) => finish(resp.credential ?? null)
    });
    gsi.prompt((moment) => {
      if (moment.isNotDisplayed() || moment.isSkippedMoment()) finish(null);
    });
  });
}

export default function App() {
  // Hydrate persisted session token from sessionStorage on initial mount.
  const [auth, setAuth] = useState<AuthSession | null>(() => {
    const saved = sessionStorage.getItem("rpg_auth");
    if (!saved) return null;
    try {
      return JSON.parse(saved) as AuthSession;
    } catch {
      // Discard malformed sessionStorage entry so corrupt data cannot break startup.
      sessionStorage.removeItem("rpg_auth");
      return null;
    }
  });
  const [session, setSession] = useState<RoomSession | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const googleBtnRef = useRef<HTMLDivElement | null>(null);
  // Monotonic epoch counter used to ignore async join completions from superseded/expired sessions.
  const joinEpochRef = useRef(0);
  // Current session, readable from callbacks without making them depend on the token. A silent
  // renewal swaps the token here, so a running connection and its reconnect loop keep their identity.
  const authRef = useRef<AuthSession | null>(auth);
  const refreshInFlightRef = useRef<Promise<boolean> | null>(null);

  /**
   * Clears stored credentials, last-joined room hint, and active React auth/room state,
   * while advancing `joinEpochRef` to invalidate any in-flight asynchronous join requests.
   */
  const clearExpiredSession = useCallback((keepRoomHint = false) => {
    joinEpochRef.current += 1;
    authRef.current = null;
    sessionStorage.removeItem("rpg_auth");
    if (!keepRoomHint) sessionStorage.removeItem("rpg_last_room");
    setAuth(null);
    setSession(null);
  }, []);

  /**
   * Handles an unrecoverable HTTP 401 by clearing the session and asking for a manual sign-in.
   * The last-room hint is kept so signing back in resumes the same shard (and any battle in it).
   */
  const handleAuthExpired = useCallback(() => {
    clearExpiredSession(true);
    setJoinError("Session expired. Please sign in with Google again.");
  }, [clearExpiredSession]);

  /**
   * Tries to renew an expired session without the player doing anything, by asking Google for a
   * credential silently and exchanging it for a new session token. Concurrent callers share one
   * attempt. Returns false when it cannot (the caller then asks the player to sign in), including when
   * Google would sign in as a different account or the player signed out while it was running.
   */
  const refreshSession = useCallback((): Promise<boolean> => {
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    const epoch = joinEpochRef.current;
    const previousSubject = authRef.current ? sessionTokenSubject(authRef.current.token) : null;
    const attempt = (async () => {
      try {
        await loadGsi();
        const credential = await requestSilentGoogleCredential();
        if (!credential || joinEpochRef.current !== epoch) return false;
        const res = await publicApiClient.api.auth.google.$post({ json: { idToken: credential } });
        if (!res.ok || joinEpochRef.current !== epoch) return false;
        const { token } = await res.json();
        // Never swap the account of a running game; a different Google account must sign in explicitly.
        if (previousSubject && sessionTokenSubject(token) !== previousSubject) return false;
        const nextAuth: AuthSession = { token };
        authRef.current = nextAuth;
        sessionStorage.setItem("rpg_auth", JSON.stringify(nextAuth));
        setAuth(nextAuth);
        return true;
      } catch {
        return false;
      }
    })().finally(() => {
      refreshInFlightRef.current = null;
    });
    refreshInFlightRef.current = attempt;
    return attempt;
  }, []);

  /**
   * Runs an authenticated request with the current session token. On a 401 it first tries a silent
   * re-authentication and repeats the request once; only if that fails does it end the session.
   * A 401 never reaches the caller: it has already been handled and surfaces as AuthExpiredError.
   */
  const authedRequest = useCallback(
    async (send: (token: string) => Promise<Response>): Promise<Response> => {
      const token = authRef.current?.token;
      if (!token) throw new AuthExpiredError();
      const first = await send(token);
      if (first.status !== 401) return first;
      if (await refreshSession()) {
        const renewed = authRef.current?.token;
        if (renewed) {
          const second = await send(renewed);
          if (second.status !== 401) return second;
        }
      }
      handleAuthExpired();
      throw new AuthExpiredError();
    },
    [refreshSession, handleAuthExpired]
  );

  /**
   * Exchanges a Google credential JWT with `/api/auth/google` for a server-signed session token
   * and persists it in `sessionStorage` for the current browser tab.
   */
  const handleGoogleCredential = useCallback(async (idToken: string) => {
    setJoinError(null);
    const res = await publicApiClient.api.auth.google.$post({
      json: { idToken }
    });
    if (!res.ok) {
      throw new Error(await readApiError(res, "Google sign-in failed"));
    }
    const data = await res.json();
    const nextAuth: AuthSession = {
      token: data.token
    };
    authRef.current = nextAuth;
    sessionStorage.setItem("rpg_auth", JSON.stringify(nextAuth));
    setAuth(nextAuth);
  }, []);

  /**
   * Lazily loads Google Identity Services (`gsi/client`) when unauthenticated and renders
   * the sign-in button into `googleBtnRef`.
   */
  useEffect(() => {
    if (auth || !GOOGLE_CLIENT_ID) return;
    let cancelled = false;

    loadGsi()
      .then(() => {
        if (cancelled || !googleBtnRef.current || !window.google?.accounts?.id) return;
        googleBtnRef.current.innerHTML = "";
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: (resp) => {
            if (!resp.credential) {
              setJoinError("Missing Google credential");
              return;
            }
            handleGoogleCredential(resp.credential).catch((err: Error) => {
              setJoinError(err.message);
            });
          }
        });
        window.google.accounts.id.renderButton(googleBtnRef.current, {
          theme: "filled_blue",
          size: "large"
        });
      })
      .catch((err: Error) => {
        if (!cancelled) setJoinError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [auth, handleGoogleCredential]);

  /**
   * Signs the user out explicitly and clears any displayed matchmaking or auth error.
   */
  const signOut = useCallback(() => {
    clearExpiredSession(false);
    setJoinError(null);
  }, [clearExpiredSession]);

  /**
   * Requests a regional shard assignment and one-time WebSocket ticket from `/api/join`,
   * passing any previously visited `rpg_last_room` so the server can resume an active player/battle.
   */
  const requestRoom = useCallback(
    async (): Promise<RoomSession> => {
      const resumeRoomId = sessionStorage.getItem("rpg_last_room");
      const res = await authedRequest((token) =>
        createApiClient(token).api.join.$post({ json: resumeRoomId ? { resumeRoomId } : {} })
      );
      if (!res.ok) {
        throw new Error(await readApiError(res, "Failed to join room"));
      }
      const next = await res.json();
      sessionStorage.setItem("rpg_last_room", next.roomId);
      return next;
    },
    [authedRequest]
  );

  /**
   * Mints a fresh short-lived WebSocket ticket for `targetRoomId` when reconnecting
   * after the initial one-shot ticket has already been used.
   */
  const fetchWsTicket = useCallback(
    async (targetRoomId: string): Promise<string> => {
      const res = await authedRequest((token) =>
        createApiClient(token).api["ws-ticket"].$post({ json: { roomId: targetRoomId } })
      );
      // 409: the server will not take us back into this exact room (e.g. full); re-matchmake.
      // 503 is treated as transient and retried with the normal reconnect backoff.
      if (res.status === 409) {
        throw new RoomUnavailableError(await readApiError(res, "Room unavailable"));
      }
      if (!res.ok) {
        throw new Error(await readApiError(res, "Failed to mint WebSocket ticket"));
      }
      const data = await res.json();
      // A ticket is bound to one room; never use one minted for a different shard.
      if (data.roomId !== targetRoomId) {
        throw new RoomUnavailableError("Server returned a ticket for a different room");
      }
      return data.wsTicket;
    },
    [authedRequest]
  );

  /**
   * Validates the stored session token against `/api/me` on mount or token change.
   * Only forces sign-out on explicit 401; transient errors keep the current session intact.
   */
  const signedIn = auth !== null;
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;

    authedRequest((token) => createApiClient(token).api.me.$get())
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        await res.json();
      })
      .catch(() => {
        // Expiry is handled inside authedRequest; keep the session on any transient failure.
      });

    return () => {
      cancelled = true;
    };
  }, [signedIn, authedRequest]);

  // Shares a single in-flight /api/join promise across retry effects and shard failovers.
  const inFlightJoinRef = useRef<Promise<RoomSession> | null>(null);

  /**
   * Executes or joins an in-flight `/api/join` request while enforcing cancellation
   * and epoch checks so stale responses never overwrite newer session state.
   */
  const runJoinRequest = useCallback(
    (epoch: number, isCancelled?: () => boolean) => {
      const task = (inFlightJoinRef.current ?? requestRoom()).finally(() => {
        if (inFlightJoinRef.current === task) {
          inFlightJoinRef.current = null;
        }
      });
      inFlightJoinRef.current = task;

      task
        .then((nextRoom) => {
          if (isCancelled?.() || joinEpochRef.current !== epoch) return;
          setJoinError(null);
          setSession(nextRoom);
        })
        .catch((err: Error) => {
          if (isCancelled?.() || joinEpochRef.current !== epoch) return;
          setJoinError(err.message);
        });
    },
    [requestRoom]
  );

  // Automatically join a regional shard once authenticated or when the user clicks Retry World Join.
  useEffect(() => {
    if (!signedIn) {
      inFlightJoinRef.current = null;
      return;
    }
    let cancelled = false;
    const epoch = joinEpochRef.current;
    runJoinRequest(epoch, () => cancelled);

    return () => {
      cancelled = true;
    };
  }, [signedIn, runJoinRequest, retryNonce]);

  /**
   * Triggered by `useGameRoom` when repeated initial WebSocket connection attempts fail,
   * clearing the cached `rpg_last_room` hint and re-running shard selection.
   */
  const handleShardUnavailable = useCallback(() => {
    if (!signedIn) return;
    const epoch = ++joinEpochRef.current;
    sessionStorage.removeItem("rpg_last_room");
    runJoinRequest(epoch);
  }, [signedIn, runJoinRequest]);

  // Connect to the assigned GameRoom Durable Object and subscribe to live world/combat updates.
  const {
    connected,
    synced,
    selfId,
    superseded,
    clockOffsetMs,
    positionsRef,
    roster,
    battle,
    battleResult,
    dismissBattleResult,
    combatLog,
    notice,
    sendWASD,
    sendBattleAction,
    reconnectNow
  } = useGameRoom(
    session?.roomId ?? null,
    session?.wsTicket ?? null,
    signedIn ? fetchWsTicket : null,
    handleShardUnavailable
  );

  // The player id the canvas is drawn for. `selfId` is cleared whenever the socket drops, but the canvas
  // must stay mounted across a reconnect (rebuilding the whole Pixi scene causes a blank flash), so keep
  // the last known id until the user signs out.
  const [canvasPlayerId, setCanvasPlayerId] = useState<string | null>(null);
  useEffect(() => {
    if (selfId) setCanvasPlayerId(selfId);
  }, [selfId]);
  useEffect(() => {
    if (!auth) setCanvasPlayerId(null);
  }, [auth]);

  // Render error screen with retry and sign-out controls if auth or shard join fails.
  if (joinError) {
    return (
      <main className="w-full h-screen bg-slate-950 text-rose-400 flex flex-col items-center justify-center gap-3">
        <div>Authentication / Matchmaking error: {joinError}</div>
        <div className="flex items-center gap-2">
          {auth && (
            <button
              onClick={() => {
                setJoinError(null);
                setRetryNonce((n) => n + 1);
              }}
              className="px-4 py-2 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-sm cursor-pointer"
            >
              Retry World Join
            </button>
          )}
          <button
            // Without a session this is only dismissing an expiry notice, so the resume hint stays.
            onClick={auth ? signOut : () => setJoinError(null)}
            className="px-4 py-2 rounded bg-slate-800 text-white text-sm border border-slate-600 cursor-pointer"
          >
            Back to Google Sign-In
          </button>
        </div>
      </main>
    );
  }

  // Render Google Sign-In screen when no session token is present.
  if (!auth) {
    return (
      <main className="w-full h-screen bg-slate-950 text-white flex flex-col items-center justify-center gap-4">
        <h1 className="text-2xl font-bold text-amber-400">BHVR Edge RPG</h1>
        <p className="text-sm text-slate-300">Sign in with your Google account to enter the world.</p>
        {!GOOGLE_CLIENT_ID ? (
          <div className="text-rose-400 text-sm">Missing VITE_GOOGLE_CLIENT_ID</div>
        ) : (
          <div ref={googleBtnRef} />
        )}
      </main>
    );
  }

  // Render matchmaking loading state while awaiting /api/join shard assignment.
  if (!session) {
    return (
      <main className="w-full h-screen bg-slate-950 text-white flex items-center justify-center">
        Finding regional world...
      </main>
    );
  }

  return (
    <main className="relative w-full h-screen bg-slate-950 select-none">
      {/* Top-left HUD overlay showing socket connection status, active player label, shard ID, and session actions */}
      <div className="absolute top-4 left-4 z-10 bg-slate-900/80 text-white px-3 py-2 rounded-lg text-xs border border-slate-700">
        <div>
          Status:{" "}
          {connected ? "🟢 Connected" : superseded ? "🟡 Active in another tab" : "🔴 Reconnecting..."}
        </div>
        {(() => {
          const liveSelf = connected && synced && selfId ? roster[selfId] : undefined;
          const activeUsername = liveSelf?.username ?? (synced ? selfId ?? "Player" : "Syncing...");
          return (
            <>
              <div>You: {activeUsername}</div>
              <div className="text-sky-300">Shard: {session.roomId}</div>
              <div className="text-slate-400 mt-1">Use WASD to walk into a yellow building with another player</div>
              {notice && (
                <div role="status" className="mt-1 text-amber-300">
                  {notice}
                </div>
              )}
              <div className="mt-2 flex items-center gap-2">
                {superseded && (
                  <button
                    onClick={reconnectNow}
                    className="px-2 py-1 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold cursor-pointer"
                  >
                    Reconnect Here
                  </button>
                )}
                <button
                  onClick={signOut}
                  className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-600 cursor-pointer"
                >
                  Sign out
                </button>
              </div>
            </>
          );
        })()}
      </div>

      {/* Interactive PixiJS 2D overworld canvas; movement input locks while disconnected, unsynced, or in combat */}
      {canvasPlayerId && (
        <Suspense fallback={<div className="w-full h-screen" />}>
          <GameCanvas
            myId={canvasPlayerId}
            positionsRef={positionsRef}
            movementLocked={!connected || !synced || Boolean(battle) || Boolean(battleResult)}
            sendWASD={sendWASD}
          />
        </Suspense>
      )}

      {/* Turn-based encounter modal displayed whenever the player is participating in an active battle */}
      {battle && selfId && (
        <BattleModal
          myId={selfId}
          connected={connected}
          battle={battle}
          clockOffsetMs={clockOffsetMs}
          roster={roster}
          combatLog={combatLog}
          onAction={sendBattleAction}
        />
      )}

      {/* Outcome of the last battle (winner, final log line, reward), shown until dismissed */}
      {!battle && battleResult && canvasPlayerId && (
        <BattleResultModal
          myId={canvasPlayerId}
          result={battleResult}
          roster={roster}
          onClose={dismissBattleResult}
        />
      )}
    </main>
  );
}
