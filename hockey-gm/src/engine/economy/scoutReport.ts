/**
 * Written scouting reports: a grade and a few lines for each area of a
 * player's game, concerns, a style comparison to a current NHL player, and
 * the scout who filed it. Everything is read through the user's (imperfect)
 * scouting: area values come from displayedAttr, so a thinly scouted player's
 * report can be wrong.
 *
 * SIMPLIFICATION: areas are graded against the league's current NHL players at
 * the same position group; prospects are graded on where each area projects
 * (scaled by the estimated ceiling), not where it is today.
 */
import type { AttrKey, League, Player } from '../types';
import { displayedAttr, estimate, knowledgeOf, leadScout, scoutReport } from './scouting';
import { ARCHETYPES } from '../player/archetypes';

type Group = 'F' | 'D' | 'G';
const groupOf = (p: Player): Group => (p.pos === 'G' ? 'G' : p.pos === 'D' ? 'D' : 'F');

interface AreaDef {
  label: string;
  keys: AttrKey[];
}

const SKATER_AREAS: AreaDef[] = [
  { label: 'Skating', keys: ['speed', 'acceleration', 'agility', 'balance', 'edgework'] },
  { label: 'Shooting', keys: ['wristPower', 'wristAccuracy', 'slapPower', 'oneTimer', 'shotSelection'] },
  { label: 'Puck skills', keys: ['stickhandling', 'passing', 'puckControl', 'receiving', 'creativity'] },
  { label: 'Hockey sense', keys: ['offAwareness', 'anticipation', 'decisionMaking', 'hockeySense', 'positioning'] },
  { label: 'Compete & physical', keys: ['strength', 'bodyChecking', 'aggression', 'endurance', 'determination'] },
  { label: 'Defence', keys: ['defAwareness', 'stickChecking', 'shotBlocking', 'defPositioning', 'backchecking'] },
];

const GOALIE_AREAS: AreaDef[] = [
  { label: 'Reflexes & athleticism', keys: ['reflexes', 'athleticism', 'glove', 'blocker'] },
  { label: 'Positioning', keys: ['gPositioning', 'lateral', 'highDanger'] },
  { label: 'Rebounds & puck play', keys: ['reboundControl', 'puckHandling'] },
  { label: 'Mental game', keys: ['composure', 'consistency', 'clutch'] },
];

export const areasFor = (p: Player): AreaDef[] => (p.pos === 'G' ? GOALIE_AREAS : SKATER_AREAS);

const PHRASE: Partial<Record<AttrKey, string>> = {
  speed: 'top-end speed', acceleration: 'first-step quickness', agility: 'agility', balance: 'balance on his skates', edgework: 'edgework',
  wristPower: 'a heavy wrister', wristAccuracy: 'wrist-shot accuracy', slapPower: 'a big slap shot', oneTimer: 'his one-timer', shotSelection: 'shot selection',
  stickhandling: 'his hands', passing: 'his passing', puckControl: 'puck protection', receiving: 'taking passes in stride', creativity: 'creativity',
  offAwareness: 'offensive instincts', anticipation: 'anticipation', decisionMaking: 'decision-making', hockeySense: 'his read of the play', positioning: 'positioning',
  strength: 'strength', bodyChecking: 'physical play', aggression: 'his edge', endurance: 'conditioning', determination: 'work ethic',
  defAwareness: 'defensive awareness', stickChecking: 'an active stick', shotBlocking: 'shot blocking', defPositioning: 'gap control', backchecking: 'backchecking',
  reflexes: 'reflexes', athleticism: 'athleticism', glove: 'his glove hand', blocker: 'his blocker side', gPositioning: 'his angles', lateral: 'lateral movement',
  highDanger: 'stopping chances in tight', reboundControl: 'rebound control', puckHandling: 'puck handling', composure: 'composure', consistency: 'consistency', clutch: 'big-game play',
};

const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);

// League norms: area averages of current NHL players by position group, cached per day.
const normCache = new WeakMap<League, { key: string; norms: Record<Group, number[][]> }>();

function norms(league: League): Record<Group, number[][]> {
  const key = `${league.season}-${league.day}-${league.phase}`;
  const hit = normCache.get(league);
  if (hit && hit.key === key) return hit.norms;
  const out: Record<Group, number[][]> = { F: [], D: [], G: [] };
  for (const p of Object.values(league.players)) {
    if (p.status !== 'active' || p.teamId === null) continue;
    const g = groupOf(p);
    const areas = areasFor(p);
    areas.forEach((a, i) => (out[g][i] ??= []).push(avg(a.keys.map((k) => p.attrs[k]))));
  }
  for (const g of ['F', 'D', 'G'] as Group[]) out[g].forEach((xs) => xs.sort((a, b) => a - b));
  normCache.set(league, { key, norms: out });
  return out;
}

function percentile(sorted: number[] | undefined, v: number): number {
  if (!sorted?.length) return 50;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return (lo / sorted.length) * 100;
}

export function gradeWord(pct: number): string {
  return pct >= 92 ? 'elite' : pct >= 78 ? 'high-end' : pct >= 58 ? 'above average' : pct >= 40 ? 'NHL average' : pct >= 20 ? 'below average' : 'a weakness';
}

/** Is this player still being projected (rather than judged on what he is)? */
export function isProjection(league: League, p: Player): boolean {
  return p.status === 'draft' || p.status === 'prospect' || league.season - p.birthYear <= 22;
}

export interface ReportArea {
  label: string;
  percentile: number;
  grade: string;
  text: string;
}

