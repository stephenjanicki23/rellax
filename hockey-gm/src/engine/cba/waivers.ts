/**
 * Waivers (CBA 13): non-exempt players need waivers to be assigned to the
 * minors during the season (training camp onward) or released. Other teams
 * may claim them for 24 hours; the claim with the highest priority (worst
 * points percentage; previous season's standings early in the year) wins and
 * takes on the contract as is.
 */
import type { League, Player, WaiverEntry } from '../types';
import { addNews, addTransaction, teamName } from '../league/helpers';
import { standingRows } from '../league/standings';
import { waiverStatus, fmtCap } from './rulesEngine';
import { activeClause, holderCapHit } from './contract';
import { capSeason, teamCapSheet } from './capManager';
import { rulesFor } from './rules';
import { contractValue } from './market';
import { isForward } from '../player/ability';
import { emptyStatLine } from '../core/statline';
import { rosterChangeFamiliarity } from '../team/fit';

const name = (p: Player) => `${p.first} ${p.last}`;
const grp = (p: Player) => (p.pos === 'G' ? 'G' : p.pos === 'D' ? 'D' : isForward(p.pos) ? 'F' : 'F');

/** Waivers apply from training camp through the end of the regular season (and to playoff assignments). */
export function waiverPeriod(league: League): boolean {
  return league.phase === 'preseason' || league.phase === 'regular' || league.phase === 'playoffs';
}

export function needsWaivers(league: League, p: Player): { required: boolean; reason: string } {
  if (!p.contract) return { required: false, reason: 'No NHL contract.' };
  if (!waiverPeriod(league)) return { required: false, reason: 'Outside the waiver period (summer assignments do not require waivers).' };
  const st = waiverStatus(p, capSeason(league), league);
  return { required: !st.exempt, reason: st.reason };
}

/** NMC players cannot be sent to the minors or waived without consent (CBA 11.8). */
export function waiverConsentBlock(league: League, p: Player): string | null {
  const c = p.contract;
  if (!c) return null;
  const cl = activeClause(c, capSeason(league));
  if (cl?.kind === 'NMC') return `${name(p)} has a no-movement clause and will not consent to waivers or a minor-league assignment.`;
  return null;
}

/** Claim order: worst points percentage first; previous season's final standings for the first ~10% of the season. */
export function waiverPriority(league: League): number[] {
  const rows = standingRows(league);
  const gp = rows.reduce((s, r) => s + r.rec.gp, 0) / Math.max(1, rows.length);
  if (league.phase === 'regular' && gp >= 8) return [...rows].sort((a, b) => a.pct - b.pct || b.rec.gp - a.rec.gp).map((r) => r.team.id);
  const last = league.history[league.history.length - 1];
  if (last) return [...last.standings].sort((a, b) => a.pts - b.pts).map((s) => s.teamId);
  return league.teams.map((t) => t.id).reverse();
}

export function onWaivers(league: League, playerId: number): WaiverEntry | undefined {
  return league.waivers.find((w) => w.playerId === playerId && (w.status ?? 'pending') === 'pending');
}

/** Place a player on waivers (assignment = to the minors if he clears; release = contract terminated if he clears). */
export function placeOnWaivers(league: League, p: Player, reason: WaiverEntry['reason']): { ok: boolean; message: string } {
  if (p.teamId === null || !p.contract) return { ok: false, message: `${name(p)} is not under contract.` };
  if (onWaivers(league, p.id)) return { ok: false, message: `${name(p)} is already on waivers.` };
  const block = waiverConsentBlock(league, p);
  if (block) return { ok: false, message: block };
  const tid = p.teamId;
  league.waivers.push({ playerId: p.id, fromTeamId: tid, season: league.season, day: league.day, claims: [], reason, status: 'pending' });
  // He is off the NHL roster while on waivers.
  p.status = 'prospect';
  const msg = `${teamName(league, tid)} place ${name(p)} on waivers${reason === 'assignment' ? ' for the purpose of assignment' : ''} (cap hit ${fmtCap(holderCapHit(p.contract))})`;
  addTransaction(league, { kind: 'waivers', teamIds: [tid], playerIds: [p.id], description: msg });
  return { ok: true, message: msg };
}

/** Put in a claim (user or AI). */
export function claimOnWaivers(league: League, teamId: number, playerId: number): { ok: boolean; message: string } {
  const w = onWaivers(league, playerId);
  if (!w) return { ok: false, message: 'That player is not on waivers.' };
  if (w.fromTeamId === teamId) return { ok: false, message: 'A team cannot claim its own player.' };
  const p = league.players[playerId];
  const fit = claimFit(league, teamId, p);
  if (!fit.ok) return { ok: false, message: fit.reason };
  if (!w.claims.includes(teamId)) w.claims.push(teamId);
  return { ok: true, message: `Claim submitted for ${name(p)}. Priority decides if several teams claim him.` };
}

