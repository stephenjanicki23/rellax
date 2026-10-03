import { useMemo, useState } from 'react';
import { useGame } from '../store';
import { Card, TeamLink, Tabs } from '../components/common';
import { href } from '../router';
import { shortDate } from '../format';
import type { ScheduledGame } from '../../engine/types';
import { playoffRoundName } from '../../engine/league/playoffs';

export function SchedulePage() {
  const { league, version } = useGame();
  const [tab, setTab] = useState<'mine' | 'day'>('mine');
  const [day, setDay] = useState(Math.max(0, league.day - 1));
  const me = league.userTeamId;
  const games = useMemo(
    () => league.schedule.filter((g) => g.home === me || g.away === me).sort((a, b) => a.day - b.day || a.id - b.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [league, version],
  );
  const dayGames = league.schedule.filter((g) => g.day === day);
  const maxDay = league.schedule.reduce((m, g) => Math.max(m, g.day), 0);

  const row = (g: ScheduledGame, perspective?: number) => {
    const r = g.result;
    const home = perspective === undefined ? true : g.home === perspective;
    let res: React.ReactNode = <span className="dim">{g.day === league.day && !g.played ? 'Today' : '—'}</span>;
    if (r) {
      const us = perspective === undefined ? r.hg : home ? r.hg : r.ag;
      const them = perspective === undefined ? r.ag : home ? r.ag : r.hg;
      const w = us > them;
      res = (
        <a href={href(`game/${g.id}`)}>
          {perspective !== undefined && <b className={w ? 'good' : r.ot ? 'warn' : 'bad'}>{w ? 'W' : r.ot ? 'OTL' : 'L'} </b>}
          {perspective === undefined ? `${r.ag}–${r.hg}` : `${us}–${them}`}
          {r.so ? ' SO' : r.ot ? ' OT' : ''}
        </a>
      );
    }
    return (
      <tr key={g.id} className={g.day === league.day && !g.played ? 'me' : ''}>
        <td className="muted">{shortDate(league.season, g.day)}</td>
        {perspective !== undefined ? (
          <td>
            {home ? 'vs' : '@'} <TeamLink league={league} id={home ? g.away : g.home} logo />
          </td>
        ) : (
          <td>
            <TeamLink league={league} id={g.away} logo /> @ <TeamLink league={league} id={g.home} logo />
          </td>
        )}
        <td>{g.playoff ? <span className="pill accent">{playoffRoundName(league, g.playoff.round)} G{g.playoff.game}</span> : ''}</td>
        <td>{res}</td>
        <td className="num muted">{r ? `SOG ${r.as}–${r.hs} · xG ${r.axg.toFixed(1)}–${r.hxg.toFixed(1)}` : ''}</td>
      </tr>
    );
  };

  return (
    <>
      <div className="page-head">
        <h1>Schedule</h1>
        <span className="sub">
          {games.filter((g) => g.played).length} of {games.length} games played
        </span>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'mine', label: 'My schedule' }, { id: 'day', label: 'League scoreboard' }]} />
      {tab === 'mine' ? (
        <Card tight>
          <table className="tbl">
            <tbody>{games.map((g) => row(g, me))}</tbody>
          </table>
        </Card>
      ) : (
        <Card
          tight
          title={<h3>{shortDate(league.season, day)}</h3>}
          right={
            <div className="row">
              <button className="btn small" onClick={() => setDay((d) => Math.max(0, d - 1))}>◀</button>
              <input type="range" min={0} max={maxDay} value={day} onChange={(e) => setDay(Number(e.target.value))} />
              <button className="btn small" onClick={() => setDay((d) => Math.min(maxDay, d + 1))}>▶</button>
            </div>
          }
        >
          {dayGames.length ? (
            <table className="tbl">
              <tbody>{dayGames.map((g) => row(g))}</tbody>
            </table>
          ) : (
            <div className="empty">No games on this day.</div>
          )}
        </Card>
      )}
    </>
  );
}
