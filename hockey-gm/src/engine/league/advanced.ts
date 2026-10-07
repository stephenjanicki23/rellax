/**
 * Advanced stats: rate and share metrics for players and teams, league
 * rankings, and the link between a team metric and the player metric that
 * drives it (so a team weakness points straight at the players who are best
 * at fixing it). Built from the season's box-score lines only.
 */
import type { League, Player, StatLine } from '../types';
import { emptyStatLine, addStatLine, points, savePct, corsiPct, xgPct, faceoffPct, gsax, hdSavePct, reboundRate, gaa } from '../core/statline';
import { ppPct, pkPct } from './standings';

export type Better = 'high' | 'low';
export type Fmt = 'pct' | 'sv' | 'num1' | 'num2' | 'signed1' | 'toi';

export interface PlayerRow {
  p: Player;
  s: StatLine;
  teamId: number;
}

export interface PlayerMetric {
  key: string;
  label: string;
  short: string;
  desc: string;
  group: 'skater' | 'goalie';
  better: Better;
  fmt: Fmt;
  value: (s: StatLine) => number;
  /** Minimum sample to qualify for the rankings. */
  qualifies: (s: StatLine) => boolean;
}

const per60 = (v: number, secs: number) => (secs > 0 ? (v * 3600) / secs : 0);
const esPoints = (s: StatLine) => points(s) - (s.ppg + s.ppa) - (s.shg + s.sha);
const minToi = (mins: number) => (s: StatLine) => s.toi >= mins * 60;

