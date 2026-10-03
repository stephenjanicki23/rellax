/**
 * Turns real NHL roster records into game players.
 *
 * Ratings are estimated from recent NHL production (points, goals, ice time,
 * shooting, faceoffs, save percentage), blended over up to three seasons and
 * shrunk toward replacement level for small samples. Players are then ranked
 * league-wide by position group and the rank is mapped onto the same ability
 * distribution the fictional generator produces, so engine balance (goals,
 * save %, standings spread) is unchanged. Stat profiles pick the archetype and
 * nudge individual attributes, so a sniper shoots like one and a 58% faceoff
 * man wins draws.
 */
import type { Rng } from '../../core/rng';
import { clamp } from '../../core/math';
import type { ArchetypeId, AttrKey, Player, Position } from '../../types';
import { generatePlayer } from '../../player/generate';
import { abilityWeights, computeCA } from '../../player/ability';
import { NAME_POOLS } from '../names';
import type { NhlPlayerRecord, NhlSnapshot } from './types';

type Group = 'F' | 'D' | 'G';

/** Weight of each recent season, newest first. */
const SEASON_W = [1, 0.55, 0.3];

/** ISO-3 → name-pool code where they differ. */
const COUNTRY_TO_POOL: Record<string, string> = { DEU: 'GER', CHE: 'SUI', LVA: 'LAT' };

export interface SkaterProfile {
  /** Season-weighted games played (sample size). */
  n: number;
  ppg: number;
  gpg: number;
  apg: number;
  toiMin: number;
  pimPg: number;
  pmPg: number;
  shotsPg: number;
  shPct: number;
  fo: number | null;
}

export interface GoalieProfile {
  n: number;
  sv: number;
  shotsFaced: number;
  starts: number;
}

export function skaterProfile(rec: NhlPlayerRecord): SkaterProfile {
  const lines = (rec.skater ?? []).slice(0, SEASON_W.length);
  let n = 0;
  let pts = 0, g = 0, a = 0, toi = 0, pim = 0, pm = 0, shots = 0;
  let foW = 0, fo = 0;
  lines.forEach((l, i) => {
    if (!l.gp) return;
    const w = SEASON_W[i];
    n += w * l.gp;
    pts += w * (l.g + l.a);
    g += w * l.g;
    a += w * l.a;
    toi += w * l.gp * (l.toi / 60);
    pim += w * l.pim;
    pm += w * l.pm;
    shots += w * l.shots;
    if (l.fo !== null && l.fo !== undefined) {
      fo += w * l.gp * l.fo;
      foW += w * l.gp;
    }
  });
  const per = (x: number) => (n > 0 ? x / n : 0);
  return {
    n,
    ppg: per(pts),
    gpg: per(g),
    apg: per(a),
    toiMin: per(toi),
    pimPg: per(pim),
    pmPg: per(pm),
    shotsPg: per(shots),
    shPct: shots > 0 ? g / shots : 0.09,
    fo: foW >= 15 ? fo / foW : null,
  };
}

export function goalieProfile(rec: NhlPlayerRecord): GoalieProfile {
  const lines = (rec.goalie ?? []).slice(0, SEASON_W.length);
  let n = 0, saves = 0, shots = 0, starts = 0;
  lines.forEach((l, i) => {
    if (!l.gp) return;
    const w = SEASON_W[i];
    const sa = l.gp * 27;
    n += w * l.gp;
    shots += w * sa;
    saves += w * sa * l.sv;
    starts += w * l.gs;
  });
  return { n, sv: shots > 0 ? saves / shots : 0.895, shotsFaced: shots, starts };
}

const REPLACEMENT = { F: { ppg: 0.2, toi: 11, gpg: 0.08 }, D: { ppg: 0.14, toi: 15.5, gpg: 0.02 } };
const PRIOR_GAMES = 25;

/** Single number used to rank players within their position group. */
export function valueScore(rec: NhlPlayerRecord, group: Group): number {
  if (group === 'G') {
    const g = goalieProfile(rec);
    const PRIOR_SHOTS = 1600;
    const sv = (g.sv * g.shotsFaced + 0.893 * PRIOR_SHOTS) / (g.shotsFaced + PRIOR_SHOTS);
    return sv * 1000 + Math.min(g.starts, 60) * 0.12;
  }
  const s = skaterProfile(rec);
  const rep = REPLACEMENT[group];
  const shrink = (x: number, r: number) => (x * s.n + r * PRIOR_GAMES) / (s.n + PRIOR_GAMES);
  const ppg = shrink(s.ppg, rep.ppg);
  const toi = shrink(s.toiMin, rep.toi);
  const gpg = shrink(s.gpg, rep.gpg);
  if (group === 'F') return ppg * 100 + toi * 3 + gpg * 30;
  return ppg * 70 + toi * 4.5 + shrink(s.pmPg, 0) * 15;
}

