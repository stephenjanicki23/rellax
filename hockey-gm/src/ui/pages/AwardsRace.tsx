import { useMemo, useState } from 'react';
import { useGame } from '../store';
import { Card, PlayerLink, Pos, Tabs, TeamLogo } from '../components/common';
import { allStarDay, awardsRace } from '../../engine/league/race';
import { shortDate } from '../format';

/** Who's leading each trophy, the three stars of the week, and the All-Stars. */
export function AwardsRacePage() {
  const { league, version } = useGame();
  const [tab, setTab] = useState<'race' | 'stars' | 'allstars'>('race');
  const race = useMemo(() => awardsRace(league), [league, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const weeks = league.weekly?.season === league.season ? league.weekly.stars : [];
  const as = league.allStars?.season === league.season ? league.allStars : null;
  const me = league.userTeamId;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Awards Race</h1>
          <div className="sub">Where the trophy races stand today, scored the way the season-end voting is.</div>
        </div>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'race', label: 'Trophy race' },
          { id: 'stars', label: `Three stars of the week${weeks.length ? ` (${weeks.length})` : ''}` },
          { id: 'allstars', label: 'All-Stars' },
        ]}
      />
      {tab === 'race' && (
        <div className="grid g2">
          {race.map((r) => (
            <Card key={r.key} title={r.award} tight>
              {r.leaders.length ? (
                <table className="tbl">
                  <tbody>
                    {r.leaders.map((e, i) => {
                      const p = league.players[e.playerId];
                      return (
                        <tr key={e.playerId} className={p?.teamId === me ? 'me' : ''}>
                          <td style={{ width: 24 }}>
                            <b className={i === 0 ? 'txt-good' : ''}>{i + 1}</b>
                          </td>
                          <td>
                            {p && <Pos pos={p.pos} />} <PlayerLink p={p} /> <TeamLogo team={league.teams[e.teamId]} size={14} />
                          </td>
                          <td className="muted" style={{ fontSize: 12 }}>
                            {e.value}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <div className="muted" style={{ padding: 12 }}>
                  Not enough games played yet.
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      {tab === 'stars' && (
        <Card>
          {weeks.length ? (
            <div className="list">
              {weeks.map((w) => (
                <div key={w.day} className="item" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                  <b>Week ending {shortDate(league.season, w.day)}</b>
                  {w.stars.map((s, i) => {
                    const p = league.players[s.playerId];
                    return (
                      <div key={s.playerId} className={`row ${p?.teamId === me ? 'txt-good' : ''}`} style={{ gap: 8 }}>
                        <span style={{ width: 22 }}>{'★'.repeat(3 - i)}</span>
                        <TeamLogo team={league.teams[s.teamId]} size={16} />
                        <PlayerLink p={p} />
                        <span className="muted" style={{ fontSize: 12 }}>
                          {s.line}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ) : (
            <span className="muted">The first three stars are named after the first full week of the season.</span>
          )}
        </Card>
      )}
      {tab === 'allstars' &&
        (as ? (
          <div className="grid g2">
            {league.config.conferences.map((c) => (
              <Card key={c.id} title={`${c.name} Conference`} right={<span className="muted" style={{ fontSize: 12 }}>Named {shortDate(league.season, as.day)}</span>} tight>
                <table className="tbl">
                  <tbody>
                    {(as.rosters[c.id] ?? [])
                      .map((id) => league.players[id])
                      .filter(Boolean)
                      .sort((a, b) => (a.pos === 'G' ? 2 : a.pos === 'D' ? 1 : 0) - (b.pos === 'G' ? 2 : b.pos === 'D' ? 1 : 0))
                      .map((p) => (
                        <tr key={p.id} className={p.teamId === me ? 'me' : ''}>
                          <td>
                            <Pos pos={p.pos} />
                          </td>
                          <td>
                            <PlayerLink p={p} />
                          </td>
                          <td>{p.teamId !== null && <TeamLogo team={league.teams[p.teamId]} size={16} />}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <span className="muted">All-Star rosters are named around {shortDate(league.season, allStarDay(league))}: 12 forwards, 6 defencemen and 3 goalies per conference, every club represented.</span>
          </Card>
        ))}
    </>
  );
}
