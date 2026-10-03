import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { rulesFor, elcMaxFor } from '../src/engine/cba/rules';
import { buildContract, flatTerms, aav, fullCapHit, cashIn, contractStructureErrors, isThirtyFivePlus } from '../src/engine/cba/contract';
import { calculateBuyout, calculateLTIRRelief, calculateOfferSheetCompensation, calculateQualifyingOffer, determineFreeAgentStatus, waiverStatus, validatePlayoffRoster, validateRoster } from '../src/engine/cba/rulesEngine';
import { CapManager, capProjection, teamCapSheet } from '../src/engine/cba/capManager';
import { checkContract, contractFromOffer, signFromOffer } from '../src/engine/cba/contractService';
import type { Player } from '../src/engine/types';

const league = createLeague({ seed: 'cba-tests', rosters: false });
const anyPlayer = (pred: (p: Player) => boolean) => Object.values(league.players).find(pred)!;

describe('versioned league rules', () => {
  it('has the published caps, floors and minimum salaries', () => {
    expect(rulesFor(2025).upperLimit).toBe(95500);
    expect(rulesFor(2025).lowerLimit).toBe(70600);
    expect(rulesFor(2026).upperLimit).toBe(104000);
    expect(rulesFor(2026).lowerLimit).toBe(76900);
    expect(rulesFor(2026).minimumSalary).toBe(850);
    expect(rulesFor(2027).upperLimit).toBe(113500);
    expect(rulesFor(2027).lowerLimit).toBe(83900);
    expect(rulesFor(2027).minimumSalary).toBe(900);
    expect(rulesFor(2028).minimumSalary).toBe(950);
    expect(rulesFor(2029).minimumSalary).toBe(1000);
  });
  it('switches term limits with the new CBA', () => {
    expect([rulesFor(2025).maxTermOwnTeam, rulesFor(2025).maxTermExternal]).toEqual([8, 7]);
    expect([rulesFor(2026).maxTermOwnTeam, rulesFor(2026).maxTermExternal]).toEqual([7, 6]);
  });
  it('projects seasons beyond the table and flags them', () => {
    const r = rulesFor(2032);
    expect(r.projected).toBe(true);
    expect(r.upperLimit).toBeGreaterThan(rulesFor(2029).upperLimit);
    expect(r.sources.upperLimit).toMatch(/PROJECTED/);
  });
  it('uses the MOU entry-level maximums', () => {
    expect(elcMaxFor(2026)).toBe(1000);
    expect(elcMaxFor(2030)).toBe(1175);
  });
});

describe('contract structure', () => {
  const p = anyPlayer((x) => x.status === 'active' && league.season - x.birthYear === 27);
  it('computes AAV, cap hit and cash separately', () => {
    const c = buildContract({ startSeason: 2026, salaries: [11000, 11000, 10000], signingBonuses: [1000, 1000, 1000], signedSeason: 2026 });
    expect(aav(c)).toBeCloseTo(11666.667, 2);
    expect(fullCapHit(c)).toBeCloseTo(aav(c), 6);
    expect(cashIn(c, 2026)).toBe(12000);
    expect(cashIn(c, 2028)).toBe(11000);
  });
  it('allows a 7-year extension with the current team', () => {
    const c = buildContract(flatTerms(9000, 7, 2026));
    expect(contractStructureErrors(c, { ownTeam: true, signingSeason: 2026, age: 27 })).toEqual([]);
  });
  it('rejects an 8-year extension under the new CBA', () => {
    const c = buildContract(flatTerms(9000, 8, 2026));
    const e = contractStructureErrors(c, { ownTeam: true, signingSeason: 2026, age: 27 });
    expect(e.join(' ')).toMatch(/limited to 7 years/);
  });
  it('allows a 6-year external free-agent contract', () => {
    const c = buildContract(flatTerms(7000, 6, 2026));
    expect(contractStructureErrors(c, { ownTeam: false, signingSeason: 2026, age: 28 })).toEqual([]);
  });
  it('rejects a 7-year external free-agent contract with a clear reason', () => {
    const c = buildContract(flatTerms(7000, 7, 2026));
    const e = contractStructureErrors(c, { ownTeam: false, signingSeason: 2026, age: 28 });
    expect(e[0]).toMatch(/external free-agent contracts are limited to 6 years/);
  });
  it('enforces the 20% / 71% variance rules of the new CBA', () => {
    const bad = buildContract({ startSeason: 2026, salaries: [12000, 12000, 8000], signedSeason: 2026 });
    expect(contractStructureErrors(bad, { ownTeam: true, signingSeason: 2026, age: 28 }).join(' ')).toMatch(/adjacent years may differ/);
    const ok = buildContract({ startSeason: 2026, salaries: [12000, 12000, 11000, 10000, 9000], signedSeason: 2026 });
    expect(contractStructureErrors(ok, { ownTeam: true, signingSeason: 2026, age: 28 })).toEqual([]);
  });
  it('caps signing bonuses at 60% of total compensation from 2026-27', () => {
    const c = buildContract({ startSeason: 2026, salaries: [1000, 1000, 1000], signingBonuses: [9000, 9000, 9000], signedSeason: 2026 });
    expect(contractStructureErrors(c, { ownTeam: true, signingSeason: 2026, age: 28 }).join(' ')).toMatch(/signing bonuses/);
  });
  it('enforces ELC term and maximums', () => {
    const tooLong = buildContract({ ...flatTerms(950, 4, 2026), type: 'ELC' });
    expect(contractStructureErrors(tooLong, { ownTeam: true, signingSeason: 2026, age: 19, elcYear: 2026 }).join(' ')).toMatch(/must be 3 years/);
    const tooRich = buildContract({ ...flatTerms(1200, 3, 2026), type: 'ELC' });
    expect(contractStructureErrors(tooRich, { ownTeam: true, signingSeason: 2026, age: 19, elcYear: 2026 }).join(' ')).toMatch(/exceeds the 2026 maximum/);
  });
  it('applies the 35+ rule and the 2025 MOU exemption', () => {
    const declining = buildContract({ startSeason: 2026, salaries: [5000, 4500], signedSeason: 2026 });
    expect(isThirtyFivePlus(declining, 36)).toBe(true);
    const flat = buildContract({ startSeason: 2026, salaries: [4000, 4000], signedSeason: 2026 });
    expect(isThirtyFivePlus(flat, 36)).toBe(false);
    const young = buildContract({ startSeason: 2026, salaries: [5000, 4500], signedSeason: 2026 });
    expect(isThirtyFivePlus(young, 33)).toBe(false);
    void p;
  });
});

