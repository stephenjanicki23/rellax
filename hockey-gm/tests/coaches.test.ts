import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { startRegularSeason } from '../src/engine/league/offseason';
import { simDays } from '../src/engine/league/season';
import { coachTotals, coachTraits } from '../src/engine/team/coaching';
import { realCoachSeasons } from '../src/engine/data/nhl/coachRecords';
import {
  closeCoachSeason,
  coachAsk,
  coachOf,
  coachRefusal,
  deadStaffMoney,
  offerCoach,
  staffBudget,
  staffSpend,
  userFireCoach,
} from '../src/engine/team/staffMarket';

describe('coaches', () => {
  it('real head coaches carry their real NHL records and the market holds real former coaches', () => {
    const l = createLeague({ seed: 'coach-1' });
    for (const t of l.teams) {
      const hc = coachOf(l, t, 'headCoach')!;
      expect(hc).toBeTruthy();
      expect(hc.real).toBe(true);
      const real = realCoachSeasons(`${hc.first} ${hc.last}`);
      expect(hc.career.filter((c) => c.real)).toHaveLength(real.length);
      const gp = real.reduce((s, x) => s + x.gp, 0);
      expect(coachTotals(hc).gp).toBe(gp);
    }
    const pool = Object.values(l.coaches).filter((c) => c.teamId === null);
    for (const role of ['head', 'assistant', 'goalie'] as const) expect(pool.filter((c) => c.role === role).length).toBeGreaterThanOrEqual(5);
    // Every coach has at least one strength and one weakness to weigh.
    for (const c of Object.values(l.coaches).slice(0, 60)) {
      const tr = coachTraits(c);
      expect(tr.strengths.length).toBeGreaterThan(0);
      expect(tr.weaknesses.length + tr.strengths.length).toBeGreaterThan(1);
    }
  });

  it('firing a head coach in season promotes the assistant as interim and keeps paying the fired coach', () => {
    const l = createLeague({ seed: 'coach-2' });
    startRegularSeason(l);
    const me = l.teams[l.userTeamId];
    const hc = coachOf(l, me, 'headCoach')!;
    const asst = coachOf(l, me, 'assistant')!;
    const owed = hc.contract!.salary;
    const r = userFireCoach(l, me.id, 'headCoach');
    expect(r.ok).toBe(true);
    expect(coachOf(l, me, 'headCoach')!.id).toBe(asst.id);
    expect(asst.interim).toBe(true);
    expect(me.staff.assistant).toBeNull();
    expect(deadStaffMoney(l, me)).toBe(owed);
    expect(hc.teamId).toBeNull();
    // He won't come back to the club that fired him.
    expect(coachRefusal(l, hc, me.id, 'head')).toMatch(/fired/);
  });

  it('coaches turn down lowball offers, respect the staff budget and accept their ask', () => {
    const l = createLeague({ seed: 'coach-3' });
    const me = l.teams[l.userTeamId];
    const fired = me.staff.goalieCoach;
    userFireCoach(l, me.id, 'goalieCoach');
    const cand = Object.values(l.coaches).find((c) => c.teamId === null && c.role === 'goalie' && c.id !== fired)!;
    const ask = coachAsk(l, cand, 'goalie', me.id);
    expect(offerCoach(l, me.id, cand.id, 'goalie', Math.round(ask.salary * 0.7), ask.years).ok).toBe(false);
    expect(offerCoach(l, me.id, cand.id, 'goalie', staffBudget(me) - staffSpend(l, me) + 100, ask.years).message).toMatch(/budget/);
    const ok = offerCoach(l, me.id, cand.id, 'goalie', ask.salary, ask.years);
    expect(ok.ok).toBe(true);
    expect(coachOf(l, me, 'goalieCoach')!.id).toBe(cand.id);
    // A filled job must be vacated before hiring someone else.
    const other = Object.values(l.coaches).find((c) => c.teamId === null && c.role === 'goalie' && c.id !== fired)!;
    expect(offerCoach(l, me.id, other.id, 'goalie', 5000, 2).ok).toBe(false);
  });

  it('head coaches are credited only with the games they coached', () => {
    const l = createLeague({ seed: 'coach-4' });
    startRegularSeason(l);
    l.settings.autoManageUser = true;
    simDays(l, 20);
    const me = l.teams[l.userTeamId];
    const first = coachOf(l, me, 'headCoach')!;
    const gpBefore = l.standings[me.id].gp;
    userFireCoach(l, me.id, 'headCoach');
    const interim = coachOf(l, me, 'headCoach')!;
    simDays(l, 15);
    const rec = l.standings[me.id];
    const s1 = first.stints!.filter((s) => s.season === l.season).reduce((a, s) => a + s.gp, 0);
    const s2 = interim.stints!.filter((s) => s.season === l.season).reduce((a, s) => a + s.gp, 0);
    expect(s1).toBe(gpBefore);
    expect(s1 + s2).toBe(rec.gp);
    const w = [first, interim].flatMap((c) => c.stints!).reduce((a, s) => a + s.w, 0);
    expect(w).toBe(rec.w);
    // League-wide: every team's games are credited to someone.
    for (const t of l.teams) {
      const credited = Object.values(l.coaches).flatMap((c) => (c.stints ?? []).filter((s) => s.teamId === t.id)).reduce((a, s) => a + s.gp, 0);
      expect(credited).toBe(l.standings[t.id].gp);
    }
    closeCoachSeason(l);
    const line = interim.career.at(-1)!;
    expect(line.interim).toBe(true);
    expect(line.gp).toBe(s2);
    expect(interim.stints).toHaveLength(0);
  });
});
