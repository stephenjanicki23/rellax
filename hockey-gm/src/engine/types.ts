/**
 * Core domain types. Everything in a League is plain JSON-serialisable data so
 * the whole universe can be saved, loaded and diffed without custom codecs.
 */
import type { RngState } from './core/rng';

export type Position = 'C' | 'LW' | 'RW' | 'D' | 'G';
export type Hand = 'L' | 'R';

export const SKATING_ATTRS = ['speed', 'acceleration', 'agility', 'balance', 'edgework'] as const;
export const SHOOTING_ATTRS = [
  'wristPower',
  'wristAccuracy',
  'slapPower',
  'slapAccuracy',
  'oneTimer',
  'backhand',
  'shotSelection',
] as const;
export const PUCK_ATTRS = ['stickhandling', 'passing', 'puckControl', 'receiving', 'creativity'] as const;
export const IQ_ATTRS = [
  'offAwareness',
  'defAwareness',
  'positioning',
  'anticipation',
  'decisionMaking',
  'hockeySense',
] as const;
export const PHYSICAL_ATTRS = ['strength', 'bodyChecking', 'aggression', 'endurance'] as const;
export const DEFENSIVE_ATTRS = ['stickChecking', 'shotBlocking', 'defPositioning', 'faceoffs', 'backchecking'] as const;
export const MENTAL_ATTRS = ['composure', 'discipline', 'determination', 'leadership', 'consistency', 'clutch'] as const;
export const GOALIE_ATTRS = [
  'reflexes',
  'gPositioning',
  'reboundControl',
  'glove',
  'blocker',
  'athleticism',
  'puckHandling',
  'highDanger',
  'lateral',
] as const;

export const SKATER_ATTR_KEYS = [
  ...SKATING_ATTRS,
  ...SHOOTING_ATTRS,
  ...PUCK_ATTRS,
  ...IQ_ATTRS,
  ...PHYSICAL_ATTRS,
  ...DEFENSIVE_ATTRS,
] as const;

export const ALL_ATTR_KEYS = [...SKATER_ATTR_KEYS, ...MENTAL_ATTRS, ...GOALIE_ATTRS] as const;

export type AttrKey = (typeof ALL_ATTR_KEYS)[number];
export type Attributes = Record<AttrKey, number>;

export const ATTR_GROUPS: { label: string; keys: readonly AttrKey[] }[] = [
  { label: 'Skating', keys: SKATING_ATTRS },
  { label: 'Shooting', keys: SHOOTING_ATTRS },
  { label: 'Puck Skills', keys: PUCK_ATTRS },
  { label: 'Hockey IQ', keys: IQ_ATTRS },
  { label: 'Physical', keys: PHYSICAL_ATTRS },
  { label: 'Defensive', keys: DEFENSIVE_ATTRS },
  { label: 'Mental', keys: MENTAL_ATTRS },
];
export const GOALIE_ATTR_GROUPS: { label: string; keys: readonly AttrKey[] }[] = [
  { label: 'Goaltending', keys: GOALIE_ATTRS },
  { label: 'Mental', keys: MENTAL_ATTRS },
];

export type ArchetypeId =
  | 'sniper'
  | 'playmaker'
  | 'powerForward'
  | 'twoWayForward'
  | 'grinder'
  | 'enforcer'
  | 'defensiveForward'
  | 'offensiveDefenseman'
  | 'twoWayDefenseman'
  | 'stayAtHome'
  | 'puckMovingDefenseman'
  | 'physicalDefenseman'
  | 'butterflyGoalie'
  | 'hybridGoalie'
  | 'athleticGoalie';

export type DevCurve = 'early' | 'normal' | 'late' | 'plateau' | 'bust' | 'opportunity';

export type PersonalityId =
  | 'professional'
  | 'driven'
  | 'loyal'
  | 'ambitious'
  | 'teamPlayer'
  | 'quiet'
  | 'competitive'
  | 'difficult'
  | 'leader'
  | 'easygoing';

export type TraitId = 'injuryProne' | 'durable' | 'streaky' | 'bigGame' | 'fanFavorite' | 'lateBloomer';

export type InjurySeverity = 'minor' | 'moderate' | 'major' | 'severe';

