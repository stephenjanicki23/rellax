import { describe, expect, it } from 'vitest';
import { Rng, seedFrom } from '../src/engine/core/rng';

describe('Rng', () => {
  it('is deterministic for a given seed', () => {
    const a = new Rng('abc');
    const b = new Rng('abc');
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it('differs across seeds', () => {
    expect(new Rng('a').next()).not.toBe(new Rng('b').next());
  });

  it('resumes from a saved state', () => {
    const a = new Rng(42);
    for (let i = 0; i < 10; i++) a.next();
    const b = new Rng(a.state());
    for (let i = 0; i < 50; i++) expect(b.next()).toBe(a.next());
  });

  it('produces roughly uniform and normal values', () => {
    const r = new Rng('dist');
    let s = 0;
    let s2 = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const x = r.normal();
      s += x;
      s2 += x * x;
    }
    expect(Math.abs(s / n)).toBeLessThan(0.03);
    expect(Math.abs(s2 / n - 1)).toBeLessThan(0.05);
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) counts[r.int(0, 3)]++;
    for (const c of counts) expect(Math.abs(c / n - 0.25)).toBeLessThan(0.02);
  });

  it('seedFrom is stable', () => {
    expect(seedFrom('x', 1, 2)).toBe(seedFrom('x', 1, 2));
    expect(seedFrom('x', 1, 2)).not.toBe(seedFrom('x', 2, 1));
  });
});
