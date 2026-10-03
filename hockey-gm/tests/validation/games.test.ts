/**
 * Statistical validation of the game engine against realistic ranges.
 * 100 games run in the normal suite; 1,000 and 10,000 run with VALIDATION=1.
 */
import { describe, expect, it } from 'vitest';
import { createLeague } from '../../src/engine/league/create';
import { runGameBatch, checkTargets, GAME_TARGETS } from '../../src/engine/analytics';

const heavy = !!process.env.VALIDATION;
const league = createLeague({ seed: 'validation' });

function report(n: number) {
  const b = runGameBatch(league, n);
  const rows = checkTargets(b as unknown as Record<string, number>, GAME_TARGETS);
  const failed = rows.filter((r) => !r.ok);
  if (failed.length) console.warn(`${n} games out of range:`, failed.map((f) => `${f.key}=${f.value.toFixed(3)} [${f.lo},${f.hi}]`).join(', '));
  return { b, rows, failed };
}

describe('engine validation — 100 games', () => {
  it('produces hockey-like numbers even in a small sample', () => {
    const { b } = report(100);
    // Small sample: generous bounds.
    expect(b.goalsPerTeam).toBeGreaterThan(2.3);
    expect(b.goalsPerTeam).toBeLessThan(4);
    expect(b.shotsPerTeam).toBeGreaterThan(24);
    expect(b.shotsPerTeam).toBeLessThan(38);
    expect(b.svPct).toBeGreaterThan(0.88);
    expect(b.svPct).toBeLessThan(0.93);
  });
});

describe.skipIf(!heavy)('engine validation — 1,000 games', () => {
  it('lands every core metric inside the realistic band', () => {
    const { failed, b } = report(1000);
    // Allow at most one marginal miss at this sample size.
    expect(failed.length).toBeLessThanOrEqual(1);
    expect(b.homeWinPct).toBeGreaterThan(0.48);
  });
});

describe.skipIf(!heavy)('engine validation — 10,000 games', () => {
  it('converges on the realistic band', () => {
    const { failed, b } = report(10000);
    expect(failed).toEqual([]);
    console.log(`10,000 games: ${b.ms} ms (${(b.ms / 10000).toFixed(2)} ms/game)`);
    // Scoring distribution is not dominated by blowouts or shootouts.
    const total = b.totalGoalsHist.reduce((s, h) => s + h.count, 0);
    const blowouts = b.marginHist.find((m) => m.label === '5+')!.count / total;
    expect(blowouts).toBeLessThan(0.08);
    expect(b.soPct).toBeLessThan(0.14);
  });
});
