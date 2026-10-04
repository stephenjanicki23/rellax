import { useMemo, useState } from 'react';
import { coachChangeFamiliarity } from '../../engine/team/fit';
import { useGame, mutate, toast } from '../store';
import { useRoute } from '../router';
import { Card, Table, TeamLogo, TeamLink, Tabs, Stat, LineChart, type Column } from '../components/common';
import { playerColumns } from '../playerCells';
import { playersOf, points } from '../../engine/league/helpers';
import { recordString } from '../../engine/league/standings';
import { teamStrength } from '../../engine/team/strength';
import { payroll, fmtMoney } from '../../engine/economy/contracts';
import { coachOverall, PHILOSOPHY_LABEL } from '../../engine/team/coaching';
import { attr20 } from '../../engine/player/ability';
import type { Coach } from '../../engine/types';
import { seasonLabel } from '../format';

export function TeamPage({ id }: { id: number }) {
  const { league, version } = useGame();
  const r = useRoute();
  const [tab, setTab] = useState<'roster' | 'staff' | 'history' | 'prospects'>((r.query.get('tab') as 'staff') ?? 'roster');
  const team = league.teams[id];
  const roster = useMemo(() => (team ? playersOf(league, team.id) : []), [league, version, team]);
  const prospects = useMemo(() => (team ? playersOf(league, team.id, ['prospect']) : []), [league, version, team]);
  if (!team) return <div className="empty">Team not found.</div>;
  const rec = league.standings[team.id];
  const st = teamStrength(league, team.id);
  const mine = team.id === league.userTeamId;
  const staff: { role: string; c: Coach | undefined }[] = [
    { role: 'Head coach', c: team.staff.headCoach !== null ? league.coaches[team.staff.headCoach] : undefined },
    { role: 'Assistant coach', c: team.staff.assistant !== null ? league.coaches[team.staff.assistant] : undefined },
    { role: 'Goaltending coach', c: team.staff.goalieCoach !== null ? league.coaches[team.staff.goalieCoach] : undefined },
  ];
  const history = league.history.map((h) => ({ season: h.season, row: h.standings.find((s) => s.teamId === team.id)! })).filter((x) => x.row);
  const available = Object.values(league.coaches).filter((c) => c.teamId === null && !c.retired);

  const hire = (c: Coach) => {
    mutate((l) => {
      const t = l.teams[team.id];
      const slot = c.role === 'head' ? 'headCoach' : c.role === 'goalie' ? 'goalieCoach' : 'assistant';
      const old = t.staff[slot];
      if (old !== null) {
        l.coaches[old].teamId = null;
        l.coaches[old].contract = null;
      }
      c.teamId = t.id;
      c.hiredSeason = l.season;
      c.contract = { salary: 1000 + c.reputation * 25, years: 3 };
      t.staff[slot] = c.id;
      // A new head coach means a new system to learn.
      if (slot === 'headCoach') coachChangeFamiliarity(t);
    });
    toast(`${c.first} ${c.last} hired.`, 'good');
  };

  const coachCols: Column<Coach>[] = [
    { key: 'name', label: 'Coach', render: (c) => `${c.first} ${c.last}`, sort: (c) => c.last, defaultDesc: false },
    { key: 'role', label: 'Role', render: (c) => c.role },
    { key: 'ph', label: 'Philosophy', render: (c) => <span className="muted" title={c.styleNote ?? ''}>{PHILOSOPHY_LABEL[c.philosophy]}{c.styleNote ? ` — ${c.styleNote}` : ''}</span> },
    { key: 'ovr', label: 'Ovr', num: true, render: (c) => attr20(coachOverall(c)), sort: (c) => coachOverall(c) },
    { key: 'off', label: 'Off', num: true, render: (c) => attr20(c.ratings.offense) },
    { key: 'def', label: 'Def', num: true, render: (c) => attr20(c.ratings.defense) },
    { key: 'dev', label: 'Dev', num: true, render: (c) => attr20(c.ratings.development) },
    { key: 'gk', label: 'GK', num: true, render: (c) => attr20(c.ratings.goaltending) },
    { key: 'mot', label: 'Mot', num: true, render: (c) => attr20(c.ratings.motivation) },
    { key: 'tac', label: 'Tac', num: true, render: (c) => attr20(c.ratings.tactics) },
    ...(mine ? [{ key: 'h', label: '', render: (c: Coach) => <button className="btn small primary" onClick={() => hire(c)}>Hire</button> }] : []),
  ];

  return (
    <>
      <div className="page-head">
        <TeamLogo team={team} size={52} />
        <div>
          <h1>
            {team.city} {team.name}
          </h1>
          <div className="sub">
            {league.config.divisions.find((d) => d.id === team.divisionId)?.name} Division · {team.arena} · Owner: {team.owner} · GM {mine ? 'You' : team.gm.name}
          </div>
        </div>
      </div>
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <Card><Stat k="Record" v={rec ? recordString(rec) : '—'} sub={rec ? `${points(rec)} pts · GF ${rec.gf} GA ${rec.ga}` : ''} /></Card>
        <Card><Stat k="Roster strength" v={st.overall.toFixed(1)} sub={`F ${st.forwards.toFixed(0)} · D ${st.defense.toFixed(0)} · G ${st.goalie.toFixed(0)}`} /></Card>
        <Card><Stat k="Payroll" v={fmtMoney(payroll(league, team.id))} sub={`Budget ${fmtMoney(team.budget)} · ${team.strategy}`} /></Card>
        <Card><Stat k="Reputation" v={team.reputation} sub={`Facilities ${attr20(team.facilities)}/20 · Market ${team.marketSize}/5`} /></Card>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'roster', label: 'Roster' }, { id: 'prospects', label: `Prospects (${prospects.length})` }, { id: 'staff', label: 'Staff' }, { id: 'history', label: 'History' }]} />
      {tab === 'roster' && (
        <Card tight>
          <Table rows={roster} columns={playerColumns(league, { stats: true, contract: true })} rowKey={(p) => p.id} initialSort={{ key: 'ca' }} />
        </Card>
      )}
      {tab === 'prospects' && (
        <Card tight>
          <Table rows={prospects} columns={playerColumns(league, {})} rowKey={(p) => p.id} initialSort={{ key: 'pa' }} />
        </Card>
      )}
      {tab === 'staff' && (
        <div className="grid">
          <Card title="Coaching staff" tight>
            <Table rows={staff.filter((s) => s.c).map((s) => s.c!)} columns={coachCols.filter((c) => c.key !== 'h')} rowKey={(c) => c.id} />
          </Card>
          {mine && (
            <Card title="Available coaches" right={<span className="muted">Hiring replaces the current coach in that role.</span>} tight>
              <Table rows={available} columns={coachCols} rowKey={(c) => c.id} initialSort={{ key: 'ovr' }} />
            </Card>
          )}
          <Card title="Rivals">
            <div className="row">
              {Object.entries(team.rivals)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([tid, v]) => (
                  <span key={tid} className="pill">
                    <TeamLink league={league} id={Number(tid)} short /> {v}
                  </span>
                ))}
              {!Object.keys(team.rivals).length && <span className="muted">Rivalries develop through division battles and playoff series.</span>}
            </div>
          </Card>
        </div>
      )}
      {tab === 'history' && (
        <div className="grid g-main">
          <Card title="Season by season" tight>
            <table className="tbl">
              <thead>
                <tr><th>Season</th><th className="num">W</th><th className="num">L</th><th className="num">OTL</th><th className="num">PTS</th><th className="num">GF</th><th className="num">GA</th><th>Playoffs</th></tr>
              </thead>
              <tbody>
                {[...history].reverse().map((h) => (
                  <tr key={h.season}>
                    <td>{seasonLabel(h.season)}</td>
                    <td className="num">{h.row.w}</td>
                    <td className="num">{h.row.l}</td>
                    <td className="num">{h.row.otl}</td>
                    <td className="num"><b>{h.row.pts}</b></td>
                    <td className="num">{h.row.gf}</td>
                    <td className="num">{h.row.ga}</td>
                    <td className={h.row.playoff === 'Champion' ? 'gold' : h.row.playoff === 'DNQ' ? 'dim' : ''}>{h.row.playoff === 'Champion' ? `♛ ${league.config.championship}` : h.row.playoff}</td>
                  </tr>
                ))}
                {!history.length && <tr><td colSpan={8} className="muted">No completed seasons yet.</td></tr>}
              </tbody>
            </table>
          </Card>
          <Card title="Points by season">
            <LineChart series={[{ label: 'Points', color: 'var(--accent)', values: history.map((h) => h.row.pts) }]} />
            <div className="muted" style={{ marginTop: 8 }}>
              Championships: <b className="gold">{league.history.filter((h) => h.champion === team.id).length}</b>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
