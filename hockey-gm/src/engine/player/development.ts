/**
 * Player development and aging.
 *
 * Potential is a ceiling, not a promise. How much of the gap between current
 * and potential ability a player closes each year depends on age, development
 * curve, ice time, coaching, facilities, determination, personality, injuries
 * and luck. Aging is attribute-specific and gradual: skating and endurance
 * fade first, hockey sense keeps improving into the early thirties.
 */
import { Rng, seedFrom } from '../core/rng';
import { clamp } from '../core/math';
import type { AttrKey, DevCurve, Player } from '../types';
import { MENTAL_ATTRS, PHYSICAL_ATTRS, SKATING_ATTRS, IQ_ATTRS } from '../types';
import { abilityWeights, computeCA } from './ability';
import { ARCHETYPES } from './archetypes';
import { PERSONALITIES } from './personality';
import { focusWeight, intensityFactor } from './devPlan';

/** Fraction of the remaining gap closed per year at a given (curve-adjusted) age. */
function ageGrowth(age: number): number {
  const table: Record<number, number> = {
    16: 0.3, 17: 0.31, 18: 0.32, 19: 0.32, 20: 0.3, 21: 0.27, 22: 0.24, 23: 0.2, 24: 0.16, 25: 0.12, 26: 0.08, 27: 0.05, 28: 0.03,
  };
  if (age < 16) return 0.3;
  return table[Math.round(age)] ?? 0.01;
}

function curveAge(age: number, curve: DevCurve): number {
  switch (curve) {
    case 'early':
      return age + 2.2;
    case 'late':
      return age < 22 ? age + 4 : age - 2.5;
    default:
      return age;
  }
}

export interface DevContext {
  season: number;
  /** Ice-time factor 0..1 (share of expected minutes actually played). */
  iceTime: number;
  /** Team development environment 0.8..1.2 (coaching + facilities). */
  environment: number;
  /** Fraction of a season this tick represents (1 = full offseason step). */
  fraction: number;
  /** Days lost to injury this season. */
  injuryDays: number;
  /** Is the player in the minors/juniors (prospect)? */
  minors: boolean;
  /** Development factor from his role with the AHL affiliate (when he plays there). */
  minorIce?: number;
  leagueSeed: string;
}

/** Deterministic per-player-per-season development luck (log-normal multiplier). */
export function devLuck(seed: string, season: number, playerId: number): number {
  const r = new Rng(seedFrom(seed, 'dev', season, playerId));
  return Math.exp(r.normal(0, 0.38));
}

const IQ = new Set<AttrKey>(IQ_ATTRS);
const PHYS = new Set<AttrKey>([...PHYSICAL_ATTRS, ...SKATING_ATTRS]);
const MENTAL = new Set<AttrKey>(MENTAL_ATTRS);

function growthProfile(age: number, k: AttrKey): number {
  if (IQ.has(k)) return age < 22 ? 0.8 : age < 27 ? 1.15 : 1.5;
  if (PHYS.has(k)) return age < 22 ? 1.4 : age < 27 ? 1 : 0.35;
  return age < 22 ? 1 : age < 27 ? 1.1 : 0.8;
}

/** Distribute a change in CA across attributes following the growth profile. */
export function applyAbilityChange(p: Player, deltaCA: number, rng: Rng, age: number): void {
  if (Math.abs(deltaCA) < 0.01) return;
  const w = abilityWeights(p.pos);
  const gen = ARCHETYPES[p.archetype].gen;
  const keys = (Object.keys(w) as AttrKey[]).filter((k) => !MENTAL.has(k));
  let sw = 0;
  for (const k of Object.keys(w) as AttrKey[]) sw += w[k]!;
  const u: Partial<Record<AttrKey, number>> = {};
  let su = 0;
  for (const k of keys) {
    const head = deltaCA > 0 ? Math.max(0.05, (200 - p.attrs[k]) / 100) : 1;
    const emph = 1 + ((gen[k] ?? 0) > 0 ? 0.35 : 0);
    const v = growthProfile(age, k) * emph * head * focusWeight(p, k) * Math.exp(rng.normal(0, 0.35));
    u[k] = v;
    su += w[k]! * v;
  }
  if (su <= 0) return;
  const s = (deltaCA * sw) / su;
  for (const k of keys) {
    p.attrs[k] = clamp(Math.round((p.attrs[k] + s * u[k]!) * 10) / 10, 1, 200);
  }
}

