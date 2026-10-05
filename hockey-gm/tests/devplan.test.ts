import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { playersOf } from '../src/engine/league/helpers';
import { developPlayer } from '../src/engine/player/development';
import { FOCUS, coachSuggestion, devProgress, focusOptions, setDevPlan } from '../src/engine/player/devPlan';
import type { Player } from '../src/engine/types';

const ctx = (season: number) => ({ season, iceTime: 1, environment: 1, fraction: 1, injuryDays: 0, minors: false, leagueSeed: 'dev-seed' });
const avg = (p: Player, keys: readonly string[]) => keys.reduce((s, k) => s + p.attrs[k as keyof Player['attrs']], 0) / keys.length;

describe('development plans', () => {
  it('a focus steers growth into that area without changing how much he grows overall', () => {
    const l = createLeague({ seed: 'dev-1' });
    const young = playersOf(l, l.userTeamId, ['active', 'prospect']).filter((p) => p.pos !== 'G' && p.pa - p.ca > 20).sort((a, b) => a.birthYear - b.birthYear).at(-1)!;
    const plain: Player = structuredClone(young);
    const focused: Player = structuredClone(young);
    focused.devPlan = { focus: 'skating', intensity: 'normal' };
    developPlayer(plain, ctx(l.season));
    developPlayer(focused, ctx(l.season));
    const keys = FOCUS.skating.keys;
    expect(avg(focused, keys) - avg(young, keys)).toBeGreaterThan(avg(plain, keys) - avg(young, keys));
    expect(Math.abs(focused.ca - plain.ca)).toBeLessThanOrEqual(2);
  });

  it('intense plans grow players faster than light ones', () => {
    const l = createLeague({ seed: 'dev-2' });
    const young = playersOf(l, l.userTeamId, ['active', 'prospect']).filter((p) => p.pa - p.ca > 20)[0];
    const light: Player = structuredClone(young);
    const intense: Player = structuredClone(young);
    light.devPlan = { focus: 'balanced', intensity: 'light' };
    intense.devPlan = { focus: 'balanced', intensity: 'intense' };
    developPlayer(light, ctx(l.season));
    developPlayer(intense, ctx(l.season));
    expect(intense.ca).toBeGreaterThanOrEqual(light.ca);
  });

  it('plans are only for your players, suggestions fit the position, and progress is tracked', () => {
    const l = createLeague({ seed: 'dev-3' });
    const mine = playersOf(l, l.userTeamId)[0];
    const theirs = playersOf(l, (l.userTeamId + 1) % 32)[0];
    expect(setDevPlan(l, theirs, 'skating', 'normal').ok).toBe(false);
    const f = coachSuggestion(mine);
    expect(focusOptions(mine)).toContain(f);
    expect(setDevPlan(l, mine, f, 'intense').ok).toBe(true);
    expect(devProgress(l, mine)).toBeTruthy();
    const g = playersOf(l, l.userTeamId).find((p) => p.pos === 'G')!;
    expect(setDevPlan(l, g, 'shooting', 'normal').ok).toBe(false);
  });
});
