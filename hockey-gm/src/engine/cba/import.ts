/**
 * Contract database import and contract estimation.
 *
 * Real contracts come from data/contracts/contracts.json (keyed by NHL player
 * id) and existing dead-cap charges from data/transactions/dead_cap.json.
 * Players without a real contract get a structurally realistic estimate
 * flagged source: 'estimated' (term remaining, ELC rules, clauses, two-way
 * status, 35+), so the data can be refreshed without code changes.
 */
import CONTRACTS_JSON from '../../../data/contracts/contracts.json';
import DEAD_CAP_JSON from '../../../data/transactions/dead_cap.json';
import type { Rng } from '../core/rng';
import { clamp } from '../core/math';
import type { CapCharge, Contract, ContractClause, League, Player, Team } from '../types';
import { buildContract, contractStructureErrors, isThirtyFivePlus, yearsOf } from './contract';
import { STATIC, elcMaxFor, rulesFor } from './rules';

export interface ImportedContract {
  nhlId: number;
  teamAbbr: string;
  signingTeamAbbr?: string;
  type?: 'ELC' | 'standard';
  twoWay?: boolean;
  signedSeason?: number;
  years: { season: number; salary: number; signingBonus?: number; perfBonus?: number; minorSalary?: number }[];
  clauses?: { kind: ContractClause['kind']; from: number; to: number; teams?: number; mode?: 'block' | 'approve' }[];
  retained?: { teamAbbr: string; pct: number }[];
  expiryStatus?: 'RFA' | 'UFA';
  firstSpcAge?: number;
  firstSpcSeason?: number;
}

export interface ImportedCharge {
  teamAbbr: string;
  season: number;
  amount: number;
  kind: CapCharge['kind'];
  playerName: string;
  note?: string;
}

interface ContractsFile {
  schemaVersion: number;
  asOf: string | null;
  source: string;
  contracts: ImportedContract[];
}

let contractsDb = CONTRACTS_JSON as unknown as ContractsFile;
let deadCapDb = DEAD_CAP_JSON as unknown as { charges: ImportedCharge[] };

/** Swap in a different contracts database (tests / refreshed data). */
export function loadContractDatabase(contracts: unknown, deadCap?: unknown): void {
  contractsDb = contracts as ContractsFile;
  if (deadCap) deadCapDb = deadCap as { charges: ImportedCharge[] };
}

export function contractDbInfo(): { count: number; asOf: string | null; source: string } {
  return { count: contractsDb.contracts.length, asOf: contractsDb.asOf, source: contractsDb.source };
}

export function importedContract(nhlId: number | undefined): ImportedContract | undefined {
  if (nhlId === undefined) return undefined;
  return contractsDb.contracts.find((c) => c.nhlId === nhlId);
}

/** Build a Contract from an imported record. */
export function contractFromImport(rec: ImportedContract, teams: Team[], season: number, p: Player): Contract {
  const byAbbr = (a?: string) => (a ? (teams.find((t) => t.abbr === a)?.id ?? null) : null);
  const ys = [...rec.years].sort((a, b) => a.season - b.season);
  const c = buildContract(
    {
      startSeason: ys[0].season,
      salaries: ys.map((y) => y.salary),
      signingBonuses: ys.map((y) => y.signingBonus ?? 0),
      perfBonuses: ys.map((y) => y.perfBonus ?? 0),
      minorSalaries: ys.some((y) => y.minorSalary !== undefined) ? ys.map((y) => y.minorSalary ?? 0) : undefined,
      type: rec.type ?? 'standard',
      twoWay: rec.twoWay ?? false,
      clauses: rec.clauses ?? [],
      signingTeamId: byAbbr(rec.signingTeamAbbr ?? rec.teamAbbr),
      signedSeason: rec.signedSeason ?? ys[0].season - 1,
      source: 'real',
      origin: 'import',
      ageAtStart: ys[0].season - p.birthYear,
    },
    season,
  );
  c.retained = (rec.retained ?? []).map((r) => ({ teamId: byAbbr(r.teamAbbr) ?? -1, pct: r.pct, season })).filter((r) => r.teamId >= 0);
  if (rec.expiryStatus) c.expiryStatus = rec.expiryStatus;
  return c;
}

