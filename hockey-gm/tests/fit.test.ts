import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { teamGameInput } from '../src/engine/league/gameInput';
import { allOptionFits, coachChangeFamiliarity, fitNorm, learnSystem, playerFit, syncFamiliarity, trainingCamp, rosterChangeFamiliarity } from '../src/engine/team/fit';
import type { League } from '../src/engine/types';

const league = createLeague({ seed: 'fit-tests' });
const roster = (l: League, tid: number) => Object.values(l.players).filter((p) => p.teamId === tid && p.status === 'active');

describe('tactical fit', () => {
  it('is centred: across the league every system averages out', () => {
    const norm = fitNorm(league);
    const sums: Record<string, number[]> = {};
    for (const t of league.teams) for (const [a, opts] of Object.entries(allOptionFits(norm, roster(league, t.id)))) for (const [o, v] of Object.entries(opts)) (sums[`${a}.${o}`] ??= []).push(v);
    for (const [k, v] of Object.entries(sums)) expect(Math.abs(v.reduce((s, x) => s + x, 0) / v.length), k).toBeLessThan(0.2);
  });

  it('describes style, not quality: a fast, skilled forward suits the rush, not a physical game', () => {
    const norm = fitNorm(league);
    const mc = Object.values(league.players).find((p) => p.last === 'McDavid')!;
    expect(playerFit(mc, 'offense', 'rush', norm)).toBeGreaterThan(0.5);
    expect(playerFit(mc, 'defense', 'physical', norm)).toBeLessThan(0);
    expect(playerFit(mc, 'offense', 'balanced', norm)).toBe(0);
  });

  it('feeds team fit and familiarity into the game engine', () => {
    const t = league.teams[0];
    const inp = teamGameInput(league, t, 1, false, 0);
    expect(inp.fit).toBeDefined();
    expect(inp.familiarity).toBeDefined();
    for (const v of Object.values(inp.fit!)) expect(Math.abs(v)).toBeLessThanOrEqual(1);
  });
});

describe('system familiarity', () => {
  it('grows with games, halves on a system change, resets with a new coach and recovers in camp', () => {
    const l = createLeague({ seed: 'fam-tests', rosters: false });
    const t = l.teams[3];
    syncFamiliarity(t);
    coachChangeFamiliarity(t);
    expect(t.familiarity!.offense).toBeCloseTo(0.35, 6);
    learnSystem(l, t);
    expect(t.familiarity!.offense).toBeGreaterThan(0.35);
    const before = t.familiarity!.offense;
    t.tactics = { ...t.tactics, offense: t.tactics.offense === 'rush' ? 'cycle' : 'rush' };
    syncFamiliarity(t);
    expect(t.familiarity!.offense).toBeCloseTo(before / 2, 6);
    const def = t.familiarity!.defense;
    rosterChangeFamiliarity(t, 2);
    expect(t.familiarity!.defense).toBeLessThan(def);
    trainingCamp(t);
    expect(t.familiarity!.offense).toBeGreaterThan(before / 2);
  });
});

describe('real coaching identities', () => {
  it('gives real head coaches their known philosophy and signature system', () => {
    const coach = (name: string) => Object.values(league.coaches).find((c) => `${c.first} ${c.last}` === name)!;
    expect(coach('Jon Cooper').philosophy).toBe('structured');
    expect(coach("Rod Brind'Amour").system?.defense).toBe('aggressive');
    expect(coach('Paul Maurice').philosophy).toBe('physical');
    expect(coach('Paul Maurice').styleNote).toMatch(/forecheck/);
  });
});
