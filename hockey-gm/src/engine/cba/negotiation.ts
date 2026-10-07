/**
 * Contract negotiation with a player's agent (re-signings, extensions and
 * RFA talks).
 *
 * The opening demand covers money, term, trade protection and how much of
 * the pay comes as signing bonus. It depends on market value, leverage, the
 * agent's style and where the player stands on the team: a veteran on a
 * rebuilding club may only stay for a premium, and a player who wants to test
 * free agency won't sign an in-season extension without a big offer.
 * Lowball offers cost patience; reasonable ones earn concessions.
 */
import { clamp } from '../core/math';
import type { ClauseKind, ContractAsk, League, NegotiationStance, NegotiationState, Player } from '../types';
import { freeAgentProfile } from './market';
import { capSeason } from './capManager';
import { rulesFor } from './rules';
import { clauseStartSeason, isOwnTeam, formatMoney } from './contractService';
import { determineFreeAgentStatus } from './rulesEngine';
import { qualifyingOfferFor } from './rfa';
import { agentOf, AGENT_STYLES } from './agents';
import { addNews } from '../league/helpers';

export interface NegotiationResponse {
  accepted: boolean;
  walkedAway: boolean;
  message: string;
  state: NegotiationState;
}

const CLAUSE_RANK: Record<ClauseKind, number> = { 'M-NTC': 1, NTC: 2, NMC: 3 };
export const clauseRank = (c: ClauseKind | null | undefined) => (c ? CLAUSE_RANK[c] : 0);

function leverage(league: League, p: Player): number {
  // UFAs (or players heading to UFA) have more leverage than RFAs; arbitration rights add some back.
  const fa = determineFreeAgentStatus(p, league.season, league);
  if (fa.status === 'UFA') return 1.04;
  const q = qualifyingOfferFor(league, p.id);
  return q?.arbitrationEligible ? 0.98 : 0.93;
}

/** Trade protection the player asks for on a deal of `years`. */
export function demandedClause(league: League, p: Player, years: number): ClauseKind | null {
  const start = capSeason(league) + 1;
  if (years < 3 || clauseStartSeason(p, start, years) === null) return null;
  const agent = agentOf(league, p);
  const tough = agent.style === 'hardball' ? 6 : agent.style === 'friendly' ? -6 : 0;
  const level = p.ca + tough + (p.reputation >= 60 ? 4 : 0);
  if (level >= 162 && years >= 5) return 'NMC';
  if (level >= 150 && years >= 4) return 'NTC';
  if (level >= 140) return 'M-NTC';
  return null;
}

/** Signing-bonus share he asks for: money-first players and hardball agents want guaranteed, lockout-proof pay. */
function demandedBonus(league: League, p: Player, years: number, aav: number): number {
  if (years < 3 || aav < 3000) return 0;
  const agent = agentOf(league, p);
  const base = (p.prefs.money - 1) * 0.6 + (agent.style === 'hardball' ? 0.25 : agent.style === 'friendly' ? -0.1 : 0.05) + (aav >= 8000 ? 0.15 : 0);
  return Math.round(clamp(base, 0, 0.7) * 10) / 10;
}

/** How the player feels about staying (own-team talks). */
export function stanceFor(league: League, p: Player, teamId: number): NegotiationStance {
  const age = capSeason(league) - p.birthYear;
  const team = league.teams[teamId];
  const ufaBound = determineFreeAgentStatus(p, league.season, league).status === 'UFA';
  if (!ufaBound) return 'open';
  const winning = p.prefs.winning;
  if (team.strategy === 'rebuild' && age >= 28 && winning >= 1.05) return 'contenderOnly';
  // In-season extension talks: some players want to see what the open market says.
  const inSeason = league.phase === 'regular' || league.phase === 'preseason';
  if (inSeason && (p.morale < 45 || (p.prefs.loyalty < 0.8 && p.ca >= 145))) return 'testMarket';
  return 'open';
}

export function startNegotiation(league: League, p: Player, teamId: number): NegotiationState {
  const existing = league.negotiations[p.id];
  if (existing && existing.season === league.season && existing.teamId === teamId) return existing;
  const state = openingState(league, p, teamId);
  league.negotiations[p.id] = state;
  return state;
}

/** Where talks would open, without starting them (the dialog shows this before the first offer). */
export function previewNegotiation(league: League, p: Player, teamId: number): NegotiationState {
  const existing = league.negotiations[p.id];
  if (existing && existing.season === league.season && existing.teamId === teamId) return existing;
  return openingState(league, p, teamId);
}