export const PLAYER_METRICS: PlayerMetric[] = [
  { key: 'p60', label: 'Points per 60', short: 'P/60', desc: 'Points per 60 minutes, all situations.', group: 'skater', better: 'high', fmt: 'num2', value: (s) => per60(points(s), s.toi), qualifies: minToi(150) },
  { key: 'g60', label: 'Goals per 60', short: 'G/60', desc: 'Goals per 60 minutes, all situations.', group: 'skater', better: 'high', fmt: 'num2', value: (s) => per60(s.g, s.toi), qualifies: minToi(150) },
  { key: 'esp60', label: 'Even-strength points per 60', short: 'ESP/60', desc: 'Five-on-five scoring rate (points excluding power-play and shorthanded points, per 60 even-strength minutes).', group: 'skater', better: 'high', fmt: 'num2', value: (s) => per60(esPoints(s), s.toiES), qualifies: minToi(150) },
  { key: 'ppp60', label: 'Power-play points per 60', short: 'PPP/60', desc: 'Power-play points per 60 power-play minutes.', group: 'skater', better: 'high', fmt: 'num2', value: (s) => per60(s.ppg + s.ppa, s.toiPP), qualifies: (s) => s.toiPP >= 25 * 60 },
  { key: 'isf60', label: 'Shots per 60', short: 'iSF/60', desc: 'Individual shots on goal per 60 minutes.', group: 'skater', better: 'high', fmt: 'num2', value: (s) => per60(s.sog, s.toi), qualifies: minToi(150) },
  { key: 'icf60', label: 'Shot attempts per 60', short: 'iCF/60', desc: 'Individual shot attempts (on goal, missed and blocked) per 60 minutes.', group: 'skater', better: 'high', fmt: 'num2', value: (s) => per60(s.att, s.toi), qualifies: minToi(150) },
  { key: 'ixg60', label: 'Expected goals per 60', short: 'ixG/60', desc: 'Quality of the chances a player generates himself: individual expected goals per 60 minutes.', group: 'skater', better: 'high', fmt: 'num2', value: (s) => per60(s.ixg, s.toi), qualifies: minToi(150) },
  { key: 'xa60', label: 'Expected assists per 60', short: 'xA/60', desc: 'Expected goals of the shots that came right after his passes, per 60 minutes: playmaking.', group: 'skater', better: 'high', fmt: 'num2', value: (s) => per60(s.ixa, s.toi), qualifies: minToi(150) },
  { key: 'gax', label: 'Goals above expected', short: 'G−xG', desc: 'Goals minus individual expected goals: finishing talent (or luck).', group: 'skater', better: 'high', fmt: 'signed1', value: (s) => s.g - s.ixg, qualifies: minToi(150) },
  { key: 'shpct', label: 'Shooting percentage', short: 'SH%', desc: 'Goals per shot on goal.', group: 'skater', better: 'high', fmt: 'pct', value: (s) => (s.sog ? s.g / s.sog : 0), qualifies: (s) => s.sog >= 30 },
  { key: 'cfpct', label: 'Corsi for %', short: 'CF%', desc: 'Share of all shot attempts taken by his team while he is on the ice: puck possession.', group: 'skater', better: 'high', fmt: 'pct', value: corsiPct, qualifies: minToi(150) },
  { key: 'xgfpct', label: 'Expected goals for %', short: 'xGF%', desc: 'Share of expected goals while he is on the ice: who gets the better chances when he plays.', group: 'skater', better: 'high', fmt: 'pct', value: xgPct, qualifies: minToi(150) },
  { key: 'xgf60', label: 'On-ice xGF per 60', short: 'xGF/60', desc: 'Expected goals his team creates per 60 minutes with him on the ice.', group: 'skater', better: 'high', fmt: 'num2', value: (s) => per60(s.xgf, s.toi), qualifies: minToi(150) },
  { key: 'xga60', label: 'On-ice xGA per 60', short: 'xGA/60', desc: 'Expected goals his team allows per 60 minutes with him on the ice (lower is better): defensive impact.', group: 'skater', better: 'low', fmt: 'num2', value: (s) => per60(s.xga, s.toi), qualifies: minToi(150) },
  { key: 'hits60', label: 'Hits per 60', short: 'HIT/60', desc: 'Body checks per 60 minutes.', group: 'skater', better: 'high', fmt: 'num1', value: (s) => per60(s.hits, s.toi), qualifies: minToi(150) },
  { key: 'blk60', label: 'Blocked shots per 60', short: 'BLK/60', desc: 'Shots blocked per 60 minutes.', group: 'skater', better: 'high', fmt: 'num1', value: (s) => per60(s.blocks, s.toi), qualifies: minToi(150) },
  { key: 'tk60', label: 'Takeaways per 60', short: 'TK/60', desc: 'Pucks stolen from opponents per 60 minutes.', group: 'skater', better: 'high', fmt: 'num2', value: (s) => per60(s.tk, s.toi), qualifies: minToi(150) },
  { key: 'gv60', label: 'Giveaways per 60', short: 'GV/60', desc: 'Pucks given away per 60 minutes (lower is better).', group: 'skater', better: 'low', fmt: 'num2', value: (s) => per60(s.gv, s.toi), qualifies: minToi(150) },
  { key: 'pim60', label: 'Penalty minutes per 60', short: 'PIM/60', desc: 'Penalty minutes per 60 minutes (lower is better).', group: 'skater', better: 'low', fmt: 'num2', value: (s) => per60(s.pim, s.toi), qualifies: minToi(150) },
  { key: 'fopct', label: 'Faceoff win %', short: 'FO%', desc: 'Share of faceoffs won.', group: 'skater', better: 'high', fmt: 'pct', value: faceoffPct, qualifies: (s) => s.fow + s.fol >= 100 },
  { key: 'pktoi', label: 'Penalty-kill time per game', short: 'PK TOI', desc: 'Short-handed ice time per game: who the coaches trust to kill penalties.', group: 'skater', better: 'high', fmt: 'toi', value: (s) => (s.gp ? s.toiPK / s.gp : 0), qualifies: (s) => s.gp >= 10 },
  { key: 'toi', label: 'Ice time per game', short: 'TOI/GP', desc: 'Average ice time per game.', group: 'skater', better: 'high', fmt: 'toi', value: (s) => (s.gp ? s.toi / s.gp : 0), qualifies: (s) => s.gp >= 10 },
  { key: 'svpct', label: 'Save percentage', short: 'SV%', desc: 'Saves per shot on goal.', group: 'goalie', better: 'high', fmt: 'sv', value: savePct, qualifies: (s) => s.gtoi >= 300 * 60 },
  { key: 'gsax', label: 'Goals saved above expected', short: 'GSAx', desc: 'Expected goals of the shots he faced minus goals allowed: how many goals he saved compared to an average goalie.', group: 'goalie', better: 'high', fmt: 'signed1', value: gsax, qualifies: (s) => s.gtoi >= 300 * 60 },
  { key: 'gsax60', label: 'GSAx per 60', short: 'GSAx/60', desc: 'Goals saved above expected per 60 minutes played.', group: 'goalie', better: 'high', fmt: 'num2', value: (s) => per60(gsax(s), s.gtoi), qualifies: (s) => s.gtoi >= 300 * 60 },
  { key: 'hdsv', label: 'High-danger save %', short: 'HDSV%', desc: 'Save percentage on high-danger chances.', group: 'goalie', better: 'high', fmt: 'sv', value: hdSavePct, qualifies: (s) => s.hdsa >= 40 },
  { key: 'gaa', label: 'Goals against average', short: 'GAA', desc: 'Goals allowed per 60 minutes (lower is better).', group: 'goalie', better: 'low', fmt: 'num2', value: gaa, qualifies: (s) => s.gtoi >= 300 * 60 },
  { key: 'reb', label: 'Rebound rate', short: 'Reb%', desc: 'Rebounds allowed per save (lower is better).', group: 'goalie', better: 'low', fmt: 'pct', value: reboundRate, qualifies: (s) => s.gtoi >= 300 * 60 },
];

