import type { PersonalityId, TraitId } from '../types';

/**
 * Personality effects are deliberately subtle multipliers/offsets. They nudge
 * careers rather than define them.
 */
export interface PersonalityDef {
  id: PersonalityId;
  label: string;
  description: string;
  weight: number;
  /** Development speed multiplier. */
  dev: number;
  /** How strongly morale swings (1 = normal). */
  moraleVolatility: number;
  /** Chemistry contribution with teammates [-0.3, 0.3]. */
  chemistry: number;
  /** Shift to typical retirement age in years. */
  retirement: number;
  /** FA preference weights (multipliers on base preferences). */
  money: number;
  winning: number;
  loyalty: number;
  role: number;
  /** Propensity to request a trade when unhappy. */
  tradeRequest: number;
  /** Mental attribute nudges at generation. */
  mental: Partial<Record<'composure' | 'discipline' | 'determination' | 'leadership' | 'consistency' | 'clutch', number>>;
}

export const PERSONALITIES: Record<PersonalityId, PersonalityDef> = {
  professional: {
    id: 'professional', label: 'Professional', description: 'Model pro. Prepares meticulously and rarely causes problems.',
    weight: 14, dev: 1.08, moraleVolatility: 0.7, chemistry: 0.1, retirement: 1, money: 1, winning: 1.05, loyalty: 1, role: 1,
    tradeRequest: 0.4, mental: { discipline: 18, consistency: 14, determination: 10, composure: 8 },
  },
  driven: {
    id: 'driven', label: 'Driven', description: 'Relentless work ethic and a hunger to improve.',
    weight: 12, dev: 1.12, moraleVolatility: 1, chemistry: 0.05, retirement: 0.5, money: 0.95, winning: 1.2, loyalty: 0.95, role: 1.15,
    tradeRequest: 0.9, mental: { determination: 24, consistency: 6 },
  },
  loyal: {
    id: 'loyal', label: 'Loyal', description: 'Values stability and sticking with his club.',
    weight: 10, dev: 1, moraleVolatility: 0.8, chemistry: 0.12, retirement: 0.5, money: 0.85, winning: 0.95, loyalty: 1.9, role: 0.9,
    tradeRequest: 0.3, mental: { determination: 6, leadership: 6 },
  },
  ambitious: {
    id: 'ambitious', label: 'Ambitious', description: 'Wants a big role, big money and the spotlight.',
    weight: 10, dev: 1.04, moraleVolatility: 1.25, chemistry: -0.05, retirement: 0, money: 1.3, winning: 1.1, loyalty: 0.6, role: 1.35,
    tradeRequest: 1.5, mental: { determination: 10, composure: 4 },
  },
  teamPlayer: {
    id: 'teamPlayer', label: 'Team Player', description: 'Puts the group first; accepts any role.',
    weight: 12, dev: 1, moraleVolatility: 0.75, chemistry: 0.22, retirement: 0, money: 0.9, winning: 1.1, loyalty: 1.2, role: 0.7,
    tradeRequest: 0.4, mental: { discipline: 8, leadership: 4 },
  },
  quiet: {
    id: 'quiet', label: 'Quiet', description: 'Keeps to himself. Low maintenance, low influence.',
    weight: 11, dev: 0.98, moraleVolatility: 0.85, chemistry: 0, retirement: 0, money: 1, winning: 1, loyalty: 1, role: 0.9,
    tradeRequest: 0.6, mental: { leadership: -18, composure: 4 },
  },
  competitive: {
    id: 'competitive', label: 'Competitive', description: 'Hates losing. Raises his game in big moments.',
    weight: 11, dev: 1.05, moraleVolatility: 1.15, chemistry: 0.04, retirement: 0.5, money: 1, winning: 1.35, loyalty: 0.9, role: 1.1,
    tradeRequest: 1.0, mental: { clutch: 14, determination: 12 },
  },
  difficult: {
    id: 'difficult', label: 'Difficult', description: 'Talented but high maintenance. Can disrupt a room.',
    weight: 5, dev: 0.93, moraleVolatility: 1.5, chemistry: -0.25, retirement: -1, money: 1.25, winning: 0.9, loyalty: 0.5, role: 1.3,
    tradeRequest: 2.2, mental: { discipline: -20, consistency: -12, leadership: -14 },
  },
  leader: {
    id: 'leader', label: 'Leader', description: 'Natural captain. Elevates the room and the youngsters.',
    weight: 7, dev: 1.03, moraleVolatility: 0.7, chemistry: 0.25, retirement: 1, money: 0.95, winning: 1.2, loyalty: 1.3, role: 1,
    tradeRequest: 0.4, mental: { leadership: 34, composure: 12, determination: 8 },
  },
  easygoing: {
    id: 'easygoing', label: 'Easygoing', description: 'Relaxed and likeable, if not the hardest worker.',
    weight: 8, dev: 0.94, moraleVolatility: 0.6, chemistry: 0.12, retirement: -0.5, money: 1, winning: 0.9, loyalty: 1.1, role: 0.85,
    tradeRequest: 0.5, mental: { determination: -14, composure: 8 },
  },
};

export const TRAITS: Record<TraitId, { label: string; description: string }> = {
  injuryProne: { label: 'Injury Prone', description: 'Picks up knocks more often than most.' },
  durable: { label: 'Durable', description: 'Rarely misses games.' },
  streaky: { label: 'Streaky', description: 'Prone to hot and cold spells.' },
  bigGame: { label: 'Big-Game Player', description: 'Has a reputation for stepping up in the playoffs.' },
  fanFavorite: { label: 'Fan Favourite', description: 'Beloved by the home crowd.' },
  lateBloomer: { label: 'Late Bloomer', description: 'Scouts expect him to take longer to develop.' },
};