/** Dead-cap charges from the data file mapped onto team ids. */
export function importedDeadCap(teams: Team[], nextId: () => number): CapCharge[] {
  const out: CapCharge[] = [];
  for (const ch of deadCapDb.charges ?? []) {
    const t = teams.find((x) => x.abbr === ch.teamAbbr);
    if (!t) continue;
    out.push({ id: nextId(), teamId: t.id, season: ch.season, amount: ch.amount, kind: ch.kind, playerName: ch.playerName, note: ch.note });
  }
  return out;
}

export interface EstimateContext {
  season: number;
  /** Market value (cap hit) for this player now, thousands. */
  marketValue: number;
  /** Seasons left including the current one. */
  yearsLeft: number;
  /** On an entry-level deal right now. */
  elc: boolean;
  teamId: number;
}

/**
 * Typical first-contract age for a player: real players derive it from their
 * professional seasons; prospects sign at 18-20.
 */
export function estimateFirstSpcAge(p: Player, season: number): number {
  const age = season - p.birthYear;
  return clamp(age - Math.max(0, p.proSeasons), 18, 24);
}

/** Pre-save NHL experience estimate (games and accrued seasons before this league began). */
export function estimatePriorExperience(p: Player, season: number, knownSeasons: { gp: number }[] = []): { games: number; accrued: number } {
  const known = knownSeasons.reduce((s, x) => s + x.gp, 0);
  const knownAccrued = knownSeasons.filter((x) => x.gp >= STATIC().freeAgency.accruedSeasonGames).length;
  const age = season - p.birthYear;
  const earlier = Math.max(0, Math.min(p.proSeasons, age - 18) - knownSeasons.length);
  // Typical games per earlier season by current ability (rough).
  const perSeason = p.status === 'prospect' ? 6 : clamp(Math.round(20 + (p.ca - 100) * 0.9), 10, 78);
  const gp = known + earlier * perSeason;
  const accrued = knownAccrued + (perSeason >= 40 ? earlier : 0);
  return { games: gp, accrued };
}

/**
 * A realistic contract for a player already under contract when the league
 * starts. Structure respects the rules in force when it was signed.
 */
