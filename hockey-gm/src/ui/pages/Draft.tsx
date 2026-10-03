import { useMemo, useState } from 'react';
import { useGame, mutate, nextPhase, toast, ask } from '../store';
import { Card, PlayerLink, Pos, Stars, Table, TeamLink, Bar, Tabs, type Column } from '../components/common';
import { currentPick, draftRankings, makeDraftPick, runDraftUntilUser, suggestPick } from '../../engine/economy/draft';
import { estimate, knowledgeOf, scoutReport } from '../../engine/economy/scouting';
import { describeAsset, projectedPickNumber } from '../../engine/economy/trade';
import { ARCHETYPES } from '../../engine/player/archetypes';
import type { Player } from '../../engine/types';

export function DraftPage() {
  const { league, version } = useGame();
  const [tab, setTab] = useState<'board' | 'order'>('board');
  const me = league.userTeamId;
  const pick = league.phase === 'draft' ? currentPick(league) : undefined;
  const onClock = pick?.ownerId === me;
  const available = useMemo(() => draftRankings(league), [league, version]);
  const suggestion = onClock ? suggestPick(league) : undefined;
  const myPicks = league.draftPicks.filter((p) => p.ownerId === me && p.season === league.season && p.playerId === undefined);
  const order = league.draftOrder.map((id) => league.draftPicks.find((p) => p.id === id)).filter(Boolean);

  const draft = (p: Player) => {
    if (!pick || !onClock) return;
    mutate((l) => makeDraftPick(l, pick.id, p.id));
    toast(`You select ${p.first} ${p.last}!`, 'good');
  };
  const cols: Column<Player>[] = [
    { key: 'rk', label: '#', num: true, render: (_p, i) => i + 1 },
    { key: 'pos', label: 'Pos', render: (p) => <Pos pos={p.pos} /> },
    { key: 'name', label: 'Prospect', render: (p) => <PlayerLink p={p} /> },
    { key: 'age', label: 'Age', num: true, render: (p) => league.season - p.birthYear },
    { key: 'jr', label: 'From', render: (p) => <span className="muted">{p.junior}</span> },
    { key: 'type', label: 'Type', render: (p) => <span className="muted">{ARCHETYPES[p.archetype].label}</span> },
    { key: 'ca', label: 'Now', render: (p) => { const e = estimate(league, p); return <Stars value={e.ca} range={[e.caLow, e.caHigh]} />; }, sort: (p) => estimate(league, p).ca },
    { key: 'pa', label: 'Ceiling', render: (p) => { const e = estimate(league, p); return <Stars value={e.pa} range={[e.paLow, e.paHigh]} />; }, sort: (p) => estimate(league, p).pa },
    { key: 'kn', label: 'Scouted', render: (p) => <div style={{ width: 60 }}><Bar value={knowledgeOf(league, p)} max={100} /></div> },
    { key: 'rep', label: 'Scouting report', render: (p) => <span className="muted" style={{ whiteSpace: 'normal', fontSize: 12 }}>{scoutReport(league, p).summary}</span> },
    ...(onClock ? [{ key: 'act', label: '', render: (p: Player) => <button className="btn small primary" onClick={() => draft(p)}>Draft</button> }] : []),
  ];
  return (
    <>
      <div className="page-head">
        <h1>{league.phase === 'draft' ? `${league.season + 1} Entry Draft` : 'Draft'}</h1>
        <span className="sub">
          {league.phase === 'draft'
            ? pick
              ? `Pick #${pick.pickNumber} (Round ${pick.round}) — ${league.teams[pick.ownerId].city} ${league.teams[pick.ownerId].name} ${onClock ? '— you are on the clock!' : 'on the clock'}`
              : 'The draft is complete.'
            : `The draft takes place after the playoffs. You hold ${league.draftPicks.filter((p) => p.ownerId === me && p.season === league.season).length} picks this year.`}
        </span>
        <div className="actions">
          {league.phase === 'draft' && pick && !onClock && (
            <button className="btn primary" onClick={() => mutate((l) => runDraftUntilUser(l))}>
              Sim to my pick
            </button>
          )}
          {league.phase === 'draft' && onClock && suggestion && (
            <button className="btn" onClick={() => draft(suggestion)}>
              Take scouts' choice: {suggestion.last}
            </button>
          )}
          {league.phase === 'draft' && (
            <button
              className="btn"
              onClick={async () => {
                if (myPicks.length && !(await ask('Auto-draft your remaining picks using your scouts’ board?', 'Auto-draft'))) return;
                mutate((l) => runDraftUntilUser(l, true));
                void nextPhase();
              }}
            >
              {pick ? 'Auto-draft remaining' : 'Finish draft'}
            </button>
          )}
        </div>
      </div>
      {league.phase !== 'draft' && (
        <div className="banner">
          <span className="muted">Your picks:</span>
          {league.draftPicks
            .filter((p) => p.ownerId === me && p.season === league.season)
            .map((p) => (
              <span key={p.id} className="pill accent">
                {describeAsset(league, { kind: 'pick', id: p.id })}
                {p.round === 1 ? ` (~#${projectedPickNumber(league, p)})` : ''}
              </span>
            ))}
        </div>
      )}
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'board', label: 'Big board' }, { id: 'order', label: 'Draft order & picks made' }]} />
      {tab === 'board' ? (
        <Card tight>
          <Table rows={available} columns={cols} rowKey={(p) => p.id} limit={250} />
        </Card>
      ) : (
        <Card tight>
          {order.length === 0 ? (
            <div className="empty">The draft order is set when the playoffs end.</div>
          ) : (
            <table className="tbl">
              <thead>
                <tr><th>Pick</th><th>Team</th><th>Selection</th><th>Pos</th></tr>
              </thead>
              <tbody>
                {order.map((pk) => {
                  const p = pk!.playerId !== undefined ? league.players[pk!.playerId] : undefined;
                  return (
                    <tr key={pk!.id} className={pk!.ownerId === me ? 'me' : ''}>
                      <td>{pk!.pickNumber} <span className="dim">R{pk!.round}</span></td>
                      <td><TeamLink league={league} id={pk!.ownerId} logo />{pk!.originalTeamId !== pk!.ownerId && <span className="dim"> (from {league.teams[pk!.originalTeamId].abbr})</span>}</td>
                      <td>{p ? <PlayerLink p={p} /> : <span className="dim">—</span>}</td>
                      <td>{p && <Pos pos={p.pos} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </>
  );
}
