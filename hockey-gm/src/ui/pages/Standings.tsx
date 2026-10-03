import { useMemo, useState } from 'react';
import { useGame } from '../store';
import { useRoute } from '../router';
import { Card, Seg, TeamLink } from '../components/common';
import { standingRows, ppPct, pkPct, conferenceSeeds, type StandingRow } from '../../engine/league/standings';
import { playoffRoundName } from '../../engine/league/playoffs';
import { pct } from '../format';
import type { League, PlayoffSeries } from '../../engine/types';

function StandingsTable({ league, rows, cutAfter }: { league: League; rows: StandingRow[]; cutAfter?: number }) {
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th className="rank">#</th>
            <th>Team</th>
            <th className="num">GP</th>
            <th className="num">W</th>
            <th className="num">L</th>
            <th className="num">OTL</th>
            <th className="num">PTS</th>
            <th className="num">P%</th>
            <th className="num">RW</th>
            <th className="num">ROW</th>
            <th className="num">GF</th>
            <th className="num">GA</th>
            <th className="num">DIFF</th>
            <th className="num">HOME</th>
            <th className="num">AWAY</th>
            <th className="num">L10</th>
            <th className="num">STRK</th>
            <th className="num">PP%</th>
            <th className="num">PK%</th>
            <th className="num">xGF%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const l10 = r.rec.last10;
            const w10 = l10.filter((x) => x === 'W').length;
            const o10 = l10.filter((x) => x === 'O').length;
            const xg = r.rec.xgf + r.rec.xga > 0 ? r.rec.xgf / (r.rec.xgf + r.rec.xga) : 0.5;
            return (
              <tr key={r.team.id} className={`${r.team.id === league.userTeamId ? 'me' : ''} ${cutAfter !== undefined && i === cutAfter - 1 ? 'cut' : ''}`}>
                <td className="rank">{i + 1}</td>
                <td>
                  <TeamLink league={league} id={r.team.id} logo />
                </td>
                <td className="num">{r.rec.gp}</td>
                <td className="num">{r.rec.w}</td>
                <td className="num">{r.rec.l}</td>
                <td className="num">{r.rec.otl}</td>
                <td className="num"><b>{r.pts}</b></td>
                <td className="num">{r.rec.gp ? r.pct.toFixed(3).replace(/^0/, '') : '—'}</td>
                <td className="num">{r.rec.rw}</td>
                <td className="num">{r.rec.row}</td>
                <td className="num">{r.rec.gf}</td>
                <td className="num">{r.rec.ga}</td>
                <td className={`num ${r.gd > 0 ? 'good' : r.gd < 0 ? 'bad' : ''}`}>{r.gd > 0 ? `+${r.gd}` : r.gd}</td>
                <td className="num muted">{r.rec.home.join('-')}</td>
                <td className="num muted">{r.rec.away.join('-')}</td>
                <td className="num muted">{`${w10}-${l10.length - w10 - o10}-${o10}`}</td>
                <td className="num">{r.rec.streak > 0 ? `W${r.rec.streak}` : r.rec.streak < 0 ? `L${-r.rec.streak}` : '—'}</td>
                <td className="num">{r.rec.ppOpp ? pct(ppPct(r.rec)) : '—'}</td>
                <td className="num">{r.rec.tsh ? pct(pkPct(r.rec)) : '—'}</td>
                <td className="num">{pct(xg)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SeriesBox({ league, s }: { league: League; s: PlayoffSeries }) {
  const line = (id: number, seed: number, wins: number) => (
    <div className={s.winner === null ? '' : s.winner === id ? 'win' : 'lose'}>
      <span>
        <span className="dim">{seed}</span> <TeamLink league={league} id={id} short logo />
      </span>
      <b>{wins}</b>
    </div>
  );
  return (
    <div className="series">
      {line(s.high, s.highSeed, s.wins[0])}
      {line(s.low, s.lowSeed, s.wins[1])}
    </div>
  );
}

export function Bracket({ league }: { league: League }) {
  const b = league.playoffs;
  if (!b) return <div className="empty">The playoffs have not started. Current seeding is shown on the Standings tab.</div>;
  return (
    <div className="bracket">
      {b.rounds.map((round, ri) => (
        <div className="col" key={ri}>
          <h3>{playoffRoundName(league, ri)}</h3>
          {round.map((s) => (
            <SeriesBox key={s.id} league={league} s={s} />
          ))}
        </div>
      ))}
      {b.champion !== null && (
        <div className="col">
          <h3>Champion</h3>
          <div className="card" style={{ textAlign: 'center' }}>
            <div className="gold" style={{ fontSize: 28 }}>♛</div>
            <TeamLink league={league} id={b.champion} logo />
          </div>
        </div>
      )}
    </div>
  );
}

export function StandingsPage() {
  const { league, version } = useGame();
  const r = useRoute();
  const [view, setView] = useState<'division' | 'conference' | 'league' | 'wildcard' | 'bracket'>((r.query.get('view') as 'bracket') ?? (league.phase === 'playoffs' ? 'bracket' : 'division'));
  const data = useMemo(() => ({ all: standingRows(league) }), [league, version]);
  return (
    <>
      <div className="page-head">
        <h1>Standings</h1>
        <div className="actions">
          <Seg
            value={view}
            onChange={setView}
            options={[
              { id: 'division', label: 'Division' },
              { id: 'wildcard', label: 'Wild card' },
              { id: 'conference', label: 'Conference' },
              { id: 'league', label: 'League' },
              { id: 'bracket', label: 'Playoffs' },
            ]}
          />
        </div>
      </div>
      {view === 'bracket' && (
        <Card>
          <Bracket league={league} />
        </Card>
      )}
      {view === 'league' && (
        <Card tight>
          <StandingsTable league={league} rows={data.all} />
        </Card>
      )}
      {view === 'conference' &&
        league.config.conferences.map((c) => (
          <Card key={c.id} title={c.name} tight className="">
            <StandingsTable league={league} rows={data.all.filter((x) => x.team.conferenceId === c.id)} cutAfter={league.config.playoffs.teamsPerConference} />
          </Card>
        ))}
      {view === 'division' && (
        <div className="grid">
          {league.config.divisions.map((d) => (
            <Card key={d.id} title={`${d.name} Division`} tight>
              <StandingsTable league={league} rows={data.all.filter((x) => x.team.divisionId === d.id)} cutAfter={league.config.playoffs.format === 'divisional' ? league.config.playoffs.divisionQualifiers : undefined} />
            </Card>
          ))}
        </div>
      )}
      {view === 'wildcard' && (
        <div className="grid">
          {league.config.conferences.map((c) => {
            const seeds = conferenceSeeds(league, c.id);
            const ids = new Set(seeds.map((s) => s.teamId));
            const rows = data.all.filter((x) => x.team.conferenceId === c.id);
            return (
              <Card key={c.id} title={`${c.name} — playoff picture`} tight>
                <StandingsTable league={league} rows={[...rows.filter((x) => ids.has(x.team.id)), ...rows.filter((x) => !ids.has(x.team.id))]} cutAfter={seeds.length} />
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
