/**
 * Tactical fit: how well players and rosters suit each system.
 *
 * Every tactical option asks for a particular mix of attributes (a rush
 * offence wants speed and puck skill, a trap wants defensive reads and
 * discipline, a net-front power play wants size and hands in tight). A
 * player's fit is that mix measured against his own overall level, so it
 * describes his *style*, not how good he is (quality already counts
 * everywhere else). Team fit averages the players who execute the system and
 * feeds the game engine; balanced options are neutral by design.
 *
 * System familiarity (0..1 per area) grows with games played in a system and
 * drops when the system, the coach or the roster changes.
 */
import { clamp } from '../core/math';
import type { AttrKey, League, Player, Tactics, Team } from '../types';
import { isForward } from '../player/ability';

export type FitArea = 'offense' | 'defense' | 'forecheck' | 'pp' | 'pk';
export const FIT_AREAS: FitArea[] = ['offense', 'defense', 'forecheck', 'pp', 'pk'];

type Weights = Partial<Record<AttrKey, number>>;

/** Attribute mixes each option asks for (skaters). Balanced options have none (neutral). */
export const SYSTEM_DEMANDS: { [A in FitArea]: Partial<Record<string, { F: Weights; D: Weights; why: string }>> } = {
  offense: {
    rush: { F: { speed: 3, acceleration: 2, stickhandling: 2, puckControl: 1, passing: 1, creativity: 1 }, D: { speed: 2, passing: 2, puckControl: 1, acceleration: 1 }, why: 'speed and puck skill in transition' },
    cycle: { F: { strength: 3, balance: 2, puckControl: 2, offAwareness: 1, backhand: 1, endurance: 1 }, D: { slapAccuracy: 1, passing: 2, offAwareness: 1, strength: 1 }, why: 'strength and puck protection down low' },
    possession: { F: { passing: 3, receiving: 2, decisionMaking: 2, hockeySense: 2, creativity: 1 }, D: { passing: 3, decisionMaking: 2, puckControl: 1, hockeySense: 1 }, why: 'passing, patience and hockey sense' },
    dumpChase: { F: { speed: 2, bodyChecking: 2, strength: 2, endurance: 2, aggression: 1, determination: 1 }, D: { slapPower: 1, strength: 1, endurance: 1 }, why: 'skating, size and a hard forecheck' },
  },
  defense: {
    aggressive: { F: { speed: 2, stickChecking: 2, aggression: 1, endurance: 2, anticipation: 1 }, D: { speed: 2, stickChecking: 2, anticipation: 1, agility: 1 }, why: 'mobility and active sticks' },
    trap: { F: { defAwareness: 2, positioning: 2, discipline: 2, backchecking: 2 }, D: { defPositioning: 2, defAwareness: 2, discipline: 1, positioning: 1 }, why: 'defensive reads and discipline' },
    passive: { F: { backchecking: 2, positioning: 1, shotBlocking: 1 }, D: { shotBlocking: 3, defPositioning: 2, strength: 1, positioning: 1 }, why: 'shot blocking and slot protection' },
    physical: { F: { bodyChecking: 3, strength: 2, aggression: 2, balance: 1 }, D: { bodyChecking: 3, strength: 2, aggression: 1, balance: 1 }, why: 'size and physicality' },
  },
  forecheck: {
    '2-1-2': { F: { speed: 2, acceleration: 1, endurance: 2, aggression: 1, stickChecking: 1 }, D: { speed: 1, anticipation: 1 }, why: 'speed and stamina to pressure deep' },
    '1-3-1': { F: { positioning: 2, defAwareness: 2, anticipation: 2, discipline: 1 }, D: { defPositioning: 2, anticipation: 1 }, why: 'positioning and anticipation in the neutral zone' },
  },
  pp: {
    umbrella: { F: { oneTimer: 2, passing: 2, wristAccuracy: 1 }, D: { slapPower: 3, slapAccuracy: 2, passing: 2 }, why: 'a point shot and one-timers' },
    overload: { F: { passing: 3, creativity: 2, receiving: 1, offAwareness: 1 }, D: { passing: 2, offAwareness: 1 }, why: 'puck movement and creativity' },
    shooting: { F: { wristPower: 2, wristAccuracy: 2, oneTimer: 2, shotSelection: 1 }, D: { slapPower: 2, slapAccuracy: 1 }, why: 'shooters' },
    netFront: { F: { strength: 3, balance: 2, backhand: 1, stickhandling: 1 }, D: { slapAccuracy: 2, passing: 1 }, why: 'size and hands around the net' },
  },
  pk: {
    box: { F: { positioning: 2, shotBlocking: 2, defAwareness: 1, discipline: 1 }, D: { shotBlocking: 2, defPositioning: 2, strength: 1 }, why: 'positioning and shot blocking' },
    diamond: { F: { stickChecking: 2, anticipation: 2, shotBlocking: 1 }, D: { stickChecking: 1, shotBlocking: 2, anticipation: 1 }, why: 'active sticks and anticipation' },
    aggressive: { F: { speed: 2, stickChecking: 2, endurance: 1, anticipation: 1 }, D: { speed: 1, stickChecking: 2 }, why: 'speed and stick pressure' },
    passive: { F: { shotBlocking: 2, defAwareness: 2, discipline: 1 }, D: { shotBlocking: 3, strength: 1, defPositioning: 1 }, why: 'blocking shots and clearing' },
  },
};

