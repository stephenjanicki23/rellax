import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { simDays } from '../src/engine/league/season';
import { ARENA_CAPACITY, booksOf, budgetMultiplier, closeBooks, expectedFill, fans, setTicketPrice, startProject } from '../src/engine/front/finances';

describe('fans and finances', () => {
  it('every club has an arena capacity; home games book gates and attendance', () => {
    const l = createLeague({ seed: 'fin-a' });
    for (const t of l.teams) expect(ARENA_CAPACITY[t.abbr]).toBeGreaterThan(10000);
    l.settings.autoManageUser = true;
    simDays(l, 20);
    const t = l.teams[l.userTeamId];
    const f = fans(l, t.id);
    expect(f.season.homeGames).toBeGreaterThan(0);
    expect(f.season.attendance / f.season.homeGames).toBeLessThanOrEqual(ARENA_CAPACITY[t.abbr]);
    const b = booksOf(f);
    expect(b.revenue).toBeGreaterThan(0);
    expect(b.expenses).toBeGreaterThan(0);
  });

  it('higher ticket prices sell fewer seats', () => {
    const l = createLeague({ seed: 'fin-b' });
    const t = l.teams[l.userTeamId];
    const opp = l.teams.find((x) => x.id !== t.id)!;
    setTicketPrice(l, 0.8);
    const cheap = expectedFill(l, t, opp, false);
    setTicketPrice(l, 1.4);
    const dear = expectedFill(l, t, opp, false);
    expect(dear).toBeLessThan(cheap);
  });

  it("closing the books archives the season and feeds next year's budget", () => {
    const l = createLeague({ seed: 'fin-c' });
    l.settings.autoManageUser = true;
    simDays(l, 30);
    closeBooks(l);
    const f = fans(l, l.userTeamId);
    expect(f.history).toHaveLength(1);
    expect(f.season.homeGames).toBe(0);
    const m = budgetMultiplier(f);
    expect(m).toBeGreaterThanOrEqual(0.94);
    expect(m).toBeLessThanOrEqual(1.05);
  });

  it('a facility project costs money, raises facilities and is limited to one a season', () => {
    const l = createLeague({ seed: 'fin-d' });
    const t = l.teams[l.userTeamId];
    const before = t.facilities;
    expect(startProject(l, 'training').ok).toBe(true);
    expect(t.facilities).toBeGreaterThan(before);
    expect(fans(l, t.id).season.projects).toBeGreaterThan(0);
    expect(startProject(l, 'renovation').ok).toBe(false);
  });
});
