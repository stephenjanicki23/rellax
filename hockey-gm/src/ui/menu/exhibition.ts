/** Shared, unsaved league used by Play Now and Rosters (independent of any franchise save). */
import type { League } from '../../engine/types';
import { createLeague } from '../../engine/league/create';
import { teamGameInput } from '../../engine/league/gameInput';
import type { GameInput } from '../../engine/sim/gameTypes';
import { teamStrength } from '../../engine/team/strength';
import { clamp } from '../../engine/core/math';

export const EXHIBITION_SEED = 'phl-exhibition-rosters';
let cached: League | null = null;

export function exhibitionLeague(): League {
  if (!cached) cached = createLeague({ seed: EXHIBITION_SEED });
  return cached;
}

export function exhibitionInput(home: number, away: number, seed: number): GameInput {
  const l = exhibitionLeague();
  return {
    home: teamGameInput(l, l.teams[home], 0, false, 0),
    away: teamGameInput(l, l.teams[away], 0, false, 1),
    seed: `exhibition-${home}-${away}-${seed}`,
    playoff: false,
    recordEvents: true,
    regularSeasonOT: l.config.season.regularSeasonOT,
    ratingBaseline: l.ratingBaseline,
  };
}

/** Console-style 0–99 overall for a player ability (CA 0–200). */
export const playerOvr = (v: number): number => clamp(Math.round(v * 0.42 + 20), 1, 99);

/** Console-style team rating from roster strength (stretched so teams differ visibly). */
export const teamOvr = (v: number): number => clamp(Math.round(60 + (v - 125) * 1.2), 40, 99);

export function teamRatings(teamId: number): { ovr: number; off: number; def: number; g: number } {
  const s = teamStrength(exhibitionLeague(), teamId);
  return { ovr: teamOvr(s.overall), off: teamOvr(s.forwards), def: teamOvr(s.defense), g: teamOvr(s.goalie) };
}

const NUMBERS = [9, 10, 19, 27, 44, 87, 91, 97, 8, 71, 29, 13, 88, 16, 22];
export const heroNumber = (teamId: number): string => String(NUMBERS[(teamId * 7 + 3) % NUMBERS.length]);
