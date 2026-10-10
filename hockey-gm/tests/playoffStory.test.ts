import { beforeAll, describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { simTo } from '../src/engine/league/season';
import { bracketStorylines, pathToTitle, seriesGames, seriesLeaders, seriesStatus, seriesStorylines } from '../src/engine/league/playoffStory';
import type { League } from '../src/engine/types';

describe('playoff presentation', () => {
  let league: League;
  beforeAll(() => {
    league = createLeague({ seed: 'playoff-story' });
    simTo(league, 'endSeason');
  });
  it('rebuilds every series from its box scores', () => {
    const b = league.playoffs!;
    for (const s of b.rounds.flat()) {
      const games = seriesGames(league, s);
      expect(games.at(-1)!.after).toEqual(s.wins);
      // Every game's winner matches the score and the game-winning goal belongs to the winner.
      for (const g of games) {
        expect(g.winner === s.high ? g.hiGoals > g.loGoals : g.loGoals > g.hiGoals).toBe(true);
        if (g.gwg != null) expect([g.game.home, g.game.away]).toContain(league.seasonStats[g.gwg]?.teamId ?? g.winner);
      }
      const goals = games.reduce((t, g) => t + g.hiGoals + g.loGoals, 0);
      expect(seriesLeaders(league, s, games).reduce((t, l) => t + l.g, 0)).toBe(goals);
      expect(seriesStatus(league, s)).toMatch(/win \d-\d/);
      expect(Array.isArray(seriesStorylines(league, s, games))).toBe(true);
    }
  });
  it('traces the champion and archives the series', () => {
    const champ = league.playoffs!.champion!;
    const path = pathToTitle(league, champ);
    expect(path.length).toBe(league.playoffs!.rounds.length);
    expect(path.every((r) => r.won)).toBe(true);
    expect(bracketStorylines(league)[0].text).toContain('champions');
    expect(league.seriesHistory!.length).toBe(league.playoffs!.rounds.flat().length);
  });
});

describe('rematches', () => {
  it("never lists the bracket's own series as an earlier meeting", async () => {
    const { pastMeetings } = await import('../src/engine/league/playoffStory');
    const league = createLeague({ seed: 'playoff-story' });
    simTo(league, 'endSeason');
    const final = league.playoffs!.rounds.at(-1)![0];
    expect(pastMeetings(league, final.high, final.low)).toEqual([]);
  });
});
