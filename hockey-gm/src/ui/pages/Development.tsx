import { useMemo, useState } from 'react';
import type { DevFocus, DevIntensity, Player } from '../../engine/types';
import { useGame, mutate, toast } from '../store';
import { Card, PlayerLink, Pos, Seg, Stars, Table, type Column } from '../components/common';
import { playersOf } from '../../engine/league/helpers';
import { estimate } from '../../engine/economy/scouting';
import { FOCUS, INTENSITY_LABEL, coachSuggestion, devProgress, focusOptions, setDevPlan } from '../../engine/player/devPlan';
import { coachOverall } from '../../engine/team/coaching';
import { attr20 } from '../../engine/player/ability';

const signed = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`;

/** Individual development plans: a training focus and intensity for each player. */
export function DevelopmentPage() {
  const { league, version } = useGame();
  const team = league.teams[league.userTeamId];
  const [who, setWho] = useState<'young' | 'all'>('young');
  const players = useMemo(
    () => playersOf(league, team.id, ['active', 'prospect']).filter((p) => !p.ahlContract && (who === 'all' || league.season - p.birthYear <= 25)),
    [league, version, team.id, who], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const hc = team.staff.headCoach !== null ? league.coaches[team.staff.headCoach] : undefined;
  const asst = team.staff.assistant !== null ? league.coaches[team.staff.assistant] : undefined;
  const gk = team.staff.goalieCoach !== null ? league.coaches[team.staff.goalieCoach] : undefined;
  const set = (p: Player, focus: DevFocus, intensity: DevIntensity) => {
    const r = mutate((l) => setDevPlan(l, l.players[p.id], focus, intensity));
    if (!r.ok) toast(r.message, 'bad');
  };
  const cols: Column<Player>[] = [
    { key: 'pos', label: 'Pos', render: (p) => <Pos pos={p.pos} /> },
    {
      key: 'name',
      label: 'Player',
      render: (p) => (
        <span>
          <PlayerLink p={p} /> {p.status === 'prospect' && <span className="pill">minors</span>}
        </span>
      ),
      sort: (p) => p.last,
      defaultDesc: false,
    },
    { key: 'age', label: 'Age', num: true, render: (p) => league.season - p.birthYear, sort: (p) => league.season - p.birthYear },
    { key: 'now', label: 'Now', render: (p) => <Stars value={estimate(league, p).ca} />, sort: (p) => estimate(league, p).ca },
    { key: 'pot', label: 'Potential', render: (p) => <Stars value={estimate(league, p).pa} />, sort: (p) => estimate(league, p).pa },
    {
      key: 'growth',
      label: 'This season',
      num: true,
      render: (p) => {
        const g = devProgress(league, p);
        return g ? <b className={g.ca > 0.5 ? 'txt-good' : g.ca < -0.5 ? 'txt-bad' : ''}>{signed(g.ca)}</b> : <span className="dim">—</span>;
      },
      sort: (p) => devProgress(league, p)?.ca ?? 0,
    },
    {
      key: 'focus',
      label: 'Focus',
      render: (p) => {
        const sug = coachSuggestion(p);
        const cur = p.devPlan?.focus ?? 'balanced';
        return (
          <span className="stack" style={{ gap: 2 }}>
            <select style={{ maxWidth: 190 }} value={cur} onChange={(e) => set(p, e.target.value as DevFocus, p.devPlan?.intensity ?? 'normal')}>
              {focusOptions(p).map((f) => (
                <option key={f} value={f}>
                  {FOCUS[f].label}
                  {f === sug ? ' (coach suggests)' : ''}
                </option>
              ))}
            </select>
            {cur !== 'balanced' && devProgress(league, p) && (
              <span className="dim" style={{ fontSize: 11 }}>
                {FOCUS[cur].label}: {signed(devProgress(league, p)!.groups[cur] ?? 0)} this season
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: 'int',
      label: 'Intensity',
      render: (p) => (
        <select value={p.devPlan?.intensity ?? 'normal'} onChange={(e) => set(p, p.devPlan?.focus ?? 'balanced', e.target.value as DevIntensity)}>
          {(['light', 'normal', 'intense'] as DevIntensity[]).map((i) => (
            <option key={i} value={i}>
              {INTENSITY_LABEL[i]}
            </option>
          ))}
        </select>
      ),
    },
  ];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Development</h1>
          <div className="sub">Set each player's training focus and intensity. Focus steers where his growth goes; intensity speeds it up at a cost.</div>
        </div>
      </div>
      <div className="grid g3" style={{ marginBottom: 14 }}>
        <Card>
          <div className="stat">
            <span className="k">Development staff</span>
            <span className="v">{attr20(Math.round(((hc?.ratings.development ?? 90) * 0.7 + (asst?.ratings.development ?? 90) * 0.3)))}/20</span>
            <span className="muted" style={{ fontSize: 12 }}>
              Head coach and assistant · goalie coach {gk ? `${attr20(coachOverall(gk))}/20` : '—'}
            </span>
          </div>
        </Card>
        <Card>
          <div className="stat">
            <span className="k">Facilities</span>
            <span className="v">{attr20(team.facilities)}/20</span>
            <span className="muted" style={{ fontSize: 12 }}>Upgrade them on the Finances page</span>
          </div>
        </Card>
        <Card>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
            <b>Light</b>: a little slower, rested legs. <b>Intense</b>: faster growth (more with a strong development staff) but tiring; easygoing and difficult players resent it, driven pros enjoy it. Young players grow most; ice time still matters.
          </div>
        </Card>
      </div>
      <Card tight right={<Seg value={who} onChange={setWho} options={[{ id: 'young', label: '25 and under' }, { id: 'all', label: 'Everyone' }]} />} title="Players">
        <Table rows={players} columns={cols} rowKey={(p) => p.id} initialSort={{ key: 'pot' }} empty="No young players in the organisation." />
      </Card>
    </>
  );
}
