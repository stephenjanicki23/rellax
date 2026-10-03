import { memo, useEffect, useRef, useState } from 'react';
import type { GameSnapshot } from '../../engine/sim/gameTypes';
import type { Team } from '../../engine/types';
import { teamBar } from '../teamColors';
import { clockLabel, periodLabel } from '../../engine/sim/commentary';
import type { RinkPlayer } from '../rink/director';
import type { FeedLine } from './LiveFeed';

type Tab = 'stats' | 'lines' | 'summary';

export interface GamePanelsProps {
  snap: GameSnapshot;
  home: Team;
  away: Team;
  players: Map<number, RinkPlayer>;
  lines: FeedLine[];
  playoff: boolean;
}

/** Collapsible stats / current lines / summary panel, all read from the engine snapshot and event feed. */
export const GamePanels = memo(function GamePanels({ snap: s, home, away, players, lines, playoff }: GamePanelsProps) {
  const [tab, setTab] = useState<Tab>('stats');
  const [open, setOpen] = useState(true);
  const teams = [home, away] as const;
  const choose = (t: Tab) => {
    if (t === tab) setOpen((o) => !o);
    else {
      setTab(t);
      setOpen(true);
    }
  };
  return (
    <div className="game-panels">
      <div className="gp-tabs" role="tablist">
        {(['stats', 'lines', 'summary'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t && open} className={tab === t && open ? 'on' : ''} onClick={() => choose(t)} title={tab === t && open ? 'Collapse' : undefined}>
            {t === 'stats' ? 'Stats' : t === 'lines' ? 'On ice' : 'Summary'}
          </button>
        ))}
        <button className="gp-collapse" onClick={() => setOpen((o) => !o)} aria-label={open ? 'Collapse panel' : 'Expand panel'}>
          {open ? '▾' : '▸'}
        </button>
      </div>
      {open && tab === 'stats' && <Stats s={s} teams={teams} />}
      {open && tab === 'lines' && <OnIce s={s} teams={teams} players={players} />}
      {open && tab === 'summary' && <Summary lines={lines} teams={teams} playoff={playoff} />}
    </div>
  );
});

function Stats({ s, teams }: { s: GameSnapshot; teams: readonly [Team, Team] }) {
  const [h, a] = s.teamStats;
  const pct = (x: number, y: number) => (x + y ? Math.round((x / (x + y)) * 100) : 50);
  const possH = pct(s.possTime[0], s.possTime[1]);
  const rows: [string, string | number, string | number, number, number][] = [
    ['Shots', h.shots, a.shots, h.shots, a.shots],
    ['Shot attempts', h.attempts, a.attempts, h.attempts, a.attempts],
    ['Expected goals', h.xg.toFixed(2), a.xg.toFixed(2), h.xg, a.xg],
    ['Hits', h.hits, a.hits, h.hits, a.hits],
    ['Faceoffs', `${pct(h.fow, h.fol)}%`, `${pct(a.fow, a.fol)}%`, h.fow, a.fow],
    ['Power play', `${h.ppg}/${h.ppOpp}`, `${a.ppg}/${a.ppOpp}`, h.ppg, a.ppg],
    ['PP %', h.ppOpp ? `${Math.round((h.ppg / h.ppOpp) * 100)}%` : '—', a.ppOpp ? `${Math.round((a.ppg / a.ppOpp) * 100)}%` : '—', h.ppOpp ? h.ppg / h.ppOpp : 0, a.ppOpp ? a.ppg / a.ppOpp : 0],
    ['Penalty minutes', h.pim, a.pim, h.pim, a.pim],
    ['Blocks', h.blocks, a.blocks, h.blocks, a.blocks],
    ['Takeaways', h.tk, a.tk, h.tk, a.tk],
    ['Giveaways', h.gv, a.gv, h.gv, a.gv],
    ['Possession', `${possH}%`, `${100 - possH}%`, possH, 100 - possH],
  ];
  return (
    <div className="gp-body gp-stats">
      <div className="gp-teams">
        <b style={{ borderColor: teamBar(teams[0].colors) }}>{teams[0].abbr}</b>
        <b style={{ borderColor: teamBar(teams[1].colors) }}>{teams[1].abbr}</b>
      </div>
      {rows.map(([k, av, bv, an, bn]) => {
        const tot = an + bn;
        const share = tot > 0 ? an / tot : 0.5;
        return (
          <div key={k} className="gp-row">
            <span className="v">{av}</span>
            <span className="k">
              {k}
              <i className="gp-bar">
                <i style={{ width: `${share * 100}%`, background: teamBar(teams[0].colors) }} />
                <i style={{ width: `${(1 - share) * 100}%`, background: teamBar(teams[1].colors) === teamBar(teams[0].colors) ? '#c9ced5' : teamBar(teams[1].colors) }} />
              </i>
            </span>
            <span className="v">{bv}</span>
          </div>
        );
      })}
    </div>
  );
}

