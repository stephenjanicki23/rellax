import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { buildContract, flatTerms, holderCapHit } from '../src/engine/cba/contract';
import { teamCapSheet } from '../src/engine/cba/capManager';
import { aiBuyouts, aiCapHousekeeping, financialPlan, fitsPlan, planContext } from '../src/engine/ai/finance';
import type { League, Player } from '../src/engine/types';

const fresh = (seed: string) => createLeague({ seed, rosters: false });
const roster = (l: League, tid: number) => Object.values(l.players).filter((p) => p.teamId === tid && p.status === 'active');

describe('AI financial planning', () => {
  it('gives GMs different financial styles', () => {
    const l = fresh('ai-1');
    const styles = new Set(l.teams.map((t) => financialPlan(l, t.id).style));
    expect(styles.size).toBeGreaterThanOrEqual(2);
  });

  it('frugal GMs refuse long deals for players over 30; aggressive GMs bid higher', () => {
    const l = fresh('ai-2');
    const t = l.teams[0];
    t.strategy = 'rebuild';
    t.gm.aggression = 0;
    t.gm.philosophy = 'youth';
    const plan = financialPlan(l, t.id);
    expect(plan.style).toBe('frugal');
    const old = roster(l, t.id).find((p) => p.ca < 150)!;
    old.birthYear = l.season - 32;
    expect(fitsPlan(l, t.id, old, 2000, 5).ok).toBe(false);
    const u = l.teams[1];
    u.strategy = 'contend';
    u.gm.aggression = 1;
    u.gm.philosophy = 'winNow';
    expect(financialPlan(l, u.id).overpay).toBeGreaterThan(plan.overpay);
  });

  it('protects future cap space when RFA raises are coming', () => {
    const l = fresh('ai-3');
    const t = l.teams[2];
    const p = roster(l, t.id).find((x) => x.ca < 150)!;
    const ctx = planContext(l, t.id);
    ctx.future = 1000; // almost nothing left next season
    expect(fitsPlan(l, t.id, p, 4000, 4, ctx).ok).toBe(false);
    expect(fitsPlan(l, t.id, p, 4000, 1, ctx).ok).toBe(ctx.total + 4000 <= ctx.upper * ctx.plan.spendTarget);
  });

  it('buys out a badly overpaid contract in the window when the team needs room', () => {
    const l = fresh('ai-4');
    const t = l.teams.find((x) => x.id !== l.userTeamId && financialPlan(l, x.id).buyouts)!;
    const p = roster(l, t.id).find((x) => x.ca < 125 && x.contract && x.contract.type !== 'ELC') as Player;
    p.injury = null;
    p.birthYear = l.season - 31;
    p.contract = buildContract({ ...flatTerms(9000, 5, l.season), signingTeamId: t.id }, l.season);
    l.phase = 'draft';
    const bought = aiBuyouts(l);
    expect(bought.map((x) => x.id)).toContain(p.id);
    expect(l.capLedger.some((c) => c.playerId === p.id && c.kind === 'buyout')).toBe(true);
  });

  it('gets an over-the-cap CPU team compliant', () => {
    const l = fresh('ai-5');
    const t = l.teams.find((x) => x.id !== l.userTeamId)!;
    const p = roster(l, t.id).find((x) => x.contract && x.contract.type !== 'ELC' && !(x.contract.clauses ?? []).length)!;
    const sheet = teamCapSheet(l, t.id);
    p.contract = buildContract({ ...flatTerms(holderCapHit(p.contract!) + sheet.space + 3000, 2, l.season), signingTeamId: t.id }, l.season);
    expect(teamCapSheet(l, t.id).compliant).toBe(false);
    aiCapHousekeeping(l);
    expect(teamCapSheet(l, t.id).compliant).toBe(true);
  });
});
