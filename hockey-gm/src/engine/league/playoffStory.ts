/**
 * Playoff presentation: everything here is read from games that were
 * actually played (box scores, standings, this save's history). Nothing is
 * invented for the screen.
 */
import type { League, PlayoffSeries, ScheduledGame } from '../types';
import { playoffRoundName, winsNeeded } from './playoffs';
import { points as recPoints } from './helpers';

export interface SeriesGame {
  n: number;
  game: ScheduledGame;
  /** Final score from the higher seed's side. */
  hiGoals: number;
  loGoals: number;
  winner: number;
  ot: boolean;
  /** Overtime periods beyond regulation (1 = first OT). */
  otPeriods: number;
  gwg?: number;
  shutout: boolean;
  /** Series score after this game, higher seed first. */
  after: [number, number];
}

/** The played games of a series, in order. */
export function seriesGames(league: League, s: PlayoffSeries): SeriesGame[] {
  const games = league.schedule.filter((g) => g.playoff?.series === s.id && g.played && g.result).sort((a, b) => a.playoff!.game - b.playoff!.game);
  const after: [number, number] = [0, 0];
  return games.map((g) => {
    const r = g.result!;
    const hiHome = g.home === s.high;
    const hiGoals = hiHome ? r.hg : r.ag;
    const loGoals = hiHome ? r.ag : r.hg;
    const winner = hiGoals > loGoals ? s.high : s.low;
    if (winner === s.high) after[0]++;
    else after[1]++;
    // Game-winning goal: the winner's goal that put them one ahead of the loser's final total.
    const winSide: 0 | 1 = winner === g.home ? 0 : 1;
    const loserFinal = winSide === 0 ? r.ag : r.hg;
    const gwg = r.goals.filter((x) => x.team === winSide)[loserFinal]?.s;
    const lastP = Math.max(3, ...r.goals.map((x) => x.p));
    return { n: g.playoff!.game, game: g, hiGoals, loGoals, winner, ot: r.ot, otPeriods: r.ot ? lastP - 3 : 0, gwg, shutout: hiGoals === 0 || loGoals === 0, after: [after[0], after[1]] };
  });
}

const abbr = (league: League, id: number) => league.teams[id].abbr;

/** One-line series status, e.g. "TOR lead 3-1", "Series tied 2-2", "BOS win 4-2". */
export function seriesStatus(league: League, s: PlayoffSeries): string {
  const [a, b] = s.wins;
  if (s.winner !== null) {
    const [w, l] = s.winner === s.high ? [a, b] : [b, a];
    return `${abbr(league, s.winner)} win ${w}-${l}`;
  }
  if (a + b === 0) return 'Series begins';
  if (a === b) return `Series tied ${a}-${b}`;
  const lead = a > b ? s.high : s.low;
  return `${abbr(league, lead)} lead ${Math.max(a, b)}-${Math.min(a, b)}`;
}

export interface SeriesLeader {
  playerId: number;
  teamId: number;
  g: number;
  a: number;
  pts: number;
}

/** Scoring leaders in a series, from the box scores. */
export function seriesLeaders(league: League, s: PlayoffSeries, games = seriesGames(league, s)): SeriesLeader[] {
  const m = new Map<number, SeriesLeader>();
  const add = (id: number, teamId: number, g: number, a: number) => {
    const e = m.get(id) ?? { playerId: id, teamId, g: 0, a: 0, pts: 0 };
    e.g += g;
    e.a += a;
    e.pts += g + a;
    m.set(id, e);
  };
  for (const sg of games) {
    const g = sg.game;
    for (const x of g.result!.goals) {
      const teamId = x.team === 0 ? g.home : g.away;
      add(x.s, teamId, 1, 0);
      for (const a of x.a) add(a, teamId, 0, 1);
    }
  }
  return [...m.values()].sort((x, y) => y.pts - x.pts || y.g - x.g);
}

export interface SeriesGoalie {
  playerId: number;
  teamId: number;
  gp: number;
  sa: number;
  ga: number;
  so: number;
}

/** Starting goaltenders' numbers in the series (empty-net goals excluded). */
export function seriesGoalies(games: SeriesGame[]): SeriesGoalie[] {
  const m = new Map<number, SeriesGoalie>();
  for (const sg of games) {
    const g = sg.game;
    const r = g.result!;
    for (const side of [0, 1] as const) {
      const id = side === 0 ? r.hGoalie : r.aGoalie;
      if (id == null) continue;
      const teamId = side === 0 ? g.home : g.away;
      const e = m.get(id) ?? { playerId: id, teamId, gp: 0, sa: 0, ga: 0, so: 0 };
      const against = r.goals.filter((x) => x.team !== side && x.str !== 'EN').length;
      e.gp++;
      e.sa += side === 0 ? r.as : r.hs;
      e.ga += against;
      if (against === 0) e.so++;
      m.set(id, e);
    }
  }
  return [...m.values()].sort((a, b) => b.gp - a.gp);
}

