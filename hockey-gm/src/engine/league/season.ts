/**
 * Season engine: plays the schedule day by day and applies every result to the
 * persistent league state (standings, statistics, injuries, fatigue, form,
 * chemistry, news) and triggers playoffs and the offseason.
 */
import { clamp } from '../core/math';
import { emptyStatLine, addStatLine, points as statPoints } from '../core/statline';
import type { GameSummary, League, Player, ScheduledGame } from '../types';
import type { GameResult } from '../sim/gameTypes';
import { simulateGame } from '../sim/engine';
import { buildGameInput } from './gameInput';
import { applyToStandings } from './standings';
import { addNews, playersOf, teamName } from './helpers';
import { makeInjury, injuryLabel } from '../player/injuries';
import { developPlayer } from '../player/development';
import { newsFromGame } from './news';
import { startPlayoffs, playoffGamesForToday, applyPlayoffResult } from './playoffs';
import { aiDaily } from '../ai/gm';
import { checkLiveRecords } from './records';
import { endRegularSeasonHooks, finishSeason } from './offseason';
import { fullName } from '../player/ability';
import { updateMorale } from './morale';

export function summarize(r: GameResult): GameSummary {
  return {
    hg: r.homeGoals,
    ag: r.awayGoals,
    ot: r.ot,
    so: r.so,
    hs: r.teams[0].shots,
    as: r.teams[1].shots,
    hxg: Math.round(r.teams[0].xg * 100) / 100,
    axg: Math.round(r.teams[1].xg * 100) / 100,
    stars: r.stars,
    goals: r.goals.map((g) => ({ p: g.period, t: Math.round(g.clock), team: g.team, s: g.scorer, a: g.assists, str: g.strength })),
    hGoalie: r.goaliesUsed.find((id) => r.players[id]?.team === 0),
    aGoalie: r.goaliesUsed.find((id) => r.players[id]?.team === 1),
    hPP: [r.teams[0].ppg, r.teams[0].ppOpp],
    aPP: [r.teams[1].ppg, r.teams[1].ppOpp],
  };
}

function statEntry(league: League, p: Player) {
  let e = league.seasonStats[p.id];
  if (!e) {
    e = { reg: emptyStatLine(), po: emptyStatLine(), teamId: p.teamId ?? -1 };
    league.seasonStats[p.id] = e;
  }
  return e;
}

function updateForm(p: Player, s: GameResult['players'][number]): void {
  const streaky = p.traits.includes('streaky') ? 1.6 : 1;
  if (p.pos === 'G') {
    if (s.sa < 5) return;
    const perf = clamp((s.gxga - s.ga) / 1.5, -1, 1);
    p.form = clamp(p.form * 0.82 + perf * 0.18 * streaky, -1, 1);
    p.confidence = clamp(p.confidence * 0.85 + perf * 0.15, -1, 1);
    return;
  }
  const expected = p.pos === 'D' ? 0.1 + (p.ca - 110) * 0.007 : 0.15 + (p.ca - 110) * 0.011;
  const perf = clamp((statPoints(s) - expected) * 0.6 + (s.ixg - expected * 0.4) * 0.5, -1, 1);
  p.form = clamp(p.form * 0.88 + perf * 0.12 * streaky, -1, 1);
}