function OnIce({ s, teams, players }: { s: GameSnapshot; teams: readonly [Team, Team]; players: Map<number, RinkPlayer> }) {
  // Flash a team's block when its five on the ice changes (line change).
  const prev = useRef<[string, string]>(['', '']);
  const [changed, setChanged] = useState<[number, number]>([0, 0]);
  const keys: [string, string] = [s.onIce[0].join(','), s.onIce[1].join(',')];
  useEffect(() => {
    const c: [number, number] = [...changed] as [number, number];
    let any = false;
    for (const t of [0, 1] as const) {
      if (prev.current[t] && prev.current[t] !== keys[t]) {
        c[t]++;
        any = true;
      }
    }
    prev.current = keys;
    if (any) setChanged(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys[0], keys[1]]);
  const [hs, as] = s.strength;
  return (
    <div className="gp-body gp-lines">
      {([0, 1] as const).map((t) => {
        const on = s.onIce[t].filter((id) => id !== s.goalies[t]).map((id) => players.get(id)).filter((p): p is RinkPlayer => !!p);
        const fwd = on.filter((p) => p.pos !== 'D');
        const def = on.filter((p) => p.pos === 'D');
        const g = s.goalies[t] !== null ? players.get(s.goalies[t]!) : undefined;
        const mine = t === 0 ? hs : as;
        const theirs = t === 0 ? as : hs;
        const unit = mine > theirs ? 'Power-play unit' : mine < theirs ? 'Penalty kill' : `Line ${s.lineIdx[t] + 1}`;
        const nm = (p: RinkPlayer) => (
          <span key={p.id} className="gp-pl" title={`${p.first ?? ''} ${p.last ?? ''}`}>
            <i className="gp-num">{p.number ?? ''}</i>
            {p.last}
            <i className="gp-en" style={{ width: `${s.energy[p.id] ?? 100}%`, background: (s.energy[p.id] ?? 100) < 50 ? 'var(--bad)' : (s.energy[p.id] ?? 100) < 70 ? 'var(--warn)' : 'var(--good)' }} />
          </span>
        );
        return (
          <div key={`${t}-${changed[t]}`} className={`gp-unit ${changed[t] ? 'changed' : ''}`} style={{ '--tc': teamBar(teams[t].colors) } as React.CSSProperties}>
            <div className="gp-unit-head">
              <b>{teams[t].abbr}</b> <span>{unit}</span>
              {changed[t] > 0 && <em className="gp-change">Line change</em>}
            </div>
            <div className="gp-line">{fwd.map(nm)}</div>
            <div className="gp-line">{def.map(nm)}</div>
            <div className="gp-line g">{g ? nm(g) : <span className="gp-pl en">Empty net</span>}</div>
          </div>
        );
      })}
    </div>
  );
}

function Summary({ lines, teams, playoff }: { lines: FeedLine[]; teams: readonly [Team, Team]; playoff: boolean }) {
  const goals = lines.filter((l) => l.kind === 'goal' && l.text.startsWith('GOAL')).reverse();
  const pens = lines.filter((l) => l.kind === 'penalty').reverse();
  const row = (l: FeedLine, strip: RegExp) => (
    <div key={l.uid} className="gp-sum" style={{ '--tc': teamBar(teams[l.team].colors) } as React.CSSProperties}>
      <span className="t">
        {periodLabel(l.period, playoff)} {clockLabel(l.clock, l.period > 3 && !playoff ? 300 : 1200)}
      </span>
      <b>{teams[l.team].abbr}</b> {l.text.replace(strip, '')}
    </div>
  );
  return (
    <div className="gp-body gp-summary">
      <h4>Scoring</h4>
      {goals.length ? goals.map((g) => row(g, /^GOAL! /)) : <div className="gp-none">No goals yet.</div>}
      <h4>Penalties</h4>
      {pens.length ? pens.map((p) => row(p, /^PENALTY: /)) : <div className="gp-none">None.</div>}
    </div>
  );
}
