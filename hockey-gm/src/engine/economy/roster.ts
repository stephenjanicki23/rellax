import type { League, Player } from '../types';
import { addNews, addTransaction, playersOf, teamName, withRng } from '../league/helpers';
import { generatePlayer } from '../player/generate';
import { capSpace, marketValue } from './contracts';
import { signFromOffer, type SignResult } from '../cba/contractService';
import { capSeason, contractFor, teamCapSheet } from '../cba/capManager';
import { endOf } from '../cba/contract';
import { rulesFor } from '../cba/rules';
import { buyoutPlayer, canPlaceOnLTIR, inBuyoutWindow, placeOnLTIR } from '../cba/capActions';
import { executeTrade, validateTrade } from './trade';
import { needsWaivers, onWaivers, placeOnWaivers, waiverConsentBlock, waiverPeriod, waiverRisk } from '../cba/waivers';
import { fullName, isForward } from '../player/ability';
import { emptyStatLine } from '../core/statline';

const healthy = (p: Player) => !p.injury || p.injury.daysRemaining <= 0;

/** Players on injured reserve (out more than a week) do not count against the roster limit. */
export const onIR = (p: Player): boolean => !!p.injury && p.injury.daysRemaining > 7;

const onWaiversNow = (league: League, p: Player): boolean => !!onWaivers(league, p.id);

export function rosterSize(league: League, teamId: number): number {
  return playersOf(league, teamId, ['active']).filter((p) => !onIR(p) && !p.ltir).length;
}

export function rosterCounts(players: Player[]): { F: number; D: number; G: number; total: number } {
  const h = players.filter(healthy);
  return {
    F: h.filter((p) => isForward(p.pos)).length,
    D: h.filter((p) => p.pos === 'D').length,
    G: h.filter((p) => p.pos === 'G').length,
    total: players.length,
  };
}

function ensureStats(league: League, p: Player): void {
  if (!league.seasonStats[p.id] && p.teamId !== null) league.seasonStats[p.id] = { reg: emptyStatLine(), po: emptyStatLine(), teamId: p.teamId };
  else if (league.seasonStats[p.id] && p.teamId !== null) league.seasonStats[p.id].teamId = p.teamId;
}

export function promote(league: League, p: Player, announce = true): void {
  // Unsigned draft picks can't play until they sign.
  if (p.status !== 'prospect' || !p.contract || onWaiversNow(league, p)) return;
  p.status = 'active';
  ensureStats(league, p);
  if (announce && p.teamId !== null) addTransaction(league, { kind: 'callup', teamIds: [p.teamId], playerIds: [p.id], description: `${teamName(league, p.teamId)} recall ${fullName(p)} (${p.pos})` });
}

export interface MoveResult {
  ok: boolean;
  message: string;
}

/**
 * Assign a player to the minors. Non-exempt players go through waivers
 * during the waiver period; NMC players refuse (CBA 11.8, 13).
 */
export function demote(league: League, p: Player, announce = true): MoveResult {
  if (p.status !== 'active') return { ok: false, message: `${fullName(p)} is not on the NHL roster.` };
  const block = waiverConsentBlock(league, p);
  if (block) return { ok: false, message: block };
  const age = league.season - p.birthYear;
  if (age >= 25) p.morale = Math.max(0, p.morale - 20);
  if (needsWaivers(league, p).required) return placeOnWaivers(league, p, 'assignment');
  p.status = 'prospect';
  const msg = `${teamName(league, p.teamId)} assign ${fullName(p)} to the minors`;
  if (announce && p.teamId !== null) addTransaction(league, { kind: 'senddown', teamIds: [p.teamId], playerIds: [p.id], description: msg });
  return { ok: true, message: msg };
}

/**
 * Release a player. Unsigned players and expired contracts go immediately.
 * Signed players: a buyout in the offseason window; otherwise only two-way
 * or expiring deals can be terminated (unconditional waivers + mutual
 * termination). One-way multi-year contracts cannot be dropped mid-season.
 */
