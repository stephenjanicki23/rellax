import { useMemo } from 'react';
import { useGame, mutate, toast } from '../store';
import { Card } from '../components/common';
import { playersOf } from '../../engine/league/helpers';
import { autoLines, defenseScore, offenseScore } from '../../engine/team/lines';
import { lineChemistry } from '../../engine/team/chemistry';
import { estimate } from '../../engine/economy/scouting';
import type { Lines, Player } from '../../engine/types';
import { ARCHETYPES } from '../../engine/player/archetypes';
import { href } from '../router';

type Group = 'fwd' | 'def' | 'goalies' | 'pp' | 'pk';

export function LinesPage() {
  const { league, version } = useGame();
  const team = league.teams[league.userTeamId];
  const roster = useMemo(() => playersOf(league, team.id).sort((a, b) => b.ca - a.ca), [league, version, team.id]);
  const byId = new Map(roster.map((p) => [p.id, p]));
  const L = team.lines;

  const setSlot = (group: Group, unit: number, slot: number, id: number) => {
    mutate((l) => {
      const t = l.teams[l.userTeamId];
      const lines: Lines = structuredClone(t.lines);
      const target = group === 'goalies' ? lines.goalies : lines[group][unit];
      const prev = target[slot];
      // Swap if the player already occupies another even-strength slot.
      if (group === 'fwd' || group === 'def' || group === 'goalies') {
        const groups: number[][] = group === 'goalies' ? [lines.goalies] : [...lines.fwd, ...lines.def];
        for (const g of groups) {
          const i = g.indexOf(id);
          if (i >= 0 && !(g === target && i === slot)) g[i] = prev;
        }
      } else {
        const i = target.indexOf(id);
        if (i >= 0) target[i] = prev;
      }
      target[slot] = id;
      t.lines = lines;
      t.autoLines = false;
    });
  };

  const select = (group: Group, unit: number, slot: number, current: number | undefined, filter: (p: Player) => boolean) => (
    <select value={current ?? ''} onChange={(e) => setSlot(group, unit, slot, Number(e.target.value))} style={{ width: '100%' }}>
      {current === undefined && <option value="">—</option>}
      {roster.filter((p) => filter(p) || p.id === current).map((p) => (
        <option key={p.id} value={p.id} disabled={!!p.injury && p.id !== current}>
          {p.pos} {p.last} ({Math.round(estimate(league, p).ca)}){p.injury ? ' — INJ' : ''}
        </option>
      ))}
    </select>
  );

  const chem = (ids: number[]) => {
    const ps = ids.map((id) => byId.get(id)).filter((p): p is Player => !!p);
    const c = lineChemistry(ps, league.chemistry, team.morale);
    const cls = c > 0.25 ? 'good' : c > 0.05 ? 'muted' : c > -0.1 ? 'warn' : 'bad';
    return <span className={cls} title="Chemistry: style fit, handedness, personality, passing and time together">⚡ {c > 0 ? '+' : ''}{(c * 100).toFixed(0)}</span>;
  };
  const sk = (p: Player) => p.pos !== 'G';
  const fw = (p: Player) => p.pos === 'C' || p.pos === 'LW' || p.pos === 'RW';
  const unitScore = (ids: number[], f: (p: Player) => number) => {
    const ps = ids.map((id) => byId.get(id)).filter((p): p is Player => !!p);
    return ps.length ? Math.round(ps.reduce((s, p) => s + f(p), 0) / ps.length) : 0;
  };

  return (
    <>
      <div className="page-head">
        <h1>Lines</h1>
        <span className="sub">Line 1 plays the most even-strength minutes; the coach shortens the bench when trailing late.</span>
        <div className="actions">
          <label className="row muted">
            <input
              type="checkbox"
              checked={team.autoLines}
              onChange={(e) => mutate((l) => (l.teams[l.userTeamId].autoLines = e.target.checked))}
            />
            Coach sets lines automatically
          </label>
          <button
            className="btn primary"
            onClick={() => {
              mutate((l) => {
                const t = l.teams[l.userTeamId];
                t.lines = autoLines(playersOf(l, t.id));
              });
              toast('Lines optimised by your coaching staff.', 'good');
            }}
          >
            Auto-generate
          </button>
        </div>
      </div>
      <div className="grid g2">
        <Card title="Forward lines" className="span-all">
          <table className="tbl">
            <thead>
              <tr>
                <th></th>
                <th>LW</th>
                <th>C</th>
                <th>RW</th>
                <th className="num">Off</th>
                <th className="num">Chem</th>
              </tr>
            </thead>
            <tbody>
              {[0, 1, 2, 3].map((i) => (
                <tr key={i}>
                  <td className="muted">L{i + 1}</td>
                  {[0, 1, 2].map((s) => (
                    <td key={s} style={{ minWidth: 170 }}>
                      {select('fwd', i, s, L.fwd[i]?.[s], fw)}
                    </td>
                  ))}
                  <td className="num">{unitScore(L.fwd[i] ?? [], offenseScore)}</td>
                  <td className="num">{chem(L.fwd[i] ?? [])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <div className="grid">
          <Card title="Defense pairings">
            <table className="tbl">
              <thead>
                <tr>
                  <th></th>
                  <th>LD</th>
                  <th>RD</th>
                  <th className="num">Def</th>
                  <th className="num">Chem</th>
                </tr>
              </thead>
              <tbody>
                {[0, 1, 2].map((i) => (
                  <tr key={i}>
                    <td className="muted">P{i + 1}</td>
                    {[0, 1].map((s) => (
                      <td key={s} style={{ minWidth: 140 }}>
                        {select('def', i, s, L.def[i]?.[s], (p) => p.pos === 'D')}
                      </td>
                    ))}
                    <td className="num">{unitScore(L.def[i] ?? [], defenseScore)}</td>
                    <td className="num">{chem(L.def[i] ?? [])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="Goaltenders">
            <div className="grid g2">
              <label className="field">
                Starter
                {select('goalies', 0, 0, L.goalies[0], (p) => p.pos === 'G')}
              </label>
              <label className="field">
                Backup
                {select('goalies', 0, 1, L.goalies[1], (p) => p.pos === 'G')}
              </label>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              The backup starts most back-to-backs and when the starter is worn down.
            </div>
          </Card>
        </div>
        <Card title="Power play">
          {[0, 1].map((u) => (
            <div key={u} style={{ marginBottom: 10 }}>
              <div className="row muted" style={{ marginBottom: 4 }}>
                PP{u + 1} <span style={{ marginLeft: 'auto' }}>Off {unitScore(L.pp[u] ?? [], offenseScore)} · {chem(L.pp[u] ?? [])}</span>
              </div>
              <div className="grid g3">
                {[0, 1, 2, 3, 4].map((s) => (
                  <div key={s}>{select('pp', u, s, L.pp[u]?.[s], sk)}</div>
                ))}
              </div>
            </div>
          ))}
        </Card>
        <Card title="Penalty kill">
          {[0, 1].map((u) => (
            <div key={u} style={{ marginBottom: 10 }}>
              <div className="row muted" style={{ marginBottom: 4 }}>
                PK{u + 1} <span style={{ marginLeft: 'auto' }}>Def {unitScore(L.pk[u] ?? [], defenseScore)} · {chem(L.pk[u] ?? [])}</span>
              </div>
              <div className="grid g2">
                {[0, 1, 2, 3].map((s) => (
                  <div key={s}>{select('pk', u, s, L.pk[u]?.[s], sk)}</div>
                ))}
              </div>
            </div>
          ))}
          <div className="muted" style={{ fontSize: 12 }}>
            Tactics for both units are set on the <a href={href('tactics')}>Tactics</a> page.
          </div>
        </Card>
      </div>
      <Card title="Scratches" className="" right={<span className="muted">Healthy players not in the lineup</span>}>
        <div className="row">
          {roster
            .filter((p) => !L.fwd.flat().includes(p.id) && !L.def.flat().includes(p.id) && !L.goalies.includes(p.id))
            .map((p) => (
              <span key={p.id} className="pill" title={ARCHETYPES[p.archetype].label}>
                {p.pos} {p.last} {p.injury ? '(INJ)' : ''}
              </span>
            ))}
        </div>
      </Card>
    </>
  );
}
