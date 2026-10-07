/**
 * Draft day: verdicts on every selection against the consensus board,
 * one-pick-at-a-time simulation, trade-down offers while the user is on the
 * clock, and the grades handed out when the draft closes.
 *
 * SIMPLIFICATION: picks are graded the way draft analysts do it, against the
 * consensus board (Central Scouting order) when the draft opened, not against
 * how the players turn out.
 */
import type { DraftPick, League, Player } from '../types';
import { aiProspectValue, aiSelect, currentPick, makeDraftPick } from './draft';
import { executeTrade, projectedPickNumber, validateTrade, type TradeProposal } from './trade';
import { addNews, teamName } from '../league/helpers';
import { fullName } from '../player/ability';

/** Value of a draft slot (smooth curve: the first pick is worth about three late firsts). */
export function slotValue(n: number): number {
  return 1000 * Math.exp(-(n - 1) / 24) + 20;
}

export function consensusRank(league: League, playerId: number): number | null {
  const dd = league.draftDay;
  if (!dd || dd.season !== league.season) return null;
  const i = dd.board.indexOf(playerId);
  return i >= 0 ? i + 1 : null;
}

export interface Verdict {
  tag: 'Steal' | 'Value' | 'On the board' | 'Reach' | 'Big reach' | 'Off the board';
  tone: 'good' | 'ok' | 'bad';
  text: string;
}

/** How a pick compares with where the consensus board had the player. */
export function pickVerdict(pickNumber: number, consensus: number | null): Verdict {
  if (consensus === null) return { tag: 'Off the board', tone: 'bad', text: 'Not on the consensus board: a scouting bet.' };
  const d = pickNumber - consensus;
  const where = `ranked ${consensus}${consensus === 1 ? 'st' : consensus === 2 ? 'nd' : consensus === 3 ? 'rd' : 'th'}, went ${pickNumber}${pickNumber % 10 === 1 && pickNumber !== 11 ? 'st' : pickNumber % 10 === 2 && pickNumber !== 12 ? 'nd' : pickNumber % 10 === 3 && pickNumber !== 13 ? 'rd' : 'th'}`;
  // Tolerance grows through the draft: ten spots matter more at 5 than at 150.
  const tol = Math.max(3, pickNumber * 0.25);
  if (d >= tol * 2) return { tag: 'Steal', tone: 'good', text: `A steal: ${where}.` };
  if (d >= tol) return { tag: 'Value', tone: 'good', text: `Good value: ${where}.` };
  if (d > -tol) return { tag: 'On the board', tone: 'ok', text: `Right where he was expected: ${where}.` };
  if (d > -tol * 2) return { tag: 'Reach', tone: 'bad', text: `A reach: ${where}.` };
  return { tag: 'Big reach', tone: 'bad', text: `A big reach: ${where}.` };
}

/** Make the next CPU selection (stops at the user's pick). Returns false when it's the user's turn or the draft is over. */
export function simNextPick(league: League): boolean {
  const pick = currentPick(league);
  if (!pick || (pick.ownerId === league.userTeamId && !league.settings.autoManageUser)) return false;
  const sel = aiSelect(league, pick.ownerId);
  if (!sel) return false;
  makeDraftPick(league, pick.id, sel.id);
  return true;
}

export interface DraftOffer {
  teamId: number;
  /** Picks they give for the user's current pick. */
  picks: number[];
  /** The prospect they're believed to be after. */
  targetId: number;
  value: number;
  ask: number;
}

const valueOfPick = (league: League, p: DraftPick) => slotValue(projectedPickNumber(league, p)) * (p.season > league.season ? 0.85 ** (p.season - league.season) : 1);

/**
 * Trade-down offers while the user is on the clock: clubs further down the
 * order who want a prospect expected to go around this pick offer their next
 * pick plus enough extra to make it worth moving back.
 */
