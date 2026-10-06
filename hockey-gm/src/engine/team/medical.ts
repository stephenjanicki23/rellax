/**
 * The medical staff and injury management: how fast players heal, setbacks,
 * playing through injuries, and resting veterans on back-to-backs.
 *
 * SIMPLIFICATION: the medical staff is a single 1-5 level paid from the
 * owner's staff budget; its effect sizes are game tuning.
 */
import { clamp } from '../core/math';
import { Rng, seedFrom } from '../core/rng';
import type { League, Player, Team } from '../types';
import { addNews } from '../league/helpers';
import { fullName } from '../player/ability';
import { injuryLabel } from '../player/injuries';

/** Annual cost of each medical staff level (thousands). */
export const MEDICAL_COST = [0, 600, 1100, 1700, 2400, 3200];
export const MEDICAL_LABEL = ['', 'Bare-bones', 'Basic', 'Solid', 'Excellent', 'Elite'];

export function medicalLevel(team: Team): number {
  return team.medicalLevel ?? clamp(2 + Math.round((team.marketSize - 1) / 2), 2, 4);
}

export function medicalCost(team: Team): number {
  return MEDICAL_COST[medicalLevel(team)];
}

/** Injury-risk multiplier from the medical staff (prevention, conditioning). */
export function medicalRisk(team: Team | undefined): number {
  return team ? 1.12 - 0.04 * medicalLevel(team) : 1;
}

/** Can this injury be played through? */
export function canPlayThrough(p: Player): string | null {
  const i = p.injury;
  if (!i) return 'He is not injured.';
  if (i.bodyPart === 'head') return 'Not with a head injury.';
  if (i.severity === 'major' || i.severity === 'severe') return 'The injury is too serious.';
  if (i.daysRemaining > 21) return 'He is too far from returning.';
  return null;
}

/** He plays hurt: back in the lineup, less effective, at more risk, healing at half speed. */
export function playThrough(_league: League, p: Player): { ok: boolean; message: string } {
  const no = canPlayThrough(p);
  if (no) return { ok: false, message: no };
  const i = p.injury!;
  p.playingHurt = { type: i.type, bodyPart: i.bodyPart, severity: i.severity, daysLeft: i.daysRemaining };
  p.injury = null;
  return { ok: true, message: `${fullName(p)} will play through the ${i.type.toLowerCase()}.` };
}

/** Shut a player who is playing hurt back down so the injury can heal properly. */
export function shutDown(league: League, p: Player): { ok: boolean; message: string } {
  const h = p.playingHurt;
  if (!h) return { ok: false, message: 'He is not playing hurt.' };
  const days = Math.max(1, Math.ceil(h.daysLeft));
  p.injury = { type: h.type, bodyPart: h.bodyPart, severity: h.severity, daysRemaining: days, totalDays: days, season: league.season, dayInjured: league.day };
  p.playingHurt = undefined;
  return { ok: true, message: `${fullName(p)} is shut down to let it heal (${days} day${days === 1 ? '' : 's'}).` };
}

/** Daily: heal (faster with better doctors), occasional setbacks, playing-hurt recovery. */
export function medicalDay(league: League): void {
  const rng = new Rng(seedFrom(league.seed, 'medical', league.season, league.day));
  for (const p of Object.values(league.players)) {
    if (p.status === 'retired' || p.status === 'draft') continue;
    if (p.playingHurt) {
      p.playingHurt.daysLeft -= 0.5;
      if (p.playingHurt.daysLeft <= 0) p.playingHurt = undefined;
    }
    const i = p.injury;
    if (!i) continue;
    const team = p.teamId !== null ? league.teams[p.teamId] : undefined;
    const level = team ? medicalLevel(team) : 2;
    let heal = 1;
    const edge = (level - 3) * 0.12;
    if (edge > 0 && rng.chance(edge)) heal = 2;
    if (edge < 0 && rng.chance(-edge)) heal = 0;
    i.daysRemaining -= heal;
    // Setbacks on longer injuries; good medical staff catch them early.
    if (i.severity !== 'minor' && i.daysRemaining > 3 && rng.chance(0.004 * (6 - level))) {
      const extra = rng.int(3, 10);
      i.daysRemaining += extra;
      i.totalDays += extra;
      i.setbacks = (i.setbacks ?? 0) + 1;
      if (p.teamId === league.userTeamId) addNews(league, { category: 'injury', headline: `Setback for ${fullName(p)}: ${injuryLabel(i)}`, body: `He will miss about ${extra} more days.`, teamIds: [p.teamId], playerIds: [p.id], importance: 2 });
    }
    if (i.daysRemaining <= 0) p.injury = null;
  }
}

/** Expected return window in days (wider with a weaker medical staff). */
export function returnWindow(team: Team, p: Player): [number, number] {
  const d = p.injury?.daysRemaining ?? 0;
  const spread = Math.round(d * (0.05 * (6 - medicalLevel(team))));
  return [Math.max(0, d - spread), d + spread];
}

/** Players rested on the second night of back-to-backs (the user's club). */
export function restedTonight(league: League, team: Team, playedYesterday: boolean): Set<number> {
  if (team.id !== league.userTeamId || !playedYesterday) return new Set();
  return new Set(Object.values(league.players).filter((p) => p.teamId === team.id && p.loadManaged).map((p) => p.id));
}

export function setMedicalLevel(league: League, level: number): { ok: boolean; message: string } {
  const team = league.teams[league.userTeamId];
  if (level < 1 || level > 5) return { ok: false, message: 'Pick a level from 1 to 5.' };
  team.medicalLevel = level;
  return { ok: true, message: `Medical staff set to ${MEDICAL_LABEL[level].toLowerCase()} (${(MEDICAL_COST[level] / 1000).toFixed(1)}M a season).` };
}

/** Man-games lost to injury this season by the club's players. */
export function manGamesLost(league: League, teamId: number): number {
  return Object.values(league.players)
    .filter((p) => p.teamId === teamId)
    .reduce((s, p) => s + p.injuryHistory.filter((h) => h.season === league.season).reduce((a, h) => a + h.days, 0), 0);
}
