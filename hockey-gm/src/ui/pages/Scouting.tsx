import { useMemo, useState } from 'react';
import { useGame, mutate } from '../store';
import { Card, PlayerLink, Pos, Stars, Table, Tabs, Bar, type Column } from '../components/common';
import { estimate, scoutReport, knowledgeOf, combineResults, interviewsLeft } from '../../engine/economy/scouting';
import { draftColumns, interviewColumn } from '../components/DraftColumns';
import { draftClassInfo } from '../../engine/league/realDraftClass';
import { draftRankings } from '../../engine/economy/draft';
import type { Player, ScoutAssignment } from '../../engine/types';
import { ARCHETYPES } from '../../engine/player/archetypes';
import { attr20 } from '../../engine/player/ability';

export function ScoutingPage() {
  const { league, version } = useGame();
  const [tab, setTab] = useState<'draft' | 'staff' | 'combine'>('draft');
  const prospects = useMemo(() => draftRankings(league), [league, version]);
  const assign = (scoutId: number, a: ScoutAssignment) => mutate((l) => {
    const s = l.scouts.find((x) => x.id === scoutId);
    if (s) s.assignment = a;
  });
  const cols: Column<Player>[] = [
    { key: 'rk', label: 'Rank', num: true, render: (_p, i) => i + 1 },
    { key: 'pos', label: 'Pos', render: (p) => <Pos pos={p.pos} /> },
    { key: 'name', label: 'Prospect', render: (p) => <PlayerLink p={p} /> },
    { key: 'age', label: 'Age', num: true, render: (p) => league.season - p.birthYear },
    ...draftColumns(league),
    { key: 'type', label: 'Type', render: (p) => <span className="muted">{ARCHETYPES[p.archetype].short}</span> },
    { key: 'ca', label: 'Now', render: (p) => { const e = estimate(league, p); return <Stars value={e.ca} range={[e.caLow, e.caHigh]} />; }, sort: (p) => estimate(league, p).ca },
    { key: 'pa', label: 'Ceiling (est.)', render: (p) => { const e = estimate(league, p); return <Stars value={e.pa} range={[e.paLow, e.paHigh]} />; }, sort: (p) => estimate(league, p).pa },
    { key: 'know', label: 'Scouted', render: (p) => <div style={{ width: 70 }}><Bar value={knowledgeOf(league, p)} max={100} /></div>, sort: (p) => knowledgeOf(league, p) },
    { key: 'rep', label: 'Report', render: (p) => { const r = scoutReport(league, p); return <span className="muted" style={{ whiteSpace: 'normal', fontSize: 12 }}>{r.projection}{r.personality ? ` Character: ${r.personality}.` : ''}</span>; } },
    interviewColumn(league),
  ];
  const info = draftClassInfo();
  return (
    <>
      <div className="page-head">
        <h1>Scouting</h1>
        <span className="sub">Your knowledge is imperfect. Scouts narrow the ranges each week — better scouts, better reads.</span>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'draft', label: `Draft class (${prospects.length})` }, { id: 'staff', label: 'Scouting staff' }, { id: 'combine', label: 'Draft combine' }]} />
      {tab === 'draft' && (
        <Card tight>
          <div className="muted" style={{ padding: '8px 12px', fontSize: 12 }}>
            {league.scouting.central?.season === league.season
              ? `NHL Central Scouting ${league.scouting.central.stage} rankings are out. `
              : 'Central Scouting publishes midterm rankings in mid-January and final rankings when the regular season ends. '}
            {league.draftCombineDone ? `Combine interviews left: ${interviewsLeft(league)}. ` : 'Interviews open at the draft combine. '}
            {info.draftYear === league.season + 1 && info.count > 0 ? `Real prospects: ${info.source} (as of ${info.asOf}).` : ''}
          </div>
          <Table rows={prospects} columns={cols} rowKey={(p) => p.id} limit={250} />
        </Card>
      )}
      {tab === 'staff' && (
        <div className="grid g3">
          {league.scouts.map((s) => (
            <Card key={s.id} title={`${s.first} ${s.last}`}>
              <div className="stack">
                <div className="attr"><span className="n">Judging ability</span><span className="v">{attr20(s.judgingAbility)}</span><Bar value={s.judgingAbility} /></div>
                <div className="attr"><span className="n">Judging potential</span><span className="v">{attr20(s.judgingPotential)}</span><Bar value={s.judgingPotential} /></div>
                <label className="field">
                  Assignment
                  <select
                    value={s.assignment.kind === 'team' ? `team-${s.assignment.teamId}` : s.assignment.kind === 'draft' && s.assignment.region ? `draft-${s.assignment.region}` : s.assignment.kind}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v.startsWith('team-')) assign(s.id, { kind: 'team', teamId: Number(v.slice(5)) });
                      else if (v === 'draft-NA' || v === 'draft-EU') assign(s.id, { kind: 'draft', region: v.slice(6) as 'NA' | 'EU' });
                      else assign(s.id, { kind: v as 'draft' | 'freeAgents' | 'idle' });
                    }}
                  >
                    <option value="draft">Draft prospects — everywhere</option>
                    <option value="draft-NA">Draft prospects — North America (CHL, USHL, NCAA)</option>
                    <option value="draft-EU">Draft prospects — Europe</option>
                    <option value="freeAgents">Free agents</option>
                    <option value="idle">Unassigned</option>
                    {league.teams.filter((t) => t.id !== league.userTeamId).map((t) => (
                      <option key={t.id} value={`team-${t.id}`}>Scout the {t.city} {t.name}</option>
                    ))}
                  </select>
                </label>
              </div>
            </Card>
          ))}
        </div>
      )}
      {tab === 'combine' && (
        <Card tight>
          {!league.draftCombineDone ? (
            <div className="empty">The draft combine takes place at the end of the regular season.</div>
          ) : (
            <Table
              rows={prospects.slice(0, 120)}
              rowKey={(p) => p.id}
              columns={[
                { key: 'pos', label: 'Pos', render: (p) => <Pos pos={p.pos} /> },
                { key: 'name', label: 'Prospect', render: (p) => <PlayerLink p={p} /> },
                ...combineResults(prospects[0] ?? ({} as Player)).map((c, i) => ({
                  key: `c${i}`,
                  label: c.label,
                  num: true,
                  render: (p: Player) => attr20(combineResults(p)[i].value),
                  sort: (p: Player) => combineResults(p)[i].value,
                })),
                { key: 'h', label: 'Height', num: true, render: (p) => `${p.heightCm} cm` },
                { key: 'w', label: 'Weight', num: true, render: (p) => `${p.weightKg} kg` },
              ]}
            />
          )}
        </Card>
      )}
    </>
  );
}
