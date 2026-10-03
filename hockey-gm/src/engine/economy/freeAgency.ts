/**
 * Re-signing, arbitration, extensions and free agency.
 *
 * Free agents weigh money against team quality, expected role, location,
 * loyalty and career stage. Offers accumulate over several "free agency
 * days" and players decide when an offer is good enough (or time runs out).
 */
import { clamp } from '../core/math';
import { seedFrom, Rng } from '../core/rng';
import type { FreeAgentOffer, League, Player } from '../types';
import { addNews, addTransaction, isCpu, playersOf, teamName, withRng } from '../league/helpers';
import { askingSalary, capSpace, isRFA, marketValue, typicalTerm, payroll } from './contracts';
import { signFromOffer, type OfferTerms } from '../cba/contractService';
import { signingScore, contractValue, freeAgentProfile } from '../cba/market';
import { isRestricted, processQualifyingOffers, rfaDay } from '../cba/rfa';
import { respondToOffer } from '../cba/negotiation';
import { rulesFor } from '../cba/rules';
import { capSeason } from '../cba/capManager';
import { signPlayer, releasePlayer, rosterSize, rosterCounts, ensureDressable, trimRoster } from './roster';
import { executeTrade, validateTrade } from './trade';
import { fitsPlan, planContext } from '../ai/finance';
import { fullName, isForward } from '../player/ability';
import { PERSONALITIES } from '../player/personality';

export const FA_DAYS = 12;

export function expiringPlayers(league: League, teamId: number): Player[] {
  return playersOf(league, teamId, ['active', 'prospect']).filter((p) => p.contract && p.contract.years <= 0 && !p.contract.next);
}

/** Players in the final year of their deal (extension-eligible during the season). */
export function extensionEligible(league: League, teamId: number): Player[] {
  return playersOf(league, teamId, ['active', 'prospect']).filter((p) => !!p.contract && p.contract.years === 1 && !p.contract.next);
}

export function resignAsk(league: League, p: Player): { salary: number; years: number } {
  const years = typicalTerm(p, league.season);
  return { salary: askingSalary(p, league, p.teamId, years), years };
}

/** 0..1 willingness to re-sign with the current team at a fair price. */
export function willingness(league: League, p: Player): number {
  if (p.teamId === null) return 0;
  const pers = PERSONALITIES[p.personality];
  const rec = league.standings[p.teamId];
  const pct = rec && rec.gp ? (rec.w * 2 + rec.otl) / (rec.gp * 2) : 0.5;
  let w = 0.55 + (p.morale - 55) / 100 + (p.prefs.loyalty - 1) * 0.25 + (pct - 0.5) * pers.winning * 0.6;
  if (isRFA(p, league.season)) w += 0.25;
  return clamp(w, 0.05, 0.98);
}

export interface NegotiationResult {
  ok: boolean;
  message: string;
}

/** Offer a contract to one of your own players (re-sign or extension). */
export function offerContract(league: League, p: Player, salary: number, years: number, terms: Partial<OfferTerms> = {}): NegotiationResult {
  if (p.teamId === null || !p.contract) return { ok: false, message: 'Not under contract with a team.' };
  const resp = respondToOffer(league, p, p.teamId, { aav: salary, years });
  if (!resp.accepted) return { ok: false, message: resp.message };
  const extension = p.contract.years >= 1;
  const ntc = years >= 4 && league.season - p.birthYear >= 26 && p.ca >= 150;
  const res = signFromOffer(league, p, p.teamId, { aav: salary, years, clauses: ntc ? 'NTC' : null, ...terms }, { extension, origin: extension ? 'extension' : 'signing' });
  if (!res.ok) return { ok: false, message: res.message };
  p.morale = clamp(p.morale + 6, 0, 100);
  return { ok: true, message: res.message };
}