export function releasePlayer(league: League, p: Player, reason = 'released'): MoveResult {
  const tid = p.teamId;
  const c = p.contract ? contractFor(p, capSeason(league)) : null;
  if (c && tid !== null && (p.status === 'active' || p.status === 'prospect')) {
    if (inBuyoutWindow(league) && contractFor(p, league.season + 1)) {
      const r = buyoutPlayer(league, p);
      return { ok: r.ok, message: r.ok ? `${fullName(p)} bought out.` : r.errors.join(' ') };
    }
    const expiring = endOf(c) <= capSeason(league);
    if (!expiring && !c.twoWay)
      return { ok: false, message: `Release rejected: ${fullName(p)} has a one-way contract through ${endOf(c)}-${(endOf(c) + 1) % 100}. Trade him, place him on waivers for assignment, or buy him out in the offseason buyout window.` };
    if (waiverPeriod(league) && needsWaivers(league, p).required) return placeOnWaivers(league, p, 'release');
  }
  p.teamId = null;
  p.status = 'fa';
  p.contract = null;
  p.rightsTeamId = null;
  p.ltir = false;
  const msg = `${teamName(league, tid)} ${reason} ${fullName(p)}`;
  if (tid !== null) {
    const t = league.teams[tid];
    t.lines = { ...t.lines };
    addTransaction(league, { kind: c ? 'termination' : 'release', teamIds: [tid], playerIds: [p.id], description: msg });
  }
  return { ok: true, message: msg };
}

/**
 * Sign a player through the ContractService (CBA validation + cap check).
 * Returns the result so callers can react to an illegal contract.
 */
export function signPlayer(league: League, p: Player, teamId: number, salary: number, years: number, ntc = false, opts: { skipCapCheck?: boolean; origin?: 'signing' | 'offerSheet'; announce?: boolean } = {}): SignResult {
  const res = signFromOffer(league, p, teamId, { aav: salary, years, clauses: ntc ? 'NTC' : null, twoWay: salary < league.cap.minSalary * 1.4 && years <= 2 }, { skipCapCheck: opts.skipCapCheck, origin: opts.origin ?? 'signing', announce: opts.announce ?? false });
  if (res.ok) {
    p.status = 'active';
    ensureStats(league, p);
  }
  return res;
}

/**
 * Make sure a team can dress 12F / 6D / 2G healthy players: recall prospects
 * first, then sign the best cheap free agent.
 */
export function ensureDressable(league: League, teamId: number): void {
  const need = { F: 12, D: 6, G: 2 };
  for (let guard = 0; guard < 8; guard++) {
    const active = playersOf(league, teamId, ['active']);
    const c = rosterCounts(active);
    const missing: ('F' | 'D' | 'G')[] = [];
    if (c.G < need.G) missing.push('G');
    if (c.D < need.D) missing.push('D');
    if (c.F < need.F) missing.push('F');
    if (!missing.length) return;
    const pos = missing[0];
    const match = (p: Player) => (pos === 'G' ? p.pos === 'G' : pos === 'D' ? p.pos === 'D' : isForward(p.pos));
    const prospect = playersOf(league, teamId, ['prospect'])
      .filter((p) => p.contract && match(p) && healthy(p) && !onWaiversNow(league, p))
      .sort((a, b) => b.ca - a.ca)[0];
    const fa = Object.values(league.players)
      .filter((p) => p.status === 'fa' && match(p) && healthy(p))
      .sort((a, b) => b.ca - a.ca)
      .find((p) => Math.min(marketValue(p, league), league.cap.minSalary * 1.5) <= Math.max(league.cap.minSalary, capSpace(league, teamId)));
    // Recall from the system unless a clearly better free agent is affordable.
    if (prospect && (!fa || fa.ca < prospect.ca + 8)) {
      promote(league, prospect, teamId === league.userTeamId);
      continue;
    }
    if (fa) {
      // Emergency signing to dress a legal lineup (game simplification: allowed even if it breaches the cap).
      const room = capSpace(league, teamId);
      const pay = room >= league.cap.minSalary * 1.5 ? Math.max(league.cap.minSalary, Math.min(marketValue(fa, league), league.cap.minSalary * 1.5)) : league.cap.minSalary;
      signPlayer(league, fa, teamId, pay, 1, false, { skipCapCheck: true });
      addTransaction(league, { kind: 'signing', teamIds: [teamId], playerIds: [fa.id], description: `${teamName(league, teamId)} sign ${fullName(fa)} to a one-year deal` });
      continue;
    }
    // Nobody left anywhere: sign a replacement-level minor-league call-up so the team can dress a lineup.
    const callup = withRng(league, (rng) => {
      const p = pos === 'G' ? 'G' : pos === 'D' ? 'D' : rng.pick(['C', 'LW', 'RW'] as const);
      const target = Math.round(100 + rng.normal(0, 5));
      return generatePlayer(rng, { id: league.nextId.player++, pos: p, targetCA: target, age: rng.int(24, 31), season: league.season });
    });
    league.players[callup.id] = callup;
    signPlayer(league, callup, teamId, league.cap.minSalary, 1, false, { skipCapCheck: true });
    addTransaction(league, { kind: 'signing', teamIds: [teamId], playerIds: [callup.id], description: `${teamName(league, teamId)} sign minor-leaguer ${fullName(callup)} to fill an emergency need` });
  }
}

