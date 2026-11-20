/**
 * React wrapper component managing the lifetime of `GameSceneController` and its underlying
 * PixiJS canvas. Bridges React props (`movementLocked`, `myId`, `positionsRef`, `sendWASD`)
 * into the imperative rendering/input loop without triggering React re-renders per frame.
 */
import { useEffect, useRef } from "react";
import type { EntityPos } from "../hooks/useGameRoom";
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
    void controller.init();

    return () => {
      controllerRef.current = null;
      controller.destroy();
    };
  }, [myId, positionsRef, sendWASD]);

  return <div ref={hostRef} className="w-full h-screen overflow-hidden" />;
}
