import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { buildGameInput } from '../src/engine/league/gameInput';
import { GameSim, simulateGame } from '../src/engine/sim/engine';
import { describe as describeEvent } from '../src/engine/sim/commentary';
import { baseGoalProbability } from '../src/engine/sim/shotModel';

const league = createLeague({ seed: 'engine-test' });
const game = league.schedule[0];

describe('game engine', () => {
  it('is deterministic: same input + seed => same result', () => {
    const input = buildGameInput(league, game.id, true);
    const a = simulateGame(input);
    const b = simulateGame(buildGameInput(league, game.id, true));
    expect(a.homeGoals).toBe(b.homeGoals);
    expect(a.awayGoals).toBe(b.awayGoals);
    expect(a.teams).toEqual(b.teams);
    expect(a.players).toEqual(b.players);
    expect(a.events.length).toBe(b.events.length);
  });

  it('changing the seed changes the game', () => {
    const results = new Set<string>();
    for (let s = 0; s < 10; s++) {
      const r = simulateGame(buildGameInput(league, game.id, false, s));
      results.add(`${r.homeGoals}-${r.awayGoals}-${r.teams[0].shots}-${r.teams[1].shots}`);
    }
    expect(results.size).toBeGreaterThan(5);
  });

  it('recording events does not change the outcome', () => {
    const a = simulateGame(buildGameInput(league, game.id, false, 7));
    const b = simulateGame(buildGameInput(league, game.id, true, 7));
    expect([a.homeGoals, a.awayGoals]).toEqual([b.homeGoals, b.awayGoals]);
    expect(a.teams[0].shots).toBe(b.teams[0].shots);
  });

  it('produces internally consistent box scores', () => {
    for (let s = 0; s < 40; s++) {
      const r = simulateGame(buildGameInput(league, league.schedule[s].id, false, s));
      expect(r.homeGoals).not.toBe(r.awayGoals);
      const lines = Object.values(r.players);
      for (const side of [0, 1] as const) {
        const mine = lines.filter((p) => p.team === side);
        const goals = mine.reduce((x, p) => x + p.g, 0);
        expect(goals).toBe(r.teams[side].goals);
        const assists = mine.reduce((x, p) => x + p.a1 + p.a2, 0);
        expect(assists).toBeLessThanOrEqual(goals * 2);
        expect(r.teams[side].shots).toBeGreaterThanOrEqual(r.teams[side].goals);
        // Goalies faced every non-empty-net shot of the opponent.
        const sa = mine.reduce((x, p) => x + p.sa, 0);
        const enShots = r.goals.filter((g) => g.team !== side && g.strength === 'EN').length;
        expect(sa).toBeGreaterThanOrEqual(r.teams[1 - side].shots - enShots - 3);
        // Skater TOI sums to roughly 5 skaters x game length (+ shorthanded/PP variation).
        const toi = mine.filter((p) => p.sa === 0 && p.gtoi === 0).reduce((x, p) => x + p.toi, 0);
        const len = r.periods <= 3 ? 3600 : 3600 + (r.periods - 3) * 300;
        expect(toi / len).toBeGreaterThan(4.3);
        expect(toi / len).toBeLessThan(5.6);
      }
      // Exactly one goalie gets the win, one the loss.
      const w = lines.filter((p) => p.w).length;
      const l = lines.filter((p) => p.l || p.otl).length;
      expect(w).toBe(1);
      expect(l).toBe(1);
    }
  });

  it('step-by-step play matches instant simulation', () => {
    const input = buildGameInput(league, game.id, true, 3);
    const sim = new GameSim(input);
    let steps = 0;
    while (!sim.finished) {
      sim.step();
      steps++;
    }
    const a = sim.result();
    const b = simulateGame(buildGameInput(league, game.id, true, 3));
    expect([a.homeGoals, a.awayGoals]).toEqual([b.homeGoals, b.awayGoals]);
    expect(steps).toBeGreaterThan(300);
  });

  it('generates commentary from events', () => {
    const r = simulateGame(buildGameInput(league, game.id, true, 1));
    const names = (id?: number) => (id ? league.players[id]?.last ?? '?' : '?');
    const lines = r.events.map((e) => describeEvent(e, { name: names, team: (s) => (s === 0 ? 'Home' : 'Away') })).filter(Boolean);
    expect(lines.length).toBeGreaterThan(100);
    const goals = lines.filter((l) => l!.kind === 'goal' && l!.text.startsWith('GOAL'));
    expect(goals.length).toBe(r.goals.length);
  });

  it('shot model favours close, high-danger shots', () => {
    const close = baseGoalProbability({ dist: 8, angle: 10, type: 'wrist' });
    const far = baseGoalProbability({ dist: 55, angle: 10, type: 'wrist' });
    const reb = baseGoalProbability({ dist: 8, angle: 10, type: 'rebound' });
    expect(close).toBeGreaterThan(far * 4);
    expect(reb).toBeGreaterThan(close);
  });
});
