/**
 * Contract negotiation with a patience meter (re-signings, extensions and
 * RFA talks). Players open with a demand from their market value, leverage
 * and preferred term; lowball offers cost patience and players can walk away.
 */
import { clamp } from '../core/math';
import type { League, NegotiationState, Player } from '../types';
import { freeAgentProfile } from './market';
import { capSeason } from './capManager';
import { rulesFor } from './rules';
import { isOwnTeam, formatMoney } from './contractService';
import { determineFreeAgentStatus } from './rulesEngine';
import { qualifyingOfferFor } from './rfa';

export interface NegotiationResponse {
  accepted: boolean;
  walkedAway: boolean;
  message: string;
  state: NegotiationState;
}

function leverage(league: League, p: Player): number {
  // UFAs (or players heading to UFA) have more leverage than RFAs; arbitration rights add some back.
  const fa = determineFreeAgentStatus(p, league.season, league);
  if (fa.status === 'UFA') return 1.04;
  const q = qualifyingOfferFor(league, p.id);
  return q?.arbitrationEligible ? 0.98 : 0.93;
}

export function startNegotiation(league: League, p: Player, teamId: number): NegotiationState {
  const existing = league.negotiations[p.id];
  if (existing && existing.season === league.season && existing.teamId === teamId) return existing;
  const prof = freeAgentProfile(p, league);
  const maxTerm = isOwnTeam(p, teamId) ? rulesFor(capSeason(league)).maxTermOwnTeam : rulesFor(capSeason(league)).maxTermExternal;
  const demand = { aav: Math.round((prof.askingAav * leverage(league, p)) / 5) * 5, years: clamp(prof.desiredTerm, 1, maxTerm) };
  const state: NegotiationState = { playerId: p.id, teamId, season: league.season, patience: Math.round(clamp(55 + p.prefs.loyalty * 20 + (p.morale - 50) * 0.4, 25, 100)), demand, history: [] };
  league.negotiations[p.id] = state;
  return state;
}

/** Value of an offer relative to the demand, accounting for term preference. */
export function offerFit(league: League, p: Player, state: NegotiationState, offer: { aav: number; years: number }): number {
  const age = capSeason(league) - p.birthYear;
  const termPenalty = Math.abs(offer.years - state.demand.years) * (age >= 30 ? 0.04 : 0.025);
  // Older players value security: a longer deal than asked is a plus, not a minus.
  const securityBonus = age >= 31 && offer.years > state.demand.years ? (offer.years - state.demand.years) * 0.05 : 0;
  return offer.aav / state.demand.aav - termPenalty + securityBonus;
}

export function respondToOffer(league: League, p: Player, teamId: number, offer: { aav: number; years: number }): NegotiationResponse {
  const state = startNegotiation(league, p, teamId);
  const name = `${p.first} ${p.last}`;
  if (state.patience <= 0) return { accepted: false, walkedAway: true, message: `${name}'s camp has ended talks for now.`, state };
  const fit = offerFit(league, p, state, offer);
  state.lastOffer = offer;
  let message: string;
  let accepted = false;
  if (fit >= 0.985) {
    accepted = true;
    message = `${name} accepts: ${offer.years} years at ${formatMoney(offer.aav)} per season.`;
  } else {
    // Lowballs cost more patience, but no single offer ends talks on its own.
    const cost = clamp(Math.round((1 - fit) * 60 + 6), 6, 30);
    state.patience = Math.max(state.history.length === 0 ? 1 : 0, state.patience - cost);
    // The player concedes a little on reasonable offers.
    if (fit >= 0.85) state.demand = { ...state.demand, aav: Math.round((state.demand.aav - (state.demand.aav - offer.aav) * 0.18) / 5) * 5 };
    const counter = `He's looking for ${state.demand.years} years at ${formatMoney(state.demand.aav)}.`;
    if (state.patience <= 0) message = `${name}: "We're too far apart." He is done negotiating and will test the market.`;
    else if (fit < 0.85) message = `"Too low." ${counter}`;
    else if (fit < 0.95) message = `"We're getting closer." ${counter}`;
    else message = `"Close — a little more and we have a deal." ${counter}`;
  }
  state.history.push({ ...offer, response: message });
  return { accepted, walkedAway: state.patience <= 0, message, state };
}
