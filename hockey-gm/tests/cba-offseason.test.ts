import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { buildContract, flatTerms } from '../src/engine/cba/contract';
import { prepareExpiries, processQualifyingOffers, qualifyingOfferFor, submitQualifyingOffer, isRestricted, submitOfferSheet, resolveOfferSheet, fileArbitration, arbitrationAward, acceptQualifyingOffer } from '../src/engine/cba/rfa';
import { respondToOffer } from '../src/engine/cba/negotiation';
import type { League, Player } from '../src/engine/types';

/** A league sitting in the late-June re-signing window with chosen expiring RFAs. */
function rfaLeague(seed: string): { league: League; rfas: Player[] } {
  const league = createLeague({ seed, rosters: false });
  const rfas = Object.values(league.players)
    .filter((p) => p.status === 'active' && p.teamId !== null && league.season + 1 - p.birthYear <= 24 && (p.accruedBefore ?? 0) < 4)
    .slice(0, 4);
  for (const p of rfas) {
    // Contract that ends with the current season.
    p.contract = buildContract({ ...flatTerms(1500, 2, league.season - 1), signingTeamId: p.teamId }, league.season);
    p.contract.years = 0;
    p.firstSpcAge = 19;
    p.firstSpcSeason = league.season - 5; // arbitration-eligible
  }
  league.phase = 'resign';
  prepareExpiries(league);
  return { league, rfas };
}

describe('qualifying offers', () => {
  it('lists expiring RFAs with an explained QO amount', () => {
    const { league, rfas } = rfaLeague('rfa-1');
    const q = qualifyingOfferFor(league, rfas[0].id)!;
    expect(q).toBeDefined();
    expect(q.amount).toBeCloseTo(1575, 3); // $1.5M base: 105% tier in 2026-27
    expect(q.explanation).toMatch(/105%/);
  });
  it('keeps rights for a qualified RFA and frees an unqualified one as a UFA', () => {
    const { league, rfas } = rfaLeague('rfa-2');
    const team = rfas[0].teamId!;
    submitQualifyingOffer(league, rfas[0].id, true);
    submitQualifyingOffer(league, rfas[1].id, false);
    league.phase = 'freeAgency';
    processQualifyingOffers(league);
    expect(isRestricted(rfas[0])).toBe(true);
    expect(rfas[0].rightsTeamId).toBe(team);
    expect(rfas[1].status).toBe('fa');
    expect(rfas[1].rfa).toBe(false);
    expect(rfas[1].rightsTeamId).toBeNull();
  });
  it('lets an RFA accept his qualifying offer as a one-year deal', () => {
    const { league, rfas } = rfaLeague('rfa-3');
    submitQualifyingOffer(league, rfas[0].id, true);
    league.phase = 'freeAgency';
    processQualifyingOffers(league);
    expect(acceptQualifyingOffer(league, rfas[0].id).ok).toBe(true);
    expect(rfas[0].contract?.yearsDetail?.length).toBe(1);
    expect(rfas[0].contract?.origin).toBe('qualifyingOffer');
  });
});

describe('offer sheets', () => {
  function sheetLeague(seed: string) {
    const { league, rfas } = rfaLeague(seed);
    submitQualifyingOffer(league, rfas[0].id, true);
    league.phase = 'freeAgency';
    processQualifyingOffers(league);
    const rights = rfas[0].rightsTeamId!;
    const bidder = league.teams.find((t) => t.id !== rights)!.id;
    return { league, p: rfas[0], rights, bidder };
  }
  it('requires the right compensation and lets the rights team match', () => {
    const { league, p, rights, bidder } = sheetLeague('os-1');
    const res = submitOfferSheet(league, bidder, p.id, { aav: 5500, years: 4 });
    expect(res.ok).toBe(true);
    expect(res.sheet!.compensation).toEqual(['1', '3']);
    const m = resolveOfferSheet(league, res.sheet!.id, true);
    expect(m.ok).toBe(true);
    expect(p.teamId).toBe(rights);
  });
  it('transfers draft picks when the offer sheet is declined', () => {
    const { league, p, rights, bidder } = sheetLeague('os-2');
    const res = submitOfferSheet(league, bidder, p.id, { aav: 3000, years: 3 });
    expect(res.sheet!.compensation).toEqual(['2']);
    const before = league.draftPicks.filter((d) => d.ownerId === rights).length;
    resolveOfferSheet(league, res.sheet!.id, false);
    expect(p.teamId).toBe(bidder);
    expect(league.draftPicks.filter((d) => d.ownerId === rights).length).toBe(before + 1);
  });
  it('rejects an offer sheet when the bidder no longer owns the required picks', () => {
    const { league, p, bidder } = sheetLeague('os-3');
    for (const d of league.draftPicks) if (d.originalTeamId === bidder && d.round === 1) d.ownerId = (bidder + 1) % 32;
    const res = submitOfferSheet(league, bidder, p.id, { aav: 8000, years: 5 });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/do not own their round 1/);
  });
});

describe('salary arbitration', () => {
  it('awards a salary between the club offer and the player ask', () => {
    const { league, rfas } = rfaLeague('arb-1');
    submitQualifyingOffer(league, rfas[0].id, true);
    league.phase = 'freeAgency';
    processQualifyingOffers(league);
    const filed = fileArbitration(league, rfas[0].id, 'player');
    expect(filed.ok).toBe(true);
    const kase = league.arbitration[0];
    const { award, reasoning } = arbitrationAward(league, kase);
    expect(award).toBeGreaterThanOrEqual(kase.clubOffer);
    expect(award).toBeLessThanOrEqual(kase.playerAsk);
    expect(reasoning).toMatch(/Midpoint/);
  });
});

describe('negotiation', () => {
  it('rejects lowballs, drains patience and eventually walks away', () => {
    const { league, rfas } = rfaLeague('neg-1');
    const p = rfas[0];
    const first = respondToOffer(league, p, p.teamId!, { aav: 300, years: 3 });
    expect(first.accepted).toBe(false);
    expect(first.message).toMatch(/Too low/);
    let r = first;
    for (let i = 0; i < 10 && !r.walkedAway; i++) r = respondToOffer(league, p, p.teamId!, { aav: 300, years: 3 });
    expect(r.walkedAway).toBe(true);
  });
  it('accepts an offer that meets the demand', () => {
    const { league, rfas } = rfaLeague('neg-2');
    const p = rfas[1];
    const open = respondToOffer(league, p, p.teamId!, { aav: 900, years: 2 });
    const demand = open.state.demand;
    const r = respondToOffer(league, p, p.teamId!, { aav: demand.aav, years: demand.years });
    expect(r.accepted).toBe(true);
  });
});
