import { useMemo, useState } from 'react';
import { useGame, mutate, toast, ask } from '../store';
import { Card, Table, Tabs, Seg, type Column } from '../components/common';
import { playerColumns } from '../playerCells';
import { playersOf } from '../../engine/league/helpers';
import { demote, promote, releasePlayer, rosterCounts, rosterSize } from '../../engine/economy/roster';
import { payroll, fmtMoney } from '../../engine/economy/contracts';
import type { Player } from '../../engine/types';
import { teamStrength } from '../../engine/team/strength';
import { isForward } from '../../engine/player/ability';

const grp = (p: Player) => (p.pos === 'G' ? 'G' : isForward(p.pos) ? 'F' : 'D');

export function RosterPage() {
  const { league, version } = useGame();
  const [tab, setTab] = useState<'active' | 'minors'>('active');
  const [view, setView] = useState<'overview' | 'stats' | 'contract'>('overview');
  const teamId = league.userTeamId;
  const rows = useMemo(
    () => playersOf(league, teamId, [tab === 'active' ? 'active' : 'prospect']).sort((a, b) => ['C', 'LW', 'RW', 'D', 'G'].indexOf(a.pos) - ['C', 'LW', 'RW', 'D', 'G'].indexOf(b.pos) || b.ca - a.ca),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [league, version, tab],
  );
  const active = playersOf(league, teamId, ['active']);
  const counts = rosterCounts(active);
  const str = teamStrength(league, teamId);
  const max = league.config.economics.rosterMax;

  const actions: Column<Player> = {
    key: 'act',
    label: '',
    render: (p) => (
      <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
        {p.status === 'active' ? (
          <button
            className="btn small"
            onClick={() => {
              const grp = p.pos === 'G' ? counts.G : p.pos === 'D' ? counts.D : counts.F;
              const min = p.pos === 'G' ? 2 : p.pos === 'D' ? 6 : 12;
              if (grp <= min && !p.injury) return toast(`You need at least ${min} healthy ${p.pos === 'G' ? 'goalies' : p.pos === 'D' ? 'defensemen' : 'forwards'}.`, 'bad');
              { const r = mutate((l) => demote(l, p)); toast(r.message, r.ok ? 'info' : 'bad'); }
              toast(`${p.last} assigned to the minors.`);
            }}
          >
            Send down
          </button>
        ) : (
          <button
            className="btn small"
            onClick={() => {
              if (rosterSize(league, teamId) >= max) return toast(`Your active roster is full (${max}). Send someone down first.`, 'bad');
              if (p.contract && payroll(league, teamId) + p.contract.salary > league.cap.upper) return toast('Calling him up would put you over the cap.', 'bad');
              mutate((l) => promote(l, p));
              toast(`${p.last} called up.`, 'good');
            }}
          >
            Call up
          </button>
        )}
        <button
          className="btn small danger"
          onClick={async () => {
            if (!(await ask(`Release ${p.first} ${p.last}? He becomes a free agent and your team takes no further salary responsibility.`, 'Release'))) return;
            { const r = mutate((l) => releasePlayer(l, p, 'release')); toast(r.message, r.ok ? 'info' : 'bad'); }
          }}
        >
          Release
        </button>
      </span>
    ),
  };
  const cols = [
    ...playerColumns(league, { stats: view === 'stats', contract: view === 'contract', morale: view === 'overview', status: true, fit: true }),
    ...(view === 'overview'
      ? [
          { key: 'fat', label: 'Fatigue', num: true, render: (p: Player) => <span className={p.fatigue > 45 ? 'bad' : p.fatigue > 25 ? 'warn' : 'muted'}>{Math.round(p.fatigue)}</span>, sort: (p: Player) => p.fatigue },
          { key: 'form', label: 'Form', num: true, render: (p: Player) => <span className={p.form > 0.15 ? 'good' : p.form < -0.15 ? 'bad' : 'muted'}>{p.form > 0.15 ? '▲ Hot' : p.form < -0.15 ? '▼ Cold' : '—'}</span>, sort: (p: Player) => p.form },
        ]
      : []),
    actions,
  ];
  return (
    <>
      <div className="page-head">
        <h1>Roster</h1>
        <span className="sub">
          {rosterSize(league, teamId)}/{max} active (excl. injured reserve) · {counts.F}F {counts.D}D {counts.G}G healthy · Payroll {fmtMoney(payroll(league, teamId))}
        </span>
        <div className="actions">
          <Seg value={view} onChange={setView} options={[{ id: 'overview', label: 'Overview' }, { id: 'stats', label: 'Stats' }, { id: 'contract', label: 'Contracts' }]} />
        </div>
      </div>
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <Card><div className="stat"><span className="k">Forwards</span><span className="v">{str.forwards.toFixed(0)}</span></div></Card>
        <Card><div className="stat"><span className="k">Defense</span><span className="v">{str.defense.toFixed(0)}</span></div></Card>
        <Card><div className="stat"><span className="k">Goaltending</span><span className="v">{str.goalie.toFixed(0)}</span></div></Card>
        <Card><div className="stat"><span className="k">Depth</span><span className="v">{str.depth.toFixed(0)}</span></div></Card>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'active', label: `Active roster (${active.length})` }, { id: 'minors', label: `Minors / prospects (${playersOf(league, teamId, ['prospect']).length})` }]} />
      <div className="card tight">
        <Table rows={rows} columns={cols} rowKey={(p) => p.id} rowClass={(p, i) => (rows[i + 1] && grp(rows[i + 1]) !== grp(p) ? 'cut' : undefined)} />
      </div>
    </>
  );
}
