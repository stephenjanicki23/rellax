import { CoachLink } from '../components/CoachBits';
import { useMemo } from 'react';
import { useGame, runSim, nextPhase } from '../store';
import { href, navigate } from '../router';
import { Card, Gauge, PlayerLink, Pos, Stat, TeamLink, TeamLogo, moraleLabel } from '../components/common';
import { nextUserGame, userGameToday, teamInjuries } from '../../engine/league/season';
import { standingRows, recordString, leagueRank } from '../../engine/league/standings';
import { TeamRankTiles, ordinal } from '../components/TeamRankTiles';
import { payroll, fmtMoney } from '../../engine/economy/contracts';
import { playersOf, points } from '../../engine/league/helpers';
import { points as statPoints, savePct } from '../../engine/core/statline';
import { injuryLabel } from '../../engine/player/injuries';
import { teamStrength } from '../../engine/team/strength';
import { currentPick } from '../../engine/economy/draft';
import { expiringPlayers, FA_DAYS } from '../../engine/economy/freeAgency';
import { dateForDay, pct, sv, PHASE_LABEL } from '../format';
import { playoffRoundName } from '../../engine/league/playoffs';
import { NewsList } from './News';
import { OwnerCard } from './Owner';
import { describeAsset } from '../../engine/economy/trade';

