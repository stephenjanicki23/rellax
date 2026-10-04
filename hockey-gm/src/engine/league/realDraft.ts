/**
 * Real draft assets from data/draft/picks.json and data/prospects/reserves.json
 * (built by `npm run build:draft` from CapWages):
 *
 *  - pick ownership: every future pick, including picks that changed hands
 *    and the conditions attached to them ("Top-10 protected")
 *  - reserve lists: each club's unsigned draft picks, with the date the club
 *    must sign them by before their rights lapse
 *
 * Season convention: in the game a pick's `season` is the season whose draft
 * it belongs to, held the following June (pick.season 2026 = the 2027 NHL
 * draft). Draft years in the data are therefore `pick.season + 1`.
 */
import type { Rng } from '../core/rng';
import { clamp } from '../core/math';
import type { DraftPick, Player, Position, Team } from '../types';
import { generatePlayer } from '../player/generate';
import PICKS_JSON from '../../../data/draft/picks.json';
import RESERVES_JSON from '../../../data/prospects/reserves.json';

export interface ImportedPick {
  year: number;
  round: number;
  original: string;
  owner: string;
  conditions?: string[];
  note?: string;
}

export interface ImportedReserve {
  team: string;
  first: string;
  last: string;
  slug: string;
  born: string | null;
  pos: string;
  draftedBy: string;
  draftYear: number | null;
  round: number | null;
  overall: number | null;
  mustSignBy: string | null;
}

const PICKS = (PICKS_JSON as { picks: ImportedPick[] }).picks;
const RESERVES = (RESERVES_JSON as { prospects: ImportedReserve[] }).prospects;

export function draftDataInfo(): { asOf: string; picks: number; prospects: number } {
  return { asOf: (PICKS_JSON as { asOf: string }).asOf, picks: PICKS.length, prospects: RESERVES.length };
}

/** "Top-10 protected" → 10. */
export function protectionFrom(conditions: string[] | undefined): number | undefined {
  for (const c of conditions ?? []) {
    const m = c.match(/top[\s-]*(\d+)[\s-]*protect/i);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/**
 * Apply real ownership to the league's picks. Returns how many picks changed
 * hands. Picks the data doesn't cover stay with their original team.
 */
export function applyRealPickOwnership(picks: DraftPick[], teams: Team[]): number {
  const byAbbr = new Map(teams.map((t) => [t.abbr, t.id]));
  const rows = new Map(PICKS.map((r) => [`${r.year}-${r.round}-${r.original}`, r]));
  let moved = 0;
  for (const pick of picks) {
    const row = rows.get(`${pick.season + 1}-${pick.round}-${teams[pick.originalTeamId].abbr}`);
    if (!row) continue;
    const owner = byAbbr.get(row.owner);
    if (owner === undefined) continue;
    if (owner !== pick.ownerId) moved++;
    pick.ownerId = owner;
    if (row.conditions?.length) {
      pick.conditions = row.conditions;
      const top = protectionFrom(row.conditions);
      if (top !== undefined && owner !== pick.originalTeamId) pick.protectedTop = top;
    }
  }
  return moved;
}

const POS: Record<string, Position> = { C: 'C', LW: 'LW', RW: 'RW', D: 'D', G: 'G' };
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

/**
 * Ratings for a real prospect. There is no public rating for unsigned picks,
 * so potential is estimated from where he was drafted (earlier picks project
 * higher, with wide spread) and dimmed the longer he goes unsigned; current
 * ability follows his age. SIMPLIFICATION: draft slot stands in for scouting.
 */
function prospectRatings(rng: Rng, r: ImportedReserve, age: number, season: number): { ca: number; pa: number } {
  const overall = r.overall ?? (r.round ? (r.round - 0.5) * 32 : 150);
  let pa = 182 - 9.6 * Math.log(Math.max(1, overall)) + rng.normal(0, 7);
  // Still unsigned years after the draft: the club hasn't seen enough to sign him.
  const yearsSince = r.draftYear ? season + 1 - r.draftYear : 0;
  if (yearsSince > 3) pa -= (yearsSince - 3) * 4;
  pa = Math.round(clamp(pa, 95, 192));
  const frac = clamp(0.56 + (age - 18) * 0.06 + rng.normal(0, 0.03), 0.48, 0.92);
  const ca = Math.round(clamp(pa * frac, 45, pa));
  return { ca, pa };
}

/** Season in whose offseason his rights lapse (the Aug./June sign-by date falls after that season). */
function signBySeason(r: ImportedReserve, birthYear: number, season: number): number {
  if (r.mustSignBy) return Number(r.mustSignBy.slice(0, 4)) - 1;
  // No deadline listed (rights held while he plays in Europe): SIMPLIFICATION — until age 27, at least this summer.
  return Math.max(season, birthYear + 26);
}

/**
 * Each club's real unsigned draft picks as players in its system (status
 * 'prospect', no contract, rights held). Players already in the league
 * (signed since the data was pulled) are skipped.
 */
export function buildRealReserves(rng: Rng, teams: Team[], season: number, existing: Iterable<Player>, nextId: () => number): Player[] {
  const byAbbr = new Map(teams.map((t) => [t.abbr, t.id]));
  const known = new Set<string>();
  for (const p of existing) known.add(`${norm(p.first)}|${norm(p.last)}|${p.birthYear}`);
  const out: Player[] = [];
  for (const r of RESERVES) {
    const teamId = byAbbr.get(r.team);
    if (teamId === undefined || !r.born) continue;
    const birthYear = Number(r.born.slice(0, 4));
    const key = `${norm(r.first)}|${norm(r.last)}|${birthYear}`;
    if (known.has(key)) continue;
    known.add(key);
    const age = season - birthYear;
    // Decades-old rights to players who never came over (kept on some reserve lists) aren't prospects.
    if (age > 28) continue;
    const pos = POS[r.pos] ?? 'C';
    const { ca, pa } = prospectRatings(rng, r, age, season);
    const p = generatePlayer(rng, { id: nextId(), pos, targetCA: ca, age, season, pa, tier: clamp((pa - 120) / 60, 0, 1) });
    p.first = r.first;
    p.last = r.last;
    p.birthYear = birthYear;
    p.ca = Math.min(p.ca, p.pa);
    p.teamId = teamId;
    p.rightsTeamId = teamId;
    p.status = 'prospect';
    p.contract = null;
    p.proSeasons = 0;
    p.reputation = Math.round(clamp((pa - 100) * 0.5, 1, 70));
    const draftedBy = byAbbr.get(r.draftedBy) ?? teamId;
    p.draft = r.draftYear ? { season: r.draftYear - 1, round: r.round ?? 7, pick: r.overall ?? 0, teamId: draftedBy } : null;
    p.signBySeason = signBySeason(r, birthYear, season);
    out.push(p);
  }
  return out;
}