export interface Injury {
  type: string;
  bodyPart: 'upper' | 'lower' | 'head' | 'other';
  severity: InjurySeverity;
  daysRemaining: number;
  totalDays: number;
  season: number;
  dayInjured: number;
}

export interface Contract {
  /** Annual salary in thousands of dollars. */
  salary: number;
  /** Seasons remaining including the current one. */
  years: number;
  type: 'ELC' | 'standard';
  ntc: boolean;
  signedSeason: number;
}

export interface StatLine {
  gp: number;
  g: number;
  a1: number;
  a2: number;
  pm: number;
  pim: number;
  sog: number;
  att: number; // individual shot attempts (iCF)
  missed: number;
  blockedAtt: number;
  hits: number;
  blocks: number;
  tk: number;
  gv: number;
  fow: number;
  fol: number;
  toi: number; // seconds
  toiES: number;
  toiPP: number;
  toiPK: number;
  ppg: number;
  ppa: number;
  shg: number;
  sha: number;
  gwg: number;
  ixg: number;
  ixa: number;
  cf: number; // on-ice attempts for / against
  ca: number;
  xgf: number;
  xga: number;
  // goalie
  gs: number;
  w: number;
  l: number;
  otl: number;
  sa: number;
  ga: number;
  so: number;
  gxga: number; // expected goals of shots on goal faced
  hdsa: number;
  hdga: number;
  reb: number;
  gtoi: number;
}

export interface CareerSeason {
  season: number;
  teamId: number;
  playoffs: boolean;
  stats: StatLine;
}

export interface PlayerAward {
  season: number;
  award: string;
}

export interface Player {
  id: number;
  first: string;
  last: string;
  birthYear: number;
  nat: string;
  pos: Position;
  shoots: Hand;
  heightCm: number;
  weightKg: number;
  number: number;
  archetype: ArchetypeId;
  attrs: Attributes;
  /** Current ability, 0-200. Derived from attributes. */
  ca: number;
  /** Potential ability ceiling, 0-200. Hidden from the user unless scouted. */
  pa: number;
  devCurve: DevCurve;
  personality: PersonalityId;
  traits: TraitId[];
  /** Hidden injury resistance 0-200. */
  durability: number;
  morale: number; // 0-100
  /** Slow-moving form/streak value in roughly [-1, 1]. */
  form: number;
  /** Goalie confidence [-1, 1]. */
  confidence: number;
  /** Season-long accumulated fatigue 0-100. */
  fatigue: number;
  injury: Injury | null;
  injuryHistory: { season: number; type: string; bodyPart: string; days: number }[];
  teamId: number | null;
  status: 'active' | 'prospect' | 'fa' | 'retired' | 'draft';
  contract: Contract | null;
  /** Unsigned draft rights or RFA rights held by this team. */
  rightsTeamId: number | null;
  draft: { season: number; round: number; pick: number; teamId: number } | null;
  career: CareerSeason[];
  awards: PlayerAward[];
  /** Public reputation 0-100 (league-wide perception). */
  reputation: number;
  /** Playoff reputation in roughly [-1, 1]. Small effect only. */
  playoffRep: number;
  proSeasons: number;
  retiredSeason?: number;
  junior?: string;
  /** Free-agency preferences, hidden. */
  prefs: { money: number; winning: number; role: number; location: number; loyalty: number };
  /** Ice-time expectation used for morale (minutes/game). */
  expectedToi: number;
  /** Rolling "games since last point" etc. for streaks. */
  streak: { points: number; goalless: number; bestPoints: number };
  /** Accumulated in-season development not yet applied (fractional CA). */
  devBank: number;
  /** Season-level ice time for development purposes (sum minutes). */
  seasonToiMin: number;
  /** Ratings snapshot at season start for "breakout" detection. */
  caSeasonStart: number;
}

export type OffenseStyle = 'cycle' | 'rush' | 'possession' | 'dumpChase' | 'balanced';
export type DefenseStyle = 'aggressive' | 'trap' | 'passive' | 'physical' | 'balanced';
export type Forecheck = '1-2-2' | '2-1-2' | '1-3-1';
export type PowerPlayStyle = 'umbrella' | 'overload' | 'shooting' | 'netFront';
export type PenaltyKillStyle = 'box' | 'diamond' | 'aggressive' | 'passive';
export type LineUsage = 'balanced' | 'topHeavy' | 'rollFour';

