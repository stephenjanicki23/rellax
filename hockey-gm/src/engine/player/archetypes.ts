import type { ArchetypeId, AttrKey, Position } from '../types';

/**
 * Archetypes give players an identity beyond their raw numbers:
 *  - `gen` shapes the attribute profile when a player is generated
 *  - `boost` changes how strongly a rating translates into on-ice performance
 *    (a Sniper gets more out of every point of shooting than a Grinder does)
 *  - `style` drives behaviour in the simulation (who shoots, who goes to the net,
 *    who carries the puck, who throws hits)
 */
export interface ArchetypeStyle {
  shoot: number;
  pass: number;
  carry: number;
  netFront: number;
  hit: number;
  /** Preference for the point/perimeter as a shooting location. */
  point: number;
}

export type Composite =
  | 'skate'
  | 'hands'
  | 'pass'
  | 'shot'
  | 'slap'
  | 'offIQ'
  | 'defIQ'
  | 'stickD'
  | 'block'
  | 'phys'
  | 'faceoff';

export interface ArchetypeDef {
  id: ArchetypeId;
  label: string;
  short: string;
  positions: Position[];
  gen: Partial<Record<AttrKey, number>>;
  boost: Partial<Record<Composite, number>>;
  style: ArchetypeStyle;
  description: string;
}

const S = (shoot: number, pass: number, carry: number, netFront: number, hit: number, point: number): ArchetypeStyle => ({
  shoot,
  pass,
  carry,
  netFront,
  hit,
  point,
});

