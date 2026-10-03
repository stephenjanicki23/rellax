/**
 * Trade legality (two- and multi-team): ownership, deadline, waivers,
 * NMC / NTC / M-NTC consent, salary retention limits (CBA 50.5(e)(iii)),
 * per-team cap compliance after the trade and the 50-contract limit.
 * Execution applies retention to the contract and logs one transaction.
 */
import type { League, Player } from '../types';
import { seedFrom } from '../core/rng';
import { addNews, addTransaction, playersOf, teamName } from '../league/helpers';
import { activeClause, fullCapHit, holderCapHit, refreshContract, retainedShare, yearsOf } from './contract';
import { capSeason, teamCapSheet } from './capManager';
import { rulesFor } from './rules';
import { fmtCap } from './rulesEngine';
import { onWaivers } from './waivers';
import { emptyStatLine } from '../core/statline';

export type TradeAsset = { kind: 'player'; id: number } | { kind: 'pick'; id: number };

export interface TradeMove {
  asset: TradeAsset;
  from: number;
  to: number;
  /** Share of the cap hit the sending team keeps (0–0.5). */
  retainPct?: number;
}

export interface TeamCapImpact {
  teamId: number;
  before: number;
  after: number;
  limit: number;
  spaceBefore: number;
  spaceAfter: number;
  incoming: number;
  outgoing: number;
  retainedAdded: number;
  ok: boolean;
}

export interface TradeCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
  cap: TeamCapImpact[];
  /** Consent decisions for clause players. */
  consents: { playerId: number; clause: string; required: boolean; granted: boolean; reason: string }[];
}

const name = (p: Player) => `${p.first} ${p.last}`;
const tname = (league: League, id: number) => teamName(league, id);

function ownsAsset(league: League, teamId: number, a: TradeAsset): boolean {
  if (a.kind === 'player') {
    const p = league.players[a.id];
    return !!p && p.teamId === teamId && (p.status === 'active' || p.status === 'prospect');
  }
  const pick = league.draftPicks.find((x) => x.id === a.id);
  return !!pick && pick.ownerId === teamId && pick.playerId === undefined;
}

export function describeTradeAsset(league: League, a: TradeAsset): string {
  if (a.kind === 'player') {
    const p = league.players[a.id];
    return p ? `${name(p)} (${p.pos})` : 'Unknown player';
  }
  const pick = league.draftPicks.find((x) => x.id === a.id);
  if (!pick) return 'Unknown pick';
  const own = pick.originalTeamId === pick.ownerId ? '' : ` (${league.teams[pick.originalTeamId].abbr})`;
  return `${pick.season} Round ${pick.round} pick${own}`;
}

// ───────────────────────────── clauses ─────────────────────────────

/**
 * Teams a modified-NTC player may block (or, for an approve list, every team
 * not on it). Deterministic per player and clause: players tend to list
 * rebuilding and less attractive markets.
 */
