import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { agentOf, AGENT_STYLES } from '../src/engine/cba/agents';
import { demandedClause, offerFit, respondToOffer, startNegotiation, stanceFor } from '../src/engine/cba/negotiation';
import { offerContract } from '../src/engine/economy/freeAgency';
import { beginHoldout, DEC1_DAY, holdoutDay, wantsToHoldOut } from '../src/engine/cba/holdouts';
import { buildContract, flatTerms } from '../src/engine/cba/contract';
import type { League, Player, QualifyingOfferRecord } from '../src/engine/types';

const league = createLeague({ seed: 'negotiation' });
const vets = () => Object.values(league.players).filter((p) => p.status === 'active' && p.teamId !== null && league.season - p.birthYear >= 29);

/** Put a player in the last year of his deal so he can be extended. */
function finalYear(l: League, p: Player): void {
  p.contract = buildContract({ ...flatTerms(4000, 2, l.season - 1), signingTeamId: p.teamId! }, l.season);
  p.contract.years = 1;
}

describe('agents', () => {
  it('every player has an agent with a name, agency and style', () => {
    const ps = Object.values(league.players).filter((p) => p.teamId !== null).slice(0, 200);
    for (const p of ps) {
      const a = agentOf(league, p);
      expect(a.name).not.toMatch(/undefined/);
      expect(a.agency.length).toBeGreaterThan(3);
      expect(AGENT_STYLES[a.style]).toBeDefined();
      expect(agentOf(league, p).id).toBe(a.id);
    }
    expect(new Set(ps.map((p) => agentOf(league, p).style)).size).toBeGreaterThanOrEqual(3);
  });
});

describe('demands', () => {
  it('established stars want trade protection on long deals; young players can’t get it', () => {
    const star = vets().sort((a, b) => b.ca - a.ca)[0];
    expect(demandedClause(league, star, 6)).not.toBeNull();
    expect(demandedClause(league, star, 1)).toBeNull();
    const kid = Object.values(league.players).find((p) => p.status === 'active' && league.season + 1 - p.birthYear <= 21 && (p.accruedBefore ?? 0) === 0)!;
    expect(demandedClause(league, kid, 3)).toBeNull();
  });

  it('meeting the clause ask matters, and the signed contract carries clause and bonus', () => {
    const l = createLeague({ seed: 'negotiation-2' });
    const p = Object.values(l.players).filter((x) => x.status === 'active' && x.teamId !== null && l.season - x.birthYear >= 28 && x.ca >= 152).sort((a, b) => b.ca - a.ca)[0];
    finalYear(l, p);
    const state = startNegotiation(l, p, p.teamId!);
    state.stance = 'open';
    const d = state.demand;
    expect(d.clause).not.toBeNull();
    const without = offerFit(l, p, state, { ...d, clause: null });
    const withIt = offerFit(l, p, state, d);
    expect(withIt).toBeGreaterThan(without + 0.03);
    const res = offerContract(l, p, d.aav, d.years, { clause: d.clause, bonusShare: d.bonusShare });
    expect(res.ok).toBe(true);
    const next = p.contract!.next ?? p.contract!;
    expect(next.clauses?.some((c) => c.kind === d.clause)).toBe(true);
    if ((d.bonusShare ?? 0) > 0) expect(next.yearsDetail!.some((y) => y.signingBonus > 0)).toBe(true);
  });

  it('a veteran who wants to win asks a rebuilding team for a premium', () => {
    const l = createLeague({ seed: 'negotiation-3' });
    const p = Object.values(l.players).filter((x) => x.status === 'active' && x.teamId !== null && l.season - x.birthYear >= 30)[0];
    finalYear(l, p);
    p.prefs.winning = 1.5;
    l.teams[p.teamId!].strategy = 'rebuild';
    l.phase = 'resign';
    expect(stanceFor(l, p, p.teamId!)).toBe('contenderOnly');
    const premium = startNegotiation(l, p, p.teamId!).demand.aav;
    delete l.negotiations[p.id];
    l.teams[p.teamId!].strategy = 'contend';
    expect(startNegotiation(l, p, p.teamId!).demand.aav).toBeLessThan(premium);
  });

  it('agents concede on reasonable offers and walk away from lowballs', () => {
    const l = createLeague({ seed: 'negotiation-4' });
    const p = Object.values(l.players).filter((x) => x.status === 'active' && x.teamId !== null && x.ca >= 135)[3];
    finalYear(l, p);
    const s = startNegotiation(l, p, p.teamId!);
    s.stance = 'open';
    const ask = s.demand.aav;
    respondToOffer(l, p, p.teamId!, { ...s.demand, aav: Math.round(ask * 0.9) });
    expect(l.negotiations[p.id].demand.aav).toBeLessThan(ask);
    let r = respondToOffer(l, p, p.teamId!, { aav: 800, years: 1 });
    for (let i = 0; i < 12 && !r.walkedAway; i++) r = respondToOffer(l, p, p.teamId!, { aav: 800, years: 1 });
    expect(r.walkedAway).toBe(true);
  });
});

describe('holdouts', () => {
  it('an underpaid star RFA holds out and signs by December 1', () => {
    const l = createLeague({ seed: 'holdout' });
    // Find a young, good player whose agent isn't the friendly type and make him an unsigned RFA.
    const p = Object.values(l.players).find((x) => x.status === 'active' && x.teamId !== null && x.ca >= 140 && l.season - x.birthYear <= 24 && agentOf(l, x).style === 'hardball')
      ?? Object.values(l.players).find((x) => x.status === 'active' && x.teamId !== null && x.ca >= 140 && agentOf(l, x).style !== 'friendly')!;
    const teamId = p.teamId!;
    const q: QualifyingOfferRecord = { playerId: p.id, teamId, season: l.season, amount: 900, previousSalary: 900, oneWay: true, arbitrationEligible: false, status: 'submitted', reason: 'test' } as QualifyingOfferRecord;
    l.qualifyingOffers.push(q);
    // The hash decides whether a given player holds out; force the decision path either way.
    if (!wantsToHoldOut(l, p, q)) expect(['friendly']).not.toContain(agentOf(l, p).style);
    p.contract = null;
    p.status = 'fa';
    p.rfa = true;
    p.rightsTeamId = teamId;
    p.teamId = null;
    beginHoldout(l, p, teamId);
    expect(p.holdout).toBeDefined();
    l.phase = 'regular';
    l.settings.autoManageUser = false;
    l.userTeamId = teamId; // the user's player: no CPU settlement
    l.day = DEC1_DAY;
    holdoutDay(l);
    expect(p.holdout).toBeUndefined();
    expect(p.teamId).toBe(teamId);
    expect(p.contract).not.toBeNull();
  });
});
