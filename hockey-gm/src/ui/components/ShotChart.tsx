import { useMemo, useState } from 'react';
import type { League, Player } from '../../engine/types';
import { ANGLE_BANDS, DIST_BANDS, ZONE_COUNT, ZONE_NAMES, zoneBounds } from '../../engine/core/shotZones';
import { Card, Seg } from './common';
import { seasonLabel } from '../format';

const GL = 11; // goal line, feet from the end boards
const pt = (d: number, aDeg: number, side: 1 | -1) => {
  const a = (aDeg * Math.PI) / 180;
  return { x: side * d * Math.sin(a), y: GL + d * Math.cos(a) };
};

/** An annular sector of the zone, on one side of the ice. */
function sector(z: number, side: 1 | -1): string {
  const [d0, d1, a0, a1] = zoneBounds(z);
  const sweepOut = side > 0 ? 0 : 1;
  const sweepIn = side > 0 ? 1 : 0;
  const p1 = pt(d0, a0, side);
  const p2 = pt(d1, a0, side);
  const p3 = pt(d1, a1, side);
  const p4 = pt(d0, a1, side);
  const f = (n: number) => n.toFixed(2);
  return `M${f(p1.x)} ${f(p1.y)} L${f(p2.x)} ${f(p2.y)} A${d1} ${d1} 0 0 ${sweepOut} ${f(p3.x)} ${f(p3.y)} L${f(p4.x)} ${f(p4.y)}${d0 > 0 ? ` A${d0} ${d0} 0 0 ${sweepIn} ${f(p1.x)} ${f(p1.y)}` : ''} Z`;
}

/** League-wide shots and goals per zone (for "better than average" call-outs). */
function leagueZones(charts: Record<number, number[]> | undefined): { sog: number[]; goals: number[] } {
  const sog = new Array(ZONE_COUNT).fill(0);
  const goals = new Array(ZONE_COUNT).fill(0);
  for (const z of Object.values(charts ?? {})) for (let i = 0; i < ZONE_COUNT; i++) {
    sog[i] += z[i];
    goals[i] += z[ZONE_COUNT + i];
  }
  return { sog, goals };
}

