import { clamp } from '../core/math';
import type { ArchetypeId, Player } from '../types';
import { PERSONALITIES } from '../player/personality';

/**
 * Chemistry between two teammates in [-1, 1]. It combines stylistic fit,
 * handedness (for D pairs), personality, passing ability, time spent together
 * and team morale. The engine scales it down heavily (it is a nudge, not a
 * driver of results).
 */
const COMPLEMENT: Partial<Record<ArchetypeId, Partial<Record<ArchetypeId, number>>>> = {
  sniper: { playmaker: 0.4, twoWayForward: 0.2, defensiveForward: 0.18, powerForward: 0.22, grinder: 0.05, sniper: -0.12, offensiveDefenseman: 0.12, puckMovingDefenseman: 0.12 },
  playmaker: { sniper: 0.4, powerForward: 0.3, twoWayForward: 0.15, playmaker: -0.08, grinder: 0.05, enforcer: -0.08 },
  powerForward: { playmaker: 0.3, sniper: 0.22, twoWayForward: 0.12, powerForward: 0.02 },
  twoWayForward: { sniper: 0.2, playmaker: 0.15, twoWayForward: 0.1, powerForward: 0.12, defensiveForward: 0.08 },
  grinder: { grinder: 0.15, enforcer: 0.12, defensiveForward: 0.15, sniper: 0.05 },
  enforcer: { grinder: 0.12, sniper: -0.1, playmaker: -0.08 },
  defensiveForward: { sniper: 0.18, grinder: 0.15, defensiveForward: 0.05, twoWayForward: 0.08 },
  offensiveDefenseman: { stayAtHome: 0.35, physicalDefenseman: 0.25, twoWayDefenseman: 0.15, offensiveDefenseman: -0.18, puckMovingDefenseman: -0.05 },
  twoWayDefenseman: { twoWayDefenseman: 0.12, offensiveDefenseman: 0.15, stayAtHome: 0.12, puckMovingDefenseman: 0.12, physicalDefenseman: 0.1 },
  stayAtHome: { offensiveDefenseman: 0.35, puckMovingDefenseman: 0.3, twoWayDefenseman: 0.12, stayAtHome: -0.08, physicalDefenseman: 0 },
  puckMovingDefenseman: { stayAtHome: 0.3, physicalDefenseman: 0.25, twoWayDefenseman: 0.12, puckMovingDefenseman: -0.05 },
  physicalDefenseman: { puckMovingDefenseman: 0.25, offensiveDefenseman: 0.25, twoWayDefenseman: 0.1, physicalDefenseman: -0.1 },
};

export function styleFit(a: ArchetypeId, b: ArchetypeId): number {
  return COMPLEMENT[a]?.[b] ?? COMPLEMENT[b]?.[a] ?? 0;
}

export function familiarity(sharedSeconds: number): number {
  return 1 - Math.exp(-sharedSeconds / 24000);
}

export function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

export function pairChemistry(a: Player, b: Player, sharedSeconds: number, teamMorale: number): number {
  let c = styleFit(a.archetype, b.archetype);
  if (a.pos === 'D' && b.pos === 'D') c += a.shoots !== b.shoots ? 0.1 : -0.06;
  c += (PERSONALITIES[a.personality].chemistry + PERSONALITIES[b.personality].chemistry) / 2;
  c += ((a.attrs.passing + b.attrs.passing) / 2 - 120) / 400;
  c += familiarity(sharedSeconds) * 0.4 - 0.1;
  c += ((teamMorale - 55) / 45) * 0.1;
  if (a.nat === b.nat && a.nat !== 'CAN' && a.nat !== 'USA') c += 0.05;
  return clamp(c, -1, 1);
}

export function lineChemistry(players: Player[], shared: Record<string, number>, teamMorale: number): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < players.length; i++)
    for (let j = i + 1; j < players.length; j++) {
      s += pairChemistry(players[i], players[j], shared[pairKey(players[i].id, players[j].id)] ?? 0, teamMorale);
      n++;
    }
  return n ? s / n : 0;
}