export function mntcBlockedTeams(league: League, p: Player): number[] {
  const c = p.contract;
  const cl = c ? activeClause(c, capSeason(league)) : null;
  if (!cl || cl.kind !== 'M-NTC') return [];
  const n = Math.max(1, Math.min(league.teams.length - 1, cl.teams ?? 10));
  const ranked = league.teams
    .filter((t) => t.id !== p.teamId)
    .map((t) => ({ id: t.id, score: (1 - t.appeal) * 1.4 + (t.strategy === 'rebuild' ? 0.35 : 0) + (seedFrom(league.seed, 'mntc', p.id, cl.from, t.id) % 1000) / 1000 }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.id);
  return cl.mode === 'approve' ? ranked.slice(0, ranked.length - n) : ranked.slice(0, n);
}

/** Does this player need to approve a trade to `dest`, and would he? Deterministic per player/team/season. */
export function tradeConsent(league: League, p: Player, dest: number): { required: boolean; granted: boolean; clause: string; reason: string } {
  const c = p.contract;
  const cl = c ? activeClause(c, capSeason(league)) : null;
  if (!cl) return { required: false, granted: true, clause: '', reason: '' };
  const destName = tname(league, dest);
  if (cl.kind === 'M-NTC' && !mntcBlockedTeams(league, p).includes(dest))
    return { required: false, granted: true, clause: cl.kind, reason: `${destName} is not on ${name(p)}'s modified no-trade list.` };
  const destTeam = league.teams[dest];
  const age = capSeason(league) - p.birthYear;
  const own = p.teamId !== null ? league.teams[p.teamId] : null;
  let pWaive = destTeam.strategy === 'contend' ? 0.45 : destTeam.strategy === 'rebuild' ? 0.06 : 0.16;
  if (p.morale < 35) pWaive += 0.4;
  if (own?.strategy === 'rebuild' && age >= 30) pWaive += 0.2;
  pWaive += (destTeam.appeal - 0.55) * 0.5;
  if (cl.kind === 'NMC') pWaive *= 0.85;
  const h = (seedFrom(league.seed, 'consent', p.id, dest, league.season) % 10000) / 10000;
  const granted = h < Math.max(0.02, Math.min(0.95, pWaive));
  const what = cl.kind === 'NMC' ? 'a no-movement clause' : cl.kind === 'NTC' ? 'a full no-trade clause' : `a modified no-trade clause (${destName} is on his list)`;
  return {
    required: true,
    granted,
    clause: cl.kind,
    reason: granted ? `${name(p)} has ${what} and has agreed to waive it for ${destName}.` : `Trade invalid: ${name(p)} has ${what} and has not approved a trade to ${destName}.`,
  };
}

// ───────────────────────────── retention ─────────────────────────────

/** Contracts on which a team currently retains salary. */
export function retainedContracts(league: League, teamId: number): Player[] {
  const season = capSeason(league);
  return Object.values(league.players).filter((p) => p.contract && (p.contract.retained ?? []).some((r) => r.teamId === teamId) && yearsOf(p.contract).some((y) => y.season >= season));
}

export function retentionErrors(league: League, p: Player, fromTeam: number, pct: number, retainingInTrade = 0): string[] {
  const r = rulesFor(capSeason(league)).retention;
  const errors: string[] = [];
  const c = p.contract;
  if (!c) return [`Retention invalid: ${name(p)} has no contract.`];
  if (pct <= 0) return errors;
  if (pct > r.maxPct + 1e-9) errors.push(`Retention invalid: ${tname(league, fromTeam)} cannot retain more than ${Math.round(r.maxPct * 100)}% of ${name(p)}'s cap hit (requested ${Math.round(pct * 100)}%).`);
  if ((c.retained ?? []).length >= r.maxTimesPerContract) errors.push(`Retention invalid: ${name(p)}'s contract has already been retained on ${c.retained!.length} times (limit ${r.maxTimesPerContract}).`);
  // SIMPLIFICATION: a double-retained contract keeps at least a quarter of its cap hit with the acquiring team.
  if (retainedShare(c) + pct > 0.75 + 1e-9) errors.push(`Retention invalid: combined retention on ${name(p)}'s contract would be ${Math.round((retainedShare(c) + pct) * 100)}% (at most 75% across two retentions).`);
  const held = retainedContracts(league, fromTeam).length + retainingInTrade;
  if (held >= r.maxContractsPerTeam) errors.push(`Retention invalid: ${tname(league, fromTeam)} already retains salary on ${held} contracts (limit ${r.maxContractsPerTeam}).`);
  return errors;
}

// ───────────────────────────── validation ─────────────────────────────

function chargeAt(league: League, p: Player, share: number): number {
  const c = p.contract;
  if (!c) return 0;
  const hit = fullCapHit(c) * share;
  if (p.status !== 'prospect' || c.thirtyFivePlus) return hit;
  const r = rulesFor(capSeason(league));
  return Math.max(0, hit - (r.minimumSalary + r.buriedAllowance));
}

export function validateMoves(league: League, moves: TradeMove[]): TradeCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const consents: TradeCheck['consents'] = [];
  const teams = [...new Set(moves.flatMap((m) => [m.from, m.to]))];
  if (!moves.length) errors.push('The trade is empty.');
  if (teams.length > 3) errors.push('Trades are limited to three teams.');
  if (league.phase === 'regular' && league.day > league.tradeDeadlineDay) errors.push('Trade invalid: the trade deadline has passed.');
  if (league.phase === 'playoffs') errors.push('Trade invalid: trades are frozen during the playoffs.');
  const seen = new Set<string>();
  const retainingCount: Record<number, number> = {};
  for (const m of moves) {
    const k = `${m.asset.kind}-${m.asset.id}`;
    if (m.from === m.to) errors.push('A team cannot trade with itself.');
    if (seen.has(k)) errors.push(`${describeTradeAsset(league, m.asset)} appears more than once.`);
    seen.add(k);
    if (!ownsAsset(league, m.from, m.asset)) {
      errors.push(`${describeTradeAsset(league, m.asset)} is not available from ${tname(league, m.from)}.`);
      continue;
    }
    if (m.asset.kind !== 'player') continue;
    const p = league.players[m.asset.id];
    if (onWaivers(league, p.id)) errors.push(`Trade invalid: ${name(p)} is on waivers and cannot be traded.`);
    if (p.ltir) warnings.push(`${name(p)} is on LTIR; the acquiring team takes on his full cap hit when he returns.`);
    const consent = tradeConsent(league, p, m.to);
    if (consent.required) consents.push({ playerId: p.id, clause: consent.clause, required: true, granted: consent.granted, reason: consent.reason });
    if (consent.required && !consent.granted) errors.push(consent.reason);
    if (m.retainPct) {
      if (p.contract && (p.contract.retained ?? []).some((r) => r.teamId === m.to)) errors.push(`Trade invalid: ${tname(league, m.to)} already retains salary on ${name(p)} and cannot reacquire him (CBA 50.5(e)(iii)).`);
      errors.push(...retentionErrors(league, p, m.from, m.retainPct, retainingCount[m.from] ?? 0));
      retainingCount[m.from] = (retainingCount[m.from] ?? 0) + 1;
    }
  }
  // Cap and contract limits per team.
  const season = capSeason(league);
  const r = rulesFor(season);
  const cap: TeamCapImpact[] = [];
  for (const tid of teams) {
    const sheet = teamCapSheet(league, tid, season);
    let incoming = 0, outgoing = 0, retainedAdded = 0, contractsIn = 0, contractsOut = 0, activeIn = 0, activeOut = 0;
    for (const m of moves) {
      if (m.asset.kind !== 'player') continue;
      const p = league.players[m.asset.id];
      if (!p?.contract) continue;
      const share = 1 - retainedShare(p.contract);
      if (m.from === tid) {
        outgoing += chargeAt(league, p, share);
        contractsOut++;
        if (p.status === 'active') activeOut++;
        if (m.retainPct) retainedAdded += fullCapHit(p.contract) * m.retainPct;
      }
      if (m.to === tid) {
        incoming += chargeAt(league, p, share - (m.retainPct ?? 0));
        contractsIn++;
        if (p.status === 'active') activeIn++;
      }
    }
    const after = sheet.total - outgoing + incoming + retainedAdded;
    const limit = sheet.effectiveLimit;
    const ok = after <= limit + 1e-6 || after <= sheet.total + 1e-6;
    if (!ok) errors.push(`Trade invalid: ${tname(league, tid)} would be ${fmtCap(after - limit)} over the ${fmtCap(limit)} ${limit > r.upperLimit ? 'limit' : 'salary cap'} after this trade (${fmtCap(sheet.total)} → ${fmtCap(after)}).`);
    if (sheet.rows.length - contractsOut + contractsIn > r.contractLimit) errors.push(`Trade invalid: ${tname(league, tid)} would have ${sheet.rows.length - contractsOut + contractsIn} contracts (limit ${r.contractLimit}).`);
    const activeAfter = playersOf(league, tid).filter((p) => !p.ltir).length - activeOut + activeIn;
    if (activeAfter > r.rosterMax + 3) errors.push(`Trade invalid: ${tname(league, tid)} would have ${activeAfter} players on the active roster.`);
    else if (activeAfter > r.rosterMax && (league.phase === 'regular' || league.phase === 'preseason')) warnings.push(`${tname(league, tid)} will have ${activeAfter} active players and must send someone down (limit ${r.rosterMax}).`);
    cap.push({ teamId: tid, before: sheet.total, after, limit, spaceBefore: limit - sheet.total, spaceAfter: limit - after, incoming, outgoing, retainedAdded, ok });
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings, cap, consents };
}

