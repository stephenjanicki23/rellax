import { useMemo, useState } from 'react';
import type { Lines, Player } from '../../engine/types';
import { useGame, mutate, toast } from '../store';
import { Card, PlayerLink } from './common';
import { playersOf } from '../../engine/league/helpers';
import { autoLines, defenseScore, offenseScore } from '../../engine/team/lines';
import { chemistryParts, lineChemistry, pairKey, untappedPairs } from '../../engine/team/chemistry';
import { ARCHETYPES } from '../../engine/player/archetypes';
import { PERSONALITIES } from '../../engine/player/personality';

const PART_LABEL: Record<string, string> = { style: 'Style fit', hands: 'Handedness', personality: 'Personalities', passing: 'Passing', together: 'Time together', morale: 'Team morale', nation: 'Same country' };
const pct = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;
const cls = (v: number) => (v > 0.02 ? 'txt-good' : v < -0.02 ? 'txt-bad' : 'muted');

/** Line chemistry breakdown and the coaching staff's suggested lines. */
export function LineInsights() {
  const { league, version } = useGame();
  const team = league.teams[league.userTeamId];
  const roster = useMemo(() => playersOf(league, team.id), [league, version, team.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const byId = new Map(roster.map((p) => [p.id, p]));
  const L = team.lines;
  const units: { key: string; label: string; ids: number[] }[] = [
    ...L.fwd.map((ids, i) => ({ key: `f${i}`, label: `Forward line ${i + 1}`, ids })),
    ...L.def.map((ids, i) => ({ key: `d${i}`, label: `Defence pair ${i + 1}`, ids })),
  ];
  const [sel, setSel] = useState('f0');
  const unit = units.find((u) => u.key === sel) ?? units[0];
  const members = (unit?.ids ?? []).map((id) => byId.get(id)).filter((p): p is Player => !!p);
  const pairs: { a: Player; b: Player }[] = [];
  for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) pairs.push({ a: members[i], b: members[j] });

  const suggested = useMemo(() => autoLines(roster), [roster]);
  const sameUnit = (a: number, b: number) => [...L.fwd, ...L.def].some((u) => u.includes(a) && u.includes(b));
  const untapped = useMemo(() => untappedPairs(roster.filter((p) => !p.injury), league.chemistry, team.morale, sameUnit), [roster, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const unitOf = (lines: Lines, group: 'fwd' | 'def', i: number) => (lines[group][i] ?? []).map((id) => byId.get(id)).filter((p): p is Player => !!p);
  const changes: { label: string; inn: Player[]; out: Player[]; before: number; after: number; chemBefore: number; chemAfter: number }[] = [];
  (['fwd', 'def'] as const).forEach((group) =>
    (group === 'fwd' ? [0, 1, 2, 3] : [0, 1, 2]).forEach((i) => {
      const cur = unitOf(L, group, i);
      const sug = unitOf(suggested, group, i);
      const inn = sug.filter((p) => !cur.some((c) => c.id === p.id));
      const out = cur.filter((p) => !sug.some((c) => c.id === p.id));
      if (!inn.length && !out.length) return;
      const score = group === 'fwd' ? offenseScore : defenseScore;
      const avg = (ps: Player[]) => (ps.length ? ps.reduce((s, p) => s + score(p), 0) / ps.length : 0);
      changes.push({
        label: group === 'fwd' ? `Line ${i + 1}` : `Pair ${i + 1}`,
        inn,
        out,
        before: avg(cur),
        after: avg(sug),
        chemBefore: lineChemistry(cur, league.chemistry, team.morale),
        chemAfter: lineChemistry(sug, league.chemistry, team.morale),
      });
    }),
  );

  return (
    <div className="grid g2" style={{ marginTop: 14 }}>
      <Card title="Chemistry breakdown" right={<select value={sel} onChange={(e) => setSel(e.target.value)}>{units.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}</select>}>
        <div className="stack" style={{ gap: 10 }}>
          {pairs.map(({ a, b }) => {
            const c = chemistryParts(a, b, league.chemistry[pairKey(a.id, b.id)] ?? 0, team.morale);
            return (
              <div key={`${a.id}-${b.id}`} className="stack" style={{ gap: 4 }}>
                <div className="row">
                  <PlayerLink p={a} full={false} /> <span className="dim">+</span> <PlayerLink p={b} full={false} />
                  <span className="dim" style={{ fontSize: 11 }}>
                    {ARCHETYPES[a.archetype].label} / {ARCHETYPES[b.archetype].label}
                  </span>
                  <b className={cls(c.total)} style={{ marginLeft: 'auto' }}>
                    ⚡ {pct(c.total)}
                  </b>
                </div>
                <div className="row" style={{ gap: 10, fontSize: 11 }}>
                  {Object.entries(c)
                    .filter(([k, v]) => k !== 'total' && Math.abs(v) >= 0.01)
                    .map(([k, v]) => (
                      <span key={k} className={cls(v)} title={k === 'personality' ? `${PERSONALITIES[a.personality].label} + ${PERSONALITIES[b.personality].label}` : undefined}>
                        {PART_LABEL[k]} {pct(v)}
                      </span>
                    ))}
                </div>
              </div>
            );
          })}
          {!pairs.length && <span className="muted">Pick a line to see how its players fit together.</span>}
          {untapped.length > 0 && (
            <div className="stack" style={{ gap: 4, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
              <b style={{ fontSize: 13 }}>Untapped duos</b>
              {untapped.map((u) => (
                <div key={`${u.a.id}-${u.b.id}`} className="row" style={{ fontSize: 13 }}>
                  <PlayerLink p={u.a} full={false} /> <span className="dim">+</span> <PlayerLink p={u.b} full={false} />
                  <b className={cls(u.value)} style={{ marginLeft: 'auto' }}>
                    ⚡ {pct(u.value)}
                  </b>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
      <Card
        title="Coach's suggestions"
        right={
          changes.length ? (
            <button
              className="btn small primary"
              onClick={() => {
                mutate((l) => {
                  const t = l.teams[l.userTeamId];
                  t.lines = autoLines(playersOf(l, t.id));
                });
                toast("The coach's lines are in.", 'good');
              }}
            >
              Apply coach's lines
            </button>
          ) : null
        }
      >
        {changes.length ? (
          <div className="stack" style={{ gap: 10 }}>
            {changes.map((c) => (
              <div key={c.label} className="stack" style={{ gap: 2 }}>
                <div className="row">
                  <b style={{ width: 60 }}>{c.label}</b>
                  {c.inn.length > 0 && (
                    <span className="txt-good" style={{ fontSize: 13 }}>
                      In: {c.inn.map((p) => p.last).join(', ')}
                    </span>
                  )}
                  {c.out.length > 0 && (
                    <span className="txt-bad" style={{ fontSize: 13 }}>
                      Out: {c.out.map((p) => p.last).join(', ')}
                    </span>
                  )}
                </div>
                <span className="dim" style={{ fontSize: 11, marginLeft: 60 }}>
                  Rating {Math.round(c.before)} → {Math.round(c.after)} · chemistry {pct(c.chemBefore)} → {pct(c.chemAfter)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <span className="muted">Your lines match what the coaching staff would run.</span>
        )}
      </Card>
    </div>
  );
}