/**
 * Growth for one tick. Returns the CA change applied.
 */
export function developPlayer(p: Player, ctx: DevContext): number {
  const age = ctx.season - p.birthYear;
  const rng = new Rng(seedFrom(ctx.leagueSeed, 'devtick', ctx.season, p.id, Math.round(ctx.fraction * 1000), p.ca));
  const before = p.ca;
  const gap = Math.max(0, p.pa - p.ca);
  // Goaltenders mature later than skaters.
  let rate = ageGrowth(curveAge(p.pos === 'G' ? age - 2 : age, p.devCurve));
  const pers = PERSONALITIES[p.personality];
  const det = 0.88 + 0.24 * clamp((p.attrs.determination - 60) / 140, 0, 1);
  let ice = ctx.minors ? (ctx.minorIce ?? 0.92) : 0.7 + 0.4 * clamp(ctx.iceTime, 0, 1);
  if (p.devCurve === 'opportunity') ice = ctx.minors ? 0.75 : 0.45 + 0.95 * clamp(ctx.iceTime, 0, 1);
  if (p.devCurve === 'plateau' && age >= 22) rate *= 0.45;
  const inj = ctx.injuryDays > 120 ? 0.65 : ctx.injuryDays > 45 ? 0.82 : ctx.injuryDays > 20 ? 0.93 : 1;
  const luck = devLuck(ctx.leagueSeed, ctx.season, p.id);
  let growth = gap * rate * pers.dev * det * ice * ctx.environment * inj * luck * ctx.fraction * intensityFactor(p, ctx.environment);
  // Rare breakout seasons for young players.
  if (ctx.fraction >= 0.5 && age <= 25 && gap > 15 && rng.chance(0.045)) growth += gap * 0.18;
  growth = Math.min(growth, gap);
  if (growth > 0.05) applyAbilityChange(p, growth, rng, age);
  // Busts: some players' ceilings collapse as they fail to progress.
  if (p.devCurve === 'bust' && ctx.fraction >= 0.5 && age >= 19 && age <= 24 && rng.chance(0.35)) {
    p.pa = Math.round(Math.max(p.ca, p.pa - (p.pa - p.ca) * rng.float(0.3, 0.6)));
  }
  // Long injuries can permanently dent the ceiling.
  if (ctx.injuryDays > 150 && rng.chance(0.3)) p.pa = Math.max(p.ca, p.pa - rng.int(2, 8));
  p.ca = computeCA(p.attrs, p.pos);
  p.pa = Math.max(p.pa, p.ca);
  return p.ca - before;
}

/**
 * Yearly aging (applied once per offseason). Attribute-specific and gradual.
 */
