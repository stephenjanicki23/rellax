import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { buildContract, flatTerms, holderCapHit, yearsOf } from '../src/engine/cba/contract';
import { teamCapSheet } from '../src/engine/cba/capManager';
import { rulesFor } from '../src/engine/cba/rules';
import { validateRoster } from '../src/engine/cba/rulesEngine';
import { claimOnWaivers, needsWaivers, placeOnWaivers, processWaivers, waiverPriority } from '../src/engine/cba/waivers';
import { tradeConsent, validateMoves, executeMoves, type TradeMove } from '../src/engine/cba/tradeRules';
import { applyElcSlides, buyoutPlayer, enforcePlayoffCap, placeOnLTIR, previewBuyout, settlePerformanceBonuses, thirtyFivePlusRetirement, activateFromLTIR } from '../src/engine/cba/capActions';
import { demote, releasePlayer } from '../src/engine/economy/roster';
import { dressedIds, autoLines } from '../src/engine/team/lines';
import { emptyStatLine } from '../src/engine/core/statline';
import type { League, Player } from '../src/engine/types';

const fresh = (seed: string) => createLeague({ seed, rosters: false });
const roster = (l: League, tid: number) => Object.values(l.players).filter((p) => p.teamId === tid && p.status === 'active');
const vet = (l: League, tid: number, pred: (p: Player) => boolean = () => true) =>
  roster(l, tid).find((p) => l.season - p.birthYear >= 28 && p.contract && p.contract.type !== 'ELC' && !(p.contract.clauses ?? []).length && pred(p))!;

/** Give a player a clean contract from this season. */
function setContract(l: League, p: Player, aavK: number, years: number, extra: Parameters<typeof flatTerms>[3] = {}) {
  p.contract = buildContract({ ...flatTerms(aavK, years, l.season), signingTeamId: p.teamId, ...extra }, l.season);
  return p.contract;
}

describe('waivers', () => {
  it('waiver-exempt young players go straight down; veterans need waivers', () => {
    const l = fresh('wv-1');
    const t = l.teams[0].id;
    const young = roster(l, t).find((p) => p.contract?.type === 'ELC');
    if (young) {
      young.firstSpcAge = 19;
      young.firstSpcSeason = l.season;
      expect(needsWaivers(l, young).required).toBe(false);
    }
    const v = vet(l, t);
    expect(needsWaivers(l, v).required).toBe(true);
    const r = demote(l, v);
    expect(r.ok).toBe(true);
    expect(l.waivers.some((w) => w.playerId === v.id && w.status === 'pending')).toBe(true);
  });

  it('awards a claimed player to the highest-priority claimant with his contract', () => {
    const l = fresh('wv-2');
    const from = l.teams[3].id;
    const v = vet(l, from);
    setContract(l, v, 900, 1);
    placeOnWaivers(l, v, 'assignment');
    const order = waiverPriority(l).filter((id) => id !== from);
    // The two lowest-priority teams claim; the higher of them wins.
    const a = order[order.length - 1];
    const b = order[order.length - 2];
    expect(claimOnWaivers(l, a, v.id).ok).toBe(true);
    expect(claimOnWaivers(l, b, v.id).ok).toBe(true);
    // Keep other CPU teams out of it for a deterministic result.
    v.ca = 60;
    l.day += 1;
    processWaivers(l);
    expect(v.teamId).toBe(b);
    expect(v.status).toBe('active');
    expect(v.contract?.yearsDetail?.[0].salary).toBe(900);
  });

  it('assigns a player who clears waivers to the minors', () => {
    const l = fresh('wv-3');
    const v = vet(l, l.teams[5].id);
    v.ca = 60;
    placeOnWaivers(l, v, 'assignment');
    processWaivers(l, true);
    expect(v.status).toBe('prospect');
    expect(v.teamId).toBe(l.teams[5].id);
  });

  it('refuses to waive a no-movement-clause player', () => {
    const l = fresh('wv-4');
    const v = vet(l, l.teams[1].id);
    setContract(l, v, 6000, 4, { clauses: [{ kind: 'NMC', from: l.season, to: l.season + 3 }] });
    const r = demote(l, v);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no-movement clause/);
  });

  it('will not release a one-way multi-year contract mid-season', () => {
    const l = fresh('wv-5');
    const v = vet(l, l.teams[2].id);
    setContract(l, v, 3000, 3);
    const r = releasePlayer(l, v);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/buyout window/);
  });
});

