/**
 * Turn-based combat modal rendered while the local player is in an active encounter (`battle`).
 * Displays encounter zone, server-clock-synchronized turn countdown, combatant turn status and
 * server-computed HP percentages, scrollable battle log, and action buttons (ATTACK, HEAL, FLEE).
 */
import { useEffect, useRef, useState } from "react";
import type { BattleState, PlayerSnapshot, BattleAction } from "shared/protocol";

type Props = {
  myId: string;
  connected: boolean;
  battle: BattleState;
  clockOffsetMs: number;
  roster: Record<string, PlayerSnapshot>;
  combatLog: string[];
  onAction: (battleId: string, turnNumber: number, action: BattleAction) => void;
};

export function BattleModal({ myId, connected, battle, clockOffsetMs, roster, combatLog, onAction }: Props) {
  // Look up both battle participants in the synced room roster for display names.
  const p1 = roster[battle.player1Id];
  const p2 = roster[battle.player2Id];
  const isMyTurn = battle.activeTurnPlayerId === myId;
  // Composite key uniquely identifying the current battle and turn number to prevent duplicate submissions.
  const turnKey = `${battle.id}:${battle.turnNumber}`;
  const [submittedTurnKey, setSubmittedTurnKey] = useState<string | null>(null);
  const canAct = connected && isMyTurn && submittedTurnKey !== turnKey;
  const logEndRef = useRef<HTMLDivElement | null>(null);

  // Initialize remaining turn seconds using clockOffsetMs to align client time with serverNow.
  const [secondsLeft, setSecondsLeft] = useState<number>(() =>
    Math.max(0, Math.ceil((battle.turnDeadlineAt - (Date.now() + clockOffsetMs)) / 1000))
  );

  // Poll remaining turn time every 250ms so the countdown ticks smoothly without drifting on local clock skew.
  useEffect(() => {
    const updateRemaining = () => {
      const serverNow = Date.now() + clockOffsetMs;
      const remainingMs = Math.max(0, battle.turnDeadlineAt - serverNow);
      setSecondsLeft(Math.ceil(remainingMs / 1000));
    };

    updateRemaining();
    const interval = setInterval(updateRemaining, 250);
    return () => clearInterval(interval);
  }, [battle.id, battle.turnNumber, battle.turnDeadlineAt, clockOffsetMs]);

  // Automatically scroll the combat log to the newest entry whenever new lines arrive.
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [combatLog.length]);

  return (
    <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50">
      <div className="bg-slate-900 border border-amber-400/50 rounded-xl p-6 w-full max-w-md text-white shadow-2xl">
        {/* Encounter header with building/zone title and urgent countdown badge */}
        <div className="flex items-center justify-between gap-2 mb-4">
          <h2 className="text-xl font-bold text-amber-400">
            Encounter in {battle.zoneId.toUpperCase()}
          </h2>
          <span
            className={`px-2.5 py-1 rounded text-xs font-mono font-bold border ${
              secondsLeft <= 3
                ? "bg-rose-950/80 text-rose-300 border-rose-500/60"
                : "bg-slate-800 text-amber-300 border-amber-400/40"
            }`}
          >
            {secondsLeft}s
          </span>
        </div>

        {/* Participant cards showing username, current turn state, and server-computed HP percentage */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          {[p1, p2].map((p) => {
            if (!p) return null;
            const hpPct = battle.hpPercentByPlayerId?.[p.id];
            return (
              <div key={p.id} className="bg-slate-800 p-3 rounded-lg">
                <div className="font-semibold">{p.username}</div>
                <div className="text-xs text-slate-400 mt-0.5">
                  {battle.activeTurnPlayerId === p.id ? "Active turn" : "Waiting"}
                </div>
                {typeof hpPct === "number" && (
                  <div className="text-xs text-emerald-400 font-mono mt-1">
                    HP: {hpPct}%
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Chronological turn-by-turn combat log */}
        <div className="bg-slate-950 rounded p-3 h-28 overflow-y-auto text-xs space-y-1 mb-4 font-mono text-slate-300">
          {combatLog.map((line, i) => (
            <div key={i}>&gt; {line}</div>
          ))}
          <div ref={logEndRef} />
        </div>

        {/* Prompt indicating whether local player action is currently awaited */}
        <div className="text-sm mb-3 text-center font-medium">
          {isMyTurn ? (
            <span className="text-sky-400">Your Turn ({secondsLeft}s) — Choose an action:</span>
          ) : (
            <span className="text-slate-400">Waiting for opponent ({secondsLeft}s)...</span>
          )}
        </div>

        {/* Combat action buttons; disabled once an action is submitted for the active turn or when not my turn */}
        <div className="grid grid-cols-3 gap-2">
          {(["ATTACK", "HEAL", "FLEE"] as BattleAction[]).map((action) => (
            <button
              key={action}
              disabled={!canAct}
              onClick={() => {
                setSubmittedTurnKey(turnKey);
                onAction(battle.id, battle.turnNumber, action);
              }}
              className="py-2 px-3 rounded bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-slate-950 font-bold text-sm cursor-pointer"
            >
              {action}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
