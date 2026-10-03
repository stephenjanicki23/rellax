import type { AttrKey, Attributes, Player, Position } from '../types';
import { ALL_ATTR_KEYS, GOALIE_ATTRS } from '../types';
import { clamp } from '../core/math';

type Weights = Partial<Record<AttrKey, number>>;

const FORWARD_WEIGHTS: Weights = {
  speed: 1.2, acceleration: 1.1, agility: 1.0, balance: 0.8, edgework: 0.8,
  wristPower: 0.9, wristAccuracy: 1.1, slapPower: 0.4, slapAccuracy: 0.4, oneTimer: 0.7, backhand: 0.5, shotSelection: 0.8,
  stickhandling: 1.1, passing: 1.1, puckControl: 1.0, receiving: 0.7, creativity: 0.9,
  offAwareness: 1.2, defAwareness: 0.8, positioning: 0.9, anticipation: 0.9, decisionMaking: 1.0, hockeySense: 1.0,
  strength: 0.8, bodyChecking: 0.5, aggression: 0.15, endurance: 0.7,
  stickChecking: 0.7, shotBlocking: 0.4, defPositioning: 0.7, faceoffs: 0.25, backchecking: 0.7,
  composure: 0.6, discipline: 0.3, determination: 0.4, leadership: 0.15, consistency: 0.5, clutch: 0.25,
};

const CENTER_WEIGHTS: Weights = { ...FORWARD_WEIGHTS, faceoffs: 0.9 };

const DEFENSE_WEIGHTS: Weights = {
  speed: 0.9, acceleration: 0.8, agility: 0.9, balance: 0.9, edgework: 1.0,
  wristPower: 0.4, wristAccuracy: 0.5, slapPower: 0.8, slapAccuracy: 0.8, oneTimer: 0.5, backhand: 0.2, shotSelection: 0.5,
  stickhandling: 0.7, passing: 1.2, puckControl: 0.9, receiving: 0.7, creativity: 0.6,
  offAwareness: 0.7, defAwareness: 1.3, positioning: 1.3, anticipation: 1.0, decisionMaking: 1.1, hockeySense: 1.0,
  strength: 1.0, bodyChecking: 0.7, aggression: 0.2, endurance: 0.8,
  stickChecking: 1.1, shotBlocking: 1.0, defPositioning: 1.3, faceoffs: 0, backchecking: 0.5,
  composure: 0.7, discipline: 0.4, determination: 0.4, leadership: 0.15, consistency: 0.5, clutch: 0.2,
};

const GOALIE_WEIGHTS: Weights = {
  reflexes: 1.4, gPositioning: 1.4, reboundControl: 1.0, glove: 1.0, blocker: 0.9, athleticism: 1.0, puckHandling: 0.3,
  highDanger: 1.2, lateral: 1.1, composure: 0.8, consistency: 0.8, determination: 0.2, leadership: 0.1, clutch: 0.2,
};

export function abilityWeights(pos: Position): Weights {
  switch (pos) {
    case 'C':
      return CENTER_WEIGHTS;
    case 'LW':
    case 'RW':
      return FORWARD_WEIGHTS;
    case 'D':
      return DEFENSE_WEIGHTS;
    case 'G':
      return GOALIE_WEIGHTS;
  }
}

/** Current ability: weighted mean of attributes relevant to the position. */
export function computeCA(attrs: Attributes, pos: Position): number {
  const w = abilityWeights(pos);
  let s = 0;
  let tw = 0;
  for (const k in w) {
    const wk = w[k as AttrKey]!;
    s += attrs[k as AttrKey] * wk;
    tw += wk;
  }
  return Math.round(clamp(s / tw, 1, 200));
}

export function emptyAttributes(v = 0): Attributes {
  const a = {} as Attributes;
  for (const k of ALL_ATTR_KEYS) a[k] = v;
  return a;
}

export function isGoalieAttr(k: AttrKey): boolean {
  return (GOALIE_ATTRS as readonly string[]).includes(k);
}

export function ageOf(p: Pick<Player, 'birthYear'>, season: number): number {
  return season - p.birthYear;
}

/** 0-200 → FM style 1-20 display. */
export function attr20(v: number): number {
  return clamp(Math.round(v / 10), 1, 20);
}

/** Star rating 0.5 - 5 for an ability value. */
export function stars(ability: number): number {
  return clamp(Math.round(((ability - 60) / 120) * 10) / 2, 0.5, 5);
}

export function fullName(p: Pick<Player, 'first' | 'last'>): string {
  return `${p.first} ${p.last}`;
}

export function isForward(pos: Position): boolean {
  return pos === 'C' || pos === 'LW' || pos === 'RW';
}

/** Rough role description for a given CA (used in scouting copy and UI). */
export function roleForAbility(pos: Position, ca: number): string {
  if (pos === 'G') {
    if (ca >= 165) return 'elite starting goaltender';
    if (ca >= 150) return 'starting goaltender';
    if (ca >= 138) return '1B / tandem goaltender';
    if (ca >= 125) return 'backup goaltender';
    return 'minor-league goaltender';
  }
  const d = pos === 'D';
  if (ca >= 170) return d ? 'franchise defenseman' : 'franchise forward';
  if (ca >= 155) return d ? 'top-pairing defenseman' : 'first-line forward';
  if (ca >= 142) return d ? 'top-four defenseman' : 'top-six forward';
  if (ca >= 128) return d ? 'third-pairing defenseman' : 'middle-six forward';
  if (ca >= 116) return d ? 'depth defenseman' : 'bottom-six forward';
  return 'minor-league player';
}
