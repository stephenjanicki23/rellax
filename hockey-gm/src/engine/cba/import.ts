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
import type { CapCharge, Contract, ContractClause, ContractHistoryEntry, League, Player, Team } from '../types';
import { buildContract, contractStructureErrors, isThirtyFivePlus, refreshContract, yearsOf } from './contract';
import { STATIC, elcMaxFor, rulesFor } from './rules';

/** One contract as written by scripts/fetch-contracts.mjs. */
export interface ImportedContract {
  type: 'ELC' | 'standard';
  extension?: boolean;
  signingTeamAbbr: string | null;
  signingDate?: string | null;
  signedSeason: number;
  expiryStatus?: 'RFA' | 'UFA';
  arbitrationAtExpiry?: boolean;
  /** Official cap hit (excluding performance bonuses), thousands. */
  capHit: number | null;
  totalValue?: number | null;
  twoWay?: boolean;
  years: { season: number; salary: number; signingBonus?: number; perfBonus?: number; minorSalary?: number }[];
  clauses?: { kind: ContractClause['kind']; from: number; to: number; teams?: number; mode?: 'block' | 'approve' }[];
  retained?: { teamAbbr: string; pct: number }[];
  boughtOut?: boolean;
  qualifyingOffer?: number | null;
}

/** A player's contract record: every contract (history, current, signed extensions). */
export interface ImportedPlayer {
  nhlId: number;
  slug?: string;
  name: string;
  teamAbbr: string | null;
  /** CapWages status: NHL, Minor, IR, LTIR, Loan, ... */
  status?: string | null;
  born?: string | null;
  pos?: string | null;
  shoots?: string | null;
  nationality?: string | null;
  number?: number | null;
  waiversExempt?: boolean;
  slideCandidate?: boolean;
  firstSpcAge?: number;
  firstSpcSeason?: number;
  careerGames?: number;
  contracts: ImportedContract[];
}

export interface ImportedCharge {
  teamAbbr: string;
  season: number;
  amount: number;
  kind: CapCharge['kind'];
  playerName: string;
  nhlId?: number;
  note?: string;
}

interface ContractsFile {
  schemaVersion: number;
  asOf: string | null;
  source: string;
  players?: ImportedPlayer[];
}

let contractsDb = CONTRACTS_JSON as unknown as ContractsFile;
let deadCapDb = DEAD_CAP_JSON as unknown as { charges: ImportedCharge[] };
let index: Map<number, ImportedPlayer> | null = null;

/** Swap in a different contracts database (tests / refreshed data). */
export function loadContractDatabase(contracts: unknown, deadCap?: unknown): void {
  contractsDb = contracts as ContractsFile;
  index = null;
  if (deadCap) deadCapDb = deadCap as { charges: ImportedCharge[] };
}

export function contractDbInfo(): { count: number; asOf: string | null; source: string } {
  return { count: (contractsDb.players ?? []).length, asOf: contractsDb.asOf, source: contractsDb.source };
}

export function importedPlayer(nhlId: number | undefined): ImportedPlayer | undefined {
  if (nhlId === undefined) return undefined;
  index ??= new Map((contractsDb.players ?? []).map((r) => [r.nhlId, r]));
  return index.get(nhlId);
}

export function importedPlayers(): ImportedPlayer[] {
  return contractsDb.players ?? [];
}

/** Build a Contract from one imported contract. */
export function contractFromImport(rec: ImportedContract, teams: Team[], season: number, p: Player, holderAbbr: string | null): Contract {
  const byAbbr = (a?: string | null) => (a ? (teams.find((t) => t.abbr === a)?.id ?? null) : null);
  const ys = [...rec.years].sort((a, b) => a.season - b.season);
  const c = buildContract(
    {
      startSeason: ys[0].season,
      salaries: ys.map((y) => y.salary),
      signingBonuses: ys.map((y) => y.signingBonus ?? 0),
      perfBonuses: ys.map((y) => y.perfBonus ?? 0),
      minorSalaries: ys.some((y) => y.minorSalary !== undefined) ? ys.map((y) => y.minorSalary ?? y.salary) : undefined,
      type: rec.type ?? 'standard',
      twoWay: rec.twoWay ?? false,
      clauses: rec.clauses ?? [],
      signingTeamId: byAbbr(rec.signingTeamAbbr ?? holderAbbr),
      signedSeason: rec.signedSeason ?? ys[0].season - 1,
      source: 'real',
      origin: rec.type === 'ELC' ? 'elc' : 'import',
      ageAtStart: ys[0].season - p.birthYear,
    },
    season,
  );
  if (rec.capHit !== null && rec.capHit !== undefined && rec.capHit > 0) c.capHitOverride = rec.capHit;
  if (rec.signingDate) c.signingDate = rec.signingDate;
  c.retained = (rec.retained ?? []).map((r) => ({ teamId: byAbbr(r.teamAbbr) ?? -1, pct: r.pct, season })).filter((r) => r.teamId >= 0 && r.teamId !== byAbbr(holderAbbr));
  if (rec.expiryStatus) c.expiryStatus = rec.expiryStatus;
  refreshContract(c, season);
  return c;
}