export const ARCHETYPES: Record<ArchetypeId, ArchetypeDef> = {
  sniper: {
    id: 'sniper',
    label: 'Sniper',
    short: 'SNP',
    positions: ['LW', 'RW', 'C'],
    gen: {
      wristAccuracy: 26, wristPower: 22, oneTimer: 22, shotSelection: 16, slapPower: 8, slapAccuracy: 8, offAwareness: 14,
      anticipation: 8, backhand: 8, defAwareness: -16, defPositioning: -16, backchecking: -14, stickChecking: -10,
      shotBlocking: -22, bodyChecking: -18, strength: -6, faceoffs: -10,
    },
    boost: { shot: 0.14, slap: 0.06, offIQ: 0.05 },
    style: S(1.55, 0.8, 1.05, 0.95, 0.55, 0.9),
    description: 'Elite finisher. Converts chances at a high rate; limited defensive value.',
  },
  playmaker: {
    id: 'playmaker',
    label: 'Playmaker',
    short: 'PLY',
    positions: ['C', 'LW', 'RW'],
    gen: {
      passing: 26, creativity: 24, puckControl: 18, stickhandling: 16, hockeySense: 16, offAwareness: 14, decisionMaking: 10,
      receiving: 8, agility: 6, wristPower: -8, slapPower: -10, bodyChecking: -18, strength: -8, shotBlocking: -18,
      defPositioning: -10, aggression: -10,
    },
    boost: { pass: 0.14, hands: 0.06, offIQ: 0.06 },
    style: S(0.72, 1.55, 1.2, 0.7, 0.5, 0.9),
    description: 'Creates offence for linemates through vision and passing.',
  },
  powerForward: {
    id: 'powerForward',
    label: 'Power Forward',
    short: 'PWF',
    positions: ['LW', 'RW', 'C'],
    gen: {
      strength: 26, bodyChecking: 22, balance: 16, wristPower: 14, aggression: 12, puckControl: 8, endurance: 6,
      offAwareness: 6, agility: -10, creativity: -10, edgework: -6, discipline: -8, passing: -6,
    },
    boost: { phys: 0.12, shot: 0.05, hands: 0.03 },
    style: S(1.2, 0.85, 1.0, 1.6, 1.35, 0.6),
    description: 'Wins battles, drives the net and scores from close range.',
  },
  twoWayForward: {
    id: 'twoWayForward',
    label: 'Two-Way Forward',
    short: 'TWF',
    positions: ['C', 'LW', 'RW'],
    gen: {
      defAwareness: 14, backchecking: 14, positioning: 12, hockeySense: 12, stickChecking: 10, decisionMaking: 10,
      offAwareness: 6, faceoffs: 6, endurance: 8, determination: 8, creativity: -8, slapPower: -6,
    },
    boost: { offIQ: 0.05, defIQ: 0.08, stickD: 0.05 },
    style: S(1.0, 1.0, 1.0, 1.0, 0.9, 0.85),
    description: 'Reliable at both ends; trusted in every situation.',
  },
  grinder: {
    id: 'grinder',
    label: 'Grinder',
    short: 'GRN',
    positions: ['C', 'LW', 'RW'],
    gen: {
      endurance: 20, bodyChecking: 18, backchecking: 16, determination: 18, strength: 12, shotBlocking: 12, aggression: 10,
      stickChecking: 6, creativity: -20, stickhandling: -14, wristAccuracy: -12, oneTimer: -14, passing: -8,
    },
    boost: { phys: 0.08, defIQ: 0.04, block: 0.05 },
    style: S(0.85, 0.75, 0.7, 1.2, 1.5, 0.7),
    description: 'Hard-working depth forward who forechecks relentlessly.',
  },
  enforcer: {
    id: 'enforcer',
    label: 'Enforcer',
    short: 'ENF',
    positions: ['LW', 'RW', 'C', 'D'],
    gen: {
      strength: 34, aggression: 34, bodyChecking: 26, balance: 12, discipline: -24, speed: -16, acceleration: -12,
      agility: -18, creativity: -24, stickhandling: -20, passing: -14, wristAccuracy: -16, hockeySense: -10,
    },
    boost: { phys: 0.14 },
    style: S(0.5, 0.6, 0.45, 1.1, 1.9, 0.6),
    description: 'Physical intimidator. Protects teammates; limited hockey skill.',
  },
  defensiveForward: {
    id: 'defensiveForward',
    label: 'Defensive Forward',
    short: 'DFF',
    positions: ['C', 'LW', 'RW'],
    gen: {
      defAwareness: 22, defPositioning: 20, stickChecking: 20, backchecking: 20, faceoffs: 14, shotBlocking: 14,
      anticipation: 10, discipline: 10, creativity: -16, wristPower: -12, oneTimer: -14, offAwareness: -10,
    },
    boost: { defIQ: 0.12, stickD: 0.09, faceoff: 0.06, block: 0.05 },
    style: S(0.75, 0.85, 0.75, 0.9, 1.0, 0.7),
    description: 'Shutdown specialist and penalty killer.',
  },
  offensiveDefenseman: {
    id: 'offensiveDefenseman',
    label: 'Offensive Defenseman',
    short: 'OFD',
    positions: ['D'],
    gen: {
      slapPower: 22, slapAccuracy: 22, oneTimer: 16, passing: 18, offAwareness: 20, creativity: 14, puckControl: 10,
      wristAccuracy: 10, defPositioning: -14, defAwareness: -10, shotBlocking: -12, bodyChecking: -8, strength: -6,
    },
    boost: { slap: 0.12, pass: 0.08, offIQ: 0.08 },
    style: S(1.0, 1.25, 1.15, 0.35, 0.6, 1.4),
    description: 'Quarterbacks the attack and the power play from the blue line.',
  },
  twoWayDefenseman: {
    id: 'twoWayDefenseman',
    label: 'Two-Way Defenseman',
    short: 'TWD',
    positions: ['D'],
    gen: {
      defAwareness: 12, defPositioning: 12, passing: 12, hockeySense: 12, decisionMaking: 10, offAwareness: 8,
      stickChecking: 8, slapAccuracy: 6, endurance: 8,
    },
    boost: { defIQ: 0.06, pass: 0.06, offIQ: 0.03 },
    style: S(0.7, 1.05, 1.0, 0.3, 0.9, 1.2),
    description: 'Balanced blueliner who plays big minutes in all situations.',
  },
  stayAtHome: {
    id: 'stayAtHome',
    label: 'Stay-at-Home Defenseman',
    short: 'SAH',
    positions: ['D'],
    gen: {
      defPositioning: 24, shotBlocking: 26, defAwareness: 20, stickChecking: 14, strength: 12, positioning: 12,
      discipline: 8, creativity: -20, offAwareness: -18, stickhandling: -14, oneTimer: -14, slapAccuracy: -6,
    },
    boost: { defIQ: 0.12, block: 0.12, stickD: 0.05 },
    style: S(0.4, 0.75, 0.6, 0.25, 1.1, 1.1),
    description: 'Defence first. Blocks shots and clears the crease.',
  },
  puckMovingDefenseman: {
    id: 'puckMovingDefenseman',
    label: 'Puck-Moving Defenseman',
    short: 'PMD',
    positions: ['D'],
    gen: {
      passing: 22, edgework: 18, agility: 16, speed: 12, puckControl: 16, decisionMaking: 14, stickhandling: 12,
      composure: 10, strength: -14, bodyChecking: -16, shotBlocking: -6, slapPower: -6,
    },
    boost: { pass: 0.12, skate: 0.06, hands: 0.05 },
    style: S(0.6, 1.4, 1.35, 0.25, 0.55, 1.2),
    description: 'Moves the puck up ice quickly and drives transition.',
  },
  physicalDefenseman: {
    id: 'physicalDefenseman',
    label: 'Physical Defenseman',
    short: 'PHD',
    positions: ['D'],
    gen: {
      strength: 26, bodyChecking: 28, aggression: 18, balance: 12, shotBlocking: 10, defPositioning: 6, discipline: -12,
      creativity: -16, agility: -10, passing: -8, offAwareness: -10,
    },
    boost: { phys: 0.14, defIQ: 0.03 },
    style: S(0.5, 0.7, 0.6, 0.3, 1.8, 1.1),
    description: 'Punishes forwards along the boards and in front of the net.',
  },
  butterflyGoalie: {
    id: 'butterflyGoalie',
    label: 'Goaltender (Butterfly)',
    short: 'G-BF',
    positions: ['G'],
    gen: { gPositioning: 18, reboundControl: 14, highDanger: 8, consistency: 8, athleticism: -10, puckHandling: -8 },
    boost: {},
    style: S(0, 0, 0, 0, 0, 0),
    description: 'Technically sound and positionally consistent.',
  },
  hybridGoalie: {
    id: 'hybridGoalie',
    label: 'Goaltender (Hybrid)',
    short: 'G-HY',
    positions: ['G'],
    gen: { gPositioning: 8, reflexes: 8, lateral: 8, puckHandling: 6 },
    boost: {},
    style: S(0, 0, 0, 0, 0, 0),
    description: 'Blends positional play with reactive athleticism.',
  },
  athleticGoalie: {
    id: 'athleticGoalie',
    label: 'Goaltender (Athletic)',
    short: 'G-AT',
    positions: ['G'],
    gen: { reflexes: 18, athleticism: 20, lateral: 14, highDanger: 10, gPositioning: -12, reboundControl: -10, consistency: -10 },
    boost: {},
    style: S(0, 0, 0, 0, 0, 0),
    description: 'Spectacular reflexes; more prone to streaks.',
  },
};

