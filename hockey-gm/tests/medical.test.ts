import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { playersOf } from '../src/engine/league/helpers';
import { canPlayThrough, medicalDay, medicalRisk, playThrough, restedTonight, setMedicalLevel, shutDown } from '../src/engine/team/medical';
import { toGamePlayer } from '../src/engine/league/gameInput';
import { staffSpend } from '../src/engine/team/staffMarket';

const injure = (p: ReturnType<typeof playersOf>[number], days: number, severity: 'minor' | 'moderate' | 'major' = 'moderate', bodyPart: 'upper' | 'head' = 'upper') => {
  p.injury = { type: 'Upper-body injury', bodyPart, severity, daysRemaining: days, totalDays: days, season: 2026, dayInjured: 0 };
};

describe('medical staff and injury management', () => {
  it('better medical staff heal players faster and cost more', () => {
    const l = createLeague({ seed: 'med-1' });
    const me = l.teams[l.userTeamId];
    const other = l.teams[(l.userTeamId + 1) % 32];
    const a = playersOf(l, me.id)[3];
    const b = playersOf(l, other.id)[3];
    injure(a, 60);
    injure(b, 60);
    const spendLow = staffSpend(l, me);
    setMedicalLevel(l, 5);
    other.medicalLevel = 1;
    expect(staffSpend(l, me)).toBeGreaterThan(spendLow);
    expect(medicalRisk(me)).toBeLessThan(medicalRisk(other));
    for (let d = 0; d < 30; d++) {
      l.day = d;
      medicalDay(l);
    }
    expect(a.injury!.daysRemaining).toBeLessThan(b.injury!.daysRemaining);
  });

  it('playing through an injury: available, less effective, riskier, and can be shut down', () => {
    const l = createLeague({ seed: 'med-2' });
    const p = playersOf(l, l.userTeamId).find((x) => x.pos !== 'G')!;
    injure(p, 10, 'major');
    expect(canPlayThrough(p)).toMatch(/serious/);
    injure(p, 10, 'moderate', 'head');
    expect(canPlayThrough(p)).toMatch(/head/);
    injure(p, 10);
    const healthy = toGamePlayer({ ...p, injury: null }, l.season);
    expect(playThrough(l, p).ok).toBe(true);
    expect(p.injury).toBeNull();
    const hurt = toGamePlayer(p, l.season);
    expect(hurt.form).toBeLessThan(healthy.form);
    expect(hurt.injuryRisk).toBeGreaterThan(healthy.injuryRisk);
    medicalDay(l);
    expect(p.playingHurt!.daysLeft).toBe(9.5);
    expect(shutDown(l, p).ok).toBe(true);
    expect(p.injury!.daysRemaining).toBe(10);
  });

  it('load-managed players sit the second night of a back-to-back (user club only)', () => {
    const l = createLeague({ seed: 'med-3' });
    const me = l.teams[l.userTeamId];
    const vet = playersOf(l, me.id)[0];
    vet.loadManaged = true;
    expect(restedTonight(l, me, true).has(vet.id)).toBe(true);
    expect(restedTonight(l, me, false).size).toBe(0);
  });
});