/** Arbitration-style resolution for restricted free agents (full hearings live in cba/arbitration). */
export function arbitrate(league: League, p: Player): NegotiationResult {
  if (!p.contract || p.teamId === null) return { ok: false, message: 'No rights held.' };
  if (!isRFA(p, league.season)) return { ok: false, message: 'Only restricted free agents are arbitration-eligible.' };
  const ask = askingSalary(p, league, p.teamId, 2);
  const teamOffer = Math.round(marketValue(p, league) * 0.82);
  const award = Math.max(league.cap.minSalary, Math.round(((ask + teamOffer) / 2) / 5) * 5);
  const years = league.season - p.birthYear >= 24 ? 2 : 1;
  const res = signFromOffer(league, p, p.teamId, { aav: award, years }, { origin: 'arbitration', skipCapCheck: true });
  if (!res.ok) return { ok: false, message: res.message };
  p.morale = clamp(p.morale - 6, 0, 100);
  return { ok: true, message: `Arbitrator awards ${years} year(s) at $${(award / 1000).toFixed(2)}M.` };
}

/** CPU teams decide who to keep among their expiring contracts. */
export function aiResign(league: League, teamId: number): void {
  const team = league.teams[teamId];
  const exp = expiringPlayers(league, teamId).sort((a, b) => b.ca - a.ca);
  const ctx = planContext(league, teamId);
  const booked = (a: { salary: number; years: number }) => {
    ctx.total += a.salary;
    if (a.years >= 2) ctx.future -= a.salary;
  };
  for (const p of exp) {
    const age = league.season - p.birthYear;
    const rfa = isRFA(p, league.season);
    const ask = resignAsk(league, p);
    const room = league.cap.upper * 1.02 - payroll(league, teamId);
    const sameGroup = playersOf(league, teamId, ['active']).filter((x) => (p.pos === 'G' ? x.pos === 'G' : p.pos === 'D' ? x.pos === 'D' : isForward(x.pos)));
    const rank = sameGroup.filter((x) => x.ca > p.ca).length;
    const needed = p.pos === 'G' ? rank < 2 : p.pos === 'D' ? rank < 6 : rank < 11;
    let want = (needed || p.status === 'prospect') && ask.salary <= room + (p.contract?.salary ?? 0);
    if (team.strategy === 'rebuild' && age >= 31) want = want && p.ca >= 150;
    if (age >= 36 && p.ca < 145) want = false;
    if (p.status === 'prospect') want = p.pa >= 125 || p.ca >= 110;
    // Long-term plan: frugal GMs let pricey depth walk; everyone checks future cap space.
    if (want && p.status !== 'prospect') {
      const fit = fitsPlan(league, teamId, p, ask.salary, ask.years, ctx);
      const core = p.ca >= 150 || (age <= 25 && p.pa >= 155);
      if (!fit.ok && !core) want = false;
    }
    if (!want) continue;
    if (rfa) {
      if (signFromOffer(league, p, teamId, { aav: ask.salary, years: ask.years, twoWay: p.status === 'prospect' }, { origin: 'signing', toMinors: p.status === 'prospect' }).ok) booked(ask);
      continue;
    }
    const roll = (seedFrom(league.seed, 'airesign', league.season, p.id) % 1000) / 1000;
    if (roll < willingness(league, p)) {
      const ntc = ask.years >= 4 && age >= 26 && p.ca >= 150;
      if (signFromOffer(league, p, teamId, { aav: ask.salary, years: ask.years, clauses: ntc ? 'NTC' : null }, { origin: 'signing' }).ok) booked(ask);
    }
  }
}

/** Unsigned expiring players become free agents. */
export function releaseExpired(league: League): void {
  for (const p of Object.values(league.players)) {
    if ((p.status === 'active' || p.status === 'prospect') && p.contract && p.contract.years <= 0) {
      const tid = p.teamId;
      releasePlayer(league, p, 'decline to re-sign');
      if (tid !== null && p.reputation >= 50) addNews(league, { category: 'signing', headline: `${fullName(p)} hits the open market after leaving ${teamName(league, tid)}`, teamIds: [tid], playerIds: [p.id], importance: 2 });
    }
  }
}