/**
 * Hometown discount: a loyal player who has been with the club a long time,
 * likes it there and sees it winning takes a little less to stay. Hardball
 * agents talk him out of most of it. Only for his own club, and never when he
 * wants out (rebuild) or wants to test the market.
 */
export function hometownDiscount(league: League, p: Player, teamId: number, stance: NegotiationStance = stanceFor(league, p, teamId)): { pct: number; reasons: string[] } {
  if (!isOwnTeam(p, teamId) || stance !== 'open') return { pct: 0, reasons: [] };
  const reasons: string[] = [];
  let d = 0;
  const seasons = new Set(p.career.filter((c) => c.teamId === teamId && !c.playoffs).map((c) => c.season)).size;
  if (seasons >= 3) {
    d += Math.min(0.05, seasons * 0.006);
    reasons.push(`${seasons} seasons with the club`);
  }
  if (p.prefs.loyalty > 1) {
    d += Math.min(0.04, (p.prefs.loyalty - 1) * 0.1);
    reasons.push('loyal by nature');
  }
  if (p.morale >= 65) {
    d += Math.min(0.03, ((p.morale - 60) / 100) * 0.12);
    reasons.push('happy in the room');
  }
  const team = league.teams[teamId];
  const rec = league.standings[teamId];
  const pct = rec && rec.gp ? (rec.w * 2 + rec.otl) / (rec.gp * 2) : 0.5;
  if ((team.strategy === 'contend' || pct >= 0.58) && p.prefs.winning >= 1) {
    d += 0.02;
    reasons.push('wants to win here');
  }
  if (team.captain === p.id) {
    d += 0.01;
    reasons.push('the captain');
  }
  const agent = agentOf(league, p);
  if (agent.style === 'hardball') d *= 0.4;
  else if (agent.style === 'friendly') d *= 1.2;
  return { pct: Math.round(clamp(d, 0, 0.15) * 1000) / 1000, reasons };
}

function openingState(league: League, p: Player, teamId: number): NegotiationState {
  const prof = freeAgentProfile(p, league);
  const agent = agentOf(league, p);
  const style = AGENT_STYLES[agent.style];
  const maxTerm = isOwnTeam(p, teamId) ? rulesFor(capSeason(league)).maxTermOwnTeam : rulesFor(capSeason(league)).maxTermExternal;
  const stance = stanceFor(league, p, teamId);
  // A veteran on a rebuilding team stays only for a premium; one eyeing free agency wants top dollar now.
  const premium = stance === 'contenderOnly' ? 1.12 : stance === 'testMarket' ? 1.08 : 1;
  const years = clamp(prof.desiredTerm, 1, maxTerm);
  const lev = leverage(league, p);
  const home = hometownDiscount(league, p, teamId, stance);
  const aav = Math.round((prof.askingAav * lev * style.demand * premium * (1 - home.pct)) / 5) * 5;
  const factors: NonNullable<NegotiationState['factors']> = [
    { label: 'Market ask', pct: 0, note: formatMoney(prof.askingAav) },
    { label: lev > 1 ? 'Leverage: headed for unrestricted free agency' : 'Leverage: restricted (club holds his rights)', pct: lev - 1 },
    { label: `Agent: ${style.label}`, pct: style.demand - 1 },
    ...(premium !== 1 ? [{ label: stance === 'contenderOnly' ? 'Premium to stay through a rebuild' : 'Premium to skip free agency', pct: premium - 1 }] : []),
    ...(home.pct > 0 ? [{ label: 'Hometown discount', pct: -home.pct, note: home.reasons.join(', ') }] : []),
  ];
  const demand: ContractAsk = { aav, years, clause: demandedClause(league, p, years), bonusShare: demandedBonus(league, p, years, aav) };
  const patience = Math.round(clamp(55 + p.prefs.loyalty * 20 + (p.morale - 50) * 0.4 + style.patience - (stance === 'open' ? 0 : 10), 20, 100));
  return { playerId: p.id, teamId, season: league.season, patience, demand, stance, history: [], factors };
}

/** Value of an offer relative to the demand, accounting for term, trade protection and bonus structure. */
export function offerFit(league: League, p: Player, state: NegotiationState, offer: ContractAsk): number {
  const age = capSeason(league) - p.birthYear;
  const d = state.demand;
  const termPenalty = Math.abs(offer.years - d.years) * (age >= 30 ? 0.04 : 0.025);
  // Older players value security: a longer deal than asked is a plus, not a minus.
  const securityBonus = age >= 31 && offer.years > d.years ? (offer.years - d.years) * 0.05 : 0;
  // Trade protection: each level short of the ask costs; more than asked is a small sweetener.
  const gap = clauseRank(d.clause) - clauseRank(offer.clause);
  const clause = gap > 0 ? -0.035 * gap - 0.02 : gap < 0 ? Math.min(0.03, -gap * 0.012) : 0;
  // Signing bonus: guaranteed money is worth a bit more to him than salary.
  const bonusGap = (offer.bonusShare ?? 0) - (d.bonusShare ?? 0);
  const bonus = bonusGap < 0 ? bonusGap * 0.08 : Math.min(0.025, bonusGap * 0.04);
  return offer.aav / d.aav - termPenalty + securityBonus + clause + bonus;
}

