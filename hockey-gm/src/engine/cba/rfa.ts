/**
 * Restricted free agency: qualifying offers, arbitration and offer sheets.
 *
 * Calendar (FA day 0 = July 1):
 *   late June  prepareExpiries → teams submit/withhold qualifying offers
 *   July 1     processQualifyingOffers: no QO → UFA; QO → RFA (rights held)
 *   day 0-10   RFAs may accept their QO; offer sheets may be signed
 *   day 3 / 4  player-elected / club-elected arbitration filing
 *   day 8      arbitration hearings (award binding unless the club walks away)
 *   final day  unsigned RFAs accept their QO (game simplification)
 */
import type { Rng } from '../core/rng';
import { clamp } from '../core/math';
import type { ArbitrationCase, League, OfferSheet, Player, QualifyingOfferRecord } from '../types';
import { addNews, addTransaction, isCpu, teamName } from '../league/helpers';
import { fullName } from '../player/ability';
import { releasePlayer } from '../economy/roster';
import { arbitrationEligible, calculateOfferSheetCompensation, calculateQualifyingOffer, determineFreeAgentStatus } from './rulesEngine';
import { contractFromOffer, formatMoney, registerContract, checkContract } from './contractService';
import { CapManager, capProjection, capSeason } from './capManager';
import { contractValue, freeAgentProfile } from './market';
import { rulesFor } from './rules';
import { totalValue } from './contract';
import { beginHoldout, wantsToHoldOut } from './holdouts';

export const ARB_PLAYER_FILE_DAY = 3;
export const ARB_CLUB_FILE_DAY = 4;
export const ARB_HEARING_DAY = 8;
export const QO_EXPIRY_DAY = 10;
export const OFFER_SHEET_DECISION_DAYS = 3;

/** Players whose contract expired this offseason (still attached, years = 0). */
export function expiredPlayers(league: League, teamId?: number): Player[] {
  return Object.values(league.players).filter((p) => p.contract && p.contract.years <= 0 && !p.contract.next && p.teamId !== null && (teamId === undefined || p.teamId === teamId) && (p.status === 'active' || p.status === 'prospect'));
}

/** Late June: classify expiring contracts and create the qualifying-offer list. */
export function prepareExpiries(league: League): void {
  league.qualifyingOffers = league.qualifyingOffers.filter((q) => q.season !== league.season);
  for (const p of expiredPlayers(league)) {
    const fa = determineFreeAgentStatus(p, league.season, league);
    p.contract!.expiryStatus = fa.status;
    if (fa.status !== 'RFA') continue;
    const qo = calculateQualifyingOffer(p, p.contract!, league.season, league);
    league.qualifyingOffers.push({
      playerId: p.id,
      teamId: p.teamId!,
      season: league.season,
      previousSalary: qo.previousSalary,
      previousAav: qo.previousAav,
      amount: qo.amount,
      oneWay: qo.oneWay,
      explanation: qo.explanation,
      status: 'required',
      arbitrationEligible: arbitrationEligible(p, league.season).eligible,
    });
  }
}

export function qualifyingOfferFor(league: League, playerId: number): QualifyingOfferRecord | undefined {
  return league.qualifyingOffers.find((q) => q.playerId === playerId && q.season === league.season);
}

/** Submit (or withhold) a qualifying offer during the re-signing window. */
export function submitQualifyingOffer(league: League, playerId: number, submit: boolean): { ok: boolean; message: string } {
  const q = qualifyingOfferFor(league, playerId);
  if (!q) return { ok: false, message: 'This player is not a pending RFA.' };
  if (league.phase !== 'resign') return { ok: false, message: 'Qualifying offers are made before free agency opens (late June).' };
  q.status = submit ? 'submitted' : 'notSubmitted';
  const p = league.players[playerId];
  if (submit) addTransaction(league, { kind: 'qualifyingOffer', teamIds: [q.teamId], playerIds: [playerId], description: `${teamName(league, q.teamId)} extend a qualifying offer to ${fullName(p)}: ${formatMoney(q.amount)}${q.oneWay ? ' (one-way)' : ' (two-way)'}` });
  return { ok: true, message: submit ? `Qualifying offer of ${formatMoney(q.amount)} submitted.` : `${fullName(p)} will not be qualified and becomes a UFA on July 1.` };
}