/** How attractive an offer is to the player (~1.0 = fair, neutral). See cba/market signingScore. */
export function offerUtility(league: League, p: Player, o: Pick<FreeAgentOffer, 'teamId' | 'salary' | 'years'>): number {
  return signingScore(league, p, { teamId: o.teamId, aav: o.salary, years: o.years }).total;
}

export function startFreeAgency(league: League): void {
  // July 1: unqualified RFAs become UFAs, qualified RFAs stay with their club's rights.
  processQualifyingOffers(league);
  releaseExpired(league);
  league.offseasonStep = 'freeAgency';
  league.faOffers = [];
  league.faDay = 0;
  league.phase = 'freeAgency';
}

/** User makes (or updates) an offer to a free agent. */
export function makeOffer(league: League, teamId: number, p: Player, salary: number, years: number): NegotiationResult {
  if (p.status !== 'fa') return { ok: false, message: 'Player is not a free agent.' };
  if (isRestricted(p)) {
    if (p.rightsTeamId !== teamId) return { ok: false, message: `${fullName(p)} is a restricted free agent (${teamName(league, p.rightsTeamId!)} hold his rights). Sign him to an offer sheet instead.` };
    const resp = respondToOffer(league, p, teamId, { aav: salary, years });
    if (!resp.accepted) return { ok: false, message: resp.message };
    const res = signFromOffer(league, p, teamId, { aav: salary, years }, { origin: 'signing' });
    return { ok: res.ok, message: res.message };
  }
  if (salary < league.cap.minSalary) return { ok: false, message: `Minimum salary is $${league.cap.minSalary}K.` };
  if (salary > league.cap.upper * 0.2) return { ok: false, message: 'Exceeds the maximum contract.' };
  const committed = league.faOffers.filter((o) => o.teamId === teamId && o.playerId !== p.id).reduce((s, o) => s + o.salary, 0);
  if (salary + committed > capSpace(league, teamId) + 1) return { ok: false, message: 'Not enough cap space (including your other pending offers).' };
  if (rosterSize(league, teamId) >= league.config.economics.rosterMax) return { ok: false, message: 'Your roster is full.' };
  league.faOffers = league.faOffers.filter((o) => !(o.teamId === teamId && o.playerId === p.id));
  const offer: FreeAgentOffer = { playerId: p.id, teamId, salary, years, day: league.faDay, ntc: false };
  // Outside the free-agency period (in-season), players decide immediately.
  if (league.phase !== 'freeAgency') {
    const u = offerUtility(league, p, offer);
    if (u >= 0.97) {
      const res = signPlayer(league, p, teamId, salary, years, false);
      if (!res.ok) return { ok: false, message: res.message };
      league.faOffers = league.faOffers.filter((x) => x.playerId !== p.id);
      return { ok: true, message: `${fullName(p)} accepts your offer!` };
    }
    return { ok: false, message: `${fullName(p)} declines. He wants roughly $${(askingSalary(p, league, null, years) / 1000).toFixed(2)}M.` };
  }
  league.faOffers.push(offer);
  const u = offerUtility(league, p, offer);
  return { ok: true, message: u >= 1.05 ? `${fullName(p)}'s camp is very interested.` : u >= 0.95 ? `${fullName(p)} is considering your offer.` : `${fullName(p)}'s agent says the offer is below what other teams are discussing.` };
}

function completeSigning(league: League, o: FreeAgentOffer): boolean {
  const p = league.players[o.playerId];
  const res = signPlayer(league, p, o.teamId, o.salary, o.years, o.ntc);
  if (!res.ok) {
    // Illegal now (cap/term/roster): the offer is void.
    league.faOffers = league.faOffers.filter((x) => !(x.playerId === o.playerId && x.teamId === o.teamId));
    return false;
  }
  league.faOffers = league.faOffers.filter((x) => x.playerId !== o.playerId);
  addTransaction(league, { kind: 'signing', teamIds: [o.teamId], playerIds: [p.id], description: `${teamName(league, o.teamId)} sign ${fullName(p)} (${p.pos}): ${o.years} yr / $${(o.salary / 1000).toFixed(2)}M AAV` });
  if (p.reputation >= 45 || o.teamId === league.userTeamId) {
    addNews(league, { category: 'signing', headline: `${fullName(p)} signs ${o.years}-year, $${((o.salary * o.years) / 1000).toFixed(1)}M contract with ${teamName(league, o.teamId)}`, teamIds: [o.teamId], playerIds: [p.id], importance: p.reputation >= 60 ? 4 : 2 });
  }
  return true;
}

