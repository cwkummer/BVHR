/**
 * Pure PvP encounter matching for building zones, unit-tested in `game-core.test.ts`.
 *
 * A pair fights when both players are standing in the same zone, outside battle and past their
 * post-battle immunity, and at least one of them is "armed". A player becomes armed by entering a
 * zone and is disarmed when a battle ends, so finished opponents idling together do not rematch
 * forever, while a newcomer (or someone whose immunity just expired) still triggers a fight.
 */
export type EncounterCandidate = {
  id: string;
  currentZoneId: string | null;
  battleId: string | null;
  battleCooldownUntil: number;
  zoneArmed: boolean;
};

export type EncounterPair<T extends EncounterCandidate> = { zoneId: string; first: T; second: T };

/**
 * Returns disjoint pairs to start battles for. The armed player always takes the first turn.
 */
export function pickEncounterPairs<T extends EncounterCandidate>(
  players: Iterable<T>,
  now: number
): EncounterPair<T>[] {
  const byZone = new Map<string, T[]>();
  for (const p of players) {
    if (!p.currentZoneId || p.battleId || now < p.battleCooldownUntil) continue;
    const list = byZone.get(p.currentZoneId);
    if (list) list.push(p);
    else byZone.set(p.currentZoneId, [p]);
  }

  const pairs: EncounterPair<T>[] = [];
  for (const [zoneId, occupants] of byZone) {
    const remaining = [...occupants];
    while (remaining.length >= 2) {
      const firstIdx = remaining.findIndex((p) => p.zoneArmed);
      if (firstIdx === -1) break;
      const [first] = remaining.splice(firstIdx, 1);
      const [second] = remaining.splice(0, 1);
      pairs.push({ zoneId, first, second });
    }
  }
  return pairs;
}
