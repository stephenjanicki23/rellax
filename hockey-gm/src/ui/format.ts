import type { League, Phase, Player } from '../engine/types';
import { fmtMoney } from '../engine/economy/contracts';

export { fmtMoney };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Calendar date for a schedule day (season opens in early October). */
export function dateForDay(season: number, day: number): string {
  const d = new Date(Date.UTC(season, 9, 8));
  d.setUTCDate(d.getUTCDate() + day);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function shortDate(season: number, day: number): string {
  const d = new Date(Date.UTC(season, 9, 8));
  d.setUTCDate(d.getUTCDate() + day);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function seasonLabel(season: number): string {
  return `${season}–${String((season + 1) % 100).padStart(2, '0')}`;
}

export const PHASE_LABEL: Record<Phase, string> = {
  preseason: 'Preseason',
  regular: 'Regular Season',
  playoffs: 'Playoffs',
  draft: 'Entry Draft',
  resign: 'Re-signing Period',
  freeAgency: 'Free Agency',
};

export function leagueDate(league: League): string {
  if (league.phase === 'regular' || league.phase === 'playoffs') return dateForDay(league.season, league.day);
  if (league.phase === 'draft') return `June ${league.season + 1}`;
  if (league.phase === 'resign') return `Late June ${league.season + 1}`;
  if (league.phase === 'freeAgency') return `July ${league.faDay + 1}, ${league.season + 1}`;
  return `September ${league.season}`;
}

export const pct = (v: number, dp = 1): string => `${(v * 100).toFixed(dp)}%`;
export const sv = (v: number): string => (v ? v.toFixed(3).replace(/^0/, '') : '—');
export const num = (v: number, dp = 0): string => (Number.isFinite(v) ? v.toFixed(dp) : '—');
export const signed = (v: number, dp = 0): string => (v > 0 ? `+${v.toFixed(dp)}` : v.toFixed(dp));

export function ageOf(league: League, p: Player): number {
  return league.season - p.birthYear;
}

export function heightLabel(cm: number): string {
  const inches = Math.round(cm / 2.54);
  return `${Math.floor(inches / 12)}'${inches % 12}"`;
}

export function weightLabel(kg: number): string {
  return `${Math.round(kg * 2.2046)} lb`;
}
