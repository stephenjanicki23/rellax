import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { marketDay, marketRole, offerForUser, tryMarketTrade } from '../src/engine/ai/tradeMarket';
import { validateTrade } from '../src/engine/economy/trade';
import { teamCapSheet } from '../src/engine/cba/capManager';
import type { League, Transaction } from '../src/engine/types';

function newTrades(league: League, since: number): Transaction[] {
  return league.transactions.filter((t) => t.kind === 'trade' && t.id > since);
}
const lastTx = (league: League) => league.transactions[0]?.id ?? 0;

describe('AI trade market', () => {
  it('front offices start with a plan: contenders, rebuilders and teams in between', () => {
    const league = createLeague({ seed: 'market-plan' });
    const cpu = league.teams.filter((t) => t.id !== league.userTeamId);
    const count = (s: string) => cpu.filter((t) => t.strategy === s).length;
    expect(count('contend')).toBeGreaterThanOrEqual(5);
    expect(count('rebuild')).toBeGreaterThanOrEqual(3);
    expect(count('rebuild')).toBeLessThanOrEqual(10);
    expect(count('balanced')).toBeGreaterThanOrEqual(8);
    // Early in the season stance follows strategy.
    league.phase = 'regular';
    const rebuilder = cpu.find((t) => t.strategy === 'rebuild')!;
    expect(marketRole(league, rebuilder)).toBe('seller');
  });

  it('CPU teams make legal, cap-compliant trades as the deadline approaches', () => {
    const league = createLeague({ seed: 'market-deadline' });
    league.phase = 'regular';
    league.day = league.tradeDeadlineDay - 4;
    const before = lastTx(league);
    let done = 0;
    for (let d = 0; d < 4; d++) {
      done += marketDay(league);
      league.day++;
    }
    const trades = newTrades(league, before);
    expect(done).toBeGreaterThanOrEqual(3);
    expect(trades.length).toBe(done);
    for (const t of league.teams) if (t.id !== league.userTeamId) expect(teamCapSheet(league, t.id).compliant).toBe(true);
    // The user's team is never traded with behind their back.
    for (const t of trades) expect(t.teamIds).not.toContain(league.userTeamId);
    // GMs never give up more than one first-round pick in a deal.
    for (const t of trades) expect((t.description.match(/Round 1 pick/g) ?? []).length).toBeLessThanOrEqual(1);
  });

  it('the market closes at the trade deadline', () => {
    const league = createLeague({ seed: 'market-closed' });
    league.phase = 'regular';
    league.day = league.tradeDeadlineDay + 1;
    const before = lastTx(league);
    for (let i = 0; i < 5; i++) marketDay(league);
    expect(newTrades(league, before)).toHaveLength(0);
    expect(tryMarketTrade(league)).toBeNull();
  });

  it('CPU teams call the user with legal offers', () => {
    const league = createLeague({ seed: 'market-offers' });
    league.phase = 'regular';
    league.day = league.tradeDeadlineDay - 10;
    const offers = [];
    for (let i = 0; i < 25; i++) {
      const o = offerForUser(league);
      if (o) offers.push(o);
    }
    expect(offers.length).toBeGreaterThan(0);
    for (const o of offers) {
      expect(o.proposal.to).toBe(league.userTeamId);
      expect(validateTrade(league, o.proposal)).toEqual([]);
      expect(o.note.length).toBeGreaterThan(10);
    }
  });
});
