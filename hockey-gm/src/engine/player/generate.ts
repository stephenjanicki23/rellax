import type { Rng } from '../core/rng';
import { clamp } from '../core/math';
import type { ArchetypeId, Attributes, AttrKey, DevCurve, PersonalityId, Player, Position, TraitId } from '../types';
import { MENTAL_ATTRS, GOALIE_ATTRS, SKATER_ATTR_KEYS } from '../types';
import { ARCHETYPES, archetypeWeights } from './archetypes';
import { abilityWeights, computeCA, emptyAttributes } from './ability';
import { PERSONALITIES } from './personality';
import { NAME_POOLS } from '../data/names';

export interface GenerateOptions {
  id: number;
  pos: Position;
  targetCA: number;
  age: number;
  season: number;
  pa?: number;
  archetype?: ArchetypeId;
  nat?: string;
  /** 0..1 – how elite the player is relative to the league (affects archetype mix). */
  tier?: number;
}

export function pickNationality(rng: Rng): (typeof NAME_POOLS)[number] {
  return rng.weighted(NAME_POOLS, (p) => p.weight);
}

export function pickArchetype(rng: Rng, pos: Position, tier: number): ArchetypeId {
  const w = archetypeWeights(pos, clamp(tier, 0, 1));
  const valid = w.filter(([a]) => ARCHETYPES[a].positions.includes(pos));
  return valid[rng.weightedIndex(valid.map(([, x]) => x))][0];
}

export function pickPersonality(rng: Rng): PersonalityId {
  const list = Object.values(PERSONALITIES);
  return rng.weighted(list, (p) => p.weight).id;
}

export function pickDevCurve(rng: Rng): DevCurve {
  const opts: [DevCurve, number][] = [
    ['normal', 50],
    ['early', 12],
    ['late', 12],
    ['plateau', 10],
    ['bust', 7],
    ['opportunity', 9],
  ];
  return opts[rng.weightedIndex(opts.map((o) => o[1]))][0];
}

/** Potential for an existing (non-draft) player of a given age and ability. */
export function rollPotential(rng: Rng, ca: number, age: number): number {
  if (age >= 28) return Math.round(clamp(ca + Math.max(0, rng.normal(1, 2)), ca, 200));
  const gapMean = Math.max(0, 26 - age) * 3.4;
  const gap = Math.max(0, rng.normal(gapMean, gapMean * 0.6 + 2));
  return Math.round(clamp(ca + gap, ca, 198));
}

const SKILL_KEYS_BY_POS: Record<Position, AttrKey[]> = {
  C: [...SKATER_ATTR_KEYS],
  LW: [...SKATER_ATTR_KEYS],
  RW: [...SKATER_ATTR_KEYS],
  D: [...SKATER_ATTR_KEYS],
  G: [...GOALIE_ATTRS],
};

/**
 * Build an attribute set that hits the target CA while expressing the archetype.
 */
export function generateAttributes(
  rng: Rng,
  pos: Position,
  archetype: ArchetypeId,
  targetCA: number,
  personality: PersonalityId,
): Attributes {
  const attrs = emptyAttributes(0);
  const def = ARCHETYPES[archetype];
  const skillKeys = SKILL_KEYS_BY_POS[pos];
  // Individual "fingerprint" offsets make two players of the same archetype differ.
  for (const k of skillKeys) {
    const offset = def.gen[k] ?? 0;
    attrs[k] = targetCA + offset + rng.normal(0, 11);
  }
  if (pos === 'D') attrs.faceoffs = 40 + rng.normal(0, 12);
  if (pos === 'LW' || pos === 'RW') attrs.faceoffs -= 22;
  if (pos === 'G') {
    for (const k of SKATER_ATTR_KEYS) attrs[k] = clamp(55 + rng.normal(0, 12), 20, 100);
    attrs.endurance = clamp(targetCA + rng.normal(0, 14), 40, 200);
  } else {
    for (const k of GOALIE_ATTRS) attrs[k] = 1;
  }
  // Mental attributes are mostly independent of ability, shaped by personality.
  const p = PERSONALITIES[personality];
  for (const k of MENTAL_ATTRS) {
    const base = 95 + (targetCA - 120) * 0.35;
    attrs[k] = base + (p.mental[k] ?? 0) + (def.gen[k] ?? 0) + rng.normal(0, 20);
  }
  for (const k of [...skillKeys, ...MENTAL_ATTRS]) attrs[k] = clamp(attrs[k], 1, 200);

  // Shift skill attributes until CA matches the target (mental stays as-is).
  for (let iter = 0; iter < 6; iter++) {
    const ca = computeCA(attrs, pos);
    const diff = targetCA - ca;
    if (Math.abs(diff) < 0.5) break;
    const w = abilityWeights(pos);
    for (const k of skillKeys) if ((w[k] ?? 0) > 0) attrs[k] = clamp(attrs[k] + diff * 1.08, 1, 200);
  }
  for (const k of Object.keys(attrs) as AttrKey[]) attrs[k] = Math.round(attrs[k]);
  return attrs;
}

