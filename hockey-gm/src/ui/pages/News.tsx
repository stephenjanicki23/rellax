import { useMemo, useState } from 'react';
import { useGame } from '../store';
import type { NewsCategory, NewsItem } from '../../engine/types';
import { shortDate } from '../format';
import { Seg } from '../components/common';
import { href } from '../router';

const CAT_ICON: Record<NewsCategory, string> = {
  game: '🏒',
  milestone: '★',
  injury: '✚',
  trade: '⇄',
  signing: '✍',
  rumor: '…',
  award: '♛',
  coach: '📋',
  draft: '⬇',
  record: '⚑',
  retirement: '⌂',
  streak: '🔥',
  league: '◉',
  development: '↑',
  room: '💬',
};

export function NewsList({ items, compact }: { items: NewsItem[]; compact?: boolean }) {
  const { league } = useGame();
  if (!items.length) return <div className="muted">No news yet.</div>;
  return (
    <div className="list">
      {items.map((n) => (
        <div className="item" key={n.id} style={{ alignItems: 'flex-start' }}>
          <span style={{ width: 18, textAlign: 'center' }}>{CAT_ICON[n.category]}</span>
          <div className="stack" style={{ gap: 2, flex: 1 }}>
            <span style={{ fontWeight: n.importance >= 4 ? 650 : 450 }}>
              {n.playerIds.length === 1 ? <a href={href(`player/${n.playerIds[0]}`)} style={{ color: 'inherit' }}>{n.headline}</a> : n.headline}
            </span>
            {!compact && n.body && <span className="muted" style={{ fontSize: 12 }}>{n.body}</span>}
          </div>
          <span className="dim" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
            {n.season === league.season ? shortDate(n.season, n.day) : n.season}
          </span>
        </div>
      ))}
    </div>
  );
}

export function NewsPage() {
  const { league, version } = useGame();
  const [cat, setCat] = useState<'all' | 'mine' | NewsCategory>('all');
  const items = useMemo(
    () => league.news.filter((n) => (cat === 'all' ? true : cat === 'mine' ? n.teamIds.includes(league.userTeamId) : n.category === cat)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [league, version, cat],
  );
  return (
    <>
      <div className="page-head">
        <h1>News</h1>
        <span className="sub">Generated from what actually happens in the league.</span>
      </div>
      <div style={{ marginBottom: 12 }}>
        <Seg
          value={cat}
          onChange={setCat}
          options={[
            { id: 'all', label: 'All' },
            { id: 'mine', label: 'My team' },
            { id: 'game', label: 'Games' },
            { id: 'trade', label: 'Trades' },
            { id: 'signing', label: 'Signings' },
            { id: 'injury', label: 'Injuries' },
            { id: 'rumor', label: 'Rumors' },
            { id: 'milestone', label: 'Milestones' },
            { id: 'award', label: 'Awards' },
            { id: 'record', label: 'Records' },
          ]}
        />
      </div>
      <div className="card">
        <NewsList items={items.slice(0, 250)} />
      </div>
    </>
  );
}