/** CPU teams place offers on free agents that fit their needs and budget. */
export function aiOffers(league: League, rng: Rng): void {
  const fas = Object.values(league.players).filter((p) => p.status === 'fa' && !isRestricted(p) && !(p.injury && p.injury.daysRemaining > 60));
  const offerCount = new Map<number, number>();
  for (const o of league.faOffers) offerCount.set(o.playerId, (offerCount.get(o.playerId) ?? 0) + 1);
  const teams = rng.shuffle(league.teams.filter((t) => isCpu(league, t.id)));
  for (const team of teams) {
    const roster = playersOf(league, team.id).filter((p) => !(p.injury && p.injury.daysRemaining > 7));
    const pay = payroll(league, team.id);
    const mine = league.faOffers.filter((o) => o.teamId === team.id);
    const underFloor = pay < league.cap.floor;
    const budgetRoom = Math.min(capSpace(league, team.id), Math.max(team.budget, league.cap.floor) - pay);
    let room = budgetRoom - mine.reduce((s, o) => s + o.salary, 0);
    const wanted = league.config.economics.rosterMax - roster.length - mine.length;
    let slots = Math.max(wanted, 1) + 1;
    if (room < league.cap.minSalary) continue;
    const groups = {
      F: roster.filter((p) => isForward(p.pos)).sort((a, b) => a.ca - b.ca),
      D: roster.filter((p) => p.pos === 'D').sort((a, b) => a.ca - b.ca),
      G: roster.filter((p) => p.pos === 'G').sort((a, b) => a.ca - b.ca),
    };
    const counts = { F: groups.F.length, D: groups.D.length, G: groups.G.length };
    const scored = fas
      .filter((p) => !mine.some((o) => o.playerId === p.id))
      .map((p) => {
        const grp = p.pos === 'G' ? 'G' : p.pos === 'D' ? 'D' : 'F';
        const bestG = groups.G[groups.G.length - 1]?.ca ?? 0;
        const need = grp === 'G' ? counts.G < 2 || (bestG < 138 && p.ca > bestG) : grp === 'D' ? counts.D < 7 : counts.F < 13;
        const weakest = grp === 'G' && bestG < 138 ? bestG : (groups[grp][0]?.ca ?? 90);
        const age = league.season - p.birthYear;
        let score = p.ca - weakest + (need ? 12 : 0) - (offerCount.get(p.id) ?? 0) * 5 + rng.normal(0, 6);
        // A team without a real starting goalie makes him the priority.
        if (grp === 'G' && bestG < 128 && p.ca > bestG + 5) score += 25;
        if (team.strategy === 'rebuild' && age >= 31) score -= 14;
        if (team.strategy === 'contend') score += (p.ca - 130) * 0.15;
        return { p, grp, score, need };
      })
      .filter((x) => x.score > 3)
      .sort((a, b) => b.score - a.score);
    let made = 0;
    const ctx = planContext(league, team.id);
    for (const o of mine) {
      ctx.total += o.salary;
      if (o.years >= 2) ctx.future -= o.salary;
    }
    for (const { p, grp } of scored) {
      if (made >= 4 || slots <= 0) break;
      const age = league.season - p.birthYear;
      const years = typicalTerm(p, league.season, rng);
      const ask = askingSalary(p, league, null, years);
      // Strategy and GM style decide how hard they bid (aggressive GMs sometimes overpay).
      const eager = (underFloor ? 1.12 : team.strategy === 'contend' ? 1.04 : team.strategy === 'rebuild' ? 1.06 : 1) * ctx.plan.overpay;
      const bid = Math.max(league.cap.minSalary, Math.round((ask * rng.float(0.9, 1.08) * eager) / 5) * 5);
      if (bid > room) continue;
      if (!underFloor && !fitsPlan(league, team.id, p, bid, years, ctx).ok) continue;
      ctx.total += bid;
      if (years >= 2) ctx.future -= bid;
      league.faOffers.push({ playerId: p.id, teamId: team.id, salary: bid, years, day: league.faDay, ntc: years >= 4 && age >= 27 && rng.chance(0.4) });
      offerCount.set(p.id, (offerCount.get(p.id) ?? 0) + 1);
      room -= bid;
      slots--;
      made++;
      counts[grp as 'F' | 'D' | 'G']++;
    }
  }
}

