/**
 * Individual development plans: the GM picks a training focus and intensity
 * for a player. Focus doesn't add ability by itself; it steers where his
 * growth goes. Intensity trades a little extra growth (more with a good
 * development staff) against fatigue and, for some personalities, morale.
 */
import { clamp } from '../core/math';
import type { AttrKey, DevFocus, DevIntensity, League, Player } from '../types';
import { DEFENSIVE_ATTRS, IQ_ATTRS, PHYSICAL_ATTRS, PUCK_ATTRS, SHOOTING_ATTRS, SKATING_ATTRS } from '../types';
import { abilityWeights } from './ability';
import { fullName } from './ability';

export const FOCUS: Record<DevFocus, { label: string; keys: readonly AttrKey[]; goalie?: boolean; skater?: boolean }> = {
  balanced: { label: 'Balanced', keys: [] },
  skating: { label: 'Skating', keys: SKATING_ATTRS, skater: true },
  shooting: { label: 'Shooting', keys: SHOOTING_ATTRS, skater: true },
  puck: { label: 'Puck skills', keys: PUCK_ATTRS, skater: true },
  iq: { label: 'Hockey IQ', keys: IQ_ATTRS, skater: true },
  defense: { label: 'Defensive play', keys: DEFENSIVE_ATTRS, skater: true },
  physical: { label: 'Strength & conditioning', keys: PHYSICAL_ATTRS, skater: true },
  reflexes: { label: 'Reflexes & athleticism', keys: ['reflexes', 'glove', 'blocker', 'athleticism', 'highDanger'], goalie: true },
  technique: { label: 'Positioning & technique', keys: ['gPositioning', 'reboundControl', 'lateral', 'puckHandling'], goalie: true },
};

export const INTENSITY_LABEL: Record<DevIntensity, string> = { light: 'Light', normal: 'Normal', intense: 'Intense' };

export function focusOptions(p: Pick<Player, 'pos'>): DevFocus[] {
  return (Object.keys(FOCUS) as DevFocus[]).filter((f) => f === 'balanced' || (p.pos === 'G' ? FOCUS[f].goalie : FOCUS[f].skater));
}

/** Growth weight for an attribute under the player's plan (the CA gained is unchanged; only where it lands). */
export function focusWeight(p: Player, k: AttrKey): number {
  const f = p.devPlan?.focus;
  if (!f || f === 'balanced') return 1;
  return FOCUS[f].keys.includes(k) ? 2.2 : 0.7;
}

/** Growth multiplier from intensity; intense work pays off more under a good development environment (0.85–1.02). */
export function intensityFactor(p: Player, environment: number): number {
  const i = p.devPlan?.intensity ?? 'normal';
  if (i === 'light') return 0.92;
  if (i === 'intense') return 1.04 + clamp((environment - 0.85) / 0.17, 0, 1) * 0.1;
  return 1;
}

function groupAverages(p: Player): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of focusOptions(p)) {
    if (f === 'balanced') continue;
    const keys = FOCUS[f].keys;
    out[f] = keys.reduce((s, k) => s + (p.attrs[k] ?? 0), 0) / keys.length;
  }
  return out;
}

/**
 * The coaching staff's suggestion: the area that matters most for his position
 * where he lags his own overall level.
 */
export function coachSuggestion(p: Player): DevFocus {
  const w = abilityWeights(p.pos);
  const avg = groupAverages(p);
  const overall = Object.values(avg).reduce((a, b) => a + b, 0) / Math.max(1, Object.keys(avg).length);
  let best: DevFocus = 'balanced';
  let bestScore = 2;
  for (const [f, v] of Object.entries(avg)) {
    const importance = FOCUS[f as DevFocus].keys.reduce((s, k) => s + (w[k] ?? 0), 0);
    const score = importance * (overall - v);
    if (score > bestScore) {
      bestScore = score;
      best = f as DevFocus;
    }
  }
  return best;
}

export function setDevPlan(league: League, p: Player, focus: DevFocus, intensity: DevIntensity): { ok: boolean; message: string } {
  if (p.teamId !== league.userTeamId) return { ok: false, message: 'He is not in your organisation.' };
  if (!focusOptions(p).includes(focus)) return { ok: false, message: 'That focus does not apply to his position.' };
  p.devPlan = focus === 'balanced' && intensity === 'normal' ? undefined : { focus, intensity };
  recordDevStart(league, p);
  return { ok: true, message: `${fullName(p)}: ${FOCUS[focus].label.toLowerCase()} focus, ${INTENSITY_LABEL[intensity].toLowerCase()} intensity.` };
}

export function recordDevStart(league: League, p: Player): void {
  if (p.devStart?.season === league.season) return;
  p.devStart = { season: league.season, ca: p.ca, groups: groupAverages(p) };
}

/** Progress this season by area (attribute-group average change). */
export function devProgress(league: League, p: Player): { ca: number; groups: Record<string, number> } | null {
  if (!p.devStart || p.devStart.season !== league.season) return null;
  const now = groupAverages(p);
  const groups: Record<string, number> = {};
  for (const [k, v] of Object.entries(now)) groups[k] = v - (p.devStart.groups[k] ?? v);
  return { ca: p.ca - p.devStart.ca, groups };
}

/** Weekly: snapshot new arrivals; intense plans tire players and test some personalities. */
export function devPlansWeekly(league: League): void {
  for (const p of Object.values(league.players)) {
    if (p.teamId !== league.userTeamId || (p.status !== 'active' && p.status !== 'prospect')) continue;
    recordDevStart(league, p);
    if (p.devPlan?.intensity === 'intense') {
      p.fatigue = clamp(p.fatigue + 1.5, 0, 100);
      if (p.personality === 'easygoing' || p.personality === 'difficult') p.morale = clamp(p.morale - 1.2, 0, 100);
      if (p.personality === 'driven' || p.personality === 'professional') p.morale = clamp(p.morale + 0.4, 0, 100);
    } else if (p.devPlan?.intensity === 'light') {
      p.fatigue = clamp(p.fatigue - 1, 0, 100);
    }
  }
}
