import { useGame } from '../store';
import { Card, PlayerLink, TeamLogo, TeamLink } from '../components/common';
import { dateForDay } from '../format';
import { periodLabel } from '../../engine/sim/commentary';
import { playoffRoundName } from '../../engine/league/playoffs';

export function GameRecap({ id }: { id: number }) {
  const { league } = useGame();
  const g = league.schedule.find((x) => x.id === id);
  if (!g || !g.result) return <div className="empty">Game not found or not played yet.</div>;
  const r = g.result;
  const home = league.teams[g.home];
  const away = league.teams[g.away];
  const periods = Math.max(3, ...r.goals.map((x) => x.p));
  const byPeriod = (team: 0 | 1, p: number) => r.goals.filter((x) => x.team === team && x.p === p).length;
  const mmss = (t: number) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  return (
    <>
      <div className="page-head">
        <h1>Box score</h1>
        <span className="sub">
          {dateForDay(league.season, g.day)} · {home.arena}
          {g.playoff ? ` · ${playoffRoundName(league, g.playoff.round)}, Game ${g.playoff.game}` : ''}
        </span>
      </div>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="scoreboard">
          <div className="team">
            <TeamLogo team={away} size={52} />
            <b style={{ fontSize: 16 }}><TeamLink league={league} id={away.id} /></b>
            <span className="score" style={{ marginLeft: 'auto' }}>{r.ag}</span>
          </div>
          <div className="clock">
            <div className="big">Final{r.so ? '/SO' : r.ot ? '/OT' : ''}</div>
          </div>
          <div className="team away">
            <TeamLogo team={home} size={52} />
            <b style={{ fontSize: 16 }}><TeamLink league={league} id={home.id} /></b>
            <span className="score" style={{ marginRight: 'auto' }}>{r.hg}</span>
          </div>
        </div>
      </div>
      <div className="grid g-main">
        <div className="grid">
          <Card title="By period" tight>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Team</th>
                  {Array.from({ length: periods }, (_, i) => <th key={i} className="num">{periodLabel(i + 1, !!g.playoff)}</th>)}
                  {r.so && <th className="num">SO</th>}
                  <th className="num">T</th>
                  <th className="num">SOG</th>
                  <th className="num">xG</th>
                  <th className="num">PP</th>
                </tr>
              </thead>
              <tbody>
                {([[1, away, r.ag, r.as, r.axg, r.aPP], [0, home, r.hg, r.hs, r.hxg, r.hPP]] as const).map(([side, t, goals, sog, xg, pp]) => (
                  <tr key={t.id}>
                    <td><TeamLink league={league} id={t.id} short logo /></td>
                    {Array.from({ length: periods }, (_, i) => <td key={i} className="num">{byPeriod(side as 0 | 1, i + 1)}</td>)}
                    {r.so && <td className="num">{goals - r.goals.filter((x) => x.team === side).length}</td>}
                    <td className="num"><b>{goals}</b></td>
                    <td className="num">{sog}</td>
                    <td className="num">{xg.toFixed(2)}</td>
                    <td className="num">{pp ? `${pp[0]}/${pp[1]}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="Scoring summary">
            <div className="list">
              {r.goals.map((x, i) => (
                <div className="item" key={i}>
                  <span className="dim" style={{ minWidth: 70 }}>{periodLabel(x.p, !!g.playoff)} {mmss(x.t)}</span>
                  <TeamLogo team={x.team === 0 ? home : away} size={18} />
                  <span>
                    <PlayerLink p={league.players[x.s]} />
                    {x.a.length ? <span className="muted"> ({x.a.map((a, j) => <span key={a}>{j ? ', ' : ''}<PlayerLink p={league.players[a]} full={false} /></span>)})</span> : <span className="muted"> (unassisted)</span>}
                  </span>
                  {x.str !== 'EV' && <span className="pill accent" style={{ marginLeft: 'auto' }}>{x.str}</span>}
                </div>
              ))}
              {!r.goals.length && <div className="muted">No goals in regulation or overtime.</div>}
            </div>
          </Card>
        </div>
        <div className="grid" style={{ alignContent: 'start' }}>
          <Card title="Three stars">
            <div className="list">
              {r.stars.map((pid, i) => (
                <div className="item" key={pid}>
                  <span className="gold">{'★'.repeat(3 - i)}</span>
                  <PlayerLink p={league.players[pid]} />
                  <span className="muted" style={{ marginLeft: 'auto' }}>{league.players[pid]?.teamId !== null ? league.teams[league.players[pid].teamId!]?.abbr : ''}</span>
                </div>
              ))}
            </div>
          </Card>
          <Card title="Goaltenders">
            <div className="list">
              {[r.aGoalie, r.hGoalie].map((gid, i) =>
                gid !== undefined ? (
                  <div className="item" key={i}>
                    <TeamLogo team={i === 0 ? away : home} size={18} />
                    <PlayerLink p={league.players[gid]} />
                    <span className="muted" style={{ marginLeft: 'auto' }}>{i === 0 ? `${r.hs - r.goals.filter((x) => x.team === 0 && x.str !== 'EN').length} saves` : `${r.as - r.goals.filter((x) => x.team === 1 && x.str !== 'EN').length} saves`}</span>
                  </div>
                ) : null,
              )}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
