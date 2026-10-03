/**
 * Imperfect information. The user only sees estimates of other players'
 * ability and potential; scouts narrow (and slightly bias) those estimates over
 * time. CPU teams have their own fixed scouting error per player.
 */
import { Rng, seedFrom } from '../core/rng';
import { clamp } from '../core/math';
import type { AttrKey, League, Player, Scout } from '../types';
import { roleForAbility, abilityWeights } from '../player/ability';
import { ARCHETYPES } from '../player/archetypes';
import { PERSONALITIES } from '../player/personality';

export interface Estimate {
  ca: number;
  pa: number;
  caLow: number;
  caHigh: number;
  paLow: number;
  paHigh: number;
  knowledge: number;
  exact: boolean;
}

export function knowledgeOf(league: League, p: Player): number {
  if (league.settings.godMode) return 100;
  const k = league.scouting.knowledge[p.id] ?? 0;
  if (p.teamId === league.userTeamId && p.status !== 'draft') return Math.max(k, 85);
  // Established NHL players are well known around the league.
  const base = p.status === 'active' ? 45 + Math.min(30, p.proSeasons * 6) : p.status === 'fa' ? 40 : 10;
  return clamp(Math.max(k, base), 0, 100);
}

function scoutQuality(league: League): { ca: number; pa: number } {
  if (!league.scouts.length) return { ca: 90, pa: 90 };
  return {
    ca: Math.max(...league.scouts.map((s) => s.judgingAbility)),
    pa: Math.max(...league.scouts.map((s) => s.judgingPotential)),
  };
}

/** User-facing estimate of a player's current and potential ability. */
export function estimate(league: League, p: Player): Estimate {
  const k = knowledgeOf(league, p);
  if (k >= 100 || league.settings.godMode) return { ca: p.ca, pa: p.pa, caLow: p.ca, caHigh: p.ca, paLow: p.pa, paHigh: p.pa, knowledge: 100, exact: true };
  const q = scoutQuality(league);
  const r = new Rng(seedFrom(league.seed, 'est', p.id));
  const biasCa = r.normal(0, 1);
  const biasPa = r.normal(0, 1);
  const unk = (100 - k) / 100;
  const sdCa = 4 + unk * 26 * (1.15 - q.ca / 250);
  const sdPa = 5 + unk * 34 * (1.15 - q.pa / 250) + (p.status === 'draft' || p.status === 'prospect' ? 4 : 0);
  // Your own staff knows exactly what your players can do today; the ceiling is still a guess.
  const own = p.teamId === league.userTeamId && p.status !== 'draft';
  const ca = own ? p.ca : Math.round(clamp(p.ca + biasCa * sdCa * 0.55, 1, 200));
  const pa = Math.round(clamp(Math.max(ca, p.pa + biasPa * sdPa * 0.55), 1, 200));
  if (own) {
    return { ca, pa, caLow: ca, caHigh: ca, paLow: Math.round(clamp(Math.max(ca, pa - sdPa), 1, 200)), paHigh: Math.round(clamp(pa + sdPa, 1, 200)), knowledge: k, exact: false };
  }
  return {
    ca,
    pa,
    caLow: Math.round(clamp(ca - sdCa, 1, 200)),
    caHigh: Math.round(clamp(ca + sdCa, 1, 200)),
    paLow: Math.round(clamp(Math.max(ca, pa - sdPa), 1, 200)),
    paHigh: Math.round(clamp(pa + sdPa, 1, 200)),
    knowledge: k,
    exact: false,
  };
}

/** Displayed attribute (0-200) with uncertainty for poorly-scouted players. */
export function displayedAttr(league: League, p: Player, k: AttrKey): { value: number; range: number } {
  const know = knowledgeOf(league, p);
  if (know >= 95 || (p.teamId === league.userTeamId && p.status !== 'draft')) return { value: p.attrs[k], range: 0 };
  const r = new Rng(seedFrom(league.seed, 'attr', p.id, k));
  const sd = ((100 - know) / 100) * 30;
  return { value: Math.round(clamp(p.attrs[k] + r.normal(0, sd * 0.5), 1, 200)), range: Math.round(sd) };
}