const SKATER_KEYS: AttrKey[] = [
  'speed', 'acceleration', 'agility', 'balance', 'edgework', 'wristPower', 'wristAccuracy', 'slapPower', 'slapAccuracy', 'oneTimer', 'backhand',
  'shotSelection', 'stickhandling', 'passing', 'puckControl', 'receiving', 'creativity', 'offAwareness', 'defAwareness', 'positioning',
  'anticipation', 'decisionMaking', 'hockeySense', 'strength', 'bodyChecking', 'aggression', 'endurance', 'stickChecking', 'shotBlocking',
  'defPositioning', 'backchecking', 'discipline', 'determination',
];

/** Attribute points per standard deviation of style difference. */
const STYLE_SD = 9;

/** League attribute profile per position group: a player's style is measured against what is typical for his position. */
export interface FitNorm {
  F: { mean: Partial<Record<AttrKey, number>>; overall: number };
  D: { mean: Partial<Record<AttrKey, number>>; overall: number };
}

const normCache = new WeakMap<League, { stamp: string; norm: FitNorm }>();

function overallLevel(p: Player): number {
  let s = 0;
  for (const k of SKATER_KEYS) s += p.attrs[k] ?? 0;
  return s / SKATER_KEYS.length;
}

export function fitNormFrom(players: Player[]): FitNorm {
  const make = (list: Player[]) => {
    const mean: Partial<Record<AttrKey, number>> = {};
    for (const k of SKATER_KEYS) mean[k] = list.reduce((s, p) => s + (p.attrs[k] ?? 0), 0) / Math.max(1, list.length);
    return { mean, overall: list.reduce((s, p) => s + overallLevel(p), 0) / Math.max(1, list.length) };
  };
  return { F: make(players.filter((p) => isForward(p.pos))), D: make(players.filter((p) => p.pos === 'D')) };
}

/** Each team's top 12 forwards and 6 defencemen: the players systems are measured on. */
export function regulars(players: Player[]): Player[] {
  const byTeam = new Map<number, Player[]>();
  for (const p of players) if (p.teamId !== null && p.pos !== 'G') (byTeam.get(p.teamId) ?? byTeam.set(p.teamId, []).get(p.teamId)!).push(p);
  const out: Player[] = [];
  for (const list of byTeam.values()) {
    out.push(...list.filter((p) => isForward(p.pos)).sort((a, b) => b.ca - a.ca).slice(0, 12));
    out.push(...list.filter((p) => p.pos === 'D').sort((a, b) => b.ca - a.ca).slice(0, 6));
  }
  return out;
}

/** The league's typical skater profiles (cached per season/phase). */
export function fitNorm(league: League): FitNorm {
  const stamp = `${league.season}-${league.phase}-${league.day}`;
  const hit = normCache.get(league);
  if (hit && hit.stamp === stamp) return hit.norm;
  const norm = fitNormFrom(regulars(Object.values(league.players).filter((p) => p.status === 'active' && p.teamId !== null)));
  normCache.set(league, { stamp, norm });
  return norm;
}

