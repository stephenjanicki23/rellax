/**
 * Contract arithmetic and structural validation. Pure functions over the
 * Contract model; everything rule-dependent reads the versioned rules.
 */
import type { ClauseKind, Contract, ContractClause, ContractYear, Player } from '../types';
import { STATIC, elcMaxFor, rulesFor } from './rules';

const round = (x: number) => Math.round(x * 1000) / 1000;

export interface ContractTerms {
  startSeason: number;
  /** Year-by-year base salaries (one per season). */
  salaries: number[];
  /** Year-by-year signing bonuses (defaults to 0). */
  signingBonuses?: number[];
  /** Year-by-year maximum performance bonuses (defaults to 0). */
  perfBonuses?: number[];
  minorSalaries?: number[];
  type?: Contract['type'];
  twoWay?: boolean;
  clauses?: ContractClause[];
  signingTeamId?: number | null;
  signedSeason: number;
  signedDay?: number;
  source?: Contract['source'];
  origin?: Contract['origin'];
  /** Player age as of June 30 before the first season (35+ test). */
  ageAtStart?: number;
}

/** Build a full contract from terms. Derived flat fields are set for `currentSeason`. */
export function buildContract(t: ContractTerms, currentSeason = t.startSeason): Contract {
  const n = t.salaries.length;
  const years: ContractYear[] = t.salaries.map((salary, i) => ({
    season: t.startSeason + i,
    salary: round(salary),
    signingBonus: round(t.signingBonuses?.[i] ?? 0),
    perfBonus: round(t.perfBonuses?.[i] ?? 0),
    ...(t.minorSalaries?.[i] !== undefined ? { minorSalary: t.minorSalaries[i] } : {}),
  }));
  const c: Contract = {
    salary: 0,
    years: n,
    type: t.type ?? 'standard',
    ntc: false,
    signedSeason: t.signedSeason,
    startSeason: t.startSeason,
    endSeason: t.startSeason + n - 1,
    yearsDetail: years,
    twoWay: t.twoWay ?? false,
    clauses: t.clauses ?? [],
    signingTeamId: t.signingTeamId ?? null,
    signedDay: t.signedDay ?? 0,
    retained: [],
    source: t.source ?? 'game',
    origin: t.origin ?? 'signing',
  };
  c.thirtyFivePlus = t.ageAtStart !== undefined ? isThirtyFivePlus(c, t.ageAtStart) : false;
  refreshContract(c, currentSeason);
  return c;
}

/** Flat salary over `years` seasons (convenience for AI/user offers). */
export function flatTerms(aav: number, years: number, startSeason: number, extra: Partial<ContractTerms> = {}): ContractTerms {
  return { startSeason, salaries: new Array(years).fill(aav), signedSeason: extra.signedSeason ?? startSeason, ...extra };
}

/** Years detail, synthesising one for legacy flat contracts. */
export function yearsOf(c: Contract): ContractYear[] {
  if (c.yearsDetail?.length) return c.yearsDetail;
  const start = c.startSeason ?? c.signedSeason;
  const total = (c.endSeason ?? start + c.years - 1) - start + 1;
  return Array.from({ length: Math.max(1, total) }, (_, i) => ({ season: start + i, salary: c.salary, signingBonus: 0, perfBonus: 0 }));
}

export const termOf = (c: Contract) => yearsOf(c).length;
export const totalValue = (c: Contract) => yearsOf(c).reduce((s, y) => s + y.salary + y.signingBonus, 0);
export const totalPerfBonus = (c: Contract) => yearsOf(c).reduce((s, y) => s + y.perfBonus, 0);

/** Averaged Amount: (salary + signing bonuses) over the term. */
export function aav(c: Contract): number {
  return round(totalValue(c) / termOf(c));
}

/**
 * Cap hit before retention. Performance bonuses count toward the cap hit for
 * contracts allowed to carry them (ELC, 35+, eligible one-year deals), per
 * CBA 50.5(d)(i)(B)(2).
 */
export function fullCapHit(c: Contract): number {
  return round((totalValue(c) + totalPerfBonus(c)) / termOf(c));
}

/** Share of the cap hit still carried by the player's current team (after retention). */
export function retainedShare(c: Contract): number {
  return (c.retained ?? []).reduce((s, r) => s + r.pct, 0);
}

export function holderCapHit(c: Contract): number {
  return round(fullCapHit(c) * (1 - retainedShare(c)));
}

/** Actual cash paid in a season (salary + signing bonus), before retention. */
export function cashIn(c: Contract, season: number): number {
  const y = yearsOf(c).find((x) => x.season === season);
  return y ? y.salary + y.signingBonus : 0;
}