describe('cap manager', () => {
  const tid = 0;
  it('builds a cap sheet that adds up', () => {
    const s = teamCapSheet(league, tid);
    expect(s.total).toBeCloseTo(s.forwards + s.defense + s.goalies + s.buried + s.deadCap, 3);
    expect(s.space).toBeCloseTo(s.upper + s.ltirRelief - s.total, 3);
    expect(s.upper).toBe(104000);
  });
  it('accepts a cap-compliant signing and rejects one that breaks the cap', () => {
    const fa = anyPlayer((x) => x.status === 'fa');
    const space = CapManager.getAvailableCapSpace(league, tid);
    const fits = contractFromOffer(league, fa, { aav: Math.max(900, Math.min(2000, space - 100)), years: 2 });
    expect(checkContract(league, fa, tid, fits)).toEqual([]);
    const huge = contractFromOffer(league, fa, { aav: 20000, years: 2 });
    huge.yearsDetail!.forEach((y) => (y.salary = space + 5000));
    const errors = checkContract(league, fa, tid, huge);
    expect(errors.some((e) => /salary cap|maximum player salary/.test(e))).toBe(true);
  });
  it('gives buried relief for minor-league contracts', () => {
    const pros = teamCapSheet(league, tid).rows.filter((r) => r.buried);
    for (const r of pros) expect(r.capHit).toBeLessThanOrEqual(Math.max(0, r.fullCapHit - (rulesFor(2026).minimumSalary + 375)) + 0.01);
  });
  it('projects future cap space', () => {
    const proj = capProjection(league, tid, 4);
    expect(proj.map((y) => y.season)).toEqual([2026, 2027, 2028, 2029]);
    expect(proj[1].upper).toBe(113500);
    expect(proj[1].committed).toBeLessThanOrEqual(proj[0].committed + 1);
  });
});

