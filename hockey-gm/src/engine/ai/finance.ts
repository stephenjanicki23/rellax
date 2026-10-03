/**
 * AI front-office finance: every CPU GM manages the cap through the same
 * CapManager / rules engine as the user, with a style that depends on team
 * strategy and GM personality. Aggressive GMs spend to the cap and sometimes
 * overpay; frugal ones protect future space and let players walk; all of
 * them look at future cap projections (including RFA raises) before signing.
 */
import type { League, Player } from '../types';
import { seedFrom } from '../core/rng';
import { isCpu, playersOf } from '../league/helpers';
import { capProjection, capSeason, contractFor, teamCapSheet } from '../cba/capManager';
import { contractValue } from '../cba/market';
import { holderCapHit } from '../cba/contract';
import { buyoutPlayer, canPlaceOnLTIR, inBuyoutWindow, placeOnLTIR, previewBuyout } from '../cba/capActions';
import { enforceCap } from '../economy/roster';

export type FinanceStyle = 'aggressive' | 'balanced' | 'frugal';

export interface FinancialPlan {
  style: FinanceStyle;
  /** Share of the upper limit the GM is comfortable spending. */
  spendTarget: number;
  /** Multiplier on free-agent bids (> 1 = willing to overpay). */
  overpay: number;
  /** Projected space (thousands) the GM wants to keep next season after RFA raises; negative = will go over and fix it later. */
  futureBuffer: number;
  /** Longest term the GM hands out to players 30+. */
  maxTermOver30: number;
  buyouts: boolean;
  /** Will retain salary to sell at the deadline. */
  retainToSell: boolean;
  /** Uses LTIR to create room proactively (not only when over the cap). */
  ltirAggressive: boolean;
}

export function financialPlan(league: League, teamId: number): FinancialPlan {
  const t = league.teams[teamId];
  const h = (seedFrom(league.seed, 'gmfin', t.id, t.gm.name) % 1000) / 1000;
  const aggression = t.gm.aggression ?? 0.5;
  let score = (t.strategy === 'contend' ? 0.35 : t.strategy === 'rebuild' ? -0.35 : 0) + (aggression - 0.5) * 0.6 + (h - 0.5) * 0.5;
  if (t.gm.philosophy === 'winNow') score += 0.15;
  if (t.gm.philosophy === 'youth' || t.gm.philosophy === 'analytics') score -= 0.1;
  const style: FinanceStyle = score > 0.12 ? 'aggressive' : score < -0.12 ? 'frugal' : 'balanced';
  const budgetShare = Math.min(1, t.budget / Math.max(1, league.cap.upper));
  return {
    style,
    spendTarget: Math.min(budgetShare, style === 'aggressive' ? 0.995 : style === 'balanced' ? 0.96 : 0.9),
    overpay: style === 'aggressive' ? 1.06 + h * 0.08 : style === 'balanced' ? 1.0 : 0.94,
    futureBuffer: style === 'aggressive' ? -2500 : style === 'balanced' ? 1500 : 6000,
    maxTermOver30: style === 'aggressive' ? 6 : style === 'balanced' ? 4 : 2,
    buyouts: style !== 'frugal' || t.strategy === 'rebuild',
    retainToSell: t.strategy !== 'contend',
    ltirAggressive: style === 'aggressive' && t.strategy === 'contend',
  };
}

export interface PlanContext {
  teamId: number;
  plan: FinancialPlan;
  total: number;
  upper: number;
  /** Lowest projected space over the next two seasons after expected RFA raises. */
  future: number;
}

export function planContext(league: League, teamId: number): PlanContext {
  const sheet = teamCapSheet(league, teamId);
  const proj = capProjection(league, teamId, 3, (p) => contractValue(p, league).value);
  const later = proj.slice(1);
  return { teamId, plan: financialPlan(league, teamId), total: sheet.total, upper: sheet.upper, future: later.length ? Math.min(...later.map((y) => y.projectedSpace)) : Infinity };
}

/** Does a contract fit the GM's long-term plan? Pass a PlanContext to reuse it across candidates (update `total` as offers are made). */
export function fitsPlan(league: League, teamId: number, p: Player, aav: number, years: number, ctx: PlanContext = planContext(league, teamId)): { ok: boolean; reason: string } {
  const plan = ctx.plan;
  const age = capSeason(league) - p.birthYear;
  if (age >= 30 && years > plan.maxTermOver30 && p.ca < 160) return { ok: false, reason: `won't give a ${age}-year-old ${years} years` };
  if (ctx.total + aav > ctx.upper * plan.spendTarget + (p.ca >= 155 ? ctx.upper * 0.03 : 0)) return { ok: false, reason: 'over the spending target' };
  // Stars get some leeway: GMs will squeeze the future for a difference-maker.
  if (years >= 2 && ctx.future - aav < plan.futureBuffer - (p.ca >= 155 ? 4000 : 0)) return { ok: false, reason: 'would squeeze future cap space' };
  return { ok: true, reason: '' };
}

/**
 * Offseason buyouts (CPU, in the window): a contract well above the player's
 * value when the team needs room, at most one per summer.
 */
export function aiBuyouts(league: League): Player[] {
  if (!inBuyoutWindow(league)) return [];
  const out: Player[] = [];
  for (const t of league.teams) {
    if (!isCpu(league, t.id)) continue;
    const plan = financialPlan(league, t.id);
    if (!plan.buyouts) continue;
    const next = teamCapSheet(league, t.id, league.season + 1);
    const tight = next.upper - next.total < 6000;
    const cands = [...playersOf(league, t.id, ['active', 'prospect'])]
      .map((p) => {
        const c = contractFor(p, league.season + 1);
        if (!c || c.type === 'ELC') return null;
        const hit = holderCapHit(c);
        const surplus = contractValue(p, league).value - hit;
        return { p, hit, surplus };
      })
      .filter((x): x is { p: Player; hit: number; surplus: number } => !!x && x.hit >= 2500 && x.surplus < (tight ? -2000 : -4500))
      .sort((a, b) => a.surplus - b.surplus);
    for (const c of cands) {
      const pv = previewBuyout(league, c.p);
      // Only if it actually saves meaningful cap next season.
      const nextCharge = pv.capCharges[league.season + 1] ?? 0;
      if (!pv.allowed || c.hit - nextCharge < 1000) continue;
      if (buyoutPlayer(league, c.p).ok) out.push(c.p);
      break;
    }
  }
  return out;
}

/** Weekly in-season cap housekeeping for CPU teams: compliance and proactive LTIR. */
export function aiCapHousekeeping(league: League): void {
  for (const t of league.teams) {
    if (!isCpu(league, t.id)) continue;
    const sheet = teamCapSheet(league, t.id);
    if (!sheet.compliant) {
      enforceCap(league, t.id);
      continue;
    }
    const plan = financialPlan(league, t.id);
    if (plan.ltirAggressive && sheet.space < 2000) {
      const p = playersOf(league, t.id).filter((x) => !x.ltir && canPlaceOnLTIR(league, x).ok).sort((a, b) => (b.contract?.salary ?? 0) - (a.contract?.salary ?? 0))[0];
      if (p) placeOnLTIR(league, p);
    }
  }
}