export function estimateContract(rng: Rng, p: Player, ctx: EstimateContext): Contract {
  const age = ctx.season - p.birthYear;
  const r = rulesFor(ctx.season);
  if (ctx.elc) {
    const spcAge = p.firstSpcAge ?? clamp(age - 1, 18, 24);
    const term = STATIC().elcTermByAge[String(Math.min(24, Math.max(18, spcAge)))] ?? 3;
    const elapsed = clamp(term - ctx.yearsLeft, 0, term - 1);
    const start = ctx.season - elapsed;
    const max = elcMaxFor(start);
    const minS = rulesFor(start).minimumSalary;
    const comp = clamp(Math.round(minS + (max - minS) * clamp((p.pa - 110) / 70, 0, 1)), minS, max);
    const sb = Math.round(comp * 0.1 * clamp((p.pa - 130) / 40, 0, 1));
    const perf = p.pa >= 155 ? STATIC().elcScheduleABonusMax : p.pa >= 140 ? 400 : 0;
    const c = buildContract(
      { startSeason: start, salaries: new Array(term).fill(comp - sb), signingBonuses: new Array(term).fill(sb), perfBonuses: new Array(term).fill(perf), minorSalaries: new Array(term).fill(80), type: 'ELC', twoWay: true, signedSeason: start - 1, source: 'estimated', origin: 'elc', signingTeamId: ctx.teamId, ageAtStart: start - p.birthYear },
      ctx.season,
    );
    p.firstSpcAge ??= start - p.birthYear;
    p.firstSpcSeason ??= start;
    return c;
  }
  const yearsLeft = clamp(ctx.yearsLeft, 1, 8);
  // How long the deal was: longer for prime-age stars.
  const longTerm = p.ca >= 150 && age <= 31 ? rng.int(5, 8) : p.ca >= 135 ? rng.int(2, 5) : rng.int(1, 3);
  const term = clamp(Math.max(yearsLeft, longTerm), yearsLeft, 8);
  const start = ctx.season - (term - yearsLeft);
  const signRules = rulesFor(Math.max(start, 2025));
  const capAtSigning = rulesFor(start).upperLimit;
  // Value at signing scaled to the cap environment of that year.
  const aavAtSigning = clamp((ctx.marketValue * capAtSigning) / r.upperLimit, rulesFor(start).minimumSalary, rulesFor(start).maxSalary);
  const salaries: number[] = [];
  const bonuses: number[] = [];
  const bonusy = aavAtSigning >= 6000 && term >= 4;
  for (let i = 0; i < term; i++) {
    // Mild front-loading on big deals, kept inside the variance rules.
    const tilt = bonusy ? 1 + (signRules.salaryVariance.adjacentPctOfFirstYear * 0.4) * ((term - 1) / 2 - i) / Math.max(1, term - 1) : 1;
    const comp = Math.max(rulesFor(start + i).minimumSalary, Math.round((aavAtSigning * tilt) / 5) * 5);
    const sb = bonusy ? Math.round((comp * 0.45) / 5) * 5 : 0;
    salaries.push(comp - sb);
    bonuses.push(sb);
  }
  const twoWay = aavAtSigning < rulesFor(start).minimumSalary * 1.5 && age <= 26;
  const clauses: ContractClause[] = [];
  const ufaAtSigning = start - p.birthYear >= 27;
  if (ufaAtSigning && p.ca >= 158) clauses.push({ kind: 'NMC', from: start, to: start + term - 1 });
  else if (ufaAtSigning && p.ca >= 148) clauses.push({ kind: rng.chance(0.5) ? 'NTC' : 'M-NTC', from: start, to: start + term - 1, ...(rng.chance(0.5) ? { teams: rng.pick([8, 10, 12, 15]), mode: 'block' as const } : {}) });
  else if (ufaAtSigning && p.ca >= 140 && term >= 3 && rng.chance(0.35)) clauses.push({ kind: 'M-NTC', from: start + 1, to: start + term - 1, teams: rng.pick([8, 10, 12]), mode: 'block' });
  const c = buildContract(
    { startSeason: start, salaries, signingBonuses: bonuses, type: 'standard', twoWay, clauses: clauses.filter((x) => x.from <= x.to), signedSeason: start - 1, source: 'estimated', origin: 'signing', signingTeamId: ctx.teamId, ageAtStart: start - p.birthYear },
    ctx.season,
  );
  c.thirtyFivePlus = isThirtyFivePlus(c, start - p.birthYear);
  // Safety: if the estimate breaks a structural rule, fall back to a flat deal.
  if (contractStructureErrors(c, { ownTeam: true, signingSeason: Math.max(start, yearsOf(c)[0].season), age: start - p.birthYear }).some((e) => !e.includes('limited to'))) {
    const flat = Math.round(aavAtSigning / 5) * 5;
    return buildContract({ startSeason: start, salaries: new Array(term).fill(flat), type: 'standard', twoWay, clauses, signedSeason: start - 1, source: 'estimated', origin: 'signing', signingTeamId: ctx.teamId, ageAtStart: start - p.birthYear }, ctx.season);
  }
  return c;
}

/** League-level containers for the financial system (new leagues and migrations). */
export function emptyFinancialState(): Pick<League, 'capLedger' | 'ltir' | 'waivers' | 'qualifyingOffers' | 'arbitration' | 'offerSheets' | 'negotiations' | 'nextContractId'> {
  return { capLedger: [], ltir: [], waivers: [], qualifyingOffers: [], arbitration: [], offerSheets: [], negotiations: {}, nextContractId: 1 };
}
