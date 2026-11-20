/**
 * Rebuilds a room's in-memory state from its SQLite after a restart or hibernation wake-up.
 */
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { eq } from "drizzle-orm";
import { battles, players } from "../db/do-schema";
import { createLivePlayer, type LivePlayer } from "./live-player";

/**
 * Removes active battles whose participants no longer exist, clears dangling battle references (restoring
 * full HP), deletes idle players with no open socket, and returns the survivors as live players.
 * All writes happen in a single transaction.
 */
export function recoverRoomState(
  db: DrizzleSqliteDODatabase,
  storage: DurableObjectStorage,
  openPlayerIds: Set<string>,
  now: number
): Map<string, LivePlayer> {
  const live = new Map<string, LivePlayer>();
  const playerRows = db.select().from(players).all();
  const persistedPlayerIds = new Set(playerRows.map((p) => p.id));
  const activeBattles = db.select().from(battles).where(eq(battles.status, "ACTIVE")).all();

  storage.transactionSync(() => {
    const validBattleIds = new Set<string>();
    for (const b of activeBattles) {
      if (persistedPlayerIds.has(b.player1Id) && persistedPlayerIds.has(b.player2Id)) {
        validBattleIds.add(b.id);
      } else {
        db.delete(battles).where(eq(battles.id, b.id)).run();
      }
    }

    for (const p of playerRows) {
      let battleId = p.battleId;
      let hp = p.hp;

      if (battleId && !validBattleIds.has(battleId)) {
        battleId = null;
        hp = p.maxHp;
        db.update(players).set({ battleId: null, hp }).where(eq(players.id, p.id)).run();
      }

      if (!battleId && !openPlayerIds.has(p.id)) {
        db.delete(players).where(eq(players.id, p.id)).run();
        continue;
      }

      live.set(p.id, createLivePlayer({ ...p, battleId, hp }, now));
    }
  });

  return live;
}

/**
 * Ends a battle for the given participants in memory and in SQLite: clears the battle reference,
 * restores full HP, grants post-battle immunity and disarms them. Call inside the caller's
 * `transactionSync` so it commits together with the battle row deletion and any reward.
 */
export function resetParticipantsAfterBattle(
  db: DrizzleSqliteDODatabase,
  participants: LivePlayer[],
  cooldownUntil: number
): void {
  for (const p of participants) {
    p.battleId = null;
    p.hp = p.maxHp;
    p.battleCooldownUntil = cooldownUntil;
    p.zoneArmed = false;
    db.update(players)
      .set({ battleId: null, hp: p.maxHp, battleCooldownUntil: cooldownUntil })
      .where(eq(players.id, p.id))
      .run();
  }
}
