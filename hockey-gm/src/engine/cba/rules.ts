/**
 * Versioned NHL league financial rules.
 *
 * All values live in data/league_rules/rules.json (money in thousands of
 * dollars), each tagged with its provenance (CBA2013, MOU2025, NHL figure,
 * PROJECTED or SIMPLIFICATION). A season's rule set inherits everything from
 * the previous season and overrides what changed, so a future CBA change is a
 * data edit, not an engine rewrite. Seasons beyond the table are projected.
 */
import RULES_JSON from '../../../data/league_rules/rules.json';

type Sourced<T> = { value: T; source: string };

interface RawSeason {
  label?: string;
  ruleset?: string;
  upperLimit?: Sourced<number>;
  lowerLimit?: Sourced<number>;
  minimumSalary?: Sourced<number>;
  averageLeagueSalary?: Sourced<number>;
  maxSalaryPctOfUpper?: Sourced<number>;
  maxTermOwnTeam?: Sourced<number>;
  maxTermExternal?: Sourced<number>;
  salaryVariance?: { adjacentPctOfFirstYear: number; lowestPctOfHighest: number; source: string };
  signingBonusMaxPctOfTotal?: Sourced<number | null>;
  qualifyingOffer?: { tiers: [number | null, number][]; tier2Cap: number; aavCapPct: number; oneWayGamesLast3: number; oneWayGamesLastSeason: number; source: string };
  offerSheetTiers?: { aavDivisorMaxYears: number; tiers: [number | null, string[]][]; source: string };
  arbitration?: { clubElectThreshold: number; walkAwayThreshold: number; source: string };
  buriedAllowance?: Sourced<number>;
  bonusCushionPct?: Sourced<number>;
  retention?: { maxPct: number; maxContractsPerTeam: number; maxTimesPerContract: number; source: string };
  buyout?: { ratioUnder26: number; ratio26Plus: number; termMultiplier: number; source: string };
  ltir?: { minDays: number; minGames: number; inSeasonReturnReliefCap: string; source: string };
  playoffCap?: Sourced<boolean>;
  rosterMax?: Sourced<number>;
  contractLimit?: Sourced<number>;
  escrowCapPct?: Sourced<number>;
  thirtyFivePlusAge?: Sourced<number>;
  offseasonOveragePct?: Sourced<number>;
  injuryReserveDays?: Sourced<number>;
}

/** Fully resolved rules for one league season (start year). */
export interface LeagueFinancialRules {
  season: number;
  label: string;
  ruleset: string;
  /** True when any key money figure is a projection rather than an announced number. */
  projected: boolean;
  upperLimit: number;
  lowerLimit: number;
  minimumSalary: number;
  averageLeagueSalary: number;
  maxSalary: number;
  maxTermOwnTeam: number;
  maxTermExternal: number;
  salaryVariance: { adjacentPctOfFirstYear: number; lowestPctOfHighest: number };
  signingBonusMaxPctOfTotal: number | null;
  qualifyingOffer: { tiers: [number | null, number][]; tier2Cap: number; aavCapPct: number; oneWayGamesLast3: number; oneWayGamesLastSeason: number };
  offerSheetTiers: { aavDivisorMaxYears: number; tiers: [number | null, string[]][] };
  arbitration: { clubElectThreshold: number; walkAwayThreshold: number };
  buriedAllowance: number;
  bonusCushionPct: number;
  retention: { maxPct: number; maxContractsPerTeam: number; maxTimesPerContract: number };
  buyout: { ratioUnder26: number; ratio26Plus: number; termMultiplier: number };
  ltir: { minDays: number; minGames: number; inSeasonReturnReliefCap: number };
  playoffCap: boolean;
  rosterMax: number;
  contractLimit: number;
  escrowCapPct: number;
  thirtyFivePlusAge: number;
  offseasonOveragePct: number;
  injuryReserveDays: number;
  /** Provenance of each field, for display ("why is this the rule?"). */
  sources: Record<string, string>;
}