export function yearIn(c: Contract, season: number): ContractYear | undefined {
  return yearsOf(c).find((x) => x.season === season);
}

export function endOf(c: Contract): number {
  const ys = yearsOf(c);
  return ys[ys.length - 1].season;
}

export function remainingYears(c: Contract, season: number): number {
  return Math.max(0, endOf(c) - Math.max(season, yearsOf(c)[0].season) + 1);
}

export function activeClause(c: Contract, season: number): ContractClause | null {
  const order: Record<ClauseKind, number> = { NMC: 3, NTC: 2, 'M-NTC': 1 };
  let best: ContractClause | null = null;
  for (const cl of c.clauses ?? []) if (season >= cl.from && season <= cl.to && (!best || order[cl.kind] > order[best.kind])) best = cl;
  return best;
}

/** Recompute the flat convenience fields for a season. */
export function refreshContract(c: Contract, season: number): Contract {
  c.salary = holderCapHit(c);
  c.years = remainingYears(c, season);
  c.ntc = !!activeClause(c, season);
  c.endSeason = endOf(c);
  c.startSeason = yearsOf(c)[0].season;
  return c;
}

/**
 * 35+ contract: multi-year, player 35+ as of June 30 before year one. Since
 * the 2025 MOU a contract is not 35+ if compensation never decreases from one
 * year to the next and there are no signing bonuses after year one.
 */
export function isThirtyFivePlus(c: Contract, ageAtStart: number): boolean {
  const ys = yearsOf(c);
  const rules = rulesFor(ys[0].season);
  if (ys.length < 2 || ageAtStart < rules.thirtyFivePlusAge) return false;
  if (rules.ruleset === 'MOU2025') {
    const comp = ys.map((y) => y.salary + y.signingBonus);
    const nonDecreasing = comp.every((v, i) => i === 0 || v >= comp[i - 1]);
    const noLaterBonus = ys.slice(1).every((y) => y.signingBonus === 0);
    if (nonDecreasing && noLaterBonus) return false;
  }
  return true;
}

export interface ValidationContext {
  /** Signing with his current team (re-sign/extension) vs another team. */
  ownTeam: boolean;
  /** Season whose rules apply (the league year the contract is signed in). */
  signingSeason: number;
  /** Player age as of Sept 15 of the signing year (ELC eligibility). */
  age: number;
  /** Draft/signing year for ELC maximums. */
  elcYear?: number;
}

/**
 * Structural legality of a contract under the season's rules. Returns a list
 * of specific, GM-readable reasons it is illegal (empty = legal).
 */