/** CPU team's private view of a player's potential (fixed error per team/player). */
export function aiPerceivedPA(league: League, teamId: number, p: Player): number {
  const r = new Rng(seedFrom(league.seed, 'ai-scout', teamId, p.id));
  const sd = p.status === 'draft' || p.status === 'prospect' ? 11 : 5;
  return clamp(p.pa + r.normal(0, sd), p.ca, 200);
}

export function scoutReport(league: League, p: Player): { projection: string; strengths: string[]; weaknesses: string[]; personality: string | null; injury: string | null; summary: string } {
  const e = estimate(league, p);
  const k = e.knowledge;
  const w = abilityWeights(p.pos);
  const keys = (Object.keys(w) as AttrKey[]).filter((x) => (w[x] ?? 0) >= 0.5);
  const sorted = [...keys].sort((a, b) => p.attrs[b] - p.attrs[a]);
  const label = (x: AttrKey) => x.replace(/([A-Z])/g, ' $1').replace(/^g /, '').replace(/^./, (c) => c.toUpperCase());
  const strengths = k >= 25 ? sorted.slice(0, k >= 60 ? 3 : 2).map(label) : [];
  const weaknesses = k >= 40 ? sorted.slice(-2).map(label) : [];
  const personality = k >= 60 ? PERSONALITIES[p.personality].label : null;
  const injury = k >= 50 ? (p.durability < 95 || p.traits.includes('injuryProne') ? 'Medical staff have durability concerns' : 'No significant injury concerns') : null;
  const ceiling = roleForAbility(p.pos, e.pa);
  const confidence = k >= 75 ? 'Projects as' : k >= 45 ? 'Likely projects as' : 'Early viewings suggest';
  const projection = `${confidence} a potential ${ceiling}.`;
  const arch = ARCHETYPES[p.archetype].label;
  const summary = `${arch}. ${projection}${strengths.length ? ` Strengths: ${strengths.join(', ')}.` : ''}`;
  return { projection, strengths, weaknesses, personality, injury, summary };
}

/** Weekly scouting progress for the user's scouts. */
export function weeklyScouting(league: League): void {
  for (const s of league.scouts) {
    const gain = 7 + s.judgingAbility / 25;
    const targets = scoutTargets(league, s);
    for (const p of targets) {
      const cur = league.scouting.knowledge[p.id] ?? 0;
      league.scouting.knowledge[p.id] = clamp(cur + gain * (cur > 70 ? 0.5 : 1), 0, 100);
    }
  }
}

function scoutTargets(league: League, s: Scout): Player[] {
  const all = Object.values(league.players);
  const k = (p: Player) => league.scouting.knowledge[p.id] ?? 0;
  let pool: Player[] = [];
  switch (s.assignment.kind) {
    case 'draft':
      pool = all.filter((p) => p.status === 'draft').sort((a, b) => b.reputation - a.reputation).slice(0, 120);
      break;
    case 'team': {
      const tid = s.assignment.teamId;
      pool = all.filter((p) => p.teamId === tid && (p.status === 'active' || p.status === 'prospect'));
      break;
    }
    case 'freeAgents':
      pool = all.filter((p) => p.status === 'fa').sort((a, b) => b.reputation - a.reputation).slice(0, 80);
      break;
    default:
      return [];
  }
  return pool.filter((p) => k(p) < 100).sort((a, b) => k(a) - k(b)).slice(0, 12);
}

/** Draft combine: physical testing reveals more about every prospect. */
export function runCombine(league: League): void {
  for (const p of Object.values(league.players)) {
    if (p.status !== 'draft') continue;
    const cur = league.scouting.knowledge[p.id] ?? 0;
    league.scouting.knowledge[p.id] = clamp(cur + 12, 0, 100);
  }
  league.draftCombineDone = true;
}

export function combineResults(p: Player): { label: string; value: number }[] {
  const a = p.attrs;
  return [
    { label: 'Skating speed', value: a.speed },
    { label: 'Acceleration', value: a.acceleration },
    { label: 'Strength', value: a.strength },
    { label: 'Endurance (VO2)', value: a.endurance },
    { label: 'Agility', value: a.agility },
  ];
}
