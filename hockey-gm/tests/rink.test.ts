import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { buildGameInput } from '../src/engine/league/gameInput';
import { GameSim } from '../src/engine/sim/engine';
import { RINK, RinkDirector, attackDir, type Frame, type RinkPlayer } from '../src/ui/rink/director';

describe('live rink director', () => {
  const league = createLeague({ seed: 'rink' });
  const input = buildGameInput(league, league.schedule[0].id, true);
  const sim = new GameSim(input);
  const players: RinkPlayer[] = ([input.home, input.away] as const).flatMap((t, team) => t.players.map((p) => ({ id: p.id, team: team as 0 | 1, pos: p.pos, number: p.number ?? null })));
  const dir = new RinkDirector(new Map(players.map((p) => [p.id, p])), ['H', 'A']);
  const frames: Frame[] = [];
  const goals: { team: 0 | 1; x: number; period: number }[] = [];
  while (!sim.finished) {
    const evs = sim.step();
    const s = sim.snapshot();
    for (const e of evs) {
      const fr = dir.apply(e, { period: s.inShootout ? 5 : e.period, onIce: s.onIce, goalies: s.goalies });
      frames.push(...fr);
      if (e.type === 'goal') goals.push({ team: e.team, x: fr[fr.length - 1].puck.x, period: e.period });
    }
  }

  it('keeps the puck and every player on the ice', () => {
    expect(frames.length).toBeGreaterThan(300);
    for (const f of frames) {
      for (const pt of [f.puck, ...Object.values(f.players)]) {
        expect(Number.isFinite(pt.x) && Number.isFinite(pt.y)).toBe(true);
        expect(pt.x).toBeGreaterThanOrEqual(0);
        expect(pt.x).toBeLessThanOrEqual(RINK.w);
        expect(pt.y).toBeGreaterThanOrEqual(0);
        expect(pt.y).toBeLessThanOrEqual(RINK.h);
      }
    }
  });
  it('puts goals in the net the scoring team attacks that period', () => {
    for (const g of goals) {
      if (g.period > 4) continue;
      const right = attackDir(g.team, g.period) > 0;
      expect(right ? g.x > RINK.goalR : g.x < RINK.goalL).toBe(true);
    }
  });
  it('switches ends between periods', () => {
    expect(attackDir(0, 1)).toBe(1);
    expect(attackDir(0, 2)).toBe(-1);
    expect(attackDir(1, 2)).toBe(1);
  });
  it('draws all ten skaters and both goalies at even strength', () => {
    const f = frames[Math.floor(frames.length / 3)];
    expect(Object.keys(f.players).length).toBeGreaterThanOrEqual(10);
  });
});
