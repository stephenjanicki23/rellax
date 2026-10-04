import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { askingPrice, counterOffer, gmPatience, offerForUser, recordRejection, shopPlayer, toggleTradeBlock, tradeBlock } from '../src/engine/ai/tradeMarket';
import { evaluateTrade, playerTradeValue, validateTrade, type TradeProposal } from '../src/engine/economy/trade';
import { playersOf } from '../src/engine/league/helpers';
import { startRegularSeason } from '../src/engine/league/offseason';

describe('trade talks with the user', () => {
  const league = createLeague({ seed: 'trade-talks' });
  startRegularSeason(league);
  league.day = 40;
  const me = league.userTeamId;
  const mine = playersOf(league, me, ['active']).filter((p) => p.contract && !p.injury).sort((a, b) => b.ca - a.ca);

  it('shopping a player returns legal bids from several teams, best first', () => {
    // A fairly paid regular (an overpaid contract rightly draws few bids).
    const target = mine.find((p) => p.contract!.salary <= 5000 && p.ca >= 132)!;
    const offers = shopPlayer(league, target.id);
    expect(offers.length).toBeGreaterThan(1);
    for (const o of offers) {
      expect(o.proposal.to).toBe(me);
      expect(o.proposal.get).toEqual([{ kind: 'player', id: target.id }]);
      expect(validateTrade(league, o.proposal)).toEqual([]);
    }
    expect(new Set(offers.map((o) => o.proposal.from)).size).toBe(offers.length);
  });

  it('the trade block draws offers for listed players', () => {
    const target = mine[8];
    expect(toggleTradeBlock(league, target.id)).toBe(true);
    expect(tradeBlock(league).map((p) => p.id)).toContain(target.id);
    let hits = 0;
    for (let i = 0; i < 20; i++) {
      const o = offerForUser(league);
      if (o?.proposal.get.some((a) => a.id === target.id)) hits++;
    }
    expect(hits).toBeGreaterThan(3);
    expect(toggleTradeBlock(league, target.id)).toBe(false);
    expect(tradeBlock(league)).toHaveLength(0);
  });

  it('names an asking price the partner accepts', () => {
    const partner = league.teams.find((t) => t.id !== me && t.strategy !== 'contend')!;
    const want = playersOf(league, partner.id, ['active']).filter((p) => p.contract && !p.injury).sort((a, b) => b.ca - a.ca)[7];
    const p = askingPrice(league, partner.id, [{ kind: 'player', id: want.id }]);
    expect(p).not.toBeNull();
    expect(p!.give.length).toBeGreaterThan(0);
    expect(validateTrade(league, p!)).toEqual([]);
    expect(evaluateTrade(league, p!).accept).toBe(true);
  });

  it('a rejected lowball comes back with an acceptable counter', () => {
    const partner = league.teams.find((t) => t.id !== me)!;
    // A useful, reasonably paid player the partner values.
    const want = playersOf(league, partner.id, ['active'])
      .filter((p) => p.contract && !p.injury && p.contract.salary < 4000 && playerTradeValue(league, partner.id, p) > 10)
      .sort((a, b) => b.ca - a.ca)[0];
    const junk = playersOf(league, me, ['prospect']).filter((p) => p.contract).sort((a, b) => a.pa - b.pa)[0];
    const lowball: TradeProposal = { from: me, to: partner.id, give: [{ kind: 'player', id: junk.id }], get: [{ kind: 'player', id: want.id }] };
    expect(evaluateTrade(league, lowball).accept).toBe(false);
    const c = counterOffer(league, lowball);
    expect(c).not.toBeNull();
    expect(evaluateTrade(league, c!.proposal).accept).toBe(true);
    expect(c!.note.length).toBeGreaterThan(10);
  });

  it('GMs stop taking calls after repeated rejections, until the next day', () => {
    const tid = league.teams.find((t) => t.id !== me)!.id;
    for (let i = 0; i < 3; i++) recordRejection(league, tid);
    expect(gmPatience(league, tid).open).toBe(true);
    recordRejection(league, tid);
    expect(gmPatience(league, tid).open).toBe(false);
    league.day++;
    expect(gmPatience(league, tid).open).toBe(true);
  });
});
