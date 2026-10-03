import { beforeAll, describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { simTo } from '../src/engine/league/season';
import { advanceOffseason, simOffseason } from '../src/engine/league/offseason';
import { payroll, marketValue, rosterOf, capSpace } from '../src/engine/economy/contracts';
import { evaluateTrade, executeTrade, playerTradeValue, type TradeProposal } from '../src/engine/economy/trade';
import { currentPick, makeDraftPick, suggestPick } from '../src/engine/economy/draft';
import { estimate } from '../src/engine/economy/scouting';
import { makeOffer, faPool, demandFor } from '../src/engine/economy/freeAgency';
import { playersOf } from '../src/engine/league/helpers';
import type { League } from '../src/engine/types';

describe('contracts & cap', () => {
  const league = createLeague({ seed: 'cap-test' });
  it('starts every team at or under the cap', () => {
    for (const t of league.teams) expect(payroll(league, t.id)).toBeLessThanOrEqual(league.cap.upper);
  });
  it('values better players more', () => {
    const ps = Object.values(league.players).filter((p) => p.status === 'active' && league.season - p.birthYear === 27);
    const best = ps.sort((a, b) => b.ca - a.ca)[0];
    const worst = ps[ps.length - 1];
    expect(marketValue(best, league)).toBeGreaterThan(marketValue(worst, league) * 3);
    expect(marketValue(best, league)).toBeLessThanOrEqual(league.cap.upper * 0.2);
  });
});

describe('trades', () => {
  const league = createLeague({ seed: 'trade-test' });
  league.teams[5].strategy = 'rebuild';
  league.teams[6].strategy = 'contend';
  it('rejects lopsided offers and accepts generous ones', () => {
    const mine = rosterOf(league, 0).sort((a, b) => a.ca - b.ca);
    const theirs = rosterOf(league, 5).sort((a, b) => b.ca - a.ca);
    const bad: TradeProposal = { from: 0, to: 5, give: [{ kind: 'player', id: mine[0].id }], get: [{ kind: 'player', id: theirs[0].id }] };
    expect(evaluateTrade(league, bad).accept).toBe(false);
    const theirWorst = rosterOf(league, 5).sort((a, b) => a.ca - b.ca)[0];
    const myBest = rosterOf(league, 0).filter((p) => p.contract!.salary <= theirWorst.contract!.salary + capSpace(league, 5)).sort((a, b) => b.ca - a.ca)[0];
    const good: TradeProposal = { from: 0, to: 5, give: [{ kind: 'player', id: myBest.id }], get: [{ kind: 'player', id: theirWorst.id }] };
    const ev = evaluateTrade(league, good);
    if (!myBest.contract!.ntc) expect(ev.accept).toBe(true);
  });
  it('rebuilding teams value youth more than contenders do', () => {
    const young = Object.values(league.players).filter((p) => p.status === 'prospect' && p.pa > 150)[0];
    expect(playerTradeValue(league, 5, young)).toBeGreaterThan(playerTradeValue(league, 6, young));
  });
  it('executes trades by moving assets', () => {
    const a = rosterOf(league, 1)[0];
    const pick = league.draftPicks.find((p) => p.ownerId === 2)!;
    const t: TradeProposal = { from: 1, to: 2, give: [{ kind: 'player', id: a.id }], get: [{ kind: 'pick', id: pick.id }] };
    executeTrade(league, t);
    expect(a.teamId).toBe(2);
    expect(pick.ownerId).toBe(1);
    expect(league.transactions[0].kind).toBe('trade');
  });
});

describe('offseason: draft, re-sign, free agency', () => {
  let league: League;
  beforeAll(() => {
    league = createLeague({ seed: 'offseason-test' });
    simTo(league, 'endSeason');
  });

  it('runs a draft where the user picks and CPU teams fill every other slot', () => {
    expect(league.phase).toBe('draft');
    advanceOffseason(league); // CPU picks until the user is on the clock
    const pick = currentPick(league);
    expect(pick?.ownerId).toBe(league.userTeamId);
    const choice = suggestPick(league)!;
    makeDraftPick(league, pick!.id, choice.id);
    expect(choice.teamId).toBe(league.userTeamId);
    expect(choice.status).toBe('prospect');
    let guard = 0;
    while (league.phase === 'draft' && guard++ < 20) {
      advanceOffseason(league);
      const p = currentPick(league);
      if (league.phase === 'draft' && p?.ownerId === league.userTeamId) makeDraftPick(league, p.id, suggestPick(league)!.id);
    }
    expect(league.phase).toBe('resign');
  });

  it('scouting gives imperfect information about prospects', () => {
    const prospects = Object.values(league.players).filter((p) => p.status === 'prospect' && p.teamId !== league.userTeamId);
    const off = prospects.filter((p) => {
      const e = estimate(league, p);
      return e.pa !== p.pa;
    });
    expect(off.length).toBeGreaterThan(prospects.length * 0.5);
    for (const p of prospects.slice(0, 50)) {
      const e = estimate(league, p);
      expect(e.paLow).toBeLessThanOrEqual(e.paHigh);
    }
  });

  it('free agency signs players and keeps CPU teams under the cap', () => {
    advanceOffseason(league); // → free agency
    expect(league.phase).toBe('freeAgency');
    const pool = faPool(league);
    expect(pool.length).toBeGreaterThan(30);
    // User offers a fair deal to a depth player.
    const target = pool.find((p) => p.ca < 125)!;
    const d = demandFor(league, target);
    const r = makeOffer(league, league.userTeamId, target, Math.round(d.salary * 1.15), d.years);
    expect(r.ok).toBe(true);
    simOffseason(league);
    expect(league.phase).toBe('regular');
    for (const t of league.teams) {
      if (t.id === league.userTeamId) continue;
      expect(payroll(league, t.id)).toBeLessThanOrEqual(league.cap.upper * 1.001);
      const n = playersOf(league, t.id).length;
      expect(n).toBeGreaterThanOrEqual(20);
      expect(n).toBeLessThanOrEqual(league.config.economics.rosterMax);
    }
    const signings = league.transactions.filter((t) => t.kind === 'signing' && t.season === league.season - 1);
    expect(signings.length).toBeGreaterThan(60);
  });
});
