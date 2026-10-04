import { STATIC, elcMaxFor, rulesFor } from '../cba/rules';
import { buildContract } from '../cba/contract';
import { registerContract } from '../cba/contractService';
import { emptyStatLine } from '../core/statline';
import type { CsCategory, DraftPick, League, Player } from '../types';
import { addNews, addTransaction, playersOf, teamName, withRng, points } from '../league/helpers';
import { playoffResultFor } from '../league/playoffs';
import { compareRecords } from '../league/standings';
import { aiPerceivedPA, centralRank, estimate } from './scouting';

import { fullName } from '../player/ability';

const LOTTERY_ODDS = [18.5, 13.5, 11.5, 9.5, 8.5, 7.5, 6.5, 6, 5, 3.5, 3, 2.5, 2, 1.5, 0.5, 0.5];

/** Order of teams for every round: lottery for non-playoff teams, then playoff teams by finish. */
export function draftTeamOrder(league: League): number[] {
  const byRecord = [...league.teams].sort((a, b) => compareRecords(league.standings[b.id], league.standings[a.id]));
  const playoffTeams = new Set(league.playoffs?.seeds.map((s) => s.teamId) ?? []);
  const nonPlayoff = byRecord.filter((t) => !playoffTeams.has(t.id)).map((t) => t.id);
  const roundReached = (id: number) => {
    const res = playoffResultFor(league, id);
    if (res === 'Champion') return 10;
    const rounds = league.playoffs?.rounds ?? [];
    let r = -1;
    rounds.forEach((rs, i) => rs.forEach((s) => (s.high === id || s.low === id) && (r = i)));
    return r;
  };
  const playoff = byRecord
    .filter((t) => playoffTeams.has(t.id))
    .sort((a, b) => roundReached(a.id) - roundReached(b.id) || points(league.standings[a.id]) - points(league.standings[b.id]))
    .map((t) => t.id);
  // Lottery among non-playoff teams.
  const order = [...nonPlayoff];
  const draws = league.config.draft.lotteryDraws;
  const lotteryPool = order.slice(0, league.config.draft.lotteryTeams);
  const winners: number[] = [];
  withRng(league, (rng) => {
    for (let d = 0; d < draws && lotteryPool.length; d++) {
      const weights = lotteryPool.map((id) => LOTTERY_ODDS[order.indexOf(id)] ?? 0.5);
      const idx = rng.weightedIndex(weights);
      winners.push(lotteryPool[idx]);
      lotteryPool.splice(idx, 1);
    }
  });
  const rest = order.filter((id) => !winners.includes(id));
  const final = [...winners, ...rest, ...playoff];
  if (winners.length && winners[0] !== order[0]) {
    const jump = order.indexOf(winners[0]) + 1;
    addNews(league, { category: 'draft', headline: `${teamName(league, winners[0])} win the draft lottery, jumping from No. ${jump} to No. 1`, teamIds: [winners[0]], playerIds: [], importance: 4 });
  }
  return final;
}

export function prepareDraft(league: League): void {
  const teamOrder = draftTeamOrder(league);
  const picks = league.draftPicks.filter((p) => p.season === league.season);
  const order: number[] = [];
  let n = 1;
  for (let r = 1; r <= league.config.draft.rounds; r++) {
    for (const tid of teamOrder) {
      const pick = picks.find((p) => p.round === r && p.originalTeamId === tid);
      if (!pick) continue;
      pick.pickNumber = n++;
      order.push(pick.id);
    }
  }
  league.draftOrder = order;
  for (const id of order) resolveProtection(league, league.draftPicks.find((p) => p.id === id)!);
  league.phase = 'draft';
}

/**
 * A protected pick that lands inside its protection stays with the original
 * team; the conveyance rolls to that team's same-round pick the next year
 * (unprotected). SIMPLIFICATION: real protections vary deal by deal.
 */
