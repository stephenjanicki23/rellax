import { useMemo, useState } from 'react';
import { useGame } from '../store';
import { Card, PlayerLink, Pos, Seg, Table, TeamLink, type Column } from '../components/common';
import type { Player, StatLine, Team } from '../../engine/types';
import { points, savePct, gaa, gsax, hdSavePct, faceoffPct, fmtToi, corsiPct, xgPct, shootingPct, reboundRate } from '../../engine/core/statline';
import { pct, sv, num, seasonLabel } from '../format';
import { ppPct, pkPct } from '../../engine/league/standings';
import { awardsRace } from '../../engine/league/awards';

interface Row {
  p: Player;
  s: StatLine;
  teamId: number;
}

export function StatsPage() {
  const { league, version } = useGame();
  const [tab, setTab] = useState<'skaters' | 'goalies' | 'teams' | 'awards'>('skaters');
  const [po, setPo] = useState(false);
  const seasons = [league.season, ...league.history.map((h) => h.season).filter((s) => s !== league.season).reverse()];
  const [season, setSeason] = useState(league.season);
  const [minGp, setMinGp] = useState(1);
  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    if (season === league.season && Object.keys(league.seasonStats).length && !league.history.some((h) => h.season === season)) {
      for (const [id, e] of Object.entries(league.seasonStats)) {
        const p = league.players[Number(id)];
        const s = po ? e.po : e.reg;
        if (p && s.gp) out.push({ p, s, teamId: e.teamId });
      }
    } else {
      for (const p of Object.values(league.players))
        for (const c of p.career) if (c.season === season && c.playoffs === po && c.stats.gp) out.push({ p, s: c.stats, teamId: c.teamId });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [league, version, season, po]);
  const skaters = rows.filter((r) => r.p.pos !== 'G' && r.s.gp >= minGp);
  const goalies = rows.filter((r) => r.p.pos === 'G' && r.s.gp >= minGp);
  const base: Column<Row>[] = [
    { key: 'pos', label: 'Pos', render: (r) => <Pos pos={r.p.pos} /> },
    { key: 'name', label: 'Player', render: (r) => <PlayerLink p={r.p} />, sort: (r) => r.p.last, defaultDesc: false },
    { key: 'team', label: 'Team', render: (r) => <TeamLink league={league} id={r.teamId} short />, sort: (r) => league.teams[r.teamId]?.abbr ?? '', defaultDesc: false },
    { key: 'gp', label: 'GP', num: true, render: (r) => r.s.gp, sort: (r) => r.s.gp },
  ];
  const n = (k: string, label: string, f: (s: StatLine) => number, fmt: (v: number) => string = (v) => String(v), title?: string): Column<Row> => ({ key: k, label, num: true, title, render: (r) => fmt(f(r.s)), sort: (r) => f(r.s) });
  const skCols: Column<Row>[] = [
    ...base,
    n('g', 'G', (s) => s.g),
    n('a', 'A', (s) => s.a1 + s.a2),
    { ...n('p', 'P', points), render: (r) => <b>{points(r.s)}</b> },
    n('pm', '+/-', (s) => s.pm, (v) => (v > 0 ? `+${v}` : String(v))),
    n('pim', 'PIM', (s) => s.pim),
    n('ppp', 'PPP', (s) => s.ppg + s.ppa, String, 'Power-play points'),
    n('shg', 'SHG', (s) => s.shg),
    n('gwg', 'GWG', (s) => s.gwg),
    n('sog', 'SOG', (s) => s.sog),
    n('shp', 'SH%', shootingPct, (v) => pct(v)),
    n('toi', 'TOI/GP', (s) => s.toi / s.gp, (v) => fmtToi(v)),
    n('pptoi', 'PP TOI', (s) => s.toiPP / s.gp, (v) => fmtToi(v), 'Power-play TOI per game'),
    n('pktoi', 'PK TOI', (s) => s.toiPK / s.gp, (v) => fmtToi(v), 'Penalty-kill TOI per game'),
    n('hits', 'HIT', (s) => s.hits),
    n('blk', 'BLK', (s) => s.blocks),
    n('tk', 'TK', (s) => s.tk),
    n('gv', 'GV', (s) => s.gv),
    n('fo', 'FO%', (s) => (s.fow + s.fol >= 20 ? faceoffPct(s) : 0), (v) => (v ? pct(v) : '—')),
    n('ixg', 'ixG', (s) => s.ixg, (v) => num(v, 1), 'Individual expected goals'),
    n('ixa', 'xA', (s) => s.ixa, (v) => num(v, 1), 'Expected assists (xG of shots after your passes)'),
    n('gax', 'G−xG', (s) => s.g - s.ixg, (v) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1)), 'Goals above expected'),
    n('cf', 'CF%', corsiPct, (v) => pct(v), 'On-ice shot attempt share'),
    n('xgf', 'xGF%', xgPct, (v) => pct(v), 'On-ice expected goal share'),
  ];
  const gCols: Column<Row>[] = [
    ...base,
    n('gs', 'GS', (s) => s.gs),
    n('w', 'W', (s) => s.w),
    n('l', 'L', (s) => s.l),
    n('otl', 'OTL', (s) => s.otl),
    n('sa', 'SA', (s) => s.sa),
    n('ga', 'GA', (s) => s.ga),
    { ...n('sv', 'SV%', savePct, sv), render: (r) => <b>{sv(savePct(r.s))}</b> },
    n('gaa', 'GAA', gaa, (v) => v.toFixed(2)),
    n('so', 'SO', (s) => s.so),
    n('gsax', 'GSAx', gsax, (v) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1)), 'Goals saved above expected'),
    n('hd', 'HDSV%', hdSavePct, sv, 'High-danger save %'),
    n('reb', 'Reb%', reboundRate, (v) => pct(v), 'Rebounds allowed per save'),
  ];
  const teamRows = league.teams.map((t) => ({ t, r: league.standings[t.id] }));
  const tCol = (k: string, label: string, f: (x: (typeof teamRows)[number]) => number, fmt: (v: number) => string = (v) => v.toFixed(2)): Column<{ t: Team; r: (typeof teamRows)[number]['r'] }> => ({ key: k, label, num: true, render: (x) => fmt(f(x)), sort: f });
  const per = (v: number, gp: number) => (gp ? v / gp : 0);
  return (
    <>
      <div className="page-head">
        <h1>Statistics</h1>
        <div className="actions">
          <select value={season} onChange={(e) => setSeason(Number(e.target.value))}>
            {seasons.map((s) => <option key={s} value={s}>{seasonLabel(s)}</option>)}
          </select>
          <Seg value={po ? 'po' : 'reg'} onChange={(v) => setPo(v === 'po')} options={[{ id: 'reg', label: 'Regular season' }, { id: 'po', label: 'Playoffs' }]} />
          <label className="row muted">Min GP <input type="number" value={minGp} min={0} onChange={(e) => setMinGp(Number(e.target.value))} style={{ width: 56 }} /></label>
        </div>
      </div>
      <Seg value={tab} onChange={setTab} options={[{ id: 'skaters', label: `Skaters (${skaters.length})` }, { id: 'goalies', label: `Goalies (${goalies.length})` }, { id: 'teams', label: 'Teams' }, { id: 'awards', label: 'Awards race' }]} />
      <div style={{ height: 10 }} />
      {tab === 'awards' && <AwardsRace />}
      {tab === 'skaters' && <Card tight><Table rows={skaters} columns={skCols} rowKey={(r) => `${r.p.id}-${r.teamId}`} initialSort={{ key: 'p' }} limit={250} /></Card>}
      {tab === 'goalies' && <Card tight><Table rows={goalies} columns={gCols} rowKey={(r) => `${r.p.id}-${r.teamId}`} initialSort={{ key: 'w' }} /></Card>}
      {tab === 'teams' && (
        <Card tight>
          <Table
            rows={teamRows}
            rowKey={(x) => x.t.id}
            initialSort={{ key: 'gf' }}
            columns={[
              { key: 'team', label: 'Team', render: (x) => <TeamLink league={league} id={x.t.id} logo />, sort: (x) => x.t.abbr, defaultDesc: false },
              tCol('gf', 'GF/G', (x) => per(x.r.gf, x.r.gp)),
              tCol('ga', 'GA/G', (x) => per(x.r.ga, x.r.gp)),
              tCol('sf', 'SF/G', (x) => per(x.r.sf, x.r.gp), (v) => v.toFixed(1)),
              tCol('sa', 'SA/G', (x) => per(x.r.sa, x.r.gp), (v) => v.toFixed(1)),
              tCol('cf', 'CF%', (x) => (x.r.cf + x.r.ca ? x.r.cf / (x.r.cf + x.r.ca) : 0.5), (v) => pct(v)),
              tCol('xgf', 'xGF/G', (x) => per(x.r.xgf, x.r.gp)),
              tCol('xga', 'xGA/G', (x) => per(x.r.xga, x.r.gp)),
              tCol('xgp', 'xGF%', (x) => (x.r.xgf + x.r.xga ? x.r.xgf / (x.r.xgf + x.r.xga) : 0.5), (v) => pct(v)),
              tCol('pp', 'PP%', (x) => ppPct(x.r), (v) => pct(v)),
              tCol('pk', 'PK%', (x) => pkPct(x.r), (v) => pct(v)),
              tCol('fo', 'FO%', (x) => (x.r.fow + x.r.fol ? x.r.fow / (x.r.fow + x.r.fol) : 0.5), (v) => pct(v)),
              tCol('hits', 'Hits/G', (x) => per(x.r.hits, x.r.gp), (v) => v.toFixed(1)),
              tCol('blk', 'Blk/G', (x) => per(x.r.blocks, x.r.gp), (v) => v.toFixed(1)),
              tCol('pim', 'PIM/G', (x) => per(x.r.pim, x.r.gp), (v) => v.toFixed(1)),
              tCol('shp', 'SH%', (x) => (x.r.sf ? x.r.gf / x.r.sf : 0), (v) => pct(v)),
              tCol('svp', 'SV%', (x) => (x.r.sa ? 1 - x.r.ga / x.r.sa : 0), (v) => sv(v)),
            ]}
          />
        </Card>
      )}
    </>
  );
}

function AwardsRace() {
  const { league, version } = useGame();
  const races = useMemo(() => awardsRace(league), [league, version]);
  if (!Object.values(league.seasonStats).some((e) => e.reg.gp)) return <div className="card empty">Award races take shape once the season starts.</div>;
  return (
    <div className="grid g3">
      {races.map((r) => (
        <Card key={r.award} title={r.award} tight>
          <table className="tbl">
            <tbody>
              {r.candidates.map((c, i) => (
                <tr key={c.playerId} className={league.players[c.playerId]?.teamId === league.userTeamId ? 'me' : ''}>
                  <td className="rank">{i + 1}</td>
                  <td><PlayerLink p={league.players[c.playerId]} /> <span className="dim">{league.teams[c.teamId]?.abbr}</span></td>
                  <td className="num muted">{c.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  );
}