// ───────────────────────────── execution ─────────────────────────────

export function executeMoves(league: League, moves: TradeMove[]): void {
  const season = capSeason(league);
  const teams = [...new Set(moves.flatMap((m) => [m.from, m.to]))];
  for (const m of moves) {
    if (m.asset.kind === 'player') {
      const p = league.players[m.asset.id];
      if (p.contract && m.retainPct) {
        (p.contract.retained ??= []).push({ teamId: m.from, pct: m.retainPct, season });
        refreshContract(p.contract, season);
      }
      p.teamId = m.to;
      if (p.rightsTeamId !== null) p.rightsTeamId = m.to;
      p.morale = Math.max(20, p.morale - 8);
      if (!league.seasonStats[p.id]) league.seasonStats[p.id] = { reg: emptyStatLine(), po: emptyStatLine(), teamId: m.to };
      else league.seasonStats[p.id].teamId = m.to;
      if (p.ltir) {
        // LTIR relief stays with the club that placed him; the new club re-places him.
        league.ltir = league.ltir.filter((l) => l.playerId !== p.id);
        p.ltir = false;
      }
    } else {
      const pick = league.draftPicks.find((x) => x.id === m.asset.id);
      if (pick) pick.ownerId = m.to;
    }
  }
  for (const tid of teams) {
    league.teams[tid].autoLines = tid === league.userTeamId ? league.teams[tid].autoLines : true;
    league.aiMemory[tid] = { ...league.aiMemory[tid], lastTradeDay: league.day };
  }
  const part = (tid: number) => {
    const got = moves.filter((m) => m.to === tid).map((m) => describeTradeAsset(league, m.asset) + (m.retainPct ? ` (${Math.round(m.retainPct * 100)}% retained by ${league.teams[m.from].abbr})` : ''));
    return `${tname(league, tid)} acquire ${got.join(', ') || 'future considerations'}`;
  };
  const desc = teams.length === 2 ? `${part(teams[0])} from ${tname(league, teams[1])} for ${moves.filter((m) => m.to === teams[1]).map((m) => describeTradeAsset(league, m.asset)).join(', ') || 'future considerations'}` : `Three-team trade: ${teams.map(part).join('; ')}`;
  const playerIds = moves.filter((m) => m.asset.kind === 'player').map((m) => m.asset.id);
  const pickIds = moves.filter((m) => m.asset.kind === 'pick').map((m) => m.asset.id);
  addTransaction(league, { kind: 'trade', teamIds: teams, playerIds, pickIds, description: desc });
  const stars = playerIds.map((id) => league.players[id]).filter((p) => p.reputation >= 55);
  addNews(league, {
    category: 'trade',
    headline: stars.length ? `Blockbuster: ${name(stars[0])} traded to ${tname(league, stars[0].teamId!)}` : teams.length > 2 ? 'Three-team trade completed' : `Trade completed between ${league.teams[teams[0]].city} and ${league.teams[teams[1]].city}`,
    body: desc,
    teamIds: teams,
    playerIds,
    importance: stars.length ? 4 : 2,
  });
}

/** Cap hit a team takes on for a player after a given retention. */
export function incomingCapHit(p: Player, retainPct = 0): number {
  return p.contract ? holderCapHit(p.contract) - fullCapHit(p.contract) * retainPct : 0;
}