/** CPU teams decide which RFAs to qualify, based on value vs. QO and future cap room. */
export function aiQualifyingDecisions(league: League, teamId: number): void {
  const proj = capProjection(league, teamId, 2);
  for (const q of league.qualifyingOffers) {
    if (q.teamId !== teamId || q.season !== league.season || q.status !== 'required') continue;
    const p = league.players[q.playerId];
    if (!p.contract || p.contract.years > 0 || p.contract.next) continue; // already re-signed
    const value = contractValue(p, league).value;
    const age = league.season + 1 - p.birthYear;
    // Young players with real upside are kept; otherwise the QO must be good value for the role.
    const prospect = age <= 23 && p.pa >= 138 && p.pa - p.ca >= 8;
    const roleWorthy = p.status === 'active' ? p.ca >= 118 : p.pa >= 135;
    const worth = (value >= q.amount * 0.97 && roleWorthy) || prospect;
    const affordable = proj[0].space > q.amount * 0.6 || value >= q.amount * 1.1;
    submitQualifyingOffer(league, q.playerId, worth && affordable);
  }
}

/** July 1: unqualified RFAs become UFAs; qualified RFAs stay with their club's rights. */
export function processQualifyingOffers(league: League): void {
  for (const q of league.qualifyingOffers) {
    if (q.season !== league.season) continue;
    const p = league.players[q.playerId];
    if (!p) continue;
    if (p.contract && (p.contract.years > 0 || p.contract.next)) {
      q.status = 'accepted'; // re-signed before free agency
      continue;
    }
    if (q.status !== 'submitted') {
      q.status = 'notSubmitted';
      const tid = p.teamId;
      releasePlayer(league, p, 'do not qualify');
      p.rfa = false;
      if (tid !== null && p.reputation >= 45) addNews(league, { category: 'signing', headline: `${fullName(p)} becomes an unrestricted free agent after ${teamName(league, tid)} decline to qualify him`, teamIds: [tid], playerIds: [p.id], importance: 2 });
      continue;
    }
    // Qualified: rights held, unsigned.
    const tid = p.teamId!;
    p.teamId = null;
    p.status = 'fa';
    p.contract = null;
    p.rfa = true;
    p.rightsTeamId = tid;
  }
}

export function isRestricted(p: Player): boolean {
  return p.status === 'fa' && !!p.rfa && p.rightsTeamId !== null;
}

function signQualifyingOffer(league: League, p: Player, q: QualifyingOfferRecord): boolean {
  const c = contractFromOffer(league, p, { aav: q.amount, years: 1, twoWay: !q.oneWay });
  const res = registerContract(league, p, q.teamId, c, { origin: 'qualifyingOffer', skipCapCheck: true });
  if (res.ok) q.status = 'accepted';
  return res.ok;
}

/** Player accepts his qualifying offer (human GM can also prompt it via UI). */
export function acceptQualifyingOffer(league: League, playerId: number): { ok: boolean; message: string } {
  const q = qualifyingOfferFor(league, playerId);
  const p = league.players[playerId];
  if (!q || !isRestricted(p)) return { ok: false, message: 'No open qualifying offer.' };
  return signQualifyingOffer(league, p, q) ? { ok: true, message: `${fullName(p)} accepts his qualifying offer.` } : { ok: false, message: 'Could not register the qualifying offer.' };
}

// ───────────────────────────── arbitration ─────────────────────────────

