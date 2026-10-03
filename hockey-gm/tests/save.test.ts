import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { simDays, advanceDay } from '../src/engine/league/season';
import { serializeLeague, deserializeLeague } from '../src/engine/save';

describe('save / load', () => {
  it('round-trips the league and continues identically (deterministic after load)', () => {
    const league = createLeague({ seed: 'save-test' });
    simDays(league, 10);
    const text = serializeLeague(league, 'slot1');
    const { league: copy, meta } = deserializeLeague(text);
    expect(meta.season).toBe(league.season);
    expect(copy.day).toBe(league.day);
    // Continue both and compare.
    for (let i = 0; i < 5; i++) {
      advanceDay(league);
      advanceDay(copy);
    }
    expect(JSON.stringify(copy.standings)).toBe(JSON.stringify(league.standings));
    expect(copy.rng).toEqual(league.rng);
    expect(text.length).toBeLessThan(15_000_000);
  });

  it('rejects garbage', () => {
    expect(() => deserializeLeague('{"foo":1}')).toThrow();
  });
});
