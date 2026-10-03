import type { League, PlayoffSeries, ScheduledGame } from '../types';
import type { GameResult } from '../sim/gameTypes';
import { conferenceSeeds } from './standings';
import { addNews, nextId, teamName } from './helpers';

const HOME_PATTERN = [true, true, false, false, true, false, true]; // 2-2-1-1-1 (high seed perspective)

function makeSeries(league: League, round: number, conferenceId: string | null, a: { teamId: number; seed: number }, b: { teamId: number; seed: number }): PlayoffSeries {
  const [high, low] = a.seed <= b.seed ? [a, b] : [b, a];
  return { id: nextId(league, 'game') + 100000, round, conferenceId, high: high.teamId, low: low.teamId, highSeed: high.seed, lowSeed: low.seed, wins: [0, 0], winner: null, games: [] };
}

/** Build the bracket from the final regular-season standings. */
export function startPlayoffs(league: League): void {
  const cfg = league.config.playoffs;
  const seedsAll: { teamId: number; seed: number; label: string; conferenceId: string }[] = [];
  const firstRound: PlayoffSeries[] = [];
  for (const conf of league.config.conferences) {
    const seeds = conferenceSeeds(league, conf.id);
    seeds.forEach((s) => seedsAll.push({ teamId: s.teamId, seed: s.seed, label: s.label, conferenceId: conf.id }));
    if (cfg.format === 'divisional' && seeds.length === 8) {
      const divs = league.config.divisions.filter((d) => d.conferenceId === conf.id);
      const winners = divs.map((d) => seeds.find((s) => s.divisionId === d.id && s.label.endsWith('1'))!).sort((x, y) => x.seed - y.seed);
      const wcs = seeds.filter((s) => s.label.startsWith('WC')).sort((x, y) => x.seed - y.seed);
      // Best division winner plays the second wild card.
      const pairs: [typeof seeds[number], typeof seeds[number]][] = [];
      for (let i = 0; i < winners.length; i++) {
        const w = winners[i];
        const wc = wcs[wcs.length - 1 - i] ?? wcs[0];
        const d2 = seeds.find((s) => s.divisionId === w.divisionId && s.label.endsWith('2'));
        const d3 = seeds.find((s) => s.divisionId === w.divisionId && s.label.endsWith('3'));
        pairs.push([w, wc]);
        if (d2 && d3) pairs.push([d2, d3]);
      }
      for (const [x, y] of pairs) firstRound.push(makeSeries(league, 0, conf.id, x, y));
    } else {
      const n = seeds.length;
      const order: [number, number][] = [];
      // Classic bracket: 1v8, 4v5, 2v7, 3v6
      const bracket = n >= 8 ? [[1, 8], [4, 5], [2, 7], [3, 6]] : n >= 4 ? [[1, 4], [2, 3]] : [[1, 2]];
      for (const [a, b] of bracket) order.push([a, b]);
      for (const [a, b] of order) {
        const x = seeds.find((s) => s.seed === a);
        const y = seeds.find((s) => s.seed === b);
        if (x && y) firstRound.push(makeSeries(league, 0, conf.id, x, y));
      }
    }
  }
  league.playoffs = { season: league.season, rounds: [firstRound], currentRound: 0, champion: null, roundStartDay: league.day + 1, seeds: seedsAll };
  league.phase = 'playoffs';
  const user = seedsAll.find((s) => s.teamId === league.userTeamId);
  addNews(league, {
    category: 'league',
    headline: `Playoff field set: ${seedsAll.length} teams chase the ${league.config.championship}${user ? ` — ${teamName(league, league.userTeamId)} are in as the ${user.label} seed` : ''}`,
    teamIds: [],
    playerIds: [],
    importance: 4,
  });
}

function winsNeeded(league: League, round: number): number {
  const len = league.config.playoffs.seriesLength[round] ?? 7;
  return Math.ceil(len / 2);
}

/** Create (or return already-created) playoff games for today. */
export function playoffGamesForToday(league: League, create: boolean): ScheduledGame[] {
  const b = league.playoffs;
  if (!b || b.champion !== null) return [];
  const existing = league.schedule.filter((g) => g.playoff && g.day === league.day && !g.played);
  if (existing.length || !create) {
    if (existing.length || league.day < b.roundStartDay || (league.day - b.roundStartDay) % 2 !== 0) return existing;
    // Preview (not creating): describe what would be created.
    return b.rounds[b.currentRound]
      .filter((s) => s.winner === null)
      .map((s) => {
        const gameNo = s.wins[0] + s.wins[1];
        const highHome = HOME_PATTERN[gameNo] ?? true;
        return { id: -1, day: league.day, home: highHome ? s.high : s.low, away: highHome ? s.low : s.high, played: false, playoff: { round: s.round, series: s.id, game: gameNo + 1 } };
      });
  }
  if (league.day < b.roundStartDay || (league.day - b.roundStartDay) % 2 !== 0) return [];
  const out: ScheduledGame[] = [];
  for (const s of b.rounds[b.currentRound]) {
    if (s.winner !== null) continue;
    const gameNo = s.wins[0] + s.wins[1];
    const highHome = HOME_PATTERN[gameNo] ?? true;
    const g: ScheduledGame = {
      id: nextId(league, 'game'),
      day: league.day,
      home: highHome ? s.high : s.low,
      away: highHome ? s.low : s.high,
      played: false,
      playoff: { round: s.round, series: s.id, game: gameNo + 1 },
    };
    league.schedule.push(g);
    s.games.push(g.id);
    out.push(g);
  }
  return out;
}

