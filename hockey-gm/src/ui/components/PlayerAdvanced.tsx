import { useMemo } from 'react';
import type { League, Player } from '../../engine/types';
import { addStatLine, emptyStatLine } from '../../engine/core/statline';
import { PLAYER_METRICS, percentileOf, rankOf, seasonRows } from '../../engine/league/advanced';
import { Card } from './common';
import { href } from '../router';
import { fmtMetric, ordinal } from '../pages/Advanced';
import { seasonLabel } from '../format';

const barColor = (p: number) => (p >= 80 ? 'var(--good)' : p >= 50 ? 'var(--accent)' : p >= 20 ? 'var(--warn)' : 'var(--bad)');

/**
 * A player's advanced stats with his league rank and percentile among
 * qualified players at his position (forwards, defencemen or goalies).
 */
export function PlayerAdvanced({ league, p, version }: { league: League; p: Player; version: number }) {
  const data = useMemo(() => seasonRows(league), [league, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const group = p.pos === 'G' ? 'goalie' : 'skater';
  const peer = (x: Player) => (p.pos === 'G' ? x.pos === 'G' : p.pos === 'D' ? x.pos === 'D' : x.pos !== 'G' && x.pos !== 'D');
  const peerLabel = p.pos === 'G' ? 'goalies' : p.pos === 'D' ? 'defencemen' : 'forwards';
  const mine = data.rows.filter((r) => r.p.id === p.id);
  const metrics = PLAYER_METRICS.filter((m) => m.group === group);
  if (!mine.length) {
    return (
      <Card title="Advanced stats">
        <div className="muted">No NHL games in {seasonLabel(data.season)} yet.</div>
      </Card>
    );
  }
  // Players traded mid-season have a line per club: combine them.
  const s = emptyStatLine();
  for (const r of mine) addStatLine(s, r.s);
  const peers = data.rows.filter((r) => peer(r.p));
  return (
    <Card title={`Advanced stats — ${seasonLabel(data.season)}`} right={<span className="muted" style={{ fontSize: 12 }}>Rank among qualified {peerLabel}</span>}>
      <div className="adv-list">
        {metrics.map((m) => {
          const v = m.value(s);
          const pool = peers.filter((r) => m.qualifies(r.s)).map((r) => m.value(r.s));
          const ok = m.qualifies(s);
          const pc = ok ? percentileOf(v, pool, m.better) : null;
          const rank = ok ? rankOf(v, pool, m.better) : null;
          return (
            <a key={m.key} className="adv-row" href={href(`leaders/${m.key}`)} title={`${m.desc} Click for the league leaders.`}>
              <span className="k">{m.label}</span>
              <b className="v">{fmtMetric(v, m.fmt)}</b>
              <span className="bar" style={{ height: 6 }}>
                <i style={{ width: `${pc ?? 0}%`, background: pc === null ? 'var(--line)' : barColor(pc) }} />
              </span>
              <span className="r muted">{rank ? `${ordinal(rank)} of ${pool.length}` : 'below the minimum to rank'}</span>
            </a>
          );
        })}
      </div>
    </Card>
  );
}
