import { describe, expect, it } from 'vitest';
import { Rng } from '../src/engine/core/rng';
import { generatePlayer } from '../src/engine/player/generate';
import { agePlayer, developPlayer } from '../src/engine/player/development';
import { computeCA } from '../src/engine/player/ability';
import { ARCHETYPES } from '../src/engine/player/archetypes';

const ctx = (season: number, iceTime = 1) => ({ season, iceTime, environment: 1, fraction: 1, injuryDays: 0, minors: false, leagueSeed: 'dev' });

describe('player generation', () => {
  it('hits the target ability and expresses the archetype', () => {
    const rng = new Rng('gen');
    for (let i = 0; i < 50; i++) {
      const p = generatePlayer(rng, { id: i, pos: 'RW', targetCA: 140, age: 25, season: 2026, archetype: 'sniper' });
      expect(Math.abs(p.ca - 140)).toBeLessThanOrEqual(3);
      expect(p.ca).toBe(computeCA(p.attrs, p.pos));
      expect(p.attrs.wristAccuracy).toBeGreaterThan(p.attrs.shotBlocking);
      expect(p.pa).toBeGreaterThanOrEqual(p.ca);
    }
    expect(ARCHETYPES.sniper.boost.shot).toBeGreaterThan(0);
  });
});

describe('development', () => {
  it('young high-potential players usually improve, but not all reach their ceiling', () => {
    const rng = new Rng('dev');
    let improved = 0;
    let reached = 0;
    const n = 120;
    for (let i = 0; i < n; i++) {
      const p = generatePlayer(rng, { id: i, pos: 'C', targetCA: 110, age: 19, season: 2026, pa: 170 });
      for (let y = 0; y < 6; y++) developPlayer(p, ctx(2027 + y));
      if (p.ca > 125) improved++;
      if (p.ca >= p.pa - 3) reached++;
    }
    expect(improved / n).toBeGreaterThan(0.7);
    expect(reached / n).toBeLessThan(0.6);
  });

  it('ice time matters for opportunity players', () => {
    const rng = new Rng('opp');
    const a = generatePlayer(rng, { id: 1, pos: 'LW', targetCA: 120, age: 21, season: 2026, pa: 165 });
    a.devCurve = 'opportunity';
    const b = structuredClone(a);
    for (let y = 0; y < 3; y++) {
      developPlayer(a, ctx(2027 + y, 1));
      developPlayer(b, ctx(2027 + y, 0.1));
    }
    expect(a.ca).toBeGreaterThan(b.ca);
  });
});

describe('aging', () => {
  it('veterans lose skating gradually while hockey sense holds', () => {
    const rng = new Rng('age');
    const p = generatePlayer(rng, { id: 1, pos: 'C', targetCA: 160, age: 30, season: 2026 });
    const start = { speed: p.attrs.speed, ca: p.ca, sense: p.attrs.hockeySense };
    const yearly: number[] = [];
    for (let y = 1; y <= 6; y++) {
      const before = p.ca;
      agePlayer(p, 2026 + y, 'seed');
      yearly.push(before - p.ca);
    }
    expect(p.attrs.speed).toBeLessThan(start.speed - 10);
    expect(p.attrs.hockeySense).toBeGreaterThan(start.sense - 8);
    // No single-year collapse.
    for (const d of yearly) expect(d).toBeLessThan(8);
    expect(p.ca).toBeLessThan(start.ca);
    expect(p.ca).toBeGreaterThan(start.ca - 30);
  });
});
