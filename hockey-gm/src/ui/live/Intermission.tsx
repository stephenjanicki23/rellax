import { useMemo, type ReactNode } from 'react';
import type { GameEvent, GameSnapshot } from '../../engine/sim/gameTypes';
import type { Team } from '../../engine/types';
import { clockLabel, periodLabel } from '../../engine/sim/commentary';
import type { RinkPlayer } from '../rink/director';
import { TeamLogo } from '../components/common';

interface Line {
  id: number;
  team: 0 | 1;
  g: number;
  a: number;
  sog: number;
  hits: number;
  blocks: number;
  saves: number;
  ga: number;
}

/** An engine event with who was in goal at the time. */
export interface ShownEvent {
  e: GameEvent;
  ice: { goalies: [number | null, number | null] };
}

/** Player lines from the events shown so far (exactly what the viewer has seen). */
function linesFrom(items: ShownEvent[], players: Map<number, RinkPlayer>): Line[] {
  const m = new Map<number, Line>();
  const get = (id: number | null | undefined) => {
    if (id === undefined || id === null) return null;
    const p = players.get(id);
    if (!p) return null;
    let l = m.get(id);
    if (!l) m.set(id, (l = { id, team: p.team, g: 0, a: 0, sog: 0, hits: 0, blocks: 0, saves: 0, ga: 0 }));
    return l;
  };
  for (const { e, ice } of items) {
    switch (e.type) {
      case 'goal': {
        const s = get(e.p1);
        if (s) s.g++;
        for (const a of [e.p2, e.p3]) {
          const l = get(a);
          if (l) l.a++;
        }
        const g = get(ice.goalies[1 - e.team]);
        if (g) g.ga++;
        break;
      }
      case 'shot': {
        const l = get(e.p1);
        if (l) l.sog++;
        break;
      }
      case 'save': {
        const l = get(e.p1);
        if (l) l.saves++;
        break;
      }
      case 'hit': {
        const l = get(e.p1);
        if (l) l.hits++;
        break;
      }
      case 'blocked': {
        const l = get(e.p1);
        if (l) l.blocks++;
        break;
      }
    }
  }
  return [...m.values()];
}

const starScore = (l: Line) => l.g * 3 + l.a * 1.8 + l.sog * 0.15 + l.hits * 0.05 + l.blocks * 0.1 + l.saves * 0.1 - l.ga * 0.6;

/**
 * Between-periods report (and the final report): score, shots and goals by
 * period, the period's goals, the stars so far and the key team numbers.
 */