/** A player's fit for one option: style z-score (about −2..+2), 0 for balanced options or goalies. */
export function playerFit(p: Player, area: FitArea, option: string, norm: FitNorm): number {
  if (p.pos === 'G') return 0;
  const demand = SYSTEM_DEMANDS[area][option];
  if (!demand) return 0;
  const grp = p.pos === 'D' ? 'D' : 'F';
  const w = demand[grp];
  const n = norm[grp];
  let sum = 0;
  let tot = 0;
  for (const [k, wt] of Object.entries(w)) {
    sum += ((p.attrs[k as AttrKey] ?? 0) - (n.mean[k as AttrKey] ?? 0)) * wt!;
    tot += wt!;
  }
  if (!tot) return 0;
  // Relative to his own level: a great player is not automatically a great fit for everything.
  return clamp((sum / tot - (overallLevel(p) - n.overall)) / STYLE_SD, -2.5, 2.5);
}

/** 0..100 display score for a player's fit (50 = neutral). */
export const fitScore = (z: number): number => Math.round(clamp(50 + z * 18, 0, 100));

export function fitLabel(z: number): { text: string; cls: string } {
  if (z >= 0.6) return { text: 'Great fit', cls: 'good' };
  if (z >= 0.2) return { text: 'Good fit', cls: 'good' };
  if (z > -0.2) return { text: 'Neutral', cls: '' };
  if (z > -0.6) return { text: 'Poor fit', cls: 'warn' };
  return { text: 'Bad fit', cls: 'bad' };
}

/** Who executes each area: forwards matter more for offence/forecheck, defence more on the PK point and blue line. */
const AREA_WEIGHT: Record<FitArea, { F: number; D: number }> = {
  offense: { F: 1, D: 0.6 },
  defense: { F: 0.8, D: 1 },
  forecheck: { F: 1, D: 0.3 },
  pp: { F: 1, D: 0.9 },
  pk: { F: 0.9, D: 1 },
};

/**
 * Team fit for one option in −1..+1 from the players who would execute it
 * (top 12 F / 6 D by ability; PP/PK units when lines are set).
 */
export function teamFitFor(norm: FitNorm, players: Player[], area: FitArea, option: string, units?: number[][]): number {
  const skaters = players.filter((p) => p.pos !== 'G');
  let pool: Player[];
  if ((area === 'pp' || area === 'pk') && units?.length) {
    const ids = new Set(units.flat());
    pool = skaters.filter((p) => ids.has(p.id));
  } else {
    const f = skaters.filter((p) => isForward(p.pos)).sort((a, b) => b.ca - a.ca).slice(0, 12);
    const d = skaters.filter((p) => p.pos === 'D').sort((a, b) => b.ca - a.ca).slice(0, 6);
    pool = [...f, ...d];
  }
  if (!pool.length || !SYSTEM_DEMANDS[area][option]) return 0;
  let s = 0;
  let w = 0;
  for (const p of pool) {
    const wt = p.pos === 'D' ? AREA_WEIGHT[area].D : AREA_WEIGHT[area].F;
    s += playerFit(p, area, option, norm) * wt;
    w += wt;
  }
  // Averages of ~18 players vary much less than individuals: rescale so typical rosters span about ±1.
  // Soft limit: strong fits approach ±1 without piling up at the cap.
  return Math.tanh((s / w) / TEAM_SCALE);
}

/** Typical spread of a roster's average fit; dividing by it makes rosters span about ±1. */
const TEAM_SCALE = 0.6;

export type TeamFit = Record<FitArea, number>;

const optionOf = (t: Tactics, area: FitArea): string => (area === 'offense' ? t.offense : area === 'defense' ? t.defense : area === 'forecheck' ? t.forecheck : area === 'pp' ? t.pp : t.pk);