export function describeAsk(a: ContractAsk): string {
  const parts = [`${a.years} yr${a.years === 1 ? '' : 's'} at ${formatMoney(a.aav)}`];
  if (a.clause) parts.push(a.clause === 'M-NTC' ? 'a modified no-trade clause' : a.clause === 'NTC' ? 'a full no-trade clause' : 'a no-movement clause');
  if (a.bonusShare) parts.push(`${Math.round(a.bonusShare * 100)}% in signing bonuses`);
  return parts.join(', ');
}

export function respondToOffer(league: League, p: Player, teamId: number, offer: ContractAsk): NegotiationResponse {
  const state = startNegotiation(league, p, teamId);
  const name = `${p.first} ${p.last}`;
  const agent = agentOf(league, p);
  const style = AGENT_STYLES[agent.style];
  if (state.patience <= 0) return { accepted: false, walkedAway: true, message: `${agent.name} (${name}'s agent) has ended talks for now.`, state };
  const fit = offerFit(league, p, state, offer);
  state.lastOffer = offer;
  let message: string;
  let accepted = false;
  // A player who wants to test the market needs a statement offer to sign now.
  const bar = state.stance === 'testMarket' ? 1.03 : 0.985;
  if (fit >= bar) {
    accepted = true;
    message = `${name} accepts: ${describeAsk(offer)}.`;
  } else {
    // Lowballs cost more patience, but no single offer ends talks on its own.
    const cost = clamp(Math.round((1 - fit) * 60 + 6 - style.patience * 0.2), 5, 32);
    state.patience = Math.max(state.history.length === 0 ? 1 : 0, state.patience - cost);
    // The agent concedes some ground on reasonable offers (how much depends on his style).
    if (fit >= 0.85) {
      const moved = Math.round((state.demand.aav - (state.demand.aav - offer.aav) * style.concession) / 5) * 5;
      state.demand = { ...state.demand, aav: Math.max(offer.aav, moved) };
      // Friendly agents drop secondary asks first.
      if (agent.style === 'friendly' && state.demand.bonusShare) state.demand.bonusShare = Math.max(0, Math.round((state.demand.bonusShare - 0.2) * 10) / 10);
    }
    const counter = `He's looking for ${describeAsk(state.demand)}.`;
    const who = `${agent.name}:`;
    if (state.patience <= 0) message = `${who} "We're too far apart." ${name} is done negotiating${state.stance === 'contenderOnly' ? ' and wants to play for a contender' : ' and will test the market'}.`;
    else if (fit < 0.85) message = `${who} "That's not a serious offer." ${counter}`;
    else if (fit < 0.95) message = `${who} "We're getting closer." ${counter}`;
    else message = `${who} "Close — a little more and we have a deal." ${counter}`;
    // Media-savvy agents take insulting offers to the press, and the player hears about it.
    if (agent.style === 'media' && fit < 0.85 && teamId === league.userTeamId) {
      p.morale = clamp(p.morale - 4, 0, 100);
      addNews(league, { category: 'rumor', headline: `${name}'s camp calls ${league.teams[teamId].city}'s contract offer "disrespectful"`, teamIds: [teamId], playerIds: [p.id], importance: 2 });
    }
  }
  state.history.push({ ...offer, response: message });
  return { accepted, walkedAway: state.patience <= 0, message, state };
}

/** Year-by-year salary and signing-bonus split for an offer (each season sums to the AAV). */
export function payStructure(offer: ContractAsk): { salaries: number[]; signingBonuses: number[] } {
  const share = clamp(offer.bonusShare ?? 0, 0, 0.8);
  const bonus = Math.round(offer.aav * share);
  return { salaries: new Array(offer.years).fill(offer.aav - bonus), signingBonuses: new Array(offer.years).fill(bonus) };
}

export const STANCE_LABEL: Record<NegotiationStance, string> = {
  open: 'Open to a new deal',
  contenderOnly: 'Wants to win now — will only stay on a rebuilding team for a premium',
  testMarket: 'Wants to test free agency — needs a statement offer to sign now',
};
