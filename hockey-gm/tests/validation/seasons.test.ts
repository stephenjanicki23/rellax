/**
 * Multi-season validation: the league must stay believable over time
 * (parity, scoring leaders, goalie spread, injuries, talent levels, rosters).
 */
import { describe, expect, it } from 'vitest';
import { createLeague } from '../../src/engine/league/create';
import { simTo } from '../../src/engine/league/season';
import { simOffseason } from '../../src/engine/league/offseason';
import { seasonSummary, checkTargets, SEASON_TARGETS } from '../../src/engine/analytics';
import { payroll } from '../../src/engine/economy/contracts';
import { playersOf } from '../../src/engine/league/helpers';

const heavy = !!process.env.VALIDATION;

describe.skipIf(!heavy)('league validation — multiple seasons', () => {
  it('stays realistic and stable over five seasons', () => {
    const league = createLeague({ seed: 'multi-season-validation' });
    league.settings.autoManageUser = true;
    const summaries = [];
    for (let s = 0; s < 5; s++) {
      simTo(league, 'endSeason');
      const sum = seasonSummary(league);
      summaries.push(sum);
      const rows = checkTargets(sum as unknown as Record<string, number>, SEASON_TARGETS);
      const failed = rows.filter((r) => !r.ok);
      if (failed.length) console.warn(`Season ${sum.season} out of range:`, failed.map((f) => `${f.key}=${f.value}`).join(', '));
      expect(failed.length).toBeLessThanOrEqual(1);
      simOffseason(league);
      // Rosters stay legal after every offseason.
      for (const t of league.teams) {
        const n = playersOf(league, t.id).length;
        expect(n).toBeGreaterThanOrEqual(20);
        expect(payroll(league, t.id)).toBeLessThanOrEqual(league.cap.upper * 1.01);
      }
    }
    // Talent level does not run away.
    const drift = summaries.at(-1)!.top400CA - summaries[0].top400CA;
    expect(Math.abs(drift)).toBeLessThan(5);
    // Different champions emerge (dynamic league).
    const champs = new Set(summaries.map((s) => s.champion));
    expect(champs.size).toBeGreaterThanOrEqual(3);
    // History accumulates.
    expect(league.history.length).toBe(5);
    expect(Object.keys(league.records.career).length).toBeGreaterThan(4);
  });
});
