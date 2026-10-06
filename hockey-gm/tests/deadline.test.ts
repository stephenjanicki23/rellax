import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { simTo, advanceDay } from '../src/engine/league/season';

describe('trade deadline', () => {
  it('records the deals, rumours and the close in the deadline feed, with times on deadline day', () => {
    const l = createLeague({ seed: 'deadline-1' });
    l.settings.autoManageUser = true;
    simTo(l, 'tradeDeadline');
    expect(l.day).toBe(l.tradeDeadlineDay);
    advanceDay(l);
    const feed = l.deadlineFeed!;
    expect(feed.season).toBe(l.season);
    const trades = feed.events.filter((e) => e.kind === 'trade');
    expect(trades.length).toBeGreaterThan(5);
    expect(trades[0].text).toMatch(/acquire .* from /);
    const close = feed.events.find((e) => e.kind === 'close')!;
    expect(close.time).toBe('3:00 PM');
    const today = feed.events.filter((e) => e.day === l.tradeDeadlineDay);
    for (const e of today) expect(e.time).toBeTruthy();
    // Nothing older than the two-week window.
    expect(Math.min(...feed.events.map((e) => e.day))).toBeGreaterThanOrEqual(l.tradeDeadlineDay - 14);
  });
});
