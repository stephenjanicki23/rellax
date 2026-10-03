/**
 * NHLRulesEngine: the single home of CBA logic. Pure functions over league
 * data; every rule reads the versioned rules database (rules.ts). UI and AI
 * code call these instead of re-implementing rules.
 */
import type { Contract, League, Player } from '../types';
import { STATIC, rulesFor } from './rules';
import { accruedSeasons, firstSpcAge, nhlGames, nhlGamesIn, proSeasonsSinceSpc } from './experience';
import { aav, cashIn, contractStructureErrors, fullCapHit, totalValue, yearIn, yearsOf, type ValidationContext } from './contract';

const fmt = (k: number) => (Math.abs(k) >= 1000 ? `$${(k / 1000).toFixed(Math.abs(k) >= 10000 ? 2 : 3).replace(/0+$/, '').replace(/\.$/, '')}M` : `$${Math.round(k)}K`);
export const fmtCap = fmt;

// ───────────────────────────── free agency status ─────────────────────────────

export type FaGroup = 'Group 1' | 'Group 2' | 'Group 3' | 'Group 5' | 'Group 6';

export interface FreeAgentStatus {
  status: 'RFA' | 'UFA';
  group: FaGroup;
  /** Plain-language reasons (shown to the GM). */
  reasons: string[];
  age: number;
  accrued: number;
  proSeasons: number;
  nhlGames: number;
}

/**
 * Free-agent classification for the offseason after `season` (i.e. entering
 * season + 1). Age is as of June 30 of that offseason (CBA Art. 10).
 */
export function determineFreeAgentStatus(p: Player, season: number, league?: Pick<League, 'seasonStats' | 'season'>): FreeAgentStatus {
  const fa = STATIC().freeAgency;
  const age = season + 1 - p.birthYear;
  const accrued = accruedSeasons(p);
  const pro = proSeasonsSinceSpc(p, season + 1);
  const gp = nhlGames(p, league);
  const goalie = p.pos === 'G';
  const base = { age, accrued, proSeasons: pro, nhlGames: gp };
  if (age >= fa.ufaAge) return { ...base, status: 'UFA', group: 'Group 3', reasons: [`Age ${age} on June 30 (UFA at ${fa.ufaAge}).`] };
  if (accrued >= fa.ufaAccruedSeasons) return { ...base, status: 'UFA', group: 'Group 3', reasons: [`${accrued} accrued seasons (UFA at ${fa.ufaAccruedSeasons}).`] };
  const g6Games = goalie ? fa.group6MaxGamesGoalie : fa.group6MaxGamesSkater;
  if (age >= fa.group6Age && pro >= fa.group6ProSeasons && gp < g6Games)
    return { ...base, status: 'UFA', group: 'Group 6', reasons: [`Group 6: age ${age}, ${pro} pro seasons and only ${gp} NHL games (under ${g6Games}).`] };
  const elc = p.contract?.type === 'ELC';
  return {
    ...base,
    status: 'RFA',
    group: elc ? 'Group 1' : 'Group 2',
    reasons: [`Age ${age} with ${accrued} accrued season${accrued === 1 ? '' : 's'} — restricted (UFA at age ${fa.ufaAge} or ${fa.ufaAccruedSeasons} accrued seasons).`],
  };
}

// ───────────────────────────── qualifying offers ─────────────────────────────

export interface QualifyingOfferCalc {
  previousSalary: number;
  previousAav: number;
  amount: number;
  oneWay: boolean;
  explanation: string;
}

/**
 * Qualifying offer for an RFA whose contract ends after `season` (CBA 10.2).
 * Based on the final-year base salary, tiered by the offer season's rules,
 * capped at 120% of the expiring contract's AAV, never below the minimum.
 */
