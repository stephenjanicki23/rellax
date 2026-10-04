/**
 * League-average shot model.
 *
 * `baseGoalProbability` is the probability that a shot ON GOAL from a given
 * location/type/context beats an average goaltender when taken by an average
 * shooter. It is the "expected goals" value for a shot on goal. Shooter and
 * goalie ability are applied on top of it by the engine (which is what makes
 * Goals Saved Above Expected meaningful).
 *
 * xG for an unblocked attempt = P(on net | avg shooter) × baseGoalProbability.
 */
import { clamp } from '../core/math';

export type ShotType = 'wrist' | 'snap' | 'slap' | 'backhand' | 'oneTimer' | 'tip' | 'wraparound' | 'rebound';

const TYPE_MULT: Record<ShotType, number> = {
  wrist: 1,
  snap: 1.06,
  slap: 0.92,
  backhand: 0.85,
  oneTimer: 1.45,
  tip: 1.2,
  wraparound: 0.55,
  rebound: 1.9,
};

const MISS_ADJ: Record<ShotType, number> = {
  wrist: 0,
  snap: 0.02,
  slap: 0.06,
  backhand: 0.05,
  oneTimer: 0.06,
  tip: 0.12,
  wraparound: 0.08,
  rebound: 0.04,
};

export interface ShotContext {
  dist: number;
  angle: number;
  type: ShotType;
  rush?: boolean;
  oddMan?: boolean;
  screened?: boolean;
  turnover?: boolean;
  empty?: boolean;
}

export function baseGoalProbability(c: ShotContext): number {
  if (c.empty) return 0.92;
  let p = 0.29 * Math.exp(-c.dist / 14) + 0.026;
  p *= 1 - 0.45 * Math.pow(Math.min(c.angle, 85) / 85, 1.5);
  p *= TYPE_MULT[c.type];
  if (c.rush) p *= 1.12;
  if (c.oddMan) p *= 1.4;
  // Long shots mostly score through traffic: a screen matters more the farther out the shot.
  if (c.screened) p *= c.dist > 30 ? 1.55 : 1.25;
  if (c.turnover) p *= 1.1;
  return clamp(p, 0.008, 0.62);
}

export function baseMissProbability(type: ShotType, dist: number): number {
  return clamp(0.23 + dist * 0.0018 + MISS_ADJ[type], 0.12, 0.55);
}

/** Danger tier label for a shot distance (used in UI/analytics). */
export function dangerOf(dist: number): 'high' | 'medium' | 'low' {
  return dist < 20 ? 'high' : dist < 36 ? 'medium' : 'low';
}