export function findSeries(league: League, seriesId: number): PlayoffSeries | undefined {
  return league.playoffs?.rounds.flat().find((s) => s.id === seriesId);
}

export function applyPlayoffResult(league: League, g: ScheduledGame, r: GameResult): void {
  const b = league.playoffs;
  if (!b || !g.playoff) return;
  const s = findSeries(league, g.playoff.series);
  if (!s || s.winner !== null) return;
  const winnerTeam = r.homeGoals > r.awayGoals ? g.home : g.away;
  if (winnerTeam === s.high) s.wins[0]++;
  else s.wins[1]++;
  const need = winsNeeded(league, s.round);
  if (s.wins[0] >= need || s.wins[1] >= need) {
    s.winner = s.wins[0] >= need ? s.high : s.low;
    const loser = s.winner === s.high ? s.low : s.high;
    const [w, l] = s.wins[0] >= need ? s.wins : [s.wins[1], s.wins[0]];
    const finalRound = s.conferenceId === null;
    const upset = s.winner === s.low;
    addNews(league, {
      category: 'game',
      headline: finalRound
        ? `${teamName(league, s.winner)} win the ${league.config.championship}!`
        : `${teamName(league, s.winner)} ${upset ? 'upset' : 'eliminate'} ${teamName(league, loser)} in ${w + l} games`,
      teamIds: [s.winner, loser],
      playerIds: [],
      importance: finalRound ? 5 : upset ? 4 : 3,
    });
    advanceBracket(league);
  }
}

function advanceBracket(league: League): void {
  const b = league.playoffs!;
  const round = b.rounds[b.currentRound];
  if (round.some((s) => s.winner === null)) return;
  if (round.length === 1) {
    b.champion = round[0].winner;
    return;
  }
  const next: PlayoffSeries[] = [];
  const nr = b.currentRound + 1;
  // Pair winners within each conference first; the last round pairs conference champions.
  const confs = [...new Set(round.map((s) => s.conferenceId))];
  const sameConf = round.length > confs.length;
  if (sameConf) {
    for (const c of confs) {
      const rs = round.filter((s) => s.conferenceId === c);
      for (let i = 0; i + 1 < rs.length; i += 2) {
        const a = rs[i];
        const bb = rs[i + 1];
        const seedOf = (s: PlayoffSeries) => (s.winner === s.high ? s.highSeed : s.lowSeed);
        next.push(makeSeries(league, nr, c, { teamId: a.winner!, seed: seedOf(a) }, { teamId: bb.winner!, seed: seedOf(bb) }));
      }
    }
  } else {
    // Final: home ice to the better regular-season record.
    const [a, bb] = round;
    const pa = league.standings[a.winner!];
    const pb = league.standings[bb.winner!];
    const ptsA = pa.w * 2 + pa.otl;
    const ptsB = pb.w * 2 + pb.otl;
    next.push(makeSeries(league, nr, null, { teamId: a.winner!, seed: ptsA >= ptsB ? 1 : 2 }, { teamId: bb.winner!, seed: ptsA >= ptsB ? 2 : 1 }));
  }
  b.rounds.push(next);
  b.currentRound = nr;
  b.roundStartDay = league.day + 2;
}

export function playoffRoundName(league: League, round: number): string {
  const total = league.config.playoffs.seriesLength.length;
  const fromEnd = total - 1 - round;
  if (fromEnd === 0) return `${league.config.championship} Final`;
  if (fromEnd === 1) return 'Conference Final';
  if (fromEnd === 2) return 'Second Round';
  return 'First Round';
}

/** Furthest round reached by a team in the current bracket (for history). */
export function playoffResultFor(league: League, teamId: number): string {
  const b = league.playoffs;
  if (!b) return 'DNQ';
  if (b.champion === teamId) return 'Champion';
  let reached = -1;
  for (const r of b.rounds) for (const s of r) if (s.high === teamId || s.low === teamId) reached = Math.max(reached, s.round);
  if (reached < 0) return 'DNQ';
  return `Lost ${playoffRoundName(league, reached)}`;
}