/** Cost of sending a player down: waiver risk for non-exempt players, nothing for exempt ones. */
function sendDownCost(league: League, p: Player): number {
  if (waiverConsentBlock(league, p)) return Infinity;
  if (!needsWaivers(league, p).required) return 0;
  // AI GMs know who would be claimed: risk × how much the player matters.
  return waiverRisk(league, p) * (10 + Math.max(0, p.ca - 110));
}

/** Trim an over-full active roster: send down waiver-exempt players first, then whoever is least likely to be claimed. */
export function trimRoster(league: League, teamId: number): void {
  const max = league.config.economics.rosterMax;
  for (let guard = 0; guard < 12; guard++) {
    const active = playersOf(league, teamId, ['active']).filter((p) => !onIR(p) && !p.ltir);
    if (active.length <= max) return;
    const c = rosterCounts(active);
    const canLose = (p: Player) => {
      if (p.pos === 'G') return c.G > 2;
      if (p.pos === 'D') return c.D > 7;
      return c.F > 13;
    };
    const ranked = active
      .filter(canLose)
      .map((p) => ({ p, cost: sendDownCost(league, p) + p.ca * 0.15 }))
      .filter((x) => Number.isFinite(x.cost))
      .sort((a, b) => a.cost - b.cost);
    const target = ranked[0]?.p;
    if (!target) return;
    const r = demote(league, target, teamId === league.userTeamId);
    if (!r.ok) {
      const rel = releasePlayer(league, target, 'release');
      if (!rel.ok) return;
    }
  }
}

/** Promote prospects who are clearly better than the weakest regulars (CPU teams). */
export function promoteReadyProspects(league: League, teamId: number): void {
  const prospects = playersOf(league, teamId, ['prospect']).filter((p) => healthy(p) && league.season - p.birthYear >= 19 && p.contract && !onWaiversNow(league, p));
  for (const pr of prospects.sort((a, b) => b.ca - a.ca)) {
    const active = playersOf(league, teamId, ['active']);
    const same = active.filter((p) => (pr.pos === 'G' ? p.pos === 'G' : pr.pos === 'D' ? p.pos === 'D' : isForward(p.pos) && p.pos !== 'G'));
    const weakest = same.sort((a, b) => a.ca - b.ca)[0];
    const max = league.config.economics.rosterMax;
    if (active.length < max && pr.ca >= 120 && (!weakest || pr.ca > weakest.ca + 3)) {
      promote(league, pr, false);
    } else if (weakest && pr.ca > weakest.ca + 6 && pr.ca >= 122 && sendDownCost(league, weakest) < 12) {
      promote(league, pr, false);
      if (!demote(league, weakest, false).ok) releasePlayer(league, weakest, 'release');
    }
  }
}

export function noteRosterMove(league: League, teamId: number, text: string, playerIds: number[]): void {
  addNews(league, { category: 'league', headline: text, teamIds: [teamId], playerIds, importance: 1 });
}

/**
 * Get cap compliant (CPU): LTIR for long-term injuries, send down waiver-exempt
 * cap carriers, waive low-risk contracts to the minors (buried relief), and in
 * the buyout window buy out the worst-value contract.
 */