describe('trade clauses and retention', () => {
  it('blocks a trade the NMC player has not approved and explains why', () => {
    const l = fresh('tr-1');
    const from = l.teams[0].id;
    const p = vet(l, from);
    setContract(l, p, 7000, 4, { clauses: [{ kind: 'NMC', from: l.season, to: l.season + 3 }] });
    p.morale = 80;
    const dest = l.teams.find((t) => t.id !== from && !tradeConsent(l, p, t.id).granted)!.id;
    const chk = validateMoves(l, [{ asset: { kind: 'player', id: p.id }, from, to: dest }]);
    expect(chk.ok).toBe(false);
    expect(chk.errors.join(' ')).toMatch(/no-movement clause and has not approved a trade/);
  });

  it('lets an NTC player approve a move', () => {
    const l = fresh('tr-2');
    const from = l.teams[0].id;
    const p = vet(l, from);
    setContract(l, p, 2000, 3, { clauses: [{ kind: 'NTC', from: l.season, to: l.season + 2 }] });
    p.morale = 20; // unhappy players waive more readily
    const dest = l.teams.find((t) => t.id !== from && tradeConsent(l, p, t.id).granted)!.id;
    const chk = validateMoves(l, [{ asset: { kind: 'player', id: p.id }, from, to: dest }]);
    expect(chk.consents[0]).toMatchObject({ required: true, granted: true });
    expect(chk.errors.filter((e) => /clause/.test(e))).toEqual([]);
  });

  it('retains salary: the sender keeps part of the cap hit', () => {
    const l = fresh('tr-3');
    const from = l.teams[4].id;
    const to = l.teams[9].id;
    const p = vet(l, from);
    setContract(l, p, 6000, 3);
    const beforeFrom = teamCapSheet(l, from).total;
    const beforeTo = teamCapSheet(l, to).total;
    const moves: TradeMove[] = [{ asset: { kind: 'player', id: p.id }, from, to, retainPct: 0.5 }];
    const chk = validateMoves(l, moves);
    expect(chk.errors.filter((e) => /Retention/.test(e))).toEqual([]);
    executeMoves(l, moves);
    expect(holderCapHit(p.contract!)).toBeCloseTo(3000, 3);
    expect(teamCapSheet(l, from).total).toBeCloseTo(beforeFrom - 3000, 0);
    expect(teamCapSheet(l, to).total).toBeCloseTo(beforeTo + 3000, 0);
    expect(teamCapSheet(l, from).dead.some((d) => d.kind === 'retained' && d.playerId === p.id)).toBe(true);
  });

  it('enforces the retention limits (50%, three contracts per team, twice per contract)', () => {
    const l = fresh('tr-4');
    const from = l.teams[6].id;
    const to = l.teams[7].id;
    const vets = roster(l, from).filter((p) => p.contract && p.contract.type !== 'ELC');
    const p = vets[0];
    setContract(l, p, 4000, 3);
    expect(validateMoves(l, [{ asset: { kind: 'player', id: p.id }, from, to, retainPct: 0.6 }]).errors.join(' ')).toMatch(/more than 50%/);
    // Three contracts already retained by `from`.
    for (const other of Object.values(l.players).filter((x) => x.teamId !== from && x.contract && x.contract.type !== 'ELC').slice(0, 3)) {
      setContract(l, other, 2000, 2);
      other.contract!.retained = [{ teamId: from, pct: 0.25, season: l.season }];
    }
    expect(validateMoves(l, [{ asset: { kind: 'player', id: p.id }, from, to, retainPct: 0.25 }]).errors.join(' ')).toMatch(/already retains salary on 3 contracts/);
    // A contract retained twice cannot be retained again.
    const q = vets[1];
    setContract(l, q, 4000, 3);
    q.contract!.retained = [{ teamId: 20, pct: 0.2, season: l.season }, { teamId: 21, pct: 0.2, season: l.season }];
    expect(validateMoves(l, [{ asset: { kind: 'player', id: q.id }, from, to, retainPct: 0.1 }]).errors.join(' ')).toMatch(/already been retained on 2 times/);
  });

  it('rejects a trade that puts a team over the cap and shows the before/after', () => {
    const l = fresh('tr-5');
    const from = l.teams[10].id;
    const to = l.teams[11].id;
    const p = vet(l, from);
    setContract(l, p, 8000, 3);
    // Leave the receiving team $2M of space.
    const filler = roster(l, to).find((x) => x.contract && x.contract.type !== 'ELC')!;
    setContract(l, filler, holderCapHit(filler.contract!) + teamCapSheet(l, to).space - 2000, 2);
    const chk = validateMoves(l, [{ asset: { kind: 'player', id: p.id }, from, to }]);
    expect(chk.ok).toBe(false);
    expect(chk.errors.join(' ')).toMatch(/over the .* after this trade/);
    const imp = chk.cap.find((c) => c.teamId === to)!;
    expect(imp.after).toBeGreaterThan(imp.limit);
  });

  it('runs a legal three-team trade', () => {
    const l = fresh('tr-6');
    const [a, b, c] = [l.teams[12].id, l.teams[13].id, l.teams[14].id];
    const pa = vet(l, a);
    const pb = vet(l, b);
    const pick = l.draftPicks.find((d) => d.ownerId === c && d.round === 2)!;
    for (const p of [pa, pb]) setContract(l, p, 1000, 1);
    const moves: TradeMove[] = [
      { asset: { kind: 'player', id: pa.id }, from: a, to: b },
      { asset: { kind: 'player', id: pb.id }, from: b, to: c },
      { asset: { kind: 'pick', id: pick.id }, from: c, to: a },
    ];
    const chk = validateMoves(l, moves);
    expect(chk.errors).toEqual([]);
    expect(chk.cap).toHaveLength(3);
    executeMoves(l, moves);
    expect(pa.teamId).toBe(b);
    expect(pb.teamId).toBe(c);
    expect(pick.ownerId).toBe(a);
    expect(l.transactions[0].teamIds).toHaveLength(3);
  });
});