export function Dashboard() {
  const { league, version } = useGame();
  const team = league.teams[league.userTeamId];
  const rec = league.standings[team.id];
  const data = useMemo(() => {
    const next = nextUserGame(league);
    const today = userGameToday(league);
    const div = standingRows(league, (t) => t.divisionId === team.divisionId);
    const roster = playersOf(league, team.id);
    const scorers = roster
      .map((p) => ({ p, s: league.seasonStats[p.id]?.reg }))
      .filter((x) => x.s && x.s.gp)
      .sort((a, b) => statPoints(b.s!) - statPoints(a.s!));
    const goalies = roster.filter((p) => p.pos === 'G').map((p) => ({ p, s: league.seasonStats[p.id]?.reg })).filter((x) => x.s && x.s.gp);
    const recent = league.schedule
      .filter((g) => g.played && (g.home === team.id || g.away === team.id))
      .sort((a, b) => b.day - a.day || b.id - a.id)
      .slice(0, 6);
    const strengthRank = league.teams.map((t) => ({ id: t.id, s: teamStrength(league, t.id).overall })).sort((a, b) => b.s - a.s).findIndex((x) => x.id === team.id) + 1;
    return { next, today, div, scorers, goalies, recent, injuries: teamInjuries(league, team.id), strengthRank, roster };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [league, version, team]);

  const pay = payroll(league, team.id);
  const morale = moraleLabel(team.morale);
  const banner = phaseBanner();

  function phaseBanner() {
    switch (league.phase) {
      case 'draft': {
        const p = currentPick(league);
        return (
          <div className="banner">
            <b>The {league.season + 1} Entry Draft is under way.</b>
            <span className="muted">{p?.ownerId === team.id ? `You are on the clock with pick #${p.pickNumber}.` : 'CPU teams are making their selections.'}</span>
            <button className="btn primary" style={{ marginLeft: 'auto' }} onClick={() => navigate('draft')}>
              Open draft board
            </button>
          </div>
        );
      }
      case 'resign': {
        const n = expiringPlayers(league, team.id).length;
        return (
          <div className="banner">
            <b>Re-signing period.</b>
            <span className="muted">{n ? `${n} of your players have expiring contracts.` : 'All of your key players are under contract.'} Free agency opens next.</span>
            <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => navigate('contracts')}>
              Manage contracts
            </button>
            <button className="btn primary" onClick={() => void nextPhase()}>
              Open free agency
            </button>
          </div>
        );
      }
      case 'freeAgency':
        return (
          <div className="banner">
            <b>Free agency — day {league.faDay + 1} of {FA_DAYS}.</b>
            <span className="muted">Make offers; players decide as the days pass.</span>
            <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => navigate('freeagency')}>
              Free agent market
            </button>
            <button className="btn primary" onClick={() => void nextPhase()}>
              Advance a day
            </button>
          </div>
        );
      case 'preseason':
        return (
          <div className="banner">
            <b>Training camp.</b>
            <span className="muted">Set your lines and tactics, then start the {league.season} season.</span>
            <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => navigate('lines')}>
              Lines
            </button>
            <button className="btn primary" onClick={() => void nextPhase()}>
              Start season
            </button>
          </div>
        );
      case 'playoffs': {
        const b = league.playoffs;
        const alive = b?.rounds[b.currentRound]?.some((s) => (s.high === team.id || s.low === team.id) && s.winner === null);
        return (
          <div className="banner">
            <b>{b ? playoffRoundName(league, b.currentRound) : 'Playoffs'}</b>
            <span className="muted">{alive ? 'Your team is still alive.' : b?.seeds.some((s) => s.teamId === team.id) ? 'Your season is over.' : 'You missed the playoffs this year.'}</span>
            <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => navigate('standings?view=bracket')}>
              Bracket
            </button>
          </div>
        );
      }
      default:
        return null;
    }
  }

  const next = data.next;
  const opp = next ? league.teams[next.home === team.id ? next.away : next.home] : null;
  const oppRec = opp ? league.standings[opp.id] : null;

  return (
    <>
      <div className="page-head">
        <TeamLogo team={team} size={40} />
        <div>
          <h1>
            {team.city} {team.name}
          </h1>
          <div className="sub">
            {PHASE_LABEL[league.phase]} · {team.arena} · Coach <CoachLink c={league.coaches[team.staff.headCoach ?? -1]} full={false} />
          </div>
        </div>
      </div>
      {banner}
      {league.phase === 'regular' && league.tradeDeadlineDay - league.day >= 0 && league.tradeDeadlineDay - league.day <= 7 && (
        <div className="banner" style={{ marginBottom: 14 }}>
          <b>⏱ {league.tradeDeadlineDay === league.day ? 'Trade deadline today' : `Trade deadline in ${league.tradeDeadlineDay - league.day} day${league.tradeDeadlineDay - league.day === 1 ? '' : 's'}`}</b>
          <span className="muted" style={{ flex: 1 }}>{league.tradeDeadlineDay === league.day ? 'Deals close at 3 PM ET.' : 'Buyers and sellers are working the phones.'}</span>
          <button className="btn small" onClick={() => navigate('deadline')}>
            Deadline Centre
          </button>
        </div>
      )}
      {league.tradeOffers.length > 0 && (
        <div className="banner" style={{ marginBottom: 14 }}>
          <b>📞 {league.tradeOffers.length === 1 ? 'Trade offer' : `${league.tradeOffers.length} trade offers`}</b>
          <span className="muted" style={{ flex: 1, minWidth: 200 }}>
            {league.tradeOffers
              .map((o) => `${league.teams[o.from].abbr} want ${o.get.map((a) => describeAsset(league, a)).join(', ')}`)
              .join(' · ')}
          </span>
          <button className="btn primary small" onClick={() => navigate(`trades?review=${league.tradeOffers[0].id}`)}>
            Review
          </button>
        </div>
      )}
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <Card>
          <Stat k="Record" v={rec ? recordString(rec) : '0-0-0'} sub={`${rec ? points(rec) : 0} pts · ${rec && rec.gp ? pct(points(rec) / (rec.gp * 2)) : '—'} pts%`} />
        </Card>
        <Card>
          <Stat k="Division" v={ordinal(data.div.findIndex((r) => r.team.id === team.id) + 1)} sub={`${ordinal(leagueRank(league, team.id))} in the league · roster ${ordinal(data.strengthRank)}`} />
        </Card>
        <Card>
          <Stat
            k="Form"
            v={rec?.gp ? (rec.streak > 0 ? `W${rec.streak}` : `${rec.last10.at(-1) === 'O' ? 'OT' : 'L'}${-rec.streak}`) : '—'}
            sub={rec?.gp ? `Last 10: ${rec.last10.filter((x) => x === 'W').length}-${rec.last10.filter((x) => x === 'L').length}-${rec.last10.filter((x) => x === 'O').length}` : 'No games yet'}
          />
        </Card>
        <Card>
          <Stat k="Cap space" v={fmtMoney(league.cap.upper - pay)} sub={`Payroll ${fmtMoney(pay)} / ${fmtMoney(league.cap.upper)}`} />
        </Card>
      </div>
      <Card title="Team stats" right={<span className="muted" style={{ fontSize: 12 }}>League rank · top 8 green, bottom 8 red</span>}>
        <TeamRankTiles league={league} teamId={team.id} keys={['gf', 'ga', 'pp', 'pk', 'sf', 'sa']} />
      </Card>
      <div style={{ height: 14 }} />
      <div className="grid g-main">
        <div className="grid">
          <Card title={data.today ? 'Tonight' : 'Next game'}>
            {next && opp ? (
              <div className="row" style={{ gap: 16 }}>
                <TeamLogo team={opp} size={54} />
                <div className="stack" style={{ gap: 2 }}>
                  <b style={{ fontSize: 16 }}>
                    {next.home === team.id ? 'vs' : '@'} {opp.city} {opp.name}
                  </b>
                  <span className="muted">
                    {dateForDay(league.season, next.day)}
                    {next.playoff ? ` · ${playoffRoundName(league, next.playoff.round)}, Game ${next.playoff.game}` : ''}
                  </span>
                  <span className="muted">
                    {oppRec ? `${recordString(oppRec)} · ${points(oppRec)} pts` : ''} · Goalie {league.players[league.teams[opp.id].lines.goalies[0]]?.last ?? '—'}
                  </span>
                </div>
                <div className="row" style={{ marginLeft: 'auto' }}>
                  {data.today ? (
                    <>
                      <button className="btn primary" onClick={() => navigate('live')}>
                        ▶ Play live
                      </button>
                      <button className="btn" onClick={() => void runSim('day')}>
                        Sim game
                      </button>
                    </>
                  ) : (
                    <button className="btn primary" onClick={() => void runSim('toUserGame')}>
                      Sim to game day
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="muted">No games scheduled.</div>
            )}
          </Card>
          <div className="grid g2">
            <Card title="Recent results" tight>
              <div className="list" style={{ padding: '0 14px 8px' }}>
                {data.recent.length === 0 && <div className="empty">No games played yet.</div>}
                {data.recent.map((g) => {
                  const home = g.home === team.id;
                  const us = home ? g.result!.hg : g.result!.ag;
                  const them = home ? g.result!.ag : g.result!.hg;
                  const w = us > them;
                  return (
                    <div className="item" key={g.id}>
                      <b className={w ? 'good' : g.result!.ot ? 'warn' : 'bad'} style={{ width: 22 }}>
                        {w ? 'W' : g.result!.ot ? 'OTL' : 'L'}
                      </b>
                      <span>
                        {us}–{them}
                        {g.result!.so ? ' SO' : g.result!.ot ? ' OT' : ''}
                      </span>
                      <span className="muted">
                        {home ? 'vs' : '@'} <TeamLink league={league} id={home ? g.away : g.home} short />
                      </span>
                      <a style={{ marginLeft: 'auto' }} href={href(`game/${g.id}`)}>
                        Box score
                      </a>
                    </div>
                  );
                })}
              </div>
            </Card>
            <Card title={`${league.config.divisions.find((d) => d.id === team.divisionId)?.name} Division`} tight>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Team</th>
                    <th className="num">GP</th>
                    <th className="num">PTS</th>
                    <th className="num">DIFF</th>
                  </tr>
                </thead>
                <tbody>
                  {data.div.map((r, i) => (
                    <tr key={r.team.id} className={`${r.team.id === team.id ? 'me' : ''} ${i === 2 ? 'cut' : ''}`}>
                      <td>
                        <TeamLink league={league} id={r.team.id} logo />
                      </td>
                      <td className="num">{r.rec.gp}</td>
                      <td className="num">
                        <b>{r.pts}</b>
                      </td>
                      <td className={`num ${r.gd > 0 ? 'good' : r.gd < 0 ? 'bad' : ''}`}>{r.gd > 0 ? `+${r.gd}` : r.gd}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
          <Card title="League news" right={<a href={href('news')}>All news →</a>}>
            <NewsList items={league.news.slice(0, 10)} compact />
          </Card>
        </div>
        <div className="grid" style={{ alignContent: 'start' }}>
          <OwnerCard league={league} />
          <Card title="Team leaders" tight>
            <table className="tbl">
              <tbody>
                {data.scorers.slice(0, 5).map(({ p, s }) => (
                  <tr key={p.id}>
                    <td>
                      <Pos pos={p.pos} /> <PlayerLink p={p} />
                    </td>
                    <td className="num muted">
                      {s!.g}G {s!.a1 + s!.a2}A
                    </td>
                    <td className="num">
                      <b>{statPoints(s!)}</b>
                    </td>
                  </tr>
                ))}
                {data.goalies.map(({ p, s }) => (
                  <tr key={p.id}>
                    <td>
                      <Pos pos="G" /> <PlayerLink p={p} />
                    </td>
                    <td className="num muted">
                      {s!.w}-{s!.l}-{s!.otl}
                    </td>
                    <td className="num">
                      <b>{sv(savePct(s!))}</b>
                    </td>
                  </tr>
                ))}
                {!data.scorers.length && (
                  <tr>
                    <td className="muted">The season hasn't started.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>
          <Card title="Dressing room" right={<a href={href('room')}>Open →</a>}>
            <Gauge value={team.morale} label={`Team morale — ${morale.text}`} />
            <div style={{ height: 10 }} />
            <div className="list">
              {[...data.roster]
                .sort((a, b) => a.morale - b.morale)
                .slice(0, 3)
                .map((p) => (
                  <div className="item" key={p.id}>
                    <PlayerLink p={p} />
                    {p.tradeRequest && <span className="pill warn">wants a trade</span>}
                    <span className={`${moraleLabel(p.morale).cls}`} style={{ marginLeft: 'auto' }}>
                      {moraleLabel(p.morale).text}
                    </span>
                  </div>
                ))}
            </div>
          </Card>
          <Card title={`Injuries (${data.injuries.length})`}>
            {data.injuries.length === 0 ? (
              <div className="muted">Everyone is healthy.</div>
            ) : (
              <div className="list">
                {data.injuries.map((p) => (
                  <div className="item" key={p.id}>
                    <Pos pos={p.pos} /> <PlayerLink p={p} />
                    <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
                      {injuryLabel(p.injury!)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card title="Salary cap">
            <div className="bar" style={{ height: 10 }}>
              <i style={{ width: `${Math.min(100, (pay / league.cap.upper) * 100)}%`, background: pay > league.cap.upper ? 'var(--bad)' : 'var(--accent)' }} />
            </div>
            <div className="row muted" style={{ marginTop: 6, justifyContent: 'space-between' }}>
              <span>Floor {fmtMoney(league.cap.floor)}</span>
              <span>{fmtMoney(pay)}</span>
              <span>Cap {fmtMoney(league.cap.upper)}</span>
            </div>
          </Card>
          <Card title="Club news">
            <NewsList items={league.news.filter((n) => n.teamIds.includes(team.id)).slice(0, 6)} compact />
          </Card>
        </div>
      </div>
    </>
  );
}
