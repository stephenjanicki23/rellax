import type { Rng } from '../core/rng';
import { clamp } from '../core/math';
import type { Injury, InjurySeverity, Player } from '../types';

export type InjuryCause = 'hit' | 'block' | 'noncontact' | 'fight' | 'practice';

interface InjuryType {
  type: string;
  bodyPart: Injury['bodyPart'];
  severity: InjurySeverity;
  days: [number, number];
  causes: InjuryCause[];
  weight: number;
}

const INJURY_TYPES: InjuryType[] = [
  // minor
  { type: 'Bruised foot', bodyPart: 'lower', severity: 'minor', days: [1, 5], causes: ['block'], weight: 6 },
  { type: 'Bruised hand', bodyPart: 'upper', severity: 'minor', days: [1, 5], causes: ['block', 'hit', 'fight'], weight: 4 },
  { type: 'Upper-body injury (day-to-day)', bodyPart: 'upper', severity: 'minor', days: [1, 6], causes: ['hit', 'fight', 'practice'], weight: 6 },
  { type: 'Lower-body injury (day-to-day)', bodyPart: 'lower', severity: 'minor', days: [1, 6], causes: ['noncontact', 'hit', 'practice'], weight: 6 },
  { type: 'Illness', bodyPart: 'other', severity: 'minor', days: [1, 4], causes: ['practice'], weight: 3 },
  { type: 'Facial laceration', bodyPart: 'head', severity: 'minor', days: [1, 3], causes: ['hit', 'fight'], weight: 2 },
  // moderate
  { type: 'Upper-body injury', bodyPart: 'upper', severity: 'moderate', days: [7, 21], causes: ['hit', 'fight', 'practice'], weight: 5 },
  { type: 'Lower-body injury', bodyPart: 'lower', severity: 'moderate', days: [7, 21], causes: ['noncontact', 'hit', 'block', 'practice'], weight: 5 },
  { type: 'Groin strain', bodyPart: 'lower', severity: 'moderate', days: [8, 24], causes: ['noncontact', 'practice'], weight: 4 },
  { type: 'Sprained ankle', bodyPart: 'lower', severity: 'moderate', days: [10, 28], causes: ['noncontact', 'hit'], weight: 3 },
  { type: 'Sprained wrist', bodyPart: 'upper', severity: 'moderate', days: [8, 20], causes: ['hit', 'block', 'fight'], weight: 2 },
  { type: 'Concussion', bodyPart: 'head', severity: 'moderate', days: [10, 28], causes: ['hit', 'fight'], weight: 2 },
  // major
  { type: 'Shoulder injury', bodyPart: 'upper', severity: 'major', days: [25, 55], causes: ['hit'], weight: 3 },
  { type: 'MCL sprain', bodyPart: 'lower', severity: 'major', days: [28, 56], causes: ['hit', 'noncontact'], weight: 3 },
  { type: 'Broken hand', bodyPart: 'upper', severity: 'major', days: [28, 49], causes: ['block', 'fight'], weight: 2 },
  { type: 'Broken foot', bodyPart: 'lower', severity: 'major', days: [30, 56], causes: ['block'], weight: 3 },
  { type: 'Concussion', bodyPart: 'head', severity: 'major', days: [30, 70], causes: ['hit'], weight: 1.5 },
  { type: 'High ankle sprain', bodyPart: 'lower', severity: 'major', days: [30, 60], causes: ['noncontact', 'hit'], weight: 2 },
  // severe
  { type: 'Torn ACL', bodyPart: 'lower', severity: 'severe', days: [180, 270], causes: ['noncontact', 'hit'], weight: 0.6 },
  { type: 'Fractured leg', bodyPart: 'lower', severity: 'severe', days: [80, 150], causes: ['block', 'hit'], weight: 0.8 },
  { type: 'Shoulder surgery', bodyPart: 'upper', severity: 'severe', days: [100, 170], causes: ['hit'], weight: 0.8 },
  { type: 'Herniated disc', bodyPart: 'other', severity: 'severe', days: [70, 140], causes: ['noncontact', 'practice'], weight: 0.6 },
];

const SEVERITY_BASE: Record<InjurySeverity, number> = { minor: 0.52, moderate: 0.3, major: 0.14, severe: 0.04 };

export interface RolledInjury {
  type: string;
  bodyPart: Injury['bodyPart'];
  severity: InjurySeverity;
  days: number;
}

/**
 * Roll an injury given its cause. `severityShift` > 0 makes serious injuries
 * more likely (re-injury, fatigue, age).
 */
export function rollInjury(rng: Rng, cause: InjuryCause, severityShift = 0): RolledInjury {
  const sevWeights: Record<InjurySeverity, number> = {
    minor: SEVERITY_BASE.minor * Math.exp(-0.6 * severityShift),
    moderate: SEVERITY_BASE.moderate,
    major: SEVERITY_BASE.major * Math.exp(0.5 * severityShift),
    severe: SEVERITY_BASE.severe * Math.exp(0.8 * severityShift),
  };
  const sevs: InjurySeverity[] = ['minor', 'moderate', 'major', 'severe'];
  let severity = sevs[rng.weightedIndex(sevs.map((s) => sevWeights[s]))];
  let candidates = INJURY_TYPES.filter((t) => t.severity === severity && t.causes.includes(cause));
  if (!candidates.length) {
    candidates = INJURY_TYPES.filter((t) => t.causes.includes(cause));
    if (!candidates.length) candidates = INJURY_TYPES;
  }
  const t = rng.weighted(candidates, (c) => c.weight);
  severity = t.severity;
  const days = rng.int(t.days[0], t.days[1]);
  return { type: t.type, bodyPart: t.bodyPart, severity, days };
}

/**
 * Multiplier on injury probability for a player. Durability matters most;
 * fatigue, age and recent injury history add risk.
 */
export function injuryRisk(p: Player, season: number): number {
  const age = season - p.birthYear;
  let r = Math.exp((120 - p.durability) / 55);
  r *= 1 + Math.max(0, p.fatigue - 30) / 120;
  if (age > 31) r *= 1 + (age - 31) * 0.04;
  const recent = p.injuryHistory.filter((h) => h.season >= season - 1 && h.days >= 10).length;
  r *= 1 + recent * 0.12;
  if (p.traits.includes('injuryProne')) r *= 1.35;
  if (p.traits.includes('durable')) r *= 0.75;
  return clamp(r, 0.3, 4);
}

/** Severity shift for re-injury risk to the same body part. */
export function severityShift(p: Player, season: number, bodyPart?: string): number {
  const recent = p.injuryHistory.filter((h) => h.season >= season - 1 && (!bodyPart || h.bodyPart === bodyPart));
  return clamp(recent.length * 0.25 + Math.max(0, p.fatigue - 50) / 100, 0, 1.2);
}

export function makeInjury(r: RolledInjury, season: number, day: number): Injury {
  return { ...r, daysRemaining: r.days, totalDays: r.days, season, dayInjured: day };
}

export function injuryLabel(i: Injury): string {
  if (i.daysRemaining <= 5) return `${i.type} — day-to-day`;
  const weeks = Math.ceil(i.daysRemaining / 7);
  return `${i.type} — ${weeks} week${weeks > 1 ? 's' : ''}`;
}