/** Can this team absorb the contract (cap space and the 50-contract limit)? */
export function claimFit(league: League, teamId: number, p: Player): { ok: boolean; reason: string } {
  if (!p.contract) return { ok: false, reason: 'No contract.' };
  const sheet = teamCapSheet(league, teamId);
  const hit = holderCapHit(p.contract);
  if (sheet.total + hit > sheet.effectiveLimit + 1e-6) return { ok: false, reason: `Claim rejected: ${teamName(league, teamId)} would exceed the cap by ${fmtCap(sheet.total + hit - sheet.effectiveLimit)}.` };
  if (sheet.rows.length + 1 > rulesFor(capSeason(league)).contractLimit) return { ok: false, reason: `Claim rejected: ${teamName(league, teamId)} is at the 50-contract limit.` };
  return { ok: true, reason: '' };
}

/** Would a CPU team claim this player? (need at his position, value for money, cap fit) */
export function aiWantsClaim(league: League, teamId: number, p: Player): boolean {
  if (!p.contract) return false;
  const age = capSeason(league) - p.birthYear;
  const same = Object.values(league.players).filter((x) => x.teamId === teamId && x.status === 'active' && grp(x) === grp(p)).sort((a, b) => b.ca - a.ca);
  const slots = p.pos === 'G' ? 2 : p.pos === 'D' ? 6 : 12;
  const bar = same[slots - 1]?.ca ?? 0;
  const upgrade = p.ca >= bar + 3;
  const upside = age <= 24 && p.pa >= 140 && p.pa - p.ca >= 10;
  if (!upgrade && !upside) return false;
  const value = contractValue(p, league).value;
  const strat = league.teams[teamId].strategy;
  const tolerance = strat === 'contend' ? 0.85 : strat === 'rebuild' ? 1.05 : 0.95;
  return value >= holderCapHit(p.contract) * tolerance && claimFit(league, teamId, p).ok;
}

/** How likely is this player to be claimed if waived (AI demotion decisions). */
export function waiverRisk(league: League, p: Player): number {
  if (!p.contract) return 0;
  let n = 0;
  for (const t of league.teams) if (t.id !== p.teamId && aiWantsClaim(league, t.id, p)) n++;
  return Math.min(1, n / 3);
}

/**
 * Resolve waivers that have run their 24 hours (or all of them when
 * `force`, e.g. at a phase change). Claimed players join the highest-priority
 * claimant with their contract; cleared players are assigned or released.
 */
export function processWaivers(league: League, force = false): void {
  const pending = league.waivers.filter((w) => (w.status ?? 'pending') === 'pending' && (force || w.season < league.season || w.day < league.day));
  if (!pending.length) return;
  const priority = waiverPriority(league);
  for (const w of pending) {
    const p = league.players[w.playerId];
    if (!p || p.teamId !== w.fromTeamId || !p.contract) {
      w.status = 'cleared';
      continue;
    }
    for (const t of league.teams) if (t.id !== w.fromTeamId && t.id !== league.userTeamId && !w.claims.includes(t.id) && aiWantsClaim(league, t.id, p)) w.claims.push(t.id);
    const winner = priority.find((tid) => w.claims.includes(tid) && claimFit(league, tid, p).ok);
    if (winner !== undefined) {
      p.teamId = winner;
      p.status = 'active';
      p.rightsTeamId = null;
      w.status = 'claimed';
      w.claimedBy = winner;
      rosterChangeFamiliarity(league.teams[winner], 1);
      if (!league.seasonStats[p.id]) league.seasonStats[p.id] = { reg: emptyStatLine(), po: emptyStatLine(), teamId: winner };
      league.seasonStats[p.id].teamId = winner;
      const desc = `${teamName(league, winner)} claim ${name(p)} off waivers from ${teamName(league, w.fromTeamId)}`;
      addTransaction(league, { kind: 'waiverClaim', teamIds: [winner, w.fromTeamId], playerIds: [p.id], description: desc });
      if (winner === league.userTeamId || w.fromTeamId === league.userTeamId || p.reputation >= 40) addNews(league, { category: 'signing', headline: desc, teamIds: [winner, w.fromTeamId], playerIds: [p.id], importance: 2 });
      continue;
    }
    w.status = 'cleared';
    w.claimedBy = null;
    if (w.reason === 'release') {
      // Unconditional waivers cleared: mutual termination of the remaining contract.
      const tid = p.teamId;
      p.contract = null;
      p.teamId = null;
      p.status = 'fa';
      p.rightsTeamId = null;
      addTransaction(league, { kind: 'termination', teamIds: [tid], playerIds: [p.id], description: `${name(p)} clears waivers; ${teamName(league, tid)} terminate his contract` });
    } else {
      p.status = 'prospect';
      addTransaction(league, { kind: 'waiverClear', teamIds: [w.fromTeamId], playerIds: [p.id], description: `${name(p)} clears waivers and is assigned to the minors by ${teamName(league, w.fromTeamId)}` });
    }
  }
  // Keep only this season's waiver log.
  league.waivers = league.waivers.filter((w) => w.season >= league.season);
}
