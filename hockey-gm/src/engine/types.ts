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

export interface MoraleParts {
  role: number;
  winning: number;
  contract: number;
  promises: number;
  coach: number;
  room: number;
}

export type PromiseKind = 'role' | 'pp' | 'noTrade' | 'extension';

export interface PlayerPromise {
  kind: PromiseKind;
  season: number;
  day: number;
  /** Schedule day by which it must be honoured (end of the regular season for season-long promises). */
  dueDay: number;
  /** Weekly checks honoured / total (role and power-play promises). */
  ok: number;
  total: number;
  status: 'open' | 'kept' | 'broken';
  /** Role tier a "bigger role" promise commits to. */
  tier?: number;
}

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

/** One league year of a contract (money in thousands of dollars). */
export interface ContractYear {
  season: number;
  /** NHL base salary paid this season. */
  salary: number;
  /** Signing bonus paid this season (counts toward the cap hit). */
  signingBonus: number;
  /** Maximum performance bonuses achievable this season (ELC / 35+ / eligible one-year deals). */
  perfBonus: number;
  /** Minor-league salary on a two-way deal. */
  minorSalary?: number;
}

export type ClauseKind = 'NMC' | 'NTC' | 'M-NTC';

export interface ContractClause {
  kind: ClauseKind;
  /** First and last season the clause is in force. */
  from: number;
  to: number;
  /** Modified NTC: number of teams on the player's list. */
  teams?: number;
  /** 'block' = list of teams he can refuse; 'approve' = list he would accept. */
  mode?: 'block' | 'approve';
}

/** Salary retained by a former team in a trade. */
export interface RetainedSalary {
  teamId: number;
  /** Share of cap hit and salary retained (0..0.5). */
  pct: number;
  season: number;
}

/**
 * A Standard Player Contract. Year-by-year money is the source of truth; the
 * flat fields (salary, years, ntc) are kept in sync for convenience and mean
 * "this player's cap hit to his current team", "seasons remaining" and "any
 * movement protection this season".
 */
export interface Contract {
  /** Cap hit to the current team this season after retention (thousands). */
  salary: number;
  /** Seasons remaining, including the current one. */
  years: number;
  type: 'ELC' | 'standard';
  /** Any trade/movement protection in force this season (NTC, M-NTC or NMC). */
  ntc: boolean;
  signedSeason: number;
  /** Extension signed during the final year; takes effect next season. */
  next?: Contract;
  // ── full contract ──
  id?: number;
  startSeason?: number;
  endSeason?: number;
  yearsDetail?: ContractYear[];
  twoWay?: boolean;
  clauses?: ContractClause[];
  signingTeamId?: number | null;
  signedDay?: number;
  /** Signed at 35+ (as of June 30 before year one) on a multi-year deal (cap hit stays if he retires; no buried relief). */
  thirtyFivePlus?: boolean;
  retained?: RetainedSalary[];
  /** Where the terms come from. */
  source?: 'real' | 'estimated' | 'game';
  /** How it was obtained (signing, extension, arbitration, offer sheet, qualifying offer, ELC). */
  origin?: 'signing' | 'extension' | 'arbitration' | 'offerSheet' | 'qualifyingOffer' | 'elc' | 'import';
  /** Free-agent status the player is projected to have when this contract expires. */
  expiryStatus?: 'RFA' | 'UFA';
  /** ELC seasons slid (18/19-year-olds who played fewer than 10 NHL games). */
  slid?: number;
  /** Official cap hit from imported data (excluding performance bonuses); overrides the computed AAV. */
  capHitOverride?: number;
  /** Signing date as published (imported contracts). */
  signingDate?: string;
}