/** Apply one finished game to league state. */
export function applyGameResult(league: League, g: ScheduledGame, r: GameResult): void {
  if (g.played) return;
  g.played = true;
  g.result = summarize(r);
  const playoff = !!g.playoff;
  if (!playoff) applyToStandings(league, g.home, g.away, r);
  const teams = [g.home, g.away];
  for (const [idStr, s] of Object.entries(r.players)) {
    const p = league.players[Number(idStr)];
    if (!p) continue;
    const e = statEntry(league, p);
    e.teamId = teams[s.team];
    addStatLine(playoff ? e.po : e.reg, s);
    p.seasonToiMin += s.toi / 60;
    // Fatigue: load from minutes, physical play; endurance and age modulate.
    const age = league.season - p.birthYear;
    const end = (p.attrs.endurance - 120) / 400;
    const load = p.pos === 'G' ? (s.gtoi / 60) * 0.55 : (s.toi / 60) * 0.85 + s.hits * 0.3 + s.blocks * 0.5;
    p.fatigue = clamp(p.fatigue + load * (1 - end) * (age > 32 ? 1 + (age - 32) * 0.04 : 1), 0, 100);
    updateForm(p, s);
    if (!playoff) {
      if (statPoints(s) > 0) {
        p.streak.points++;
        p.streak.bestPoints = Math.max(p.streak.bestPoints, p.streak.points);
        if ([10, 15, 20, 25, 30].includes(p.streak.points) && p.pos !== 'G') {
          addNews(league, { category: 'streak', headline: `${fullName(p)} extends point streak to ${p.streak.points} games`, teamIds: [teams[s.team]], playerIds: [p.id], importance: p.streak.points >= 15 ? 4 : 3 });
        }
      } else if (p.pos !== 'G') p.streak.points = 0;
      if (s.g > 0) p.streak.goalless = 0;
      else if (p.pos !== 'G') {
        p.streak.goalless++;
        if (p.streak.goalless === 20 && p.ca >= 150) {
          addNews(league, { category: 'streak', headline: `${fullName(p)} mired in a 20-game goal drought`, teamIds: [teams[s.team]], playerIds: [p.id], importance: 2 });
        }
      }
    }
  }
  // Shared ice time builds chemistry.
  for (const [k, v] of Object.entries(r.pairToi)) league.chemistry[k] = (league.chemistry[k] ?? 0) + v;
  // Injuries.
  for (const inj of r.injuries) {
    const p = league.players[inj.playerId];
    if (!p) continue;
    const days = Math.max(1, Math.round(inj.injury.days * league.settings.injuryRate));
    if (p.injury && p.injury.daysRemaining >= days) continue;
    p.injury = makeInjury({ ...inj.injury, days }, league.season, league.day);
    p.injuryHistory.push({ season: league.season, type: inj.injury.type, bodyPart: inj.injury.bodyPart, days });
    if (inj.injury.severity !== 'minor' && (p.reputation >= 40 || p.teamId === league.userTeamId)) {
      const vet = league.season - p.birthYear >= 30;
      addNews(league, {
        category: 'injury',
        headline: `${vet ? 'Veteran' : ''} ${p.pos === 'D' ? 'defenseman' : p.pos === 'G' ? 'goaltender' : 'forward'} ${fullName(p)} ${days > 21 ? 'placed on injured reserve' : 'out'}: ${injuryLabel(p.injury)}`.trim().replace(/^./, (c) => c.toUpperCase()),
        teamIds: p.teamId !== null ? [p.teamId] : [],
        playerIds: [p.id],
        importance: days > 60 ? 4 : 3,
      });
    }
  }
  newsFromGame(league, g.home, g.away, r, playoff);
  if (playoff) applyPlayoffResult(league, g, r);
}

export function gamesOnDay(league: League, day: number): ScheduledGame[] {
  return league.schedule.filter((g) => g.day === day && !g.played);
}

export function userGameToday(league: League): ScheduledGame | undefined {
  if (league.phase === 'playoffs') {
    const todays = playoffGamesForToday(league, false);
    return todays.find((g) => g.home === league.userTeamId || g.away === league.userTeamId);
  }
  if (league.phase !== 'regular') return undefined;
  return gamesOnDay(league, league.day).find((g) => g.home === league.userTeamId || g.away === league.userTeamId);
}

/** Make sure today's games exist (playoff games are created day by day) and return the user's. */
export function prepareUserGame(league: League): ScheduledGame | undefined {
  if (league.phase === 'playoffs') playoffGamesForToday(league, true);
  return userGameToday(league);
}

export function nextUserGame(league: League): ScheduledGame | undefined {
  return league.schedule
    .filter((g) => !g.played && (g.home === league.userTeamId || g.away === league.userTeamId))
    .sort((a, b) => a.day - b.day)[0];
}

/** Daily maintenance: injuries heal, fatigue recovers, periodic development/morale/AI. */
function dailyUpdates(league: League): void {
  const day = league.day;
  for (const p of Object.values(league.players)) {
    if (p.status === 'retired' || p.status === 'draft') continue;
    if (p.injury) {
      p.injury.daysRemaining--;
      if (p.injury.daysRemaining <= 0) p.injury = null;
    }
    p.fatigue = clamp(p.fatigue * 0.58 - 0.5, 0, 100);
  }
  if (day % 7 === 6) updateMorale(league);
  if (day % 21 === 20) inSeasonDevelopment(league, 21 / 190);
  aiDaily(league);
}

/** Young players develop a little during the season; the rest happens in the offseason. */
export function inSeasonDevelopment(league: League, fraction: number): void {
  for (const p of Object.values(league.players)) {
    if (p.status !== 'active' && p.status !== 'prospect') continue;
    const age = league.season - p.birthYear;
    if (age > 26 || p.pa <= p.ca) continue;
    developPlayer(p, devContext(league, p, fraction * 0.45));
  }
}

