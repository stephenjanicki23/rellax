import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { playersOf } from '../src/engine/league/helpers';
import { chemistryParts, pairChemistry, untappedPairs } from '../src/engine/team/chemistry';

describe('line chemistry insights', () => {
  it('itemised chemistry adds up to the engine value, and untapped duos are spread out', () => {
    const l = createLeague({ seed: 'chem-1' });
    const roster = playersOf(l, l.userTeamId);
    const [a, b] = roster.filter((p) => p.pos === 'D');
    const parts = chemistryParts(a, b, 30000, 60);
    expect(parts.total).toBeCloseTo(pairChemistry(a, b, 30000, 60), 6);
    const duos = untappedPairs(roster, l.chemistry, 60, () => false, 5);
    expect(duos.length).toBe(5);
    const count = new Map<number, number>();
    for (const d of duos) for (const p of [d.a, d.b]) count.set(p.id, (count.get(p.id) ?? 0) + 1);
    expect(Math.max(...count.values())).toBeLessThanOrEqual(2);
  });
});