function resolveProtection(league: League, pick: DraftPick): void {
  if (!pick.protectedTop || !pick.pickNumber || pick.ownerId === pick.originalTeamId) return;
  const inRound = ((pick.pickNumber - 1) % league.teams.length) + 1;
  if (inRound > pick.protectedTop) return;
  const holder = pick.ownerId;
  const top = pick.protectedTop;
  pick.ownerId = pick.originalTeamId;
  const next = league.draftPicks.find((d) => d.season === pick.season + 1 && d.round === pick.round && d.originalTeamId === pick.originalTeamId && d.ownerId === pick.originalTeamId);
  if (next) next.ownerId = holder;
  delete pick.protectedTop;
  addNews(league, {
    category: 'draft',
    headline: `${teamName(league, pick.originalTeamId)} keep their top-${top} protected pick (No. ${pick.pickNumber}); ${teamName(league, holder)} ${next ? `get their ${pick.season + 2} pick instead` : 'come away empty-handed'}`,
    teamIds: [pick.originalTeamId, holder],
    playerIds: [],
    importance: 3,
  });
}

/** Public consensus ranking of draft-eligible prospects. */
export function draftRankings(league: League): Player[] {
  const pool = Object.values(league.players).filter((p) => p.status === 'draft');
  // Once Central Scouting has published, the consensus follows its lists (merged by typical draft slot).
  if (league.scouting.central?.season === league.season) {
    const per: Record<CsCategory, number> = { 'NA-S': 1.55, 'INT-S': 2.4, 'NA-G': 7, 'INT-G': 9 };
    const slot = (p: Player) => {
      const r = centralRank(league, p);
      return r ? r.rank * per[r.category] : 999;
    };
    return pool.sort((a, b) => slot(a) - slot(b));
  }
  return pool.sort((a, b) => b.reputation + b.ca * 0.15 - (a.reputation + a.ca * 0.15));
}

export function currentPick(league: League): DraftPick | undefined {
  for (const id of league.draftOrder) {
    const p = league.draftPicks.find((x) => x.id === id);
    if (p && p.playerId === undefined) return p;
  }
  return undefined;
}

/** How a CPU team values a prospect: perceived potential, readiness and positional need. */
export function aiProspectValue(league: League, teamId: number, p: Player): number {
  const pa = aiPerceivedPA(league, teamId, p);
  const team = league.teams[teamId];
  const roster = playersOf(league, teamId, ['active', 'prospect']);
  const needD = roster.filter((x) => x.pos === 'D').length < 10;
  const needG = roster.filter((x) => x.pos === 'G').length < 4;
  let v = pa + p.ca * 0.18;
  if (team.gm.philosophy === 'winNow') v += p.ca * 0.08;
  if (team.gm.philosophy === 'youth') v += (pa - p.ca) * 0.05;
  if (p.pos === 'D' && needD) v += 2;
  if (p.pos === 'G') v += needG ? 3 : -1;
  return v;
}

export function makeDraftPick(league: League, pickId: number, playerId: number): void {
  const pick = league.draftPicks.find((p) => p.id === pickId);
  const p = league.players[playerId];
  if (!pick || !p || p.status !== 'draft' || pick.playerId !== undefined) throw new Error('Invalid draft selection');
  pick.playerId = playerId;
  p.status = 'prospect';
  p.teamId = pick.ownerId;
  p.rightsTeamId = pick.ownerId;
  p.draft = { season: league.season, round: pick.round, pick: pick.pickNumber ?? 0, teamId: pick.ownerId };
  // Drafted, not signed: the club holds his rights until his sign-by date
  // (CBA 8.6 — two years for junior players, four for college/European
  // players; SIMPLIFICATION: which path an 18-year-old takes is random).
  const age = league.season + 1 - p.birthYear;
  const years = age >= 20 || withRng(league, (rng) => rng.chance(0.4)) ? 4 : 2;
  p.signBySeason = league.season + years;
  league.seasonStats[p.id] = { reg: emptyStatLine(), po: emptyStatLine(), teamId: pick.ownerId };
  addTransaction(league, { kind: 'draft', teamIds: [pick.ownerId], playerIds: [p.id], pickIds: [pick.id], description: `${teamName(league, pick.ownerId)} select ${fullName(p)} (${p.pos}) — Round ${pick.round}, Pick ${pick.pickNumber}` });
  if (pick.pickNumber === 1) {
    addNews(league, { category: 'draft', headline: `${teamName(league, pick.ownerId)} select ${fullName(p)} first overall`, teamIds: [pick.ownerId], playerIds: [p.id], importance: 5 });
  } else if (pick.ownerId === league.userTeamId && pick.round <= 2) {
    addNews(league, { category: 'draft', headline: `${teamName(league, pick.ownerId)} draft ${fullName(p)} at No. ${pick.pickNumber}`, teamIds: [pick.ownerId], playerIds: [p.id], importance: 2 });
  }
}