export const playerMetric = (key: string) => PLAYER_METRICS.find((m) => m.key === key);

// ── Teams ────────────────────────────────────────────────────────────────

export interface TeamTotals {
  teamId: number;
  gp: number;
  /** Standings line (goals, shots, attempts, special teams…). */
  r: League['standings'][number];
  /** Sum of the team's players' lines this season (takeaways, giveaways, goalie GSAx…). */
  skaters: StatLine;
  goalies: StatLine;
}

export interface TeamMetric {
  key: string;
  label: string;
  short: string;
  desc: string;
  better: Better;
  fmt: Fmt;
  value: (t: TeamTotals) => number;
  /** The player metric that drives this team stat (for the leaders page). */
  player: string;
}

const pg = (v: number, gp: number) => (gp ? v / gp : 0);

export const TEAM_METRICS: TeamMetric[] = [
  { key: 'gf', label: 'Goals for per game', short: 'GF/G', desc: 'Goals scored per game.', better: 'high', fmt: 'num2', value: (t) => pg(t.r.gf, t.gp), player: 'p60' },
  { key: 'ga', label: 'Goals against per game', short: 'GA/G', desc: 'Goals allowed per game (lower is better).', better: 'low', fmt: 'num2', value: (t) => pg(t.r.ga, t.gp), player: 'gsax' },
  { key: 'cf', label: 'Corsi for %', short: 'CF%', desc: 'Share of all shot attempts: puck possession.', better: 'high', fmt: 'pct', value: (t) => (t.r.cf + t.r.ca ? t.r.cf / (t.r.cf + t.r.ca) : 0.5), player: 'cfpct' },
  { key: 'xgfp', label: 'Expected goals for %', short: 'xGF%', desc: 'Share of expected goals: who gets the better chances.', better: 'high', fmt: 'pct', value: (t) => (t.r.xgf + t.r.xga ? t.r.xgf / (t.r.xgf + t.r.xga) : 0.5), player: 'xgfpct' },
  { key: 'xgf', label: 'Expected goals for per game', short: 'xGF/G', desc: 'Quality of chances created per game.', better: 'high', fmt: 'num2', value: (t) => pg(t.r.xgf, t.gp), player: 'ixg60' },
  { key: 'xga', label: 'Expected goals against per game', short: 'xGA/G', desc: 'Quality of chances allowed per game (lower is better).', better: 'low', fmt: 'num2', value: (t) => pg(t.r.xga, t.gp), player: 'xga60' },
  { key: 'sf', label: 'Shots for per game', short: 'SF/G', desc: 'Shots on goal per game.', better: 'high', fmt: 'num1', value: (t) => pg(t.r.sf, t.gp), player: 'isf60' },
  { key: 'sa', label: 'Shots against per game', short: 'SA/G', desc: 'Shots on goal allowed per game (lower is better).', better: 'low', fmt: 'num1', value: (t) => pg(t.r.sa, t.gp), player: 'xga60' },
  { key: 'gax', label: 'Goals above expected', short: 'GF−xGF', desc: 'Goals scored minus expected goals: finishing.', better: 'high', fmt: 'signed1', value: (t) => t.r.gf - t.r.xgf, player: 'gax' },
  { key: 'shp', label: 'Shooting percentage', short: 'SH%', desc: 'Goals per shot on goal.', better: 'high', fmt: 'pct', value: (t) => (t.r.sf ? t.r.gf / t.r.sf : 0), player: 'shpct' },
  { key: 'svp', label: 'Save percentage', short: 'SV%', desc: 'Saves per shot on goal allowed.', better: 'high', fmt: 'sv', value: (t) => (t.r.sa ? 1 - t.r.ga / t.r.sa : 0), player: 'svpct' },
  { key: 'gsax', label: 'Goals saved above expected', short: 'GSAx', desc: 'Goaltending: expected goals faced minus goals allowed.', better: 'high', fmt: 'signed1', value: (t) => gsax(t.goalies), player: 'gsax' },
  { key: 'pp', label: 'Power-play %', short: 'PP%', desc: 'Power-play goals per opportunity.', better: 'high', fmt: 'pct', value: (t) => ppPct(t.r), player: 'ppp60' },
  { key: 'pk', label: 'Penalty-kill %', short: 'PK%', desc: 'Penalties killed per time short-handed.', better: 'high', fmt: 'pct', value: (t) => pkPct(t.r), player: 'pktoi' },
  { key: 'fo', label: 'Faceoff win %', short: 'FO%', desc: 'Share of faceoffs won.', better: 'high', fmt: 'pct', value: (t) => (t.r.fow + t.r.fol ? t.r.fow / (t.r.fow + t.r.fol) : 0.5), player: 'fopct' },
  { key: 'hits', label: 'Hits per game', short: 'HIT/G', desc: 'Body checks per game.', better: 'high', fmt: 'num1', value: (t) => pg(t.r.hits, t.gp), player: 'hits60' },
  { key: 'blk', label: 'Blocked shots per game', short: 'BLK/G', desc: 'Shots blocked per game.', better: 'high', fmt: 'num1', value: (t) => pg(t.r.blocks, t.gp), player: 'blk60' },
  { key: 'tk', label: 'Takeaways per game', short: 'TK/G', desc: 'Pucks stolen per game.', better: 'high', fmt: 'num1', value: (t) => pg(t.skaters.tk, t.gp), player: 'tk60' },
  { key: 'gv', label: 'Giveaways per game', short: 'GV/G', desc: 'Pucks given away per game (lower is better).', better: 'low', fmt: 'num1', value: (t) => pg(t.skaters.gv, t.gp), player: 'gv60' },
  { key: 'pim', label: 'Penalty minutes per game', short: 'PIM/G', desc: 'Penalty minutes per game (lower is better).', better: 'low', fmt: 'num1', value: (t) => pg(t.r.pim, t.gp), player: 'pim60' },
];