export function calculateQualifyingOffer(p: Player, c: Contract, season: number, league?: Pick<League, 'seasonStats' | 'season'>): QualifyingOfferCalc {
  const next = rulesFor(season + 1);
  const r = next.qualifyingOffer;
  const last = yearIn(c, season) ?? yearsOf(c)[yearsOf(c).length - 1];
  const base = last.salary;
  const prevAav = aav(c);
  const steps: string[] = [`Final-year base salary ${fmt(base)}.`];
  let amount = base;
  for (const [ceiling, mult] of r.tiers) {
    if (ceiling === null || base <= ceiling) {
      amount = base * mult;
      steps.push(ceiling === null ? `Over the top tier: ${Math.round(mult * 100)}% of base.` : `Up to ${fmt(ceiling)}: ${Math.round(mult * 100)}% of base = ${fmt(amount)}.`);
      if (mult > 1 && mult < 1.1 && amount > r.tier2Cap) {
        amount = Math.max(base, r.tier2Cap);
        steps.push(`Middle tier capped at ${fmt(r.tier2Cap)}.`);
      }
      break;
    }
  }
  const aavCap = prevAav * r.aavCapPct;
  if (amount > aavCap) {
    amount = aavCap;
    steps.push(`Capped at ${Math.round(r.aavCapPct * 100)}% of the contract's AAV (${fmt(prevAav)}) = ${fmt(aavCap)} (2020 MOU).`);
  }
  if (amount < next.minimumSalary) {
    amount = next.minimumSalary;
    steps.push(`Raised to the ${next.label} league minimum ${fmt(next.minimumSalary)}.`);
  }
  const g3 = nhlGamesIn(p, season - 2, season, league);
  const g1 = nhlGamesIn(p, season, season, league);
  const oneWay = g3 >= r.oneWayGamesLast3 || g1 >= r.oneWayGamesLastSeason;
  steps.push(oneWay ? `One-way offer required (${g3} NHL games in the last three seasons / ${g1} last season).` : `Two-way offer allowed (${g3} NHL games in three seasons, ${g1} last season).`);
  return { previousSalary: base, previousAav: prevAav, amount: Math.round(amount * 1000) / 1000, oneWay, explanation: steps.join(' ') };
}

// ───────────────────────────── arbitration ─────────────────────────────

export function arbitrationEligible(p: Player, season: number): { eligible: boolean; reason: string } {
  const table = STATIC().arbitrationEligibility;
  const age = Math.min(24, Math.max(18, firstSpcAge(p)));
  const need = table[String(age)] ?? 1;
  const have = proSeasonsSinceSpc(p, season + 1);
  return {
    eligible: have >= need,
    reason: `Signed first NHL contract at ${firstSpcAge(p)}: needs ${need} professional season${need > 1 ? 's' : ''}, has ${have} (CBA 12.1).`,
  };
}

// ───────────────────────────── offer sheets ─────────────────────────────

export interface OfferSheetCompensation {
  compAav: number;
  picks: string[];
  description: string;
}

/** Draft-pick compensation for an offer sheet (CBA 10.4); AAV = total / min(years, 5). */
export function calculateOfferSheetCompensation(totalComp: number, years: number, season: number): OfferSheetCompensation {
  const r = rulesFor(season).offerSheetTiers;
  const compAav = totalComp / Math.min(years, r.aavDivisorMaxYears);
  let picks: string[] = [];
  for (const [ceiling, p] of r.tiers) {
    if (ceiling === null || compAav <= ceiling) {
      picks = p;
      break;
    }
  }
  const names: Record<string, string> = { '1': '1st', '2': '2nd', '3': '3rd' };
  return { compAav, picks, description: picks.length ? picks.map((x) => `${names[x]}-round pick`).join(', ') : 'No compensation' };
}

// ───────────────────────────── buyouts ─────────────────────────────

export interface BuyoutCalc {
  eligible: boolean;
  reason?: string;
  ratio: number;
  remainingSalary: number;
  totalCost: number;
  /** Cash paid to the player per season. */
  payments: Record<number, number>;
  /** Cap charge per season. */
  capCharges: Record<number, number>;
  savings: number;
}

/**
 * Buyout (CBA 50.9(i)): pay 2/3 of remaining salary (1/3 if under 26) over
 * twice the remaining term. Cap charge each year = buyout payment + (cap hit -
 * salary) while the original term runs (signing bonuses stay on the books).
 * 35+ contracts keep their full cap hit. Bought out in the offseason before
 * `fromSeason`.
 */