export function contractStructureErrors(c: Contract, ctx: ValidationContext): string[] {
  const errors: string[] = [];
  const r = rulesFor(ctx.signingSeason);
  const ys = yearsOf(c);
  const n = ys.length;
  const fmt = (k: number) => (k >= 1000 ? `$${(k / 1000).toFixed(k % 1000 === 0 ? 1 : 3)}M` : `$${Math.round(k)}K`);
  const maxTerm = ctx.ownTeam ? r.maxTermOwnTeam : r.maxTermExternal;
  if (n < 1) errors.push('Contract rejected: a contract must be at least one season.');
  if (n > maxTerm) errors.push(`Contract rejected: ${ctx.ownTeam ? 're-signing with his current team' : 'external free-agent contracts are'} limited to ${maxTerm} years under the ${r.label} rules (${r.sources.maxTermOwnTeam ?? r.ruleset}).`);
  const yearRules = (season: number) => rulesFor(season);
  for (const y of ys) {
    const yr = yearRules(y.season);
    if (y.salary + 1e-6 < yr.minimumSalary) errors.push(`Contract rejected: ${yr.label} salary ${fmt(y.salary)} is below the league minimum of ${fmt(yr.minimumSalary)}.`);
  }
  const capHit = fullCapHit(c);
  if (aav(c) > r.maxSalary + 1e-6) errors.push(`Contract rejected: AAV ${fmt(aav(c))} exceeds the maximum player salary of ${fmt(r.maxSalary)} (20% of the ${r.label} upper limit).`);
  if (c.type === 'ELC') {
    const term = STATIC().elcTermByAge;
    const elcTerm = term[String(Math.min(24, Math.max(18, ctx.age)))];
    if (ctx.age >= 25 || elcTerm === undefined) errors.push('Contract rejected: players 25 or older are not eligible for an entry-level contract.');
    else if (n !== elcTerm) errors.push(`Contract rejected: an entry-level contract for a player signing at ${ctx.age} must be ${elcTerm} year${elcTerm > 1 ? 's' : ''} (CBA 9.1).`);
    const max = elcMaxFor(ctx.elcYear ?? ctx.signingSeason);
    for (const y of ys) if (y.salary + y.signingBonus > max + 1e-6) errors.push(`Contract rejected: ELC compensation ${fmt(y.salary + y.signingBonus)} in ${y.season} exceeds the ${ctx.elcYear ?? ctx.signingSeason} maximum of ${fmt(max)}.`);
    const sbMax = STATIC().elcSignatureBonusMaxPct;
    for (const y of ys) if (y.signingBonus > (y.salary + y.signingBonus) * sbMax + 1e-6) errors.push(`Contract rejected: ELC signing bonuses are limited to ${sbMax * 100}% of compensation.`);
    const perfMax = STATIC().elcScheduleABonusMax;
    for (const y of ys) if (y.perfBonus > perfMax + 1e-6) errors.push(`Contract rejected: ELC Schedule A performance bonuses are limited to ${fmt(perfMax)} per season.`);
  } else if (n > 1) {
    // Salary variance (CBA 50.7 / MOU2025).
    const comp = ys.map((y) => y.salary + y.signingBonus);
    const v = r.salaryVariance;
    // CBA2013: % of the lower of the first two years; MOU2025: % of the first year.
    const base = r.ruleset === 'MOU2025' ? comp[0] : Math.min(comp[0], comp[1] ?? comp[0]);
    const lim = base * v.adjacentPctOfFirstYear;
    for (let i = 1; i < n; i++) {
      if (Math.abs(comp[i] - comp[i - 1]) > lim + 1e-6) {
        errors.push(`Contract rejected: compensation changes by ${fmt(Math.abs(comp[i] - comp[i - 1]))} between ${ys[i - 1].season} and ${ys[i].season}; adjacent years may differ by at most ${Math.round(v.adjacentPctOfFirstYear * 100)}% of ${r.ruleset === 'MOU2025' ? 'the first year' : 'the lower of the first two years'} (${fmt(lim)}).`);
        break;
      }
    }
    const hi = Math.max(...comp);
    const lo = Math.min(...comp);
    if (lo < hi * v.lowestPctOfHighest - 1e-6) errors.push(`Contract rejected: the lowest year (${fmt(lo)}) must be at least ${Math.round(v.lowestPctOfHighest * 100)}% of the highest (${fmt(hi)}).`);
    for (const y of ys) if (y.perfBonus > 0 && !c.thirtyFivePlus && n > 1) errors.push('Contract rejected: performance bonuses are only allowed on entry-level, 35+ or eligible one-year contracts.');
  }
  if (r.signingBonusMaxPctOfTotal !== null && c.type !== 'ELC') {
    const sb = ys.reduce((s, y) => s + y.signingBonus, 0);
    if (sb > totalValue(c) * r.signingBonusMaxPctOfTotal + 1e-6) errors.push(`Contract rejected: signing bonuses (${fmt(sb)}) exceed ${r.signingBonusMaxPctOfTotal * 100}% of total compensation (${r.sources.signingBonusMaxPctOfTotal}).`);
  }
  for (const cl of c.clauses ?? []) if (cl.kind === 'NMC' || cl.kind === 'NTC' || cl.kind === 'M-NTC') {
    // CBA 11.8: clauses only for players eligible for Group 3 UFA status by the time they are effective.
    if (c.type === 'ELC') errors.push('Contract rejected: entry-level contracts cannot contain no-trade or no-movement clauses.');
  }
  void capHit;
  return [...new Set(errors)];
}

/** Age as of Sept 15 of a calendar year (contract-eligibility age). */
export function ageSept15(p: Pick<Player, 'birthYear'>, year: number): number {
  return year - p.birthYear;
}

/** Age as of June 30 before a season starts. */
export function ageJune30(p: Pick<Player, 'birthYear'>, season: number): number {
  return season - p.birthYear;
}

/** Scale every year's money by a factor (keeping minimums); used when fitting estimated contracts under the cap. */
export function scaleContract(c: Contract, factor: number, season: number): Contract {
  for (const y of yearsOf(c)) {
    const min = rulesFor(y.season).minimumSalary;
    const comp = Math.min(Math.max(min, Math.round(((y.salary + y.signingBonus) * factor) / 5) * 5), Math.max(min, rulesFor(y.season).maxSalary));
    const sbShare = y.salary + y.signingBonus > 0 ? y.signingBonus / (y.salary + y.signingBonus) : 0;
    y.signingBonus = Math.round(comp * sbShare);
    y.salary = comp - y.signingBonus;
  }
  if (!c.yearsDetail?.length) c.yearsDetail = yearsOf(c);
  return refreshContract(c, season);
}