/** Past contracts shown on the player profile. */
export interface ContractHistoryEntry {
  teamId: number | null;
  signingTeamId: number | null;
  startSeason: number;
  endSeason: number;
  years: number;
  totalValue: number;
  aav: number;
  type: 'ELC' | 'standard';
  origin?: Contract['origin'];
  source?: Contract['source'];
  note?: string;
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
  /** Real-world NHL player id when imported from the roster snapshot. */
  nhlId?: number;
  /** Age (as of Sept 15) when he signed his first NHL contract; drives ELC, waiver and arbitration rules. */
  firstSpcAge?: number;
  /** Season his first NHL contract started. */
  firstSpcSeason?: number;
  /** Contract history (newest last). */
  contractHistory?: ContractHistoryEntry[];
  /** NHL regular-season games and accrued seasons from before this save's history (imported/estimated). */
  nhlGamesBefore?: number;
  accruedBefore?: number;
  /** Restricted free agent whose rights are held (status 'fa' with rightsTeamId set). */
  rfa?: boolean;
  /** Placed on long-term injured reserve. */
  ltir?: boolean;
  /** Official headshot URL for real players. */
  headshot?: string;
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
  /** What drives his morale right now (the latest weekly target, by factor). */
  moraleParts?: MoraleParts;
  /** Faith in the GM's word, 0-100 (promises kept and broken). */
  trust?: number;
  /** Promises the GM has made him. */
  promises?: PlayerPromise[];
  /** An open trade request (private to the GM until it goes public). */
  tradeRequest?: { season: number; day: number; reason: string; public: boolean; since: number };
  /** Consecutive weeks of low morale. */
  unhappyWeeks?: number;
  /** Last one-on-one meeting with the GM, and how many this season. */
  meetings?: { season: number; day: number; count: number };
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
  /** Draft prospect: last amateur club and NHL Central Scouting list rank (real prospects). */
  amateurClub?: string;
  csRank?: { category: CsCategory; rank: number };
  /** Rank on an imported public big board (real prospects). */
  boardRank?: number;
  /** Signed to an AHL contract with the club's affiliate (no NHL contract; must sign one to be called up). */
  ahlContract?: boolean;
  /** AHL seasons (kept apart from NHL career totals). */
  ahlCareer?: { season: number; team: string; stats: AhlLine }[];
  /** Agent representing him (see cba/agents). */
  agentId?: number;
  /** Restricted free agent refusing his qualifying offer (sits out until he signs). */
  holdout?: { season: number; sinceDay: number };
  draft: { season: number; round: number; pick: number; teamId: number } | null;
  /**
   * Unsigned draft pick (status 'prospect', no contract, rightsTeamId set):
   * the team holds his rights until the offseason of this season, when they
   * lapse unless he signs (CBA 8.6).
   */
  signBySeason?: number;
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
  /** [season, CA at season end] pairs for development charts. */
  caHistory: [number, number][];
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
  /** Power play and penalty kill design. */
  specialTeams: number;
  /** How disciplined his teams are (fewer penalties). */
  discipline: number;
}

/** One coaching stint in a season (head coaches carry a record). */
export interface CoachSeasonLine {
  season: number;
  /** League team id (null for real history with a franchise no longer in the league). */
  teamId: number | null;
  /** Team abbreviation, for real NHL history imported from the feed. */
  team?: string;
  role?: 'head' | 'assistant' | 'goalie';
  gp?: number;
  w: number;
  l: number;
  /** Ties (NHL before 2005-06). */
  t?: number;
  otl: number;
  pw?: number;
  pl?: number;
  playoffs: string;
  cup?: boolean;
  /** Came from the real NHL record (before this save began). */
  real?: boolean;
  interim?: boolean;
}

/** Current-season tally for a head coach's stint with his team. */
export interface CoachStint {
  season: number;
  teamId: number;
  gp: number;
  w: number;
  l: number;
  otl: number;
  pw: number;
  pl: number;
  interim?: boolean;
}