export function fileArbitration(league: League, playerId: number, electedBy: 'player' | 'club', years?: number): { ok: boolean; message: string } {
  const p = league.players[playerId];
  const q = qualifyingOfferFor(league, playerId);
  if (!p || !q || !isRestricted(p)) return { ok: false, message: 'Only qualified, unsigned RFAs can go to arbitration.' };
  if (!q.arbitrationEligible) return { ok: false, message: `${fullName(p)} is not arbitration-eligible (${arbitrationEligible(p, league.season).reason}).` };
  if (league.arbitration.some((a) => a.playerId === playerId && a.season === league.season)) return { ok: false, message: 'Arbitration already filed.' };
  if (electedBy === 'club' && q.previousSalary < rulesFor(capSeason(league)).arbitration.clubElectThreshold) return { ok: false, message: `Club-elected arbitration requires a prior salary of at least ${formatMoney(rulesFor(capSeason(league)).arbitration.clubElectThreshold)}.` };
  const prof = freeAgentProfile(p, league);
  const value = prof.marketValue;
  const age = capSeason(league) - p.birthYear;
  const term = years ?? (age >= 25 ? 2 : 1);
  const kase: ArbitrationCase = {
    playerId,
    teamId: q.teamId,
    season: league.season,
    electedBy,
    playerAsk: Math.round(Math.max(q.amount, prof.askingAav * 1.06) / 5) * 5,
    clubOffer: Math.round(Math.max(q.amount, value * 0.84) / 5) * 5,
    years: clamp(term, 1, 2),
    hearingDay: ARB_HEARING_DAY,
    status: 'filed',
  };
  league.arbitration.push(kase);
  addTransaction(league, { kind: 'arbitration', teamIds: [q.teamId], playerIds: [playerId], description: `${fullName(p)} (${teamName(league, q.teamId)}) ${electedBy === 'player' ? 'files' : 'is taken'} to salary arbitration: asks ${formatMoney(kase.playerAsk)}, club offers ${formatMoney(kase.clubOffer)}` });
  return { ok: true, message: `Arbitration filed: player asks ${formatMoney(kase.playerAsk)}, club ${formatMoney(kase.clubOffer)}. Hearing on day ${ARB_HEARING_DAY} of free agency.` };
}

/**
 * Arbitrator's award: starts at the midpoint of ask and offer and moves toward
 * what comparable players earn, always inside the two submissions.
 */
export function arbitrationAward(league: League, kase: ArbitrationCase): { award: number; reasoning: string; comparables: ArbitrationCase['comparables'] } {
  const p = league.players[kase.playerId];
  const v = contractValue(p, league);
  const mid = (kase.playerAsk + kase.clubOffer) / 2;
  const compMedian = v.comparableMedian ?? v.value;
  const raw = mid * 0.5 + compMedian * 0.5;
  const award = Math.round(clamp(raw, kase.clubOffer, kase.playerAsk) / 5) * 5;
  const comps = v.comparables.slice(0, 4).map((c) => ({ playerId: c.playerId, name: c.name, aav: Math.round(c.indexedAav) }));
  const reasoning = `Midpoint of submissions ${formatMoney(mid)}; comparable players${comps.length ? ` (${comps.map((c) => `${c.name} ${formatMoney(c.aav)}`).join(', ')})` : ''} suggest ${formatMoney(compMedian)}. Award: ${formatMoney(award)} × ${kase.years} year${kase.years > 1 ? 's' : ''}.`;
  return { award, reasoning, comparables: comps };
}

function holdHearing(league: League, kase: ArbitrationCase): void {
  const p = league.players[kase.playerId];
  if (!isRestricted(p)) {
    kase.status = 'settled';
    return;
  }
  const { award, reasoning, comparables } = arbitrationAward(league, kase);
  kase.award = award;
  kase.reasoning = reasoning;
  kase.comparables = comparables;
  const r = rulesFor(capSeason(league));
  // Clubs may walk away from player-elected awards at or above the threshold.
  const canWalk = kase.electedBy === 'player' && award >= r.arbitration.walkAwayThreshold;
  if (canWalk && isCpu(league, kase.teamId)) {
    const value = contractValue(p, league).value;
    const space = CapManager.getAvailableCapSpace(league, kase.teamId);
    if (award > value * 1.25 && space < award) {
      kase.status = 'walkedAway';
      p.rfa = false;
      p.rightsTeamId = null;
      addTransaction(league, { kind: 'arbitration', teamIds: [kase.teamId], playerIds: [p.id], description: `${teamName(league, kase.teamId)} walk away from ${fullName(p)}'s ${formatMoney(award)} arbitration award; he becomes an unrestricted free agent` });
      return;
    }
  }
  const c = contractFromOffer(league, p, { aav: award, years: kase.years });
  registerContract(league, p, kase.teamId, c, { origin: 'arbitration', skipCapCheck: true, note: reasoning });
  kase.status = 'awarded';
  if (p.reputation >= 40) addNews(league, { category: 'signing', headline: `Arbitrator awards ${fullName(p)} ${formatMoney(award)} from ${teamName(league, kase.teamId)}`, body: reasoning, teamIds: [kase.teamId], playerIds: [p.id], importance: 2 });
}