/** Regular-season meetings between two clubs this season (wins for a, wins for b, games). */
export function headToHead(league: League, a: number, b: number): { a: number; b: number; gp: number; ot: number } {
  let wa = 0;
  let wb = 0;
  let ot = 0;
  for (const g of league.schedule) {
    if (g.playoff || !g.played || !g.result) continue;
    if (!((g.home === a && g.away === b) || (g.home === b && g.away === a))) continue;
    const homeWon = g.result.hg > g.result.ag;
    const w = homeWon ? g.home : g.away;
    if (w === a) wa++;
    else wb++;
    if (g.result.ot || g.result.so) ot++;
  }
  return { a: wa, b: wb, gp: wa + wb, ot };
}

/** Earlier playoff meetings between two clubs in this save. */
export function pastMeetings(league: League, a: number, b: number) {
  const season = league.playoffs?.season ?? league.season;
  return (league.seriesHistory ?? []).filter((x) => x.season < season && ((x.high === a && x.low === b) || (x.high === b && x.low === a))).sort((x, y) => y.season - x.season);
}

/** Seasons since a club's last title in this save's history (null: none recorded). */
export function lastTitle(league: League, teamId: number, before = league.playoffs?.season ?? league.season): number | null {
  const h = [...league.history].reverse().find((x) => x.champion === teamId && x.season < before);
  return h ? h.season : null;
}

export interface StoryLine {
  tone: 'info' | 'hot' | 'good' | 'bad';
  text: string;
}

/** Last season's champion (the bracket's own season is already in history once the Final ends). */
export function defendingChampion(league: League): number | null {
  const season = league.playoffs?.season ?? league.season;
  return [...league.history].reverse().find((h) => h.season < season)?.champion ?? null;
}

/** A real upset: three or more seeds apart within a conference (Final seeding is by points, so it never counts). */
export const isUpset = (s: PlayoffSeries) => s.winner !== null && s.conferenceId !== null && s.winner === s.low && s.lowSeed - s.highSeed >= 3;