export interface WrittenReport {
  byline: string | null;
  weeks: number;
  knowledge: number;
  projecting: boolean;
  areas: ReportArea[];
  /** Areas withheld because the player hasn't been seen enough. */
  hiddenAreas: number;
  concerns: string[];
  comparison: { player: Player; note: string } | null;
  bottomLine: string;
}

/** Area values as the user's staff sees them (projected for young players). */
function growthOf(league: League, p: Player, projecting: boolean): number {
  const e = estimate(league, p);
  return projecting ? Math.min(1.6, Math.max(1, e.pa / Math.max(1, e.ca))) : 1;
}

function areaValues(league: League, p: Player, projecting: boolean): number[] {
  const growth = growthOf(league, p, projecting);
  return areasFor(p).map((a) => avg(a.keys.map((k) => displayedAttr(league, p, k).value * growth)));
}

export function writtenReport(league: League, p: Player): WrittenReport {
  const k = knowledgeOf(league, p);
  const projecting = isProjection(league, p);
  const g = groupOf(p);
  const n = norms(league)[g];
  const defs = areasFor(p);
  const vals = areaValues(league, p, projecting);
  const grow = growthOf(league, p, projecting);
  let areas: ReportArea[] = defs.map((a, i) => {
    const pct = percentile(n[i], vals[i]);
    const subs = a.keys.map((key) => ({ key, v: displayedAttr(league, p, key).value * grow })).sort((x, y) => y.v - x.v);
    const best = subs[0];
    const worst = subs[subs.length - 1];
    const grade = gradeWord(pct);
    const lead = projecting ? `Projects to be ${grade}` : grade === 'a weakness' ? 'A weakness' : grade[0].toUpperCase() + grade.slice(1);
    let text = `${lead}.`;
    if (pct >= 40) text += ` Best tool: ${PHRASE[best.key] ?? best.key}.`;
    if (best.v - worst.v > 25 && subs.length > 2) text += ` ${(PHRASE[worst.key] ?? worst.key).replace(/^./, (c) => c.toUpperCase())} needs work.`;
    return { label: a.label, percentile: Math.round(pct), grade, text };
  });
  // Thinly scouted: only the standout and the obvious hole.
  let hiddenAreas = 0;
  if (k < 25) {
    hiddenAreas = areas.length;
    areas = [];
  } else if (k < 50) {
    const sorted = [...areas].sort((a, b) => b.percentile - a.percentile);
    const keep = new Set([sorted[0], sorted[1], sorted[sorted.length - 1]]);
    hiddenAreas = areas.length - keep.size;
    areas = areas.filter((a) => keep.has(a));
  }

  const concerns: string[] = [];
  if (k >= 40) {
    if (p.pos !== 'G' && p.heightCm < 178) concerns.push('Undersized: has to prove he can handle NHL traffic.');
    if (p.pos === 'G' && p.heightCm < 185) concerns.push('Small for a modern goalie; can lose sight of pucks through traffic.');
    if (p.attrs.consistency < 80) concerns.push('Inconsistent from game to game.');
    if (p.pos !== 'G' && p.attrs.discipline < 75) concerns.push('Takes undisciplined penalties.');
  }
  if (k >= 50 && (p.durability < 95 || p.traits.includes('injuryProne'))) concerns.push('Durability: a history of injuries worries the medical staff.');
  if ((k >= 60 || league.scouting.interviewed?.[p.id] !== undefined) && p.attrs.determination < 85) concerns.push('Questions about his work ethic.');
  if (k >= 55 && projecting && p.devCurve === 'late') concerns.push('Raw: could take a few years in the minors.');
  if (k >= 55 && projecting && (p.devCurve === 'bust' || p.devCurve === 'plateau')) concerns.push('Has not shown much growth since last season.');

  const comparison = k >= 50 && projecting ? nhlComparison(league, p, vals) : null;
  const lead = leadScout(league, p);
  const own = p.teamId === league.userTeamId && p.status !== 'draft';
  const byline = lead ? `${lead.scout.first} ${lead.scout.last}` : own ? 'Club staff' : null;
  const base = scoutReport(league, p).projection;
  const bottomLine = `${ARCHETYPES[p.archetype].label}. ${base}${k < 45 ? ' More viewings needed before we commit to that.' : ''}`;
  return { byline, weeks: lead?.weeks ?? 0, knowledge: Math.round(k), projecting, areas, hiddenAreas, concerns, comparison, bottomLine };
}

/** The current NHL player whose game this one most resembles (style, not certainty). */
export function nhlComparison(league: League, p: Player, projected: number[]): { player: Player; note: string } | null {
  const g = groupOf(p);
  const defs = areasFor(p);
  let best: { c: Player; d: number } | null = null;
  for (const c of Object.values(league.players)) {
    if (c.id === p.id || c.status !== 'active' || c.teamId === null || groupOf(c) !== g || league.season - c.birthYear < 24 || league.season - c.birthYear > 32) continue;
    const cv = defs.map((a) => avg(a.keys.map((key) => c.attrs[key])));
    // Shape of the game matters more than its level: compare each area relative to the player's own average.
    const pm = avg(projected);
    const cm = avg(cv);
    let d = 0;
    for (let i = 0; i < cv.length; i++) d += ((projected[i] - pm) - (cv[i] - cm)) ** 2;
    d = Math.sqrt(d) + Math.abs(pm - cm) * 0.6 - (c.archetype === p.archetype ? 8 : 0);
    if (!best || d < best.d) best = { c, d };
  }
  if (!best) return null;
  const e = estimate(league, p);
  const c = best.c;
  const note = e.pa < c.ca - 15 ? `a poor man's version of ${c.last}` : e.pa > c.ca + 15 ? `a similar game, with a higher ceiling` : `a similar game at a similar level`;
  return { player: c, note };
}