/**
 * Cap-clearing trades: CPU teams well under the floor take on a salaried
 * veteran from a CPU team pressed against the cap, for a late pick. This is
 * how real floor teams add talent, and it keeps rebuilding teams from
 * bottoming out completely.
 */
export function absorbCapDumps(league: League): void {
  const cpu = league.teams.filter((t) => isCpu(league, t.id));
  const poor = cpu.filter((t) => payroll(league, t.id) < league.cap.floor * 0.95).sort((a, b) => payroll(league, a.id) - payroll(league, b.id));
  const group = (p: Player) => (p.pos === 'G' ? 'G' : p.pos === 'D' ? 'D' : 'F');
  const MIN = { F: 13, D: 7, G: 2 };
  for (const team of poor) {
    for (let moves = 0; moves < 3; moves++) {
      const shortfall = league.cap.floor - payroll(league, team.id);
      if (shortfall < league.cap.minSalary * 2) break;
      const myG = playersOf(league, team.id, ['active']).filter((p) => p.pos === 'G');
      const bestG = Math.max(0, ...myG.map((p) => p.ca));
      let best: Player | null = null;
      let bestScore = -Infinity;
      for (const giver of cpu) {
        if (giver.id === team.id) continue;
        const pressed = payroll(league, giver.id) >= league.cap.upper * 0.85;
        const active = playersOf(league, giver.id, ['active']);
        const c = rosterCounts(active);
        const theirG = active.filter((p) => p.pos === 'G').sort((a, b) => b.ca - a.ca);
        for (const p of active) {
          const sal = p.contract?.salary ?? 0;
          if (sal < league.cap.minSalary * 2 || sal > shortfall + league.cap.minSalary * 3) continue;
          if (league.season - p.birthYear < 26 || p.id === giver.captain || p.contract?.ntc) continue;
          if (c[group(p)] <= MIN[group(p)]) continue;
          // Teams with a spare goalie move him to a floor team that badly needs one.
          const spareGoalie = p.pos === 'G' && theirG[0]?.id !== p.id && bestG < 130 && p.ca > bestG + 6;
          if (!pressed && !spareGoalie) continue;
          const score = p.ca + (spareGoalie ? 25 : 0);
          if (score > bestScore) {
            best = p;
            bestScore = score;
          }
        }
      }
      if (!best) break;
      const from = best.teamId!;
      const pick = league.draftPicks
        .filter((d) => d.ownerId === team.id && d.season > league.season && d.round >= 4)
        .sort((a, b) => b.round - a.round)[0];
      const dump = { from: team.id, to: from, give: pick ? [{ kind: 'pick' as const, id: pick.id }] : [], get: [{ kind: 'player' as const, id: best.id }] };
      if (validateTrade(league, dump).length) break;
      executeTrade(league, dump);
      trimRoster(league, team.id);
      ensureDressable(league, from);
    }
  }
}

/** Teams still under the cap floor at the end of free agency sign one-year deals to reach it. */
export function enforceCapFloor(league: League): void {
  for (const team of league.teams) {
    if (!isCpu(league, team.id)) continue;
    for (let guard = 0; guard < 6 && payroll(league, team.id) < league.cap.floor; guard++) {
      const p = Object.values(league.players).filter((x) => x.status === 'fa').sort((a, b) => b.ca - a.ca)[0];
      if (!p) break;
      const ask = askingSalary(p, league, null, 1);
      const salary = Math.max(ask, Math.min(league.cap.floor - payroll(league, team.id), ask * 1.6));
      completeSigning(league, { playerId: p.id, teamId: team.id, salary: Math.round(salary / 5) * 5, years: 1, day: league.faDay, ntc: false });
    }
  }
}

