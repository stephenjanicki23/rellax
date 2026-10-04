import type { League, TeamRecord } from '../../engine/types';
import { ppPct, pkPct } from '../../engine/league/standings';

interface Metric {
  key: string;
  label: string;
  value: (r: TeamRecord) => number;
  fmt: (v: number) => string;
  /** Totals line under the value. */
  sub: (r: TeamRecord) => string;
  /** Lower is better (goals against, shots against, penalties). */
  low?: boolean;
}

export const RANK_METRICS: Metric[] = [
  { key: 'gf', label: 'Goals for', value: (r) => r.gf / r.gp, fmt: (v) => v.toFixed(2), sub: (r) => `${r.gf} total · per game` },
  { key: 'ga', label: 'Goals against', value: (r) => r.ga / r.gp, fmt: (v) => v.toFixed(2), sub: (r) => `${r.ga} total · per game`, low: true },
  { key: 'pp', label: 'Power play', value: ppPct, fmt: (v) => `${(v * 100).toFixed(1)}%`, sub: (r) => `${r.ppg} for ${r.ppOpp}` },
  { key: 'pk', label: 'Penalty kill', value: pkPct, fmt: (v) => `${(v * 100).toFixed(1)}%`, sub: (r) => `${r.tsh - r.ppga} of ${r.tsh} killed` },
  { key: 'sf', label: 'Shots for', value: (r) => r.sf / r.gp, fmt: (v) => v.toFixed(1), sub: () => 'per game' },
  { key: 'sa', label: 'Shots against', value: (r) => r.sa / r.gp, fmt: (v) => v.toFixed(1), sub: () => 'per game', low: true },
  { key: 'pim', label: 'Penalty minutes', value: (r) => r.pim / r.gp, fmt: (v) => v.toFixed(1), sub: () => 'per game', low: true },
];

export function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** League rank (1 = best) of a team for one metric among teams that have played. */
export function metricRank(league: League, teamId: number, m: Metric): { rank: number; of: number } | null {
  const mine = league.standings[teamId];
  if (!mine?.gp) return null;
  const all = league.teams.map((t) => league.standings[t.id]).filter((r): r is TeamRecord => !!r?.gp);
  const v = m.value(mine);
  const better = all.filter((r) => (m.low ? m.value(r) < v : m.value(r) > v)).length;
  return { rank: better + 1, of: all.length };
}

function rankClass(rank: number, of: number): string {
  if (rank <= Math.ceil(of / 4)) return 'good';
  if (rank > of - Math.ceil(of / 4)) return 'bad';
  return '';
}

/** Team stat tiles, each with its league rank (top quarter green, bottom quarter red). */
export function TeamRankTiles({ league, teamId, keys }: { league: League; teamId: number; keys?: string[] }) {
  const r = league.standings[teamId];
  const metrics = keys ? RANK_METRICS.filter((m) => keys.includes(m.key)) : RANK_METRICS;
  return (
    <div className="rank-tiles">
      {metrics.map((m) => {
        const rk = metricRank(league, teamId, m);
        return (
          <div key={m.key} className="rank-tile">
            <div className="k">{m.label}</div>
            <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
              <span className="v">{r?.gp ? m.fmt(m.value(r)) : '—'}</span>
              {rk && (
                <span className={`pill ${rankClass(rk.rank, rk.of)}`} title={`${ordinal(rk.rank)} of ${rk.of} teams`}>
                  {ordinal(rk.rank)}
                </span>
              )}
            </div>
            <div className="sub">{r?.gp ? m.sub(r) : 'No games yet'}</div>
          </div>
        );
      })}
    </div>
  );
}