/** Human GM option after a player-elected award above the threshold. */
export function walkAwayFromAward(league: League, playerId: number): { ok: boolean; message: string } {
  const kase = league.arbitration.find((a) => a.playerId === playerId && a.season === league.season && a.status === 'awarded');
  const p = league.players[playerId];
  if (!kase || !p.contract || kase.electedBy !== 'player' || (kase.award ?? 0) < rulesFor(capSeason(league)).arbitration.walkAwayThreshold) return { ok: false, message: 'Walk-away rights are only available on player-elected awards above the threshold.' };
  p.contract = null;
  p.teamId = null;
  p.status = 'fa';
  p.rfa = false;
  p.rightsTeamId = null;
  kase.status = 'walkedAway';
  addTransaction(league, { kind: 'arbitration', teamIds: [kase.teamId], playerIds: [p.id], description: `${teamName(league, kase.teamId)} walk away from ${fullName(p)}'s arbitration award; he becomes a UFA` });
  return { ok: true, message: `${fullName(p)} becomes an unrestricted free agent.` };
}

// ───────────────────────────── offer sheets ─────────────────────────────

/** The draft picks a team would surrender, using its own picks from the next drafts. */
export function compensationPicks(league: League, teamId: number, picks: string[]): { ok: boolean; pickIds: number[]; missing: string[] } {
  const firstDraft = league.phase === 'draft' ? league.season : league.season + 1;
  const used = new Set<number>();
  const pickIds: number[] = [];
  const missing: string[] = [];
  for (const round of picks) {
    const r = Number(round);
    const pick = league.draftPicks
      .filter((d) => d.originalTeamId === teamId && d.ownerId === teamId && d.round === r && d.season >= firstDraft && d.playerId === undefined && !used.has(d.id))
      .sort((a, b) => a.season - b.season)[0];
    if (pick) {
      used.add(pick.id);
      pickIds.push(pick.id);
    } else missing.push(`round ${r}`);
  }
  return { ok: missing.length === 0, pickIds, missing };
}

