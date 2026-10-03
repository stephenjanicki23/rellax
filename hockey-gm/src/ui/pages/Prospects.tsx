import { useMemo } from 'react';
import { useGame } from '../store';
import { Card, Table, PlayerLink, Pos, Stars, type Column } from '../components/common';
import { playersOf } from '../../engine/league/helpers';
import { estimate, scoutReport } from '../../engine/economy/scouting';
import { projectedPickNumber, describeAsset } from '../../engine/economy/trade';
import { ARCHETYPES } from '../../engine/player/archetypes';
import type { Player } from '../../engine/types';
import { href } from '../router';

export function ProspectsPage() {
  const { league, version } = useGame();
  const teamId = league.userTeamId;
  const prospects = useMemo(
    () => playersOf(league, teamId, ['prospect']).sort((a, b) => estimate(league, b).pa - estimate(league, a).pa),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [league, version],
  );
  const youngActive = useMemo(
    () => playersOf(league, teamId, ['active']).filter((p) => league.season - p.birthYear <= 23).sort((a, b) => b.pa - a.pa),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [league, version],
  );
  const picks = league.draftPicks.filter((p) => p.ownerId === teamId && p.playerId === undefined).sort((a, b) => a.season - b.season || a.round - b.round);
  const cols: Column<Player>[] = [
    { key: 'pos', label: 'Pos', render: (p) => <Pos pos={p.pos} /> },
    { key: 'name', label: 'Name', render: (p) => <PlayerLink p={p} />, sort: (p) => p.last, defaultDesc: false },
    { key: 'age', label: 'Age', num: true, render: (p) => league.season - p.birthYear, sort: (p) => p.birthYear },
    { key: 'type', label: 'Type', render: (p) => <span className="muted">{ARCHETYPES[p.archetype].label}</span> },
    { key: 'ca', label: 'Now', render: (p) => { const e = estimate(league, p); return <Stars value={e.ca} range={[e.caLow, e.caHigh]} />; }, sort: (p) => estimate(league, p).ca },
    { key: 'pa', label: 'Ceiling', render: (p) => { const e = estimate(league, p); return <Stars value={e.pa} range={[e.paLow, e.paHigh]} />; }, sort: (p) => estimate(league, p).pa },
    { key: 'proj', label: 'Projection', render: (p) => <span className="muted" style={{ whiteSpace: 'normal' }}>{scoutReport(league, p).projection}</span> },
    { key: 'draft', label: 'Drafted', render: (p) => (p.draft ? `${p.draft.season} R${p.draft.round} #${p.draft.pick}` : 'Undrafted') },
    { key: 'gp', label: 'GP (pro)', num: true, render: (p) => p.career.filter((c) => !c.playoffs).reduce((s, c) => s + c.stats.gp, 0) + (league.seasonStats[p.id]?.reg.gp ?? 0) },
  ];
  return (
    <>
      <div className="page-head">
        <h1>Prospects</h1>
        <span className="sub">Estimates come from your scouts and development staff — ceilings are educated guesses, not guarantees.</span>
      </div>
      <div className="grid g-main">
        <div className="grid">
          <Card title={`In the system (${prospects.length})`} tight>
            <Table rows={prospects} columns={cols} rowKey={(p) => p.id} initialSort={{ key: 'pa' }} empty="No prospects in your system." />
          </Card>
          <Card title="Young players on the roster (≤23)" tight>
            <Table rows={youngActive} columns={cols.filter((c) => c.key !== 'draft')} rowKey={(p) => p.id} />
          </Card>
        </div>
        <Card title={`Draft picks (${picks.length})`}>
          <div className="list">
            {picks.map((p) => (
              <div className="item" key={p.id}>
                <b>{describeAsset(league, { kind: 'pick', id: p.id })}</b>
                {p.round === 1 && <span className="muted" style={{ marginLeft: 'auto' }}>proj. #{projectedPickNumber(league, p)}</span>}
              </div>
            ))}
            {!picks.length && <div className="muted">You have traded away all of your picks.</div>}
          </div>
          <div style={{ marginTop: 10 }}>
            <a href={href('draft')}>Draft board →</a>
          </div>
        </Card>
      </div>
    </>
  );
}