/** Ability by league percentile (0 = best), per position group. Mirrors the generator's roster slots. */
const CA_CURVES: Record<Group, [number, number][]> = {
  F: [[0, 181], [0.01, 171], [0.05, 160], [0.12, 152], [0.25, 143], [0.5, 130], [0.75, 118], [0.9, 110], [1, 98]],
  D: [[0, 175], [0.02, 163], [0.08, 153], [0.2, 143], [0.4, 135], [0.6, 127], [0.8, 117], [1, 104]],
  G: [[0, 172], [0.05, 162], [0.15, 155], [0.33, 148], [0.5, 140], [0.7, 126], [0.85, 119], [1, 108]],
};

export function caForPercentile(group: Group, p: number): number {
  const c = CA_CURVES[group];
  for (let i = 1; i < c.length; i++) {
    if (p <= c[i][0]) {
      const [p0, v0] = c[i - 1];
      const [p1, v1] = c[i];
      return v0 + ((p - p0) / (p1 - p0)) * (v1 - v0);
    }
  }
  return c[c.length - 1][1];
}

export function archetypeFor(rec: NhlPlayerRecord, pos: Position): ArchetypeId {
  if (pos === 'G') {
    if (rec.heightCm >= 193) return 'butterflyGoalie';
    if (rec.heightCm <= 186) return 'athleticGoalie';
    return 'hybridGoalie';
  }
  const s = skaterProfile(rec);
  const heavy = rec.weightKg >= 97;
  if (pos === 'D') {
    if (s.ppg >= 0.68) return 'offensiveDefenseman';
    if (heavy && s.pimPg >= 0.6) return 'physicalDefenseman';
    if (s.ppg >= 0.4) return 'puckMovingDefenseman';
    if (s.ppg < 0.2 && s.n > 0) return 'stayAtHome';
    return heavy ? 'physicalDefenseman' : 'twoWayDefenseman';
  }
  if (s.n > 0 && s.ppg < 0.25 && (s.pimPg >= 1 || (heavy && s.pimPg >= 0.6))) return s.pimPg >= 1.3 ? 'enforcer' : 'grinder';
  if (s.ppg < 0.36) return pos === 'C' && (s.fo ?? 0.5) >= 0.51 ? 'defensiveForward' : s.pimPg >= 0.5 ? 'grinder' : 'defensiveForward';
  const goalShare = s.ppg > 0 ? s.gpg / s.ppg : 0.4;
  if (goalShare >= 0.5) return heavy ? 'powerForward' : 'sniper';
  if (goalShare <= 0.37) return 'playmaker';
  return heavy && s.pimPg >= 0.5 ? 'powerForward' : 'twoWayForward';
}

/** Per-attribute offsets from the stat profile (the generator re-normalises to the target ability). */
export function statBias(rec: NhlPlayerRecord, pos: Position): Partial<Record<AttrKey, number>> {
  const b: Partial<Record<AttrKey, number>> = {};
  const add = (k: AttrKey, v: number) => (b[k] = clamp((b[k] ?? 0) + v, -28, 28));
  if (pos === 'G') {
    const g = goalieProfile(rec);
    if (g.n >= 10) {
      const d = (g.sv - 0.905) * 1500;
      add('reflexes', d);
      add('highDanger', d);
      add('glove', d * 0.5);
    }
    return b;
  }
  const s = skaterProfile(rec);
  const physical = (rec.weightKg - 91) * 1.3;
  add('strength', physical);
  add('bodyChecking', physical * 0.8);
  add('aggression', (s.pimPg - 0.4) * 25);
  add('discipline', -(s.pimPg - 0.4) * 20);
  if (s.n < 10) return b;
  if (pos === 'D') {
    add('slapPower', (s.shotsPg - 1.4) * 10);
    add('slapAccuracy', (s.shotsPg - 1.4) * 6);
    add('passing', (s.apg - 0.25) * 50);
    add('offAwareness', (s.ppg - 0.3) * 40);
    add('shotBlocking', -(s.ppg - 0.3) * 20);
  } else {
    add('wristAccuracy', (s.shPct - 0.105) * 220);
    add('shotSelection', (s.shPct - 0.105) * 160);
    add('wristPower', (s.shotsPg - 2) * 8);
    add('oneTimer', (s.shotsPg - 2) * 6);
    add('passing', (s.apg - 0.3) * 45);
    add('creativity', (s.apg - 0.3) * 35);
    add('defAwareness', s.pmPg * 60);
    add('backchecking', s.pmPg * 40);
  }
  return b;
}