/** Fit of the team's current tactics (what the engine uses). */
export function teamFit(norm: FitNorm, players: Player[], tactics: Tactics, lines?: { pp: number[][]; pk: number[][] }): TeamFit {
  const out = {} as TeamFit;
  for (const a of FIT_AREAS) out[a] = teamFitFor(norm, players, a, optionOf(tactics, a), a === 'pp' ? lines?.pp : a === 'pk' ? lines?.pk : undefined);
  return out;
}

/** Fit of every option in every area, for the tactics screen and the AI. */
export function allOptionFits(norm: FitNorm, players: Player[], lines?: { pp: number[][]; pk: number[][] }): Record<FitArea, Record<string, number>> {
  const opts: Record<FitArea, string[]> = {
    offense: ['balanced', 'rush', 'cycle', 'possession', 'dumpChase'],
    defense: ['balanced', 'aggressive', 'trap', 'passive', 'physical'],
    forecheck: ['1-2-2', '2-1-2', '1-3-1'],
    pp: ['umbrella', 'overload', 'shooting', 'netFront'],
    pk: ['box', 'diamond', 'aggressive', 'passive'],
  };
  const out = {} as Record<FitArea, Record<string, number>>;
  for (const a of FIT_AREAS) {
    out[a] = {};
    for (const o of opts[a]) out[a][o] = teamFitFor(norm, players, a, o, a === 'pp' ? lines?.pp : a === 'pk' ? lines?.pk : undefined);
  }
  return out;
}

/** Player's fit for his team's current systems (even strength) and his best styles. */
export function playerSystemFit(norm: FitNorm, p: Player, tactics: Tactics): { offense: number; defense: number; forecheck: number; overall: number } {
  const offense = playerFit(p, 'offense', tactics.offense, norm);
  const defense = playerFit(p, 'defense', tactics.defense, norm);
  const forecheck = playerFit(p, 'forecheck', tactics.forecheck, norm);
  return { offense, defense, forecheck, overall: offense * 0.45 + defense * 0.35 + forecheck * 0.2 };
}

// ───────────────────────────── familiarity ─────────────────────────────

export type Familiarity = Record<FitArea, number>;

export const fullFamiliarity = (): Familiarity => ({ offense: 1, defense: 1, forecheck: 1, pp: 1, pk: 1 });

/** Per-game familiarity gain; a strong tactician installs a system faster (about 15–30 games to learn one). */
function gainPerGame(league: League, team: Team): number {
  const hc = team.staff.headCoach !== null ? league.coaches[team.staff.headCoach] : undefined;
  const tac = hc?.ratings.tactics ?? 100;
  return clamp(0.035 + (tac - 100) / 4000, 0.025, 0.07);
}

/** Before a game: detect system changes (familiarity halves in the changed area). */
export function syncFamiliarity(team: Team): Familiarity {
  team.familiarity ??= fullFamiliarity();
  const prev = team.famTactics;
  if (prev) for (const a of FIT_AREAS) if (optionOf(prev, a) !== optionOf(team.tactics, a)) team.familiarity[a] *= 0.5;
  team.famTactics = { ...team.tactics };
  return team.familiarity;
}

/** After a game: players learn the system. */
export function learnSystem(league: League, team: Team): void {
  syncFamiliarity(team);
  const g = gainPerGame(league, team);
  for (const a of FIT_AREAS) team.familiarity![a] = Math.min(1, team.familiarity![a] + g);
}

/** A new head coach brings a new system: most familiarity is lost. */
export function coachChangeFamiliarity(team: Team): void {
  team.familiarity = { offense: 0.35, defense: 0.35, forecheck: 0.35, pp: 0.35, pk: 0.35 };
  team.famTactics = { ...team.tactics };
}

/** New players need time to learn the system (team familiarity dips a little per arrival). */
export function rosterChangeFamiliarity(team: Team, arrivals: number): void {
  if (!arrivals) return;
  team.familiarity ??= fullFamiliarity();
  const k = Math.pow(0.975, arrivals);
  for (const a of FIT_AREAS) team.familiarity[a] *= k;
}

/** Training camp: everyone gets reps in the system. */
export function trainingCamp(team: Team): void {
  team.familiarity ??= fullFamiliarity();
  for (const a of FIT_AREAS) team.familiarity[a] = Math.min(1, team.familiarity[a] * 0.85 + 0.25);
}
