import type { ArchetypeId, Attributes, CoachRatings, Lines, Position, StatLine, Tactics } from '../types';
import type { RolledInjury } from '../player/injuries';

/** Everything the game engine needs to know about one player. */
export interface GamePlayerInput {
  id: number;
  first: string;
  last: string;
  /** Jersey number (presentation only). */
  number?: number;
  pos: Position;
  archetype: ArchetypeId;
  attrs: Attributes;
  age: number;
  /** Starting energy cap 0-100 (season fatigue, back-to-backs, travel). */
  energy: number;
  /** Season form/streak [-1, 1]. */
  form: number;
  morale: number;
  /** Goalie confidence [-1, 1]. */
  confidence: number;
  /** Multiplier on injury probability. */
  injuryRisk: number;
  /** Severity shift for any injury rolled. */
  injurySeverity: number;
  streaky: boolean;
  /** Playoff reputation [-1, 1]; tiny effect in playoff games. */
  playoffRep: number;
}

export interface GameTeamInput {
  teamId: number;
  abbr: string;
  name: string;
  players: GamePlayerInput[];
  lines: Lines;
  tactics: Tactics;
  coach: CoachRatings | null;
  /** Pairwise chemistry in [-1, 1] between two player ids. */
  chemistry?: (a: number, b: number) => number;
  morale: number;
  /** Team fit of the current tactics per area (−1..1); omitted = neutral. */
  fit?: { offense: number; defense: number; forecheck: number; pp: number; pk: number };
  /** System familiarity per area (0..1); omitted = fully familiar. */
  familiarity?: { offense: number; defense: number; forecheck: number; pp: number; pk: number };
}

export interface GameInput {
  home: GameTeamInput;
  away: GameTeamInput;
  seed: number | string;
  playoff: boolean;
  /** Keep a full structured event log (needed for live play-by-play). */
  recordEvents: boolean;
  regularSeasonOT?: { minutes: number; skaters: number; shootout: boolean };
  /** Disable home-ice advantage (neutral site / testing). */
  neutral?: boolean;
  /**
   * Rating that counts as "average" for the engine (default 120). The league
   * sets this from its current talent level so scoring stays stable even if
   * ratings drift over decades.
   */
  ratingBaseline?: number;
}

export type GameEventType =
  | 'periodStart'
  | 'periodEnd'
  | 'faceoff'
  | 'breakout'
  | 'entry'
  | 'dumpIn'
  | 'battle'
  | 'pass'
  | 'shot'
  | 'blocked'
  | 'missed'
  | 'save'
  | 'rebound'
  | 'freeze'
  | 'goal'
  | 'hit'
  | 'takeaway'
  | 'giveaway'
  | 'icing'
  | 'offside'
  | 'penalty'
  | 'ppEnd'
  | 'injury'
  | 'lineChange'
  | 'goaliePulled'
  | 'goalieReturn'
  | 'goalieChange'
  | 'fight'
  | 'clear'
  | 'shootout'
  | 'gameEnd';

export interface GameEvent {
  /** Absolute game seconds elapsed. */
  t: number;
  period: number;
  /** Seconds elapsed within the period. */
  clock: number;
  type: GameEventType;
  team: 0 | 1;
  p1?: number;
  p2?: number;
  p3?: number;
  data?: {
    xg?: number;
    dist?: number;
    shotType?: string;
    danger?: 'high' | 'medium' | 'low';
    zone?: 'D' | 'N' | 'O';
    penalty?: string;
    minutes?: number;
    strength?: string;
    severity?: string;
    injury?: string;
    success?: boolean;
    assists?: number[];
    score?: [number, number];
    rush?: boolean;
    oddMan?: boolean;
    rebound?: boolean;
    unit?: string;
    big?: boolean;
    en?: boolean;
    round?: number;
  };
}

export interface TeamGameStats {
  goals: number;
  shots: number;
  attempts: number;
  missed: number;
  blockedAtt: number;
  hits: number;
  blocks: number;
  tk: number;
  gv: number;
  fow: number;
  fol: number;
  ppOpp: number;
  ppg: number;
  shg: number;
  pim: number;
  xg: number;
  hdShots: number;
  shotsByPeriod: number[];
  goalsByPeriod: number[];
  ozTime: number;
  possTime: number;
}

export interface GoalRecord {
  team: 0 | 1;
  period: number;
  clock: number;
  scorer: number;
  assists: number[];
  strength: 'EV' | 'PP' | 'SH' | 'EN';
  xg: number;
  shotType: string;
}

export interface PenaltyRecord {
  team: 0 | 1;
  period: number;
  clock: number;
  player: number;
  infraction: string;
  minutes: number;
}

export interface InjuryRecord {
  team: 0 | 1;
  playerId: number;
  period: number;
  clock: number;
  cause: string;
  injury: RolledInjury;
  leftGame: boolean;
}

export interface PlayerGameLine extends StatLine {
  team: 0 | 1;
}

export interface GameResult {
  homeGoals: number;
  awayGoals: number;
  ot: boolean;
  so: boolean;
  periods: number;
  teams: [TeamGameStats, TeamGameStats];
  players: Record<number, PlayerGameLine>;
  goals: GoalRecord[];
  penalties: PenaltyRecord[];
  injuries: InjuryRecord[];
  stars: number[];
  winningGoalie: number | null;
  losingGoalie: number | null;
  gwg: number | null;
  /** Shared ice time among teammates, key "minId-maxId" -> seconds. */
  pairToi: Record<string, number>;
  /** Per-goalie saves etc. are in players; list of goalies who appeared. */
  goaliesUsed: number[];
  shootout: { team: 0 | 1; shooter: number; goalie: number; scored: boolean }[];
  events: GameEvent[];
}

export interface GameSnapshot {
  period: number;
  clock: number;
  periodLength: number;
  score: [number, number];
  shots: [number, number];
  attempts: [number, number];
  xg: [number, number];
  hits: [number, number];
  fow: [number, number];
  possession: 0 | 1;
  zone: 'D' | 'N' | 'O';
  onIce: [number[], number[]];
  goalies: [number | null, number | null];
  strength: [number, number];
  ppTimeLeft: [number, number];
  momentum: number;
  possTime: [number, number];
  finished: boolean;
  inShootout: boolean;
  energy: Record<number, number>;
  lineIdx: [number, number];
  /** Running team box-score totals (presentation copy). */
  teamStats: [TeamGameStats, TeamGameStats];
  /** Players currently serving penalties. */
  box: { team: 0 | 1; player: number; remaining: number; minutes: number; coincidental: boolean }[];
}
