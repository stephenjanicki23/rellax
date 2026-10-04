import type { League, Player } from '../types';
import { isForward } from '../player/ability';

export interface TeamStrength {
  overall: number;
  forwards: number;
  defense: number;
  goalie: number;
  depth: number;
  top: number;
}

const healthy = (p: Player) => !p.injury || p.injury.daysRemaining <= 7;

function weightedTop(values: number[], weights: number[]): number {
  let s = 0;
  let w = 0;
  for (let i = 0; i < weights.length; i++) {
    const v = values[i] ?? 95;
    s += v * weights[i];
    w += weights[i];
  }
  return s / w;
}

/** Roster strength on the CA scale, weighting top-of-lineup players more. */
export function strengthOf(players: Player[], includeInjured = false): TeamStrength {
  const pool = players.filter((p) => p.status === 'active' && (includeInjured || healthy(p)));
  const f = pool.filter((p) => isForward(p.pos)).map((p) => p.ca).sort((a, b) => b - a);
  const d = pool.filter((p) => p.pos === 'D').map((p) => p.ca).sort((a, b) => b - a);
  const g = pool.filter((p) => p.pos === 'G').map((p) => p.ca).sort((a, b) => b - a);
  const forwards = weightedTop(f, [1.4, 1.4, 1.4, 1.15, 1.15, 1.15, 0.9, 0.9, 0.9, 0.6, 0.6, 0.6]);
  const defense = weightedTop(d, [1.4, 1.4, 1.1, 1.1, 0.8, 0.8]);
  const goalie = weightedTop(g, [1, 0.15]);
  const depth = weightedTop(f.slice(6), [1, 1, 1, 1, 1, 1]) * 0.6 + weightedTop(d.slice(4), [1, 1]) * 0.4;
  const top = weightedTop(f, [1, 1, 1]) * 0.6 + weightedTop(d, [1, 1]) * 0.4;
  // Weights follow what the game engine actually rewards: a regression of
  // simulated standings points on these components gave roughly 3.2 : 1.0 : 0.8
  // per rating point (forwards : defence : goalie). Goalie ratings spread far
  // wider than lineup averages, so a small weight still makes the crease matter.
  const overall = forwards * 0.62 + defense * 0.2 + goalie * 0.18;
  return { overall, forwards, defense, goalie, depth, top };
}

export function teamStrength(league: League, teamId: number, includeInjured = false): TeamStrength {
  const roster = Object.values(league.players).filter((p) => p.teamId === teamId && p.status === 'active');
  return strengthOf(roster, includeInjured);
}

/** Projected standings points from roster strength (used for expectations and AI). */
export function projectedPoints(league: League, teamId: number): number {
  const all = league.teams.map((t) => teamStrength(league, t.id, true).overall);
  const avg = all.reduce((a, b) => a + b, 0) / all.length;
  const mine = teamStrength(league, teamId, true).overall;
  // ~5 points per unit in simulated seasons; regressed toward the mean as real projections are.
  return Math.round(92 + (mine - avg) * 4);
}

export function powerRankings(league: League): { teamId: number; score: number }[] {
  return league.teams
    .map((t) => {
      const r = league.standings[t.id];
      const s = teamStrength(league, t.id).overall;
      const pct = r && r.gp ? (r.w * 2 + r.otl) / (r.gp * 2) : 0.5;
      const xg = r && r.xgf + r.xga > 0 ? r.xgf / (r.xgf + r.xga) : 0.5;
      const weight = r ? Math.min(1, r.gp / 40) : 0;
      return { teamId: t.id, score: (1 - weight) * (s - 120) + weight * ((pct - 0.5) * 60 + (xg - 0.5) * 50) };
    })
    .sort((a, b) => b.score - a.score);
}
