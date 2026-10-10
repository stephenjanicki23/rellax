import { beforeAll, describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { simTo } from '../src/engine/league/season';
import { AWARD_NAMES } from '../src/engine/league/awards';
import { vote } from '../src/engine/league/awardsNight';
import { Rng } from '../src/engine/core/rng';
import type { League } from '../src/engine/types';

describe('awards voting', () => {
  it('a clear favourite sweeps; a tight race splits the first-place votes', () => {
    const rng = new Rng('vote');
    const clear = vote(
      rng,
      [
        { playerId: 1, teamId: 0, score: 130, value: '' },
        { playerId: 2, teamId: 0, score: 100, value: '' },
        { playerId: 3, teamId: 0, score: 95, value: '' },
        { playerId: 4, teamId: 0, score: 90, value: '' },
        { playerId: 5, teamId: 0, score: 85, value: '' },
        { playerId: 6, teamId: 0, score: 80, value: '' },
      ],
      190,
      [10, 7, 5, 3, 1],
    );
    expect(clear[0].playerId).toBe(1);
    expect(clear[0].firsts).toBeGreaterThan(150);
    const tight = vote(
      rng,
      [
        { playerId: 1, teamId: 0, score: 101, value: '' },
        { playerId: 2, teamId: 0, score: 100, value: '' },
        { playerId: 3, teamId: 0, score: 80, value: '' },
        { playerId: 4, teamId: 0, score: 70, value: '' },
      ],
      190,
      [10, 7, 5, 3, 1],
    );
    expect(tight[0].firsts).toBeLessThan(170);
    expect(tight[1].firsts).toBeGreaterThan(20);
    // Every ballot hands out the scale (four names, so no fifth place).
    expect(tight.reduce((s, f) => s + f.pts, 0)).toBe(190 * 25);
  });
});

describe('awards night', () => {
  let league: League;
  beforeAll(() => {
    league = createLeague({ seed: 'awards-night' });
    simTo(league, 'endSeason');
  });
  it('records ballots whose winners match the trophies handed out', () => {
    const night = league.awardsNight!;
    expect(night.season).toBe(league.history.at(-1)!.season);
    const h = league.history.at(-1)!;
    for (const name of [AWARD_NAMES.mvp, AWARD_NAMES.goalie, AWARD_NAMES.defense, AWARD_NAMES.rookie, AWARD_NAMES.selke, AWARD_NAMES.lindsay, AWARD_NAMES.coach]) {
      const b = night.ballots.find((x) => x.award === name)!;
      expect(b, name).toBeTruthy();
      expect(b.results.length).toBeGreaterThanOrEqual(3);
      expect(b.results[0].pts).toBeGreaterThanOrEqual(b.results[1].pts);
      const won = h.awards.find((a) => a.award === name)!;
      expect(won.playerId ?? won.coachId).toBe(b.results[0].playerId ?? b.results[0].coachId);
    }
    expect(night.ballots.some((b) => b.award === AWARD_NAMES.playoffMvp)).toBe(true);
    expect(night.revealed).toEqual([AWARD_NAMES.playoffMvp]);
  });
  it('names two All-Star teams with the right positions', () => {
    const { first, second } = league.awardsNight!.allStars;
    expect(first.map((x) => x.pos)).toEqual(['C', 'LW', 'RW', 'D', 'D', 'G']);
    expect(second.map((x) => x.pos)).toEqual(['C', 'LW', 'RW', 'D', 'D', 'G']);
    const ids = [...first, ...second].map((x) => x.playerId);
    expect(new Set(ids).size).toBe(12);
    for (const x of first) expect(league.players[x.playerId].awards.some((a) => a.award === 'First All-Star Team')).toBe(true);
    expect(league.history.at(-1)!.allStarTeams?.first).toEqual(first.map((x) => x.playerId));
  });
});
