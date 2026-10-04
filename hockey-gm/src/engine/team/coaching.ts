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
    specialTeams: r(philosophy === 'offensive' ? 4 : 0),
    discipline: r(philosophy === 'structured' || philosophy === 'defensive' ? 8 : philosophy === 'physical' ? -12 : 0),
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
  if (c.role === 'assistant') return Math.round(r.offense * 0.2 + r.defense * 0.2 + r.development * 0.25 + r.specialTeams * 0.2 + r.tactics * 0.15);
  return Math.round(r.offense * 0.17 + r.defense * 0.17 + r.tactics * 0.22 + r.motivation * 0.14 + r.development * 0.1 + r.goaltending * 0.06 + r.specialTeams * 0.09 + r.discipline * 0.05);
}

export interface CoachTrait {
  key: keyof CoachRatings | 'cups' | 'veteran' | 'unproven';
  label: string;
  detail: string;
}

const TRAIT_TEXT: Record<keyof CoachRatings, { good: [string, string]; bad: [string, string] }> = {
  offense: { good: ['Offensive mind', 'His teams create chances and get to the scoring areas'], bad: ['Limited offence', 'His teams struggle to generate chances'] },
  defense: { good: ['Defensive structure', 'Tight in front of his goalie; teams are hard to break down'], bad: ['Loose defensively', 'His teams give up too much off the rush and in the slot'] },
  development: { good: ['Develops young players', 'Prospects and young players progress faster under him'], bad: ['Not a teacher', 'Young players progress more slowly under him'] },
  goaltending: { good: ["Goalie's coach", 'Gets the best out of his goaltenders'], bad: ['No help for goalies', 'Goaltenders get little from his staff'] },
  motivation: { good: ['Motivator', 'Teams play hard for him; the room stays together through slumps'], bad: ['Can lose the room', 'Morale and effort sag when results turn'] },
  tactics: { good: ['Elite tactician', 'Reads his roster, installs systems quickly and gets more out of them'], bad: ['Rigid', 'Slow to install systems and to adjust them to his roster'] },
  specialTeams: { good: ['Special-teams expert', 'Well-designed power play and penalty kill'], bad: ['Weak special teams', 'His power play and penalty kill underperform'] },
  discipline: { good: ['Disciplined teams', 'His teams stay out of the penalty box'], bad: ['Undisciplined teams', 'His teams take too many penalties'] },
};

/** Ratings that matter for each role (assistants and goalie coaches are judged on their speciality). */
const ROLE_KEYS: Record<Coach['role'], (keyof CoachRatings)[]> = {
  head: ['offense', 'defense', 'tactics', 'motivation', 'development', 'specialTeams', 'discipline', 'goaltending'],
  assistant: ['offense', 'defense', 'development', 'specialTeams', 'tactics'],
  goalie: ['goaltending', 'development'],
};

/**
 * A coach's strengths and weaknesses: ratings that stand out on the 1–20 scale
 * (15+ strength, 8 or lower weakness), plus his NHL résumé.
 */
export function coachTraits(c: Coach): { strengths: CoachTrait[]; weaknesses: CoachTrait[] } {
  const strengths: CoachTrait[] = [];
  const weaknesses: CoachTrait[] = [];
  const keys = ROLE_KEYS[c.role];
  const sorted = [...keys].sort((a, b) => c.ratings[b] - c.ratings[a]);
  for (const k of sorted) if (c.ratings[k] >= 145 && strengths.length < 3) strengths.push({ key: k, label: TRAIT_TEXT[k].good[0], detail: TRAIT_TEXT[k].good[1] });
  for (const k of [...sorted].reverse()) if (c.ratings[k] <= 85 && weaknesses.length < 2 && !(c.role === 'head' && k === 'goaltending')) weaknesses.push({ key: k, label: TRAIT_TEXT[k].bad[0], detail: TRAIT_TEXT[k].bad[1] });
  // Everyone has a best and a worst area, even if neither stands out.
  if (!strengths.length) strengths.push({ key: sorted[0], label: TRAIT_TEXT[sorted[0]].good[0], detail: `His best area — ${TRAIT_TEXT[sorted[0]].good[1].toLowerCase()}` });
  const worst = [...sorted].reverse().find((k) => !(c.role === 'head' && k === 'goaltending'))!;
  if (!weaknesses.length && worst !== strengths[0].key) weaknesses.push({ key: worst, label: TRAIT_TEXT[worst].bad[0], detail: `His weakest area — ${TRAIT_TEXT[worst].bad[1].toLowerCase()}` });
  if (c.role === 'head') {
    const t = coachTotals(c);
    const cups = c.career.filter((l) => l.cup).length;
    if (cups) strengths.unshift({ key: 'cups', label: cups > 1 ? `${cups}× Stanley Cup champion` : 'Stanley Cup champion', detail: `Won it in ${c.career.filter((l) => l.cup).map((l) => l.season + 1).join(', ')}` });
    if (t.gp >= 600) strengths.push({ key: 'veteran', label: 'Veteran bench boss', detail: `${t.gp} NHL games behind the bench` });
    else if (t.gp < 82) weaknesses.push({ key: 'unproven', label: 'Unproven', detail: t.gp ? `Only ${t.gp} NHL games as a head coach` : 'Has never been an NHL head coach' });
  }
  return { strengths, weaknesses };
}

/** Career head-coaching totals: the real NHL record plus everything in this save (including the current season). */
export function coachTotals(c: Coach): { gp: number; w: number; l: number; t: number; otl: number; pw: number; pl: number; ptsPct: number; cups: number; seasons: number } {
  let gp = 0, w = 0, l = 0, t = 0, otl = 0, pw = 0, pl = 0, cups = 0;
  const seasons = new Set<number>();
  for (const x of c.career) {
    if (x.role && x.role !== 'head') continue;
    const g = x.gp ?? x.w + x.l + (x.t ?? 0) + x.otl;
    gp += g;
    w += x.w;
    l += x.l;
    t += x.t ?? 0;
    otl += x.otl;
    pw += x.pw ?? 0;
    pl += x.pl ?? 0;
    if (x.cup) cups++;
    if (g) seasons.add(x.season);
  }
  for (const s of c.stints ?? []) {
    gp += s.gp;
    w += s.w;
    l += s.l;
    otl += s.otl;
    pw += s.pw;
    pl += s.pl;
    if (s.gp) seasons.add(s.season);
  }
  return { gp, w, l, t, otl, pw, pl, ptsPct: gp ? (2 * w + t + otl) / (2 * gp) : 0, cups, seasons: seasons.size };
}

/** Effective ratings seen by the game engine (head coach + goalie coach input). */
export function effectiveCoachRatings(head: Coach | undefined, goalieCoach: Coach | undefined, assistant: Coach | undefined): CoachRatings {
  // An empty bench: nobody runs the systems or the special teams.
  const r: CoachRatings = head ? { ...head.ratings } : { offense: 70, defense: 70, development: 70, goaltending: 70, motivation: 70, tactics: 70, specialTeams: 70, discipline: 85 };
  if (goalieCoach) r.goaltending = Math.max(r.goaltending, goalieCoach.ratings.goaltending * 0.9 + r.goaltending * 0.1);
  if (assistant) {
    r.offense = r.offense * 0.85 + assistant.ratings.offense * 0.15;
    r.defense = r.defense * 0.85 + assistant.ratings.defense * 0.15;
    r.development = r.development * 0.8 + assistant.ratings.development * 0.2;
    // Assistants usually run one of the special-teams units.
    r.specialTeams = r.specialTeams * 0.6 + assistant.ratings.specialTeams * 0.4;
  }
  return r;
}
