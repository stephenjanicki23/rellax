import type { Rng } from '../core/rng';
import { clamp } from '../core/math';
import type { Coach, CoachPhilosophy, CoachRatings, Player, Tactics } from '../types';
import { NAME_POOLS, COACH_FIRST } from '../data/names';
import { allOptionFits, type FitArea, type FitNorm } from './fit';

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
 * CPU coaches pick systems from their philosophy and their roster: each
 * option scores its team fit plus a bonus for the coach's preferred system.
 * Better tacticians read their roster more accurately (less noise).
 */
export function tacticsForRoster(ph: CoachPhilosophy, roster: Player[], tacticalRating: number, rng: Rng, lines?: { pp: number[][]; pk: number[][] }, system?: Partial<Tactics>, norm?: FitNorm): Tactics {
  const t = { ...tacticsForPhilosophy(ph), ...(system ?? {}) };
  // A coach's signature system is part of his identity; a philosophy default is a softer preference.
  const bonus = (area: FitArea) => (system && (system as Record<string, unknown>)[area] !== undefined ? 0.8 : 0.45);
  const active = roster.filter((p) => p.status === 'active' && p.pos !== 'G');
  if (active.length < 10 || !norm) return t;
  const fits = allOptionFits(norm, active, lines && lines.pp.length ? lines : undefined);
  const noise = clamp((165 - tacticalRating) / 220, 0.05, 0.5);
  const pick = <K extends FitArea>(area: K, preferred: string): string => {
    let best = preferred;
    let bestScore = -Infinity;
    for (const [opt, fit] of Object.entries(fits[area])) {
      const score = fit + (opt === preferred ? bonus(area) : 0) + rng.normal(0, noise);
      if (score > bestScore) {
        bestScore = score;
        best = opt;
      }
    }
    return best;
  };
  return {
    ...t,
    offense: pick('offense', t.offense) as Tactics['offense'],
    defense: pick('defense', t.defense) as Tactics['defense'],
    forecheck: pick('forecheck', t.forecheck) as Tactics['forecheck'],
    pp: pick('pp', t.pp) as Tactics['pp'],
    pk: pick('pk', t.pk) as Tactics['pk'],
  };
}

const PHILOSOPHIES: [CoachPhilosophy, number][] = [
  ['balanced', 4],
  ['offensive', 2],
  ['defensive', 2],
  ['development', 1.5],
  ['structured', 2],
  ['physical', 1],
];

export function generateCoach(rng: Rng, id: number, season: number, quality: number, role: Coach['role'] = 'head', profile?: { philosophy: CoachPhilosophy; system?: Partial<Tactics>; lean?: Partial<Record<keyof CoachRatings, number>>; note?: string }): Coach {
  const pool = rng.weighted(NAME_POOLS.slice(0, 6), (p) => p.weight);
  const rolled = PHILOSOPHIES[rng.weightedIndex(PHILOSOPHIES.map((p) => p[1]))][0];
  const philosophy = profile?.philosophy ?? rolled;
  const r = (bias = 0) => Math.round(clamp(quality + bias + rng.normal(0, 16), 30, 195));
  const ratings: CoachRatings = {
    offense: r(philosophy === 'offensive' ? 14 : philosophy === 'defensive' ? -8 : 0),
    defense: r(philosophy === 'defensive' ? 14 : philosophy === 'offensive' ? -8 : 0),
    development: r(philosophy === 'development' ? 18 : 0),
    goaltending: r(role === 'goalie' ? 25 : -5),
    motivation: r(philosophy === 'physical' ? 6 : 0),
    tactics: r(philosophy === 'structured' ? 14 : 0),
  };
  for (const [k, v] of Object.entries(profile?.lean ?? {})) ratings[k as keyof CoachRatings] = Math.round(clamp(ratings[k as keyof CoachRatings] + (v ?? 0), 30, 195));
  const age = rng.int(36, 66);
  return {
    ...(profile?.system ? { system: profile.system } : {}),
    ...(profile?.note ? { styleNote: profile.note } : {}),
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
