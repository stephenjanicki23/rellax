import { beforeAll, describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { simTo } from '../src/engine/league/season';
import { advanceOffseason, simOffseason } from '../src/engine/league/offseason';
import { DAY_ONE_WAVES, faSignings, offerStanding, processFAStep, signingVerdict } from '../src/engine/economy/freeAgency';
import { marketValue, rosterOf, capSpace } from '../src/engine/economy/contracts';
import { teamCapSheet } from '../src/engine/cba/capManager';
import { evaluateTrade, executeTrade, playerTradeValue, validateTrade, type TradeProposal } from '../src/engine/economy/trade';
import { offerForUser } from '../src/engine/ai/tradeMarket';
import { currentPick, makeDraftPick, suggestPick } from '../src/engine/economy/draft';
import { estimate } from '../src/engine/economy/scouting';
import { makeOffer, faPool, demandFor } from '../src/engine/economy/freeAgency';
import { rosterSize } from '../src/engine/economy/roster';
import type { League } from '../src/engine/types';

describe('contracts & cap', () => {
  const league = createLeague({ seed: 'cap-test' });
  it('starts every team at or under the cap', () => {
    // Real payrolls: compliant means under the upper limit plus any LTIR relief.
    for (const t of league.teams) expect(teamCapSheet(league, t.id).compliant).toBe(true);
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
  it('CPU teams make valid unsolicited offers to the user', () => {
    let found = null;
    for (let i = 0; i < 30 && !(found && found.proposal.get.length); i++) found = offerForUser(league);
    expect(found).not.toBeNull();
    const p = found!.proposal;
    expect(p.to).toBe(league.userTeamId);
    expect(validateTrade(league, p)).toEqual([]);
    const target = league.players[p.get[0].id];
    expect(target.teamId).toBe(league.userTeamId);
    executeTrade(league, p);
    expect(target.teamId).toBe(p.from);
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

describe('free-agent signing verdicts', () => {
  it('calls bargains and overpays against market value', () => {
    expect(signingVerdict(700, 1000).tag).toBe('Bargain');
    expect(signingVerdict(1000, 1000).tag).toBe('Fair');
    expect(signingVerdict(1500, 1000).tag).toBe('Big overpay');
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
    // July 1 runs in waves; the user can see where his offer stands.
    const st = offerStanding(league, target.id);
    expect(st?.of).toBeGreaterThanOrEqual(1);
    for (let w = 1; w < DAY_ONE_WAVES.length; w++) {
      expect(processFAStep(league)).toBe(false);
      expect(league.faDay).toBe(0);
      expect(league.faWave).toBe(w);
    }
    processFAStep(league);
    expect(league.faDay).toBe(1);
    const day1 = faSignings(league).filter((e) => e.day === 0);
    expect(day1.length).toBeGreaterThan(5);
    expect(day1.some((e) => (e.wave ?? 0) < DAY_ONE_WAVES.length - 1)).toBe(true);
    // Newest first: the day's waves run in order (no later wave listed before an earlier one).
    for (let i = 1; i < day1.length; i++) expect(day1[i].wave!).toBeLessThanOrEqual(day1[i - 1].wave!);
    for (const e of day1) expect(e.value).toBeGreaterThan(0);
    expect(league.media!.articles.some((a) => a.kind === 'fa')).toBe(true);
    simOffseason(league);
    expect(league.phase).toBe('regular');
    for (const t of league.teams) {
      if (t.id === league.userTeamId) continue;
      const sheet = teamCapSheet(league, t.id);
      expect(sheet.total).toBeLessThanOrEqual(sheet.effectiveLimit * 1.001);
      const n = rosterSize(league, t.id);
      expect(n).toBeGreaterThanOrEqual(20);
      expect(n).toBeLessThanOrEqual(league.config.economics.rosterMax);
    }
    const signings = league.transactions.filter((t) => t.kind === 'signing' && t.season === league.season - 1);
    expect(signings.length).toBeGreaterThan(60);
  });
});

import { ensureDressable as ensureDressable2 } from '../src/engine/economy/roster';
import { capSeason as capSeason2, teamCapSheet as capSheet2 } from '../src/engine/cba/capManager';
import { rulesFor as rulesFor2 } from '../src/engine/cba/rules';
import { createLeague as createLeague2 } from '../src/engine/league/create';
import { playersOf as playersOf2 } from '../src/engine/league/helpers';

describe('emergency signings at the contract limit', () => {
  it('a club at the contract limit that loses its goalies frees a minor-league slot and signs one', () => {
    const l = createLeague2({ seed: 'limit-1' });
    const t = l.teams[3];
    for (const g of playersOf2(l, t.id, ['active', 'prospect']).filter((p) => p.pos === 'G')) {
      g.teamId = null;
      g.status = 'fa';
      g.contract = null;
    }
    // Treat the club's current count as the limit.
    const rules = rulesFor2(capSeason2(l)) as { contractLimit: number };
    const orig = rules.contractLimit;
    rules.contractLimit = capSheet2(l, t.id).rows.length;
    try {
      const before = capSheet2(l, t.id).rows.length;
      ensureDressable2(l, t.id);
      expect(capSheet2(l, t.id).rows.length).toBeLessThanOrEqual(before);
      expect(playersOf2(l, t.id).filter((p) => p.pos === 'G').length).toBeGreaterThanOrEqual(2);
    } finally {
      rules.contractLimit = orig;
    }
  });
});
