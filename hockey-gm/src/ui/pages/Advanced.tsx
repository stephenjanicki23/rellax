import { useMemo, useState } from 'react';
import { useGame } from '../store';
import { navigate, href } from '../router';
import { Card, PlayerLink, Pos, Seg, Table, TeamLink, Bar, type Column } from '../components/common';
import { PLAYER_METRICS, TEAM_METRICS, leaders, percentileOf, playerMetric, rankOf, seasonRows, teamMetric, teamTotals, type Fmt, type PlayerMetric, type PlayerRow, type TeamMetric } from '../../engine/league/advanced';
import { fmtToi } from '../../engine/core/statline';
import { fmtMoney } from '../../engine/economy/contracts';
import { seasonLabel } from '../format';

export function fmtMetric(v: number, f: Fmt): string {
  if (!Number.isFinite(v)) return '—';
  switch (f) {
    case 'pct':
      return `${(v * 100).toFixed(1)}%`;
    case 'sv':
      return v ? v.toFixed(3).replace(/^0/, '') : '—';
    case 'num1':
      return v.toFixed(1);
    case 'num2':
      return v.toFixed(2);
    case 'signed1':
      return `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
    case 'toi':
      return fmtToi(v);
  }
}

export const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`;
const rankCls = (rank: number, of: number) => (rank <= Math.max(3, of * 0.16) ? 'txt-good' : rank > of - Math.max(3, of * 0.16) ? 'txt-bad' : 'muted');
const pctColor = (p: number) => (p >= 80 ? 'var(--good)' : p >= 50 ? 'var(--accent)' : p >= 20 ? 'var(--warn)' : 'var(--bad)');

function useAdvanced() {
  const { league, version } = useGame();
  return useMemo(() => {
    const { rows, season } = seasonRows(league);
    const teams = teamTotals(league, rows);
    return { rows, season, teams };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [league, version]);
}

/** League rankings of advanced stats for teams, skaters and goalies. */
export function AdvancedPage() {
  const { league } = useGame();
  const { rows, season, teams } = useAdvanced();
  const [tab, setTab] = useState<'teams' | 'skaters' | 'goalies'>('teams');
  const [pos, setPos] = useState<'all' | 'F' | 'D'>('all');
  const [mine, setMine] = useState(false);
  const me = league.userTeamId;
  const live = season === league.season;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Advanced Stats</h1>
          <div className="sub">
            {seasonLabel(season)} regular season{live ? '' : ' (no games played yet this season)'}. Click any team stat to see the players who lead the league in it.
          </div>
        </div>
      </div>
      <Seg value={tab} onChange={setTab} options={[{ id: 'teams', label: 'Teams' }, { id: 'skaters', label: 'Skaters' }, { id: 'goalies', label: 'Goalies' }]} />
      <div style={{ height: 10 }} />
      {tab === 'teams' && <TeamsView teams={teams} me={me} />}
      {tab !== 'teams' && (
        <>
          <div className="row" style={{ marginBottom: 10, gap: 10, flexWrap: 'wrap' }}>
            {tab === 'skaters' && <Seg value={pos} onChange={setPos} options={[{ id: 'all', label: 'All skaters' }, { id: 'F', label: 'Forwards' }, { id: 'D', label: 'Defence' }]} />}
            <Seg value={mine ? 'mine' : 'all'} onChange={(v) => setMine(v === 'mine')} options={[{ id: 'all', label: 'League' }, { id: 'mine', label: league.teams[me].name }]} />
            <span className="muted" style={{ fontSize: 12 }}>Ranks and colours are among qualified players (shaded cells don't qualify yet). Leaderboards:</span>
            {PLAYER_METRICS.filter((m) => m.group === (tab === 'goalies' ? 'goalie' : 'skater')).map((m) => (
              <a key={m.key} className="pill" href={href(`leaders/${m.key}`)} title={m.desc}>
                {m.short}
              </a>
            ))}
          </div>
          <PlayersView rows={rows} group={tab === 'goalies' ? 'goalie' : 'skater'} pos={pos} teamId={mine ? me : undefined} />
        </>
      )}
    </>
  );
}

function TeamsView({ teams, me }: { teams: ReturnType<typeof teamTotals>; me: number }) {
  const { league } = useGame();
  const values = useMemo(() => Object.fromEntries(TEAM_METRICS.map((m) => [m.key, teams.map((t) => m.value(t))])), [teams]);
  const mineT = teams.find((t) => t.teamId === me)!;
  const cell = (m: TeamMetric, t: (typeof teams)[number]) => {
    const v = m.value(t);
    const rank = rankOf(v, values[m.key], m.better);
    return (
      <a href={href(`leaders/${m.key}`)} title={`${m.label}: ${ordinal(rank)} in the league. Click for the league leaders.`} style={{ color: 'inherit' }}>
        {fmtMetric(v, m.fmt)} <span className={rankCls(rank, teams.length)} style={{ fontSize: 10 }}>{ordinal(rank)}</span>
      </a>
    );
  };
  const cols: Column<(typeof teams)[number]>[] = [
    { key: 'team', label: 'Team', render: (t) => <TeamLink league={league} id={t.teamId} logo short />, sort: (t) => league.teams[t.teamId].abbr, defaultDesc: false },
    ...TEAM_METRICS.map((m) => ({ key: m.key, label: m.short, title: m.desc, num: true, render: (t: (typeof teams)[number]) => cell(m, t), sort: (t: (typeof teams)[number]) => (m.better === 'high' ? m.value(t) : -m.value(t)) })),
  ];
  return (
    <>
      <Card title={`${league.teams[me].city} ${league.teams[me].name}: where you rank`}>
        <div className="adv-tiles">
          {TEAM_METRICS.map((m) => {
            const v = m.value(mineT);
            const rank = rankOf(v, values[m.key], m.better);
            return (
              <button key={m.key} className="adv-tile" onClick={() => navigate(`leaders/${m.key}`)} title={`${m.desc} Click for the players who lead the league in this.`}>
                <span className="k">{m.short}</span>
                <b>{fmtMetric(v, m.fmt)}</b>
                <span className={rankCls(rank, teams.length)}>{ordinal(rank)}</span>
              </button>
            );
          })}
        </div>
      </Card>
      <div style={{ height: 12 }} />
      <Card tight>
        <Table rows={teams} columns={cols} rowKey={(t) => t.teamId} rowClass={(t) => (t.teamId === me ? 'me' : undefined)} initialSort={{ key: 'xgfp' }} />
      </Card>
    </>
  );
}

function PlayersView({ rows, group, pos, teamId }: { rows: PlayerRow[]; group: 'skater' | 'goalie'; pos: 'all' | 'F' | 'D'; teamId?: number }) {
  const { league } = useGame();
  const metrics = PLAYER_METRICS.filter((m) => m.group === group);
  const pool = rows.filter((r) => (group === 'goalie' ? r.p.pos === 'G' : r.p.pos !== 'G'));
  // Distributions among qualified players across the league (for colours), whatever the filters.
  const dist = useMemo(() => Object.fromEntries(metrics.map((m) => [m.key, pool.filter((r) => m.qualifies(r.s)).map((r) => m.value(r.s))])), [pool, metrics]);
  const shown = pool
    .filter((r) => pos === 'all' || (pos === 'D' ? r.p.pos === 'D' : r.p.pos !== 'D'))
    .filter((r) => teamId === undefined || r.teamId === teamId)
    .filter((r) => (group === 'goalie' ? r.s.gtoi >= 60 * 60 : r.s.toi >= 60 * 60));
  const cols: Column<PlayerRow>[] = [
    { key: 'pos', label: 'Pos', render: (r) => <Pos pos={r.p.pos} /> },
    { key: 'name', label: 'Player', render: (r) => <PlayerLink p={r.p} />, sort: (r) => r.p.last, defaultDesc: false },
    { key: 'team', label: 'Team', render: (r) => <TeamLink league={league} id={r.teamId} short />, sort: (r) => league.teams[r.teamId]?.abbr ?? '' },
    { key: 'gp', label: 'GP', num: true, render: (r) => r.s.gp, sort: (r) => r.s.gp },
    ...metrics.map((m) => ({
      key: m.key,
      label: m.short,
      title: m.desc,
      num: true,
      render: (r: PlayerRow) => {
        const v = m.value(r.s);
        if (!m.qualifies(r.s)) return <span className="dim">{fmtMetric(v, m.fmt)}</span>;
        const p = percentileOf(v, dist[m.key], m.better);
        return <span style={{ color: pctColor(p) }} title={`${p}th percentile`}>{fmtMetric(v, m.fmt)}</span>;
      },
      sort: (r: PlayerRow) => (m.qualifies(r.s) ? (m.better === 'high' ? m.value(r.s) : -m.value(r.s)) : -1e9),
    })),
  ];
  return (
    <Card tight>
      <Table rows={shown} columns={cols} rowKey={(r) => `${r.p.id}-${r.teamId}`} rowClass={(r) => (r.teamId === league.userTeamId ? 'me' : undefined)} initialSort={{ key: group === 'goalie' ? 'gsax' : 'p60' }} limit={300} />
    </Card>
  );
}

/** Leaders in one stat: the team ranking (for team stats) and the players who lead the league in it. */
export function StatLeadersPage({ statKey }: { statKey: string }) {
  const { league } = useGame();
  const { rows, season, teams } = useAdvanced();
  const tm = teamMetric(statKey);
  const pm: PlayerMetric | undefined = playerMetric(tm ? tm.player : statKey);
  const [top, setTop] = useState(10);
  const [pos, setPos] = useState<'all' | 'F' | 'D'>('all');
  const [others, setOthers] = useState(false);
  const me = league.userTeamId;
  if (!pm) return <div className="card empty">Unknown stat.</div>;
  const list = leaders(rows, pm, { pos, excludeTeam: others ? me : undefined });
  const all = leaders(rows, pm, { pos });
  const mineBest = all.find((x) => x.row.teamId === me);
  const mineRank = mineBest ? all.indexOf(mineBest) + 1 : null;
  const teamVals = tm ? teams.map((t) => ({ t, v: tm.value(t) })).sort((a, b) => (tm.better === 'high' ? b.v - a.v : a.v - b.v)) : [];
  // Bars show how far each team is from the worst in the league (share stats all sit near 50%).
  const lo = teamVals.length ? Math.min(...teamVals.map((x) => x.v)) : 0;
  const hi = teamVals.length ? Math.max(...teamVals.map((x) => x.v)) : 1;
  const goodness = (v: number) => (hi - lo < 1e-9 ? 1 : 0.12 + 0.88 * (tm?.better === 'low' ? (hi - v) / (hi - lo) : (v - lo) / (hi - lo)));
  const myTeamRank = teamVals.findIndex((x) => x.t.teamId === me) + 1;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{tm ? tm.label : pm.label}</h1>
          <div className="sub">{tm ? tm.desc : pm.desc} {seasonLabel(season)} regular season.</div>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => navigate('advanced')}>All advanced stats</button>
        </div>
      </div>
      <div className={tm ? 'grid g-main' : ''} style={{ alignItems: 'start' }}>
        <Card
          title={tm ? `Top players: ${pm.label}` : 'League leaders'}
          right={
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <Seg value={String(top)} onChange={(v) => setTop(Number(v))} options={[{ id: '5', label: 'Top 5' }, { id: '10', label: 'Top 10' }, { id: '25', label: 'Top 25' }]} />
              {pm.group === 'skater' && <Seg value={pos} onChange={setPos} options={[{ id: 'all', label: 'All' }, { id: 'F', label: 'F' }, { id: 'D', label: 'D' }]} />}
              <label className="row muted" style={{ fontSize: 12, gap: 4 }}>
                <input type="checkbox" checked={others} onChange={(e) => setOthers(e.target.checked)} /> Other teams only
              </label>
            </div>
          }
          tight
        >
          {tm && <div className="muted" style={{ padding: '8px 12px 0', fontSize: 12 }}>{pm.desc}</div>}
          <table className="tbl">
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th>Team</th>
                <th className="num">Age</th>
                <th className="num">{pm.short}</th>
                <th className="num">GP</th>
                <th className="num">Cap hit</th>
                <th className="num">Yrs</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.slice(0, top).map(({ row, value }, i) => (
                <tr key={row.p.id} className={row.teamId === me ? 'me' : ''}>
                  <td className="rank">{i + 1}</td>
                  <td>
                    <Pos pos={row.p.pos} /> <PlayerLink p={row.p} />
                  </td>
                  <td>
                    <TeamLink league={league} id={row.teamId} short />
                  </td>
                  <td className="num">{league.season - row.p.birthYear}</td>
                  <td className="num">
                    <b>{fmtMetric(value, pm.fmt)}</b>
                  </td>
                  <td className="num muted">{row.s.gp}</td>
                  <td className="num">{row.p.contract ? fmtMoney(row.p.contract.salary) : <span className="dim">—</span>}</td>
                  <td className="num muted">{row.p.contract ? row.p.contract.years : '—'}</td>
                  <td>
                    {row.p.teamId !== me && row.p.teamId !== null && row.p.status === 'active' && (
                      <button className="btn small" onClick={() => navigate(`trades?target=${row.p.id}`)} title="Open the trade builder with this player">
                        Trade for
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!list.length && (
                <tr>
                  <td colSpan={9} className="muted">
                    Nobody qualifies yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="muted" style={{ padding: '6px 12px 10px', fontSize: 12 }}>
            {mineBest ? (
              <>
                Your best: <PlayerLink p={mineBest.row.p} /> ({fmtMetric(mineBest.value, pm.fmt)}), {ordinal(mineRank!)} of {all.length} qualified.
              </>
            ) : (
              'None of your players qualify yet.'
            )}
          </div>
        </Card>
        {tm && (
          <Card title={`Team ranking${myTeamRank ? `: you're ${ordinal(myTeamRank)}` : ''}`} tight>
            <table className="tbl">
              <tbody>
                {teamVals.map(({ t, v }, i) => (
                  <tr key={t.teamId} className={t.teamId === me ? 'me' : ''}>
                    <td className="rank">{i + 1}</td>
                    <td>
                      <TeamLink league={league} id={t.teamId} logo short />
                    </td>
                    <td style={{ width: '45%' }}>
                      <Bar value={goodness(v)} max={1} color={t.teamId === me ? 'var(--accent)' : 'var(--line-2, #556)'} />
                    </td>
                    <td className="num">{fmtMetric(v, tm.fmt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </>
  );
}