const signDay = (c: ImportedContract) => {
  const d = parseBorn(c.signingDate);
  return d ? d.year * 400 + d.month * 32 + d.day : 0;
};
const endSeason = (c: ImportedContract) => Math.max(...c.years.map((y) => y.season));
const startSeason = (c: ImportedContract) => Math.min(...c.years.map((y) => y.season));

/**
 * The contracts a player holds at `season`: the one in force (or the next
 * one starting, for a player between deals), a signed extension, and his
 * past contracts as history entries.
 */
export function playerContractsFromImport(rec: ImportedPlayer, teams: Team[], season: number, p: Player): { current: Contract | null; next: Contract | null; history: ContractHistoryEntry[] } {
  const byAbbr = (a?: string | null) => (a ? (teams.find((t) => t.abbr === a)?.id ?? null) : null);
  const live = rec.contracts.filter((c) => !c.boughtOut && c.years.length && endSeason(c) >= season).sort((a, b) => startSeason(a) - startSeason(b));
  // Several deals can overlap a season (e.g. an old contract ended by a trade/termination and a new one signed): the latest signing wins.
  const covering = live.filter((c) => startSeason(c) <= season).sort((a, b) => a.signedSeason - b.signedSeason || startSeason(a) - startSeason(b) || signDay(a) - signDay(b));
  const curRec = covering[covering.length - 1] ?? live[0] ?? null;
  const nextRec = curRec ? (live.find((c) => c !== curRec && startSeason(c) > endSeason(curRec)) ?? null) : null;
  const current = curRec ? contractFromImport(curRec, teams, season, p, rec.teamAbbr) : null;
  const next = nextRec ? contractFromImport(nextRec, teams, season, p, rec.teamAbbr) : null;
  if (current && next) current.next = next;
  const history: ContractHistoryEntry[] = rec.contracts
    .filter((c) => c.years.length)
    .sort((a, b) => startSeason(a) - startSeason(b))
    .map((c) => {
      const total = c.totalValue ?? c.years.reduce((s, y) => s + y.salary + (y.signingBonus ?? 0), 0);
      return {
        teamId: byAbbr(c.signingTeamAbbr),
        signingTeamId: byAbbr(c.signingTeamAbbr),
        startSeason: startSeason(c),
        endSeason: endSeason(c),
        years: c.years.length,
        totalValue: total,
        aav: c.capHit ?? total / c.years.length,
        type: c.type,
        origin: c.type === 'ELC' ? 'elc' : 'import',
        source: 'real',
        note: [c.extension ? 'extension' : '', c.signingDate ? `signed ${c.signingDate}` : '', c.boughtOut ? 'bought out' : ''].filter(Boolean).join(' · ') || undefined,
      } as ContractHistoryEntry;
    });
  return { current, next, history };
}

/** Dead-cap charges from the data file mapped onto team ids. */
export function importedDeadCap(teams: Team[], nextId: () => number, fromSeason = -Infinity): CapCharge[] {
  const out: CapCharge[] = [];
  for (const ch of deadCapDb.charges ?? []) {
    const t = teams.find((x) => x.abbr === ch.teamAbbr);
    if (!t || ch.season < fromSeason) continue;
    out.push({ id: nextId(), teamId: t.id, season: ch.season, amount: ch.amount, kind: ch.kind, playerName: ch.playerName, note: ch.note });
  }
  return out;
}

/** Parse "May. 25, 1996" → { year, month, day }. */
export function parseBorn(s: string | null | undefined): { year: number; month: number; day: number } | null {
  const m = String(s ?? '').match(/([A-Z][a-z]{2})\w*\.? (\d+), (\d{4})/);
  if (!m) return null;
  const months: Record<string, number> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  return { year: Number(m[3]), month: months[m[1]] ?? 1, day: Number(m[2]) };
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
