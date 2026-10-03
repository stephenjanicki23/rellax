import type { Rng } from '../core/rng';
import { clamp } from '../core/math';
import type { League, Player, Team } from '../types';
import { capProjection, teamCapSheet } from '../cba/capManager';

/** Ability as perceived by the market: current ability plus some credit for youth upside. */
export function perceivedAbility(p: Player, season: number): number {
  const age = season - p.birthYear;
  const upside = Math.max(0, p.pa - p.ca);
  const credit = age <= 21 ? 0.3 : age <= 23 ? 0.22 : age <= 25 ? 0.12 : 0;
  return p.ca + upside * credit;
}

/** Statistical bump/penalty from last season's production (market loves points). */
function productionAdj(p: Player): number {
  const last = [...p.career].reverse().find((c) => !c.playoffs);
  if (!last || last.stats.gp < 20) return 0;
  const s = last.stats;
  if (p.pos === 'G') {
    const sv = s.sa ? (s.sa - s.ga) / s.sa : 0.9;
    return clamp((sv - 0.905) * 120, -4, 4);
  }
  const ppg = (s.g + s.a1 + s.a2) / s.gp;
  const expected = p.pos === 'D' ? 0.1 + (p.ca - 110) * 0.008 : 0.15 + (p.ca - 110) * 0.012;
  return clamp((ppg - expected) * 12, -5, 6);
}

/** Fair annual salary (thousands) for a player on the open market. */
export function marketValue(p: Player, league: Pick<League, 'season' | 'cap'>): number {
  const age = league.season - p.birthYear;
  const ability = perceivedAbility(p, league.season) + productionAdj(p);
  const x = clamp((ability - 105) / 85, 0, 1.2);
  let v = league.cap.minSalary + 14_500 * x * x;
  if (p.pos === 'G') v *= 0.9;
  if (age >= 33) v *= clamp(1 - 0.09 * (age - 32), 0.35, 1);
  v *= league.cap.upper / 92_000;
  const max = league.cap.upper * 0.2;
  return Math.round(clamp(v, league.cap.minSalary, max) / 5) * 5;
}

/** Contract term a player/team would typically agree to. */
export function typicalTerm(p: Player, season: number, rng?: Rng): number {
  const age = season - p.birthYear;
  let t: number;
  if (p.ca >= 155 && age <= 28) t = 6 + (rng ? rng.int(0, 2) : 1);
  else if (p.ca >= 140 && age <= 30) t = 3 + (rng ? rng.int(0, 2) : 1);
  else if (age >= 34) t = 1;
  else if (age >= 31) t = 1 + (rng ? rng.int(0, 1) : 1);
  else t = 1 + (rng ? rng.int(0, 2) : 1);
  return clamp(t, 1, 8);
}

export function isRFA(p: Player, season: number): boolean {
  const age = season - p.birthYear;
  return age < 27 && p.proSeasons < 7;
}


/** Team cap charge for the current books (CapManager: active roster, buried, retained, dead cap). */
export function payroll(league: League, teamId: number): number {
  return teamCapSheet(league, teamId).total;
}

/** Cap space for the current books (upper limit + LTIR relief − total). */
export function capSpace(league: League, teamId: number): number {
  return teamCapSheet(league, teamId).space;
}

export function rosterOf(league: League, teamId: number, status: Player['status'] = 'active'): Player[] {
  const out: Player[] = [];
  for (const p of Object.values(league.players)) if (p.teamId === teamId && p.status === status) out.push(p);
  return out;
}

/** Commitments for future seasons: [current books, next, +2 ...] (contracts + dead cap). */
export function futureCommitments(league: League, teamId: number, years = 5): number[] {
  return capProjection(league, teamId, years).map((y) => y.committed + y.deadCap);
}

export function teamBudget(t: Team, cap: number): number {
  return Math.round(cap * clamp(0.82 + t.marketSize * 0.045, 0.85, 1.05));
}

/**
 * Salary demand of a player when negotiating with a given team. Players give
 * a discount to contenders / their current team if they value winning or
 * loyalty, and want a premium for a lesser role.
 */
export function askingSalary(p: Player, league: League, teamId: number | null, years: number): number {
  const base = marketValue(p, league);
  let mult = 1;
  if (teamId !== null && p.teamId === teamId) mult -= 0.05 * (p.prefs.loyalty - 0.8);
  const age = league.season - p.birthYear;
  // Short deals for young players cost less per year; long deals for vets cost less per year.
  if (age < 26) mult += (years - 3) * 0.025;
  else if (age > 31) mult -= (years - 2) * 0.03;
  mult += (p.morale < 40 ? 0.06 : 0) + (p.prefs.money - 1) * 0.15;
  return Math.round(clamp(base * mult, league.cap.minSalary, league.cap.upper * 0.2) / 5) * 5;
}

export function fmtMoney(thousands: number): string {
  if (Math.abs(thousands) >= 1000) return `$${(thousands / 1000).toFixed(thousands >= 10_000 ? 1 : 2)}M`;
  return `$${Math.round(thousands)}K`;
}
