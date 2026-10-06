import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { buildGameInput } from '../src/engine/league/gameInput';
import { analyzeGame, RINK_LIMITS } from '../src/ui/rink/believability';

// Several full games with different teams and tactics: every one must look right.
const league = createLeague({ seed: 'believable' });
const games = [0, 7, 15, 24].map((i) => league.schedule[i]);

describe('live rink believability', () => {
  for (const g of games) {
    it(`${league.teams[g.away].abbr} at ${league.teams[g.home].abbr}`, () => {
      const m = analyzeGame(buildGameInput(league, g.id, true));
      if (process.env.RINK_REPORT) console.log(g.id, m);
      expect(m.seconds).toBeGreaterThan(1500);
      expect(m.stacked).toBeLessThan(RINK_LIMITS.stacked);
      expect(m.maxSpeed).toBeLessThan(RINK_LIMITS.maxSpeed);
      expect(m.maxTurn).toBeLessThan(RINK_LIMITS.maxTurn);
      expect(m.idlePer20).toBeLessThan(RINK_LIMITS.idlePer20);
      expect(m.offIce).toBe(RINK_LIMITS.offIce);
      expect(m.teleports).toBe(RINK_LIMITS.teleports);
      expect(m.offside).toBeLessThan(RINK_LIMITS.offside);
      expect(m.goalieSquare).toBeGreaterThan(RINK_LIMITS.goalieSquare);
      expect(m.faceoffMiss).toBeLessThan(RINK_LIMITS.faceoffMiss);
      expect(m.minStoppage).toBeGreaterThan(RINK_LIMITS.minStoppage);
    });
  }
});