export function calculateBuyout(p: Player, c: Contract, fromSeason: number): BuyoutCalc {
  const r = rulesFor(fromSeason);
  const ys = yearsOf(c).filter((y) => y.season >= fromSeason);
  const age = fromSeason - 1 - p.birthYear + 1; // age as of June 30 in the buyout window
  const ratio = age < 26 ? r.buyout.ratioUnder26 : r.buyout.ratio26Plus;
  if (!ys.length) return { eligible: false, reason: 'No seasons remain on the contract.', ratio, remainingSalary: 0, totalCost: 0, payments: {}, capCharges: {}, savings: 0 };
  if (c.type === 'ELC' && p.status === 'prospect') {
    // ELCs can be terminated rather than bought out in many cases; keep the general rule.
  }
  const remainingSalary = ys.reduce((s, y) => s + y.salary, 0);
  const totalCost = remainingSalary * ratio;
  const n = ys.length * r.buyout.termMultiplier;
  const perYear = totalCost / n;
  const payments: Record<number, number> = {};
  const capCharges: Record<number, number> = {};
  const capHit = fullCapHit(c);
  for (let i = 0; i < n; i++) {
    const season = fromSeason + i;
    payments[season] = perYear;
    const y = ys.find((x) => x.season === season);
    const charge = c.thirtyFivePlus ? (y ? capHit : 0) : y ? perYear + (capHit - y.salary) : perYear;
    if (charge > 0.0005) capCharges[season] = Math.round(charge * 1000) / 1000;
  }
  const originalCap = ys.length * capHit;
  const chargedOverTerm = ys.reduce((s, y) => s + (capCharges[y.season] ?? 0), 0);
  return { eligible: true, ratio, remainingSalary, totalCost, payments, capCharges, savings: Math.round((originalCap - chargedOverTerm) * 1000) / 1000 };
}

// ───────────────────────────── LTIR ─────────────────────────────

/**
 * LTIR relief (CBA 50.10 as amended by the 2025 MOU): a team may exceed the
 * upper limit by the injured player's cap hit minus the cap space it had when
 * he was placed. If he is expected back this season, relief is capped at the
 * average league salary; full relief only if out for the season and playoffs.
 */
export function calculateLTIRRelief(capHit: number, capSpaceAtPlacement: number, season: number, seasonEnding: boolean): { relief: number; explanation: string } {
  const r = rulesFor(season);
  const raw = Math.max(0, capHit - Math.max(0, capSpaceAtPlacement));
  const relief = seasonEnding ? raw : Math.min(raw, r.ltir.inSeasonReturnReliefCap);
  const parts = [`Cap hit ${fmt(capHit)} minus cap space at placement ${fmt(Math.max(0, capSpaceAtPlacement))} = ${fmt(raw)}.`];
  if (!seasonEnding && raw > relief) parts.push(`Expected back this season: relief capped at the average league salary (${fmt(r.ltir.inSeasonReturnReliefCap)}).`);
  return { relief: Math.round(relief * 1000) / 1000, explanation: parts.join(' ') };
}

export function ltirEligible(p: Player, season: number): { eligible: boolean; reason: string } {
  const r = rulesFor(season);
  const days = p.injury?.daysRemaining ?? 0;
  const games = Math.round(days / 2.15);
  if (days >= r.ltir.minDays && games >= r.ltir.minGames) return { eligible: true, reason: `Expected to miss ${days} days / ~${games} games (minimum ${r.ltir.minDays} days and ${r.ltir.minGames} games).` };
  return { eligible: false, reason: `LTIR requires an injury of at least ${r.ltir.minDays} days and ${r.ltir.minGames} games (expected: ${days} days).` };
}

// ───────────────────────────── waivers ─────────────────────────────