export function devContext(league: League, p: Player, fraction: number) {
  const team = p.teamId !== null ? league.teams[p.teamId] : null;
  const hc = team?.staff.headCoach != null ? league.coaches[team.staff.headCoach] : undefined;
  const asst = team?.staff.assistant != null ? league.coaches[team.staff.assistant] : undefined;
  const gk = team?.staff.goalieCoach != null ? league.coaches[team.staff.goalieCoach] : undefined;
  const coachDev = p.pos === 'G' ? (gk?.ratings.goaltending ?? 90) * 0.6 + (hc?.ratings.development ?? 90) * 0.4 : (hc?.ratings.development ?? 90) * 0.7 + (asst?.ratings.development ?? 90) * 0.3;
  const env = clamp(0.93 + (coachDev - 100) / 1400 + ((team?.facilities ?? 90) - 100) / 1800, 0.85, 1.02);
  const gp = league.seasonStats[p.id]?.reg.gp ?? 0;
  const toiPerGame = gp ? p.seasonToiMin / gp : 0;
  const daysPlayed = Math.max(1, league.day);
  const gamesShare = clamp(gp / Math.max(1, daysPlayed / 2.3), 0, 1);
  const iceTime = p.pos === 'G' ? gamesShare : clamp((toiPerGame / Math.max(8, p.expectedToi)) * 0.6 + gamesShare * 0.4, 0, 1.2);
  const injuryDays = p.injuryHistory.filter((h) => h.season === league.season).reduce((s, h) => s + h.days, 0);
  return { season: league.season, iceTime, environment: env, fraction, injuryDays, minors: p.status === 'prospect', leagueSeed: league.seed };
}

export interface DayReport {
  day: number;
  phase: League['phase'];
  games: ScheduledGame[];
}

/**
 * Advance the league by one day. `overrides` lets the UI supply results for
 * games it played live (so the live game *is* the official result).
 */
export function advanceDay(league: League, overrides: Map<number, GameResult> = new Map()): DayReport {
  const report: DayReport = { day: league.day, phase: league.phase, games: [] };
  if (league.phase === 'regular') {
    const todays = gamesOnDay(league, league.day);
    for (const g of todays) {
      const r = overrides.get(g.id) ?? simulateGame(buildGameInput(league, g.id));
      applyGameResult(league, g, r);
      report.games.push(g);
    }
    if (todays.length) checkLiveRecords(league);
    dailyUpdates(league);
    league.day++;
    if (league.schedule.every((g) => g.played || g.playoff)) {
      endRegularSeasonHooks(league);
      startPlayoffs(league);
    }
    return report;
  }
  if (league.phase === 'playoffs') {
    const todays = playoffGamesForToday(league, true);
    for (const g of todays) {
      const r = overrides.get(g.id) ?? simulateGame(buildGameInput(league, g.id));
      applyGameResult(league, g, r);
      report.games.push(g);
    }
    dailyUpdates(league);
    league.day++;
    if (league.playoffs?.champion != null) finishSeason(league);
    return report;
  }
  return report;
}

export function simDays(league: League, n: number): DayReport[] {
  const out: DayReport[] = [];
  for (let i = 0; i < n; i++) {
    if (league.phase !== 'regular' && league.phase !== 'playoffs') break;
    out.push(advanceDay(league));
  }
  return out;
}

/** Sim until the user's team has a game on the current day (or the phase ends). */
export function simToNextUserGame(league: League): DayReport[] {
  const out: DayReport[] = [];
  const phase = league.phase;
  while (league.phase === phase && (phase === 'regular' || phase === 'playoffs')) {
    if (userGameToday(league)) break;
    out.push(advanceDay(league));
    if (out.length > 400) break;
  }
  return out;
}

export type SimTarget = 'tradeDeadline' | 'endRegular' | 'endPlayoffs' | 'endSeason';

export function simTo(league: League, target: SimTarget): DayReport[] {
  const out: DayReport[] = [];
  let guard = 0;
  while (guard++ < 1000) {
    if (target === 'tradeDeadline' && (league.phase !== 'regular' || league.day >= league.tradeDeadlineDay)) break;
    if (target === 'endRegular' && league.phase !== 'regular') break;
    if ((target === 'endPlayoffs' || target === 'endSeason') && league.phase !== 'regular' && league.phase !== 'playoffs') break;
    out.push(advanceDay(league));
  }
  return out;
}

export function teamInjuries(league: League, teamId: number): Player[] {
  return playersOf(league, teamId, ['active', 'prospect']).filter((p) => p.injury);
}

export function describeResult(league: League, g: ScheduledGame): string {
  if (!g.result) return '';
  const r = g.result;
  const suffix = r.so ? ' (SO)' : r.ot ? ' (OT)' : '';
  return `${teamName(league, g.away)} ${r.ag} @ ${teamName(league, g.home)} ${r.hg}${suffix}`;
}