/** The storylines of a series, drawn from what has happened in it. */
export function seriesStorylines(league: League, s: PlayoffSeries, games = seriesGames(league, s)): StoryLine[] {
  const out: StoryLine[] = [];
  const need = winsNeeded(league, s.round);
  const [a, b] = s.wins;
  const hi = league.teams[s.high];
  const lo = league.teams[s.low];
  const name = (id: number) => league.teams[id].name;
  // Where the series stands.
  if (s.winner === null) {
    if (a === need - 1 && b === need - 1) out.push({ tone: 'hot', text: `Game ${2 * need - 1}: winner takes the series.` });
    else if (a === need - 1) out.push({ tone: 'hot', text: `The ${lo.name} face elimination.` });
    else if (b === need - 1) out.push({ tone: 'hot', text: `The ${hi.name} face elimination.` });
  } else {
    const loser = s.winner === s.high ? s.low : s.high;
    const [w, l] = s.winner === s.high ? [a, b] : [b, a];
    if (l === 0) out.push({ tone: 'good', text: `The ${name(s.winner)} swept the ${name(loser)}.` });
    if (isUpset(s)) out.push({ tone: 'good', text: `Upset: the ${s.lowSeed} seed knocked out the ${s.highSeed}.` });
    if (w + l === 2 * need - 1) out.push({ tone: 'info', text: `Decided in a Game ${2 * need - 1}.` });
  }
  // Comebacks: the biggest hole the eventual leader (or winner) climbed out of.
  let worst = 0;
  const leader = s.winner ?? (a > b ? s.high : b > a ? s.low : null);
  if (leader !== null)
    for (const g of games) {
      const deficit = leader === s.high ? g.after[1] - g.after[0] : g.after[0] - g.after[1];
      worst = Math.max(worst, deficit);
    }
  if (leader !== null && worst >= 2) {
    const down = games.find((g) => (leader === s.high ? g.after[1] - g.after[0] : g.after[0] - g.after[1]) === worst)!;
    const [x, y] = leader === s.high ? [down.after[0], down.after[1]] : [down.after[1], down.after[0]];
    out.push({ tone: 'hot', text: `The ${name(leader)} ${s.winner === leader ? 'came back from' : 'have climbed out of'} a ${x}-${y} series deficit.` });
  }
  const ots = games.filter((g) => g.ot);
  if (ots.length >= 2) out.push({ tone: 'info', text: `${ots.length} games have gone to overtime.` });
  const longest = Math.max(0, ...ots.map((g) => g.otPeriods));
  if (longest >= 2) {
    const g = ots.find((x) => x.otPeriods === longest)!;
    out.push({ tone: 'info', text: `Game ${g.n} needed ${longest === 2 ? 'double' : longest === 3 ? 'triple' : `${longest}x`} overtime.` });
  }
  // A hot hand.
  const lead = seriesLeaders(league, s, games)[0];
  if (lead && lead.pts >= Math.max(5, games.length * 1.2)) {
    const p = league.players[lead.playerId];
    if (p) out.push({ tone: 'good', text: `${p.first} ${p.last} has ${lead.pts} points (${lead.g} G) in ${games.length} games.` });
  }
  const g1 = seriesGoalies(games).find((x) => x.so >= 2);
  if (g1) {
    const p = league.players[g1.playerId];
    if (p) out.push({ tone: 'good', text: `${p.first} ${p.last} has ${g1.so} shutouts in the series.` });
  }
  // Background.
  const h2h = headToHead(league, s.high, s.low);
  if (h2h.gp && !games.length) out.push({ tone: 'info', text: `Season series: ${hi.abbr} ${h2h.a}-${h2h.b} ${lo.abbr}${h2h.ot ? ` (${h2h.ot} past regulation)` : ''}.` });
  const past = pastMeetings(league, s.high, s.low);
  if (past.length) {
    const last = past[0];
    out.push({ tone: 'info', text: `${past.length === 1 ? 'A rematch' : `Meeting #${past.length + 1}`}: the ${name(last.winner)} won in ${last.wins[0] + last.wins[1]} in the ${last.season} ${last.roundName}.` });
  }
  const riv = Math.max(hi.rivals[lo.id] ?? 0, lo.rivals[hi.id] ?? 0);
  if (riv >= 60) out.push({ tone: 'info', text: 'One of the league\'s fiercest rivalries.' });
  const defending = defendingChampion(league);
  if (defending !== null && (defending === s.high || defending === s.low)) out.push({ tone: 'info', text: `The ${name(defending)} are the defending champions.` });
  return out;
}

/** Bracket-level talking points. */
export function bracketStorylines(league: League): StoryLine[] {
  const b = league.playoffs;
  if (!b) return [];
  const out: StoryLine[] = [];
  const all = b.rounds.flat();
  const alive = new Set<number>();
  for (const s of b.rounds[b.currentRound] ?? []) {
    if (s.winner === null) {
      alive.add(s.high);
      alive.add(s.low);
    } else alive.add(s.winner);
  }
  if (b.champion !== null) {
    const t = league.teams[b.champion];
    const prev = lastTitle(league, b.champion);
    out.push({ tone: 'good', text: `The ${t.city} ${t.name} are ${league.config.championship} champions${prev ? ` for the first time since ${prev}` : ''}.` });
  }
  // Upsets so far.
  const upsets = all.filter((s) => isUpset(s));
  if (upsets.length) out.push({ tone: 'hot', text: `${upsets.length} upset${upsets.length > 1 ? 's' : ''} so far: ${upsets.map((s) => `${abbr(league, s.low)} over ${abbr(league, s.high)}`).join(', ')}.` });
  // Lowest seed still standing.
  if (b.champion === null && b.currentRound > 0) {
    const seedOf = (id: number) => b.seeds.find((x) => x.teamId === id);
    const low = [...alive].map((id) => ({ id, s: seedOf(id) })).filter((x) => x.s).sort((x, y) => y.s!.seed - x.s!.seed)[0];
    if (low && low.s!.seed >= 5) out.push({ tone: 'hot', text: `The ${league.teams[low.id].name} (${low.s!.label}) are the lowest seed still alive.` });
  }
  // Presidents' Trophy winner's fate.
  const best = [...league.teams].sort((x, y) => recPoints(league.standings[y.id]) - recPoints(league.standings[x.id]))[0];
  if (best && !alive.has(best.id) && b.champion !== best.id) {
    const out1 = all.find((s) => (s.high === best.id || s.low === best.id) && s.winner !== null && s.winner !== best.id);
    if (out1) out.push({ tone: 'bad', text: `The league's best regular-season team, the ${best.name}, went out in the ${playoffRoundName(league, out1.round)}.` });
  }
  const defending = defendingChampion(league);
  if (defending != null && b.champion === null) {
    const t = league.teams[defending];
    out.push(alive.has(defending) ? { tone: 'info', text: `The defending champion ${t.name} are still alive.` } : { tone: 'bad', text: `The defending champion ${t.name} have been eliminated.` });
  }
  const me = league.userTeamId;
  if (b.champion === null && alive.has(me)) out.push({ tone: 'good', text: `Your ${league.teams[me].name} are still alive in the ${playoffRoundName(league, b.currentRound)}.` });
  return out;
}

/** Archive the finished bracket's series (for rematch history). */
export function archiveSeries(league: League): void {
  const b = league.playoffs;
  if (!b) return;
  league.seriesHistory ??= [];
  for (const s of b.rounds.flat())
    if (s.winner !== null) league.seriesHistory.push({ season: b.season, round: s.round, roundName: playoffRoundName(league, s.round), high: s.high, low: s.low, highSeed: s.highSeed, lowSeed: s.lowSeed, winner: s.winner, wins: [...s.wins] as [number, number] });
}

/** A champion's road: each round's opponent and result. */
export function pathToTitle(league: League, teamId: number) {
  const b = league.playoffs;
  if (!b) return [];
  return b.rounds
    .flat()
    .filter((s) => s.high === teamId || s.low === teamId)
    .sort((x, y) => x.round - y.round)
    .map((s) => {
      const mine = s.high === teamId ? s.wins[0] : s.wins[1];
      const theirs = s.high === teamId ? s.wins[1] : s.wins[0];
      return { series: s, opp: s.high === teamId ? s.low : s.high, won: s.winner === teamId, mine, theirs, round: playoffRoundName(league, s.round) };
    });
}
