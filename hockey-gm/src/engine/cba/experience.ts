/**
 * Player experience used by free agency, waivers and arbitration: NHL games,
 * accrued seasons and professional seasons. Built from the player's career
 * record plus pre-save history (imported or estimated at league creation).
 */
import type { League, Player } from '../types';
import { STATIC } from './rules';

/** NHL regular-season games (career + current season). */
export function nhlGames(p: Player, league?: Pick<League, 'seasonStats'>): number {
  let g = p.nhlGamesBefore ?? 0;
  for (const c of p.career) if (!c.playoffs) g += c.stats.gp;
  if (league) g += league.seasonStats[p.id]?.reg.gp ?? 0;
  return g;
}

/** NHL games per season from the career record (summed across teams). */
function gamesBySeason(p: Player): Map<number, number> {
  const m = new Map<number, number>();
  for (const c of p.career) if (!c.playoffs) m.set(c.season, (m.get(c.season) ?? 0) + c.stats.gp);
  return m;
}

/** NHL games in the given seasons (inclusive range). */
export function nhlGamesIn(p: Player, fromSeason: number, toSeason: number, league?: Pick<League, 'seasonStats' | 'season'>): number {
  let g = 0;
  for (const [s, n] of gamesBySeason(p)) if (s >= fromSeason && s <= toSeason) g += n;
  if (league && league.season >= fromSeason && league.season <= toSeason) g += league.seasonStats[p.id]?.reg.gp ?? 0;
  return g;
}

/**
 * Accrued seasons (CBA 10.1(c)): seasons with 40+ NHL regular-season games
 * (on the active or injured roster) at age 18 or older.
 */
export function accruedSeasons(p: Player): number {
  const need = STATIC().freeAgency.accruedSeasonGames;
  let n = p.accruedBefore ?? 0;
  for (const [season, gp] of gamesBySeason(p)) if (gp >= need && season - p.birthYear >= 18) n++;
  return n;
}

/** Professional seasons since the first NHL contract (NHL or minor-league). */
export function proSeasonsSinceSpc(p: Player, season: number): number {
  if (p.firstSpcSeason === undefined) return p.proSeasons;
  return Math.max(0, season - p.firstSpcSeason);
}

/** Age at first SPC, defaulting to a typical draftee profile. */
export function firstSpcAge(p: Player): number {
  return p.firstSpcAge ?? 20;
}
