/**
 * Player market value, free-agent profiles and the signing decision model.
 *
 * Value blends a performance model (ability, upside, production, awards,
 * playoff reputation, injuries, position, age, cap environment) with the
 * median of comparable contracts (same position group, similar ability and
 * age), indexed to the current cap.
 */
import { clamp } from '../core/math';
import { seedFrom } from '../core/rng';
import type { ClauseKind, League, Player } from '../types';
import { aav, endOf, yearsOf } from './contract';
import { capSeason } from './capManager';
import { rulesFor } from './rules';
import { determineFreeAgentStatus } from './rulesEngine';
import { teamStrength } from '../team/strength';
import { isForward } from '../player/ability';

const group = (p: Player) => (p.pos === 'G' ? 'G' : p.pos === 'D' ? 'D' : 'F');

/** Ability the market sees: current ability plus credit for youth upside. */
export function marketAbility(p: Player, season: number): number {
  const age = season - p.birthYear;
  const upside = Math.max(0, p.pa - p.ca);
  const credit = age <= 21 ? 0.3 : age <= 23 ? 0.22 : age <= 25 ? 0.12 : 0;
  return p.ca + upside * credit;
}

function lastSeasonStats(p: Player) {
  return [...p.career].reverse().find((c) => !c.playoffs)?.stats;
}

/** Production relative to what the market expects for this ability (points / save %). */
export function productionAdj(p: Player): number {
  const s = lastSeasonStats(p);
  if (!s || s.gp < 20) return 0;
  if (p.pos === 'G') {
    const sv = s.sa ? (s.sa - s.ga) / s.sa : 0.9;
    return clamp((sv - 0.905) * 120, -4, 4);
  }
  const ppg = (s.g + s.a1 + s.a2) / s.gp;
  const expected = p.pos === 'D' ? 0.1 + (p.ca - 110) * 0.008 : 0.15 + (p.ca - 110) * 0.012;
  return clamp((ppg - expected) * 12, -5, 6);
}

export interface ValueBreakdown {
  /** Fair AAV now (thousands). */
  value: number;
  model: number;
  comparables: { playerId: number; name: string; aav: number; indexedAav: number }[];
  comparableMedian: number | null;
  factors: { label: string; effect: string }[];
}

interface CompIndexEntry {
  id: number;
  name: string;
  group: 'F' | 'D' | 'G';
  ability: number;
  age: number;
  indexedAav: number;
  aav: number;
}

const compCache = new WeakMap<League, { stamp: string; entries: CompIndexEntry[] }>();

function compIndex(league: League): CompIndexEntry[] {
  if (!league.players) return []; // league still being created
  const stamp = `${league.season}-${league.phase}-${league.day}-${league.faDay}`;
  const hit = compCache.get(league);
  if (hit && hit.stamp === stamp) return hit.entries;
  const season = capSeason(league);
  const upperNow = rulesFor(season).upperLimit;
  const entries: CompIndexEntry[] = [];
  for (const p of Object.values(league.players)) {
    const c = p.contract;
    if (!c || c.type === 'ELC' || p.status === 'retired' || p.status === 'draft') continue;
    if (c.origin === 'qualifyingOffer' || c.origin === 'arbitration') continue;
    const start = yearsOf(c)[0].season;
    if (endOf(c) < season) continue;
    const a = aav(c);
    entries.push({ id: p.id, name: `${p.first} ${p.last}`, group: group(p), ability: marketAbility(p, season), age: season - p.birthYear, aav: a, indexedAav: (a * upperNow) / rulesFor(start).upperLimit });
  }
  compCache.set(league, { stamp, entries });
  return entries;
}