export interface Coach {
  id: number;
  first: string;
  last: string;
  birthYear: number;
  role: 'head' | 'assistant' | 'goalie';
  ratings: CoachRatings;
  philosophy: CoachPhilosophy;
  /** Signature system: preferred options that override the philosophy's defaults. */
  system?: Partial<Tactics>;
  /** Short description of the coach's style. */
  styleNote?: string;
  teamId: number | null;
  contract: { salary: number; years: number } | null;
  reputation: number; // 0-100
  career: CoachSeasonLine[];
  hiredSeason: number | null;
  retired?: boolean;
  /** Where he comes from (e.g. "Former NHL head coach", "AHL head coach"). */
  background?: string;
  /** Real NHL head coach (record imported from the NHL feed). */
  real?: boolean;
  /** False when the birth year is only estimated (age is not shown). */
  birthKnown?: boolean;
  /** Head-coaching stints this season (a mid-season change starts a new one). */
  stints?: CoachStint[];
  /** Coaching honours (Jack Adams, Stanley Cups) — real ones are imported. */
  awards?: { season: number; award: string }[];
  /** Interim head coach (promoted from the bench after a firing). */
  interim?: boolean;
  /** Seasons until he will talk to a club that fired him. */
  grudge?: Record<number, number>;
}

/** Salary still owed to a coach who was let go (thousands, per season). */
export interface DeadStaffMoney {
  coachId: number;
  name: string;
  salary: number;
  /** Last season (inclusive) the club pays him. */
  throughSeason: number;
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
  | { kind: 'draft'; region?: 'NA' | 'EU' }
  | { kind: 'team'; teamId: number }
  | { kind: 'freeAgents' }
  | { kind: 'idle' };

export type TeamStrategy = 'contend' | 'balanced' | 'rebuild';
export type GmPhilosophy = 'winNow' | 'youth' | 'analytics' | 'oldSchool' | 'balanced';

export interface Team {
  id: number;
  abbr: string;
  /** Official logo URL (real NHL teams); generated crest otherwise. */
  logo?: string;
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
  /** System familiarity per tactical area (0..1). */
  familiarity?: { offense: number; defense: number; forecheck: number; pp: number; pk: number };
  /** Tactics the familiarity was built in (to detect system changes). */
  famTactics?: Tactics;
  owner: string;
  staff: { headCoach: number | null; assistant: number | null; goalieCoach: number | null };
  /** Coaches the club fired but is still paying. */
  deadStaff?: DeadStaffMoney[];
  lines: Lines;
  autoLines: boolean;
  tactics: Tactics;
  captain: number | null;
  alternates: number[];
  morale: number;
  /** Rivalry intensity with other teams (teamId -> 0..100). */
  rivals: Record<number, number>;
  /** Players the team is openly shopping (the user's trade block). */
  tradeBlock?: number[];
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
  /** Conditions attached when the pick was traded (real data), e.g. "Top-10 protected". */
  conditions?: string[];
  /** Protected if it lands in the top N: it then stays with the original team (see draft.ts). */
  protectedTop?: number;
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
  roundStartDay: number;
  /** Playoff qualifiers with their seed label per conference. */
  seeds: { teamId: number; seed: number; label: string; conferenceId: string }[];
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
  | 'development'
  | 'room';

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
  kind:
    | 'trade'
    | 'signing'
    | 'release'
    | 'draft'
    | 'extension'
    | 'retirement'
    | 'callup'
    | 'senddown'
    | 'coach'
    | 'waiverClaim'
    | 'waiverClear'
    | 'waivers'
    | 'buyout'
    | 'ltir'
    | 'ltirActivate'
    | 'termination'
    | 'offerSheet'
    | 'arbitration'
    | 'qualifyingOffer'
    | 'elc';
  teamIds: number[];
  playerIds: number[];
  pickIds?: number[];
  description: string;
}

export type Phase = 'preseason' | 'regular' | 'playoffs' | 'draft' | 'resign' | 'freeAgency';

/** A non-player cap charge on a team's books (dead cap). */
export interface CapCharge {
  id: number;
  teamId: number;
  season: number;
  /** Cap charge in thousands. */
  amount: number;
  kind: 'buyout' | 'bonusOverage' | 'thirtyFivePlus' | 'termination' | 'recapture' | 'other';
  playerId?: number;
  playerName: string;
  note?: string;
}

/** A player on long-term injured reserve (relief fixed at placement). */
export interface LtirEntry {
  playerId: number;
  teamId: number;
  season: number;
  day: number;
  /** Cap relief available while he is on LTIR (thousands). */
  relief: number;
  capHit: number;
  /** Expected to miss the regular season and playoffs (full relief) vs. return this season (capped). */
  seasonEnding: boolean;
}

export interface WaiverEntry {
  playerId: number;
  fromTeamId: number;
  season: number;
  day: number;
  /** Teams that put in a claim. */
  claims: number[];
  reason: 'assignment' | 'release' | 'other';
  status?: 'pending' | 'claimed' | 'cleared';
  claimedBy?: number | null;
}

export interface QualifyingOfferRecord {
  playerId: number;
  teamId: number;
  season: number;
  previousSalary: number;
  previousAav: number;
  amount: number;
  oneWay: boolean;
  /** Why the amount is what it is (shown to the GM). */
  explanation: string;
  status: 'required' | 'submitted' | 'notSubmitted' | 'accepted' | 'rejected' | 'expired';
  arbitrationEligible: boolean;
}

export interface ArbitrationCase {
  playerId: number;
  teamId: number;
  season: number;
  electedBy: 'player' | 'club';
  playerAsk: number;
  clubOffer: number;
  /** Term (club elections may choose 1 or 2 years). */
  years: number;
  hearingDay: number;
  award?: number;
  comparables?: { playerId: number; name: string; aav: number }[];
  status: 'filed' | 'settled' | 'awarded' | 'walkedAway';
  reasoning?: string;
}

export interface OfferSheet {
  id: number;
  playerId: number;
  fromTeamId: number;
  rightsTeamId: number;
  season: number;
  day: number;
  aav: number;
  years: number;
  salaries: number[];
  /** Compensation AAV (total / min(years, 5)). */
  compAav: number;
  compensation: string[];
  status: 'pending' | 'matched' | 'declined' | 'withdrawn';
  decisionDay: number;
}

/** Central Scouting lists: North American / International skaters and goalies. */
export type CsCategory = 'NA-S' | 'INT-S' | 'NA-G' | 'INT-G';

/** In-game Central Scouting rankings for the upcoming draft (midterm in January, final in April). */
export interface CsRankings {
  season: number;
  stage: 'midterm' | 'final';
  lists: Record<CsCategory, number[]>;
}

/** A season line in the AHL (compact: skater and goalie fields). */
export interface AhlLine {
  gp: number;
  g: number;
  a: number;
  sog: number;
  pim: number;
  pm: number;
  /** Goalies. */
  gs: number;
  sa: number;
  ga: number;
  w: number;
  l: number;
  otl: number;
  so: number;
}

export interface AhlTeamRecord {
  /** NHL parent club. */
  nhlTeamId: number;
  abbrev: string;
  name: string;
  gp: number;
  w: number;
  l: number;
  otl: number;
  gf: number;
  ga: number;
}

/** The AHL season: affiliates, standings, player lines and the Calder Cup. */
export interface AhlState {
  season: number;
  teams: AhlTeamRecord[];
  stats: Record<number, AhlLine & { team: string }>;
  champion: number | null;
}

export type AgentStyle = 'hardball' | 'fair' | 'friendly' | 'media';

export interface Agent {
  id: number;
  name: string;
  agency: string;
  style: AgentStyle;
  /** One of the big agencies (represents more stars). */
  power: boolean;
}

/** Where a player stands going into talks. */
export type NegotiationStance = 'open' | 'contenderOnly' | 'testMarket';

export interface ContractAsk {
  aav: number;
  years: number;
  /** Trade protection he wants (null = none). */
  clause?: ClauseKind | null;
  /** Share of each season's pay he wants as a signing bonus (0..0.8). */
  bonusShare?: number;
}

export interface NegotiationState {
  playerId: number;
  teamId: number;
  season: number;
  /** 0..100: how much more haggling the player tolerates. */
  patience: number;
  lastOffer?: ContractAsk;
  demand: ContractAsk;
  stance?: NegotiationStance;
  history: (ContractAsk & { response: string })[];
}

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
  /** Trade protection offered (newer saves; `ntc` kept for older ones). */
  clause?: ClauseKind | null;
}