const POS: Record<NhlPlayerRecord['pos'], Position> = { C: 'C', L: 'LW', R: 'RW', D: 'D', G: 'G' };
const groupOf = (pos: Position): Group => (pos === 'G' ? 'G' : pos === 'D' ? 'D' : 'F');

export function snapshotHasRosters(snap: NhlSnapshot, abbrs: string[]): boolean {
  return abbrs.every((a) => (snap.teams[a]?.length ?? 0) >= 18);
}

/**
 * Build players for every team in the snapshot. Returns team abbreviation →
 * players (sorted best first). Contracts/teams are assigned by the caller.
 */
export function buildRealPlayers(rng: Rng, snap: NhlSnapshot, abbrs: string[], season: number, nextId: () => number): Map<string, Player[]> {
  const entries: { abbr: string; rec: NhlPlayerRecord; pos: Position; group: Group; score: number }[] = [];
  for (const abbr of abbrs)
    for (const rec of snap.teams[abbr] ?? []) {
      const pos = POS[rec.pos];
      const group = groupOf(pos);
      entries.push({ abbr, rec, pos, group, score: valueScore(rec, group) });
    }
  const pct = new Map<NhlPlayerRecord, number>();
  for (const g of ['F', 'D', 'G'] as Group[]) {
    const list = entries.filter((e) => e.group === g).sort((a, b) => b.score - a.score);
    list.forEach((e, i) => pct.set(e.rec, list.length > 1 ? i / (list.length - 1) : 0.5));
  }
  const out = new Map<string, Player[]>(abbrs.map((a) => [a, []]));
  for (const e of entries) {
    const { rec, pos } = e;
    const birthYear = Number(rec.birthDate.slice(0, 4));
    const age = clamp(season - birthYear, 17, 45);
    const targetCA = Math.round(caForPercentile(e.group, pct.get(rec)!));
    const poolCode = COUNTRY_TO_POOL[rec.country] ?? rec.country;
    const pool = NAME_POOLS.find((n) => n.code === poolCode);
    const p = generatePlayer(rng, {
      id: nextId(),
      pos,
      targetCA,
      age,
      season,
      archetype: archetypeFor(rec, pos),
      nat: pool?.code,
      bias: statBias(rec, pos),
    });
    p.nhlId = rec.nhlId;
    p.first = rec.first;
    p.last = rec.last;
    p.nat = poolCode;
    p.birthYear = birthYear;
    p.shoots = rec.shoots;
    p.heightCm = rec.heightCm;
    p.weightKg = rec.weightKg;
    if (rec.number) p.number = rec.number;
    // Faceoffs come straight from real faceoff %, not from overall ability.
    const fo = pos === 'C' ? skaterProfile(rec).fo : null;
    if (fo !== null) setAttrKeepingCA(p, 'faceoffs', clamp(118 + (fo - 0.5) * 700, 45, 195));
    if (!pool) p.junior = 'Europe';
    const nhlSeasons = (rec.skater ?? rec.goalie ?? []).filter((l) => l.gp > 0).length;
    p.proSeasons = Math.max(nhlSeasons, Math.max(0, age - 21));
    out.get(e.abbr)!.push(p);
  }
  for (const list of out.values()) list.sort((a, b) => b.ca - a.ca);
  return out;
}

/** Set one attribute, then shift the other ability attributes so overall ability is unchanged. */
function setAttrKeepingCA(p: Player, key: AttrKey, value: number): void {
  const target = p.ca;
  p.attrs[key] = Math.round(value);
  const w = abilityWeights(p.pos);
  for (let iter = 0; iter < 6; iter++) {
    const diff = target - computeCA(p.attrs, p.pos);
    if (Math.abs(diff) < 0.5) break;
    for (const k of Object.keys(w) as AttrKey[]) if (k !== key && (w[k] ?? 0) > 0) p.attrs[k] = Math.round(clamp(p.attrs[k] + diff * 1.05, 1, 200));
  }
  p.ca = computeCA(p.attrs, p.pos);
  p.pa = Math.max(p.pa, p.ca);
  p.caSeasonStart = p.ca;
}