/** Fair market AAV for a player right now, with an explanation. */
export function contractValue(p: Player, league: League): ValueBreakdown {
  const season = capSeason(league);
  const r = rulesFor(season);
  const age = season - p.birthYear;
  const factors: ValueBreakdown['factors'] = [];
  let ability = marketAbility(p, season);
  const prod = productionAdj(p);
  if (Math.abs(prod) >= 0.5) factors.push({ label: 'Recent production', effect: prod > 0 ? 'above expectation' : 'below expectation' });
  ability += prod;
  const recentAwards = p.awards.filter((a) => a.season >= league.season - 2 && !/Champion/.test(a.award)).length;
  if (recentAwards) {
    ability += Math.min(4, recentAwards * 2);
    factors.push({ label: 'Awards', effect: `${recentAwards} recent award${recentAwards > 1 ? 's' : ''}` });
  }
  if (Math.abs(p.playoffRep) > 0.2) {
    ability += p.playoffRep * 2.5;
    factors.push({ label: 'Playoff reputation', effect: p.playoffRep > 0 ? 'clutch' : 'struggles in the playoffs' });
  }
  const serious = p.injuryHistory.filter((i) => i.season >= league.season - 2 && i.days >= 30).length;
  if (serious) {
    ability -= Math.min(6, serious * 2);
    factors.push({ label: 'Injury history', effect: `${serious} serious injur${serious > 1 ? 'ies' : 'y'} in three seasons` });
  }
  const x = clamp((ability - 105) / 85, 0, 1.2);
  let model = r.minimumSalary + 13_000 * x * x + 3_000 * x;
  if (p.pos === 'G') model *= 0.9;
  if (age >= 33) {
    model *= clamp(1 - 0.09 * (age - 32), 0.35, 1);
    factors.push({ label: 'Age', effect: `${age}: declining years` });
  }
  model *= r.upperLimit / 92_000;
  // Comparable contracts.
  const myAbility = marketAbility(p, season);
  const comps = compIndex(league)
    .filter((e) => e.id !== p.id && e.group === group(p) && Math.abs(e.ability - myAbility) <= 6 && Math.abs(e.age - age) <= 4)
    .sort((a, b) => Math.abs(a.ability - myAbility) - Math.abs(b.ability - myAbility))
    .slice(0, 7);
  let median: number | null = null;
  if (comps.length >= 3) {
    const sorted = comps.map((c) => c.indexedAav).sort((a, b) => a - b);
    median = sorted[Math.floor(sorted.length / 2)];
  }
  const blended = median !== null ? model * 0.65 + median * 0.35 : model;
  const value = Math.round(clamp(blended, r.minimumSalary, r.maxSalary) / 5) * 5;
  return { value, model, comparables: comps.map((c) => ({ playerId: c.id, name: c.name, aav: c.aav, indexedAav: c.indexedAav })), comparableMedian: median, factors };
}

// ───────────────────────────── free-agent profile ─────────────────────────────

export interface FreeAgentProfile {
  marketValue: number;
  askingAav: number;
  desiredTerm: number;
  /** 0..1 weights / tolerances. */
  money: number;
  contender: number;
  rebuildTolerance: number;
  role: number;
  location: number;
  loyalty: number;
  /** Team the player last played for (home-team discount / preference). */
  previousTeamId: number | null;
  status: 'RFA' | 'UFA';
}

export function freeAgentProfile(p: Player, league: League): FreeAgentProfile {
  const season = capSeason(league);
  const age = season - p.birthYear;
  const mv = contractValue(p, league).value;
  const h = (k: string) => (seedFrom(league.seed, k, p.id) % 1000) / 1000;
  const desiredTerm = clamp(age <= 25 ? (p.ca >= 145 ? 6 : 3) : age <= 29 ? (p.ca >= 140 ? 6 : 4) : age <= 32 ? 3 : age <= 34 ? 2 : 1, 1, 7);
  const last = p.contractHistory?.[p.contractHistory.length - 1];
  return {
    marketValue: mv,
    askingAav: Math.round((mv * (1.04 + (p.prefs.money - 1) * 0.12)) / 5) * 5,
    desiredTerm,
    money: clamp(p.prefs.money, 0.4, 1.8),
    contender: clamp(p.prefs.winning * (age >= 30 ? 1.3 : 0.9), 0.3, 2),
    rebuildTolerance: clamp(1.1 - p.prefs.winning * 0.5 + h('rebuild') * 0.3, 0.1, 1),
    role: clamp(p.prefs.role, 0.4, 1.8),
    location: clamp(p.prefs.location, 0.3, 1.8),
    loyalty: clamp(p.prefs.loyalty, 0.2, 2.5),
    previousTeamId: last?.teamId ?? null,
    status: determineFreeAgentStatus(p, league.season).status,
  };
}

