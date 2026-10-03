import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { teamCapSheet } from '../src/engine/cba/capManager';
import { activeClause, fullCapHit, holderCapHit, yearsOf } from '../src/engine/cba/contract';
import { validateRoster } from '../src/engine/cba/rulesEngine';
import { contractDbInfo } from '../src/engine/cba/import';
import type { League } from '../src/engine/types';

/** League built from the bundled NHL rosters and the imported CapWages contract database. */
const league = createLeague({ seed: 'real-contracts' });
const byNhl = (l: League, id: number) => Object.values(l.players).find((p) => p.nhlId === id)!;
const team = (abbr: string) => league.teams.find((t) => t.abbr === abbr)!;

describe('imported NHL contracts', () => {
  it('loads the contract database', () => {
    expect(contractDbInfo().count).toBeGreaterThan(1000);
    const real = Object.values(league.players).filter((p) => p.contract?.source === 'real').length;
    expect(real).toBeGreaterThan(1300);
  });

  it('uses official terms: cap hit, year-by-year pay, clauses and history', () => {
    const p = byNhl(league, 8477956); // David Pastrnak
    const c = p.contract!;
    expect(fullCapHit(c)).toBe(11250);
    expect(yearsOf(c)[0].season).toBe(2023);
    expect(yearsOf(c)).toHaveLength(8);
    expect(yearsOf(c).find((y) => y.season === 2026)).toMatchObject({ salary: 8250, signingBonus: 3000 });
    expect(activeClause(c, 2026)?.kind).toBe('NMC');
    expect(activeClause(c, 2030)?.kind).toBe('M-NTC');
    expect(c.expiryStatus).toBe('UFA');
    expect(p.contractHistory!.length).toBeGreaterThanOrEqual(3);
    expect(p.contractHistory![0].type).toBe('ELC');
  });

  it('picks the newest contract when deals overlap', () => {
    const k = byNhl(league, 8475184); // Chris Kreider: new Montreal deal replaces the old Rangers contract
    expect(fullCapHit(k.contract!)).toBe(2150);
    expect(k.teamId).toBe(team('MTL').id);
  });

  it('applies retained salary to both clubs', () => {
    const p = byNhl(league, 8478450); // Parker Wotherspoon, 50% retained by Pittsburgh
    expect(holderCapHit(p.contract!)).toBeCloseTo(500, 3);
    expect(teamCapSheet(league, team('PIT').id).dead.some((d) => d.kind === 'retained' && d.playerId === p.id)).toBe(true);
  });

  it('carries existing buyouts as dead cap', () => {
    const sjs = teamCapSheet(league, team('SJS').id);
    expect(sjs.dead.filter((d) => d.kind === 'buyout').map((d) => d.name)).toEqual(expect.arrayContaining(['Martin Jones', 'Marc-Edouard Vlasic']));
  });

  it('starts every club cap compliant with a legal roster', () => {
    for (const t of league.teams) {
      const s = teamCapSheet(league, t.id);
      expect(s.compliant, `${t.abbr} ${s.total} > ${s.effectiveLimit}`).toBe(true);
      expect(validateRoster(league, t.id).errors, t.abbr).toEqual([]);
    }
  });

  it('puts long-term injured players on LTIR with relief', () => {
    expect(league.ltir.length).toBeGreaterThan(5);
    for (const l of league.ltir) expect(league.players[l.playerId].ltir).toBe(true);
  });
});