export interface Tactics {
  offense: OffenseStyle;
  defense: DefenseStyle;
  forecheck: Forecheck;
  pp: PowerPlayStyle;
  pk: PenaltyKillStyle;
  lineUsage: LineUsage;
  pullGoalie: 'conservative' | 'normal' | 'aggressive';
}

export interface Lines {
  /** 4 forward lines of [LW, C, RW]. */
  fwd: number[][];
  /** 3 defensive pairings [LD, RD]. */
  def: number[][];
  /** [starter, backup]. */
  goalies: number[];
  /** 2 power-play units of 5 skaters. */
  pp: number[][];
  /** 2 penalty-kill units of 4 skaters. */
  pk: number[][];
}

export type CoachPhilosophy = 'offensive' | 'defensive' | 'balanced' | 'development' | 'structured' | 'physical';

export interface CoachRatings {
  offense: number;
  defense: number;
  development: number;
  goaltending: number;
  motivation: number;
  tactics: number;
}

export interface Coach {
  id: number;
  first: string;
  last: string;
  birthYear: number;
  role: 'head' | 'assistant' | 'goalie';
  ratings: CoachRatings;
  philosophy: CoachPhilosophy;
  teamId: number | null;
  contract: { salary: number; years: number } | null;
  reputation: number; // 0-100
  career: { season: number; teamId: number; w: number; l: number; otl: number; playoffs: string }[];
  hiredSeason: number | null;
  retired?: boolean;
}

export interface Scout {
  id: number;
  first: string;
  last: string;
  /** Ability to judge current ability (0-200). */
  judgingAbility: number;
  /** Ability to judge potential (0-200). */
  judgingPotential: number;
  salary: number;
  assignment: ScoutAssignment;
}

export type ScoutAssignment =
  | { kind: 'draft' }
  | { kind: 'team'; teamId: number }
  | { kind: 'freeAgents' }
  | { kind: 'idle' };

export type TeamStrategy = 'contend' | 'balanced' | 'rebuild';
export type GmPhilosophy = 'winNow' | 'youth' | 'analytics' | 'oldSchool' | 'balanced';

export interface Team {
  id: number;
  abbr: string;
  city: string;
  name: string;
  arena: string;
  conferenceId: string;
  divisionId: string;
  colors: [string, string];
  marketSize: number; // 1-5
  /** Location attractiveness for free agents 0-1. */
  appeal: number;
  /** Internal payroll budget (thousands $). */
  budget: number;
  reputation: number; // 0-100
  facilities: number; // 0-200
  strategy: TeamStrategy;
  gm: { name: string; philosophy: GmPhilosophy; aggression: number };
  owner: string;
  staff: { headCoach: number | null; assistant: number | null; goalieCoach: number | null };
  lines: Lines;
  autoLines: boolean;
  tactics: Tactics;
  captain: number | null;
  alternates: number[];
  morale: number;
  /** Rivalry intensity with other teams (teamId -> 0..100). */
  rivals: Record<number, number>;
}

export interface DraftPick {
  id: number;
  season: number;
  round: number;
  originalTeamId: number;
  ownerId: number;
  /** Set once the draft order is known. */
  pickNumber?: number;
  playerId?: number;
}

export interface ScheduledGame {
  id: number;
  day: number;
  home: number;
  away: number;
  playoff?: { round: number; series: number; game: number };
  played: boolean;
  result?: GameSummary;
}

export interface GameSummary {
  hg: number;
  ag: number;
  ot: boolean;
  so: boolean;
  hs: number;
  as: number;
  hxg: number;
  axg: number;
  stars: number[];
  goals: { p: number; t: number; team: 0 | 1; s: number; a: number[]; str: 'EV' | 'PP' | 'SH' | 'EN' }[];
  hGoalie?: number;
  aGoalie?: number;
  hPP?: [number, number];
  aPP?: [number, number];
}

export interface TeamRecord {
  gp: number;
  w: number;
  l: number;
  otl: number;
  row: number; // regulation + OT wins
  rw: number;
  gf: number;
  ga: number;
  home: [number, number, number];
  away: [number, number, number];
  streak: number; // +W streak / -L streak
  last10: ('W' | 'L' | 'O')[];
  ppOpp: number;
  ppg: number;
  tsh: number; // times shorthanded
  ppga: number;
  sf: number;
  sa: number;
  xgf: number;
  xga: number;
  cf: number;
  ca: number;
  hits: number;
  blocks: number;
  fow: number;
  fol: number;
  tk: number;
  gv: number;
  pim: number;
}