export function submitOfferSheet(league: League, fromTeamId: number, playerId: number, terms: { aav: number; years: number; salaries?: number[] }): { ok: boolean; message: string; sheet?: OfferSheet } {
  const p = league.players[playerId];
  if (!p || !isRestricted(p)) return { ok: false, message: 'Offer sheets can only be signed by restricted free agents whose rights are held.' };
  if (league.phase !== 'freeAgency') return { ok: false, message: 'Offer sheets can only be signed once free agency opens.' };
  if (p.rightsTeamId === fromTeamId) return { ok: false, message: 'You hold his rights — negotiate directly instead.' };
  if (league.arbitration.some((a) => a.playerId === playerId && a.season === league.season)) return { ok: false, message: `${fullName(p)} has filed for arbitration and can no longer sign an offer sheet.` };
  if (league.offerSheets.some((o) => o.playerId === playerId && o.status === 'pending')) return { ok: false, message: 'He already has an offer sheet pending.' };
  const c = contractFromOffer(league, p, { aav: terms.aav, years: terms.years, salaries: terms.salaries });
  const errors = checkContract(league, p, fromTeamId, c);
  if (errors.length) return { ok: false, message: errors[0] };
  const comp = calculateOfferSheetCompensation(totalValue(c), terms.years, capSeason(league));
  const picks = compensationPicks(league, fromTeamId, comp.picks);
  if (!picks.ok) return { ok: false, message: `Offer sheet rejected: compensation requires ${comp.description}, and ${teamName(league, fromTeamId)} do not own their ${picks.missing.join(', ')} pick(s).` };
  const sheet: OfferSheet = {
    id: league.offerSheets.length + 1,
    playerId,
    fromTeamId,
    rightsTeamId: p.rightsTeamId!,
    season: league.season,
    day: league.faDay,
    aav: terms.aav,
    years: terms.years,
    salaries: c.yearsDetail!.map((y) => y.salary),
    compAav: comp.compAav,
    compensation: comp.picks,
    status: 'pending',
    decisionDay: league.faDay + OFFER_SHEET_DECISION_DAYS,
  };
  league.offerSheets.push(sheet);
  addTransaction(league, { kind: 'offerSheet', teamIds: [fromTeamId, sheet.rightsTeamId], playerIds: [playerId], description: `${fullName(p)} signs an offer sheet with ${teamName(league, fromTeamId)}: ${terms.years} yr / ${formatMoney(terms.aav)} AAV (compensation: ${comp.description}). ${teamName(league, sheet.rightsTeamId)} have ${OFFER_SHEET_DECISION_DAYS} days to match.` });
  addNews(league, { category: 'signing', headline: `${fullName(p)} signs an offer sheet with ${teamName(league, fromTeamId)}`, body: `${terms.years} years, ${formatMoney(terms.aav)} AAV. Compensation if not matched: ${comp.description}.`, teamIds: [fromTeamId, sheet.rightsTeamId], playerIds: [playerId], importance: 4 });
  return { ok: true, message: `Offer sheet signed. ${teamName(league, sheet.rightsTeamId)} have ${OFFER_SHEET_DECISION_DAYS} days to match (compensation: ${comp.description}).`, sheet };
}

/** Rights team matches or declines an offer sheet. */
export function resolveOfferSheet(league: League, sheetId: number, match: boolean): { ok: boolean; message: string } {
  const sheet = league.offerSheets.find((o) => o.id === sheetId);
  if (!sheet || sheet.status !== 'pending') return { ok: false, message: 'No pending offer sheet.' };
  const p = league.players[sheet.playerId];
  const signWith = match ? sheet.rightsTeamId : sheet.fromTeamId;
  const c = contractFromOffer(league, p, { aav: sheet.aav, years: sheet.years, salaries: sheet.salaries });
  if (match) {
    const errors = checkContract(league, p, sheet.rightsTeamId, c);
    if (errors.length) return { ok: false, message: `Cannot match: ${errors[0]}` };
  }
  const res = registerContract(league, p, signWith, c, { origin: 'offerSheet', skipCapCheck: !match });
  if (!res.ok) return { ok: false, message: res.message };
  sheet.status = match ? 'matched' : 'declined';
  if (!match) {
    const picks = compensationPicks(league, sheet.fromTeamId, sheet.compensation);
    for (const id of picks.pickIds) {
      const pick = league.draftPicks.find((d) => d.id === id);
      if (pick) pick.ownerId = sheet.rightsTeamId;
    }
  }
  const desc = match
    ? `${teamName(league, sheet.rightsTeamId)} match the offer sheet and keep ${fullName(p)}`
    : `${teamName(league, sheet.rightsTeamId)} decline to match; ${fullName(p)} joins ${teamName(league, sheet.fromTeamId)}, who send ${calculateOfferSheetCompensation(sheet.aav * sheet.years, sheet.years, capSeason(league)).description} as compensation`;
  addTransaction(league, { kind: 'offerSheet', teamIds: [sheet.fromTeamId, sheet.rightsTeamId], playerIds: [p.id], description: desc });
  addNews(league, { category: 'signing', headline: desc, teamIds: [sheet.fromTeamId, sheet.rightsTeamId], playerIds: [p.id], importance: 4 });
  return { ok: true, message: desc };
}