export interface StaticRules {
  elcMaxCompensationByDraftYear: Record<string, number>;
  elcTermByAge: Record<string, number>;
  elcSignatureBonusMaxPct: number;
  elcScheduleABonusMax: number;
  elcSlide: { ages: number[]; maxNhlGames: number };
  waiverExemption: {
    skater: Record<string, [number, number]>;
    goalie: Record<string, [number, number]>;
    earlyGames: { games: number; skaterYears: number; goalieYears: number };
  };
  arbitrationEligibility: Record<string, number>;
  freeAgency: {
    ufaAge: number;
    ufaAccruedSeasons: number;
    accruedSeasonGames: number;
    group6Age: number;
    group6ProSeasons: number;
    group6MaxGamesSkater: number;
    group6MaxGamesGoalie: number;
    group5ProSeasons: number;
  };
}

interface RawRules {
  elcMaxCompensationByDraftYear: Record<string, number | string>;
  elcTermByAge: Record<string, number | string>;
  elcSignatureBonusMaxPct: { value: number };
  elcScheduleABonusMax: { value: number };
  elcSlide: { ages: number[]; maxNhlGames: number };
  waiverExemption: StaticRules['waiverExemption'];
  arbitrationEligibility: Record<string, number | string>;
  freeAgency: StaticRules['freeAgency'];
  seasons: Record<string, RawSeason>;
  projection: { annualGrowth: number };
}

const numericEntries = (o: Record<string, number | string>) => Object.fromEntries(Object.entries(o).filter(([k, v]) => !k.startsWith('_') && typeof v === 'number')) as Record<string, number>;

let raw: RawRules = RULES_JSON as unknown as RawRules;
let cache = new Map<number, LeagueFinancialRules>();

/** Replace the rules database (tests, modding, or a refreshed rules.json). */
export function loadRules(data: unknown): void {
  raw = data as RawRules;
  cache = new Map();
}

export const STATIC: () => StaticRules = () => ({
  elcMaxCompensationByDraftYear: numericEntries(raw.elcMaxCompensationByDraftYear),
  elcTermByAge: numericEntries(raw.elcTermByAge),
  elcSignatureBonusMaxPct: raw.elcSignatureBonusMaxPct.value,
  elcScheduleABonusMax: raw.elcScheduleABonusMax.value,
  elcSlide: raw.elcSlide,
  waiverExemption: raw.waiverExemption,
  arbitrationEligibility: numericEntries(raw.arbitrationEligibility),
  freeAgency: raw.freeAgency,
});

function seasonKeys(): number[] {
  return Object.keys(raw.seasons)
    .map(Number)
    .sort((a, b) => a - b);
}

