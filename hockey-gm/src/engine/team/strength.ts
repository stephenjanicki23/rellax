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
  const overall = forwards * 0.45 + defense * 0.3 + goalie * 0.25;
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
  return Math.round(92 + (mine - avg) * 3.2);
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
