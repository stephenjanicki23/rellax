/**
 * RFA holdouts. A restricted free agent who thinks his qualifying offer is
 * far below his value can refuse it and sit out instead of signing at the end
 * of free agency. His club keeps his rights; he misses games until a deal is
 * done. As the weeks go by his agent softens the demand, and an RFA must sign
 * by December 1 to play that season (CBA 10.2(a)(iii)), so holdouts end by
 * then (SIMPLIFICATION: he signs his qualifying offer at the deadline rather
 * than sitting out the year).
 */
import type { League, Player, QualifyingOfferRecord } from '../types';
import { seedFrom } from '../core/rng';
import { clamp } from '../core/math';
import { addNews, addTransaction, isCpu, teamName } from '../league/helpers';
import { fullName } from '../player/ability';
import { contractValue } from './market';
import { agentOf } from './agents';
import { startNegotiation } from './negotiation';
import { contractFromOffer, registerContract } from './contractService';

/** Schedule day of December 1 (day 0 is opening night, October 8). */
export const DEC1_DAY = 54;

export function isHoldingOut(p: Player): boolean {
  return !!p.holdout;
}

/** Does this RFA refuse his qualifying offer and hold out? */
export function wantsToHoldOut(league: League, p: Player, q: QualifyingOfferRecord): boolean {
  if (p.ca < 135) return false;
  const value = contractValue(p, league).value;
  if (value < q.amount * 1.35) return false;
  const agent = agentOf(league, p);
  if (agent.style === 'friendly') return false;
  const roll = (seedFrom(league.seed, 'holdout', league.season, p.id) % 100) / 100;
  return roll < (agent.style === 'hardball' ? 0.8 : 0.55);
}

export function beginHoldout(league: League, p: Player, teamId: number): void {
  p.holdout = { season: league.season, sinceDay: league.day };
  startNegotiation(league, p, teamId);
  addNews(league, {
    category: 'signing',
    headline: `${fullName(p)} refuses his qualifying offer and will hold out from ${teamName(league, teamId)}`,
    body: `His agent, ${agentOf(league, p).name}, says the two sides are far apart on a long-term deal.`,
    teamIds: [teamId],
    playerIds: [p.id],
    importance: 3,
  });
}

export function endHoldout(league: League, p: Player): void {
  if (!p.holdout) return;
  const weeks = Math.max(0, Math.floor((league.day - p.holdout.sinceDay) / 7));
  delete p.holdout;
  // A long holdout leaves some bad blood.
  p.morale = clamp(p.morale - 3 - weeks, 0, 100);
}

function signAtQualifyingOffer(league: League, p: Player, teamId: number): boolean {
  const q = league.qualifyingOffers.find((x) => x.playerId === p.id && x.season === p.holdout?.season);
  const amount = q?.amount ?? Math.round(contractValue(p, league).value * 0.8);
  const res = registerContract(league, p, teamId, contractFromOffer(league, p, { aav: amount, years: 1, twoWay: q ? !q.oneWay : false }), { origin: 'qualifyingOffer', skipCapCheck: true });
  if (res.ok && q) q.status = 'accepted';
  return res.ok;
}

/** Daily: holdouts soften, CPU clubs settle, and everyone signs by December 1. */
export function holdoutDay(league: League): void {
  if (league.phase !== 'preseason' && league.phase !== 'regular') return;
  for (const p of Object.values(league.players)) {
    if (!p.holdout || p.rightsTeamId === null || p.status !== 'fa') continue;
    const teamId = p.rightsTeamId;
    const state = startNegotiation(league, p, teamId);
    const days = league.day - p.holdout.sinceDay;
    // Each week out, the agent comes down a little and is willing to keep talking.
    if (days > 0 && days % 7 === 0) {
      state.demand = { ...state.demand, aav: Math.round((state.demand.aav * 0.97) / 5) * 5, bonusShare: Math.max(0, (state.demand.bonusShare ?? 0) - 0.1) };
      state.patience = Math.min(100, Math.max(state.patience, 0) + 20);
      if (teamId === league.userTeamId) addNews(league, { category: 'signing', headline: `${fullName(p)}'s holdout enters week ${days / 7}; his camp now wants ${(state.demand.aav / 1000).toFixed(2)}M per season`, teamIds: [teamId], playerIds: [p.id], importance: 2 });
    }
    // CPU clubs settle near the (softening) demand within a few weeks.
    if (isCpu(league, teamId) && (seedFrom(league.seed, 'settle', league.season, league.day, p.id) % 100) < 6) {
      const c = contractFromOffer(league, p, { aav: state.demand.aav, years: state.demand.years, clauses: state.demand.clause ?? null });
      if (registerContract(league, p, teamId, c, { origin: 'signing', skipCapCheck: true }).ok) {
        endHoldout(league, p);
        addTransaction(league, { kind: 'signing', teamIds: [teamId], playerIds: [p.id], description: `${teamName(league, teamId)} end ${fullName(p)}'s holdout with a ${state.demand.years}-year deal` });
        continue;
      }
    }
    if (league.phase === 'regular' && league.day >= DEC1_DAY) {
      if (signAtQualifyingOffer(league, p, teamId)) {
        endHoldout(league, p);
        addNews(league, { category: 'signing', headline: `${fullName(p)} signs his qualifying offer just before the December 1 deadline, ending his holdout`, teamIds: [teamId], playerIds: [p.id], importance: 2 });
      }
    }
  }
}
