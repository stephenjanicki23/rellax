/**
 * The awards race (who leads each trophy right now), the three stars of the
 * week, and the mid-season All-Star selections.
 */
import type { League, Player } from '../types';
import { assists, gsax, points, savePct } from '../core/statline';
import { AWARD_NAMES, SCORERS, isRookieSeason, type AwardCand } from './awards';
import { addNews, teamName } from './helpers';
import { fullName } from '../player/ability';

export interface RaceEntry {
  playerId: number;
  teamId: number;
  value: string;
  score: number;
}
export interface Race {
  key: string;
  award: string;
  leaders: RaceEntry[];
}

function candidates(league: League): AwardCand[] {
  const out: AwardCand[] = [];
  for (const [id, e] of Object.entries(league.seasonStats)) {
    const p = league.players[Number(id)];
    if (p && e.reg.gp > 0) out.push({ p, s: e.reg, teamId: e.teamId });
  }
  return out;
}

/** Share of the regular season played so far (scales the games-played minimums). */
function seasonShare(league: League): number {
  const recs = Object.values(league.standings);
  const gp = recs.reduce((s, r) => s + r.gp, 0) / Math.max(1, recs.length);
  return Math.min(1, gp / league.config.season.games);
}

const skLine = (c: AwardCand) => `${c.s.gp} GP · ${c.s.g} G · ${assists(c.s)} A · ${points(c.s)} PTS`;
const gLine = (c: AwardCand) => `${c.s.gp} GP · ${savePct(c.s).toFixed(3).replace(/^0/, '')} SV% · ${gsax(c.s).toFixed(1)} GSAx`;

export function awardsRace(league: League, top = 5): Race[] {
  const share = seasonShare(league);
  const min = (n: number) => Math.max(3, Math.round(n * share));
  const all = candidates(league);
  const skaters = all.filter((c) => c.p.pos !== 'G');
  const goalies = all.filter((c) => c.p.pos === 'G' && c.s.gp >= min(25));
  const rank = (key: string, award: string, pool: AwardCand[], score: (c: AwardCand) => number, line: (c: AwardCand) => string): Race => ({
    key,
    award,
    leaders: pool
      .map((c) => ({ c, v: score(c) }))
      .sort((a, b) => b.v - a.v)
      .slice(0, top)
      .map(({ c, v }) => ({ playerId: c.p.id, teamId: c.teamId, value: line(c), score: v })),
  });
  // Hart: skaters and goalies on one ballot.
  const hartPool = [...skaters.filter((c) => c.s.gp >= min(40)), ...goalies];
  const hart = rank('hart', AWARD_NAMES.mvp, hartPool, (c) => (c.p.pos === 'G' ? SCORERS.hartGoalie(league, c) : SCORERS.hartSkater(league, c)), (c) => (c.p.pos === 'G' ? gLine(c) : skLine(c)));
  return [
    hart,
    rank('artross', AWARD_NAMES.scoring, skaters, (c) => points(c.s) + c.s.g * 0.01, skLine),
    rank('rocket', AWARD_NAMES.goals, skaters, (c) => c.s.g + points(c.s) * 0.001, (c) => `${c.s.g} goals in ${c.s.gp} GP`),
    rank('vezina', AWARD_NAMES.goalie, goalies, (c) => SCORERS.vezina(league, c), gLine),
    rank('norris', AWARD_NAMES.defense, skaters.filter((c) => c.p.pos === 'D' && c.s.gp >= min(40)), (c) => SCORERS.norris(league, c), (c) => `${skLine(c)} · ${(c.s.toi / c.s.gp / 60).toFixed(1)} TOI`),
    rank('calder', AWARD_NAMES.rookie, all.filter((c) => isRookieSeason(c.p, league.season) && c.s.gp >= min(25)), (c) => SCORERS.calder(league, c), (c) => (c.p.pos === 'G' ? gLine(c) : skLine(c))),
    rank('selke', AWARD_NAMES.selke, skaters.filter((c) => c.p.pos !== 'D' && c.s.gp >= min(50)), (c) => SCORERS.selke(league, c), (c) => `${c.s.tk} TK · ${c.s.pm > 0 ? '+' : ''}${c.s.pm}`),
  ];
}

// ── Three stars of the week ─────────────────────────────────────────────

interface Snap {
  gp: number;
  g: number;
  pts: number;
  w: number;
  sa: number;
  ga: number;
}

function snapOf(league: League): Record<number, Snap> {
  const out: Record<number, Snap> = {};
  for (const [id, e] of Object.entries(league.seasonStats)) out[Number(id)] = { gp: e.reg.gp, g: e.reg.g, pts: points(e.reg), w: e.reg.w, sa: e.reg.sa, ga: e.reg.ga };
  return out;
}

