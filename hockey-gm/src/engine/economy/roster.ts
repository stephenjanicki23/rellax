import type { League, Player } from '../types';
import { addNews, addTransaction, playersOf, teamName, withRng } from '../league/helpers';
import { generatePlayer } from '../player/generate';
import { capSpace, makeContract, marketValue } from './contracts';
import { fullName, isForward } from '../player/ability';
import { emptyStatLine } from '../core/statline';

const healthy = (p: Player) => !p.injury || p.injury.daysRemaining <= 0;

/** Players on injured reserve (out more than a week) do not count against the roster limit. */
export const onIR = (p: Player): boolean => !!p.injury && p.injury.daysRemaining > 7;

export function rosterSize(league: League, teamId: number): number {
  return playersOf(league, teamId, ['active']).filter((p) => !onIR(p)).length;
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
  if (p.status !== 'prospect') return;
  p.status = 'active';
  ensureStats(league, p);
  if (announce && p.teamId !== null) addTransaction(league, { kind: 'callup', teamIds: [p.teamId], playerIds: [p.id], description: `${teamName(league, p.teamId)} recall ${fullName(p)} (${p.pos})` });
}

export function demote(league: League, p: Player, announce = true): void {
  if (p.status !== 'active') return;
  p.status = 'prospect';
  const age = league.season - p.birthYear;
  if (age >= 25) p.morale = Math.max(0, p.morale - 20);
  if (announce && p.teamId !== null) addTransaction(league, { kind: 'senddown', teamIds: [p.teamId], playerIds: [p.id], description: `${teamName(league, p.teamId)} assign ${fullName(p)} to the minors` });
}

export function releasePlayer(league: League, p: Player, reason = 'released'): void {
  const tid = p.teamId;
  p.teamId = null;
  p.status = 'fa';
  p.contract = null;
  p.rightsTeamId = null;
  if (tid !== null) {
    const t = league.teams[tid];
    t.lines = { ...t.lines };
    addTransaction(league, { kind: 'release', teamIds: [tid], playerIds: [p.id], description: `${teamName(league, tid)} ${reason} ${fullName(p)}` });
  }
}

export function signPlayer(league: League, p: Player, teamId: number, salary: number, years: number, ntc = false): void {
  p.teamId = teamId;
  p.status = 'active';
  p.rightsTeamId = null;
  p.contract = makeContract(salary, years, league.season, ntc);
  ensureStats(league, p);
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
      .filter((p) => match(p) && healthy(p))
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
      signPlayer(league, fa, teamId, Math.max(league.cap.minSalary, Math.min(marketValue(fa, league), league.cap.minSalary * 1.5)), 1);
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
    signPlayer(league, callup, teamId, league.cap.minSalary, 1);
    addTransaction(league, { kind: 'signing', teamIds: [teamId], playerIds: [callup.id], description: `${teamName(league, teamId)} sign minor-leaguer ${fullName(callup)} to fill an emergency need` });
  }
}

/** Trim an over-full active roster: send down young players first, then release the weakest veteran. */
export function trimRoster(league: League, teamId: number): void {
  const max = league.config.economics.rosterMax;
  for (let guard = 0; guard < 10; guard++) {
    const active = playersOf(league, teamId, ['active']).filter((p) => !onIR(p));
    if (active.length <= max) return;
    const c = rosterCounts(active);
    const canLose = (p: Player) => {
      if (p.pos === 'G') return c.G > 2;
      if (p.pos === 'D') return c.D > 7;
      return c.F > 13;
    };
    const young = active.filter((p) => league.season - p.birthYear <= 23 && canLose(p)).sort((a, b) => a.ca - b.ca)[0];
    const worst = active.filter(canLose).sort((a, b) => a.ca - b.ca)[0];
    const target = young && (!worst || young.ca <= worst.ca + 6) ? young : worst;
    if (!target) return;
    if (league.season - target.birthYear <= 23) demote(league, target, teamId === league.userTeamId);
    else releasePlayer(league, target, 'place on waivers and release');
  }
}

/** Promote prospects who are clearly better than the weakest regulars (CPU teams). */
export function promoteReadyProspects(league: League, teamId: number): void {
  const prospects = playersOf(league, teamId, ['prospect']).filter((p) => healthy(p) && league.season - p.birthYear >= 19);
  for (const pr of prospects.sort((a, b) => b.ca - a.ca)) {
    const active = playersOf(league, teamId, ['active']);
    const same = active.filter((p) => (pr.pos === 'G' ? p.pos === 'G' : pr.pos === 'D' ? p.pos === 'D' : isForward(p.pos) && p.pos !== 'G'));
    const weakest = same.sort((a, b) => a.ca - b.ca)[0];
    const max = league.config.economics.rosterMax;
    if (active.length < max && pr.ca >= 120 && (!weakest || pr.ca > weakest.ca + 3)) {
      promote(league, pr, false);
    } else if (weakest && pr.ca > weakest.ca + 6 && pr.ca >= 122) {
      promote(league, pr, false);
      if (league.season - weakest.birthYear <= 23) demote(league, weakest, false);
      else releasePlayer(league, weakest, 'release');
    }
  }
}

export function noteRosterMove(league: League, teamId: number, text: string, playerIds: number[]): void {
  addNews(league, { category: 'league', headline: text, teamIds: [teamId], playerIds, importance: 1 });
}

/** Get under the salary cap: send down cap-carrying youngsters, then release the worst value contracts. */
export function enforceCap(league: League, teamId: number): void {
  for (let guard = 0; guard < 12; guard++) {
    const over = -capSpace(league, teamId);
    if (over <= 0) return;
    const active = playersOf(league, teamId, ['active']);
    const c = rosterCounts(active);
    const canLose = (p: Player) => (p.pos === 'G' ? c.G > 2 : p.pos === 'D' ? c.D > 6 : c.F > 12);
    const young = active.filter((p) => league.season - p.birthYear <= 23 && canLose(p) && (p.contract?.salary ?? 0) > league.cap.minSalary).sort((a, b) => a.ca - b.ca)[0];
    if (young && young.ca < 145) {
      demote(league, young, teamId === league.userTeamId);
      continue;
    }
    // Worst value per dollar among players we can spare.
    const cands = active.filter(canLose).filter((p) => p.contract).sort((a, b) => (marketValue(a, league) - a.contract!.salary) - (marketValue(b, league) - b.contract!.salary));
    const target = cands[0];
    if (!target) return;
    releasePlayer(league, target, 'buy out');
  }
}

/** Keep the prospect pool within the configured limit (release the lowest-ceiling prospects). */
export function trimProspects(league: League, teamId: number): void {
  const max = league.config.economics.prospectMax;
  const pros = playersOf(league, teamId, ['prospect']).sort((a, b) => b.pa + b.ca * 0.2 - (a.pa + a.ca * 0.2));
  for (const p of pros.slice(max)) {
    if (league.season - p.birthYear <= 19 && p.pa >= 130) continue;
    releasePlayer(league, p, 'release prospect');
  }
}