export function aiSelect(league: League, teamId: number): Player | undefined {
  const avail = Object.values(league.players).filter((p) => p.status === 'draft');
  if (!avail.length) return undefined;
  // Consider the consensus top of the board plus team-specific evaluation.
  const ranked = avail.sort((a, b) => b.reputation - a.reputation).slice(0, 60);
  let best: Player | undefined;
  let bestV = -Infinity;
  for (const p of ranked) {
    const v = aiProspectValue(league, teamId, p);
    if (v > bestV) {
      bestV = v;
      best = p;
    }
  }
  return best;
}

/** Make CPU picks until it is the user's turn (or the draft ends). Returns true if the draft is complete. */
export function runDraftUntilUser(league: League, includeUser = false): boolean {
  let pick = currentPick(league);
  while (pick) {
    if (pick.ownerId === league.userTeamId && !includeUser && !league.settings.autoManageUser) return false;
    const sel = aiSelect(league, pick.ownerId);
    if (!sel) break;
    makeDraftPick(league, pick.id, sel.id);
    pick = currentPick(league);
  }
  return true;
}

/** Suggestion for the user (based on what the user's scouts believe). */
export function suggestPick(league: League): Player | undefined {
  const avail = Object.values(league.players).filter((p) => p.status === 'draft');
  return avail.sort((a, b) => {
    const ea = estimate(league, a);
    const eb = estimate(league, b);
    return eb.pa + eb.ca * 0.15 - (ea.pa + ea.ca * 0.15);
  })[0];
}

/** After the draft: undrafted prospects either return to junior (18-year-olds) or leave the pro pipeline. */
export function finishDraft(league: League): void {
  for (const p of Object.values(league.players)) {
    if (p.status !== 'draft') continue;
    const age = league.season - p.birthYear;
    if (age >= 19 || p.pa < 115) {
      delete league.players[p.id];
      delete league.scouting.knowledge[p.id];
    }
  }
  // Draft picks for this season are now spent.
  league.draftPicks = league.draftPicks.filter((p) => p.season > league.season);
  league.draftOrder = [];
}

/**
 * Entry-level contract for a drafted player (CBA Art. 9): term by age at
 * signing, compensation up to the draft-year maximum (scaled by draft slot),
 * signing bonus up to 10%, Schedule A bonuses for top picks, two-way.
 */
export function signDraftedElc(league: League, p: Player, teamId: number, pickNumber: number, start = league.season + 1): void {
  const age = start - p.birthYear;
  const term = STATIC().elcTermByAge[String(Math.min(24, Math.max(18, age)))] ?? 3;
  const max = elcMaxFor(league.season);
  const min = rulesFor(start).minimumSalary;
  const slot = Math.max(0, 1 - pickNumber / 40);
  const comp = Math.round(min + (max - min) * slot);
  const sb = pickNumber <= 15 ? Math.round(comp * 0.1) : 0;
  const perf = pickNumber <= 5 ? STATIC().elcScheduleABonusMax : pickNumber <= 32 ? 250 : 0;
  const c = buildContract({ startSeason: start, salaries: new Array(term).fill(comp - sb), signingBonuses: new Array(term).fill(sb), perfBonuses: new Array(term).fill(perf), minorSalaries: new Array(term).fill(80), type: 'ELC', twoWay: true, signedSeason: league.season, origin: 'elc', ageAtStart: age }, start);
  delete p.signBySeason;
  registerContract(league, p, teamId, c, { origin: 'elc', skipValidation: true, toMinors: true, announce: false });
  p.status = 'prospect';
}