function bodyFor(rng: Rng, pos: Position, archetype: ArchetypeId): { h: number; w: number } {
  let h = pos === 'D' ? 188 : pos === 'G' ? 189 : 184;
  if (archetype === 'enforcer' || archetype === 'powerForward' || archetype === 'physicalDefenseman') h += 4;
  if (archetype === 'playmaker' || archetype === 'sniper') h -= 2;
  h = Math.round(h + rng.normal(0, 5));
  const bmi = 25.5 + (archetype === 'enforcer' || archetype === 'physicalDefenseman' ? 1.6 : 0) + rng.normal(0, 1.1);
  const w = Math.round(bmi * (h / 100) ** 2);
  return { h, w };
}

function jerseyNumber(rng: Rng, pos: Position): number {
  if (pos === 'G') return rng.pick([1, 29, 30, 31, 33, 34, 35, 37, 39, 40, 41, 70, 72, 80]);
  return rng.int(2, 98);
}

export function generatePlayer(rng: Rng, opts: GenerateOptions): Player {
  const pool = opts.nat ? (NAME_POOLS.find((n) => n.code === opts.nat) ?? pickNationality(rng)) : pickNationality(rng);
  const tier = opts.tier ?? clamp((opts.targetCA - 110) / 70, 0, 1);
  const archetype = opts.archetype ?? pickArchetype(rng, opts.pos, tier);
  const personality = pickPersonality(rng);
  const attrs = generateAttributes(rng, opts.pos, archetype, opts.targetCA, personality);
  const ca = computeCA(attrs, opts.pos);
  const pa = Math.max(ca, opts.pa ?? rollPotential(rng, ca, opts.age));
  const devCurve = pickDevCurve(rng);
  const traits: TraitId[] = [];
  let durability = rng.normal(122, 22);
  if (rng.chance(0.08)) {
    traits.push('injuryProne');
    durability -= 38;
  } else if (rng.chance(0.09)) {
    traits.push('durable');
    durability += 26;
  }
  if (opts.pos === 'G' ? rng.chance(0.25) : rng.chance(0.1)) traits.push('streaky');
  if (devCurve === 'late' && rng.chance(0.55)) traits.push('lateBloomer');
  if (attrs.clutch > 150 && rng.chance(0.5)) traits.push('bigGame');
  const body = bodyFor(rng, opts.pos, archetype);
  const pers = PERSONALITIES[personality];
  const shoots = opts.pos === 'LW' ? (rng.chance(0.68) ? 'L' : 'R') : opts.pos === 'RW' ? (rng.chance(0.6) ? 'R' : 'L') : rng.chance(0.62) ? 'L' : 'R';
  const player: Player = {
    id: opts.id,
    first: rng.pick(pool.first),
    last: rng.pick(pool.last),
    birthYear: opts.season - opts.age,
    nat: pool.code,
    pos: opts.pos,
    shoots,
    heightCm: body.h,
    weightKg: body.w,
    number: jerseyNumber(rng, opts.pos),
    archetype,
    attrs,
    ca,
    pa,
    devCurve,
    personality,
    traits,
    durability: Math.round(clamp(durability, 30, 200)),
    morale: 65,
    form: 0,
    confidence: 0,
    fatigue: 0,
    injury: null,
    injuryHistory: [],
    teamId: null,
    status: 'fa',
    contract: null,
    rightsTeamId: null,
    draft: null,
    career: [],
    awards: [],
    reputation: Math.round(clamp((ca - 100) * 0.9, 1, 99)),
    playoffRep: 0,
    proSeasons: Math.max(0, opts.age - 20),
    junior: rng.pick(pool.juniorLeagues),
    prefs: {
      money: clamp(rng.normal(1, 0.15) * pers.money, 0.4, 1.8),
      winning: clamp(rng.normal(1, 0.15) * pers.winning, 0.4, 1.8),
      role: clamp(rng.normal(1, 0.15) * pers.role, 0.4, 1.8),
      location: clamp(rng.normal(1, 0.2), 0.3, 1.8),
      loyalty: clamp(rng.normal(1, 0.2) * pers.loyalty, 0.2, 2.5),
    },
    expectedToi: 0,
    streak: { points: 0, goalless: 0, bestPoints: 0 },
    devBank: 0,
    seasonToiMin: 0,
    caSeasonStart: ca,
  };
  player.expectedToi = expectedToiFor(player);
  return player;
}

/** Minutes per game a player of this ability expects to play. */
export function expectedToiFor(p: Pick<Player, 'pos' | 'ca'>): number {
  if (p.pos === 'G') return p.ca >= 145 ? 50 : 15;
  if (p.pos === 'D') return clamp(10 + (p.ca - 110) * 0.28, 12, 25);
  return clamp(8 + (p.ca - 110) * 0.24, 9, 21);
}
