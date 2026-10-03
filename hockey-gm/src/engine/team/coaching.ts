import type { Rng } from '../core/rng';
import { clamp } from '../core/math';
import type { Coach, CoachPhilosophy, CoachRatings, Player, Tactics } from '../types';
import { NAME_POOLS, COACH_FIRST } from '../data/names';
import { offenseScore, defenseScore } from './lines';

export const DEFAULT_TACTICS: Tactics = {
  offense: 'balanced',
  defense: 'balanced',
  forecheck: '1-2-2',
  pp: 'umbrella',
  pk: 'box',
  lineUsage: 'balanced',
  pullGoalie: 'normal',
};

export const PHILOSOPHY_LABEL: Record<CoachPhilosophy, string> = {
  offensive: 'Run-and-gun offence',
  defensive: 'Defence first',
  balanced: 'Balanced',
  development: 'Player development',
  structured: 'Structured system',
  physical: 'Heavy, physical hockey',
};

export function tacticsForPhilosophy(ph: CoachPhilosophy): Tactics {
  switch (ph) {
    case 'offensive':
      return { offense: 'rush', defense: 'aggressive', forecheck: '2-1-2', pp: 'overload', pk: 'aggressive', lineUsage: 'topHeavy', pullGoalie: 'aggressive' };
    case 'defensive':
      return { offense: 'dumpChase', defense: 'trap', forecheck: '1-3-1', pp: 'umbrella', pk: 'box', lineUsage: 'balanced', pullGoalie: 'conservative' };
    case 'development':
      return { offense: 'possession', defense: 'balanced', forecheck: '1-2-2', pp: 'overload', pk: 'diamond', lineUsage: 'rollFour', pullGoalie: 'normal' };
    case 'structured':
      return { offense: 'cycle', defense: 'passive', forecheck: '1-2-2', pp: 'umbrella', pk: 'box', lineUsage: 'balanced', pullGoalie: 'normal' };
    case 'physical':
      return { offense: 'dumpChase', defense: 'physical', forecheck: '2-1-2', pp: 'netFront', pk: 'aggressive', lineUsage: 'balanced', pullGoalie: 'normal' };
    default:
      return { ...DEFAULT_TACTICS };
  }
}

/**
 * CPU coaches adapt their philosophy to the roster: a skilled, fast team leans
 * to the rush; a heavy team leans physical; a weak defence leans structured.
 */
export function tacticsForRoster(ph: CoachPhilosophy, roster: Player[], tacticalRating: number, rng: Rng): Tactics {
  const t = tacticsForPhilosophy(ph);
  const active = roster.filter((p) => p.status === 'active' && p.pos !== 'G');
  if (!active.length) return t;
  const avg = (f: (p: Player) => number) => active.reduce((s, p) => s + f(p), 0) / active.length;
  const speed = avg((p) => p.attrs.speed);
  const phys = avg((p) => p.attrs.strength + p.attrs.bodyChecking) / 2;
  const off = avg(offenseScore);
  const def = avg(defenseScore);
  // Smarter coaches adapt more often.
  if (rng.chance(clamp((tacticalRating - 70) / 100, 0.1, 0.9))) {
    if (speed > 135 && t.offense === 'balanced') t.offense = 'rush';
    if (phys > 135 && t.defense === 'balanced') t.defense = 'physical';
    if (def < off - 12 && t.defense === 'aggressive') t.defense = 'balanced';
    const snipers = active.filter((p) => p.archetype === 'sniper').length;
    const pf = active.filter((p) => p.archetype === 'powerForward').length;
    if (snipers >= 3 && t.pp === 'umbrella') t.pp = 'shooting';
    if (pf >= 3 && t.pp === 'umbrella') t.pp = 'netFront';
  }
  return t;
}

const PHILOSOPHIES: [CoachPhilosophy, number][] = [
  ['balanced', 4],
  ['offensive', 2],
  ['defensive', 2],
  ['development', 1.5],
  ['structured', 2],
  ['physical', 1],
];

export function generateCoach(rng: Rng, id: number, season: number, quality: number, role: Coach['role'] = 'head'): Coach {
  const pool = rng.weighted(NAME_POOLS.slice(0, 6), (p) => p.weight);
  const philosophy = PHILOSOPHIES[rng.weightedIndex(PHILOSOPHIES.map((p) => p[1]))][0];
  const r = (bias = 0) => Math.round(clamp(quality + bias + rng.normal(0, 16), 30, 195));
  const ratings: CoachRatings = {
    offense: r(philosophy === 'offensive' ? 14 : philosophy === 'defensive' ? -8 : 0),
    defense: r(philosophy === 'defensive' ? 14 : philosophy === 'offensive' ? -8 : 0),
    development: r(philosophy === 'development' ? 18 : 0),
    goaltending: r(role === 'goalie' ? 25 : -5),
    motivation: r(philosophy === 'physical' ? 6 : 0),
    tactics: r(philosophy === 'structured' ? 14 : 0),
  };
  const age = rng.int(36, 66);
  return {
    id,
    first: rng.pick(COACH_FIRST),
    last: rng.pick(pool.last),
    birthYear: season - age,
    role,
    ratings,
    philosophy,
    teamId: null,
    contract: null,
    reputation: Math.round(clamp((quality - 80) * 0.8 + rng.normal(0, 8), 5, 95)),
    career: [],
    hiredSeason: null,
  };
}

export function coachOverall(c: Coach): number {
  const r = c.ratings;
  if (c.role === 'goalie') return Math.round(r.goaltending * 0.7 + r.development * 0.3);
  return Math.round(r.offense * 0.2 + r.defense * 0.2 + r.tactics * 0.25 + r.motivation * 0.15 + r.development * 0.1 + r.goaltending * 0.1);
}

/** Effective ratings seen by the game engine (head coach + goalie coach input). */
export function effectiveCoachRatings(head: Coach | undefined, goalieCoach: Coach | undefined, assistant: Coach | undefined): CoachRatings | null {
  if (!head) return null;
  const r = { ...head.ratings };
  if (goalieCoach) r.goaltending = Math.max(r.goaltending, goalieCoach.ratings.goaltending * 0.9 + r.goaltending * 0.1);
  if (assistant) {
    r.offense = r.offense * 0.85 + assistant.ratings.offense * 0.15;
    r.defense = r.defense * 0.85 + assistant.ratings.defense * 0.15;
    r.development = r.development * 0.8 + assistant.ratings.development * 0.2;
  }
  return r;
}
