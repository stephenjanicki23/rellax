import { useMemo, useState } from 'react';
import { useGame } from '../store';
import { Card, Table, TeamLink, Tabs } from '../components/common';
import { teamStrength, powerRankings } from '../../engine/team/strength';
import { payroll, fmtMoney } from '../../engine/economy/contracts';
import { coachOverall, coachTotals, PHILOSOPHY_LABEL } from '../../engine/team/coaching';
import { CoachLink, careerRecord, coachAge } from '../components/CoachBits';
import { recordString } from '../../engine/league/standings';
import type { Coach, Team } from '../../engine/types';
import { attr20 } from '../../engine/player/ability';

export function LeaguePage() {
  const { league, version } = useGame();
  const [tab, setTab] = useState<'teams' | 'power' | 'coaches' | 'tx'>('teams');
  const teams = useMemo(
    () => league.teams.map((t) => ({ t, s: teamStrength(league, t.id), pay: payroll(league, t.id) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [league, version],
  );
  const power = useMemo(() => powerRankings(league), [league, version]);
  const coaches = Object.values(league.coaches).filter((c) => !c.retired && c.role === 'head');
  type TR = (typeof teams)[number];
  return (
    <>
      <div className="page-head">
        <h1>{league.name}</h1>
        <span className="sub">
          {league.teams.length} teams · {league.config.conferences.length} conferences · {league.config.divisions.length} divisions · Cap {fmtMoney(league.cap.upper)}
        </span>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'teams', label: 'Teams' }, { id: 'power', label: 'Power rankings' }, { id: 'coaches', label: 'Head coaches' }, { id: 'tx', label: 'Transactions' }]} />
      {tab === 'teams' && (
        <Card tight>
          <Table<TR>
            rows={teams}
            rowKey={(x) => x.t.id}
            initialSort={{ key: 'str' }}
            rowClass={(x) => (x.t.id === league.userTeamId ? 'me' : undefined)}
            columns={[
              { key: 'team', label: 'Team', render: (x) => <TeamLink league={league} id={x.t.id} logo />, sort: (x) => x.t.city, defaultDesc: false },
              { key: 'rec', label: 'Record', render: (x) => recordString(league.standings[x.t.id]) },
              { key: 'str', label: 'Roster', num: true, render: (x) => x.s.overall.toFixed(1), sort: (x) => x.s.overall },
              { key: 'f', label: 'F', num: true, render: (x) => x.s.forwards.toFixed(0), sort: (x) => x.s.forwards },
              { key: 'd', label: 'D', num: true, render: (x) => x.s.defense.toFixed(0), sort: (x) => x.s.defense },
              { key: 'g', label: 'G', num: true, render: (x) => x.s.goalie.toFixed(0), sort: (x) => x.s.goalie },
              { key: 'proj', label: 'Proj. pts', num: true, render: (x) => league.projections[x.t.id] ?? '—', sort: (x) => league.projections[x.t.id] ?? 0 },
              { key: 'strat', label: 'Direction', render: (x) => <span className={`pill ${x.t.strategy === 'contend' ? 'good' : x.t.strategy === 'rebuild' ? 'warn' : ''}`}>{x.t.strategy}</span>, sort: (x) => x.t.strategy },
              { key: 'pay', label: 'Payroll', num: true, render: (x) => fmtMoney(x.pay), sort: (x) => x.pay },
              { key: 'coach', label: 'Coach', render: (x) => { const c = league.coaches[x.t.staff.headCoach ?? -1]; return c ? `${c.first[0]}. ${c.last}` : '—'; } },
              { key: 'gm', label: 'GM', render: (x) => <span className="muted">{x.t.gm.name}</span> },
              { key: 'rep', label: 'Rep', num: true, render: (x) => x.t.reputation, sort: (x) => x.t.reputation },
            ]}
          />
        </Card>
      )}
      {tab === 'power' && (
        <Card tight>
          <table className="tbl">
            <tbody>
              {power.map((p, i) => (
                <tr key={p.teamId} className={p.teamId === league.userTeamId ? 'me' : ''}>
                  <td className="rank">{i + 1}</td>
                  <td><TeamLink league={league} id={p.teamId} logo /></td>
                  <td className="muted">{recordString(league.standings[p.teamId])}</td>
                  <td className="num">{p.score.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {tab === 'coaches' && (
        <Card tight>
          <Table<Coach>
            rows={coaches}
            rowKey={(c) => c.id}
            initialSort={{ key: 'ovr' }}
            columns={[
              { key: 'name', label: 'Coach', render: (c) => <CoachLink c={c} />, sort: (c) => c.last, defaultDesc: false },
              { key: 'team', label: 'Team', render: (c) => (c.teamId !== null ? <TeamLink league={league} id={c.teamId} short /> : <span className="dim">Available</span>) },
              { key: 'age', label: 'Age', num: true, render: (c) => coachAge(league, c) },
              { key: 'ph', label: 'Philosophy', render: (c) => <span className="muted">{PHILOSOPHY_LABEL[c.philosophy]}</span> },
              { key: 'ovr', label: 'Ovr', num: true, render: (c) => <b>{attr20(coachOverall(c))}</b>, sort: (c) => coachOverall(c) },
              { key: 'off', label: 'Off', num: true, render: (c) => attr20(c.ratings.offense), sort: (c) => c.ratings.offense },
              { key: 'def', label: 'Def', num: true, render: (c) => attr20(c.ratings.defense), sort: (c) => c.ratings.defense },
              { key: 'dev', label: 'Dev', num: true, render: (c) => attr20(c.ratings.development), sort: (c) => c.ratings.development },
              { key: 'gk', label: 'GK', num: true, render: (c) => attr20(c.ratings.goaltending), sort: (c) => c.ratings.goaltending },
              { key: 'mot', label: 'Mot', num: true, render: (c) => attr20(c.ratings.motivation), sort: (c) => c.ratings.motivation },
              { key: 'tac', label: 'Tac', num: true, render: (c) => attr20(c.ratings.tactics), sort: (c) => c.ratings.tactics },
              { key: 'st', label: 'ST', title: 'Special teams', num: true, render: (c) => attr20(c.ratings.specialTeams), sort: (c) => c.ratings.specialTeams },
              { key: 'dis', label: 'Disc', title: 'Discipline', num: true, render: (c) => attr20(c.ratings.discipline), sort: (c) => c.ratings.discipline },
              { key: 'gp', label: 'GP', num: true, render: (c) => coachTotals(c).gp, sort: (c) => coachTotals(c).gp },
              { key: 'rec', label: 'Career', num: true, render: (c) => careerRecord(c), sort: (c) => coachTotals(c).w },
              { key: 'cups', label: 'Cups', num: true, render: (c) => coachTotals(c).cups || '', sort: (c) => coachTotals(c).cups },
            ]}
          />
        </Card>
      )}
      {tab === 'tx' && (
        <Card>
          <div className="list">
            {league.transactions.slice(0, 300).map((t) => (
              <div className="item" key={t.id}>
                <span className="pill" style={{ minWidth: 70, textAlign: 'center' }}>{t.kind}</span>
                <span>{t.description}</span>
                <span className="dim" style={{ marginLeft: 'auto' }}>{t.season}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

export type { Team };
