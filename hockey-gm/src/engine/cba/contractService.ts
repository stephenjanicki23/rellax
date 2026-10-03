/**
 * ContractService: the only place contracts are created, registered,
 * extended or ended. Contracts are stored on the player (p.contract, with a
 * signed extension in p.contract.next) and every contract is also appended to
 * p.contractHistory. All validation goes through the NHLRulesEngine and the
 * CapManager so humans and AI GMs play by the same rules.
 */
import type { Contract, ContractClause, League, Player } from '../types';
import { addNews, addTransaction, teamName } from '../league/helpers';
import { fullName } from '../player/ability';
import { aav, buildContract, contractStructureErrors, endOf, flatTerms, refreshContract, termOf, totalValue, yearsOf, type ContractTerms } from './contract';
import { CapManager, contractStartSeason } from './capManager';
import { determineFreeAgentStatus } from './rulesEngine';
import { rulesFor } from './rules';

export function formatMoney(k: number): string {
  if (Math.abs(k) >= 1000) return `$${(k / 1000).toFixed(Math.abs(k) >= 10000 ? 1 : 2)}M`;
  return `$${Math.round(k)}K`;
}

/** "7 yr / $70.0M ($10.00M AAV)" */
export function formatTerms(c: Contract): string {
  return `${termOf(c)} yr / ${formatMoney(totalValue(c))} (${formatMoney(aav(c))} AAV)`;
}

/** Team that holds this player's re-signing rights ("own team" for the longer max term). */
export function rightsHolder(p: Player): number | null {
  if (p.teamId !== null) return p.teamId;
  if (p.rightsTeamId !== null) return p.rightsTeamId;
  const last = p.contractHistory?.[p.contractHistory.length - 1];
  return last?.teamId ?? null;
}

export function isOwnTeam(p: Player, teamId: number): boolean {
  return rightsHolder(p) === teamId;
}

export interface SignResult {
  ok: boolean;
  errors: string[];
  contract?: Contract;
  message: string;
}

export interface RegisterOptions {
  origin: NonNullable<Contract['origin']>;
  /** Skip legality checks (imports / league creation). */
  skipValidation?: boolean;
  /** Skip the cap-room check only (e.g. arbitration awards, which bind the team). */
  skipCapCheck?: boolean;
  /** Signed while the current contract still runs: becomes p.contract.next. */
  extension?: boolean;
  /** Assign straight to the minors (prospects / two-way depth). */
  toMinors?: boolean;
  announce?: boolean;
  note?: string;
}

function nextContractId(league: League): number {
  league.nextContractId = (league.nextContractId ?? 1) + 1;
  return league.nextContractId - 1;
}

/** Check whether a contract could legally be registered (no side effects). */
export function checkContract(league: League, p: Player, teamId: number, c: Contract, opts: Pick<RegisterOptions, 'extension' | 'toMinors' | 'skipCapCheck'> = {}): string[] {
  const signingSeason = contractStartSeason(league) === league.season ? league.season : league.phase === 'draft' ? league.season : league.season + 1;
  const errors = contractStructureErrors(c, {
    ownTeam: isOwnTeam(p, teamId),
    signingSeason: opts.extension ? league.season : signingSeason,
    age: yearsOf(c)[0].season - p.birthYear,
    elcYear: p.draft?.season ?? yearsOf(c)[0].season,
  });
  // Contract limit (50 SPCs).
  const r = rulesFor(yearsOf(c)[0].season);
  const org = Object.values(league.players).filter((x) => x.teamId === teamId && x.contract && (x.status === 'active' || x.status === 'prospect') && x.id !== p.id).length;
  if (org >= r.contractLimit) errors.push(`Contract rejected: ${teamName(league, teamId)} already has ${org} contracts (limit ${r.contractLimit}).`);
  if (!opts.skipCapCheck && !opts.extension) {
    const cap = CapManager.canRegisterContract(league, teamId, c, { replacingPlayerId: p.teamId === teamId ? p.id : undefined, toMinors: opts.toMinors });
    errors.push(...cap.errors);
  }
  if (opts.extension) {
    // Extensions are registered against the first season they cover.
    const cap = CapManager.canRegisterContract(league, teamId, c, {});
    if (!cap.ok && rulesFor(yearsOf(c)[0].season).projected === false) errors.push(...cap.errors.map((e) => e.replace('Contract rejected', 'Extension rejected')));
  }
  return [...new Set(errors)];
}

