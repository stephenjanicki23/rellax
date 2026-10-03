import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { simDays, advanceDay } from '../src/engine/league/season';
import { serializeLeague, deserializeLeague } from '../src/engine/save';
import { buildContract } from '../src/engine/cba/contract';
import { teamCapSheet } from '../src/engine/cba/capManager';

describe('save / load', () => {
  it('round-trips the league and continues identically (deterministic after load)', () => {
    const league = createLeague({ seed: 'save-test' });
    simDays(league, 10);
    const text = serializeLeague(league, 'slot1');
    const { league: copy, meta } = deserializeLeague(text);
    expect(meta.season).toBe(league.season);
    expect(copy.day).toBe(league.day);
    // Continue both and compare.
    for (let i = 0; i < 5; i++) {
      advanceDay(league);
      advanceDay(copy);
    }
    expect(JSON.stringify(copy.standings)).toBe(JSON.stringify(league.standings));
    expect(copy.rng).toEqual(league.rng);
    expect(text.length).toBeLessThan(15_000_000);
  });

  it('persists the full contract, cap and CBA state', () => {
    const league = createLeague({ seed: 'save-cba', rosters: false });
    const tid = league.teams[3].id;
    const p = Object.values(league.players).find((x) => x.teamId === tid && x.status === 'active' && x.contract && x.contract.type !== 'ELC')!;
    p.contract = buildContract({ startSeason: league.season, salaries: [7000, 6000, 5000], signingBonuses: [1000, 1000, 0], clauses: [{ kind: 'M-NTC', from: league.season, to: league.season + 2, teams: 10, mode: 'block' }], signingTeamId: tid, signedSeason: league.season - 1, ageAtStart: 29 }, league.season);
    p.contract.retained = [{ teamId: 9, pct: 0.25, season: league.season }];
    p.contract.expiryStatus = 'UFA';
    league.capLedger.push({ id: 1, teamId: tid, season: league.season + 1, amount: 1234.5, kind: 'buyout', playerName: 'Someone', note: 'test' });
    league.ltir.push({ playerId: p.id, teamId: tid, season: league.season, day: 3, relief: 4000, capHit: 7000, seasonEnding: true });
    league.waivers.push({ playerId: p.id, fromTeamId: tid, season: league.season, day: 2, claims: [5], reason: 'assignment', status: 'pending' });
    league.negotiations[p.id] = { playerId: p.id, teamId: tid, season: league.season, patience: 42, demand: { aav: 6000, years: 4 }, history: [{ aav: 5000, years: 4, response: 'Too low.' }] };
    const before = teamCapSheet(league, tid);
    const { league: copy } = deserializeLeague(serializeLeague(league, 'cba'));
    const q = copy.players[p.id];
    expect(q.contract).toEqual(p.contract);
    expect(q.contractHistory).toEqual(p.contractHistory);
    expect(copy.capLedger).toEqual(league.capLedger);
    expect(copy.ltir).toEqual(league.ltir);
    expect(copy.waivers).toEqual(league.waivers);
    expect(copy.negotiations).toEqual(league.negotiations);
    const after = teamCapSheet(copy, tid);
    expect(after.total).toBeCloseTo(before.total, 6);
    expect(after.ltirRelief).toBe(4000);
    expect(teamCapSheet(copy, 9).retained).toBeCloseTo(teamCapSheet(league, 9).retained, 6);
  });

  it('upgrades a legacy flat contract to the full contract model', () => {
    const league = createLeague({ seed: 'save-legacy', rosters: false });
    const p = Object.values(league.players).find((x) => x.contract && x.status === 'active')!;
    const legacy = JSON.parse(serializeLeague(league, 'old'));
    legacy.league.version = 1;
    delete legacy.league.capLedger;
    legacy.league.players[p.id].contract = { salary: 3000, years: 2, type: 'standard', ntc: true, signedSeason: league.season - 1 };
    const { league: copy } = deserializeLeague(JSON.stringify(legacy));
    const c = copy.players[p.id].contract!;
    expect(c.yearsDetail).toHaveLength(2);
    expect(c.clauses?.[0].kind).toBe('NTC');
    expect(copy.capLedger).toEqual([]);
  });

  it('rejects garbage', () => {
    expect(() => deserializeLeague('{"foo":1}')).toThrow();
  });
});