/** Expected role (0..1) on a team: share of the depth chart he would beat. */
export function projectedRole(league: League, p: Player, teamId: number): number {
  const mates = Object.values(league.players).filter((x) => x.teamId === teamId && x.status === 'active' && x.id !== p.id && (p.pos === 'G' ? x.pos === 'G' : p.pos === 'D' ? x.pos === 'D' : isForward(x.pos)));
  const better = mates.filter((x) => x.ca > p.ca).length;
  const slots = p.pos === 'G' ? 2 : p.pos === 'D' ? 6 : 12;
  return clamp(1 - better / slots, 0, 1);
}

export interface SigningScore {
  total: number;
  parts: { label: string; value: number }[];
}

/**
 * How attractive an offer is (≈1.0 = fair and neutral). Players weigh money
 * and term against team quality, role, contention, location, coach and GM
 * reputation, teammates and their previous team — not just the highest bid.
 */
export function signingScore(league: League, p: Player, offer: { teamId: number; aav: number; years: number; clause?: ClauseKind | null }): SigningScore {
  const prof = freeAgentProfile(p, league);
  const team = league.teams[offer.teamId];
  const age = capSeason(league) - p.birthYear;
  const strengths = league.teams.map((t) => teamStrength(league, t.id).overall).sort((a, b) => a - b);
  const winPct = strengths.findIndex((s) => s >= teamStrength(league, offer.teamId).overall) / Math.max(1, strengths.length - 1);
  const role = projectedRole(league, p, offer.teamId);
  const coachId = team.staff.headCoach;
  const coach = coachId !== null ? league.coaches[coachId] : undefined;
  const countrymen = Object.values(league.players).filter((x) => x.teamId === offer.teamId && x.status === 'active' && x.nat === p.nat).length;
  const parts: SigningScore['parts'] = [
    { label: 'Money', value: (offer.aav / Math.max(1, prof.askingAav)) * prof.money - (prof.money - 1) },
    { label: 'Term', value: -Math.abs(offer.years - prof.desiredTerm) * (age >= 30 ? 0.045 : 0.025) },
    { label: 'Chance to win', value: (winPct - 0.5) * 0.35 * prof.contender },
    { label: 'Rebuild', value: team.strategy === 'rebuild' ? -(1 - prof.rebuildTolerance) * 0.12 : 0 },
    { label: 'Role / ice time', value: (role - 0.5) * 0.25 * prof.role },
    { label: 'Location', value: (team.appeal - 0.55) * 0.3 * prof.location },
    { label: 'Coach', value: coach ? ((coach.reputation - 50) / 100) * 0.08 : 0 },
    { label: 'GM / organisation', value: ((team.reputation - 50) / 100) * 0.06 },
    { label: 'Teammates', value: Math.min(3, countrymen) * 0.01 },
    { label: 'Previous team', value: prof.previousTeamId === offer.teamId ? (prof.loyalty - 0.8) * 0.2 : 0 },
    // Established veterans on long deals want trade protection.
    { label: 'Trade protection', value: offer.clause ? (age >= 27 && offer.years >= 3 ? (p.ca >= 145 ? 0.05 : 0.025) : 0.01) : age >= 28 && offer.years >= 4 && p.ca >= 150 ? -0.03 : 0 },
  ];
  return { total: parts.reduce((s, x) => s + x.value, 0), parts };
}