/** Register a contract for a player with a team (signing, re-signing, extension, ELC...). */
export function registerContract(league: League, p: Player, teamId: number, c: Contract, opts: RegisterOptions): SignResult {
  if (!opts.skipValidation) {
    const errors = checkContract(league, p, teamId, c, opts);
    if (errors.length) return { ok: false, errors, message: errors[0] };
  }
  c.id = nextContractId(league);
  c.signingTeamId = teamId;
  c.signedSeason = league.season;
  c.signedDay = league.day;
  c.origin = opts.origin;
  c.source ??= 'game';
  c.expiryStatus = projectedExpiry(p, c);
  refreshContract(c, Math.max(league.season, yearsOf(c)[0].season));
  if (p.firstSpcAge === undefined) {
    p.firstSpcAge = yearsOf(c)[0].season - p.birthYear;
    p.firstSpcSeason = yearsOf(c)[0].season;
  }
  if (opts.extension && p.contract && p.teamId === teamId) {
    p.contract.next = c;
  } else {
    p.contract = c;
    p.teamId = teamId;
    p.rightsTeamId = null;
    p.rfa = false;
    if (opts.toMinors) p.status = 'prospect';
    else if (p.status === 'fa' || p.status === 'draft') p.status = 'active';
  }
  (p.contractHistory ??= []).push({
    teamId,
    signingTeamId: teamId,
    startSeason: yearsOf(c)[0].season,
    endSeason: endOf(c),
    years: termOf(c),
    totalValue: totalValue(c),
    aav: aav(c),
    type: c.type,
    origin: c.origin,
    source: c.source,
    note: opts.note,
  });
  const verb = { signing: 'sign', extension: 'extend', arbitration: 'are awarded', offerSheet: 'sign (offer sheet)', qualifyingOffer: 're-sign (qualifying offer)', elc: 'sign (entry-level)', import: 'hold' }[opts.origin];
  if (opts.announce !== false && opts.origin !== 'import') {
    const kind = opts.origin === 'extension' ? 'extension' : opts.origin === 'arbitration' ? 'arbitration' : opts.origin === 'offerSheet' ? 'offerSheet' : opts.origin === 'qualifyingOffer' ? 'qualifyingOffer' : opts.origin === 'elc' ? 'elc' : 'signing';
    addTransaction(league, { kind, teamIds: [teamId], playerIds: [p.id], description: `${teamName(league, teamId)} ${verb} ${fullName(p)} (${p.pos}): ${formatTerms(c)}${c.clauses?.length ? ` · ${c.clauses.map((x) => x.kind).join('/')}` : ''}` });
    if (p.reputation >= 50 && opts.origin !== 'elc') addNews(league, { category: 'signing', headline: `${fullName(p)} ${opts.origin === 'extension' ? 'signs a' : 'agrees to a'} ${termOf(c)}-year, ${formatMoney(totalValue(c))} ${opts.origin === 'extension' ? 'extension' : 'contract'} with ${teamName(league, teamId)}`, teamIds: [teamId], playerIds: [p.id], importance: p.reputation >= 65 ? 4 : 3 });
  }
  return { ok: true, errors: [], contract: c, message: `${fullName(p)} signs: ${formatTerms(c)}.` };
}

/** Free-agent status the player would have when this contract ends. */
export function projectedExpiry(p: Player, c: Contract): 'RFA' | 'UFA' {
  const end = endOf(c);
  return determineFreeAgentStatus(p, end).status;
}

export interface OfferTerms {
  aav: number;
  years: number;
  /** Optional explicit year-by-year salaries (must match `years`). */
  salaries?: number[];
  signingBonuses?: number[];
  clauses?: ContractClause['kind'] | null;
  twoWay?: boolean;
  type?: Contract['type'];
  perfBonuses?: number[];
}

/** Turn simple offer terms into a contract starting at the right league year. */
export function contractFromOffer(league: League, p: Player, t: OfferTerms, opts: { start?: number } = {}): Contract {
  const start = opts.start ?? contractStartSeason(league);
  const terms: ContractTerms = t.salaries
    ? { startSeason: start, salaries: t.salaries, signedSeason: league.season }
    : flatTerms(t.aav, t.years, start, { signedSeason: league.season });
  if (t.signingBonuses) terms.signingBonuses = t.signingBonuses;
  if (t.perfBonuses) terms.perfBonuses = t.perfBonuses;
  terms.type = t.type ?? 'standard';
  terms.twoWay = t.twoWay ?? false;
  terms.ageAtStart = start - p.birthYear;
  if (t.clauses) terms.clauses = [{ kind: t.clauses, from: start, to: start + t.years - 1, ...(t.clauses === 'M-NTC' ? { teams: 10, mode: 'block' as const } : {}) }];
  return buildContract(terms, Math.max(league.season, start));
}

/** Convenience: build + register from offer terms. */
export function signFromOffer(league: League, p: Player, teamId: number, t: OfferTerms, opts: Omit<RegisterOptions, 'origin'> & { origin?: RegisterOptions['origin'] } = {}): SignResult {
  const start = opts.extension && p.contract ? endOf(p.contract) + 1 : contractStartSeason(league);
  const c = contractFromOffer(league, p, t, { start });
  return registerContract(league, p, teamId, c, { ...opts, origin: opts.origin ?? (opts.extension ? 'extension' : 'signing') });
}

/**
 * Roll contracts into a new league year: expired deals give way to signed
 * extensions; flat fields are refreshed for the new season. Expired contracts
 * without an extension stay attached (years = 0) until free agency decides.
 */
export function advanceContracts(league: League, newSeason: number): void {
  for (const p of Object.values(league.players)) {
    const c = p.contract;
    if (!c || p.status === 'retired') continue;
    if (endOf(c) < newSeason && c.next) {
      p.contract = c.next;
    }
    refreshContract(p.contract!, newSeason);
  }
}

/** End a player's contract (release/termination); the caller handles dead cap. */
export function endContract(p: Player): void {
  p.contract = null;
}