export function Intermission({
  title,
  period,
  snap,
  items,
  home,
  away,
  players,
  playoff,
  stars,
  onContinue,
  continueLabel,
  skip,
  onSkip,
  extra,
}: {
  title: string;
  /** Period that just ended. */
  period: number;
  snap: GameSnapshot;
  items: ShownEvent[];
  home: Team;
  away: Team;
  players: Map<number, RinkPlayer>;
  playoff: boolean;
  /** Official three stars (final report); otherwise computed from the play so far. */
  stars?: number[];
  onContinue: () => void;
  continueLabel: string;
  skip?: boolean;
  onSkip?: (v: boolean) => void;
  /** Extra buttons (e.g. close the final report). */
  extra?: ReactNode;
}) {
  const teams = [home, away] as const;
  const lines = useMemo(() => linesFrom(items, players), [items, players]);
  const best = useMemo(() => {
    if (stars?.length) return stars.map((id) => lines.find((l) => l.id === id) ?? { id, team: players.get(id)?.team ?? 0, g: 0, a: 0, sog: 0, hits: 0, blocks: 0, saves: 0, ga: 0 });
    return [...lines].sort((a, b) => starScore(b) - starScore(a)).slice(0, 3);
  }, [lines, stars, players]);
  const periods = Math.max(3, period);
  const cols = Array.from({ length: Math.min(periods, 4) }, (_, i) => i);
  const byPeriod = (team: 0 | 1, k: 'shotsByPeriod' | 'goalsByPeriod', i: number) => snap.teamStats[team][k][i] ?? 0;
  const periodGoals = items.map((x) => x.e).filter((e) => e.type === 'goal' && e.period === period);
  const name = (id?: number) => {
    const p = id !== undefined ? players.get(id) : undefined;
    return p ? `${p.first?.[0] ?? ''}. ${p.last ?? ''}` : '';
  };
  const [h, a] = snap.teamStats;
  const pct = (x: number, y: number) => (x + y ? Math.round((x / (x + y)) * 100) : 50);
  return (
    <div className="intermission" role="dialog" aria-label={title}>
      <div className="im-card">
        <div className="im-head">
          <span className="im-title">{title}</span>
        </div>
        <div className="im-score">
          {teams.map((t, i) => (
            <div key={t.abbr} className="im-team">
              <TeamLogo team={t} size={40} />
              <b>{t.abbr}</b>
              <span className="im-goals">{snap.score[i]}</span>
            </div>
          ))}
        </div>
        <table className="im-table">
          <thead>
            <tr>
              <th />
              {cols.map((i) => (
                <th key={i}>{periodLabel(i + 1, playoff)}</th>
              ))}
              <th>T</th>
            </tr>
          </thead>
          <tbody>
            {(['goalsByPeriod', 'shotsByPeriod'] as const).map((k) =>
              teams.map((t, ti) => (
                <tr key={`${k}${t.abbr}`} className={ti === 0 ? 'im-sep' : ''}>
                  <td>
                    {t.abbr} <span className="muted">{k === 'goalsByPeriod' ? 'goals' : 'shots'}</span>
                  </td>
                  {cols.map((i) => (
                    <td key={i} className={i + 1 > period ? 'dim' : ''}>
                      {i + 1 > period ? '–' : byPeriod(ti as 0 | 1, k, i)}
                    </td>
                  ))}
                  <td>
                    <b>{k === 'goalsByPeriod' ? snap.score[ti] : snap.teamStats[ti].shots}</b>
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
        <div className="im-grid">
          <div>
            <h4>{periodLabel(period, playoff)} period goals</h4>
            {periodGoals.length ? (
              periodGoals.map((g, i) => (
                <div key={i} className="im-goal">
                  <span className="dim">{clockLabel(g.clock, snap.periodLength)}</span>
                  <b>{teams[g.team].abbr}</b>
                  <span>
                    {name(g.p1)}
                    {g.p2 !== undefined && <span className="muted"> ({[name(g.p2), name(g.p3)].filter(Boolean).join(', ')})</span>}
                    {g.data?.strength && g.data.strength !== 'EV' && <span className="pill">{g.data.strength}</span>}
                  </span>
                </div>
              ))
            ) : (
              <div className="muted">No scoring.</div>
            )}
          </div>
          <div>
            <h4>{stars?.length ? 'Three stars' : 'Stars so far'}</h4>
            {best.map((l, i) => (
              <div key={l.id} className="im-star">
                <span className="im-rank">{'★'.repeat(3 - i)}</span>
                <b>{name(l.id)}</b>
                <span className="muted">{teams[l.team].abbr}</span>
                <span className="muted" style={{ marginLeft: 'auto' }}>
                  {players.get(l.id)?.pos === 'G' ? `${l.saves} saves` : `${l.g}G ${l.a}A · ${l.sog} SOG`}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="im-stats">
          <span>
            Faceoffs <b>{pct(h.fow, h.fol)}%</b> – <b>{pct(a.fow, a.fol)}%</b>
          </span>
          <span>
            Hits <b>{h.hits}</b> – <b>{a.hits}</b>
          </span>
          <span>
            Power play <b>{h.ppg}/{h.ppOpp}</b> – <b>{a.ppg}/{a.ppOpp}</b>
          </span>
          <span>
            xG <b>{h.xg.toFixed(2)}</b> – <b>{a.xg.toFixed(2)}</b>
          </span>
        </div>
        <div className="im-actions">
          {onSkip && (
            <label className="muted" style={{ fontSize: 12 }}>
              <input type="checkbox" checked={!!skip} onChange={(e) => onSkip(e.target.checked)} /> Skip intermission reports
            </label>
          )}
          {extra}
          <button className="btn primary" onClick={onContinue}>
            {continueLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
