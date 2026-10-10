import { useEffect, useMemo } from 'react';
import { useGame } from '../store';
import { Card, PlayerLink, Pos, TeamLink, TeamLogo } from '../components/common';
import { findSeries, playoffRoundName } from '../../engine/league/playoffs';
import { bracketStorylines, headToHead, lastTitle, pastMeetings, pathToTitle, seriesGames, seriesGoalies, seriesLeaders, seriesStatus, seriesStorylines, type StoryLine } from '../../engine/league/playoffStory';
import { AWARD_NAMES } from '../../engine/league/awards';
import { points as recPoints } from '../../engine/league/helpers';
import { points as statPoints } from '../../engine/core/statline';
import type { League, PlayoffSeries } from '../../engine/types';
import { shortDate, seasonLabel } from '../format';
import { href } from '../router';
import { sfx } from '../audio/sfx';

const toneCls = (t: StoryLine['tone']) => (t === 'hot' ? 'txt-warn' : t === 'good' ? 'txt-good' : t === 'bad' ? 'txt-bad' : '');

export function Storylines({ lines, empty }: { lines: StoryLine[]; empty?: string }) {
  if (!lines.length) return empty ? <span className="muted">{empty}</span> : null;
  return (
    <ul className="storylines">
      {lines.map((l, i) => (
        <li key={i} className={toneCls(l.tone)}>
          {l.text}
        </li>
      ))}
    </ul>
  );
}

/** Talking points across the whole bracket (shown above it). */
export function BracketStorylines({ league }: { league: League }) {
  const lines = bracketStorylines(league);
  if (!lines.length) return null;
  return (
    <Card title="Playoff storylines">
      <Storylines lines={lines} />
    </Card>
  );
}

const rec = (league: League, id: number) => {
  const r = league.standings[id];
  return r ? `${r.w}-${r.l}-${r.otl}, ${recPoints(r)} pts` : '';
};

function SeriesHead({ league, s }: { league: League; s: PlayoffSeries }) {
  const side = (id: number, seed: number, wins: number) => (
    <div className={`sh-team${s.winner === id ? ' win' : s.winner !== null ? ' lose' : ''}`} style={{ ['--tc' as string]: league.teams[id].colors[0] }}>
      <TeamLogo team={league.teams[id]} size={56} />
      <div className="stack" style={{ gap: 2, minWidth: 0 }}>
        <TeamLink league={league} id={id} />
        <span className="muted" style={{ fontSize: 12 }}>
          {b(league, id)?.label ?? `Seed ${seed}`} · {rec(league, id)}
        </span>
      </div>
      <b className="sh-wins">{wins}</b>
    </div>
  );
  return (
    <div className="series-head">
      {side(s.high, s.highSeed, s.wins[0])}
      <div className="sh-mid muted">{seriesStatus(league, s)}</div>
      {side(s.low, s.lowSeed, s.wins[1])}
    </div>
  );
}
const b = (league: League, id: number) => league.playoffs?.seeds.find((x) => x.teamId === id);

