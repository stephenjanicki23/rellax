import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { simDays } from '../src/engine/league/season';
import { fireGm, goalProgress, goalScore, ownerSeasonReview, ownerWeekly, stayOn, takeJob } from '../src/engine/front/owner';

describe('owner goals and job security', () => {
  it('sets season goals from expectations when a league starts', () => {
    const l = createLeague({ seed: 'owner-1' });
    const o = l.owner!;
    expect(o.teamId).toBe(l.userTeamId);
    expect(o.season).toBe(l.season);
    expect(o.goals.length).toBeGreaterThanOrEqual(2);
    expect(o.goals.some((g) => g.kind === 'points')).toBe(true);
    for (const g of o.goals) {
      const pr = goalProgress(l, g, o.teamId);
      expect(pr.score).toBeGreaterThanOrEqual(0);
      expect(pr.value.length).toBeGreaterThan(0);
    }
  });

  it('security follows results and a terrible season gets the GM fired, with job offers', () => {
    const l = createLeague({ seed: 'owner-2' });
    l.settings.autoManageUser = false;
    const o = l.owner!;
    simDays(l, 25);
    const before = o.security;
    ownerWeekly(l);
    expect(o.security).not.toBe(before);
    // A disastrous review.
    o.security = 10;
    for (const g of o.goals) g.target = 999;
    expect(goalScore(l, o)).toBeLessThan(0.7);
    ownerSeasonReview(l);
    expect(o.fired).toBeTruthy();
    expect(o.fired!.offers.length).toBeGreaterThan(0);
    // Simming stops while the GM is out of a job.
    const day = l.day;
    simDays(l, 5);
    expect(l.day).toBe(day);
  });

  it('taking a new job moves the user to that club and swaps the front offices', () => {
    const l = createLeague({ seed: 'owner-3' });
    const oldTeam = l.userTeamId;
    fireGm(l, 'Test.');
    const target = l.owner!.fired!.offers[0];
    const theirGm = l.teams[target].gm.name;
    takeJob(l, target);
    expect(l.userTeamId).toBe(target);
    expect(l.teams[oldTeam].gm.name).toBe(theirGm);
    expect(l.owner!.teamId).toBe(target);
    expect(l.owner!.fired).toBeUndefined();
    expect(l.owner!.career).toHaveLength(1);
    expect(l.owner!.goals.length).toBeGreaterThan(0);
  });

  it('staying on turns firing off', () => {
    const l = createLeague({ seed: 'owner-4' });
    fireGm(l, 'Test.');
    stayOn(l);
    expect(l.owner!.fired).toBeUndefined();
    expect(l.settings.canBeFired).toBe(false);
    l.owner!.security = 0;
    ownerSeasonReview(l);
    expect(l.owner!.fired).toBeUndefined();
  });
});