/** Weekly: the three best performers since last week. */
export function weeklyStars(league: League): void {
  if (league.phase !== 'regular') return;
  const w = league.weekly;
  const now = snapOf(league);
  if (!w || w.season !== league.season) {
    league.weekly = { season: league.season, snapshot: now, stars: [] };
    return;
  }
  const scored: { p: Player; teamId: number; score: number; line: string }[] = [];
  for (const [idStr, s] of Object.entries(now)) {
    const id = Number(idStr);
    const p = league.players[id];
    const before = w.snapshot[id] ?? { gp: 0, g: 0, pts: 0, w: 0, sa: 0, ga: 0 };
    const gp = s.gp - before.gp;
    if (!p || gp <= 0) continue;
    const teamId = league.seasonStats[id].teamId;
    if (p.pos === 'G') {
      const sa = s.sa - before.sa;
      const ga = s.ga - before.ga;
      const wins = s.w - before.w;
      if (sa < 60) continue;
      const sv = (sa - ga) / sa;
      scored.push({ p, teamId, score: wins * 1.5 + (sv - 0.905) * 75, line: `${wins}-${gp - wins} · ${sv.toFixed(3).replace(/^0/, '')} SV%` });
    } else {
      const g = s.g - before.g;
      const pts = s.pts - before.pts;
      if (pts < 3) continue;
      scored.push({ p, teamId, score: pts + g * 0.35, line: `${g} G · ${pts - g} A · ${pts} PTS in ${gp} GP` });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const stars = scored.slice(0, 3).map((x) => ({ playerId: x.p.id, teamId: x.teamId, line: x.line }));
  if (stars.length) {
    w.stars.unshift({ day: league.day, stars });
    w.stars = w.stars.slice(0, 26);
    const first = league.players[stars[0].playerId];
    addNews(league, {
      category: 'award',
      headline: `Three stars of the week: ${stars.map((s, i) => `${['1st', '2nd', '3rd'][i]} ${fullName(league.players[s.playerId])} (${league.teams[s.teamId].abbr})`).join(', ')}`,
      body: `${fullName(first)}: ${stars[0].line}.`,
      teamIds: [...new Set(stars.map((s) => s.teamId))],
      playerIds: stars.map((s) => s.playerId),
      importance: stars.some((s) => s.teamId === league.userTeamId) ? 3 : 1,
    });
  }
  w.snapshot = now;
}

// ── All-Stars ───────────────────────────────────────────────────────────

/** Day the All-Star rosters are named: just past the midpoint of the regular season. */
export function allStarDay(league: League): number {
  const last = league.schedule.reduce((m, g) => (g.playoff ? m : Math.max(m, g.day)), 0);
  return Math.round(last * 0.55);
}

/**
 * Name an All-Star roster per conference: 12 forwards, 6 defencemen and 3
 * goalies on merit, with every club represented at least once.
 */
export function selectAllStars(league: League): void {
  if (league.allStars?.season === league.season) return;
  const all = candidates(league);
  const share = seasonShare(league);
  const rosters: Record<string, number[]> = {};
  for (const conf of league.config.conferences) {
    const inConf = (teamId: number) => league.teams[teamId]?.conferenceId === conf.id;
    const pool = all.filter((c) => inConf(c.teamId) && c.p.teamId === c.teamId);
    const merit = (c: AwardCand) => (c.p.pos === 'G' ? SCORERS.hartGoalie(league, c) + c.p.ca * 0.08 : points(c.s) / Math.max(1, c.s.gp) * 40 + c.s.g * 0.3 + c.p.ca * 0.1);
    const pick = (f: (c: AwardCand) => boolean, n: number, minGp: number) =>
      pool
        .filter((c) => f(c) && c.s.gp >= Math.round(minGp * share))
        .sort((a, b) => merit(b) - merit(a))
        .slice(0, n);
    const chosen = [...pick((c) => c.p.pos !== 'G' && c.p.pos !== 'D', 12, 25), ...pick((c) => c.p.pos === 'D', 6, 25), ...pick((c) => c.p.pos === 'G', 3, 15)];
    // Every club sends someone: its best player replaces the weakest pick at his position group.
    for (const t of league.teams.filter((x) => x.conferenceId === conf.id)) {
      if (chosen.some((c) => c.teamId === t.id)) continue;
      const best = pool.filter((c) => c.teamId === t.id && c.s.gp >= Math.round(15 * share)).sort((a, b) => merit(b) - merit(a))[0];
      if (!best) continue;
      const group = (c: AwardCand) => (c.p.pos === 'G' ? 'G' : c.p.pos === 'D' ? 'D' : 'F');
      const counts = new Map<number, number>();
      for (const c of chosen) counts.set(c.teamId, (counts.get(c.teamId) ?? 0) + 1);
      const swap = chosen
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => group(c) === group(best) && (counts.get(c.teamId) ?? 0) > 1)
        .sort((a, b) => merit(a.c) - merit(b.c))[0];
      if (swap) chosen[swap.i] = best;
    }
    rosters[conf.id] = chosen.map((c) => c.p.id);
    for (const c of chosen) c.p.awards.push({ season: league.season, award: 'All-Star' });
  }
  league.allStars = { season: league.season, day: league.day, rosters };
  const mine = Object.values(rosters).flat().filter((id) => league.players[id]?.teamId === league.userTeamId);
  addNews(league, {
    category: 'award',
    headline: `All-Star rosters named${mine.length ? `: ${mine.map((id) => fullName(league.players[id])).join(', ')} will represent the ${teamName(league, league.userTeamId)}` : ''}`,
    teamIds: mine.length ? [league.userTeamId] : [],
    playerIds: mine,
    importance: 3,
  });
}