/** A player's shot chart: shots on goal and goals by zone, shaded by volume. */
export function ShotChart({ league, p, compact = false }: { league: League; p: Player; compact?: boolean }) {
  const cur = league.shotCharts?.season === league.season ? league.shotCharts : undefined;
  const prev = league.shotChartsPrev ?? (league.shotCharts && league.shotCharts.season !== league.season ? league.shotCharts : undefined);
  const hasCur = !!cur?.players[p.id];
  const [which, setWhich] = useState<'cur' | 'prev'>(hasCur || !prev?.players[p.id] ? 'cur' : 'prev');
  const src = which === 'cur' ? cur : prev;
  const data = src?.players[p.id];
  const lg = useMemo(() => leagueZones(src?.players), [src]);
  const sog = data ? data.slice(0, ZONE_COUNT) : new Array(ZONE_COUNT).fill(0);
  const goals = data ? data.slice(ZONE_COUNT) : new Array(ZONE_COUNT).fill(0);
  const total = sog.reduce((a, b) => a + b, 0);
  const totalG = goals.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...sog);
  // Zones where he finishes clearly better than the league (at least 10 shots).
  const hot = sog
    .map((s, z) => ({ z, s, g: goals[z], sh: s ? goals[z] / s : 0, lg: lg.sog[z] ? lg.goals[z] / lg.sog[z] : 0 }))
    .filter((x) => x.s >= 10)
    .sort((a, b) => b.sh - b.lg - (a.sh - a.lg));
  const right = (
    prev?.players[p.id] && cur ? (
      <Seg value={which} onChange={setWhich} options={[{ id: 'cur', label: seasonLabel(cur.season) }, { id: 'prev', label: seasonLabel(prev.season) }]} />
    ) : src ? (
      <span className="muted" style={{ fontSize: 12 }}>{seasonLabel(src.season)}</span>
    ) : null
  );
  return (
    <Card title="Shot chart" right={right}>
      {p.pos === 'G' ? (
        <div className="muted">Shot charts are kept for shooters.</div>
      ) : !total ? (
        <div className="muted">No shots on goal recorded yet{src ? ` in ${seasonLabel(src.season)}` : ''}.</div>
      ) : (
        <div className={compact ? 'stack' : 'shot-chart-wrap'} style={{ gap: 12 }}>
          <svg className="shot-chart" viewBox="-44 -2 88 79" role="img" aria-label={`Shot chart: ${totalG} goals on ${total} shots`}>
            <defs>
              <clipPath id={`oz-${p.id}`}>
                <path d="M-42.5 75 L-42.5 28 A28 28 0 0 1 -14.5 0 L14.5 0 A28 28 0 0 1 42.5 28 L42.5 75 Z" />
              </clipPath>
            </defs>
            <path d="M-42.5 75 L-42.5 28 A28 28 0 0 1 -14.5 0 L14.5 0 A28 28 0 0 1 42.5 28 L42.5 75 Z" className="sc-ice" />
            <g clipPath={`url(#oz-${p.id})`}>
              {Array.from({ length: ZONE_COUNT }, (_, z) => {
                const op = sog[z] ? 0.1 + 0.7 * (sog[z] / max) : 0;
                return ([1, -1] as const).map((side) => <path key={`${z}${side}`} d={sector(z, side)} className="sc-zone" style={{ fillOpacity: op }}><title>{`${ZONE_NAMES(z)}: ${goals[z]} goals on ${sog[z]} shots`}</title></path>);
              })}
              {/* Rink markings */}
              <line x1="-42.5" x2="42.5" y1={GL} y2={GL} className="sc-red" />
              <line x1="-42.5" x2="42.5" y1="75" y2="75" className="sc-blue" />
              {[-22, 22].map((x) => (
                <g key={x}>
                  <circle cx={x} cy={GL + 20} r="15" className="sc-circle" />
                  <circle cx={x} cy={GL + 20} r="0.9" className="sc-dot" />
                </g>
              ))}
              <path d={`M-4 ${GL} L-4 ${GL + 4.5} A4 4 0 0 0 4 ${GL + 4.5} L4 ${GL} Z`} className="sc-crease" />
              <rect x="-3" y={GL - 3.3} width="6" height="3.3" rx="1" className="sc-net" />
              {/* Band edges */}
              {DIST_BANDS.slice(0, -1).map((d) => (
                <path key={d} d={`M${-d} ${GL} A${d} ${d} 0 0 0 ${d} ${GL}`} className="sc-band" />
              ))}
              {ANGLE_BANDS.slice(0, -1).map((a) => ([1, -1] as const).map((side) => { const q = pt(75, a, side); return <line key={`${a}${side}`} x1="0" y1={GL} x2={q.x} y2={q.y} className="sc-band" />; }))}
              {/* Goals / shots per zone (right side; the left mirrors it) */}
              {/* The closest band is too small to label per angle: one figure for everything in tight. */}
              {(() => {
                const inner = Array.from({ length: ANGLE_BANDS.length }, (_, a) => a);
                const s0 = inner.reduce((t, z) => t + sog[z], 0);
                const g0 = inner.reduce((t, z) => t + goals[z], 0);
                return s0 ? (
                  <text x="0" y={GL + 8.6} className="sc-num" textAnchor="middle">
                    {g0}/{s0}
                  </text>
                ) : null;
              })()}
              {Array.from({ length: ZONE_COUNT }, (_, z) => {
                if (!sog[z] || z < ANGLE_BANDS.length) return null;
                const [d0, d1, a0, a1] = zoneBounds(z);
                const c = pt(d1 >= 75 ? 54 : (d0 + d1) / 2, a1 > 40 ? 62 : (a0 + a1) / 2, 1);
                if (c.y > 74 || c.x > 41) return null;
                return (
                  <text key={z} x={c.x} y={c.y + 1} className="sc-num" textAnchor="middle">
                    {goals[z]}/{sog[z]}
                  </text>
                );
              })}
            </g>
          </svg>
          <div className="stack" style={{ gap: 6, minWidth: 0 }}>
            <div className="row" style={{ gap: 14 }}>
              <span><b>{totalG}</b> <span className="muted">goals</span></span>
              <span><b>{total}</b> <span className="muted">shots on goal</span></span>
              <span><b>{((totalG / total) * 100).toFixed(1)}%</b> <span className="muted">SH%</span></span>
            </div>
            {!compact &&
              hot.slice(0, 3).map((x) => (
                <span key={x.z} style={{ fontSize: 12 }}>
                  <span className={x.sh > x.lg ? 'txt-good' : 'txt-bad'}>{x.sh > x.lg ? 'Hot' : 'Cold'}:</span> {ZONE_NAMES(x.z)} — {x.g}/{x.s} ({(x.sh * 100).toFixed(0)}% vs league {(x.lg * 100).toFixed(0)}%)
                </span>
              ))}
            <span className="dim" style={{ fontSize: 11 }}>
              Shading: shots on goal. Numbers: goals/shots. The sim records each shot's distance and angle but not which side it came from, so both sides show the same zone.
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}
