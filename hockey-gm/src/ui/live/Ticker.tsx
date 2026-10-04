import { memo } from 'react';
import type { GameResult } from '../../engine/sim/gameTypes';
import type { Team } from '../../engine/types';
import { TeamLogo } from '../components/common';

export interface TickerGame {
  id: number;
  home: Team;
  away: Team;
  /** Full result, simulated up front; revealed in step with the user's game clock. */
  result: GameResult;
}

const PERIOD = 1200;
/** Game seconds from the opening faceoff (the engine clock counts up within a period). */
const elapsedAt = (period: number, clock: number) => (period - 1) * PERIOD + clock;

function gameEnd(r: GameResult, playoff: boolean): number {
  if (!r.ot && !r.so) return 3 * PERIOD;
  if (r.so) return 3 * PERIOD + (playoff ? PERIOD : 300);
  const last = r.goals[r.goals.length - 1];
  return last ? elapsedAt(last.period, last.clock) : 3 * PERIOD;
}

const ord = (p: number) => (p === 1 ? '1st' : p === 2 ? '2nd' : p === 3 ? '3rd' : p === 4 ? 'OT' : `${p - 3}OT`);

/**
 * Scores from around the league tonight. Every game's result was simulated
 * when the user's game started; goals appear as the user's clock passes the
 * moment they were scored, so the ticker runs in step with the live game.
 */
export const Ticker = memo(function Ticker({ games, period, clock, finished, playoff }: { games: TickerGame[]; period: number; clock: number; finished: boolean; playoff: boolean }) {
  if (!games.length) return null;
  const now = finished ? Infinity : elapsedAt(period, clock);
  const items = games.map((g) => {
    const goals = g.result.goals.filter((x) => elapsedAt(x.period, x.clock) <= now);
    const score = [goals.filter((x) => x.team === 0).length, goals.filter((x) => x.team === 1).length];
    const end = gameEnd(g.result, playoff);
    const final = now >= end;
    if (final) {
      // The official final (includes the shootout winner's deciding goal).
      score[0] = g.result.homeGoals;
      score[1] = g.result.awayGoals;
    }
    const last = goals[goals.length - 1];
    const hot = !final && last !== undefined && now - elapsedAt(last.period, last.clock) < 90;
    const status = final ? (g.result.so ? 'FINAL/SO' : g.result.ot ? 'FINAL/OT' : 'FINAL') : now <= 0 ? 'Pre-game' : now >= 3 * PERIOD ? (g.result.so && now >= 3 * PERIOD + (playoff ? PERIOD : 300) ? 'SO' : 'OT') : ord(period);
    return { g, score, final, hot, status };
  });
  // Duplicate the list so the marquee loops seamlessly.
  const strip = (key: string) =>
    items.map(({ g, score, final, hot, status }) => (
      <span key={`${key}-${g.id}`} className={`tk-game${hot ? ' hot' : ''}${final ? ' final' : ''}`}>
        <span className="tk-team">
          <TeamLogo team={g.away} size={16} />
          <b>{g.away.abbr}</b>
          <span className={`tk-score${final && score[1] > score[0] ? ' win' : ''}`}>{score[1]}</span>
        </span>
        <span className="tk-team">
          <TeamLogo team={g.home} size={16} />
          <b>{g.home.abbr}</b>
          <span className={`tk-score${final && score[0] > score[1] ? ' win' : ''}`}>{score[0]}</span>
        </span>
        <span className="tk-status">{hot ? 'GOAL' : status}</span>
      </span>
    ));
  return (
    <div className="ticker" aria-label="Scores around the league">
      <span className="tk-label">Around the league</span>
      <div className="tk-viewport">
        <div className="tk-track" style={{ animationDuration: `${Math.max(20, items.length * 6)}s` }}>
          {strip('a')}
          {strip('b')}
        </div>
      </div>
    </div>
  );
});
