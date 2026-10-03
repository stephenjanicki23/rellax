import { useMemo, useState } from 'react';
import { useGame } from '../store';
import { Card, PlayerLink, TeamLink, Tabs, Table, Pos } from '../components/common';
import { seasonLabel, sv } from '../format';
import type { Player, RecordEntry } from '../../engine/types';
import { careerSum } from '../../engine/league/records';
import { points, savePct } from '../../engine/core/statline';

export function HistoryPage() {
  const { league, version } = useGame();
  const [tab, setTab] = useState<'champions' | 'awards' | 'records' | 'leaders' | 'halloffame'>('champions');
  const history = [...league.history].reverse();
  const awardNames = useMemo(() => [...new Set(league.history.flatMap((h) => h.awards.map((a) => a.award)))], [league.history.length]);
  const careers = useMemo(() => {
    return Object.values(league.players)
      .filter((p) => p.career.length)
      .map((p) => ({ p, reg: careerSum(p, false), po: careerSum(p, true) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [league, version]);
  const fmtRecord = (r: RecordEntry) => (r.key === 'savePct' ? sv(r.value) : String(r.value));
  const recordRow = (r: RecordEntry) => (
    <tr key={r.key}>
      <td>{r.label}</td>
      <td className="num"><b>{fmtRecord(r)}</b></td>
      <td>{r.playerId !== undefined ? <PlayerLink p={league.players[r.playerId]} /> : r.detail ?? ''}</td>
      <td>{r.teamId !== undefined ? <TeamLink league={league} id={r.teamId} short /> : ''}</td>
      <td className="muted">{r.season !== undefined ? seasonLabel(r.season) : ''}</td>
    </tr>
  );
  type CR = (typeof careers)[number];
  return (
    <>
      <div className="page-head">
        <h1>History</h1>
        <span className="sub">{league.history.length} completed season{league.history.length === 1 ? '' : 's'}. The league writes its own story.</span>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'champions', label: 'Champions' }, { id: 'awards', label: 'Awards' }, { id: 'records', label: 'Record book' }, { id: 'leaders', label: 'All-time leaders' }, { id: 'halloffame', label: 'Legends' }]} />
      {tab === 'champions' && (
        <Card tight>
          {history.length === 0 ? (
            <div className="empty">No seasons completed yet.</div>
          ) : (
            <table className="tbl">
              <thead>
                <tr><th>Season</th><th>{league.config.championship}</th><th>Runner-up</th><th>Presidents' Trophy</th><th>Playoff MVP</th><th>Scoring leader</th></tr>
              </thead>
              <tbody>
                {history.map((h) => {
                  const mvp = h.awards.find((a) => a.award.startsWith('Conn'));
                  const lead = h.leaders.find((l) => l.cat === 'Points');
                  return (
                    <tr key={h.season}>
                      <td>{seasonLabel(h.season)}</td>
                      <td className="gold">♛ <TeamLink league={league} id={h.champion} /></td>
                      <td><TeamLink league={league} id={h.runnerUp} short /></td>
                      <td><TeamLink league={league} id={h.presidentsTrophy} short /></td>
                      <td>{mvp?.playerId !== undefined ? <PlayerLink p={league.players[mvp.playerId]} /> : '—'}</td>
                      <td>{lead ? <><PlayerLink p={league.players[lead.playerId]} /> <span className="muted">({lead.value})</span></> : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      )}
      {tab === 'awards' && (
        <Card tight>
          {history.length === 0 ? (
            <div className="empty">Awards are handed out after the playoffs.</div>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr><th>Season</th>{awardNames.map((a) => <th key={a}>{a.split(' (')[0]}</th>)}</tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.season}>
                      <td>{seasonLabel(h.season)}</td>
                      {awardNames.map((a) => {
                        const w = h.awards.find((x) => x.award === a);
                        return (
                          <td key={a} title={w?.value}>
                            {w?.playerId !== undefined ? <PlayerLink p={league.players[w.playerId]} full={false} /> : w?.coachId !== undefined ? `${league.coaches[w.coachId]?.last}` : w ? <TeamLink league={league} id={w.teamId} short /> : '—'}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      {tab === 'records' && (
        <div className="grid g2">
          <Card title="Single season" tight>
            <table className="tbl"><tbody>{Object.values(league.records.singleSeason).map(recordRow)}</tbody></table>
          </Card>
          <div className="grid">
            <Card title="Career" tight>
              <table className="tbl"><tbody>{Object.values(league.records.career).map(recordRow)}</tbody></table>
            </Card>
            <Card title="Team" tight>
              <table className="tbl"><tbody>{Object.values(league.records.team).map(recordRow)}</tbody></table>
            </Card>
          </div>
        </div>
      )}
      {tab === 'leaders' && (
        <Card tight>
          <Table<CR>
            rows={careers}
            rowKey={(c) => c.p.id}
            initialSort={{ key: 'p' }}
            limit={150}
            columns={[
              { key: 'pos', label: 'Pos', render: (c) => <Pos pos={c.p.pos} /> },
              { key: 'name', label: 'Player', render: (c) => <PlayerLink p={c.p} /> },
              { key: 'st', label: 'Status', render: (c) => (c.p.status === 'retired' ? <span className="muted">Retired {c.p.retiredSeason}</span> : <TeamLink league={league} id={c.p.teamId} short />) },
              { key: 'gp', label: 'GP', num: true, render: (c) => c.reg.gp, sort: (c) => c.reg.gp },
              { key: 'g', label: 'G', num: true, render: (c) => c.reg.g, sort: (c) => c.reg.g },
              { key: 'a', label: 'A', num: true, render: (c) => c.reg.a1 + c.reg.a2, sort: (c) => c.reg.a1 + c.reg.a2 },
              { key: 'p', label: 'P', num: true, render: (c) => <b>{points(c.reg)}</b>, sort: (c) => points(c.reg) },
              { key: 'w', label: 'W (G)', num: true, render: (c) => c.reg.w || '', sort: (c) => c.reg.w },
              { key: 'so', label: 'SO', num: true, render: (c) => c.reg.so || '', sort: (c) => c.reg.so },
              { key: 'sv', label: 'SV%', num: true, render: (c) => (c.reg.sa > 500 ? sv(savePct(c.reg)) : ''), sort: (c) => (c.reg.sa > 500 ? savePct(c.reg) : 0) },
              { key: 'pog', label: 'PO G', num: true, render: (c) => c.po.g, sort: (c) => c.po.g },
              { key: 'pop', label: 'PO P', num: true, render: (c) => points(c.po), sort: (c) => points(c.po) },
              { key: 'cups', label: 'Cups', num: true, render: (c) => c.p.awards.filter((a) => a.award.endsWith('Champion')).length || '', sort: (c) => c.p.awards.filter((a) => a.award.endsWith('Champion')).length },
            ]}
          />
        </Card>
      )}
      {tab === 'halloffame' && <Legends players={careers.map((c) => c.p)} />}
    </>
  );
}

function Legends({ players }: { players: Player[] }) {
  const { league } = useGame();
  const retired = players
    .filter((p) => p.status === 'retired')
    .map((p) => {
      const reg = careerSum(p, false);
      const score = points(reg) + reg.w * 1.5 + reg.so * 4 + p.awards.length * 40;
      return { p, reg, score };
    })
    .filter((x) => x.score > 400)
    .sort((a, b) => b.score - a.score);
  if (!retired.length) return <div className="card empty">Legends are made over many seasons. Check back after a few years.</div>;
  return (
    <div className="grid g3">
      {retired.slice(0, 30).map(({ p, reg }) => (
        <Card key={p.id}>
          <div className="stack" style={{ gap: 4 }}>
            <b><PlayerLink p={p} /></b>
            <span className="muted">{p.pos} · {p.career.length ? `${p.career[0].season}–${p.retiredSeason}` : ''}</span>
            <span>{p.pos === 'G' ? `${reg.w} wins · ${reg.so} shutouts · ${sv(savePct(reg))}` : `${reg.g} G · ${reg.a1 + reg.a2} A · ${points(reg)} P in ${reg.gp} GP`}</span>
            <span className="gold" style={{ fontSize: 12 }}>{p.awards.map((a) => a.award.split(' (')[0]).join(' · ')}</span>
            <span className="dim" style={{ fontSize: 11 }}>{[...new Set(p.career.map((c) => league.teams[c.teamId]?.abbr))].join(', ')}</span>
          </div>
        </Card>
      ))}
    </div>
  );
}