/** Players review offers and sign when an offer is good enough for the day. */
function playerDecisions(league: League, rng: Rng, final: boolean): void {
  const byPlayer = new Map<number, FreeAgentOffer[]>();
  for (const o of league.faOffers) byPlayer.set(o.playerId, [...(byPlayer.get(o.playerId) ?? []), o]);
  for (const [pid, offers] of byPlayer) {
    const p = league.players[pid];
    if (!p || p.status !== 'fa' || isRestricted(p)) continue;
    // Drop offers that no longer fit the team's cap.
    const valid = offers.filter((o) => o.salary <= capSpace(league, o.teamId) + 1 && playersOf(league, o.teamId).length < league.config.economics.rosterMax + 4);
    if (!valid.length) continue;
    const scored = valid.map((o) => ({ o, u: offerUtility(league, p, o) })).sort((a, b) => b.u - a.u);
    const best = scored[0];
    const urgency = league.faDay / FA_DAYS;
    const depth = p.ca < 130 ? 0.2 : 0;
    const pSign = clamp(0.2 + depth + urgency * 0.7 + (best.u - 1) * 2.5 + (scored.length - 1) * 0.04, 0.05, 1);
    if (final || rng.chance(pSign)) completeSigning(league, best.o);
  }
}

/** Advance free agency by one day. Returns true when the period is over. */
export function processFADay(league: League): boolean {
  withRng(league, (rng) => {
    const final = league.faDay >= FA_DAYS - 1;
    rfaDay(league, rng, final);
    aiRfaNegotiations(league);
    aiOffers(league, rng);
    playerDecisions(league, rng, final);
  });
  league.faDay++;
  if (league.faDay >= FA_DAYS) {
    absorbCapDumps(league);
    enforceCapFloor(league);
  }
  return league.faDay >= FA_DAYS;
}

/** In-season: CPU teams pick up free agents when injuries leave holes. */
export function aiInSeasonSignings(league: League): void {
  // Handled by ensureDressable; kept for symmetry and future expansion.
  void league;
}

export function faPool(league: League): Player[] {
  return Object.values(league.players).filter((p) => p.status === 'fa').sort((a, b) => b.ca - a.ca);
}

export function pendingOffersFor(league: League, playerId: number): FreeAgentOffer[] {
  return league.faOffers.filter((o) => o.playerId === playerId);
}

export function demandFor(league: League, p: Player): { salary: number; years: number } {
  const years = typicalTerm(p, league.season, new Rng(seedFrom(league.seed, 'term', p.id, league.season)));
  return { salary: askingSalary(p, league, null, years), years };
}

/** CPU clubs negotiate with their own unsigned RFAs early in free agency. */
export function aiRfaNegotiations(league: League): void {
  if (league.faDay > 7) return;
  for (const p of Object.values(league.players)) {
    if (!isRestricted(p) || !isCpu(league, p.rightsTeamId!)) continue;
    if (league.offerSheets.some((o) => o.playerId === p.id && o.status === 'pending')) continue;
    if (league.arbitration.some((a) => a.playerId === p.id && a.season === league.season && a.status === 'filed')) continue;
    const teamId = p.rightsTeamId!;
    const value = contractValue(p, league).value;
    const prof = freeAgentProfile(p, league);
    const years = Math.min(prof.desiredTerm, rulesFor(capSeason(league)).maxTermOwnTeam);
    const offer = Math.round((value * (0.92 + league.faDay * 0.015)) / 5) * 5;
    if (offer > capSpace(league, teamId) + 50) continue;
    const resp = respondToOffer(league, p, teamId, { aav: offer, years });
    if (resp.accepted) signFromOffer(league, p, teamId, { aav: offer, years }, { origin: 'signing' });
  }
}
