/**
 * React wrapper component managing the lifetime of `GameSceneController` and its underlying
 * PixiJS canvas. Bridges React props (`movementLocked`, `myId`, `positionsRef`, `sendWASD`)
 * into the imperative rendering/input loop without triggering React re-renders per frame.
 */
import { useEffect, useRef, useState } from "react";
import type { EntityPos } from "../hooks/useGameRoom";
import { ErrorPanel } from "./ErrorPanel";
import { GameSceneController } from "./GameSceneController";

type Props = {
  myId: string;
  positionsRef: React.MutableRefObject<Map<string, EntityPos>>;
  movementLocked: boolean;
  sendWASD: (dx: -1 | 0 | 1, dy: -1 | 0 | 1) => void;
};

export function GameCanvas({ myId, positionsRef, movementLocked, sendWASD }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<GameSceneController | null>(null);
  // Set when the graphics could not start (no WebGL, blocked GPU, ...); `attempt` restarts them.
  const [initError, setInitError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Keep latest movementLocked value in a ref so the imperative scene callback can read it synchronously.
  const movementLockedRef = useRef(movementLocked);
  movementLockedRef.current = movementLocked;

  // Forward lock state changes (e.g., entering battle or losing socket sync) to clear active keys.
  useEffect(() => {
    controllerRef.current?.setMovementLocked(movementLocked);
  }, [movementLocked]);

  // Instantiate and initialize the PixiJS scene once per (myId, positionsRef, sendWASD) binding,
  // and cleanly destroy all GPU/DOM resources on unmount.
  useEffect(() => {
    if (!hostRef.current) return;
    const controller = new GameSceneController(
      hostRef.current,
      myId,
      positionsRef.current,
      () => movementLockedRef.current,
      sendWASD
    );
    controllerRef.current = controller;
    let cancelled = false;
    controller.init().catch((err: unknown) => {
      // `init` is async, so React's error boundaries cannot see it; show the failure ourselves.
      console.error("Game graphics failed to start:", err);
      if (!cancelled) setInitError(err instanceof Error ? err : new Error(String(err)));
    });

    return () => {
      cancelled = true;
      controllerRef.current = null;
      controller.destroy();
    };
  }, [myId, positionsRef, sendWASD, attempt]);

  if (initError) {
    return (
      <ErrorPanel
        title="The game view could not start"
        message="Your browser could not start the game graphics. Try again, or reload the page. If it keeps happening, check that hardware acceleration is turned on in your browser settings."
        detail={initError.stack ?? initError.message}
        onRetry={() => {
          setInitError(null);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }

  return <div ref={hostRef} className="w-full h-screen overflow-hidden" />;
}