export function waiverStatus(p: Player, season: number, league?: Pick<League, 'seasonStats' | 'season'>): { exempt: boolean; reason: string } {
  if (!p.contract) return { exempt: true, reason: 'No NHL contract.' };
  const w = STATIC().waiverExemption;
  const age = Math.min(25, Math.max(18, firstSpcAge(p)));
  const table = p.pos === 'G' ? w.goalie : w.skater;
  let [years, games] = table[String(age)];
  const gp = nhlGames(p, league);
  // Early-games rule for 18/19-year-old signers who play 11+ NHL games.
  if (age <= 19 && p.firstSpcSeason !== undefined && nhlGamesIn(p, p.firstSpcSeason, p.firstSpcSeason, league) >= w.earlyGames.games) years = p.pos === 'G' ? w.earlyGames.goalieYears : w.earlyGames.skaterYears;
  const pro = proSeasonsSinceSpc(p, season) + 1; // the current season counts
  const yearsLeft = years - pro + 1;
  const gamesOk = games === 0 || gp < games;
  const exempt = yearsLeft > 0 && gamesOk;
  const reason = exempt
    ? `Waiver-exempt: signed first contract at ${firstSpcAge(p)} (${years} season${years > 1 ? 's' : ''}${games ? ` or ${games} NHL games` : ''}); this is pro season ${pro}, ${gp} NHL games.`
    : `Requires waivers: ${yearsLeft <= 0 ? `past the ${years}-season exemption` : `has played ${gp} NHL games (limit ${games})`} (CBA 13.4).`;
  return { exempt, reason };
}

// ───────────────────────────── contracts ─────────────────────────────

export function validateContractStructure(c: Contract, ctx: ValidationContext): string[] {
  return contractStructureErrors(c, ctx);
}

export const calculateCapHit = fullCapHit;
export { aav, cashIn, totalValue };

// ───────────────────────────── rosters ─────────────────────────────

export interface RosterCheck {
  ok: boolean;
  errors: string[];
}

export function onInjuredReserve(p: Player, season: number): boolean {
  return !!p.injury && p.injury.daysRemaining >= rulesFor(season).injuryReserveDays;
}

/** NHL roster legality for a team (CBA 16): 23-man active limit, 50 contracts, dressable lineup. */
export function validateRoster(league: League, teamId: number): RosterCheck {
  const r = rulesFor(league.season);
  const name = `${league.teams[teamId].city} ${league.teams[teamId].name}`;
  const org = Object.values(league.players).filter((p) => p.teamId === teamId && p.contract && (p.status === 'active' || p.status === 'prospect'));
  const active = org.filter((p) => p.status === 'active');
  const counting = active.filter((p) => !onInjuredReserve(p, league.season) && !p.ltir);
  const healthy = active.filter((p) => !p.injury || p.injury.daysRemaining <= 0);
  const errors: string[] = [];
  if (counting.length > r.rosterMax) errors.push(`Roster invalid: ${name} has ${counting.length} players on the active roster (limit ${r.rosterMax}, excluding IR/LTIR).`);
  if (org.length > r.contractLimit) errors.push(`Roster invalid: ${name} has ${org.length} contracts (limit ${r.contractLimit}).`);
  const g = healthy.filter((p) => p.pos === 'G').length;
  const d = healthy.filter((p) => p.pos === 'D').length;
  const f = healthy.length - g - d;
  if (g < 2) errors.push(`Roster invalid: ${name} must have at least 2 goaltenders available (has ${g}).`);
  if (f + d < 18) errors.push(`Roster invalid: ${name} must be able to dress 18 skaters (has ${f + d} healthy).`);
  return { ok: errors.length === 0, errors };
}

/**
 * Playoff cap (MOU2025, from 2026-27): the cap hits of dressed players plus
 * all dead cap must fit under the upper limit; performance bonuses are
 * excluded and LTIR relief does not apply.
 */
export function validatePlayoffRoster(league: League, teamId: number, dressed: number[], deadCap: number): RosterCheck & { capUsed: number; limit: number; applies: boolean } {
  const r = rulesFor(league.season);
  if (!r.playoffCap) return { ok: true, errors: [], capUsed: 0, limit: r.upperLimit, applies: false };
  let used = deadCap;
  for (const id of dressed) {
    const p = league.players[id];
    if (!p?.contract) continue;
    const c = p.contract;
    const noBonus = (totalValue(c) / yearsOf(c).length) * (1 - (c.retained ?? []).reduce((s, x) => s + x.pct, 0));
    used += noBonus;
  }
  const ok = used <= r.upperLimit + 1e-6;
  return {
    ok,
    errors: ok ? [] : [`Playoff lineup blocked: ${league.teams[teamId].abbr}'s dressed players' cap hits plus dead cap total ${fmt(used)}, over the ${fmt(r.upperLimit)} upper limit by ${fmt(used - r.upperLimit)} (playoff cap, 2025 MOU).`],
    capUsed: used,
    limit: r.upperLimit,
    applies: true,
  };
}