export function agePlayer(p: Player, season: number, leagueSeed: string): number {
  const age = season - p.birthYear;
  const rng = new Rng(seedFrom(leagueSeed, 'age', season, p.id));
  const before = p.ca;
  const pers = PERSONALITIES[p.personality];
  // Professional/determined players look after their bodies.
  const care = (pers.id === 'professional' || pers.id === 'driven' ? 0.85 : 1) * (1.1 - clamp((p.attrs.determination - 60) / 140, 0, 1) * 0.2);
  const d = (k: AttrKey, amt: number) => {
    if (amt === 0) return;
    p.attrs[k] = clamp(Math.round((p.attrs[k] + amt * (amt < 0 ? care : 1) * Math.exp(rng.normal(0, 0.3))) * 10) / 10, 1, 200);
  };
  const isG = p.pos === 'G';
  if (!isG) {
    if (age >= 28) {
      d('speed', -(age - 27) * 1.6);
      d('acceleration', -(age - 27) * 1.6);
    }
    if (age >= 29) {
      d('agility', -(age - 28) * 1.3);
      d('endurance', -(age - 28) * 1.3);
      d('balance', -(age - 28) * 0.8);
      d('edgework', -(age - 28) * 0.8);
    }
    if (age >= 31) {
      d('strength', -(age - 30) * 0.8);
      for (const k of ['wristPower', 'slapPower', 'oneTimer', 'stickhandling', 'puckControl', 'bodyChecking', 'wristAccuracy', 'receiving'] as AttrKey[]) d(k, -(age - 30) * 0.6);
    }
    // Hockey sense: improves late, holds, then slowly declines.
    for (const k of IQ_ATTRS) {
      if (age >= 25 && age <= 30) d(k, rng.float(0, 1.2));
      else if (age >= 33) d(k, -(age - 32) * 0.6);
    }
    for (const k of ['shotSelection', 'defPositioning', 'faceoffs', 'passing'] as AttrKey[]) {
      if (age >= 25 && age <= 30) d(k, rng.float(0, 0.8));
      else if (age >= 33) d(k, -(age - 32) * 0.45);
    }
  } else {
    if (age >= 32) {
      d('reflexes', -(age - 31) * 1.4);
      d('athleticism', -(age - 31) * 1.4);
      d('lateral', -(age - 31) * 1.2);
      d('endurance', -(age - 31) * 0.9);
      d('glove', -(age - 31) * 0.6);
      d('blocker', -(age - 31) * 0.6);
    }
    for (const k of ['gPositioning', 'reboundControl', 'highDanger'] as AttrKey[]) {
      if (age >= 25 && age <= 31) d(k, rng.float(0, 1.2));
      else if (age >= 34) d(k, -(age - 33) * 0.6);
    }
  }
  // Careers don't follow the average curve: some players find another gear in
  // their mid-twenties, and veterans can fall off a cliff in a single summer.
  const peakAge = isG ? age - 2 : age;
  if (peakAge >= 23 && peakAge <= 28 && rng.chance(0.06)) {
    const boost = rng.float(3, 8);
    p.pa = Math.max(p.pa, p.ca + boost + rng.float(0, 4));
    applyAbilityChange(p, boost, rng, age);
  }
  if (peakAge >= 30 && rng.chance(Math.min(0.35, (peakAge - 29) * 0.035))) {
    // The legs go first: a sudden drop in skating and physical tools, hockey sense intact.
    const hit = rng.float(7, 14);
    const legs: AttrKey[] = isG ? ['reflexes', 'athleticism', 'lateral', 'endurance'] : ['speed', 'acceleration', 'agility', 'endurance', 'balance', 'strength'];
    for (const k of legs) d(k, -hit);
  }
  // Mental maturation.
  if (age >= 24) d('leadership', rng.float(0, 1.5));
  if (age <= 30) d('composure', rng.float(0, 1.2));
  if (age <= 26) d('discipline', rng.float(-0.5, 1));
  p.ca = computeCA(p.attrs, p.pos);
  p.pa = Math.max(p.pa, p.ca);
  return p.ca - before;
}

/** Probability that a player retires this offseason. */
export function retirementChance(p: Player, season: number): number {
  const age = season - p.birthYear;
  const pers = PERSONALITIES[p.personality];
  const adjAge = age - pers.retirement * 0.6;
  let pr = 0;
  if (adjAge >= 33) pr = 0.06 + (adjAge - 33) * 0.1;
  if (p.ca < 118 && age >= 31) pr += 0.15 + (age - 31) * 0.05;
  if (p.ca < 105 && age >= 27) pr += 0.15;
  if (p.status === 'fa' && age >= 30) pr += 0.25;
  if (p.ca > 160) pr -= 0.12;
  const recentSevere = p.injuryHistory.filter((h) => h.season >= season - 1 && h.days > 120).length;
  pr += recentSevere * 0.1;
  if (age >= 41) pr = 1;
  if (age <= 30 && p.ca >= 105) pr = recentSevere ? 0.02 : 0.002;
  return clamp(pr, 0, 1);
}
