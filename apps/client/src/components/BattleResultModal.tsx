/**
 * Result screen shown after a battle ends: who won, the final log line and what the winner earned.
 * Stays up until the player dismisses it, so the outcome is never missed.
 */
import { useEffect, useRef } from "react";
import type { PlayerSnapshot } from "shared/protocol";
import type { BattleResult } from "../hooks/useGameRoom";

type Props = {
  myId: string;
  result: BattleResult;
  roster: Record<string, PlayerSnapshot>;
  onClose: () => void;
};

export function BattleResultModal({ myId, result, roster, onClose }: Props) {
  const won = result.winnerId === myId;
  const opponentId = result.participantIds.find((id) => id !== myId);
  const opponentName = (opponentId && roster[opponentId]?.username) || "your opponent";
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // Move focus into the dialog so keyboard players can dismiss it with Enter or Space, and Escape closes it.
  useEffect(() => {
    buttonRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="battle-result-title"
        className={`bg-slate-900 border rounded-xl p-6 w-full max-w-md text-white shadow-2xl text-center ${
          won ? "border-emerald-400/60" : "border-rose-400/50"
        }`}
      >
        <h2 id="battle-result-title" className={`text-2xl font-bold ${won ? "text-emerald-400" : "text-rose-400"}`}>
          {won ? "Victory!" : "Defeat"}
        </h2>
        <p className="mt-1 text-sm text-slate-400">{won ? `You beat ${opponentName}.` : `${opponentName} won this one.`}</p>

        <p className="mt-4 text-sm font-mono text-slate-300">&gt; {result.log}</p>

        {won && result.reward && (
          <p className="mt-4 text-amber-300 font-semibold">
            +{result.reward.xp} XP &nbsp;·&nbsp; +{result.reward.gold} gold
          </p>
        )}

        <button
          ref={buttonRef}
          onClick={onClose}
          className="mt-6 py-2 px-6 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm cursor-pointer"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
