import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { simDays } from '../src/engine/league/season';
import { allStarDay, awardsRace } from '../src/engine/league/race';

describe('awards race, three stars and All-Stars', () => {
  it('ranks candidates for every trophy, names weekly stars, and picks All-Stars with every club represented', () => {
    const l = createLeague({ seed: 'race-1' });
    l.settings.autoManageUser = true;
    simDays(l, 30);
    const race = awardsRace(l);
    expect(race.map((r) => r.key)).toEqual(['hart', 'artross', 'rocket', 'vezina', 'norris', 'calder', 'selke']);
    for (const r of race.filter((x) => x.key !== 'calder')) {
      expect(r.leaders.length).toBe(5);
      for (let i = 1; i < r.leaders.length; i++) expect(r.leaders[i - 1].score).toBeGreaterThanOrEqual(r.leaders[i].score);
    }
    expect(l.weekly!.stars.length).toBeGreaterThan(2);
    expect(l.weekly!.stars[0].stars).toHaveLength(3);
    simDays(l, allStarDay(l) - l.day + 1);
    const as = l.allStars!;
    expect(as.season).toBe(l.season);
    for (const conf of l.config.conferences) {
      const ids = as.rosters[conf.id];
      expect(ids.length).toBe(21);
      const teams = new Set(ids.map((id) => l.players[id].teamId));
      for (const t of l.teams.filter((x) => x.conferenceId === conf.id)) expect(teams.has(t.id)).toBe(true);
    }
    expect(l.players[as.rosters.E[0]].awards.some((a) => a.award === 'All-Star')).toBe(true);
  });
});