export function draftDayOffers(league: League, max = 2): DraftOffer[] {
  const cur = currentPick(league);
  const me = league.userTeamId;
  if (!cur || cur.ownerId !== me || !cur.pickNumber) return [];
  const at = cur.pickNumber;
  const ask = slotValue(at) * 1.08;
  const avail = Object.values(league.players).filter((p) => p.status === 'draft');
  const offers: DraftOffer[] = [];
  for (const t of league.teams) {
    if (t.id === me) continue;
    const later = league.draftPicks
      .filter((p) => p.ownerId === t.id && p.playerId === undefined && ((p.season === league.season && (p.pickNumber ?? 0) > at) || p.season === league.season + 1))
      .sort((a, b) => valueOfPick(league, b) - valueOfPick(league, a));
    const first = later.find((p) => p.season === league.season);
    if (!first?.pickNumber || first.pickNumber - at < 4) continue;
    // Who they want, and whether he'd still be there at their own pick.
    let target: Player | undefined;
    let best = -Infinity;
    for (const p of avail) {
      const v = aiProspectValue(league, t.id, p);
      if (v > best) {
        best = v;
        target = p;
      }
    }
    const rank = target ? consensusRank(league, target.id) : null;
    if (!target || rank === null || rank > at + 3 || rank > first.pickNumber - 4) continue;
    const give = [first];
    let value = valueOfPick(league, first);
    for (const p of later) {
      if (value >= ask || give.length >= 3) break;
      if (p === first) continue;
      give.push(p);
      value += valueOfPick(league, p);
    }
    if (value < ask) continue;
    offers.push({ teamId: t.id, picks: give.map((p) => p.id), targetId: target.id, value, ask });
  }
  return offers.sort((a, b) => a.value - b.value).slice(0, max);
}

/** Accept a trade-down offer: the user's current pick for their picks. */
export function acceptDraftOffer(league: League, o: DraftOffer): { ok: boolean; message: string } {
  const cur = currentPick(league);
  if (!cur || cur.ownerId !== league.userTeamId) return { ok: false, message: "You're not on the clock." };
  const proposal: TradeProposal = { from: o.teamId, to: league.userTeamId, give: o.picks.map((id) => ({ kind: 'pick', id })), get: [{ kind: 'pick', id: cur.id }] };
  const errs = validateTrade(league, proposal);
  if (errs.length) return { ok: false, message: errs[0] };
  executeTrade(league, proposal);
  const dd = league.draftDay;
  const line = `${teamName(league, o.teamId)} move up to No. ${cur.pickNumber} in a trade with the ${teamName(league, league.userTeamId)}`;
  if (dd) dd.trades.push(line);
  addNews(league, { category: 'draft', headline: line, teamIds: [o.teamId, league.userTeamId], playerIds: [], importance: 3 });
  return { ok: true, message: `Done: you move back and pick up ${o.picks.length} pick${o.picks.length > 1 ? 's' : ''}.` };
}

/** Grade every team's draft against the consensus board (called when the draft closes). */
export function gradeDraft(league: League): NonNullable<NonNullable<League['draftDay']>['grades']> {
  const dd = league.draftDay;
  if (!dd || dd.season !== league.season) return [];
  const unranked = dd.board.length + 20;
  const byTeam = new Map<number, { surplus: number; base: number; picks: number }>();
  for (const s of dd.selections) {
    const e = byTeam.get(s.teamId) ?? { surplus: 0, base: 0, picks: 0 };
    e.surplus += slotValue(s.consensus ?? unranked) - slotValue(s.pickNumber);
    e.base += slotValue(s.pickNumber);
    e.picks++;
    byTeam.set(s.teamId, e);
  }
  const letter = (r: number) => (r >= 0.3 ? 'A' : r >= 0.12 ? 'A-' : r >= 0.03 ? 'B+' : r >= -0.05 ? 'B' : r >= -0.15 ? 'B-' : r >= -0.3 ? 'C' : 'D');
  const grades = [...byTeam].map(([teamId, e]) => ({ teamId, score: e.surplus / Math.max(1, e.base), grade: letter(e.surplus / Math.max(1, e.base)), picks: e.picks })).sort((a, b) => b.score - a.score);
  dd.grades = grades;
  return grades;
}

/** The user's selections this draft, with verdicts (for the recap). */
export function userSelections(league: League) {
  const dd = league.draftDay;
  if (!dd) return [];
  return dd.selections.filter((s) => s.teamId === league.userTeamId).map((s) => ({ ...s, player: league.players[s.playerId], verdict: pickVerdict(s.pickNumber, s.consensus) }));
}

export const describeSelection = (league: League, playerId: number) => {
  const p = league.players[playerId];
  return p ? `${fullName(p)} (${p.pos})` : 'a prospect';
};