/** One playoff series: the games, the storylines and who's driving it. */
export function SeriesPage({ id }: { id: number }) {
  const { league, version } = useGame();
  const s = findSeries(league, id);
  const data = useMemo(() => {
    if (!s) return null;
    const games = seriesGames(league, s);
    return { games, leaders: seriesLeaders(league, s, games), goalies: seriesGoalies(games), lines: seriesStorylines(league, s, games) };
  }, [league, version, s]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s || !data) return <div className="empty">Series not found. Playoff series are kept until the new season starts.</div>;
  const me = league.userTeamId;
  const h2h = headToHead(league, s.high, s.low);
  const past = pastMeetings(league, s.high, s.low);
  const upcoming = league.schedule.filter((g) => g.playoff?.series === s.id && !g.played).sort((a, c) => a.day - c.day)[0];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{playoffRoundName(league, s.round)}</h1>
          <div className="sub">
            {seasonLabel(league.playoffs?.season ?? league.season)} playoffs · best of {league.config.playoffs.seriesLength[s.round] ?? 7} · <a href={href('standings?view=bracket')}>Bracket</a>
          </div>
        </div>
      </div>
      <SeriesHead league={league} s={s} />
      <div className="grid g2" style={{ alignItems: 'start' }}>
        <div className="stack" style={{ gap: 14 }}>
          <Card title="Storylines">
            <Storylines lines={data.lines} empty="The series hasn't produced a storyline yet." />
          </Card>
          <Card title="Games" tight>
            {data.games.length ? (
              <div className="tbl-scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Gm</th>
                      <th>Date</th>
                      <th>Result</th>
                      <th>Winning goal</th>
                      <th className="num">Series</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.games.map((g) => {
                      const w = league.teams[g.winner];
                      const home = league.teams[g.game.home];
                      const gw = g.gwg != null ? league.players[g.gwg] : undefined;
                      return (
                        <tr key={g.n} className={g.winner === me ? 'me' : ''}>
                          <td>{g.n}</td>
                          <td className="muted">{shortDate(league.season, g.game.day)}</td>
                          <td>
                            <TeamLogo team={w} size={14} /> <b>{w.abbr}</b> {Math.max(g.hiGoals, g.loGoals)}-{Math.min(g.hiGoals, g.loGoals)}
                            {g.ot ? <span className="muted"> {g.otPeriods > 1 ? `${g.otPeriods}OT` : 'OT'}</span> : null}
                            {g.shutout ? <span className="muted"> SO</span> : null}
                            <span className="dim" style={{ fontSize: 11 }}>
                              {' '}
                              at {home.abbr}
                            </span>
                          </td>
                          <td>{gw ? <PlayerLink p={gw} /> : <span className="muted">—</span>}</td>
                          <td className="num">
                            {g.after[0]}-{g.after[1]}
                          </td>
                          <td>
                            <a href={href(`game/${g.game.id}`)}>Box</a>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="muted" style={{ padding: 12 }}>
                {upcoming ? `Game 1 is ${shortDate(league.season, upcoming.day)} at ${league.teams[upcoming.home].abbr}.` : 'No games played yet.'}
              </div>
            )}
            {s.winner === null && upcoming && data.games.length > 0 && (
              <div className="muted" style={{ padding: '8px 12px', fontSize: 12 }}>
                Next: Game {upcoming.playoff!.game}, {shortDate(league.season, upcoming.day)} at {league.teams[upcoming.home].abbr}.
              </div>
            )}
          </Card>
          <Card title="Background">
            <div className="stack" style={{ gap: 6 }}>
              <span>Regular season: {h2h.gp ? `${league.teams[s.high].abbr} ${h2h.a}-${h2h.b} ${league.teams[s.low].abbr}${h2h.ot ? ` (${h2h.ot} past regulation)` : ''}` : 'they did not meet'}.</span>
              {past.length ? (
                past.map((m) => (
                  <span key={`${m.season}-${m.round}`} className="muted">
                    {m.season} {m.roundName}: {league.teams[m.winner].abbr} won {Math.max(...m.wins)}-{Math.min(...m.wins)}
                  </span>
                ))
              ) : (
                <span className="muted">No earlier playoff meetings in this save.</span>
              )}
            </div>
          </Card>
        </div>
        <div className="stack" style={{ gap: 14 }}>
          <Card title="Series scoring" tight>
            {data.leaders.length ? (
              <div className="tbl-scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th className="num">G</th>
                      <th className="num">A</th>
                      <th className="num">P</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.leaders.slice(0, 10).map((l) => {
                      const p = league.players[l.playerId];
                      return (
                        <tr key={l.playerId} className={l.teamId === me ? 'me' : ''}>
                          <td>
                            <TeamLogo team={league.teams[l.teamId]} size={14} /> {p && <Pos pos={p.pos} />} <PlayerLink p={p} />
                          </td>
                          <td className="num">{l.g}</td>
                          <td className="num">{l.a}</td>
                          <td className="num">
                            <b>{l.pts}</b>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="muted" style={{ padding: 12 }}>
                No goals yet.
              </div>
            )}
          </Card>
          <Card title="Goaltending" tight>
            {data.goalies.length ? (
              <div className="tbl-scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Goalie</th>
                      <th className="num">GP</th>
                      <th className="num">SV%</th>
                      <th className="num">GAA</th>
                      <th className="num">SO</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.goalies.map((g) => (
                      <tr key={g.playerId} className={g.teamId === me ? 'me' : ''}>
                        <td>
                          <TeamLogo team={league.teams[g.teamId]} size={14} /> <PlayerLink p={league.players[g.playerId]} />
                        </td>
                        <td className="num">{g.gp}</td>
                        <td className="num">{g.sa ? ((g.sa - g.ga) / g.sa).toFixed(3).replace(/^0/, '') : '—'}</td>
                        <td className="num">{(g.ga / g.gp).toFixed(2)}</td>
                        <td className="num">{g.so}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="muted" style={{ padding: 12 }}>
                No games yet.
              </div>
            )}
            <div className="dim" style={{ fontSize: 11, padding: '6px 12px' }}>
              Starting goaltenders; empty-net goals not counted against them.
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

/** The champions: the Cup, the road to it, and who carried them. */
export function CupPage() {
  const { league } = useGame();
  const bk = league.playoffs;
  const champ = bk?.champion ?? null;
  useEffect(() => {
    if (champ !== null && champ === league.userTeamId) {
      sfx.unlock();
      sfx.goalHorn();
    }
  }, [champ, league.userTeamId]);
  if (!bk || champ === null) return <div className="empty">The {league.config.championship} hasn't been won yet this season.</div>;
  const t = league.teams[champ];
  const path = pathToTitle(league, champ);
  const final = path.at(-1);
  const hist = league.history.find((h) => h.season === bk.season);
  const smythe = hist?.awards.find((a) => a.award === AWARD_NAMES.playoffMvp);
  const smytheP = smythe?.playerId != null ? league.players[smythe.playerId] : undefined;
  const prev = lastTitle(league, champ, bk.season);
  const captain = t.captain != null ? league.players[t.captain] : undefined;
  const finalGames = final ? seriesGames(league, final.series) : [];
  const clincher = finalGames.at(-1);
  const clinchGoal = clincher?.gwg != null ? league.players[clincher.gwg] : undefined;
  const roster = Object.entries(league.seasonStats)
    .filter(([, e]) => e.teamId === champ && e.po.gp > 0)
    .map(([id, e]) => ({ p: league.players[Number(id)], s: e.po }))
    .filter((x) => x.p)
    .sort((a, c) => (a.p.pos === 'G' ? 1 : 0) - (c.p.pos === 'G' ? 1 : 0) || statPoints(c.s) - statPoints(a.s));
  const mine = champ === league.userTeamId;
  return (
    <>
      <div className="cup-hero" style={{ ['--c1' as string]: t.colors[0], ['--c2' as string]: t.colors[1] }}>
        <div className="confetti" aria-hidden>
          {Array.from({ length: 36 }, (_, i) => (
            <i
              key={i}
              style={{ left: `${(i * 37) % 100}%`, animationDelay: `${(i % 9) * 0.35}s`, animationDuration: `${3 + (i % 5) * 0.6}s`, background: i % 3 === 0 ? 'var(--gold)' : i % 3 === 1 ? 'var(--c1)' : 'var(--c2)' }}
            />
          ))}
        </div>
        <TeamLogo team={t} size={96} />
        <div className="stack" style={{ gap: 4 }}>
          <span className="cup-kicker">
            {seasonLabel(bk.season)} {league.config.championship} Champions
          </span>
          <h1 className="cup-title">
            {t.city} {t.name}
          </h1>
          <span>
            {mine ? 'Your club are champions. ' : ''}
            {prev ? `Their first title since ${prev} in this save.` : league.history.filter((h) => h.season < bk.season).length ? 'Their first title in this save.' : ''}
          </span>
        </div>
      </div>
      <div className="grid g2" style={{ alignItems: 'start' }}>
        <div className="stack" style={{ gap: 14 }}>
          <Card title="The moment">
            <div className="stack" style={{ gap: 6 }}>
              {final && clincher && (
                <span>
                  Game {clincher.n} of the Final: {t.abbr} {Math.max(clincher.hiGoals, clincher.loGoals)}, {league.teams[final.opp].abbr} {Math.min(clincher.hiGoals, clincher.loGoals)}
                  {clincher.ot ? (clincher.otPeriods > 1 ? ` in ${clincher.otPeriods}OT` : ' in overtime') : ''}.{clinchGoal ? ` ${clinchGoal.first} ${clinchGoal.last} scored the Cup-winning goal.` : ''}{' '}
                  <a href={href(`game/${clincher.game.id}`)}>Box score</a>
                </span>
              )}
              {captain && (
                <span>
                  Captain <PlayerLink p={captain} /> is the first to lift the {league.config.championship}.
                </span>
              )}
              {smytheP && (
                <span>
                  🏆 Conn Smythe: <PlayerLink p={smytheP} /> ({league.teams[smythe!.teamId].abbr}) — {smythe!.value}
                </span>
              )}
            </div>
          </Card>
          <Card title="The road" tight>
            <table className="tbl">
              <tbody>
                {path.map((r) => (
                  <tr key={r.series.id}>
                    <td className="muted">{r.round}</td>
                    <td>
                      <a href={href(`series/${r.series.id}`)}>
                        <TeamLogo team={league.teams[r.opp]} size={16} /> {league.teams[r.opp].city} {league.teams[r.opp].name}
                      </a>
                    </td>
                    <td className="num">
                      <b>
                        {r.mine}-{r.theirs}
                      </b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
        <Card title="Playoff roster" tight>
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Player</th>
                  <th className="num">GP</th>
                  <th className="num">G</th>
                  <th className="num">A</th>
                  <th className="num">P</th>
                </tr>
              </thead>
              <tbody>
                {roster.map(({ p, s }) => (
                  <tr key={p.id}>
                    <td>
                      <Pos pos={p.pos} /> <PlayerLink p={p} />
                      {p.id === t.captain ? <b className="muted"> (C)</b> : null}
                    </td>
                    <td className="num">{s.gp}</td>
                    {p.pos === 'G' ? (
                      <td className="num muted" colSpan={3}>
                        {s.w} W · {s.sa ? ((s.sa - s.ga) / s.sa).toFixed(3).replace(/^0/, '') : '—'} SV%
                      </td>
                    ) : (
                      <>
                        <td className="num">{s.g}</td>
                        <td className="num">{s.a1 + s.a2}</td>
                        <td className="num">
                          <b>{statPoints(s)}</b>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
