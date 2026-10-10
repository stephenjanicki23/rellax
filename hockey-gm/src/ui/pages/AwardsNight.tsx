import { useState } from 'react';
import { mutate, useGame } from '../store';
import { Card, PlayerLink, Pos, TeamLogo } from '../components/common';
import { CoachLink } from '../components/CoachBits';
import { AWARD_NAMES } from '../../engine/league/awards';
import { revealAward, voteShare, type AwardBallot, type AwardsNight, type Finalist } from '../../engine/league/awardsNight';
import type { League } from '../../engine/types';
import { seasonLabel } from '../format';
import { navigate } from '../router';
import { sfx } from '../audio/sfx';

/** Presentation order: the numbers first, the Hart last. */
const ORDER = [
  AWARD_NAMES.playoffMvp,
  AWARD_NAMES.scoring,
  AWARD_NAMES.goals,
  AWARD_NAMES.jennings,
  AWARD_NAMES.byng,
  AWARD_NAMES.selke,
  AWARD_NAMES.rookie,
  AWARD_NAMES.coach,
  AWARD_NAMES.defense,
  AWARD_NAMES.goalie,
  AWARD_NAMES.lindsay,
  AWARD_NAMES.mvp,
];
const ALL_STARS = 'All-Star Teams';

export const shortAward = (a: string) => a.split(' (')[0];
const blurb = (a: string) => a.match(/\(([^)]+)\)/)?.[1] ?? '';

/** This season's awards night, if the trophies have been decided. */
export function currentAwardsNight(league: League): AwardsNight | null {
  const n = league.awardsNight;
  return n && n.season === league.season && (league.phase === 'draft' || league.phase === 'resign' || league.phase === 'freeAgency') ? n : null;
}

export function ballotsInOrder(n: AwardsNight): AwardBallot[] {
  const idx = (a: string) => (ORDER.indexOf(a) < 0 ? 99 : ORDER.indexOf(a));
  return [...n.ballots].sort((a, b) => idx(a.award) - idx(b.award));
}

export function unrevealed(n: AwardsNight): number {
  return n.ballots.filter((b) => !n.revealed.includes(b.award)).length + (n.revealed.includes(ALL_STARS) ? 0 : 1);
}

function Who({ league, f, big = false }: { league: League; f: Finalist; big?: boolean }) {
  const p = f.playerId != null ? league.players[f.playerId] : undefined;
  const c = f.coachId != null ? league.coaches[f.coachId] : undefined;
  return (
    <span
      className="row"
      style={{
        gap: 8,
        fontSize: big ? 18 : undefined,
        flexWrap: 'nowrap',
        minWidth: 0,
      }}
    >
      <TeamLogo team={league.teams[f.teamId]} size={big ? 30 : 18} />
      {p ? (
        <>
          <Pos pos={p.pos} /> <PlayerLink p={p} />
        </>
      ) : c ? (
        <CoachLink c={c} />
      ) : (
        <b>
          {league.teams[f.teamId].city} {league.teams[f.teamId].name}
        </b>
      )}
    </span>
  );
}