export interface PlayoffSeries {
  id: number;
  round: number;
  conferenceId: string | null;
  high: number; // higher seed team id
  low: number;
  highSeed: number;
  lowSeed: number;
  wins: [number, number];
  winner: number | null;
  games: number[]; // scheduled game ids
}

export interface PlayoffBracket {
  season: number;
  rounds: PlayoffSeries[][];
  currentRound: number;
  champion: number | null;
}

export type NewsCategory =
  | 'game'
  | 'milestone'
  | 'injury'
  | 'trade'
  | 'signing'
  | 'rumor'
  | 'award'
  | 'coach'
  | 'draft'
  | 'record'
  | 'retirement'
  | 'streak'
  | 'league'
  | 'development';

export interface NewsItem {
  id: number;
  season: number;
  day: number;
  category: NewsCategory;
  headline: string;
  body?: string;
  teamIds: number[];
  playerIds: number[];
  importance: number; // 1-5
}

export interface Transaction {
  id: number;
  season: number;
  day: number;
  kind: 'trade' | 'signing' | 'release' | 'draft' | 'extension' | 'retirement' | 'callup' | 'senddown' | 'coach';
  teamIds: number[];
  playerIds: number[];
  pickIds?: number[];
  description: string;
}

export type Phase = 'preseason' | 'regular' | 'playoffs' | 'draft' | 'resign' | 'freeAgency';

export interface SeasonAwardResult {
  award: string;
  playerId?: number;
  coachId?: number;
  teamId: number;
  value?: string;
}

export interface SeasonHistory {
  season: number;
  champion: number | null;
  runnerUp: number | null;
  presidentsTrophy: number | null;
  awards: SeasonAwardResult[];
  standings: { teamId: number; w: number; l: number; otl: number; pts: number; gf: number; ga: number; playoff: string }[];
  leaders: { cat: string; playerId: number; value: number }[];
  firstOverall?: number;
}

export interface RecordEntry {
  key: string;
  label: string;
  value: number;
  playerId?: number;
  teamId?: number;
  season?: number;
  detail?: string;
}

export interface RecordBook {
  singleSeason: Record<string, RecordEntry>;
  career: Record<string, RecordEntry>;
  team: Record<string, RecordEntry>;
}

export interface FreeAgentOffer {
  playerId: number;
  teamId: number;
  salary: number;
  years: number;
  day: number;
  ntc: boolean;
}

export interface LeagueSettings {
  /** Show potential ratings without scouting (debug / casual). */
  godMode: boolean;
  injuryRate: number; // multiplier
  tradeDifficulty: number; // 0.5 easy .. 1.5 hard
}

export interface League {
  version: number;
  name: string;
  seed: string;
  rng: RngState;
  userTeamId: number;
  season: number;
  phase: Phase;
  day: number;
  config: import('./data/leagueConfig').LeagueConfig;
  settings: LeagueSettings;
  /** Current salary cap ceiling / floor (thousands $). */
  cap: { upper: number; floor: number; minSalary: number };
  teams: Team[];
  players: Record<number, Player>;
  coaches: Record<number, Coach>;
  scouts: Scout[];
  schedule: ScheduledGame[];
  tradeDeadlineDay: number;
  standings: Record<number, TeamRecord>;
  seasonStats: Record<number, { reg: StatLine; po: StatLine; teamId: number }>;
  playoffs: PlayoffBracket | null;
  draftPicks: DraftPick[];
  draftOrder: number[]; // pick ids in order for the current draft
  draftCombineDone: boolean;
  faOffers: FreeAgentOffer[];
  faDay: number;
  news: NewsItem[];
  transactions: Transaction[];
  history: SeasonHistory[];
  records: RecordBook;
  scouting: { knowledge: Record<number, number> };
  /** Shared ice time between teammates: "minId-maxId" -> seconds. */
  chemistry: Record<string, number>;
  nextId: { player: number; coach: number; news: number; game: number; tx: number; pick: number; scout: number };
  /** Per-team in-season performance memory used by AI GMs. */
  aiMemory: Record<number, { lastTradeDay: number; coachHotSeat: number }>;
}