describe('buyouts', () => {
  it('buys out in the window and writes yearly dead-cap charges', () => {
    const l = fresh('bo-1');
    const tid = l.teams[2].id;
    const p = vet(l, tid);
    p.birthYear = l.season - 30;
    p.injury = null;
    p.contract = buildContract({ ...flatTerms(4000, 4, l.season), signingTeamId: tid }, l.season);
    expect(previewBuyout(l, p).allowed).toBe(false); // in-season: not in the window
    l.phase = 'draft';
    const r = buyoutPlayer(l, p);
    expect(r.ok).toBe(true);
    // 3 seasons remain after this one → 6 seasons of charges at 2/3.
    const charges = l.capLedger.filter((c) => c.playerId === p.id && c.kind === 'buyout');
    expect(charges.map((c) => c.season)).toEqual([1, 2, 3, 4, 5, 6].map((i) => l.season + i));
    expect(r.preview.totalCost).toBeCloseTo(12000 * (2 / 3), 3);
    expect(p.status).toBe('fa');
    expect(teamCapSheet(l, tid, l.season + 1).buyouts).toBeCloseTo(charges[0].amount, 3);
  });
});

describe('LTIR', () => {
  it('gives relief equal to cap hit minus space at placement, capped if he returns this season', () => {
    const l = fresh('lt-1');
    const tid = l.teams[8].id;
    const p = vet(l, tid);
    setContract(l, p, 9000, 3);
    // Fill the cap so the team has only $500K of space.
    const sheet = teamCapSheet(l, tid);
    const filler = roster(l, tid).find((x) => x.id !== p.id && x.contract && x.contract.type !== 'ELC')!;
    setContract(l, filler, Math.max(800, holderCapHit(filler.contract!) + sheet.space - 500), 2);
    const space = teamCapSheet(l, tid).space;
    p.injury = { type: 'Knee', bodyPart: 'knee', severity: 'severe', days: 70, totalDays: 70, daysRemaining: 70, dayInjured: l.day } as unknown as Player['injury'];
    const r = placeOnLTIR(l, p);
    expect(r.ok).toBe(true);
    const entry = l.ltir.find((x) => x.playerId === p.id)!;
    const avg = rulesFor(l.season).averageLeagueSalary;
    expect(entry.relief).toBeCloseTo(Math.min(9000 - space, avg), 1);
    expect(teamCapSheet(l, tid).ltirRelief).toBeCloseTo(entry.relief, 3);
    // Active roster count excludes LTIR.
    expect(validateRoster(l, tid).errors.join(' ')).not.toMatch(/active roster/);
    p.injury = null;
    activateFromLTIR(l, p);
    expect(l.ltir.some((x) => x.playerId === p.id)).toBe(false);
  });
});