function AwardCard({ league, b, shown, onReveal }: { league: League; b: AwardBallot; shown: boolean; onReveal: () => void }) {
  const me = league.userTeamId;
  const voted = b.panel > 0;
  const finalists = b.results.slice(0, voted ? 3 : 1);
  const mine = (f: Finalist) => f.teamId === me;
  const winner = b.results[0];
  return (
    <Card
      className={`award-card${shown ? ' shown' : ''}`}
      title={
        <span>
          🏆 {shortAward(b.award)}{' '}
          <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
            {blurb(b.award)}
          </span>
        </span>
      }
      right={
        <span className="muted" style={{ fontSize: 12 }}>
          {voted ? `${b.voters} · ${b.panel} ballots` : b.note === 'Presented on the ice after the Final.' ? 'Presented after the Final' : 'Decided by the numbers'}
        </span>
      }
    >
      {!shown ? (
        <div className="stack" style={{ gap: 10 }}>
          {voted ? (
            <>
              <span className="muted" style={{ fontSize: 12 }}>
                The finalists, in alphabetical order:
              </span>
              {[...finalists]
                .sort((x, y) => nameOf(league, x).localeCompare(nameOf(league, y)))
                .map((f, i) => (
                  <div key={i} className={`row award-fin${mine(f) ? ' me' : ''}`} style={{ justifyContent: 'space-between' }}>
                    <Who league={league} f={f} />
                    <span className="muted" style={{ fontSize: 12 }}>
                      {f.value}
                    </span>
                  </div>
                ))}
            </>
          ) : (
            <span className="muted">{b.note}</span>
          )}
          <button className="btn primary" onClick={onReveal}>
            And the winner is…
          </button>
        </div>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          <div className={`award-winner${mine(winner) ? ' me' : ''}`}>
            <Who league={league} f={winner} big />
            <span className="muted">{winner.value}</span>
            {voted && (
              <span style={{ fontSize: 12 }}>
                {winner.firsts === b.panel ? (
                  <b className="gold">Unanimous</b>
                ) : (
                  <>
                    {winner.firsts} of {b.panel} first-place votes
                  </>
                )}
              </span>
            )}
          </div>
          {voted ? (
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 20 }}>#</th>
                    <th>Candidate</th>
                    <th className="num" title="First-place votes">
                      1st
                    </th>
                    <th className="num an-named" title="Ballots naming him anywhere">
                      Named
                    </th>
                    <th className="num">Points</th>
                    <th className="an-bar" style={{ width: '22%' }} />
                  </tr>
                </thead>
                <tbody>
                  {b.results.map((f, i) => (
                    <tr key={i} className={mine(f) ? 'me' : ''}>
                      <td>{i + 1}</td>
                      <td>
                        <Who league={league} f={f} />
                      </td>
                      <td className="num">{f.firsts}</td>
                      <td className="num an-named">{f.named}</td>
                      <td className="num">
                        <b>{f.pts}</b>
                      </td>
                      <td className="an-bar">
                        <span className="bar" style={{ height: 6 }}>
                          <i
                            style={{
                              width: `${(voteShare(b, f) * 100).toFixed(1)}%`,
                              background: i === 0 ? 'var(--gold)' : 'var(--accent)',
                            }}
                          />
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            b.results.length > 1 && (
              <table className="tbl">
                <tbody>
                  {b.results.slice(1).map((f, i) => (
                    <tr key={i} className={mine(f) ? 'me' : ''}>
                      <td style={{ width: 20 }}>{i + 2}</td>
                      <td>
                        <Who league={league} f={f} />
                      </td>
                      <td className="muted num">{f.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
          {voted && (
            <span className="dim" style={{ fontSize: 11 }}>
              Points: {b.scale.join('-')} for each place on a ballot. {b.note ?? ''}
            </span>
          )}
        </div>
      )}
    </Card>
  );
}

const nameOf = (league: League, f: Finalist) => {
  if (f.playerId != null) return league.players[f.playerId]?.last ?? '';
  if (f.coachId != null) return league.coaches[f.coachId]?.last ?? '';
  return league.teams[f.teamId].name;
};

function AllStarCard({ league, n, shown, onReveal }: { league: League; n: AwardsNight; shown: boolean; onReveal: () => void }) {
  const me = league.userTeamId;
  return (
    <Card
      className={`award-card award-wide${shown ? ' shown' : ''}`}
      title={<span>⭐ All-Star Teams</span>}
      right={
        <span className="muted" style={{ fontSize: 12 }}>
          Hockey writers · {n.allStars.panel} ballots
        </span>
      }
    >
      {!shown ? (
        <div className="stack" style={{ gap: 10 }}>
          <span className="muted">The writers' first and second teams: a centre, two wingers, two defencemen and a goaltender each.</span>
          <button className="btn primary" onClick={onReveal}>
            Announce the teams
          </button>
        </div>
      ) : (
        <div className="grid g2" style={{ gap: 16 }}>
          {(['first', 'second'] as const).map((k) => (
            <div key={k} className="tbl-scroll">
              <b>{k === 'first' ? 'First team' : 'Second team'}</b>
              <table className="tbl">
                <tbody>
                  {n.allStars[k].map((x) => {
                    const p = league.players[x.playerId];
                    return (
                      <tr key={x.playerId} className={x.teamId === me ? 'me' : ''}>
                        <td style={{ width: 30 }} className="muted">
                          {x.pos}
                        </td>
                        <td>
                          <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                            <TeamLogo team={league.teams[x.teamId]} size={16} /> <PlayerLink p={p} />
                          </span>
                        </td>
                        <td className="muted num" style={{ fontSize: 12 }}>
                          {x.value}
                        </td>
                        <td className="num" title="Ballot points: 3 for a first-team vote, 1 for a second">
                          {x.pts}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
          <span className="dim" style={{ fontSize: 11, gridColumn: '1 / -1' }}>
            Points: 3 for a first-team vote, 1 for a second-team vote (a simplified scale).
          </span>
        </div>
      )}
    </Card>
  );
}

/** The season-end awards ceremony: finalists, the envelope, and the full voting. */
export function AwardsNightPage() {
  const { league } = useGame();
  const [, force] = useState(0);
  const n = league.awardsNight;
  if (!n) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1>Awards Night</h1>
            <div className="sub">The trophies are handed out once the playoffs are over.</div>
          </div>
        </div>
        <Card>
          <span className="muted">No awards night yet. Follow the races on the </span>
          <a href="#/awards">Awards Race</a> page.
        </Card>
      </>
    );
  }
  const ballots = ballotsInOrder(n);
  const me = league.userTeamId;
  const reveal = (award: string) => {
    mutate((l) => l.awardsNight && revealAward(l.awardsNight, award));
    const b = n.ballots.find((x) => x.award === award);
    sfx.unlock();
    if (b?.results[0]?.teamId === me) sfx.goalHorn();
    else sfx.rise();
    force((x) => x + 1);
  };
  const nextUp = ballots.find((b) => !n.revealed.includes(b.award))?.award ?? (n.revealed.includes(ALL_STARS) ? null : ALL_STARS);
  const revealAll = () => {
    mutate((l) => {
      const night = l.awardsNight;
      if (!night) return;
      for (const b of night.ballots) revealAward(night, b.award);
      revealAward(night, ALL_STARS);
    });
    force((x) => x + 1);
  };
  // The user's club on the night.
  const myFinalists = ballots.filter((b) => b.panel > 0 && b.results.slice(0, 3).some((f) => f.teamId === me));
  const myWins = ballots.filter((b) => n.revealed.includes(b.award) && b.results[0]?.teamId === me);
  const myAllStars = n.revealed.includes(ALL_STARS) ? [...n.allStars.first, ...n.allStars.second].filter((x) => x.teamId === me) : [];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Awards Night — {seasonLabel(n.season)}</h1>
          <div className="sub">The season's trophies, from the finalists to the full ballots. The voting is simulated: each voter weighs the season a little differently.</div>
        </div>
        <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
          {nextUp && (
            <button className="btn primary" onClick={() => reveal(nextUp)}>
              Next: {shortAward(nextUp)}
            </button>
          )}
          {nextUp && (
            <button className="btn" onClick={revealAll}>
              Reveal all
            </button>
          )}
          <button className="btn" onClick={() => navigate('awards')}>
            Awards Race
          </button>
        </div>
      </div>
      {(myFinalists.length > 0 || myAllStars.length > 0) && (
        <div className="banner">
          <TeamLogo team={league.teams[me]} size={28} />
          <b>Your club tonight:</b>
          <span className="muted">
            {myFinalists.length ? `${myFinalists.length} finalist${myFinalists.length > 1 ? 's' : ''} (${myFinalists.map((b) => shortAward(b.award)).join(', ')})` : 'no finalists'}
            {myWins.length ? ` · ${myWins.length} trophy${myWins.length > 1 ? ' winners' : ' winner'} so far` : ''}
            {myAllStars.length ? ` · ${myAllStars.length} All-Star team selection${myAllStars.length > 1 ? 's' : ''}` : ''}
          </span>
        </div>
      )}
      <div className="grid g2 awards-night">
        {ballots.map((b) => (
          <AwardCard key={b.award} league={league} b={b} shown={n.revealed.includes(b.award)} onReveal={() => reveal(b.award)} />
        ))}
        <AllStarCard league={league} n={n} shown={n.revealed.includes(ALL_STARS)} onReveal={() => reveal(ALL_STARS)} />
      </div>
    </>
  );
}