/** CPU rights team: match if he is worth it and it fits the cap plan. */
function aiOfferSheetDecision(league: League, sheet: OfferSheet): boolean {
  const p = league.players[sheet.playerId];
  const value = contractValue(p, league).value;
  const team = league.teams[sheet.rightsTeamId];
  const space = CapManager.getAvailableCapSpace(league, sheet.rightsTeamId);
  const fits = space >= sheet.aav * 0.9;
  const worth = sheet.aav <= value * (team.strategy === 'rebuild' && league.season + 1 - p.birthYear >= 25 ? 1.0 : 1.18);
  return fits && worth;
}

/** CPU teams occasionally chase other clubs' star RFAs with offer sheets. */
function aiOfferSheets(league: League, rng: Rng): void {
  if (league.faDay > 6) return;
  for (const p of Object.values(league.players)) {
    if (!isRestricted(p) || p.ca < 142) continue;
    if (league.offerSheets.some((o) => o.playerId === p.id) || league.arbitration.some((a) => a.playerId === p.id && a.season === league.season)) continue;
    if (!rng.chance(0.12)) continue;
    const value = contractValue(p, league).value;
    const suitors = league.teams.filter((t) => isCpu(league, t.id) && t.id !== p.rightsTeamId && t.strategy !== 'rebuild' && CapManager.getAvailableCapSpace(league, t.id) > value * 1.2);
    if (!suitors.length) continue;
    const t = rng.pick(suitors);
    submitOfferSheet(league, t.id, p.id, { aav: Math.round((value * rng.float(1.08, 1.22)) / 5) * 5, years: Math.min(5, rulesFor(capSeason(league)).maxTermExternal) });
  }
}

/** Daily RFA processing during free agency. */
export function rfaDay(league: League, rng: Rng, final: boolean): void {
  // Offer-sheet decisions.
  for (const sheet of league.offerSheets) {
    if (sheet.status !== 'pending' || league.faDay < sheet.decisionDay) continue;
    if (isCpu(league, sheet.rightsTeamId)) resolveOfferSheet(league, sheet.id, aiOfferSheetDecision(league, sheet));
    else resolveOfferSheet(league, sheet.id, false); // user did not match in time
  }
  aiOfferSheets(league, rng);
  // Arbitration filing.
  for (const q of league.qualifyingOffers) {
    if (q.season !== league.season || q.status !== 'submitted') continue;
    const p = league.players[q.playerId];
    if (!isRestricted(p) || !q.arbitrationEligible) continue;
    if (league.offerSheets.some((o) => o.playerId === p.id && o.status === 'pending')) continue;
    const value = contractValue(p, league).value;
    if (league.faDay === ARB_PLAYER_FILE_DAY && value > q.amount * 1.08 && rng.chance(0.6)) fileArbitration(league, p.id, 'player');
    if (league.faDay === ARB_CLUB_FILE_DAY && isCpu(league, q.teamId) && q.previousSalary >= rulesFor(capSeason(league)).arbitration.clubElectThreshold && rng.chance(0.25)) fileArbitration(league, p.id, 'club');
  }
  // Hearings.
  for (const kase of league.arbitration) if (kase.season === league.season && kase.status === 'filed' && league.faDay >= kase.hearingDay) holdHearing(league, kase);
  // Qualifying-offer acceptance.
  for (const q of league.qualifyingOffers) {
    if (q.season !== league.season || q.status !== 'submitted') continue;
    const p = league.players[q.playerId];
    if (!isRestricted(p)) continue;
    if (league.offerSheets.some((o) => o.playerId === p.id && o.status === 'pending')) continue;
    if (league.arbitration.some((a) => a.playerId === p.id && a.season === league.season && a.status === 'filed')) continue;
    const value = contractValue(p, league).value;
    const late = league.faDay >= QO_EXPIRY_DAY;
    if (p.holdout) continue;
    // At the end of free agency a star who feels badly underpaid holds out instead.
    if (final && wantsToHoldOut(league, p, q)) {
      beginHoldout(league, p, q.teamId);
      continue;
    }
    if (final || value <= q.amount * 1.02 || (late && value <= q.amount * 1.3)) signQualifyingOffer(league, p, q);
  }
}