export const FORWARD_ARCHETYPES: ArchetypeId[] = [
  'sniper',
  'playmaker',
  'powerForward',
  'twoWayForward',
  'grinder',
  'enforcer',
  'defensiveForward',
];
export const DEFENSE_ARCHETYPES: ArchetypeId[] = [
  'offensiveDefenseman',
  'twoWayDefenseman',
  'stayAtHome',
  'puckMovingDefenseman',
  'physicalDefenseman',
];
export const GOALIE_ARCHETYPES: ArchetypeId[] = ['butterflyGoalie', 'hybridGoalie', 'athleticGoalie'];

/** Relative frequency of archetypes, optionally by talent tier (0 = depth .. 1 = elite). */
export function archetypeWeights(pos: Position, tier: number): [ArchetypeId, number][] {
  if (pos === 'G') return [['butterflyGoalie', 4], ['hybridGoalie', 4], ['athleticGoalie', 2]];
  if (pos === 'D') {
    return [
      ['offensiveDefenseman', 1 + 2 * tier],
      ['twoWayDefenseman', 2.5],
      ['stayAtHome', 3 - 1.5 * tier],
      ['puckMovingDefenseman', 1.5 + tier],
      ['physicalDefenseman', 2 - tier],
    ];
  }
  return [
    ['sniper', 1 + 2.5 * tier],
    ['playmaker', 1 + 2.5 * tier],
    ['powerForward', 1.5 + 0.5 * tier],
    ['twoWayForward', 2.5],
    ['grinder', 3 - 2.5 * tier],
    ['enforcer', Math.max(0.05, 0.7 - 0.8 * tier)],
    ['defensiveForward', 2.2 - 1.5 * tier],
  ];
}
