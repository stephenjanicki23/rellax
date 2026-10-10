import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { simTo } from '../src/engine/league/season';
import { careerTimeline } from '../src/engine/player/career';
import { addTransaction } from '../src/engine/league/helpers';
import { points } from '../src/engine/core/statline';

describe('career timeline', () => {
  it('keeps trades and signings with the player even after the league log is trimmed', () => {
    const l = createLeague({ seed: 'career-log' });
    const p = Object.values(l.players).find((x) => x.status === 'active')!;
    addTransaction(l, { kind: 'trade', teamIds: [0, 1], playerIds: [p.id], description: 'Test trade' });
    addTransaction(l, { kind: 'callup', teamIds: [0], playerIds: [p.id], description: 'Recalled' });
    l.transactions.length = 0;
    const t = careerTimeline(l, p);
    const evs = t.rows.flatMap((r) => r.events);
    expect(evs.some((e) => e.text === 'Test trade')).toBe(true);
    expect(evs.some((e) => e.text === 'Recalled')).toBe(false);
  });
  it('builds season rows and totals that match the archived career', () => {
    const l = createLeague({ seed: 'career-season' });
    simTo(l, 'endSeason');
    const p = Object.values(l.players).filter((x) => x.pos !== 'G' && x.career.length).sort((a, b) => points(b.career[0].stats) - points(a.career[0].stats))[0];
    const t = careerTimeline(l, p);
    const row = t.rows.find((r) => r.season === l.season)!;
    expect(row.reg).toBeTruthy();
    const regTotal = p.career.filter((c) => !c.playoffs).reduce((s, c) => s + points(c.stats), 0);
    expect(points(t.summary.reg)).toBe(regTotal);
    expect(t.summary.best?.season).toBe(l.season);
    expect(row.ca).toBeTypeOf('number');
  });
});
