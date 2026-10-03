import type { Rng } from '../core/rng';
import { clamp } from '../core/math';
import type { Player, Position } from '../types';
import { generatePlayer } from './generate';

const POSITIONS: [Position, number][] = [
  ['C', 25],
  ['LW', 19],
  ['RW', 19],
  ['D', 30],
  ['G', 9],
];

/**
 * Draft-eligible prospect. Potential follows a heavy-tailed distribution: most
 * prospects project as depth players, a handful as franchise talents. Current
 * ability is a fraction of potential that depends on how "finished" the
 * prospect is (early developers look more polished at 18).
 */
export function generateProspect(rng: Rng, id: number, season: number, age = rng.chance(0.78) ? 18 : 19): Player {
  const pos = POSITIONS[rng.weightedIndex(POSITIONS.map((p) => p[1]))][0];
  const u = rng.next();
  const pa = Math.round(clamp(100 + 82 * Math.pow(u, 3.2) + rng.normal(0, 4), 88, 196));
  // Polishedness: fraction of potential already realised.
  let frac = clamp(rng.normal(0.56, 0.05), 0.42, 0.7);
  if (age === 19) frac += 0.03;
  const ca = Math.round(clamp(pa * frac, 45, 135));
  const p = generatePlayer(rng, { id, pos, targetCA: ca, age, season, pa, tier: clamp((pa - 120) / 60, 0, 1) });
  if (p.devCurve === 'early') {
    p.ca = Math.min(p.pa, p.ca);
  }
  p.status = 'draft';
  p.proSeasons = 0;
  p.teamId = null;
  p.reputation = Math.round(clamp((pa - 100) * 0.6 + rng.normal(0, 8), 1, 80));
  return p;
}

export function generateDraftClass(rng: Rng, nextId: () => number, season: number, count: number): Player[] {
  const out: Player[] = [];
  for (let i = 0; i < count; i++) out.push(generateProspect(rng, nextId(), season));
  return out;
}
