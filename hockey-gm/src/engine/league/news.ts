import type { League, Player } from '../types';
import type { GameResult } from '../sim/gameTypes';
import { addNews, teamName } from './helpers';
import { fullName } from '../player/ability';
import { points } from '../core/statline';

function careerTotals(league: League, p: Player): { g: number; a: number; pts: number; gp: number; w: number; so: number } {
  let g = 0;
  let a = 0;
  let gp = 0;
  let w = 0;
  let so = 0;
  for (const c of p.career) {
    if (c.playoffs) continue;
    g += c.stats.g;
    a += c.stats.a1 + c.stats.a2;
    gp += c.stats.gp;
    w += c.stats.w;
    so += c.stats.so;
  }
  const cur = league.seasonStats[p.id]?.reg;
  if (cur) {
    g += cur.g;
    a += cur.a1 + cur.a2;
    gp += cur.gp;
    w += cur.w;
    so += cur.so;
  }
  return { g, a, pts: g + a, gp, w, so };
}

export { careerTotals };

const MILESTONES_G = [100, 200, 300, 400, 500, 600, 700];
const MILESTONES_P = [250, 500, 750, 1000, 1250, 1500];

/**
 * Turn a finished game into news items. Called after stats are applied so
 * career totals already include this game.
 */
export function newsFromGame(league: League, home: number, away: number, r: GameResult, playoff: boolean): void {
  const teams = [home, away];
  const tn = (i: 0 | 1) => teamName(league, teams[i]);
  const winner: 0 | 1 = r.homeGoals > r.awayGoals ? 0 : 1;
  const notable = (p: Player) => p.teamId === league.userTeamId || p.reputation >= 45;
  for (const [idStr, s] of Object.entries(r.players)) {
    const p = league.players[Number(idStr)];
    if (!p) continue;
    const side = s.team;
    const tot = careerTotals(league, p);
    const age = league.season - p.birthYear;
    if (s.g >= 3) {
      const rookie = p.proSeasons <= 1 && age <= 23;
      addNews(league, {
        category: 'game',
        headline: rookie ? `Rookie sensation ${fullName(p)} scores ${s.g >= 4 ? 'four' : 'a hat trick'} for ${tn(side)}` : `${fullName(p)} records ${s.g >= 4 ? `a ${s.g}-goal game` : 'a hat trick'} as ${tn(side)} ${side === winner ? 'win' : 'fall'} ${Math.max(r.homeGoals, r.awayGoals)}-${Math.min(r.homeGoals, r.awayGoals)}`,
        teamIds: [teams[side]],
        playerIds: [p.id],
        importance: s.g >= 4 ? 4 : 3,
      });
    } else if (points(s) >= 5) {
      addNews(league, { category: 'game', headline: `${fullName(p)} piles up ${points(s)} points for ${tn(side)}`, teamIds: [teams[side]], playerIds: [p.id], importance: 3 });
    }
    if (s.g > 0 && tot.g === s.g && notable(p)) {
      addNews(league, { category: 'milestone', headline: `${fullName(p)} scores first career goal for ${tn(side)}`, teamIds: [teams[side]], playerIds: [p.id], importance: 2 });
    }
    for (const m of MILESTONES_G) if (tot.g >= m && tot.g - s.g < m) addNews(league, { category: 'milestone', headline: `${fullName(p)} scores career goal No. ${m}`, teamIds: [teams[side]], playerIds: [p.id], importance: m >= 500 ? 5 : 4 });
    const pts = points(s);
    for (const m of MILESTONES_P) if (tot.pts >= m && tot.pts - pts < m) addNews(league, { category: 'milestone', headline: `${fullName(p)} reaches ${m} career points`, teamIds: [teams[side]], playerIds: [p.id], importance: m >= 1000 ? 5 : 4 });
    if (s.so && s.sa >= 30) {
      addNews(league, {
        category: 'game',
        headline: `${fullName(p)} posts a ${s.sa}-save shutout${playoff ? ' in the playoffs' : ''}`,
        teamIds: [teams[side]],
        playerIds: [p.id],
        importance: s.sa >= 40 ? 4 : 3,
      });
    } else if (s.so && notable(p)) {
      addNews(league, { category: 'game', headline: `${fullName(p)} blanks ${tn((1 - side) as 0 | 1)} with ${s.sa} saves`, teamIds: [teams[side]], playerIds: [p.id], importance: 2 });
    }
    if (s.sa >= 45 && s.w) addNews(league, { category: 'game', headline: `${fullName(p)} stops ${s.sa - s.ga} of ${s.sa} to steal one for ${tn(side)}`, teamIds: [teams[side]], playerIds: [p.id], importance: 3 });
  }
  // Big comebacks.
  const goals = r.goals;
  let h = 0;
  let a = 0;
  let maxDeficit = 0;
  for (const g of goals) {
    if (g.team === 0) h++;
    else a++;
    const d = winner === 0 ? a - h : h - a;
    maxDeficit = Math.max(maxDeficit, d);
  }
  if (maxDeficit >= 3) {
    addNews(league, {
      category: 'game',
      headline: `${tn(winner)} rally from ${maxDeficit} goals down to beat ${tn((1 - winner) as 0 | 1)}`,
      teamIds: teams,
      playerIds: [],
      importance: 3,
    });
  }
  if (playoff && r.periods >= 6) {
    const last = goals[goals.length - 1];
    const scorer = last ? league.players[last.scorer] : undefined;
    addNews(league, {
      category: 'game',
      headline: `${scorer ? fullName(scorer) : tn(winner)} ends ${r.periods - 3}OT marathon for ${tn(winner)}`,
      teamIds: teams,
      playerIds: scorer ? [scorer.id] : [],
      importance: 4,
    });
  }
}