describe('rules engine', () => {
  it('classifies UFA at 27 and RFA below', () => {
    const p = anyPlayer((x) => x.status === 'active' && league.season + 1 - x.birthYear >= 27);
    expect(determineFreeAgentStatus(p, league.season).status).toBe('UFA');
    const y = anyPlayer((x) => x.status === 'active' && league.season + 1 - x.birthYear <= 23 && (x.accruedBefore ?? 0) < 7);
    expect(determineFreeAgentStatus(y, league.season).status).toBe('RFA');
  });
  it('calculates qualifying offers by tier with the 120% AAV cap', () => {
    const p = anyPlayer((x) => x.status === 'active');
    const low = buildContract(flatTerms(1000, 2, 2025));
    expect(calculateQualifyingOffer(p, low, 2026).amount).toBeCloseTo(1100, 3); // ≤ $1.25M: 110%
    const mid = buildContract(flatTerms(1500, 2, 2025));
    expect(calculateQualifyingOffer(p, mid, 2026).amount).toBeCloseTo(1575, 3); // 105%
    const high = buildContract(flatTerms(4000, 2, 2025));
    expect(calculateQualifyingOffer(p, high, 2026).amount).toBeCloseTo(4000, 3); // 100%
    const backLoaded = buildContract({ startSeason: 2024, salaries: [1000, 1500, 3000], signedSeason: 2024 });
    const qo = calculateQualifyingOffer(p, backLoaded, 2026);
    expect(qo.amount).toBeCloseTo(aav(backLoaded) * 1.2, 2);
    expect(qo.explanation).toMatch(/120%/);
  });
  it('maps offer sheets to the right compensation tier', () => {
    // $8.5M x 6 years: compensation AAV = total / min(years, 5) = $10.2M → 2x1st + 2nd + 3rd.
    const six = calculateOfferSheetCompensation(8500 * 6, 6, 2025);
    expect(six.compAav).toBeCloseTo(10200, 3);
    expect(six.picks).toEqual(['1', '1', '2', '3']);
    // $8.5M x 5 years → $8.5M tier: 1st + 2nd + 3rd.
    expect(calculateOfferSheetCompensation(8500 * 5, 5, 2025).picks).toEqual(['1', '2', '3']);
    // $5.5M → 1st + 3rd.
    expect(calculateOfferSheetCompensation(5500 * 4, 4, 2025).picks).toEqual(['1', '3']);
    expect(calculateOfferSheetCompensation(1000, 1, 2025).picks).toEqual([]);
    expect(calculateOfferSheetCompensation(3000 * 3, 3, 2025).picks).toEqual(['2']);
    expect(calculateOfferSheetCompensation(13000 * 5, 5, 2025).picks).toEqual(['1', '1', '1', '1']);
  });
  it('computes buyouts at 2/3 (1/3 under 26) over twice the term', () => {
    const p = anyPlayer((x) => x.status === 'active' && league.season - x.birthYear >= 30);
    const c = buildContract(flatTerms(6000, 3, 2025));
    const b = calculateBuyout(p, c, 2026);
    expect(b.ratio).toBeCloseTo(2 / 3, 5);
    expect(Object.keys(b.payments)).toHaveLength(4);
    expect(b.totalCost).toBeCloseTo(12000 * (2 / 3), 2);
    const young = anyPlayer((x) => x.status === 'active' && league.season - x.birthYear <= 22);
    expect(calculateBuyout(young, c, 2026).ratio).toBeCloseTo(1 / 3, 5);
  });
  it('caps LTIR relief at the average salary when the player returns this season', () => {
    const r = calculateLTIRRelief(9000, 1000, 2026, false);
    expect(r.relief).toBeCloseTo(rulesFor(2026).averageLeagueSalary, 2);
    expect(calculateLTIRRelief(9000, 1000, 2026, true).relief).toBe(8000);
  });
  it('determines waiver exemption from signing age, seasons and games', () => {
    const rookie = anyPlayer((x) => x.status === 'prospect' && (x.firstSpcAge ?? 20) <= 20 && (x.proSeasons ?? 0) <= 1);
    expect(waiverStatus(rookie, league.season).exempt).toBe(true);
    const vet = anyPlayer((x) => x.status === 'active' && league.season - x.birthYear >= 29);
    expect(waiverStatus(vet, league.season).exempt).toBe(false);
  });
  it('validates the 23-man roster and the playoff cap', () => {
    expect(validateRoster(league, 0).errors.filter((e) => /active roster/.test(e))).toEqual([]);
    const dressed = Object.values(league.players).filter((p) => p.teamId === 0 && p.status === 'active').slice(0, 20).map((p) => p.id);
    const ok = validatePlayoffRoster(league, 0, dressed, 0);
    expect(ok.applies).toBe(true);
    const blocked = validatePlayoffRoster(league, 0, dressed, 200000);
    expect(blocked.ok).toBe(false);
    expect(blocked.errors[0]).toMatch(/Playoff lineup blocked/);
  });
});

describe('contract service', () => {
  it('records contract history and transactions on signing', () => {
    const fa = anyPlayer((x) => x.status === 'fa' && league.season - x.birthYear >= 28);
    const before = league.transactions.length;
    const res = signFromOffer(league, fa, 1, { aav: 900, years: 1 });
    expect(res.ok).toBe(true);
    expect(fa.contractHistory?.at(-1)?.aav).toBeCloseTo(900, 3);
    expect(league.transactions.length).toBe(before + 1);
  });
  it('rejects a 7-year deal for an external free agent through the service', () => {
    const fa = anyPlayer((x) => x.status === 'fa' && !x.contractHistory?.length);
    const res = signFromOffer(league, fa, 2, { aav: 900, years: 7 });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/limited to 6 years/);
  });
});