export function enforceCap(league: League, teamId: number): void {
  for (let guard = 0; guard < 14; guard++) {
    const sheet = teamCapSheet(league, teamId);
    const over = sheet.total - sheet.effectiveLimit;
    if (over <= 0) return;
    const active = playersOf(league, teamId, ['active']);
    // 1. Long-term injuries go on LTIR.
    const ltirCand = active.filter((p) => !p.ltir && canPlaceOnLTIR(league, p).ok).sort((a, b) => (b.contract?.salary ?? 0) - (a.contract?.salary ?? 0))[0];
    if (ltirCand && placeOnLTIR(league, ltirCand).ok) continue;
    const c = rosterCounts(active);
    const canLose = (p: Player) => (p.pos === 'G' ? c.G > 2 : p.pos === 'D' ? c.D > 6 : c.F > 12);
    const buriedRelief = (p: Player) => Math.min(p.contract?.salary ?? 0, league.cap.minSalary + rulesFor(capSeason(league)).buriedAllowance);
    // 2./3. Send down whoever frees cap at the lowest risk.
    const send = active
      .filter((p) => canLose(p) && p.contract && !p.contract.thirtyFivePlus && (p.contract.salary ?? 0) > league.cap.minSalary + 100)
      // Burying saves at most min + $375K, so only cheap, low-impact contracts are worth sending down.
      .map((p) => ({ p, cost: sendDownCost(league, p) + Math.max(0, p.ca - 120) * 0.4 - buriedRelief(p) / 400 + Math.max(0, (p.contract?.salary ?? 0) - buriedRelief(p)) / 400 }))
      .filter((x) => Number.isFinite(x.cost))
      .sort((a, b) => a.cost - b.cost)[0];
    if (send && demote(league, send.p, teamId === league.userTeamId).ok) continue;
    // 4. Buyout window: worst value per dollar.
    if (inBuyoutWindow(league)) {
      const cands = [...active, ...playersOf(league, teamId, ['prospect'])]
        .filter((p) => p.contract && contractFor(p, league.season + 1) && (p.status === 'prospect' || canLose(p)))
        .sort((a, b) => (marketValue(a, league) - a.contract!.salary) - (marketValue(b, league) - b.contract!.salary));
      if (cands[0] && buyoutPlayer(league, cands[0]).ok) continue;
    }
    // 5. Trade a contract to a team with cap space (a pick goes with an overpaid deal).
    if (dumpContract(league, teamId, over)) continue;
    return;
  }
}

/** Cap dump: move the contract that best clears the overage to a CPU team with room, sweetened with a pick if it is overpaid. */
function dumpContract(league: League, teamId: number, over: number): boolean {
  if (league.phase === 'playoffs' || (league.phase === 'regular' && league.day > league.tradeDeadlineDay)) return false;
  const active = playersOf(league, teamId, ['active']);
  const grp = (p: Player) => (p.pos === 'G' ? 'G' : p.pos === 'D' ? 'D' : 'F');
  // A dumped player must be replaceable: by a spare regular or a signed minor-leaguer at his position.
  const spare = (p: Player) => {
    const same = active.filter((x) => grp(x) === grp(p)).length;
    const need = grp(p) === 'G' ? 2 : grp(p) === 'D' ? 6 : 12;
    return same > need || playersOf(league, teamId, ['prospect']).some((x) => x.contract && grp(x) === grp(p) && !onWaiversNow(league, x));
  };
  const cands = active
    .filter((p) => p.contract && spare(p) && p.contract.salary >= Math.min(over, 1000))
    .sort((a, b) => (a.contract!.salary >= over ? 0 : 1) - (b.contract!.salary >= over ? 0 : 1) || (marketValue(a, league) - a.contract!.salary) - (marketValue(b, league) - b.contract!.salary));
  const partners = league.teams.filter((t) => t.id !== teamId && t.id !== league.userTeamId).sort((a, b) => teamCapSheet(league, b.id).space - teamCapSheet(league, a.id).space);
  for (const p of cands.slice(0, 4)) {
    const overpaid = marketValue(p, league) < p.contract!.salary * 0.85;
    const pick = overpaid ? league.draftPicks.filter((d) => d.ownerId === teamId && d.playerId === undefined && d.season > league.season).sort((a, b) => b.round - a.round || a.season - b.season).find((d) => d.round <= 4) : undefined;
    for (const t of partners.slice(0, 8)) {
      const proposal = { from: teamId, to: t.id, give: [{ kind: 'player' as const, id: p.id }, ...(pick ? [{ kind: 'pick' as const, id: pick.id }] : [])], get: [] };
      if (validateTrade(league, proposal).length) continue;
      executeTrade(league, proposal);
      trimRoster(league, t.id);
      ensureDressable(league, teamId);
      return true;
    }
  }
  return false;
}

/** Keep the prospect pool within the configured limit (release the lowest-ceiling prospects). */
export function trimProspects(league: League, teamId: number): void {
  const max = league.config.economics.prospectMax;
  // Unsigned draft picks don't take a spot; their rights run out on their own schedule.
  const pros = playersOf(league, teamId, ['prospect']).filter((p) => p.contract).sort((a, b) => b.pa + b.ca * 0.2 - (a.pa + a.ca * 0.2));
  for (const p of pros.slice(max)) {
    if (league.season - p.birthYear <= 19 && p.pa >= 130) continue;
    releasePlayer(league, p, 'release prospect');
  }
}
