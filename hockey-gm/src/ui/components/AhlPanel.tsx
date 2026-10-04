import { useMemo, useState } from 'react';
import type { League, Player } from '../../engine/types';
import { Card, PlayerLink, Pos, Table, Tabs, TeamLogo, type Column } from './common';
import { affiliateOf, ahlEligible, ahlLeaders, ahlStandings } from '../../engine/league/ahl';
import { playersOf } from '../../engine/league/helpers';
import { mutate, toast } from '../store';
import { signAhlPlayer } from '../../engine/economy/roster';

type Tab = 'roster' | 'standings' | 'leaders';

const svPct = (sa: number, ga: number) => (sa ? (1 - ga / sa).toFixed(3).replace(/^0/, '') : '—');

/** The user's AHL affiliate: roster with season lines, league standings and scoring leaders. */
export function AhlPanel({ league, version }: { league: League; version: number }) {
  const [tab, setTab] = useState<Tab>('roster');
  const me = league.userTeamId;
  const aff = affiliateOf(league, me);
  const standings = useMemo(() => ahlStandings(league), [league, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const roster = useMemo(
    () =>
      playersOf(league, me, ['prospect'])
        .filter((p) => ahlEligible(league, p))
        .sort((a, b) => {
          const la = league.ahl?.stats[a.id];
          const lb = league.ahl?.stats[b.id];
          return (lb ? lb.g + lb.a : -1) - (la ? la.g + la.a : -1) || b.ca - a.ca;
        }),
    [league, version, me], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const leaders = useMemo(() => ahlLeaders(league, 25), [league, version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!aff || !league.ahl) return null;
  const rank = standings.findIndex((t) => t.nhlTeamId === me) + 1;
  const st = (p: Player) => league.ahl!.stats[p.id];
  const cols: Column<Player>[] = [
    { key: 'pos', label: 'Pos', render: (p) => <Pos pos={p.pos} /> },
    {
      key: 'name',
      label: 'Player',
      render: (p) => (
        <span>
          <PlayerLink p={p} /> {p.ahlContract && <span className="pill" title="On an AHL contract: sign him to an NHL deal to call him up">AHL deal</span>}
        </span>
      ),
      sort: (p) => p.last,
      defaultDesc: false,
    },
    { key: 'age', label: 'Age', num: true, render: (p) => league.season - p.birthYear },
    { key: 'gp', label: 'GP', num: true, render: (p) => st(p)?.gp ?? 0, sort: (p) => st(p)?.gp ?? 0 },
    { key: 'g', label: 'G / W', num: true, render: (p) => (p.pos === 'G' ? (st(p)?.w ?? 0) : (st(p)?.g ?? 0)), sort: (p) => (p.pos === 'G' ? (st(p)?.w ?? 0) : (st(p)?.g ?? 0)) },
    { key: 'a', label: 'A / SV%', num: true, render: (p) => (p.pos === 'G' ? svPct(st(p)?.sa ?? 0, st(p)?.ga ?? 0) : (st(p)?.a ?? 0)) },
    { key: 'pts', label: 'PTS / GAA', num: true, render: (p) => (p.pos === 'G' ? (st(p)?.gp ? ((st(p)!.ga / st(p)!.gp) || 0).toFixed(2) : '—') : (st(p) ? st(p)!.g + st(p)!.a : 0)), sort: (p) => (p.pos === 'G' ? 0 : st(p) ? st(p)!.g + st(p)!.a : 0) },
    { key: 'pm', label: '+/-', num: true, render: (p) => (p.pos === 'G' ? '' : (st(p)?.pm ?? 0)) },
    { key: 'pim', label: 'PIM', num: true, render: (p) => (p.pos === 'G' ? '' : (st(p)?.pim ?? 0)) },
    {
      key: 'act',
      label: '',
      render: (p) =>
        p.ahlContract ? (
          <button
            className="btn small ghost"
            title="Sign him to a two-way NHL contract (league minimum) so he can be called up"
            onClick={() => {
              const r = mutate((l) => signAhlPlayer(l, l.players[p.id]));
              toast(r.message, r.ok ? 'good' : 'bad');
            }}
          >
            + NHL deal
          </button>
        ) : null,
    },
  ];
  return (
    <Card
      title={
        <div className="row" style={{ gap: 8 }}>
          <TeamLogo team={league.teams[me]} size={20} />
          <h3>
            {aff.name} <span className="muted">· AHL affiliate</span>
          </h3>
        </div>
      }
      right={
        <span className="muted" style={{ fontSize: 12 }}>
          {aff.w}-{aff.l}-{aff.otl} · {aff.w * 2 + aff.otl} pts · {rank ? `${rank}${rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th'} of ${standings.length}` : ''}
          {league.ahl.champion === me ? ' · Calder Cup champions' : ''}
        </span>
      }
      tight
    >
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'roster', label: `Roster (${roster.length})` }, { id: 'standings', label: 'Standings' }, { id: 'leaders', label: 'Scoring leaders' }]} />
      {tab === 'roster' && <Table rows={roster} columns={cols} rowKey={(p) => p.id} empty="No one is playing for the affiliate yet." />}
      {tab === 'standings' && (
        <table className="tbl">
          <thead>
            <tr>
              <th>#</th>
              <th>Team</th>
              <th className="num">GP</th>
              <th className="num">W</th>
              <th className="num">L</th>
              <th className="num">OTL</th>
              <th className="num">PTS</th>
              <th className="num">GF</th>
              <th className="num">GA</th>
            </tr>
          </thead>
          <tbody>
            {standings.map((t, i) => (
              <tr key={t.abbrev} className={t.nhlTeamId === me ? 'me' : ''}>
                <td>{i + 1}</td>
                <td>
                  {t.name} <span className="dim">({league.teams[t.nhlTeamId].abbr})</span>
                  {league.ahl!.champion === t.nhlTeamId && <span className="pill accent">Calder Cup</span>}
                </td>
                <td className="num">{t.gp}</td>
                <td className="num">{t.w}</td>
                <td className="num">{t.l}</td>
                <td className="num">{t.otl}</td>
                <td className="num">
                  <b>{t.w * 2 + t.otl}</b>
                </td>
                <td className="num">{t.gf}</td>
                <td className="num">{t.ga}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {tab === 'leaders' && (
        <table className="tbl">
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th>Team</th>
              <th className="num">GP</th>
              <th className="num">G</th>
              <th className="num">A</th>
              <th className="num">PTS</th>
            </tr>
          </thead>
          <tbody>
            {leaders.map(({ p, l }, i) => (
              <tr key={p.id} className={p.teamId === me ? 'me' : ''}>
                <td>{i + 1}</td>
                <td>
                  <PlayerLink p={p} />
                </td>
                <td className="muted">{l.team}</td>
                <td className="num">{l.gp}</td>
                <td className="num">{l.g}</td>
                <td className="num">{l.a}</td>
                <td className="num">
                  <b>{l.g + l.a}</b>
                </td>
              </tr>
            ))}
            {!leaders.length && (
              <tr>
                <td colSpan={7} className="muted">
                  The AHL season hasn't started.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </Card>
  );
}
