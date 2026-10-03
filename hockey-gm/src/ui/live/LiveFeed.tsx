import { memo } from 'react';
import type { CommentaryLine } from '../../engine/sim/commentary';
import { clockLabel, periodLabel } from '../../engine/sim/commentary';
import type { Team } from '../../engine/types';
import { teamBar } from '../teamColors';

export type FeedLine = CommentaryLine & { uid: number };

const ICON: Record<CommentaryLine['kind'], string> = {
  goal: '🚨',
  shot: '◎',
  save: '■',
  penalty: '⚑',
  info: '•',
  hit: '✷',
  injury: '✚',
  big: '★',
};

/** Live play-by-play built only from engine events (newest first). */
export const LiveFeed = memo(function LiveFeed({ lines, home, away, playoff, running }: { lines: FeedLine[]; home: Team; away: Team; playoff: boolean; running: boolean }) {
  const teams = [home, away] as const;
  return (
    <div className="live-feed">
      <div className="lf-head">
        <span className={`lf-live ${running ? 'on' : ''}`}>Live</span>
        <span className="lf-title">Play-by-play</span>
      </div>
      <div className="lf-list">
        {lines.length === 0 && <div className="lf-empty">Press play to drop the puck.</div>}
        {lines.slice(0, 80).map((l) => (
          <div key={l.uid} className={`lf-item ${l.kind}`} style={{ '--tc': teams[l.team] ? teamBar(teams[l.team].colors) : '#666' } as React.CSSProperties}>
            <span className="lf-time">
              {clockLabel(l.clock, l.period > 3 && !playoff ? 300 : 1200)}
              <i>{periodLabel(l.period, playoff)}</i>
            </span>
            <span className="lf-icon" aria-hidden>
              {ICON[l.kind]}
            </span>
            <span className="lf-text">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
});
