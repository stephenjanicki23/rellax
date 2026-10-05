/**
 * Real recent NHL regular-season lines for players in the roster snapshot,
 * looked up by NHL player id (for showing what a player did before this save).
 */
import NHL_SNAPSHOT from './rosters.json';
import type { NhlGoalieSeason, NhlSkaterSeason, NhlSnapshot } from './types';

let index: Map<number, { skater?: NhlSkaterSeason[]; goalie?: NhlGoalieSeason[] }> | null = null;

function byId() {
  if (!index) {
    index = new Map();
    for (const list of Object.values((NHL_SNAPSHOT as unknown as NhlSnapshot).teams)) for (const r of list) index.set(r.nhlId, { skater: r.skater, goalie: r.goalie });
  }
  return index;
}

/** Most recent real NHL season (newest first in the snapshot), or null. */
export function lastRealSeason(nhlId: number | undefined): { skater?: NhlSkaterSeason; goalie?: NhlGoalieSeason } | null {
  if (nhlId === undefined) return null;
  const r = byId().get(nhlId);
  if (!r) return null;
  const skater = r.skater?.find((s) => s.gp > 0);
  const goalie = r.goalie?.find((s) => s.gp > 0);
  return skater || goalie ? { skater, goalie } : null;
}
