/**
 * Pure turn resolution for the two-player battle: given the current combatants and an action, decides
 * the outcome and next battle counters without touching storage or sockets.
 */
import type { BattleAction } from "shared/protocol";
import { TURN_TIMEOUT_MS, computeBasicAttackDamage, computeHealedHp, shouldForfeitOnTimeout } from "../combat";

export type TurnActor = { id: string; username: string; attack: number; hp: number; maxHp: number };
export type TurnOpponent = { id: string; defense: number; hp: number };
export type TurnBattle = { player1Id: string; turnNumber: number; p1Timeouts: number; p2Timeouts: number };

export type TurnOutcome =
  | { ended: true; winnerId: string; log: string }
  | {
      ended: false;
      actorHp: number;
      opponentHp: number;
      log: string;
      nextTurnNumber: number;
      p1Timeouts: number;
      p2Timeouts: number;
      turnDeadlineAt: number;
    };

/**
 * Resolves one `ATTACK`, `HEAL` or `FLEE` (or the automatic action for a timed-out turn).
 * The battle ends when the defender reaches 0 HP (the attacker wins) or the actor flees (the opponent
 * wins). Otherwise the turn passes to the opponent: a player's timeout counter increments only on their
 * own timed-out turns and resets whenever they act themselves.
 */
export function resolveTurn(args: {
  actor: TurnActor;
  opponent: TurnOpponent;
  battle: TurnBattle;
  action: BattleAction;
  isTimeout: boolean;
  now: number;
}): TurnOutcome {
  const { actor, opponent, battle, action, isTimeout, now } = args;

  let log: string;
  let actorHp = actor.hp;
  let opponentHp = opponent.hp;

  if (action === "ATTACK") {
    const dmg = computeBasicAttackDamage(actor.attack, opponent.defense);
    opponentHp = Math.max(0, opponent.hp - dmg);
    log = isTimeout
      ? `${actor.username} timed out and used a basic attack for ${dmg} DMG!`
      : `${actor.username} strikes for ${dmg} DMG!`;
  } else if (action === "HEAL") {
    actorHp = computeHealedHp(actor.hp, actor.maxHp);
    log = `${actor.username} recovers 20 HP!`;
  } else {
    log = isTimeout
      ? `${actor.username} missed 2 turns while disconnected and fled!`
      : `${actor.username} fled the battle!`;
  }

  if (opponentHp === 0 || action === "FLEE") {
    return { ended: true, winnerId: action === "FLEE" ? opponent.id : actor.id, log };
  }

  const isActorP1 = battle.player1Id === actor.id;
  return {
    ended: false,
    actorHp,
    opponentHp,
    log,
    nextTurnNumber: battle.turnNumber + 1,
    p1Timeouts: isActorP1 ? (isTimeout ? battle.p1Timeouts + 1 : 0) : battle.p1Timeouts,
    p2Timeouts: !isActorP1 ? (isTimeout ? battle.p2Timeouts + 1 : 0) : battle.p2Timeouts,
    turnDeadlineAt: now + TURN_TIMEOUT_MS
  };
}

/**
 * The automatic action for a player whose turn timed out: forfeit after a second consecutive timeout
 * while disconnected, otherwise a basic attack.
 */
export function timeoutAction(prevTimeouts: number, hasOpenSocket: boolean): "FLEE" | "ATTACK" {
  return shouldForfeitOnTimeout(prevTimeouts, hasOpenSocket) ? "FLEE" : "ATTACK";
}