export interface LeagueSettings {
  /** Show potential ratings without scouting (debug / casual). */
  godMode: boolean;
  injuryRate: number; // multiplier
  tradeDifficulty: number; // 0.5 easy .. 1.5 hard
  /** Let the AI run the user's team too (holiday mode / validation runs). */
  autoManageUser: boolean;
  /** The owner can fire the GM (off: play on regardless of results). */
  canBeFired?: boolean;
}

export type OwnerPriority = 'winNow' | 'patient' | 'frugal' | 'youth';

export interface OwnerGoal {
  kind: 'playoffs' | 'round' | 'points' | 'improve' | 'division' | 'youth' | 'budget';
  label: string;
  target: number;
  weight: number;
}

/** The user's employer: goals for the season, job security and the GM's career. */
export interface OwnerState {
  teamId: number;
  name: string;
  priority: OwnerPriority;
  /** 0-100: how slowly the owner loses faith. */
  patience: number;
  /** 0-100 job security. */
  security: number;
  /** Security when this season's goals were set (bounds in-season swings). */
  seasonStart?: number;
  /** Season the goals are for. */
  season: number;
  goals: OwnerGoal[];
  history: { season: number; teamId: number; grade: string; security: number; change: number; summary: string; record: string }[];
  messages: { season: number; day: number; text: string; tone: 'good' | 'bad' | 'neutral' }[];
  hiredSeason: number;
  /** Previous jobs. */
  career: { teamId: number; from: number; to: number; seasons: number; record: string; cups: number }[];
  warned?: boolean;
  fired?: { season: number; day: number; reason: string; offers: number[] };
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
  scouting: {
    knowledge: Record<number, number>;
    /** Prospects the user has interviewed at the combine (playerId -> season). */
    interviewed?: Record<number, number>;
    /** The user's draft shortlist, in order. */
    shortlist?: number[];
    /** Central Scouting rankings for the upcoming draft. */
    central?: CsRankings | null;
  };
  /** Shared ice time between teammates: "minId-maxId" -> seconds. */
  chemistry: Record<string, number>;
  nextId: { player: number; coach: number; news: number; game: number; tx: number; pick: number; scout: number };
  /** Engine rating baseline (see GameInput.ratingBaseline). */
  ratingBaseline: number;
  /** Preseason projected points per team (for expectations / coach of the year). */
  projections: Record<number, number>;
  /** The user's owner (goals and job security). */
  owner?: OwnerState;
  /** Per-team in-season performance memory used by AI GMs. */
  aiMemory: Record<number, { lastTradeDay: number; coachHotSeat: number; /** Rejected user proposals today (GM patience). */ talks?: { season: number; day: number; rejected: number } }>;
  /** Trade proposals CPU teams have made to the user (from = CPU team). */
  tradeOffers: { id: number; from: number; give: { kind: 'player' | 'pick'; id: number }[]; get: { kind: 'player' | 'pick'; id: number }[]; day: number; season: number; note: string }[];
  // ── NHL contract & cap system ──
  /** Dead-cap charges by season (buyouts, bonus overages, 35+, terminations). */
  capLedger: CapCharge[];
  ltir: LtirEntry[];
  waivers: WaiverEntry[];
  qualifyingOffers: QualifyingOfferRecord[];
  arbitration: ArbitrationCase[];
  offerSheets: OfferSheet[];
  negotiations: Record<number, NegotiationState>;
  /** The AHL (affiliates of every NHL club). */
  ahl?: AhlState;
  /** Player agents (created on demand for older saves). */
  agents?: Record<number, Agent>;
  /** Retained-salary transactions per team (for the per-team limit). */
  nextContractId: number;
  /** Offseason calendar step within the 'resign' / 'freeAgency' phases. */
  offseasonStep?: 'buyoutWindow' | 'qualifyingOffers' | 'freeAgency' | 'arbitration' | 'camp';
}
