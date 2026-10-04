/**
 * Real draft prospects from data/draft/class.json (built by
 * `npm run fetch:draftclass` from NHL Central Scouting rankings).
 *
 * Central Scouting ranks prospects on four lists (North American and
 * International skaters and goalies). There are no public ratings, so ability
 * is estimated from where a player sits on his list (translated to an
 * approximate overall draft slot) and his age; players re-entering the draft
 * after going unpicked project lower. SIMPLIFICATION: list rank stands in for
 * scouting.
 */
import type { Rng } from '../core/rng';
import { clamp } from '../core/math';
import type { CsCategory, Player, Position } from '../types';
import { generatePlayer } from '../player/generate';
import { NAME_POOLS } from '../data/names';
import CLASS_JSON from '../../../data/draft/class.json';

export interface ImportedProspect {
  first: string;
  last: string;
  pos: string;
  shoots: string | null;
  heightIn: number | null;
  weightLb: number | null;
  birthDate: string | null;
  birthCountry: string | null;
  club: string | null;
  league: string | null;
  category: CsCategory;
  rank: number;
  stage: 'midterm' | 'final' | 'board';
  reentry?: boolean;
  /** Overall rank on an imported big board (npm run import:draftboard). */
  boardRank?: number;
}

const DATA = CLASS_JSON as { draftYear: number; asOf: string; source: string; prospects: ImportedProspect[]; board?: { file: string; count: number; importedOn: string } };

/** True while the data holds only undrafted re-entries (the year's own rankings aren't out yet). */
export function isReentryClass(): boolean {
  return DATA.prospects.length > 0 && DATA.prospects.every((p) => p.reentry || p.boardRank);
}

export function draftClassInfo(): { draftYear: number; asOf: string; source: string; count: number; board: number } {
  return { draftYear: DATA.draftYear, asOf: DATA.asOf, source: DATA.source, count: DATA.prospects.length, board: DATA.board?.count ?? 0 };
}

/** Approximate overall draft slot for a list rank (North American skaters make up most of a draft). */
function slotFor(category: CsCategory, rank: number, reentry: boolean): number {
  const per: Record<CsCategory, number> = { 'NA-S': 1.55, 'INT-S': 2.4, 'NA-G': 7, 'INT-G': 9 };
  return rank * per[category] + (reentry ? 70 : 0);
}

const POS: Record<string, Position> = { C: 'C', LW: 'LW', RW: 'RW', D: 'D', G: 'G' };
const COUNTRY_TO_POOL: Record<string, string> = { DEU: 'GER', CHE: 'SUI', LVA: 'LAT' };
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

/**
 * Real prospects for the draft held after `season` (pick.season === season,
 * i.e. draft year season + 1). Returns none if the data is for another year.
 */
export function buildRealDraftClass(rng: Rng, season: number, existing: Iterable<Player>, nextId: () => number): Player[] {
  if (DATA.draftYear !== season + 1) return [];
  const known = new Set<string>();
  for (const p of existing) known.add(`${norm(p.first)}|${norm(p.last)}|${p.birthYear}`);
  const out: Player[] = [];
  for (const r of DATA.prospects) {
    if (!r.birthDate) continue;
    const birthYear = Number(r.birthDate.slice(0, 4));
    const key = `${norm(r.first)}|${norm(r.last)}|${birthYear}`;
    if (known.has(key)) continue;
    known.add(key);
    const pos = POS[r.pos] ?? 'C';
    const age = season - birthYear;
    const slot = r.boardRank ?? slotFor(r.category, r.rank, !!r.reentry);
    const pa = Math.round(clamp(182 - 9.6 * Math.log(Math.max(1, slot)) + rng.normal(0, 7), 95, 192));
    const frac = clamp(0.56 + (age - 18) * 0.05 + rng.normal(0, 0.03), 0.48, 0.8);
    const ca = Math.round(clamp(pa * frac, 45, pa));
    const poolCode = r.birthCountry ? (COUNTRY_TO_POOL[r.birthCountry] ?? r.birthCountry) : undefined;
    const nat = NAME_POOLS.find((n) => n.code === poolCode)?.code;
    const p = generatePlayer(rng, { id: nextId(), pos, targetCA: ca, age, season, pa, tier: clamp((pa - 120) / 60, 0, 1), nat });
    p.first = r.first;
    p.last = r.last;
    p.birthYear = birthYear;
    if (nat) p.nat = nat;
    if (r.shoots === 'L' || r.shoots === 'R') p.shoots = r.shoots;
    if (r.heightIn) p.heightCm = Math.round(r.heightIn * 2.54);
    if (r.weightLb) p.weightKg = Math.round(r.weightLb * 0.4536);
    p.ca = Math.min(p.ca, p.pa);
    p.status = 'draft';
    p.teamId = null;
    p.proSeasons = 0;
    p.junior = r.league ?? p.junior;
    p.amateurClub = r.club ?? undefined;
    if (r.boardRank) p.boardRank = r.boardRank;
    else p.csRank = { category: r.category, rank: r.rank };
    // A big-board ranking is public: the consensus follows it until Central Scouting publishes.
    p.reputation = r.boardRank ? Math.round(clamp(88 - r.boardRank * 0.6, 20, 88)) : Math.round(clamp((pa - 100) * 0.6, 1, 80));
    out.push(p);
  }
  return out;
}