/** Resolved rules for a season start year (e.g. 2026 for 2026-27). */
export function rulesFor(season: number): LeagueFinancialRules {
  const hit = cache.get(season);
  if (hit) return hit;
  const keys = seasonKeys();
  const first = keys[0];
  const last = keys[keys.length - 1];
  const target = Math.max(first, season);
  // Merge every season up to the target (inheritance).
  const merged: RawSeason = {};
  const sources: Record<string, string> = {};
  for (const k of keys) {
    if (k > target) break;
    const s = raw.seasons[String(k)];
    for (const [field, val] of Object.entries(s)) {
      (merged as Record<string, unknown>)[field] = val;
      if (val && typeof val === 'object' && 'source' in (val as object)) sources[field] = (val as { source: string }).source;
    }
  }
  const req = <T>(v: T | undefined, name: string): T => {
    if (v === undefined) throw new Error(`rules.json: missing ${name}`);
    return v;
  };
  // Projection beyond the table: grow money figures.
  const yearsBeyond = Math.max(0, season - last);
  const g = Math.pow(1 + raw.projection.annualGrowth, yearsBeyond);
  const grow = (x: number) => Math.round((x * g) / 100) * 100;
  const growFine = (x: number) => Math.round(x * g * 10) / 10;
  const upper = grow(req(merged.upperLimit, 'upperLimit').value);
  const qo = req(merged.qualifyingOffer, 'qualifyingOffer');
  const os = req(merged.offerSheetTiers, 'offerSheetTiers');
  const arb = req(merged.arbitration, 'arbitration');
  const als = growFine(req(merged.averageLeagueSalary, 'averageLeagueSalary').value);
  const projected = yearsBeyond > 0 || ['upperLimit', 'lowerLimit', 'averageLeagueSalary'].some((f) => (sources[f] ?? '').startsWith('PROJECTED'));
  if (yearsBeyond > 0) for (const f of ['upperLimit', 'lowerLimit', 'minimumSalary', 'averageLeagueSalary', 'offerSheetTiers', 'arbitration']) sources[f] = `PROJECTED (${raw.projection.annualGrowth * 100}% growth from ${last})`;
  const ltir = req(merged.ltir, 'ltir');
  const rules: LeagueFinancialRules = {
    season,
    label: `${season}-${String((season + 1) % 100).padStart(2, '0')}`,
    ruleset: merged.ruleset ?? 'CBA2013',
    projected,
    upperLimit: upper,
    lowerLimit: grow(req(merged.lowerLimit, 'lowerLimit').value),
    minimumSalary: yearsBeyond > 0 ? Math.round((req(merged.minimumSalary, 'minimumSalary').value * g) / 25) * 25 : req(merged.minimumSalary, 'minimumSalary').value,
    averageLeagueSalary: als,
    maxSalary: Math.floor(upper * req(merged.maxSalaryPctOfUpper, 'maxSalaryPctOfUpper').value),
    maxTermOwnTeam: req(merged.maxTermOwnTeam, 'maxTermOwnTeam').value,
    maxTermExternal: req(merged.maxTermExternal, 'maxTermExternal').value,
    salaryVariance: req(merged.salaryVariance, 'salaryVariance'),
    signingBonusMaxPctOfTotal: merged.signingBonusMaxPctOfTotal?.value ?? null,
    qualifyingOffer: { ...qo, tiers: qo.tiers.map(([t, m]) => [t === null ? null : growFine(t), m] as [number | null, number]), tier2Cap: growFine(qo.tier2Cap) },
    offerSheetTiers: { ...os, tiers: os.tiers.map(([t, picks]) => [t === null ? null : growFine(t), picks] as [number | null, string[]]) },
    arbitration: { clubElectThreshold: growFine(arb.clubElectThreshold), walkAwayThreshold: growFine(arb.walkAwayThreshold) },
    buriedAllowance: req(merged.buriedAllowance, 'buriedAllowance').value,
    bonusCushionPct: req(merged.bonusCushionPct, 'bonusCushionPct').value,
    retention: req(merged.retention, 'retention'),
    buyout: req(merged.buyout, 'buyout'),
    ltir: { minDays: ltir.minDays, minGames: ltir.minGames, inSeasonReturnReliefCap: ltir.inSeasonReturnReliefCap === 'averageLeagueSalary' ? als : Number(ltir.inSeasonReturnReliefCap) },
    playoffCap: req(merged.playoffCap, 'playoffCap').value,
    rosterMax: req(merged.rosterMax, 'rosterMax').value,
    contractLimit: req(merged.contractLimit, 'contractLimit').value,
    escrowCapPct: merged.escrowCapPct?.value ?? 0,
    thirtyFivePlusAge: req(merged.thirtyFivePlusAge, 'thirtyFivePlusAge').value,
    offseasonOveragePct: merged.offseasonOveragePct?.value ?? 0.1,
    injuryReserveDays: merged.injuryReserveDays?.value ?? 7,
    sources,
  };
  cache.set(season, rules);
  return rules;
}

/** Maximum ELC compensation (salary + signing bonus per year) for a draft/signing year. */
export function elcMaxFor(year: number): number {
  const t = STATIC().elcMaxCompensationByDraftYear;
  const keys = Object.keys(t).map(Number).sort((a, b) => a - b);
  if (t[String(year)] !== undefined) return t[String(year)];
  if (year < keys[0]) return t[String(keys[0])];
  // Beyond the table: minimum salary + $175K (MOU2025 formula).
  return rulesFor(year).minimumSalary + 175;
}