describe('performance bonuses', () => {
  it('charges bonus overage to next season when bonuses push a team over the cap', () => {
    const l = fresh('pb-1');
    const tid = l.teams[15].id;
    const kid = roster(l, tid)[0];
    kid.contract = buildContract({ startSeason: l.season, salaries: [900, 900, 900], perfBonuses: [3000, 3000, 3000], type: 'ELC', twoWay: true, signingTeamId: tid, ageAtStart: 20, signedSeason: l.season - 1 }, l.season);
    l.seasonStats[kid.id] = { reg: { ...emptyStatLine(), gp: 82, g: 40, a1: 30, a2: 20 }, po: emptyStatLine(), teamId: tid };
    // Push the team up to the cap without bonuses.
    const sheet = teamCapSheet(l, tid, l.season);
    const filler = roster(l, tid).find((x) => x.id !== kid.id && x.contract && x.contract.type !== 'ELC')!;
    setContract(l, filler, holderCapHit(filler.contract!) + (sheet.upper - (sheet.total - sheet.perfBonusPotential)), 2);
    const res = settlePerformanceBonuses(l).find((r) => r.teamId === tid)!;
    expect(res.earned).toBeGreaterThan(2000);
    expect(res.overage).toBeGreaterThan(0);
    const ch = l.capLedger.find((c) => c.teamId === tid && c.kind === 'bonusOverage')!;
    expect(ch.season).toBe(l.season + 1);
    expect(teamCapSheet(l, tid, l.season + 1).bonuses).toBeCloseTo(ch.amount, 3);
  });
});

describe('35+ contracts and ELC slides', () => {
  it('keeps a 35+ contract on the cap after retirement', () => {
    const l = fresh('35-1');
    const tid = l.teams[16].id;
    const p = vet(l, tid);
    p.birthYear = l.season - 36;
    p.contract = buildContract({ startSeason: l.season, salaries: [3000, 2000], signingTeamId: tid, ageAtStart: 36, signedSeason: l.season - 1 }, l.season);
    p.contract.thirtyFivePlus = true;
    thirtyFivePlusRetirement(l, p, l.season);
    const ch = l.capLedger.filter((c) => c.playerId === p.id);
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ season: l.season + 1, kind: 'thirtyFivePlus' });
    expect(ch[0].amount).toBeCloseTo(2500, 3);
  });

  it('slides an ELC for a 19-year-old with fewer than 10 NHL games', () => {
    const l = fresh('sl-1');
    const p = Object.values(l.players).find((x) => x.status === 'prospect' && x.teamId !== null)!;
    p.birthYear = l.season - 19;
    p.contract = buildContract({ startSeason: l.season, salaries: [950, 950, 950], type: 'ELC', twoWay: true, signingTeamId: p.teamId, ageAtStart: 19, signedSeason: l.season - 1 }, l.season);
    l.seasonStats[p.id] = { reg: { ...emptyStatLine(), gp: 5 }, po: emptyStatLine(), teamId: p.teamId! };
    const slid = applyElcSlides(l, l.season);
    expect(slid.map((x) => x.id)).toContain(p.id);
    expect(yearsOf(p.contract).map((y) => y.season)).toEqual([l.season + 1, l.season + 2, l.season + 3]);
  });
});

describe('roster and playoff cap', () => {
  it('flags an active roster over 23 players', () => {
    const l = fresh('rs-1');
    const tid = l.teams[17].id;
    const pros = Object.values(l.players).filter((p) => p.teamId === tid && p.status === 'prospect' && p.contract);
    for (const p of pros.slice(0, 30)) p.status = 'active';
    for (const p of roster(l, tid)) p.injury = null;
    if (roster(l, tid).length > 23) expect(validateRoster(l, tid).errors.join(' ')).toMatch(/limit 23/);
  });

  it('blocks an illegal playoff lineup and fixes it by scratching expensive players', () => {
    const l = fresh('po-1');
    l.season = 2026;
    l.phase = 'playoffs';
    const tid = l.teams[18].id;
    const players = roster(l, tid);
    for (const p of players) {
      p.injury = null;
      setContract(l, p, p.pos === 'G' ? 2000 : 6000, 2);
    }
    const lines = autoLines(players);
    const res = enforcePlayoffCap(l, tid, lines, dressedIds);
    expect(res.errors.join(' ')).toMatch(/Playoff lineup blocked/);
    // 18 skaters × $6M = $108M > $104M; no cheaper scratches exist, so it can't be fixed.
    expect(res.ok).toBe(false);
    // Add cheap call-ups: now it can be fixed.
    const callups = Object.values(l.players).filter((p) => p.teamId === tid && p.status === 'prospect' && p.pos !== 'G').slice(0, 3);
    for (const p of callups) {
      p.status = 'active';
      p.injury = null;
      setContract(l, p, 900, 1);
    }
    const fixed = enforcePlayoffCap(l, tid, lines, dressedIds);
    expect(fixed.ok).toBe(true);
    expect(fixed.changes.length).toBeGreaterThan(0);
  });
});