export const teamMetric = (key: string) => TEAM_METRICS.find((m) => m.key === key);

/** This regular season's player lines (falls back to last season's when no games have been played yet). */
export function seasonRows(league: League): { rows: PlayerRow[]; season: number } {
  const live = Object.entries(league.seasonStats).filter(([, e]) => e.reg.gp > 0);
  if (live.length) {
    return {
      season: league.season,
      rows: live.map(([id, e]) => ({ p: league.players[Number(id)], s: e.reg, teamId: e.teamId })).filter((r) => !!r.p),
    };
  }
  const last = league.history.at(-1)?.season ?? league.season - 1;
  const rows: PlayerRow[] = [];
  for (const p of Object.values(league.players)) {
    const lines = p.career.filter((c) => c.season === last && !c.playoffs);
    if (!lines.length) continue;
    const s = emptyStatLine();
    for (const c of lines) addStatLine(s, c.stats);
    rows.push({ p, s, teamId: lines.at(-1)!.teamId });
  }
  return { season: last, rows };
}

export function teamTotals(league: League, rows: PlayerRow[]): TeamTotals[] {
  return league.teams.map((t) => {
    const skaters = emptyStatLine();
    const goalies = emptyStatLine();
    for (const r of rows) if (r.teamId === t.id) addStatLine(r.p.pos === 'G' ? goalies : skaters, r.s);
    const r = league.standings[t.id];
    return { teamId: t.id, gp: r?.gp ?? 0, r, skaters, goalies };
  });
}

/** 1-based league rank of `value` among `all` (1 = best for the metric's direction). */
export function rankOf(value: number, all: number[], better: Better): number {
  return 1 + all.filter((v) => (better === 'high' ? v > value + 1e-9 : v < value - 1e-9)).length;
}

/** Percentile (0–100, 100 = best) of `value` among `all`. */
export function percentileOf(value: number, all: number[], better: Better): number {
  if (all.length <= 1) return 50;
  const worse = all.filter((v) => (better === 'high' ? v < value - 1e-9 : v > value + 1e-9)).length;
  return Math.round((worse / (all.length - 1)) * 100);
}

/** Players who qualify for a metric, best first. `pos` filters forwards/defence. */
export function leaders(rows: PlayerRow[], m: PlayerMetric, opts: { pos?: 'F' | 'D' | 'all'; excludeTeam?: number } = {}): { row: PlayerRow; value: number }[] {
  return rows
    .filter((r) => (m.group === 'goalie' ? r.p.pos === 'G' : r.p.pos !== 'G'))
    .filter((r) => !opts.pos || opts.pos === 'all' || (opts.pos === 'D' ? r.p.pos === 'D' : r.p.pos !== 'D'))
    .filter((r) => opts.excludeTeam === undefined || r.teamId !== opts.excludeTeam)
    .filter((r) => m.qualifies(r.s))
    .map((row) => ({ row, value: m.value(row.s) }))
    .sort((a, b) => (m.better === 'high' ? b.value - a.value : a.value - b.value));
}
