/**
 * Hockey game engine.
 *
 * By default every player on the ice makes his own decision every second of
 * the game. The puck carrier weighs shooting, passing to each teammate,
 * carrying, dumping it in, clearing or protecting it; his teammates choose
 * where to get open; defenders choose whom to pressure, mark or block; the
 * goalies set their angle. Each reads the same picture of the ice (positions
 * in feet), decides independently, with judgement errors that shrink as his
 * decision-making improves, and then everything resolves: passes and
 * interceptions, shots (blocks, misses, saves, rebounds, goals), skating,
 * stick battles, hits, loose pucks, offside and icing. Lines, penalties,
 * goalie pulls, overtime, the shootout and the box score are shared with the
 * older possession-step engine ('classic'), kept for comparison.
 *
 * Every probability comes from the players involved, their fatigue, tactics,
 * coaching, chemistry, momentum and home ice. The final score is simply what
 * falls out of those decisions.
 *
 * The engine is pure: given the same GameInput (rosters, ratings, tactics,
 * injuries, seed) it always produces the same GameResult.
 */
import { Rng } from '../core/rng';
import { shotZone, ZONE_COUNT } from '../core/shotZones';
import { clamp, logistic, logit } from '../core/math';
import { emptyStatLine } from '../core/statline';
import type { ArchetypeId, Lines, Position, Tactics } from '../types';
import { ARCHETYPES, type ArchetypeStyle, type Composite } from '../player/archetypes';
import { rollInjury, type InjuryCause } from '../player/injuries';
import type {
  GameEvent,
  GameEventType,
  GameInput,
  GamePlayerInput,
  GameResult,
  GameSnapshot,
  GameTeamInput,
  GoalRecord,
  TrackFrame,
  InjuryRecord,
  PenaltyRecord,
  PlayerGameLine,
  TeamGameStats,
} from './gameTypes';
import { baseGoalProbability, baseMissProbability, dangerOf, type ShotType } from './shotModel';
import { BLUE_LINE, GOAL_LINE, OUT, moveTo, clampToIce, dirOf, dist, distToSegment, along, shotGeometry, structureSpot, type Role, type StructureOpts } from './ice';

/** Balance knobs. Exposed so the analytics screen / tests can inspect them. */
export const TUNING = {
  homeAdv: 0.05,
  momentumWeight: 0.1,
  chemWeight: 0.1,
  coachWeight: 0.07,
  /** Contest edge for a perfectly suited roster (team fit +1, fully familiar). */
  fitWeight: 0.09,
  /** Contest penalty for a completely new system. */
  unfamiliarity: 0.08,
  moraleWeight: Number(globalThis.process?.env?.HGM_MORALE_WEIGHT ?? 0.025),
  /** Contest edge on special teams per standard deviation of the staff's special-teams rating. */
  specialTeamsWeight: 0.035,
  finishOffset: 0.1,
  shooterWeight: 0.24,
  goalieWeight: 0.25,
  /** Stick/hold penalties per second of play (both teams combined). */
  penaltyRate: 1 / 1000,
  /** Probability a hit draws a penalty. */
  hitPenalty: 0.018,
  hitRate: 0.003,
  injuryHit: 0.0026,
  injuryBlock: 0.0018,
  injuryNonContact: 0.00004,
  fightRate: 0.0009,
  scoreEffect: 0.11,
  /** Slope of team-vs-team possession contests (breakouts, entries, battles, turnovers). */
  contest: 0.13,
  ratingScale: Number(globalThis.process?.env?.HGM_RATING_SCALE ?? 45),
};

/** Knobs for the per-second engine (how players weigh their options, how contests resolve). */
export const AGENT = {
  /** Seconds between decisions: every player decides this often (0.25 = four times a second). */
  tick: 0.25,
  /** Seconds a player needs to settle a puck before he can pass or shoot it again (one-timers excepted). */
  settle: 0.35,
  /** Decision-noise scale for the tick length (√tick keeps a second's worth of judgement error constant). */
  noise: 1,
  /** How reluctant players are to throw the puck away from their own zone. */
  clearCost: 0.32,
  /** Bonus for sticking with last tick's choice (commitment to a play). */
  commit: 0.12,
  /** Scale from expected goals to decision utility. */
  shoot: 4.5,
  /** Utility a shot must clear before it beats keeping the puck. */
  shootBar: 0.4,
  /** Base log-odds that a pressuring defender wins the puck in a second of contact. */
  take: -2.2,
  /** Chance a defender squarely in a shooting lane blocks the shot. */
  block: 0.5,
  /** Weight of team-level edges (coaching, system fit, chemistry, momentum) in each second's puck battles. */
  teamEdge: 0.25,
  /** Skater rating spread relative to the possession engine (edges compound when contested every second). */
  talentSpread: 0.27,
  /** Score effects: weight in puck battles, and how much a trailing team's shooters force the issue. */
  scoreFx: 0.06,
  urgency: 0.02,
  /** Finishing offset on top of the shared shot model (log-odds). */
  finish: -0.15,
  /** How strongly home ice tilts puck battles (multiplies the engine's home advantage). */
  homeEdge: 0.35,
  /** Share of puck wins the scorer would actually record as a takeaway (only clear, deliberate steals). */
  tkCredit: 0.07,
  /** Appetite for finishing checks (scaled by each player's physical style). */
  hit: 0.245,
  /** Half-width of a shooting lane a defender can get a piece of (feet). */
  blockLane: 5,
  /** Scale on pass interceptions. */
  intercept: 0.85,
  /** Skating acceleration (ft/s², per second of change in velocity; 0 = instant). */
  accel: 30,
  /** Skating speed: feet per second at average skating, and per z of skating. */
  speed: 15,
  speedZ: 3,
  /** Value of a shot from distance per screener in front, and for defencemen getting it through from the point. */
  traffic: 0.38,
  pointShot: 0.28,
  /** Chance a defender right on the shooter (stick on stick) takes the shot away before it's released. */
  shotDenial: 0.45,
  /** How much a passer values moving the puck to a better scoring spot, and how much he fears interceptions. */
  passGain: 0.25,
  passRisk: 2.5,
  /** Seconds a carrier will protect the puck before he starts wanting to make a play, and how fast that grows (utility per second). */
  holdFor: 1.2,
  /** How far ahead (seconds of the carrier's skating) a pressuring defender aims. */
  pressLead: 0.35,
  /** Seconds after finishing a check before a player can throw another, and before the same carrier can be hit again. */
  hitRecover: 6,
  hitAgain: 3,
  /** Finishing lift on the power play (an extra man means cleaner looks and more screens; log-odds). */
  ppFinish: 0.15,
  holdTire: 0.2,
  /** Implied-touch assist padding (first, second) — far less than the possession engine needed. */
  assistPad: [0.82, 0.66] as [number, number],
};
// Calibration runs can override knobs: HGM_AGENT='{"shoot":6}'.
{
  const raw = globalThis.process?.env?.HGM_AGENT;
  if (raw) Object.assign(AGENT, JSON.parse(raw));
}


/**
 * How keen a player is to finish a check, levelling off at about twice average: the most physical
 * players still only get so many chances to hit someone in a game.
 */
const hitLean = (p: { hitProp: number }) => 2 * Math.tanh(p.hitProp / 2);

// Expected-goal value of every square foot of the attacking zone, computed once.
const SPOT_U = 76;
const SPOT_V = 87;
const SPOT_TABLE = new Float32Array(SPOT_U * SPOT_V);
const SPOT_EMPTY = new Float32Array(SPOT_U * SPOT_V);
for (let iu = 0; iu < SPOT_U; iu++)
  for (let iv = 0; iv < SPOT_V; iv++) {
    const g = shotGeometry(iu + BLUE_LINE, iv - 43);
    const miss = 1 - baseMissProbability('wrist', g.dist);
    SPOT_TABLE[iu * SPOT_V + iv] = baseGoalProbability({ dist: g.dist, angle: g.angle, type: 'wrist' }) * miss;
    SPOT_EMPTY[iu * SPOT_V + iv] = baseGoalProbability({ dist: g.dist, angle: g.angle, type: 'wrist', empty: true }) * miss;
  }

/** Optional tally of shots by distance and how the shooter got the puck (calibration). */
export let SHOT_DEBUG: Record<string, number> | null = null;
export const enableShotDebug = (): Record<string, number> => (SHOT_DEBUG = {});

/** Convert a chance per second of contact into the chance for one decision tick. */
const perTick = (p: number): number => 1 - Math.pow(1 - clamp(p, 0, 0.999), AGENT.tick);

const SUPPORT_OFFSETS = [0, 0, 0, 8, 0, -8, 6, 0, -6, 0];

type Act = 'shoot' | 'pass' | 'carry' | 'dump' | 'clear' | 'hold' | 'support' | 'drive' | 'pressure' | 'hit' | 'mark' | 'cover' | 'block' | 'chase' | 'goalie' | 'faceoff';
interface Plan {
  act: Act;
  tx: number;
  ty: number;
  target?: SP;
}

type Zone = 'D' | 'N' | 'O';
type Side = 0 | 1;

let BASE = 120;
/** Skater talent spread for the engine being built (the per-second engine compounds edges every second, so it compresses them). */
let SPREAD = 1;
/** Ratings → engine z-scores; the scale sets how much a talent gap matters on the ice (and so league parity). */
const zs = (v: number): number => (v - BASE) / TUNING.ratingScale;

interface SP {
  id: number;
  name: string;
  pos: Position;
  isF: boolean;
  arch: ArchetypeId;
  style: ArchetypeStyle;
  team: Side;
  // skater composites (z-scale)
  skate: number;
  hands: number;
  pass: number;
  shot: number;
  slap: number;
  oneT: number;
  back: number;
  acc: number;
  offIQ: number;
  defIQ: number;
  stickD: number;
  block: number;
  phys: number;
  fo: number;
  recv: number;
  decide: number;
  disc: number;
  hitProp: number;
  so: number;
  clutch: number;
  ovr: number;
  // goalie composites
  gBase: number;
  gHD: number;
  gLow: number;
  gReb: number;
  gScreen: number;
  gSO: number;
  // dynamic
  enduranceZ: number;
  energy: number;
  maxEnergy: number;
  form: number;
  fat: number;
  onIce: boolean;
  inBox: boolean;
  out: boolean;
  injuryRisk: number;
  injurySeverity: number;
  ageDrain: number;
  stat: PlayerGameLine;
  // per-second engine: position on the ice (feet), role in the structure, current plan
  x: number;
  y: number;
  role: Role;
  /** What he chose to do this tick (per-second engine), and what he was doing the tick before. */
  plan: Plan | null;
  last: Act | null;
  lastTarget: SP | null;
  /** Per-second scratch: effective ratings this second (form and fatigue applied). */
  e: { skate: number; hands: number; decide: number; defIQ: number; offIQ: number; stickD: number; pass: number; block: number; phys: number };
  /** Per-second scratch: distance to the nearest opponent, and the two nearest opposing defenders. */
  near: number;
  /** Distance to the puck carrier this second, and how many teammates are closer to him. */
  dc: number;
  rank: number;
  d1: number;
  d1p: SP | null;
  d2: number;
  /** Skating velocity (ft/s): nobody changes speed or direction instantly. */
  vx: number;
  vy: number;
  /** Protecting the puck he works a line (the wall, the blue line, across the ice): which way, when he last stepped, and since when he's held it. */
  protDir: number;
  protT: number;
  holdSince: number;
  /** When he last finished a check, and last took one (a player can't hit, or be hit, again straight away). */
  hitAt: number;
  hitTakenAt: number;
}

interface Pen {
  team: Side;
  player: SP;
  remaining: number;
  minutes: number;
  coincidental: boolean;
}

interface ST {
  idx: Side;
  input: GameTeamInput;
  players: SP[];
  byId: Map<number, SP>;
  lines: Lines;
  goalie: SP | null;
  lastGoalie: SP | null;
  starter: SP | null;
  backup: SP | null;
  pulled: boolean;
  goalieChanged: boolean;
  onIce: SP[];
  onIceSince: number;
  kind: string;
  fIdx: number;
  dIdx: number;
  unitIdx: number;
  fStart: number;
  dStart: number;
  lineToi: number[];
  pairToi: number[];
  esTotal: number;
  stats: TeamGameStats;
  /** The system being played right now (the coach adjusts it during the game). */
  tactics: Tactics;
  /** The game plan he started with. */
  base: Tactics;
  /** The adjustment in force (null: the game plan), and how long a temporary one lasts. */
  adjust: string | null;
  adjustUntil: number;
  /** When this team lost the puck in its own zone (recent). */
  dzLoss: number[];
  /** Share of recent play spent pinned in its own zone (smoothed). */
  pinned: number;
  coachOff: number;
  coachDef: number;
  coachTac: number;
  coachMot: number;
  coachGk: number;
  /** Head coach's discipline: scales how often his players are penalised (1 = average). */
  coachDisc: number;
  /** System fit × familiarity: additive edge in contests for each area (0 when balanced/neutral). */
  sys: { off: number; def: number; fc: number; pp: number; pk: number };
  /** How strongly each area's tactical effects apply (coach tactics × fit × familiarity). */
  tacMult: { off: number; def: number; fc: number; pp: number; pk: number };
  morale: number;
  lineChem: number;
  goalieConf: number;
}

const FWD_USAGE: Record<string, number[]> = {
  balanced: [0.35, 0.3, 0.21, 0.14],
  topHeavy: [0.4, 0.31, 0.19, 0.1],
  rollFour: [0.3, 0.27, 0.23, 0.2],
};
const DEF_USAGE: Record<string, number[]> = {
  balanced: [0.4, 0.33, 0.27],
  topHeavy: [0.44, 0.34, 0.22],
  rollFour: [0.36, 0.33, 0.31],
};

const STICK_PENALTIES: [string, number][] = [
  ['Hooking', 22],
  ['Tripping', 22],
  ['Slashing', 12],
  ['Holding', 12],
  ['High-sticking', 12],
  ['Interference', 9],
  ['Cross-checking', 8],
  ['Delay of game', 4],
  ['Holding the stick', 3],
  ['Unsportsmanlike conduct', 2],
];
// NHL mix of body-contact minors: roughing and interference dominate; boarding, charging, elbowing and kneeing are rare.
const HIT_PENALTIES: [string, number][] = [
  ['Roughing', 40],
  ['Interference', 32],
  ['Boarding', 13],
  ['Charging', 6],
  ['Elbowing', 6],
  ['Kneeing', 3],
];

function emptyTeamStats(): TeamGameStats {
  return {
    goals: 0, shots: 0, attempts: 0, missed: 0, blockedAtt: 0, hits: 0, blocks: 0, tk: 0, gv: 0, fow: 0, fol: 0,
    ppOpp: 0, ppg: 0, shg: 0, pim: 0, xg: 0, hdShots: 0, shotsByPeriod: [0, 0, 0], goalsByPeriod: [0, 0, 0],
    ozTime: 0, possTime: 0,
  };
}

const boostZ = (zv: number, b: number | undefined): number => (b ? zv * (1 + b) + b * 0.6 : zv);

function buildPlayer(inp: GamePlayerInput, team: Side, rng: Rng, playoff: boolean): SP {
  const a = inp.attrs;
  const def = ARCHETYPES[inp.archetype];
  const b = def.boost as Partial<Record<Composite, number>>;
  const isG = inp.pos === 'G';
  const consZ = zs(a.consistency);
  const formSd = isG
    ? clamp(0.24 - 0.07 * consZ + (inp.streaky ? 0.07 : 0), 0.1, 0.42)
    : clamp(0.13 - 0.04 * consZ + (inp.streaky ? 0.06 : 0), 0.05, 0.3);
  let form = rng.normal(0, formSd) + inp.form * (isG ? 0.16 : 0.12) + ((inp.morale - 60) / 40) * 0.04;
  if (isG) form += inp.confidence * 0.1;
  if (playoff) form += inp.playoffRep * 0.04 + zs(a.clutch) * 0.03;
  const skate = boostZ(zs(0.3 * a.speed + 0.25 * a.acceleration + 0.2 * a.agility + 0.1 * a.balance + 0.15 * a.edgework), b.skate);
  const hands = boostZ(zs(0.45 * a.stickhandling + 0.35 * a.puckControl + 0.2 * a.creativity), b.hands);
  const pass = boostZ(zs(0.5 * a.passing + 0.15 * a.creativity + 0.15 * a.decisionMaking + 0.2 * a.hockeySense), b.pass);
  const shot = boostZ(zs(0.45 * a.wristAccuracy + 0.25 * a.wristPower + 0.2 * a.shotSelection + 0.1 * a.composure), b.shot);
  const slap = boostZ(zs(0.45 * a.slapPower + 0.45 * a.slapAccuracy + 0.1 * a.shotSelection), b.slap);
  const offIQ = boostZ(zs(0.35 * a.offAwareness + 0.2 * a.anticipation + 0.25 * a.hockeySense + 0.2 * a.positioning), b.offIQ);
  const defIQ = boostZ(
    zs(0.3 * a.defAwareness + 0.3 * a.defPositioning + 0.15 * a.positioning + 0.15 * a.anticipation + 0.1 * a.backchecking),
    b.defIQ,
  );
  const phys = boostZ(zs(0.5 * a.strength + 0.3 * a.bodyChecking + 0.2 * a.balance), b.phys);
  const sp: SP = {
    id: inp.id,
    name: inp.last,
    pos: inp.pos,
    isF: inp.pos === 'C' || inp.pos === 'LW' || inp.pos === 'RW',
    arch: inp.archetype,
    style: def.style,
    team,
    skate,
    hands,
    pass,
    shot,
    slap,
    oneT: boostZ(zs(0.6 * a.oneTimer + 0.2 * a.wristAccuracy + 0.2 * a.receiving), b.shot),
    back: zs(0.7 * a.backhand + 0.3 * a.stickhandling),
    acc: zs(0.6 * a.wristAccuracy + 0.25 * a.shotSelection + 0.15 * a.slapAccuracy),
    offIQ,
    defIQ,
    stickD: boostZ(zs(0.55 * a.stickChecking + 0.25 * a.anticipation + 0.2 * a.defAwareness), b.stickD),
    block: boostZ(zs(0.65 * a.shotBlocking + 0.2 * a.defPositioning + 0.15 * a.determination), b.block),
    phys,
    fo: boostZ(zs(0.8 * a.faceoffs + 0.2 * a.strength), b.faceoff),
    recv: zs(a.receiving),
    decide: zs(0.5 * a.decisionMaking + 0.5 * a.composure),
    disc: zs(a.discipline),
    hitProp: def.style.hit * Math.exp((a.bodyChecking + a.aggression - 240) / 110),
    so: zs(0.35 * a.stickhandling + 0.3 * a.wristAccuracy + 0.2 * a.creativity + 0.15 * a.composure),
    clutch: zs(a.clutch),
    ovr: (skate + hands + pass + shot + offIQ + defIQ + phys) / 7,
    gBase: zs(0.22 * a.reflexes + 0.28 * a.gPositioning + 0.12 * a.glove + 0.1 * a.blocker + 0.1 * a.athleticism + 0.1 * a.lateral + 0.08 * a.highDanger),
    gHD: zs(0.3 * a.highDanger + 0.22 * a.lateral + 0.2 * a.reflexes + 0.18 * a.athleticism + 0.1 * a.gPositioning),
    gLow: zs(0.4 * a.gPositioning + 0.2 * a.glove + 0.2 * a.blocker + 0.1 * a.reflexes + 0.1 * a.reboundControl),
    gReb: zs(a.reboundControl),
    gScreen: zs(0.5 * a.gPositioning + 0.3 * a.reflexes + 0.2 * a.highDanger),
    gSO: zs(0.3 * a.reflexes + 0.3 * a.gPositioning + 0.2 * a.athleticism + 0.2 * a.lateral),
    enduranceZ: zs(a.endurance),
    energy: clamp(inp.energy, 30, 100),
    maxEnergy: clamp(inp.energy, 30, 100),
    form,
    fat: 0,
    onIce: false,
    inBox: false,
    out: false,
    injuryRisk: inp.injuryRisk,
    injurySeverity: inp.injurySeverity,
    ageDrain: inp.age > 31 ? 1 + (inp.age - 31) * 0.012 : 1,
    stat: { ...emptyStatLine(), team },
    x: 0,
    y: -41,
    role: 'X',
    near: 99,
    dc: 99,
    rank: 0,
    d1: 99,
    d1p: null,
    d2: 99,
    vx: 0,
    vy: 0,
    protDir: 1,
    protT: -99,
    holdSince: 0,
    hitAt: -99,
    hitTakenAt: -99,
    e: { skate: 0, hands: 0, decide: 0, defIQ: 0, offIQ: 0, stickD: 0, pass: 0, block: 0, phys: 0 },
    plan: null,
    last: null,
    lastTarget: null,
  };
  if (!isG && SPREAD !== 1) {
    for (const k of ['skate', 'hands', 'pass', 'shot', 'slap', 'oneT', 'back', 'acc', 'offIQ', 'defIQ', 'stickD', 'block', 'phys', 'fo', 'recv', 'decide', 'so', 'ovr'] as const) sp[k] *= SPREAD;
  }
  if (isG) {
    // Goalies carry back-to-back fatigue as a performance penalty rather than shift drain.
    sp.form += ((inp.energy - 100) / 100) * 0.35;
  }
  return sp;
}

function coachZ(v: number | undefined): number {
  return v === undefined ? 0 : (v - 100) / 50;
}

/**
 * Tactical fit and system familiarity. A roster that suits its system gains
 * an edge in that area's contests and gets more out of the system's
 * trade-offs; an ill-suited one is penalised. Unfamiliar systems cost a
 * little everywhere until the players learn them.
 */
function systemEffects(inp: GameTeamInput, coachTac: number): Pick<ST, 'sys' | 'tacMult'> {
  const fit = inp.fit ?? { offense: 0, defense: 0, forecheck: 0, pp: 0, pk: 0 };
  const fam = inp.familiarity ?? { offense: 1, defense: 1, forecheck: 1, pp: 1, pk: 1 };
  const area = (f: number, m: number) => ({
    sys: f * TUNING.fitWeight * (0.5 + 0.5 * m) - (1 - m) * TUNING.unfamiliarity,
    mult: coachTac * (1 + 0.3 * f) * (0.8 + 0.2 * m),
  });
  const o = area(fit.offense, fam.offense);
  const d = area(fit.defense, fam.defense);
  const fc = area(fit.forecheck, fam.forecheck);
  const pp = area(fit.pp, fam.pp);
  const pk = area(fit.pk, fam.pk);
  return {
    sys: { off: o.sys, def: d.sys, fc: fc.sys, pp: pp.sys, pk: pk.sys },
    tacMult: { off: o.mult, def: d.mult, fc: fc.mult, pp: pp.mult, pk: pk.mult },
  };
}

/** The staff's special-teams design adds an edge on the power play and penalty kill. */
function withSpecialTeams(e: Pick<ST, 'sys' | 'tacMult'>, z: number): Pick<ST, 'sys' | 'tacMult'> {
  const edge = z * TUNING.specialTeamsWeight;
  return { ...e, sys: { ...e.sys, pp: e.sys.pp + edge, pk: e.sys.pk + edge } };
}

export class GameSim {
  readonly rng: Rng;
  readonly input: GameInput;
  readonly teams: [ST, ST];
  period = 1;
  clock = 0;
  elapsed = 0;
  periodLength = 1200;
  finished = false;
  poss: Side = 0;
  zone: Zone = 'N';
  faceoff: 'C' | Side | null = 'C';
  setupQ = 0;
  ozPlays = 0;
  chain: SP[] = [];
  carrier: SP | null = null;
  rush = false;
  oddMan = false;
  turnoverFlag = false;
  oneTimerSetup = false;
  transition = false;
  ozFaceoff = false;
  momentum = 0;
  penalties: Pen[] = [];
  noChange: Side | -1 = -1;
  events: GameEvent[] = [];
  /** Events already handed out by step(). */
  private emitted = 0;
  goals: (GoalRecord & { winGoalie: number | null; loseGoalie: number | null })[] = [];
  pens: PenaltyRecord[] = [];
  injuries: InjuryRecord[] = [];
  pairToi: Record<string, number> = {};
  /** Shot chart for this game: shooter id -> [on-goal shots per zone..., goals per zone...]. */
  shotZones: Record<number, number[]> = {};
  inShootout = false;
  shootout: GameResult['shootout'] = [];
  soScore: [number, number] = [0, 0];
  readonly regOT: { minutes: number; skaters: number; shootout: boolean };
  private readonly homeAdv: number;
  /** Which engine runs the play: every player deciding each second, or possession steps. */
  readonly mode: 'agent' | 'classic';
  /** Puck for the per-second engine (feet; home attacks +x). */
  puck: { x: number; y: number; carrier: SP | null; dead: boolean } = { x: 0, y: 0, carrier: null, dead: true };
  /** Individual decisions made so far (each player, each second). */
  decisions = 0;
  track: TrackFrame[] = [];
  private possSince = 0;
  private entryAt = -99;
  private entryRush = false;
  private entryOdd = false;
  private takeawayAt = -99;
  private takeawayOZ = false;
  private crossSlotAt = -99;
  private lastReceiver: SP | null = null;
  private reboundAt = -99;
  /** Defender who stood the carrier up this second (forces a puck battle). */
  private blockedBy: SP | null = null;
  /** When the current carrier got the puck (he needs a moment to settle it). */
  private gotPuckAt = 0;
  /** Last dump-in (the dumping team's forecheckers go hard after it). */
  private dumpAt = -99;
  private dumpTeam: Side = 0;
  /** Each team's manpower situation this second, and reusable structure options. */
  private sitNow: ['ES' | 'PP' | 'PK', 'ES' | 'PP' | 'PK'] = ['ES', 'ES'];
  private sOpts: [StructureOpts, StructureOpts] = [
    { forecheck: '', defense: '', offense: '', pp: false, pk: false, onside: false },
    { forecheck: '', defense: '', offense: '', pp: false, pk: false, onside: false },
  ];
  /** How the current carrier got the puck (diagnostics). */
  private acquired = 'faceoff';

  constructor(input: GameInput) {
    this.input = input;
    BASE = input.ratingBaseline ?? 120;
    this.rng = new Rng(`game|${input.seed}`);
    this.regOT = input.regularSeasonOT ?? { minutes: 5, skaters: 3, shootout: true };
    this.homeAdv = input.neutral ? 0 : TUNING.homeAdv;
    this.mode = input.engine ?? ((globalThis.process?.env?.HGM_ENGINE as 'agent' | 'classic' | undefined) || 'agent');
    SPREAD = this.mode === 'agent' ? AGENT.talentSpread : 1;
    this.teams = [this.buildTeam(input.home, 0), this.buildTeam(input.away, 1)];
    for (const t of this.teams) {
      t.kind = this.kindFor(t.idx);
      this.deploy(t);
    }
    this.ev('periodStart', 0);
  }

  private buildTeam(inp: GameTeamInput, idx: Side): ST {
    const players = inp.players.map((p) => buildPlayer(p, idx, this.rng, this.input.playoff));
    const byId = new Map(players.map((p) => [p.id, p]));
    const goalies = players.filter((p) => p.pos === 'G');
    const starter = byId.get(inp.lines.goalies[0]) ?? goalies[0] ?? null;
    const backup = byId.get(inp.lines.goalies[1]) ?? goalies.find((g) => g !== starter) ?? null;
    const c = inp.coach;
    const t: ST = {
      idx,
      input: inp,
      players,
      byId,
      lines: inp.lines,
      goalie: starter,
      lastGoalie: starter,
      starter,
      backup: backup && backup !== starter ? backup : null,
      pulled: false,
      goalieChanged: false,
      onIce: [],
      onIceSince: 0,
      kind: '',
      fIdx: 0,
      dIdx: 0,
      unitIdx: 0,
      fStart: 0,
      dStart: 0,
      lineToi: [0, 0, 0, 0],
      pairToi: [0, 0, 0],
      esTotal: 0,
      stats: emptyTeamStats(),
      tactics: { ...inp.tactics },
      base: inp.tactics,
      adjust: null,
      adjustUntil: 0,
      dzLoss: [],
      pinned: 0,
      coachOff: coachZ(c?.offense) * TUNING.coachWeight,
      coachDef: coachZ(c?.defense) * TUNING.coachWeight,
      coachTac: clamp(1 + coachZ(c?.tactics) * 0.25, 0.6, 1.4),
      coachMot: coachZ(c?.motivation),
      coachGk: coachZ(c?.goaltending) * 0.04,
      coachDisc: clamp(1 - coachZ(c?.discipline) * 0.1, 0.8, 1.2),
      ...withSpecialTeams(systemEffects(inp, clamp(1 + coachZ(c?.tactics) * 0.25, 0.6, 1.4)), coachZ(c?.specialTeams)),
      morale: ((inp.morale - 55) / 45) * TUNING.moraleWeight,
      lineChem: 0,
      goalieConf: 0,
    };
    if (starter) {
      starter.stat.gs = 1;
      starter.stat.gp = 1;
    }
    return t;
  }

  // ───────────────────────────── public API ─────────────────────────────

  get score(): [number, number] {
    return [this.teams[0].stats.goals, this.teams[1].stats.goals];
  }

  /** Advance one possession step. Returns events produced during the step. */
  /** Steps played so far (a saved game is its input plus this count: the engine is deterministic). */
  steps = 0;

  step(): GameEvent[] {
    if (this.finished) return [];
    this.steps++;
    // Includes anything recorded before the first step (the opening periodStart).
    const before = this.emitted;
    const t0 = this.elapsed;
    this.manageGoalies();
    this.manageLines();
    if (this.mode === 'agent') {
      this.tick();
      if (!this.finished) {
        this.randomEvents(this.elapsed - t0);
        if (this.clock >= this.periodLength - 1e-9) this.endPeriod();
      }
      this.emitted = this.events.length;
      return this.events.slice(before);
    }
    if (this.faceoff !== null) this.doFaceoff();
    else if (!this.emptyNetAttempt()) {
      if (this.zone === 'D') this.breakout();
      else if (this.zone === 'N') this.neutralZone();
      else this.offensiveZone();
    }
    if (!this.finished) {
      this.randomEvents(this.elapsed - t0);
      if (this.clock >= this.periodLength - 1e-9) this.endPeriod();
    }
    this.emitted = this.events.length;
    return this.events.slice(before);
  }

  simulate(): GameResult {
    let guard = 0;
    while (!this.finished && guard++ < 200000) this.step();
    if (!this.finished) this.finish();
    return this.result();
  }

  snapshot(): GameSnapshot {
    const [h, a] = this.teams;
    const energy: Record<number, number> = {};
    for (const t of this.teams) for (const p of t.players) energy[p.id] = Math.round(p.energy);
    return {
      period: this.period,
      clock: this.clock,
      periodLength: this.periodLength,
      score: this.finalScore(),
      shots: [h.stats.shots, a.stats.shots],
      attempts: [h.stats.attempts, a.stats.attempts],
      xg: [h.stats.xg, a.stats.xg],
      hits: [h.stats.hits, a.stats.hits],
      fow: [h.stats.fow, a.stats.fow],
      possession: this.poss,
      zone: this.zone,
      onIce: [h.onIce.map((p) => p.id), a.onIce.map((p) => p.id)],
      goalies: [h.goalie?.id ?? null, a.goalie?.id ?? null],
      strength: [this.skaters(0), this.skaters(1)],
      ppTimeLeft: [this.ppLeft(0), this.ppLeft(1)],
      momentum: this.momentum,
      possTime: [h.stats.possTime, a.stats.possTime],
      finished: this.finished,
      inShootout: this.inShootout,
      energy,
      lineIdx: [h.fIdx, a.fIdx],
      teamStats: [{ ...h.stats, shotsByPeriod: [...h.stats.shotsByPeriod], goalsByPeriod: [...h.stats.goalsByPeriod] }, { ...a.stats, shotsByPeriod: [...a.stats.shotsByPeriod], goalsByPeriod: [...a.stats.goalsByPeriod] }],
      box: this.penalties.map((p) => ({ team: p.team, player: p.player.id, remaining: p.remaining, minutes: p.minutes, coincidental: !!p.coincidental })),
      ice: this.mode === 'agent' ? this.frame() : undefined,
    };
  }

  // ───────────────────────────── helpers ─────────────────────────────

  /**
   * Record an event. Each gets an id; `causeNext` (set just before) links it to
   * the event that led to it (a save to its shot, a takeaway to the pass it
   * picked off), so any play can be traced back.
   */
  private ev(type: GameEventType, team: Side, p1?: number, p2?: number, p3?: number, data?: GameEvent['data']): number {
    const cause = this.causeNext;
    this.causeNext = undefined;
    if (!this.input.recordEvents) return 0;
    const id = ++this.evSeq;
    this.events.push({ id, cause, t: this.elapsed, period: this.period, clock: this.clock, type, team, p1, p2, p3, data });
    return id;
  }
  private evSeq = 0;
  private causeNext: number | undefined;
  /** The latest pass (for linking the shot or turnover it led to), shot and save. */
  private lastPassEv = { id: 0, team: 0 as Side, t: -99 };
  private lastShotEv = 0;
  private lastSaveEv = 0;
  private lastReboundEv = 0;
  /** The chance the goal just scored had of going in (recorded on the goal). */
  private goalP: number | undefined;
  /** What set up a shot by team A right now: the pass just before it, or the rebound. */
  private setupFor(A: Side, rebound: boolean): number | undefined {
    if (rebound && this.lastReboundEv) return this.lastReboundEv;
    return this.lastPassEv.team === A && this.elapsed - this.lastPassEv.t < 4 && this.lastPassEv.id ? this.lastPassEv.id : undefined;
  }

  private pickW(list: SP[], w: (p: SP) => number): SP {
    return list[this.rng.weightedIndex(list.map(w))];
  }

  private isRegOT(): boolean {
    return !this.input.playoff && this.period > 3;
  }

  private boxCount(i: Side): number {
    let n = 0;
    for (const p of this.penalties) if (p.team === i && !p.coincidental) n++;
    return Math.min(2, n);
  }

  private baseSkaters(i: Side): number {
    const o = (1 - i) as Side;
    if (this.isRegOT()) {
      const diff = this.boxCount(o) - this.boxCount(i);
      return diff > 0 ? Math.min(5, this.regOT.skaters + diff) : this.regOT.skaters;
    }
    return 5 - this.boxCount(i);
  }

  skaters(i: Side): number {
    return this.baseSkaters(i) + (this.teams[i].pulled ? 1 : 0);
  }

  private situation(i: Side): 'ES' | 'PP' | 'PK' {
    const a = this.baseSkaters(i);
    const b = this.baseSkaters((1 - i) as Side);
    return a > b ? 'PP' : a < b ? 'PK' : 'ES';
  }

  private ppLeft(i: Side): number {
    if (this.situation(i) !== 'PP') return 0;
    let m = 0;
    for (const p of this.penalties) if (p.team !== i && !p.coincidental) m = Math.max(m, p.remaining);
    return m;
  }

  private kindFor(i: Side): string {
    const sit = this.situation(i);
    const n = this.baseSkaters(i);
    const base = sit === 'ES' ? `ES${n}` : `${sit}${n}`;
    return this.teams[i].pulled ? `${base}+` : base;
  }

  private val(p: SP, k: 'skate' | 'hands' | 'pass' | 'shot' | 'slap' | 'oneT' | 'back' | 'offIQ' | 'defIQ' | 'stickD' | 'block' | 'phys' | 'fo' | 'acc' | 'decide'): number {
    const fatW = k === 'skate' ? 1 : k === 'phys' ? 0.8 : k === 'offIQ' || k === 'defIQ' || k === 'decide' ? 0.6 : 0.7;
    return p[k] + p.form + p.fat * fatW;
  }

  private avg(t: ST, f: (p: SP) => number): number {
    const l = t.onIce;
    if (!l.length) return -1;
    let s = 0;
    for (const p of l) s += f(p);
    return s / l.length;
  }

  /** Context modifier for team i in contested actions (home ice, momentum, coaching, chemistry, morale). */
  private ctx(i: Side): number {
    const t = this.teams[i];
    const home = i === 0 ? this.homeAdv : -this.homeAdv;
    const mom = (i === 0 ? this.momentum : -this.momentum) * TUNING.momentumWeight;
    // Score effects: trailing teams push, leading teams sit back.
    let scoreFx = 0;
    if (this.period >= 2) {
      const [sh, sa] = this.score;
      const diff = i === 0 ? sh - sa : sa - sh;
      if (diff < 0) scoreFx = TUNING.scoreEffect * Math.min(2, -diff);
      else if (diff > 0) scoreFx = -TUNING.scoreEffect * 0.5 * Math.min(2, diff);
    }
    return home * 0.5 + mom + t.lineChem * TUNING.chemWeight + t.morale + scoreFx;
  }

  /** Score effects alone: + when trailing (pushing), - when protecting a lead. */
  private scoreEffect(i: Side): number {
    if (this.period < 2) return 0;
    const [sh, sa] = this.score;
    const diff = i === 0 ? sh - sa : sa - sh;
    if (diff < 0) return Math.min(2, -diff) * (this.period >= 3 ? 1.4 : 1);
    if (diff > 0) return -0.5 * Math.min(2, diff) * (this.period >= 3 ? 1.4 : 1);
    return 0;
  }

  private openIce(): number {
    const n = Math.min(this.baseSkaters(0), this.baseSkaters(1));
    return n <= 3 ? 1.8 : n === 4 ? 1.25 : 1;
  }

  private isPK(i: Side): boolean {
    return this.situation(i) === 'PK';
  }

  private forecheckIntensity(t: ST): number {
    const d = t.tactics.defense;
    let f = d === 'aggressive' ? 1.13 : d === 'physical' ? 1.06 : d === 'passive' ? 0.9 : d === 'trap' ? 0.86 : 1;
    const fc = t.tactics.forecheck;
    f *= fc === '2-1-2' ? 1.07 : fc === '1-3-1' ? 0.93 : 1;
    if (this.isPK(t.idx)) f *= t.tactics.pk === 'aggressive' ? 0.9 : 0.55;
    return 1 + (f - 1) * (this.isPK(t.idx) ? t.tacMult.pk : t.tacMult.fc);
  }

  private resetPossession(): void {
    this.chain = [];
    this.setupQ = 0;
    this.ozPlays = 0;
    this.carrier = null;
    this.rush = false;
    this.oddMan = false;
    this.turnoverFlag = false;
    this.oneTimerSetup = false;
    this.transition = false;
    this.ozFaceoff = false;
  }

  private changePossession(to: Side, zone: Zone): void {
    this.poss = to;
    this.zone = zone;
    this.resetPossession();
  }

  private addChain(p: SP): void {
    if (this.chain[this.chain.length - 1] === p) return;
    this.chain.push(p);
    if (this.chain.length > 4) this.chain.shift();
  }

  // ───────────────────────────── time / fatigue ─────────────────────────────

  private advance(dtRaw: number): void {
    const dt = Math.min(dtRaw, this.periodLength - this.clock);
    if (dt <= 0) return;
    this.clock += dt;
    this.elapsed += dt;
    for (const t of this.teams) {
      const sit = this.situation(t.idx);
      const kindFactor = sit === 'PK' ? 1.15 : this.isRegOT() ? 1.1 : 1;
      const defending = this.poss !== t.idx && this.zone === 'O' ? 1.12 : 1;
      for (const p of t.players) {
        if (p.pos === 'G') continue;
        if (p.onIce) {
          p.stat.toi += dt;
          if (sit === 'ES') p.stat.toiES += dt;
          else if (sit === 'PP') p.stat.toiPP += dt;
          else p.stat.toiPK += dt;
          const drain = 0.56 * (1 - p.enduranceZ * 0.13) * kindFactor * defending * p.ageDrain;
          p.energy = Math.max(5, p.energy - drain * dt);
        } else if (!p.out) {
          p.energy = Math.min(p.maxEnergy, p.energy + 0.3 * (1 + p.enduranceZ * 0.1) * dt);
        }
        p.fat = p.energy < 72 ? ((p.energy - 72) / 72) * 0.6 : 0;
      }
      if (t.goalie) {
        t.goalie.stat.gtoi += dt;
        t.goalie.stat.toi += dt;
      }
      if (sit === 'ES' && !this.isRegOT()) {
        t.lineToi[t.fIdx] += dt;
        t.pairToi[t.dIdx] += dt;
        t.esTotal += dt;
      }
    }
    const pt = this.teams[this.poss];
    pt.stats.possTime += dt;
    if (this.zone === 'O') pt.stats.ozTime += dt;
    // penalties
    if (this.penalties.length) {
      const expired: Pen[] = [];
      for (const p of this.penalties) {
        p.remaining -= dt;
        if (p.remaining <= 0) expired.push(p);
      }
      for (const p of expired) this.endPenalty(p, false);
    }
    this.momentum *= Math.exp(-dt / 150);
  }

  private endPenalty(pen: Pen, byGoal: boolean): void {
    this.penalties = this.penalties.filter((p) => p !== pen);
    if (!this.penalties.some((p) => p.player === pen.player)) pen.player.inBox = false;
    if (!pen.coincidental) {
      const killer = pen.team;
      if (!byGoal) this.bumpMomentum(killer, 0.07);
      this.ev('ppEnd', killer, pen.player.id, undefined, undefined, { success: !byGoal });
    }
  }

  private bumpMomentum(i: Side, amt: number): void {
    const t = this.teams[i];
    const scaled = amt * (1 + t.coachMot * 0.15);
    this.momentum = clamp(this.momentum + (i === 0 ? scaled : -scaled), -1, 1);
  }

  // ───────────────────────────── lines ─────────────────────────────

  private flushPairs(t: ST): void {
    const dur = this.elapsed - t.onIceSince;
    if (dur > 0 && t.onIce.length > 1) {
      const l = t.onIce;
      for (let i = 0; i < l.length; i++) {
        for (let j = i + 1; j < l.length; j++) {
          const a = l[i].id;
          const b = l[j].id;
          const key = a < b ? `${a}-${b}` : `${b}-${a}`;
          this.pairToi[key] = (this.pairToi[key] ?? 0) + dur;
        }
      }
    }
    t.onIceSince = this.elapsed;
  }

  private available(p: SP | undefined, used: Set<SP>): boolean {
    return !!p && !p.out && !p.inBox && !used.has(p) && p.pos !== 'G';
  }

  private replacement(t: ST, wantF: boolean, used: Set<SP>): SP | null {
    let best: SP | null = null;
    let bestScore = -Infinity;
    for (const p of t.players) {
      if (!this.available(p, used)) continue;
      const fit = p.isF === wantF ? 0 : -1.2;
      const s = fit + p.ovr + p.energy / 120;
      if (s > bestScore) {
        bestScore = s;
        best = p;
      }
    }
    return best;
  }

  private take(t: ST, id: number | undefined, wantF: boolean, used: Set<SP>, out: SP[]): void {
    const p = id === undefined ? undefined : t.byId.get(id);
    const chosen = p && this.available(p, used) ? p : this.replacement(t, p ? p.isF : wantF, used);
    if (chosen) {
      used.add(chosen);
      out.push(chosen);
    }
  }

  private deploy(t: ST): void {
    this.flushPairs(t);
    for (const p of t.onIce) p.onIce = false;
    const used = new Set<SP>();
    const out: SP[] = [];
    const kind = t.kind;
    const pulled = kind.endsWith('+');
    const k = pulled ? kind.slice(0, -1) : kind;
    const n = Number(k.slice(2));
    const L = t.lines;
    if (k.startsWith('PP')) {
      const unit = L.pp[t.unitIdx] ?? L.pp[0] ?? [];
      for (let i = 0; i < 5 && out.length < n; i++) this.take(t, unit[i], i < 3, used, out);
    } else if (k.startsWith('PK')) {
      const unit = L.pk[t.unitIdx] ?? L.pk[0] ?? [];
      const order = n >= 4 ? [0, 1, 2, 3] : [0, 2, 3];
      for (const i of order) if (out.length < n) this.take(t, unit[i], i < 2, used, out);
    } else {
      const fl = L.fwd[t.fIdx] ?? L.fwd[0] ?? [];
      const dp = L.def[t.dIdx] ?? L.def[0] ?? [];
      if (n >= 5) {
        for (const id of fl) this.take(t, id, true, used, out);
        for (const id of dp) this.take(t, id, false, used, out);
      } else if (n === 4) {
        this.take(t, fl[1], true, used, out);
        this.take(t, this.bestWinger(t, fl), true, used, out);
        for (const id of dp) this.take(t, id, false, used, out);
      } else {
        this.take(t, fl[1], true, used, out);
        this.take(t, this.bestWinger(t, fl), true, used, out);
        this.take(t, this.bestOf(t, dp), false, used, out);
      }
    }
    while (out.length < n) {
      const r = this.replacement(t, out.filter((p) => p.isF).length < 3, used);
      if (!r) break;
      used.add(r);
      out.push(r);
    }
    if (pulled) {
      let best: SP | null = null;
      for (const p of t.players) {
        if (!this.available(p, used) || !p.isF) continue;
        if (!best || p.offIQ + p.shot > best.offIQ + best.shot) best = p;
      }
      if (best) out.push(best);
    }
    const prev = new Set(t.onIce);
    for (const p of out) {
      p.onIce = true;
      // New skaters come over the boards from the bench.
      if (!prev.has(p)) {
        p.stat.shifts++;
        p.x = (t.idx === 0 ? -12 : 12) + this.rng.float(-4, 4);
        p.y = -40;
        p.vx = p.vy = 0;
      }
    }
    t.onIce = out;
    this.assignRoles(out);
    t.onIceSince = this.elapsed;
    t.lineChem = this.computeChem(t);
  }

  private bestWinger(t: ST, line: number[]): number | undefined {
    const w = [line[0], line[2]].map((id) => (id === undefined ? undefined : t.byId.get(id)));
    const ok = w.filter((p): p is SP => !!p && !p.out && !p.inBox);
    if (!ok.length) return line[0];
    return ok.sort((a, b) => b.ovr - a.ovr)[0].id;
  }

  private bestOf(t: ST, ids: number[]): number | undefined {
    const ok = ids.map((id) => t.byId.get(id)).filter((p): p is SP => !!p && !p.out && !p.inBox);
    if (!ok.length) return ids[0];
    return ok.sort((a, b) => b.ovr - a.ovr)[0].id;
  }

  private computeChem(t: ST): number {
    const f = t.input.chemistry;
    if (!f || t.onIce.length < 2) return 0;
    let s = 0;
    let n = 0;
    const l = t.onIce;
    for (let i = 0; i < l.length; i++)
      for (let j = i + 1; j < l.length; j++) {
        s += f(l[i].id, l[j].id);
        n++;
      }
    return n ? clamp(s / n, -1, 1) : 0;
  }

  private usage(t: ST): { f: number[]; d: number[] } {
    let f = FWD_USAGE[t.tactics.lineUsage] ?? FWD_USAGE.balanced;
    let d = DEF_USAGE[t.tactics.lineUsage] ?? DEF_USAGE.balanced;
    const [sh, sa] = this.score;
    const diff = t.idx === 0 ? sh - sa : sa - sh;
    const late = this.period >= 3 && this.periodLength - this.clock < 420;
    if (late && diff < 0) {
      f = [0.45, 0.37, 0.18, 0];
      d = [0.47, 0.38, 0.15];
    } else if (late && diff > 0 && diff <= 2) {
      f = [0.33, 0.27, 0.3, 0.1];
      d = [0.45, 0.35, 0.2];
    }
    return { f, d };
  }

  private lineEnergy(t: ST, ids: number[]): number {
    let s = 0;
    let n = 0;
    for (const id of ids) {
      const p = t.byId.get(id);
      if (p && !p.out) {
        s += p.energy;
        n++;
      }
    }
    return n ? s / n : 0;
  }

  private nextF(t: ST): number {
    const { f } = this.usage(t);
    let best = t.fIdx;
    let bestScore = -Infinity;
    for (let i = 0; i < 4; i++) {
      if (i === t.fIdx || !t.lines.fwd[i] || f[i] <= 0) continue;
      const deficit = f[i] * (t.esTotal + 90) - t.lineToi[i];
      const s = deficit + (this.lineEnergy(t, t.lines.fwd[i]) - 85) * 0.7;
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    return best;
  }

  private nextD(t: ST): number {
    const { d } = this.usage(t);
    const opp = this.teams[1 - t.idx];
    let best = t.dIdx;
    let bestScore = -Infinity;
    for (let i = 0; i < 3; i++) {
      if (i === t.dIdx || !t.lines.def[i] || d[i] <= 0) continue;
      const deficit = d[i] * (t.esTotal + 90) - t.pairToi[i];
      let s = deficit + (this.lineEnergy(t, t.lines.def[i]) - 85) * 0.7;
      // Home team has the last change: match the top pair against the opponent's top line.
      if (t.idx === 0 && i === 0 && opp.fIdx === 0) s += 14 * t.coachTac;
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    return best;
  }

  private manageLines(): void {
    for (const t of this.teams) {
      const kind = this.kindFor(t.idx);
      if (kind !== t.kind) {
        const wasSpecial = t.kind.startsWith('PP') || t.kind.startsWith('PK');
        const nowSpecial = kind.startsWith('PP') || kind.startsWith('PK');
        if (nowSpecial && !wasSpecial) t.unitIdx = 0;
        if (!nowSpecial && wasSpecial) {
          t.fIdx = this.nextF(t);
          t.dIdx = this.nextD(t);
        }
        t.kind = kind;
        t.fStart = this.elapsed;
        t.dStart = this.elapsed;
        this.deploy(t);
        continue;
      }
      const stoppage = this.faceoff !== null;
      if (stoppage && this.noChange === t.idx) continue;
      // Nobody changes while he has the puck on his stick.
      if (!stoppage && this.mode === 'agent' && this.puck.carrier && this.puck.carrier.team === t.idx) {
        const shiftF0 = this.elapsed - t.fStart;
        if (shiftF0 < 95) continue;
      }
      const canChange = stoppage || this.poss === t.idx || this.zone === 'N';
      const shiftF = this.elapsed - t.fStart;
      const shiftD = this.elapsed - t.dStart;
      if (!canChange && shiftF < 95) continue;
      // Nobody is due for a change this early in a shift.
      if (shiftF < 26 && shiftD < 30) continue;
      let changed = false;
      const base = t.kind.replace('+', '');
      if (base === 'ES5' || base === 'ES4') {
        let fe = 0;
        let fn = 0;
        let de = 0;
        let dn = 0;
        for (const p of t.onIce) {
          if (p.isF) {
            fe += p.energy;
            fn++;
          } else {
            de += p.energy;
            dn++;
          }
        }
        fe = fn ? fe / fn : 100;
        de = dn ? de / dn : 100;
        if (shiftF > 50 || (shiftF > 26 && fe < 50) || (stoppage && shiftF > 34)) {
          t.fIdx = this.nextF(t);
          t.fStart = this.elapsed;
          changed = true;
        }
        if (shiftD > 58 || (shiftD > 30 && de < 50) || (stoppage && shiftD > 40)) {
          t.dIdx = this.nextD(t);
          t.dStart = this.elapsed;
          changed = true;
        }
      } else if (base === 'ES3') {
        if (shiftF > 42) {
          t.fIdx = (t.fIdx + 1) % 3;
          t.dIdx = (t.dIdx + 1) % 2;
          t.fStart = t.dStart = this.elapsed;
          changed = true;
        }
      } else if (base.startsWith('PP')) {
        const limit = t.unitIdx === 0 ? 72 : 48;
        if (shiftF > limit) {
          t.unitIdx = t.unitIdx === 0 && t.lines.pp[1] ? 1 : 0;
          t.fStart = t.dStart = this.elapsed;
          changed = true;
        }
      } else if (base.startsWith('PK')) {
        if (shiftF > 42) {
          t.unitIdx = t.unitIdx === 0 && t.lines.pk[1] ? 1 : 0;
          t.fStart = t.dStart = this.elapsed;
          changed = true;
        }
      }
      if (changed) {
        this.deploy(t);
        this.ev('lineChange', t.idx, undefined, undefined, undefined, { unit: t.kind });
      }
    }
  }

  private manageGoalies(): void {
    const [h, a] = this.score;
    for (const t of this.teams) {
      const diff = t.idx === 0 ? h - a : a - h;
      const remaining = this.periodLength - this.clock;
      if (t.pulled) {
        if (diff >= 0 || diff < -3 || this.period !== 3) {
          if (this.faceoff !== null || this.poss !== t.idx) {
            t.pulled = false;
            t.goalie = t.lastGoalie;
            this.ev('goalieReturn', t.idx, t.goalie?.id);
          }
        }
        continue;
      }
      if (this.period !== 3 || diff >= 0 || diff < -2 || !t.goalie) continue;
      const style = t.tactics.pullGoalie;
      const mult = style === 'aggressive' ? 1.45 : style === 'conservative' ? 0.7 : 1;
      const threshold = (diff === -1 ? 95 : 118) * mult;
      if (remaining > threshold) continue;
      // Pull when we have the puck or at an offensive-zone faceoff.
      const ok = (this.faceoff !== null && this.faceoff === 1 - t.idx) || (this.faceoff === null && this.poss === t.idx && this.zone !== 'D');
      if (!ok) continue;
      if (this.situation(t.idx) === 'PK') continue;
      t.pulled = true;
      t.lastGoalie = t.goalie;
      t.goalie = null;
      this.ev('goaliePulled', t.idx, t.lastGoalie?.id);
    }
  }

  // ───────────────────────────── play: faceoff ─────────────────────────────

  private center(t: ST): SP {
    let best: SP | null = null;
    for (const p of t.onIce) {
      if (!p.isF) continue;
      const s = p.fo + (p.pos === 'C' ? 0.6 : 0);
      if (!best || s > best.fo + (best.pos === 'C' ? 0.6 : 0)) best = p;
    }
    return best ?? t.onIce[0];
  }

  private doFaceoff(): void {
    const spot = this.faceoff!;
    const [t0, t1] = this.teams;
    const c0 = this.center(t0);
    const c1 = this.center(t1);
    if (!c0 || !c1) {
      this.faceoff = null;
      return;
    }
    const l = 0.75 * (this.val(c0, 'fo') - this.val(c1, 'fo')) + this.homeAdv * 0.8;
    const w: Side = this.rng.chance(logistic(l)) ? 0 : 1;
    const winner = w === 0 ? c0 : c1;
    const loser = w === 0 ? c1 : c0;
    winner.stat.fow++;
    loser.stat.fol++;
    this.teams[w].stats.fow++;
    this.teams[1 - w].stats.fol++;
    this.poss = w;
    this.resetPossession();
    if (spot === 'C') this.zone = 'N';
    else if (spot === w) this.zone = 'D';
    else {
      this.zone = 'O';
      this.ozFaceoff = true;
      this.setupQ = 0.1;
    }
    this.carrier = this.pickW(this.teams[w].onIce, (p) => (p === winner ? 0.3 : p.isF ? 0.8 : 1.4));
    if (this.carrier !== winner) this.addChain(winner);
    this.faceoff = null;
    this.noChange = -1;
    this.ev('faceoff', w, winner.id, loser.id, undefined, { zone: this.zone });
    this.advance(this.rng.float(1.5, 4));
  }

  // ───────────────────────────── play: breakout ─────────────────────────────

  private breakout(): void {
    const A = this.teams[this.poss];
    const B = this.teams[1 - this.poss];
    const rng = this.rng;
    if (this.isPK(A.idx)) {
      const pClear = A.tactics.pk === 'aggressive' ? 0.62 : A.tactics.pk === 'passive' ? 0.9 : 0.82;
      if (rng.chance(pClear)) {
        const clr = this.pickW(A.onIce, (p) => 1 + p.defIQ);
        this.ev('clear', A.idx, clr.id);
        this.advance(rng.float(6, 11));
        this.changePossession(B.idx, 'D');
        return;
      }
    }
    const mover = this.pickW(A.onIce, (p) => (p.isF ? 0.7 : 1.3) * p.style.carry * Math.exp(0.4 * p.pass));
    const skill = 0.5 * this.val(mover, 'pass') + 0.3 * this.val(mover, 'hands') + 0.2 * this.avg(A, (p) => this.val(p, 'skate')) + A.coachOff + A.sys.off - (this.isPK(B.idx) ? B.sys.pk : B.sys.fc);
    const fc = this.forecheckIntensity(B);
    const forecheckers = B.onIce.filter((p) => p.isF);
    const fl = forecheckers.length ? forecheckers : B.onIce;
    let press = 0;
    for (const p of fl) press += 0.4 * this.val(p, 'skate') + 0.3 * this.val(p, 'phys') + 0.3 * this.val(p, 'stickD');
    press /= fl.length;
    const strDiff = this.skaters(A.idx) - this.skaters(B.idx);
    const lFail = -2.15 + TUNING.contest * (press - skill) + 1.4 * Math.log(fc) + this.ctx(B.idx) - this.ctx(A.idx) - 0.45 * strDiff - (this.transition ? 0.3 : 0);
    const pFail = logistic(lFail);
    const r = rng.next();
    this.advance(rng.float(4, 9));
    if (r < pFail) {
      const fcp = this.pickW(fl, (p) => 0.5 + p.hitProp * 0.5 + Math.exp(0.4 * p.stickD));
      if (rng.chance(0.22 * fcp.hitProp * (B.tactics.defense === 'physical' ? 1.4 : 1))) this.hit(fcp, mover);
      const credit = rng.next();
      if (credit < 0.4) {
        mover.stat.gv++;
        A.stats.gv++;
        this.ev('giveaway', A.idx, mover.id, fcp.id, undefined, { zone: 'D' });
      } else if (credit < 0.7) {
        fcp.stat.tk++;
        B.stats.tk++;
        this.ev('takeaway', B.idx, fcp.id, mover.id, undefined, { zone: 'O' });
      }
      this.changePossession(B.idx, 'O');
      this.turnoverFlag = true;
      this.setupQ = 0.25;
      this.carrier = fcp;
      return;
    }
    const pIce = 0.028 * fc * (this.isPK(A.idx) ? 0 : 1) * Math.exp(-0.3 * skill);
    if (rng.chance(pIce)) {
      this.ev('icing', A.idx, mover.id);
      this.faceoff = A.idx;
      this.noChange = A.idx;
      return;
    }
    this.addChain(mover);
    this.ev('breakout', A.idx, mover.id);
    this.zone = 'N';
    this.carrier = mover;
    // Beating an aggressive forecheck can spring a quick-up rush.
    if (fc > 1.05 && rng.chance(0.25 * (fc - 0.95) + (this.transition ? 0.12 : 0))) {
      this.rush = true;
      this.transition = true;
    }
  }

  // ───────────────────────────── play: neutral zone ─────────────────────────────

  private carryProb(A: ST, B: ST): number {
    const o = A.tactics.offense;
    let p = o === 'rush' ? 0.74 : o === 'possession' ? 0.66 : o === 'cycle' ? 0.5 : o === 'dumpChase' ? 0.3 : 0.56;
    if (B.tactics.defense === 'trap' || B.tactics.forecheck === '1-3-1') p *= 0.82;
    if (this.situation(A.idx) === 'PP') p = 0.66;
    return p;
  }

  private neutralZone(): void {
    const A = this.teams[this.poss];
    const B = this.teams[1 - this.poss];
    const rng = this.rng;
    const carrier =
      this.carrier && this.carrier.onIce && this.carrier.team === A.idx
        ? this.carrier
        : this.pickW(A.onIce, (p) => p.style.carry * Math.exp(0.35 * (p.skate + p.hands)) * (p.isF ? 1 : 0.6));
    const strDiff = this.skaters(A.idx) - this.skaters(B.idx);
    const open = this.openIce();
    let pCarry = this.carryProb(A, B) + 0.05 * (carrier.hands + carrier.skate) / 2;
    if (this.transition || this.rush) pCarry += 0.12;
    if (rng.chance(clamp(pCarry, 0.12, 0.92))) {
      const trap = B.tactics.defense === 'trap' ? 0.25 : B.tactics.defense === 'passive' ? 0.07 : 0;
      const sys = B.tactics.forecheck === '1-3-1' ? 0.14 : 0;
      const defNZ = this.avg(B, (p) => 0.45 * this.val(p, 'defIQ') + 0.3 * this.val(p, 'skate') + 0.25 * this.val(p, 'stickD')) + trap * B.tacMult.def + sys * B.tacMult.fc + B.coachDef + B.sys.def;
      const skill = (this.val(carrier, 'skate') + this.val(carrier, 'hands')) / 2 + A.coachOff + A.sys.off;
      const l = 0.62 + TUNING.contest * (skill - defNZ) + this.ctx(A.idx) - this.ctx(B.idx) + 0.4 * strDiff + 0.5 * (open - 1) + (this.transition ? 0.35 : 0);
      this.advance(rng.float(3.5, 7));
      if (rng.chance(logistic(l))) {
        if (rng.chance(0.55)) {
          const helper = this.pickW(A.onIce.filter((p) => p !== carrier), (p) => Math.exp(0.4 * p.pass));
          if (helper) this.addChain(helper);
        }
        this.addChain(carrier);
        let pOdd = 0.04 + (this.transition ? 0.09 : 0) + Math.max(0, carrier.skate - defNZ) * 0.04 + (open - 1) * 0.25;
        if (B.tactics.defense === 'aggressive' || B.tactics.forecheck === '2-1-2') pOdd += 0.025;
        if (B.tactics.defense === 'trap') pOdd -= 0.03;
        this.zone = 'O';
        this.rush = true;
        this.oddMan = rng.chance(clamp(pOdd, 0.01, 0.5));
        this.carrier = carrier;
        this.setupQ = 0.05;
        this.ev('entry', A.idx, carrier.id, undefined, undefined, { rush: true, oddMan: this.oddMan, success: true });
        return;
      }
      if (rng.chance(0.18)) {
        this.ev('offside', A.idx, carrier.id);
        this.faceoff = 'C';
        return;
      }
      const d = this.pickW(B.onIce, (p) => Math.exp(0.5 * p.stickD) * (p.isF ? 0.8 : 1.2));
      const credit = rng.next();
      if (credit < 0.3) {
        d.stat.tk++;
        B.stats.tk++;
        this.ev('takeaway', B.idx, d.id, carrier.id, undefined, { zone: 'N' });
      } else if (credit < 0.55) {
        carrier.stat.gv++;
        A.stats.gv++;
        this.ev('giveaway', A.idx, carrier.id, d.id, undefined, { zone: 'N' });
      }
      this.changePossession(B.idx, 'N');
      this.transition = true;
      this.carrier = d;
      return;
    }
    // Dump and chase.
    this.ev('dumpIn', A.idx, carrier.id);
    this.addChain(carrier);
    this.advance(rng.float(5, 9));
    const fwds = A.onIce.filter((p) => p.isF);
    const fcs = fwds.length ? fwds : A.onIce;
    const f = this.pickW(fcs, (p) => (0.6 + p.style.hit * 0.4) * Math.exp(0.4 * p.skate));
    const dmen = B.onIce.filter((p) => !p.isF);
    const d = this.pickW(dmen.length ? dmen : B.onIce, () => 1);
    const o = A.tactics.offense;
    const tac = (o === 'dumpChase' ? 0.28 : o === 'cycle' ? 0.12 : 0) + (A.tactics.defense === 'physical' ? 0.12 : 0);
    const l =
      -0.5 +
      TUNING.contest * (0.4 * this.val(f, 'skate') + 0.35 * this.val(f, 'phys') + 0.25 * this.val(f, 'stickD') - (0.35 * this.val(d, 'skate') + 0.35 * this.val(d, 'phys') + 0.3 * this.val(d, 'hands'))) +
      tac * A.tacMult.off + A.sys.fc +
      this.ctx(A.idx) - this.ctx(B.idx) + 0.35 * strDiff;
    const won = rng.chance(logistic(l));
    if (rng.chance(0.2 * (won ? f.hitProp : d.hitProp))) {
      if (won) this.hit(f, d);
      else this.hit(d, f);
    }
    this.ev('battle', won ? A.idx : B.idx, won ? f.id : d.id, won ? d.id : f.id);
    if (won) {
      this.zone = 'O';
      this.carrier = f;
      this.setupQ = 0.04;
      this.addChain(f);
    } else {
      this.changePossession(B.idx, 'D');
      this.carrier = d;
    }
  }

  // ───────────────────────────── play: offensive zone ─────────────────────────────

  private offensiveZone(): void {
    const A = this.teams[this.poss];
    const B = this.teams[1 - this.poss];
    const rng = this.rng;
    this.ozPlays++;
    if (!this.carrier || !this.carrier.onIce || this.carrier.team !== A.idx) {
      this.carrier = this.pickW(A.onIce, (p) => (p.isF ? 1 : 0.7) * Math.exp(0.3 * p.offIQ));
    }
    const carrier = this.carrier;
    const strDiff = this.skaters(A.idx) - this.skaters(B.idx);
    const sitA = this.situation(A.idx);
    const open = this.openIce();
    const attack =
      this.avg(A, (p) => 0.35 * this.val(p, 'offIQ') + 0.25 * this.val(p, 'hands') + 0.25 * this.val(p, 'pass') + 0.15 * this.val(p, 'skate')) +
      A.coachOff + (sitA === 'PP' ? A.sys.pp : A.sys.off) + this.ctx(A.idx);
    let defense =
      this.avg(B, (p) => 0.45 * this.val(p, 'defIQ') + 0.25 * this.val(p, 'stickD') + 0.15 * this.val(p, 'skate') + 0.15 * this.val(p, 'phys')) +
      B.coachDef + (sitA === 'PP' ? B.sys.pk : B.sys.def) + this.ctx(B.idx);
    const dStyle = B.tactics.defense;
    let pressure = dStyle === 'aggressive' ? 0.12 : dStyle === 'physical' ? 0.06 : dStyle === 'passive' ? -0.14 : dStyle === 'trap' ? -0.03 : 0;
    if (sitA === 'PP') {
      const pk = B.tactics.pk;
      pressure = pk === 'aggressive' ? 0.18 : pk === 'diamond' ? 0.06 : pk === 'passive' ? -0.18 : 0;
    }
    pressure *= sitA === 'PP' ? B.tacMult.pk : B.tacMult.def;
    if (B.goalie === null && !B.pulled) defense -= 0.5;
    const oStyle = A.tactics.offense;
    let lTurn = -2.05 + TUNING.contest * (defense - attack) - 0.32 * strDiff + pressure * 0.9 - (oStyle === 'possession' ? 0.15 : oStyle === 'cycle' ? 0.06 : 0);
    if (this.ozPlays > 5) lTurn += 0.08 * (this.ozPlays - 5);
    if (sitA === 'PK') lTurn += 0.4;
    const pTurn = logistic(lTurn);
    let shootMod = oStyle === 'rush' ? 0.04 : oStyle === 'possession' ? -0.06 : oStyle === 'cycle' ? -0.03 : oStyle === 'dumpChase' ? 0.03 : 0;
    if (sitA === 'PP') {
      const pp = A.tactics.pp;
      shootMod = pp === 'shooting' ? 0.1 : pp === 'overload' ? -0.06 : pp === 'netFront' ? 0.03 : 0;
    }
    if (dStyle === 'passive') shootMod += 0.04;
    let pShot = 0.22 + 0.28 * this.setupQ + shootMod + (carrier.style.shoot - 1) * 0.07;
    if (this.ozPlays === 1 && this.rush) pShot += this.oddMan ? 0.35 : 0.14;
    if (this.ozPlays === 1 && this.turnoverFlag) pShot += 0.2;
    if (this.ozPlays === 1 && this.ozFaceoff) pShot += 0.08;
    if (this.oneTimerSetup) pShot += 0.25;
    pShot = clamp(pShot, 0.1, 0.85);
    const r = rng.next();
    if (r < pTurn) {
      this.advance(rng.float(2.5, 6));
      const d = this.pickW(B.onIce, (p) => Math.exp(0.5 * p.stickD) + (p.isF ? 0 : 0.3));
      const roll = rng.next();
      if (roll < 0.17) {
        d.stat.tk++;
        B.stats.tk++;
        this.ev('takeaway', B.idx, d.id, carrier.id, undefined, { zone: 'D' });
      } else if (roll < 0.37) {
        carrier.stat.gv++;
        A.stats.gv++;
        this.ev('giveaway', A.idx, carrier.id, d.id, undefined, { zone: 'O' });
      } else {
        this.ev('clear', B.idx, d.id);
      }
      const counter = pressure > 0.1 && rng.chance(0.18 * pressure * 4);
      this.changePossession(B.idx, 'D');
      this.transition = counter || rng.chance(0.15);
      this.carrier = d;
      return;
    }
    if (r < pTurn + (1 - pTurn) * pShot) {
      this.advance(rng.float(2, 5));
      this.takeShot(A, B, carrier, attack, defense, open);
      return;
    }
    // Pass / cycle: build the quality of the chance.
    this.advance(rng.float(3, 6.5) + (oStyle === 'possession' ? 0.8 : 0));
    const others = A.onIce.filter((p) => p !== carrier);
    if (!others.length) return;
    const pp = sitA === 'PP' ? A.tactics.pp : null;
    const receiver = this.pickW(others, (p) => {
      let w = Math.exp(0.25 * p.offIQ) * (0.6 + 0.4 * p.style.shoot);
      if (!p.isF) w *= pp === 'umbrella' ? 1.3 : sitA === 'PP' ? 0.9 : 0.75;
      if (pp === 'netFront') w *= 0.7 + 0.3 * p.style.netFront;
      return w;
    });
    const chem = A.input.chemistry ? A.input.chemistry(carrier.id, receiver.id) : 0;
    let gain = 0.085 + 0.03 * (this.val(carrier, 'pass') - defense * 0.55) + 0.03 * receiver.recv + chem * 0.05;
    if (oStyle === 'possession') gain += 0.025;
    if (oStyle === 'cycle') gain += 0.02 * (this.val(carrier, 'phys') + 0.5);
    if (pp === 'overload') gain += 0.035;
    if (sitA === "PP") gain += 0.05 + 0.02 * strDiff;
    gain += (open - 1) * 0.08;
    if (dStyle === 'passive') gain -= 0.015;
    gain = clamp(gain, 0.01, 0.3);
    this.setupQ = clamp(this.setupQ + gain, 0, 1);
    const pCross = clamp(0.1 + 0.05 * carrier.pass + 0.04 * carrier.style.pass + (pp === 'umbrella' || pp === 'shooting' ? 0.05 : 0), 0.02, 0.35);
    this.oneTimerSetup = rng.chance(pCross);
    this.addChain(carrier);
    this.ev('pass', A.idx, carrier.id, receiver.id, undefined, { big: this.oneTimerSetup });
    this.carrier = receiver;
    // Board battle / hit during the cycle.
    if (rng.chance(0.05 * (oStyle === 'cycle' ? 1.4 : 1))) {
      const d = this.pickW(B.onIce, (p) => p.hitProp);
      if (rng.chance(0.55 * d.hitProp)) this.hit(d, receiver);
    }
  }

  private takeShot(A: ST, B: ST, shooter: SP, attack: number, defense: number, open: number, reboundCtx = false): void {
    const rng = this.rng;
    const sitA = this.situation(A.idx);
    const pp = sitA === 'PP' ? A.tactics.pp : null;
    const pkStyle = sitA === 'PP' ? B.tactics.pk : null;
    // ── location
    let pHD = 0.085 + 0.33 * this.setupQ + 0.1 * (shooter.style.netFront - 1) + (this.rush ? 0.05 : 0) + (this.oddMan ? 0.27 : 0) + (this.turnoverFlag ? 0.12 : 0);
    pHD += (open - 1) * 0.3 + 0.02 * (attack - defense);
    if (pp === 'netFront') pHD += 0.06;
    if (pkStyle === 'box') pHD -= 0.06;
    if (B.tactics.defense === 'passive') pHD -= 0.03;
    if (B.goalie === null) pHD += 0.3;
    if (sitA === 'PK') pHD -= 0.08;
    if (sitA === "PP") pHD += 0.13;
    let pLD = shooter.isF ? 0.34 - 0.25 * this.setupQ - 0.05 * (shooter.style.netFront - 1) : 0.72 - 0.25 * this.setupQ;
    if (pp === 'umbrella') pLD += 0.06;
    if (pp === 'shooting') pLD += 0.08;
    if (pkStyle === 'box') pLD += 0.06;
    pHD = clamp(pHD, 0.04, 0.9);
    pLD = clamp(pLD, 0.03, 0.85);
    if (pHD + pLD > 0.97) pLD = 0.97 - pHD;
    let danger: 'high' | 'medium' | 'low';
    let dist: number;
    if (reboundCtx) {
      danger = 'high';
      dist = rng.float(4, 14);
    } else {
      const r = rng.next();
      if (r < pHD) {
        danger = 'high';
        dist = rng.float(5, 20);
      } else if (r < pHD + pLD) {
        danger = 'low';
        dist = rng.float(36, 62);
      } else {
        danger = 'medium';
        dist = rng.float(20, 36);
      }
    }
    let angle = danger === 'high' ? rng.float(0, 45) : rng.float(0, 72);
    // ── shot type
    let type: ShotType;
    if (reboundCtx) type = 'rebound';
    else if (this.oneTimerSetup && danger !== 'low' && rng.chance(0.55)) type = 'oneTimer';
    else if (danger === 'low') type = rng.chance(shooter.isF ? 0.15 : 0.6) ? 'slap' : rng.chance(0.25) ? 'snap' : 'wrist';
    else if (danger === 'high') type = rng.chance(0.2) ? 'backhand' : rng.chance(0.04) ? 'wraparound' : rng.chance(0.25) ? 'snap' : 'wrist';
    else type = rng.chance(0.1) ? 'slap' : rng.chance(0.25) ? 'snap' : rng.chance(0.06) ? 'backhand' : 'wrist';
    // Point shots can be tipped by a net-front forward.
    if (danger === 'low' && !reboundCtx) {
      const tippers = A.onIce.filter((p) => p !== shooter && p.isF);
      if (tippers.length) {
        const tipper = this.pickW(tippers, (p) => p.style.netFront);
        const pTip = 0.11 * tipper.style.netFront + (pp === 'netFront' ? 0.06 : 0);
        if (rng.chance(pTip)) {
          this.addChain(shooter);
          shooter = tipper;
          type = 'tip';
          // Deflections happen anywhere from the crease to the high slot.
          dist = rng.float(5, 22);
          danger = dist < 20 ? 'high' : 'medium';
          angle = rng.float(0, 35);
        }
      }
    }
    // Screens: net-front bodies in shooting lanes.
    const screeners = A.onIce.filter((p) => p !== shooter && p.style.netFront > 1);
    const pScreen = danger === 'high' ? 0.05 : 0.12 + 0.07 * screeners.length + (pp === 'netFront' ? 0.08 : 0);
    const screened = B.goalie !== null && rng.chance(clamp(pScreen, 0, 0.45));
    // ── block
    let pBlock = danger === 'low' ? 0.36 : danger === 'medium' ? 0.2 : 0.085;
    pBlock *= 1 + 0.15 * this.avg(B, (p) => this.val(p, 'block'));
    if (pkStyle === 'box' || pkStyle === 'diamond') pBlock *= 1.12;
    if (B.tactics.defense === 'passive') pBlock *= 1.08;
    if (type === 'oneTimer' || type === 'tip' || type === 'rebound') pBlock *= 0.55;
    pBlock *= 1 / open;
    if (B.goalie === null) pBlock *= 0.6;
    shooter.stat.att++;
    A.stats.attempts++;
    for (const p of A.onIce) p.stat.cf++;
    for (const p of B.onIce) p.stat.ca++;
    if (rng.chance(pBlock)) {
      const blocker = this.pickW(B.onIce, (p) => Math.exp(0.6 * p.block) * (p.isF ? 0.7 : 1.3));
      blocker.stat.blocks++;
      B.stats.blocks++;
      shooter.stat.blockedAtt++;
      A.stats.blockedAtt++;
      this.ev('blocked', B.idx, blocker.id, shooter.id, undefined, { dist: Math.round(dist), angle: Math.round(angle) });
      if (rng.chance(TUNING.injuryBlock * blocker.injuryRisk * (type === 'slap' ? 1.5 : 1))) this.injure(blocker, 'block');
      if (rng.chance(0.42)) {
        this.setupQ *= 0.55;
        this.oneTimerSetup = false;
        this.rush = this.oddMan = this.turnoverFlag = false;
        this.carrier = this.pickW(A.onIce, () => 1);
      } else {
        this.changePossession(B.idx, 'D');
        this.carrier = blocker;
        this.transition = this.rng.chance(0.2);
      }
      return;
    }
    // ── miss / on net
    const pMissAvg = baseMissProbability(type, dist);
    const xgOnNet = baseGoalProbability({ dist, angle, type, rush: this.rush, oddMan: this.oddMan, screened, turnover: this.turnoverFlag, empty: B.goalie === null });
    const xg = (1 - pMissAvg) * xgOnNet;
    shooter.stat.ixg += xg;
    A.stats.xg += xg;
    for (const p of A.onIce) p.stat.xgf += xg;
    for (const p of B.onIce) p.stat.xga += xg;
    const passer = this.chain.length ? this.chain[this.chain.length - 1] : null;
    if (passer && passer !== shooter && passer.team === A.idx) passer.stat.ixa += xg;
    const accSkill = type === 'slap' ? this.val(shooter, 'slap') : this.val(shooter, 'acc');
    let lMiss = logit(pMissAvg) - 0.3 * accSkill + (shooter.fat < 0 ? -shooter.fat * 0.5 : 0);
    if (B.tactics.defense === 'aggressive' || pkStyle === 'aggressive') lMiss += 0.08;
    if (rng.chance(logistic(lMiss))) {
      shooter.stat.missed++;
      A.stats.missed++;
      this.ev('missed', A.idx, shooter.id, undefined, undefined, { dist: Math.round(dist), angle: Math.round(angle), shotType: type, xg, danger });
      if (rng.chance(0.42)) {
        this.setupQ *= 0.5;
        this.oneTimerSetup = false;
        this.rush = this.oddMan = this.turnoverFlag = false;
        this.carrier = this.pickW(A.onIce, () => 1);
      } else {
        this.changePossession(B.idx, 'D');
      }
      return;
    }
    // ── on goal
    shooter.stat.sog++;
    const zone = shotZone(dist, angle);
    const zs = (this.shotZones[shooter.id] ??= new Array(ZONE_COUNT * 2).fill(0));
    zs[zone]++;
    A.stats.shots++;
    A.stats.shotsByPeriod[Math.min(this.period, 4) - 1] = (A.stats.shotsByPeriod[Math.min(this.period, 4) - 1] ?? 0) + 1;
    const hd = danger === 'high';
    if (hd) A.stats.hdShots++;
    const g = B.goalie;
    if (!g) {
      this.ev('shot', A.idx, shooter.id, undefined, undefined, { dist: Math.round(dist), angle: Math.round(angle), shotType: type, xg, danger, en: true });
      zs[ZONE_COUNT + zone]++;
      this.scoreGoal(A, B, shooter, xg, type, true);
      return;
    }
    g.stat.sa++;
    g.stat.gxga += xgOnNet;
    if (hd) g.stat.hdsa++;
    this.ev('shot', A.idx, shooter.id, g.id, undefined, { dist: Math.round(dist), angle: Math.round(angle), shotType: type, xg, danger });
    const shooterSkill = this.shooterSkill(shooter, type);
    const gSkill = this.goalieSkill(g, B, danger, type, screened);
    const late = this.period >= 3 && this.periodLength - this.clock < 300 && Math.abs(this.score[0] - this.score[1]) <= 1;
    const clutch = late || this.input.playoff ? 0.05 * (shooter.clutch - 0.0) : 0;
    const adj = TUNING.shooterWeight * shooterSkill - TUNING.goalieWeight * gSkill + clutch + TUNING.finishOffset + this.ctx(A.idx) * 0.3 - this.ctx(B.idx) * 0.3;
    const pGoal = logistic(logit(xgOnNet) + adj);
    if (rng.chance(pGoal)) {
      if (hd) g.stat.hdga++;
      zs[ZONE_COUNT + zone]++;
      this.scoreGoal(A, B, shooter, xg, type, false);
      return;
    }
    // ── save
    const big = xgOnNet > 0.2;
    this.ev('save', B.idx, g.id, shooter.id, undefined, { big, xg: xgOnNet });
    if (big) this.bumpMomentum(B.idx, 0.06);
    let pReb = 0.07 - 0.03 * (g.gReb + g.form) + (type === 'slap' ? 0.03 : 0) + (type === 'tip' ? 0.02 : 0) + (screened ? 0.02 : 0);
    if (pp === 'shooting') pReb += 0.01;
    pReb = clamp(pReb, 0.02, 0.18);
    if (!reboundCtx && rng.chance(pReb)) {
      g.stat.reb++;
      // Battle for the loose puck in the crease.
      const att = this.pickW(A.onIce, (p) => (p.isF ? 1 : 0.4) * p.style.netFront * Math.exp(0.3 * p.offIQ));
      const def = this.pickW(B.onIce, (p) => (p.isF ? 0.6 : 1.3));
      const l = -0.35 + TUNING.contest * (0.5 * this.val(att, 'phys') + 0.5 * this.val(att, 'offIQ') - (0.5 * this.val(def, 'phys') + 0.5 * this.val(def, 'defIQ'))) + (pp === 'netFront' ? 0.25 : 0) + 0.25 * (open - 1);
      this.ev('rebound', A.idx, shooter.id);
      if (rng.chance(logistic(l))) {
        this.advance(rng.float(0.5, 1.5));
        this.addChain(shooter);
        this.setupQ = Math.max(this.setupQ, 0.5);
        this.takeShot(A, B, att, attack, defense, open, true);
        return;
      }
      this.advance(1);
      this.changePossession(B.idx, 'D');
      this.carrier = def;
      return;
    }
    const pFreeze = clamp(0.5 + 0.08 * g.gReb + (danger === 'low' ? -0.08 : 0.06), 0.25, 0.75);
    if (rng.chance(pFreeze)) {
      this.ev('freeze', B.idx, g.id);
      this.faceoff = B.idx;
      return;
    }
    if (rng.chance(0.4)) {
      this.setupQ *= 0.45;
      this.oneTimerSetup = false;
      this.rush = this.oddMan = this.turnoverFlag = false;
      this.carrier = this.pickW(A.onIce, () => 1);
    } else {
      this.changePossession(B.idx, 'D');
    }
  }

  private shooterSkill(p: SP, type: ShotType): number {
    const s = this.rawShooterSkill(p, type);
    // Diminishing returns at the elite end keep 90-goal seasons out of the league.
    return s > 1.15 ? 1.15 + (s - 1.15) * 0.4 : s;
  }

  private rawShooterSkill(p: SP, type: ShotType): number {
    switch (type) {
      case 'slap':
        return this.val(p, 'slap');
      case 'oneTimer':
        return 0.6 * this.val(p, 'oneT') + 0.4 * this.val(p, 'shot');
      case 'backhand':
        return 0.6 * this.val(p, 'back') + 0.4 * this.val(p, 'hands');
      case 'tip':
        return 0.5 * this.val(p, 'hands') + 0.5 * this.val(p, 'offIQ');
      case 'rebound':
        return 0.5 * this.val(p, 'offIQ') + 0.5 * this.val(p, 'hands');
      case 'wraparound':
        return this.val(p, 'hands');
      default:
        return this.val(p, 'shot');
    }
  }

  private goalieSkill(g: SP, t: ST, danger: 'high' | 'medium' | 'low', type: ShotType, screened: boolean): number {
    let s: number;
    if (type === 'rebound' || type === 'oneTimer' || danger === 'high') s = g.gHD;
    else if (danger === 'low') s = g.gLow;
    else s = g.gBase;
    if (screened) s = 0.5 * s + 0.5 * g.gScreen - 0.15;
    // Diminishing returns for elite goaltending.
    if (s > 1.1) s = 1.1 + (s - 1.1) * 0.5;
    return s + g.form + t.goalieConf + t.coachGk;
  }

  // ───────────────────────────── per-second engine ─────────────────────────────
  //
  // Every second, every player on the ice (skaters and goalies) looks at where
  // everyone is and picks what to do: the puck carrier weighs shooting,
  // passing to each teammate, carrying, dumping, clearing or protecting;
  // teammates choose where to get open; defenders choose whom to pressure,
  // mark or block; goalies set their angle. Choices are made independently and
  // simultaneously, with a little noise that shrinks with decision-making
  // ability. Then everything resolves: passes, shots, movement, stick
  // battles, loose pucks, offside and icing.

  /** Distances everyone reads this second: nearest opponent, and each skater's two closest markers. */
  private scanIce(): void {
    const [a, b] = this.teams;
    this.sitNow[0] = this.situation(0);
    this.sitNow[1] = this.situation(1);
    for (const t of this.teams)
      for (const p of t.onIce) {
        const e = p.e;
        const f = p.form;
        const fat = p.fat;
        e.skate = p.skate + f + fat;
        e.hands = p.hands + f + fat * 0.7;
        e.decide = p.decide + f + fat * 0.6;
        e.defIQ = p.defIQ + f + fat * 0.6;
        e.offIQ = p.offIQ + f + fat * 0.6;
        e.stickD = p.stickD + f + fat * 0.7;
        e.pass = p.pass + f + fat * 0.7;
        e.block = p.block + f + fat * 0.7;
        e.phys = p.phys + f + fat * 0.8;
      }
    for (const p of a.onIce) {
      p.near = 99;
      p.d1 = p.d2 = 99;
      p.d1p = null;
    }
    for (const p of b.onIce) {
      p.near = 99;
      p.d1 = p.d2 = 99;
      p.d1p = null;
    }
    for (const p of a.onIce)
      for (const q of b.onIce) {
        const d = dist(p.x, p.y, q.x, q.y);
        if (d < p.near) p.near = d;
        if (d < q.near) q.near = d;
        if (d < p.d1) {
          p.d2 = p.d1;
          p.d1 = d;
          p.d1p = q;
        } else if (d < p.d2) p.d2 = d;
        if (d < q.d1) {
          q.d2 = q.d1;
          q.d1 = d;
          q.d1p = p;
        } else if (d < q.d2) q.d2 = d;
      }
  }

  /** Each defender's distance to the puck carrier and his rank among teammates (0 = nearest). */
  private rankToCarrier(c: SP): void {
    const D = this.teams[1 - c.team].onIce;
    for (const p of D) p.dc = dist(p.x, p.y, c.x, c.y);
    for (const p of D) {
      let r = 0;
      for (const m of D) if (m !== p && m.dc < p.dc) r++;
      p.rank = r;
    }
  }

  private assignRoles(out: SP[]): void {
    const fw = out.filter((p) => p.isF);
    const dm = out.filter((p) => !p.isF);
    const want: Role[] = fw.length >= 3 ? ['C', 'LW', 'RW'] : fw.length === 2 ? ['C', 'RW'] : ['C'];
    const left = new Set(want);
    const unassigned: SP[] = [];
    for (const p of fw) {
      const r = p.pos as Role;
      if (left.has(r)) {
        p.role = r;
        left.delete(r);
      } else unassigned.push(p);
    }
    for (const p of unassigned) {
      const r = [...left][0];
      if (r) {
        p.role = r;
        left.delete(r);
      } else p.role = 'X';
    }
    const dRoles: Role[] = dm.length >= 2 ? ['LD', 'RD'] : ['LD'];
    dm.forEach((p, i) => (p.role = dRoles[i] ?? 'X'));
  }

  private frame(): TrackFrame {
    const players: TrackFrame['players'] = [];
    for (const t of this.teams) {
      for (const p of t.onIce) players.push([p.id, Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, t.idx]);
      if (t.goalie) players.push([t.goalie.id, Math.round(t.goalie.x * 10) / 10, Math.round(t.goalie.y * 10) / 10, t.idx]);
    }
    const acts: Record<number, string> = {};
    for (const t of this.teams) for (const p of t.onIce) if (p.plan) acts[p.id] = p.plan.act;
    return { t: this.elapsed, period: this.period, clock: this.clock, puck: [Math.round(this.puck.x * 10) / 10, Math.round(this.puck.y * 10) / 10], carrier: this.puck.carrier?.id ?? null, players, acts };
  }

  /** Scoring value of a spot in the attacking frame (expected goals for an average unblocked wrist shot). */
  private spotVal(u: number, v: number, empty: boolean): number {
    if (u < BLUE_LINE) return 0;
    const iu = Math.min(SPOT_U - 1, Math.max(0, Math.round(u) - BLUE_LINE));
    const iv = Math.min(SPOT_V - 1, Math.max(0, Math.round(v + 43)));
    return (empty ? SPOT_EMPTY : SPOT_TABLE)[iu * SPOT_V + iv];
  }

  /** Cheap zero-mean noise with standard deviation sd (a decision's judgement error). */
  private jitter(sd: number): number {
    // Judgement errors are redrawn every tick: scale them so a second of play carries the same noise at any tick rate.
    return (this.rng.next() - 0.5) * 3.464 * sd * AGENT.noise;
  }

  private nearestDist(x: number, y: number, list: SP[]): number {
    let m = 99;
    for (const o of list) {
      const d = dist(o.x, o.y, x, y);
      if (d < m) m = d;
    }
    return m;
  }

  private aggression(t: ST): number {
    if (this.isPK(t.idx)) return t.tactics.pk === 'aggressive' ? 0.75 : t.tactics.pk === 'passive' ? 0.5 : 0.6;
    // Systems change how hard players chase the puck, within a band: none of them is simply better.
    const d = t.tactics.defense;
    const base = d === 'aggressive' ? 0.88 : d === 'physical' ? 0.84 : d === 'passive' ? 0.66 : d === 'trap' ? 0.64 : 0.76;
    return 1 + (base - 1) * t.tacMult.def;
  }

  private shootTac(t: ST, pp: boolean): number {
    if (pp) return t.tactics.pp === 'shooting' ? 1.2 : t.tactics.pp === 'overload' ? 0.9 : 1;
    const o = t.tactics.offense;
    return o === 'rush' ? 1.04 : o === 'possession' ? 0.96 : o === 'cycle' ? 0.98 : o === 'dumpChase' ? 1.02 : 1;
  }

  private setPoss(side: Side, carrier: SP | null): void {
    if (carrier !== this.puck.carrier) this.gotPuckAt = this.elapsed;
    if (side !== this.poss) {
      // Lost it in our own end: the coach notices.
      if (this.zone === 'D') {
        const loser = this.teams[this.poss];
        loser.dzLoss.push(this.elapsed);
        if (loser.dzLoss.length > 8) loser.dzLoss.shift();
      }
      this.poss = side;
      this.resetPossession();
      this.possSince = this.elapsed;
      this.entryAt = -99;
      this.transition = true;
    }
    this.puck.carrier = carrier;
    this.puck.dead = false;
    if (carrier) {
      this.puck.x = carrier.x;
      this.puck.y = carrier.y;
    }
  }

  private loosePuck(x: number, y: number): void {
    [this.puck.x, this.puck.y] = clampToIce(x, y);
    this.puck.carrier = null;
    this.puck.dead = false;
  }

  /** Team whose attacking zone the puck is in. The puck has to cross the whole (1 ft) blue line to get in or out, so skating along the line doesn't flicker it in and out. */
  private ozFor: Side | null = null;

  private updateZone(): void {
    const u = this.puck.x * dirOf(this.poss);
    if (this.ozFor !== this.poss) this.ozFor = u > BLUE_LINE ? this.poss : null;
    else if (u < BLUE_LINE - 1) this.ozFor = null;
    this.zone = this.ozFor === this.poss ? 'O' : u < -BLUE_LINE ? 'D' : 'N';
  }

  private placeGoalies(): void {
    for (const t of this.teams) {
      const g = t.goalie;
      if (!g) continue;
      const d = dirOf(t.idx);
      const gx = -GOAL_LINE * d;
      const dx = this.puck.x - gx;
      const dy = this.puck.y;
      const len = Math.hypot(dx, dy) || 1;
      // Out to the top of the crease against shots from the slot, deeper when the puck is far or behind the net.
      const depth = dx * d < 0 ? 0.5 : len < 30 ? 3.5 : 2.5;
      g.x = gx + (dx / len) * depth;
      g.y = (dy / len) * depth;
      this.decisions++;
    }
  }

  private formationSpot(role: Role, isTaker: boolean): [number, number] {
    if (isTaker) return [-1.5, 0];
    switch (role) {
      case 'LW':
        return [-2, -15];
      case 'RW':
        return [-2, 15];
      case 'LD':
        return [-24, -10];
      case 'RD':
        return [-24, 10];
      case 'C':
        return [-1.5, 0];
      default:
        return [-8, 6];
    }
  }

  private agentFaceoff(): void {
    const spot = this.faceoff!;
    let fx = 0;
    let fy = 0;
    if (spot !== 'C') {
      fx = -69 * dirOf(spot as Side);
      fy = this.puck.y >= 0 ? 22 : -22;
    }
    const [t0, t1] = this.teams;
    const c0 = this.center(t0);
    const c1 = this.center(t1);
    if (!c0 || !c1) {
      this.faceoff = null;
      return;
    }
    for (const t of this.teams) {
      const d = dirOf(t.idx);
      const taker = t.idx === 0 ? c0 : c1;
      for (const p of t.onIce) {
        const [ou, ov] = this.formationSpot(p.role, p === taker);
        [p.x, p.y] = clampToIce(fx + ou * d, fy + ov);
        p.vx = p.vy = 0;
      }
    }
    this.puck.x = fx;
    this.puck.y = fy;
    this.placeGoalies();
    this.decisions += t0.onIce.length + t1.onIce.length;
    const l = 0.75 * (this.val(c0, 'fo') - this.val(c1, 'fo')) + this.homeAdv * 0.8;
    const w: Side = this.rng.chance(logistic(l)) ? 0 : 1;
    const winner = w === 0 ? c0 : c1;
    const loser = w === 0 ? c1 : c0;
    winner.stat.fow++;
    loser.stat.fol++;
    this.teams[w].stats.fow++;
    this.teams[1 - w].stats.fol++;
    this.poss = w;
    this.resetPossession();
    this.possSince = this.elapsed;
    this.entryAt = -99;
    const carrier = this.pickW(this.teams[w].onIce, (p) => (p === winner ? 0.3 : p.isF ? 0.7 : 1.5));
    if (carrier !== winner) this.addChain(winner);
    this.faceoff = null;
    this.noChange = -1;
    this.setPoss(w, carrier);
    this.updateZone();
    if (this.zone === 'O') this.entryAt = this.elapsed;
    this.ev('faceoff', w, winner.id, loser.id, undefined, { zone: this.zone });
    for (const t of this.teams)
      for (const p of t.onIce) {
        p.plan = null;
        p.last = null;
      }
    if (this.input.recordTrack) this.track.push(this.frame());
    this.advance(1);
  }

  /** One decision tick of play (a quarter of a second by default). */
  private tick(): void {
    if (this.faceoff !== null) {
      this.agentFaceoff();
      return;
    }
    if (!this.puck.carrier && this.puck.dead) this.loosePuck(this.puck.x, this.puck.y);
    // A carrier who just went off (change, penalty, injury) leaves the puck where he was.
    if (this.puck.carrier && (!this.puck.carrier.onIce || this.puck.carrier.out)) this.loosePuck(this.puck.x, this.puck.y);
    // 1. Everyone decides at once, from the same picture of the ice.
    for (const t of this.teams)
      for (const p of t.onIce) {
        p.last = p.plan?.act ?? null;
        p.lastTarget = p.plan?.target ?? null;
        p.plan = null;
      }
    const carrier = this.puck.carrier;
    this.scanIce();
    if (carrier) this.rankToCarrier(carrier);
    for (const t of this.teams) {
      for (const p of t.onIce) {
        this.decisions++;
        let plan: Plan;
        if (p === carrier) plan = this.decideCarrier(p);
        else if (!carrier) plan = this.decideLoose(p);
        else if (carrier.team === p.team) plan = this.decideSupport(p, carrier);
        else plan = this.decideDefender(p, carrier);
        p.plan = plan;
      }
    }
    this.placeGoalies();
    const startU = this.puck.x * dirOf(this.poss);
    const wasIn = this.ozFor === this.poss;
    const startPoss = this.poss;
    // 2. The puck carrier acts first: passes and shots beat the skaters' feet.
    let passed = false;
    if (carrier) {
      const plan = carrier.plan!;
      const A = this.teams[carrier.team];
      const B = this.teams[1 - carrier.team];
      switch (plan.act) {
        case 'shoot':
          this.agentShot(A, B, carrier);
          break;
        case 'pass':
          passed = true;
          this.agentPass(A, B, carrier, plan.target!);
          break;
        case 'dump':
          if (SHOT_DEBUG) {
            const k = `dump:u${Math.round((carrier.x * dirOf(carrier.team)) / 5) * 5}:${this.acquired}:${A.tactics.offense}`;
            SHOT_DEBUG[k] = (SHOT_DEBUG[k] ?? 0) + 1;
          }
          this.agentDump(A, carrier, false);
          break;
        case 'clear':
          this.agentDump(A, carrier, true);
          break;
        default:
          break;
      }
    }
    if (this.faceoff !== null || this.finished) return this.endTick();
    // 3. Everyone skates toward where he chose to be — all at once, from where they stood.
    this.blockedBy = null;
    const moves: (SP | number)[] = [];
    for (const t of this.teams) {
      for (const p of t.onIce) {
        const plan = p.plan;
        if (!plan) continue;
        const withPuck = this.puck.carrier === p;
        let spd = AGENT.speed + AGENT.speedZ * p.e.skate;
        let tx = plan.tx;
        let ty = plan.ty;
        if (withPuck) spd *= 0.9;
        if (withPuck && plan.act !== 'hold') {
          // A defender standing in his path stops him: no skating through bodies.
          const len = dist(p.x, p.y, plan.tx, plan.ty);
          if (len > 0.5) {
            for (const o of this.teams[1 - p.team].onIce) {
              const tt = along(o.x, o.y, p.x, p.y, plan.tx, plan.ty);
              if (tt <= 0 || distToSegment(o.x, o.y, p.x, p.y, plan.tx, plan.ty) > 3.5) continue;
              spd = Math.min(spd, Math.max(0, tt * len - 3) / AGENT.tick);
              this.blockedBy = o;
            }
          }
          // Walled off: he doesn't stand there, he cuts across to protect it.
          if (this.blockedBy && spd < 5) {
            [tx, ty] = this.protect(p, true);
            spd = (AGENT.speed + AGENT.speedZ * p.e.skate) * 0.6;
          }
        }
        spd = clamp(spd, 0, 25) * AGENT.tick;
        moveTo(p.x, p.y, tx, ty, spd);
        if (AGENT.accel > 0) {
          // Momentum: he can only change his velocity so fast (quicker with better skating).
          const dt = AGENT.tick;
          const A = AGENT.accel + 4 * p.e.skate;
          let wx = (OUT[0] - p.x) / dt;
          let wy = (OUT[1] - p.y) / dt;
          // He eases off as he gets there, so he can stop on his spot instead of gliding past it.
          const left = dist(p.x, p.y, tx, ty);
          const wl = Math.sqrt(wx * wx + wy * wy);
          const vstop = Math.sqrt(2 * A * left);
          if (wl > vstop && wl > 1e-6) {
            wx *= vstop / wl;
            wy *= vstop / wl;
          }
          let ax = wx - p.vx;
          let ay = wy - p.vy;
          const amax = A * dt;
          const al = Math.sqrt(ax * ax + ay * ay);
          if (al > amax) {
            ax *= amax / al;
            ay *= amax / al;
          }
          const vx = p.vx + ax;
          const vy = p.vy + ay;
          moveTo(p.x, p.y, p.x + vx * dt, p.y + vy * dt, 99);
          // Ahead of the puck he pulls up at the blue line rather than glide in offside.
          const d = dirOf(p.team);
          if (!withPuck && this.poss === p.team && this.puck.carrier && this.ozFor !== p.team && p.x * d <= BLUE_LINE - 0.5 && OUT[0] * d > BLUE_LINE - 0.5) OUT[0] = (BLUE_LINE - 0.5) * d;
          // The boards and the crease stop him.
          p.vx = (OUT[0] - p.x) / dt;
          p.vy = (OUT[1] - p.y) / dt;
        }
        moves.push(p, OUT[0], OUT[1]);
      }
    }
    for (let k = 0; k < moves.length; k += 3) {
      const p = moves[k] as SP;
      p.x = moves[k + 1] as number;
      p.y = moves[k + 2] as number;
    }
    if (this.puck.carrier) {
      this.puck.x = this.puck.carrier.x;
      this.puck.y = this.puck.carrier.y;
    }
    // 4. Contact: pressure on the puck carrier, hits, loose-puck races.
    this.resolveContact();
    if (this.faceoff !== null || this.finished) return this.endTick();
    if (!this.puck.carrier) this.resolveLoose();
    if (this.faceoff !== null || this.finished) return this.endTick();
    // 5. Lines: breakouts, zone entries, offside.
    const c = this.puck.carrier;
    if (c && this.poss === startPoss) {
      const u = c.x * dirOf(c.team);
      if (startU <= -BLUE_LINE && u > -BLUE_LINE) this.ev('breakout', c.team, c.id);
      if (!wasIn && startU <= BLUE_LINE && u > BLUE_LINE && !passed) {
        const A = this.teams[c.team];
        const offside = A.onIce.some((m) => m !== c && m.x * dirOf(c.team) > BLUE_LINE + 0.5);
        if (offside && this.rng.chance(0.92)) {
          this.ev('offside', c.team, c.id);
          this.faceoff = 'C';
          this.puck.carrier = null;
          return this.endTick();
        }
        const B = this.teams[1 - c.team];
        const att = A.onIce.filter((m) => m.x * dirOf(c.team) >= u - 14).length;
        const back = B.onIce.filter((m) => m.x * dirOf(c.team) > u).length;
        this.entryAt = this.elapsed;
        this.entryRush = this.elapsed - this.possSince <= 7;
        this.entryOdd = att > back;
        this.addChain(c);
        this.ev('entry', c.team, c.id, undefined, undefined, { rush: this.entryRush, oddMan: this.entryOdd, success: true });
      }
    }
    this.endTick();
  }

  private endTick(): void {
    if (this.faceoff !== null) {
      this.puck.carrier = null;
      this.puck.dead = true;
    }
    this.updateZone();
    // Who's pinned in their own end, smoothed over about a minute.
    const k = AGENT.tick / 60;
    for (const t of this.teams) t.pinned += ((this.poss !== t.idx && this.zone === 'O' && this.faceoff === null ? 1 : 0) - t.pinned) * k;
    if (Math.floor(this.elapsed / 15) !== Math.floor((this.elapsed + AGENT.tick) / 15)) for (const t of this.teams) this.coachAdjust(t);
    if (this.input.recordTrack) this.track.push(this.frame());
    this.advance(AGENT.tick);
  }

  /**
   * The bench reads the game and changes the system: chase it late when
   * trailing, lock it down late with a lead, get pucks deep after a run of
   * giveaways in their own end, collapse in front when pinned. Sharper
   * tactical coaches react sooner. Changes are to how the team plays (the
   * same decisions and contests as always), never to the score.
   */
  private coachAdjust(t: ST): void {
    if (this.inShootout || this.finished) return;
    const i = t.idx;
    const diff = this.score[i] - this.score[1 - i];
    const left = this.periodLength - this.clock;
    const reg3 = this.period === 3;
    const sharp = t.coachTac; // 0.6..1.4
    const recentLoss = t.dzLoss.filter((x) => this.elapsed - x < 240).length;
    let want: string | null = null;
    if (reg3 && diff < 0 && diff >= -2 && left < 300 + 240 * sharp) want = 'chasing';
    else if (reg3 && diff > 0 && diff <= 2 && left < 180 + 240 * sharp) want = 'protecting';
    else if (t.adjust === 'simplify' && this.elapsed < t.adjustUntil) want = 'simplify';
    else if (t.adjust === 'pinned' && this.elapsed < t.adjustUntil) want = 'pinned';
    else if (recentLoss >= (sharp > 1.1 ? 5 : 6) && t.base.offense !== 'dumpChase') want = 'simplify';
    else if (t.pinned > 0.55 - 0.08 * (sharp - 1)) want = 'pinned';
    if (want === t.adjust) return;
    const b = t.base;
    if (want === null) {
      t.tactics = { ...b };
      t.adjust = null;
      this.ev('adjustment', i, undefined, undefined, undefined, { adjust: 'reset' });
      return;
    }
    if (want === 'chasing') t.tactics = { ...b, forecheck: '2-1-2', defense: 'aggressive', offense: b.offense === 'possession' || b.offense === 'cycle' ? 'cycle' : 'rush' };
    else if (want === 'protecting') t.tactics = { ...b, forecheck: '1-3-1', defense: 'trap', offense: 'possession' };
    else if (want === 'simplify') {
      t.tactics = { ...b, offense: 'dumpChase' };
      t.adjustUntil = this.elapsed + 240;
    } else {
      t.tactics = { ...b, defense: 'passive' };
      t.adjustUntil = this.elapsed + 90;
    }
    t.adjust = want;
    this.ev('adjustment', i, undefined, undefined, undefined, { adjust: want });
  }

  // ── decisions ──

  private decideCarrier(p: SP): Plan {
    const A = this.teams[p.team];
    const B = this.teams[1 - p.team];
    const d = dirOf(p.team);
    const u = p.x * d;
    const v = p.y;
    const opp = B.onIce;
    const sit = this.situation(p.team);
    const pp = sit === 'PP';
    const pk = sit === 'PK';
    const empty = B.goalie === null;
    const sd = clamp(0.16 - 0.05 * p.e.decide, 0.05, 0.3);
    let bestU = -Infinity;
    let bAct: Act = 'hold';
    let bx = p.x;
    let by = p.y;
    let bt: SP | undefined;
    const consider = (util: number, act: Act, tx: number, ty: number, target?: SP) => {
      // Players commit to a play: sticking with it beats switching unless something clearly better opens up.
      const x = util + this.jitter(sd) + (act === p.last && (target ?? null) === p.lastTarget ? AGENT.commit : 0);
      if (x > bestU) {
        bestU = x;
        bAct = act;
        bx = tx;
        by = ty;
        bt = target;
      }
    };
    const gx = GOAL_LINE * d;
    const pressure = p.near;
    // Just got it: settle the puck first (a one-timer or a rebound goes straight back out).
    const settling = this.elapsed - this.gotPuckAt < AGENT.settle;
    const quick = (this.elapsed - this.crossSlotAt <= 1 && this.lastReceiver === p) || this.elapsed - this.reboundAt <= 1.5;
    // Shoot.
    if ((u > BLUE_LINE || (empty && u > -40)) && (!settling || quick)) {
      const g = shotGeometry(u, v);
      let xs = baseGoalProbability({ dist: g.dist, angle: g.angle, type: 'wrist', empty }) * (1 - baseMissProbability('wrist', g.dist));
      let lane = 0;
      for (const o of opp) if (distToSegment(o.x, o.y, p.x, p.y, gx, 0) < 3.5 && along(o.x, o.y, p.x, p.y, gx, 0) < 0.92) lane++;
      xs *= Math.pow(0.62, lane);
      // From behind the goal line there is almost nothing to shoot at.
      if (u > GOAL_LINE - 2) xs *= 0.2;
      // A defender on top of him hurries the shot.
      if (pressure < 5) xs *= 0.45 + 0.11 * pressure;
      let screens = 0;
      for (const m of A.onIce) if (m !== p && m.x * d > 74 && Math.abs(m.y) < 9) screens++;
      const ozTime = this.entryAt > 0 ? this.elapsed - Math.max(this.entryAt, this.possSince) : 0;
      // Getting pucks to the net from distance pays off through tips, screens and rebounds when there's traffic.
      const traffic = g.dist > 28 ? Math.min(2, screens) * AGENT.traffic + (p.isF ? 0 : AGENT.pointShot) : 0;
      let util = xs * AGENT.shoot * p.style.shoot * this.shootTac(A, pp) + traffic * (lane ? 0.4 : 1) + Math.min(0.2, ozTime * 0.01) - AGENT.shootBar;
      if (this.elapsed - this.crossSlotAt <= 1 && this.lastReceiver === p) util += 0.25;
      // Chasing the game: get pucks to the net. Protecting a lead: only good looks.
      util += AGENT.urgency * this.scoreEffect(p.team);
      if (this.elapsed - this.reboundAt <= 2 && g.dist < 15) util += 0.4;
      // Empty net: only with a clear lane, and not from so deep that a miss is icing.
      if (empty) util = xs * 1.2 - 0.55 - lane * 0.8 - (u < 0 ? 0.6 : 0) - (g.dist > 110 ? 0.5 : 0);
      consider(util, 'shoot', p.x, p.y);
    }
    // Pass to each teammate.
    for (const m of A.onIce) {
      if (m === p || settling) continue;
      if (Math.abs(m.x - p.x) > 110) continue;
      const mu = m.x * d;
      const mv = m.y;
      // A pass across the blue line to someone already inside is offside.
      if (this.ozFor !== p.team && mu > BLUE_LINE + 0.5) continue;
      let risk = 0;
      const lx = Math.min(p.x, m.x) - 10;
      const hx = Math.max(p.x, m.x) + 10;
      const ly = Math.min(p.y, m.y) - 10;
      const hy = Math.max(p.y, m.y) + 10;
      for (const o of opp) {
        if (o.x < lx || o.x > hx || o.y < ly || o.y > hy) continue;
        const dl = distToSegment(o.x, o.y, p.x, p.y, m.x, m.y);
        if (dl < 10) risk = 1 - (1 - risk) * (1 - Math.exp(-dl / 3.2) * (0.5 + 0.1 * o.defIQ));
      }
      const len = dist(p.x, p.y, m.x, m.y);
      risk += len / 450;
      const open = Math.min(25, m.near);
      // A man in the slot is only worth finding if he's actually open.
      const gain = mu > BLUE_LINE ? (this.spotVal(mu, mv, empty) * clamp((open - 2) / 10, 0.15, 1) - this.spotVal(Math.max(u, BLUE_LINE), v, empty)) * AGENT.shoot : 0;
      const prog = clamp((mu - u) * 0.004, -0.15, 0.25);
      let util = 0.08 + gain * AGENT.passGain + prog + open * 0.008 + (A.tactics.offense === 'possession' ? 0.03 : 0) + (pp ? 0.05 : 0) + (p.style.pass - 1) * 0.12 - risk * AGENT.passRisk;
      if (pressure < 5) util += 0.06;
      consider(util, 'pass', m.x, m.y, m);
    }
    // Carry.
    let front = 40;
    for (const o of opp) {
      const ou = o.x * d - u;
      const ov = o.y - v;
      if (ou > -2 && ou < 30 && Math.abs(ov) < 14) front = Math.min(front, Math.hypot(ou, ov));
    }
    let tu: number;
    let tv: number;
    if (u > BLUE_LINE) {
      // In the zone: drive the slot if it's open, otherwise work the wall or walk the line.
      const opts: [number, number, number][] = [
        [Math.min(GOAL_LINE - 6, u + 10), v * 0.55, 0.06],
        [clamp(u + this.rng.float(-10, 6), 50, GOAL_LINE + 4), (Math.sign(v) || 1) * clamp(Math.abs(v) + 4, 22, 38), 0],
        [p.isF ? u : 58, clamp(v + (v > 0 ? -12 : 12), -28, 28), p.isF ? -0.04 : 0.04],
      ];
      tu = opts[0][0];
      tv = opts[0][1];
      let bestScore = -Infinity;
      for (const [ou, ov, bias] of opts) {
        let block = 99;
        for (const o of opp) block = Math.min(block, distToSegment(o.x, o.y, p.x, p.y, ou * d, ov));
        const sc = this.spotVal(ou, ov, empty) * AGENT.shoot * 0.5 + Math.min(block, 12) * 0.03 + bias + this.jitter(sd);
        if (sc > bestScore) {
          bestScore = sc;
          tu = ou;
          tv = ov;
        }
      }
    } else {
      tu = u + 26;
      tv = v;
      let bestOpen = -1;
      for (const dv of [-12, 0, 12]) {
        const cv = clamp(v + dv, -36, 36);
        const o = this.nearestDist(tu * d, cv, opp);
        if (o > bestOpen) {
          bestOpen = o;
          tv = cv;
        }
      }
    }
    let carryU = 0.15 + 0.1 * Math.min(1.5, front / 20) + 0.04 * (p.e.skate + p.e.hands) + (u < BLUE_LINE ? 0.08 : 0);
    if (pressure < 4.5) carryU -= 0.22 - 0.06 * p.e.hands;
    // He usually sees a teammate offside and holds up — not always.
    if (u > BLUE_LINE - 18 && this.ozFor !== p.team && A.onIce.some((m) => m !== p && m.x * d > BLUE_LINE + 0.5)) carryU -= 0.35 * clamp(0.8 + 0.15 * p.e.decide, 0.5, 1);
    consider(carryU, 'carry', tu * d, tv);
    // Dump it in.
    // Over the red line only: from his own half it would be icing.
    if (u > 8 && u <= BLUE_LINE + 2 && !settling) {
      const o = A.tactics.offense;
      // Dump it in when the blue line is closed (or the system says so).
      let atLine = 0;
      for (const q of opp) {
        const qu = q.x * d;
        if (qu > BLUE_LINE - 6 && qu < BLUE_LINE + 14 && Math.abs(q.y - v) < 22) atLine++;
      }
      const closed = front < 8 && atLine >= 2;
      // Only dump-and-chase teams lean on it; everyone else would rather regroup and try again.
      let dumpU = -0.16 + (closed ? (o === 'dumpChase' ? 0.38 : o === 'cycle' ? 0.22 : 0.06) : front < 10 && o === 'dumpChase' ? 0.1 : 0);
      const tired = A.onIce.reduce((s, m) => s + m.energy, 0) / Math.max(1, A.onIce.length) < 55;
      if (tired) dumpU += 0.15;
      if (u < 0 && !pk) dumpU -= 0.55;
      consider(dumpU, 'dump', p.x, p.y);
    }
    // Clear the zone.
    // Clearing gives the puck away: a last resort when he's being run (or killing a penalty).
    if (u < -BLUE_LINE && !settling) consider((pressure < 3.5 ? 0.08 : -0.3) + (pk ? 0.35 : 0) - AGENT.clearCost, 'clear', p.x, p.y);
    // Protect it and wait for something to open.
    const holdTarget = this.protect(p, false);
    // Nobody holds it forever: the longer he's waited, the more he wants to make a play.
    const held = p.last === 'hold' ? Math.max(0, this.elapsed - p.holdSince - AGENT.holdFor) : 0;
    consider(0.04 + 0.03 * p.e.hands + (u > BLUE_LINE ? 0.05 : u < -BLUE_LINE ? 0.02 : -0.01) - held * AGENT.holdTire, 'hold', holdTarget[0], holdTarget[1]);
    if (bAct === 'hold') {
      if (p.last !== 'hold') p.holdSince = this.elapsed;
      this.protect(p, true);
    }
    return { act: bAct, tx: bx, ty: by, target: bt };
  }

  /**
   * Protecting the puck he keeps his feet moving the way players do: walking
   * the wall, sliding along the blue line at the point, or cutting across the
   * ice, with a cutback now and then and whenever he runs out of room. Never
   * toward or away from anyone in particular. Returns his next spot; `keep`
   * commits the step.
   */
  private protect(p: SP, keep: boolean): [number, number] {
    const d = dirOf(p.team);
    const u = p.x * d;
    // Fresh: start toward the middle of the ice.
    let dir = this.elapsed - p.protT > AGENT.tick * 1.5 ? (p.y >= 0 ? -1 : 1) : p.protDir;
    if (keep && this.rng.chance(0.08)) dir = -dir;
    const corner = Math.abs(p.x) > 80;
    const wall = !corner && Math.abs(p.y) > 31;
    const point = !wall && !corner && this.ozFor === p.team && u > BLUE_LINE && u < 64;
    const STEP = 6;
    const aim = (k: number): [number, number] => {
      if (wall) return [p.x + k * d * STEP, p.y]; // along the boards
      return [p.x, p.y + k * STEP]; // across: behind the net, along the line, or through the middle
    };
    let [tx, ty] = aim(dir);
    // Out of room: cut back.
    const tu = tx * d;
    const out = wall ? tu > 84 || (this.ozFor === p.team ? tu < BLUE_LINE + 3 : tu < -84) : Math.abs(ty) > (point ? 22 : corner ? 28 : 30);
    if (out) {
      dir = -dir;
      [tx, ty] = aim(dir);
    }
    if (keep) {
      p.protDir = dir;
      p.protT = this.elapsed;
    }
    // Protecting it, he doesn't wander across the blue line either way.
    if (this.ozFor !== p.team && tx * d > BLUE_LINE - 0.5 && p.x * d <= BLUE_LINE) tx = (BLUE_LINE - 0.5) * d;
    if (this.ozFor === p.team && tx * d < BLUE_LINE + 1.5) tx = (BLUE_LINE + 1.5) * d;
    const c = clampToIce(tx, ty);
    return [c[0], c[1]];
  }

  private structure(p: SP, hasPuck: boolean): [number, number] {
    const t = this.teams[p.team];
    const d = dirOf(p.team);
    const pu = this.puck.x * d;
    const c = this.puck.carrier;
    const onside = hasPuck && (!c || this.ozFor !== p.team);
    const o = this.sOpts[p.team];
    o.forecheck = t.tactics.forecheck;
    o.defense = t.tactics.defense;
    o.offense = t.tactics.offense;
    o.pp = this.sitNow[p.team] === 'PP';
    o.pk = this.sitNow[p.team] === 'PK';
    o.onside = onside;
    structureSpot(p.role, hasPuck, pu, this.puck.y, o);
    return [OUT[0] * d, OUT[1]];
  }

  private decideSupport(p: SP, carrier: SP): Plan {
    const A = this.teams[p.team];
    const B = this.teams[1 - p.team];
    const d = dirOf(p.team);
    const empty = B.goalie === null;
    const [sx, sy] = this.structure(p, true);
    const sd = clamp(0.12 - 0.04 * p.e.offIQ, 0.04, 0.25);
    let best: Plan = { act: 'support', tx: sx, ty: sy };
    let bestU = -Infinity;
    // A few spots around his place in the structure: he picks the most open, most dangerous one
    // (far from the play, his spot in the structure is the only sensible choice).
    const far = Math.abs(p.x - this.puck.x) > 70;
    for (let k = 0; k < (far ? 2 : SUPPORT_OFFSETS.length); k += 2) {
      const [qx, qy] = clampToIce(sx + SUPPORT_OFFSETS[k] * d, sy + SUPPORT_OFFSETS[k + 1]);
      if (this.ozFor !== p.team && qx * d > BLUE_LINE - 0.5) continue;
      const open = Math.min(20, this.nearestDist(qx, qy, B.onIce));
      const util = open * 0.02 + this.spotVal(qx * d, qy, empty) * AGENT.shoot * 0.6 - dist(p.x, p.y, qx, qy) * 0.002 + this.jitter(sd);
      if (util > bestU) {
        bestU = util;
        best.tx = qx;
        best.ty = qy;
      }
    }
    // Drive the net when the puck is in deep.
    if (p.isF && carrier.x * d > BLUE_LINE) {
      const util = 0.12 * p.style.netFront + (this.elapsed - this.reboundAt < 2 ? 0.3 : 0) + this.jitter(sd) + 0.1 + (p.last === 'drive' ? AGENT.commit : 0);
      if (util > bestU) best = { act: 'drive', tx: (GOAL_LINE - 9) * d, ty: clamp(p.y, -6, 6) };
    }
    // Stay onside: anyone caught inside the zone while the puck is out tags up.
    if (p.x * d > BLUE_LINE && this.ozFor !== p.team && this.rng.chance(clamp(0.95 + 0.03 * p.e.offIQ, 0.85, 0.99))) {
      best = { act: 'support', tx: (BLUE_LINE - 3) * d, ty: p.y };
    }
    void A;
    return best;
  }

  private decideDefender(p: SP, carrier: SP): Plan {
    const D = this.teams[p.team];
    const A = this.teams[carrier.team];
    const da = dirOf(carrier.team);
    const cu = carrier.x * da;
    const gx = GOAL_LINE * da;
    const sd = clamp(0.15 - 0.05 * p.e.defIQ, 0.05, 0.3);
    let bestU = -Infinity;
    let bAct: Act = 'cover';
    let bx = p.x;
    let by = p.y;
    let bt: SP | undefined;
    const consider = (util: number, act: Act, tx: number, ty: number, target?: SP) => {
      // Players commit to a play: sticking with it beats switching unless something clearly better opens up.
      const x = util + this.jitter(sd) + (act === p.last && (target ?? null) === p.lastTarget ? AGENT.commit : 0);
      if (x > bestU) {
        bestU = x;
        bAct = act;
        bx = tx;
        by = ty;
        bt = target;
      }
    };
    const dc = p.dc;
    const rank = p.rank;
    // Forecheck depth limits who chases deep in the attackers' end.
    const deep = D.tactics.forecheck === '2-1-2' ? 2 : D.tactics.forecheck === '1-3-1' || D.tactics.defense === 'trap' ? 1 : 1;
    // He can see who else is closer: the nearest man takes the puck, others think twice.
    let press = this.aggression(D) * Math.exp(-dc / 18) + (rank === 0 ? 0.32 : rank === 1 ? -0.2 : -0.55) + (cu > BLUE_LINE ? 0.08 : 0);
    if (cu < -BLUE_LINE && rank >= deep) press -= 0.5;
    if (this.isPK(p.team) && cu < BLUE_LINE) press -= 0.25;
    // Caught behind the play: skate to a spot in front of the carrier rather than chase his heels.
    // The net he defends is the one the carrier attacks.
    const ownGx = gx;
    const behind = dist(p.x, p.y, ownGx, 0) > dist(carrier.x, carrier.y, ownGx, 0) + 2;
    // Gap control: he skates to where the carrier is going, not where he was.
    let ptx = carrier.x + carrier.vx * AGENT.pressLead;
    let pty = carrier.y + carrier.vy * AGENT.pressLead;
    if (behind) {
      const gl = dist(carrier.x, carrier.y, ownGx, 0) || 1;
      ptx = carrier.x + ((ownGx - carrier.x) / gl) * 8;
      pty = carrier.y + ((0 - carrier.y) / gl) * 8;
      press -= 0.12;
    }
    consider(press, 'pressure', ptx, pty, carrier);
    // Finishing a check takes him out of the play for a moment: no second one straight after.
    if (dc < 10 && p.hitProp > 0.2 && this.elapsed - p.hitAt > AGENT.hitRecover && this.elapsed - carrier.hitTakenAt > AGENT.hitAgain) {
      const phys = D.tactics.defense === 'physical' ? 1.25 : 1;
      consider(AGENT.hit * hitLean(p) * phys + (Math.abs(carrier.y) > 30 ? 0.08 : 0) - 0.06, 'hit', carrier.x, carrier.y, carrier);
    }
    // Mark the dangerous men.
    for (const j of A.onIce) {
      if (j === carrier) continue;
      // Too far away to be his man this second.
      if (Math.abs(j.x - p.x) > 45 || Math.abs(j.y - p.y) > 45) continue;
      const ju = j.x * da;
      const threat = this.spotVal(ju, j.y, false) * AGENT.shoot + (ju > BLUE_LINE ? 0.05 : 0);
      const dj = dist(p.x, p.y, j.x, j.y);
      const taken = (j.d1p === p ? j.d2 : j.d1) < dj - 3;
      const util = threat * Math.exp(-dj / 20) + 0.04 - (taken ? 0.12 : 0);
      const gl = dist(gx, 0, j.x, j.y) || 1;
      consider(util, 'mark', j.x + ((gx - j.x) / gl) * 3, j.y + (-j.y / gl) * 3, j);
    }
    // Hold structure.
    const [sx, sy] = this.structure(p, false);
    consider(0.2 + 0.05 * p.e.defIQ, 'cover', sx, sy);
    // Get into the shooting lane.
    if (cu > 40 && distToSegment(p.x, p.y, carrier.x, carrier.y, gx, 0) < 10) {
      consider(0.24 + 0.08 * p.e.block, 'block', carrier.x + (gx - carrier.x) * 0.35, carrier.y * 0.65);
    }
    return bestU === -Infinity ? { act: 'cover', tx: sx, ty: sy } : { act: bAct, tx: bx, ty: by, target: bt };
  }

  private decideLoose(p: SP): Plan {
    const t = this.teams[p.team];
    const dp = dist(p.x, p.y, this.puck.x, this.puck.y);
    let rank = 0;
    for (const m of t.onIce) if (m !== p && dist(m.x, m.y, this.puck.x, this.puck.y) < dp) rank++;
    // After a dump-in the forecheckers go hard after it.
    const forecheck = p.team === this.dumpTeam && this.elapsed - this.dumpAt < 4 && p.isF ? 0.35 : 0;
    const chase = (rank === 0 ? 0.6 : rank === 1 ? 0.3 : -0.2) * Math.exp(-dp / 40) + forecheck + this.jitter(0.1);
    const [sx, sy] = this.structure(p, p.team === this.poss);
    if (chase > 0.12) return { act: 'chase', tx: this.puck.x, ty: this.puck.y };
    return { act: p.team === this.poss ? 'support' : 'cover', tx: sx, ty: sy };
  }

  // ── resolution ──

  private agentPass(A: ST, B: ST, p: SP, m: SP): void {
    const d = dirOf(A.idx);
    const mu = m.x * d;
    const zoneTo: 'O' | 'N' | 'D' = mu > BLUE_LINE ? 'O' : mu < -BLUE_LINE ? 'D' : 'N';
    // The chance it gets through, built up as each risk is rolled (for the record, not the roll).
    let pThrough = 1;
    const passEv = (success: boolean, outcome: string, extra?: GameEvent['data']) => {
      const id = this.ev('pass', A.idx, p.id, m.id, undefined, { success, outcome, zone: zoneTo, p: Math.round(pThrough * 1000) / 1000, ...extra });
      this.lastPassEv = { id, team: A.idx, t: this.elapsed };
      return id;
    };
    // Defenders along the lane may pick it off.
    const lanes = B.onIce
      .map((o) => ({ o, dl: distToSegment(o.x, o.y, p.x, p.y, m.x, m.y), t: along(o.x, o.y, p.x, p.y, m.x, m.y) }))
      .filter((x) => x.dl < 8)
      .sort((a, b) => a.t - b.t);
    for (const { o, dl } of lanes) {
      const pInt = clamp(Math.exp(-dl / 2.6) * (0.42 + 0.1 * o.e.defIQ + 0.06 * o.e.stickD) * AGENT.intercept - 0.05 * p.e.pass, 0, 0.9);
      pThrough *= 1 - pInt;
      if (this.rng.chance(pInt)) {
        this.causeNext = passEv(false, 'intercepted');
        const roll = this.rng.next();
        if (roll < 0.22) {
          p.stat.gv++;
          A.stats.gv++;
          this.ev('giveaway', A.idx, p.id, o.id, undefined, { zone: this.zone });
        } else if (roll < 0.22 + 0.5 * AGENT.tkCredit) {
          o.stat.tk++;
          B.stats.tk++;
          this.ev('takeaway', B.idx, o.id, p.id, undefined, { zone: this.zone });
        }
        this.takeawayAt = this.elapsed;
        this.takeawayOZ = o.x * dirOf(B.idx) > BLUE_LINE;
        this.setPoss(B.idx, o);
        return;
      }
    }
    const len = dist(p.x, p.y, m.x, m.y);
    const pBad = clamp(0.02 + len / 700 - 0.02 * p.e.pass - 0.015 * m.recv, 0.004, 0.25);
    pThrough *= 1 - pBad;
    if (this.rng.chance(pBad)) {
      passEv(false, 'off target');
      this.loosePuck(m.x + this.rng.float(-8, 8), m.y + this.rng.float(-8, 8));
      return;
    }
    // A tightly marked receiver has a stick on him as the puck arrives.
    let marker: SP | null = null;
    let md = 99;
    for (const o of B.onIce) {
      const dd = dist(o.x, o.y, m.x, m.y);
      if (dd < md) {
        md = dd;
        marker = o;
      }
    }
    const pStrip = marker && md < 5 ? logistic(-0.5 - md * 0.25 + TUNING.contest * 2 * (0.5 * marker.e.stickD + 0.5 * marker.e.defIQ - 0.5 * m.recv - 0.5 * m.e.hands)) : 0;
    pThrough *= 1 - pStrip;
    if (marker && md < 5 && this.rng.chance(pStrip)) {
      this.causeNext = passEv(false, 'stripped on arrival');
      if (this.rng.chance(0.35)) {
        if (this.rng.chance(AGENT.tkCredit)) {
          marker.stat.tk++;
          B.stats.tk++;
          this.ev('takeaway', B.idx, marker.id, m.id, undefined, { zone: this.zone });
        }
        this.setPoss(B.idx, marker);
        return;
      }
      this.loosePuck(m.x + this.rng.float(-6, 6), m.y + this.rng.float(-6, 6));
      return;
    }
    this.addChain(p);
    const cross = p.x * d > 45 && m.x * d > 45 && Math.sign(p.y) !== Math.sign(m.y) && Math.abs(p.y - m.y) > 18;
    if (cross) this.crossSlotAt = this.elapsed;
    this.lastReceiver = m;
    this.acquired = 'pass';
    passEv(true, 'completed', cross ? { big: true } : undefined);
    this.setPoss(A.idx, m);
  }

  private agentDump(A: ST, p: SP, clearing: boolean): void {
    const d = dirOf(A.idx);
    const startU = p.x * d;
    const pk = this.isPK(A.idx);
    this.addChain(p);
    if (clearing) {
      const far = !pk && this.rng.chance(0.07);
      this.ev('clear', A.idx, p.id);
      if (far && startU < 0) {
        this.ev('icing', A.idx, p.id);
        this.faceoff = A.idx;
        this.noChange = A.idx;
        return;
      }
      // Off the glass and out toward the most advanced teammate (on the PK, just get it down the ice).
      let ahead: SP | null = null;
      for (const m of A.onIce) if (m !== p && (!ahead || m.x * d > ahead.x * d)) ahead = m;
      if (!pk && ahead && ahead.x * d > startU + 15) this.loosePuck(ahead.x + d * this.rng.float(0, 14), ahead.y + this.rng.float(-10, 10));
      else this.loosePuck(this.rng.float(-8, 45) * d, this.rng.float(-30, 30));
      return;
    }
    const B = this.teams[1 - A.idx];
    // Rim it to the side his forechecker is driving to (away from their deepest man if nobody is going).
    let fc: SP | null = null;
    for (const m of A.onIce) if (m !== p && m.isF && (!fc || m.x * d > fc.x * d)) fc = m;
    let nearD: SP | null = null;
    for (const o of B.onIce) if (!nearD || o.x * d > nearD.x * d) nearD = o;
    const side = fc && fc.x * d > startU - 5 ? (fc.y >= 0 ? 1 : -1) : nearD ? (nearD.y > 0 ? -1 : 1) : 1;
    this.dumpAt = this.elapsed;
    this.dumpTeam = A.idx;
    this.ev('dumpIn', A.idx, p.id);
    if (startU < 0 && !pk && this.rng.chance(0.85)) {
      this.ev('icing', A.idx, p.id);
      this.faceoff = A.idx;
      this.noChange = A.idx;
      return;
    }
    this.loosePuck((GOAL_LINE + this.rng.float(2, 9)) * d, side * this.rng.float(18, 34));
  }

  private resolveContact(): void {
    const c = this.puck.carrier;
    if (!c) return;
    const A = this.teams[c.team];
    const B = this.teams[1 - c.team];
    let who: SP | null = null;
    let wd = 99;
    for (const o of B.onIce) {
      const pl = o.plan;
      if (!pl || pl.target !== c || (pl.act !== 'pressure' && pl.act !== 'hit')) continue;
      const dd = dist(o.x, o.y, c.x, c.y);
      if (dd < wd) {
        wd = dd;
        who = o;
      }
    }
    if ((!who || wd > 5.5) && this.blockedBy && this.blockedBy.onIce && dist(this.blockedBy.x, this.blockedBy.y, c.x, c.y) < 5.5) {
      who = this.blockedBy;
      wd = dist(who.x, who.y, c.x, c.y);
    }
    if (!who || wd > 5.5) return;
    const plan = who.plan!;
    if (plan.act === 'hit' && plan.target === c) {
      if (this.elapsed - who.hitAt <= AGENT.hitRecover || this.elapsed - c.hitTakenAt <= AGENT.hitAgain) return;
      const boards = Math.abs(c.y) > 30 || Math.abs(c.x) > 80 ? 0.35 : 0;
      if (this.rng.chance(perTick(logistic(-0.2 + 0.55 * (who.e.phys - 0.5 * c.e.skate) + boards)))) {
        this.hit(who, c);
        if (this.faceoff !== null) return;
        if (this.rng.chance(0.38)) this.loosePuck(c.x + this.rng.float(-5, 5), c.y + this.rng.float(-5, 5));
      }
      return;
    }
    const l =
      AGENT.take +
      TUNING.contest * 1.6 * (0.6 * who.e.stickD + 0.4 * who.e.defIQ - 0.7 * c.e.hands - 0.3 * c.e.skate) +
      AGENT.teamEdge * (this.ctx(who.team) - this.ctx(c.team)) +
      AGENT.scoreFx * (this.scoreEffect(who.team) - this.scoreEffect(c.team)) +
      (this.isPK(c.team) ? 0.3 : 0) + (this.situation(c.team) === 'PP' ? -0.5 : 0) + AGENT.teamEdge * (B.coachDef - A.coachOff + B.sys.def - A.sys.off) +
      (c.team === 0 ? -1 : 1) * this.homeAdv * AGENT.homeEdge;
    if (!this.rng.chance(perTick(logistic(l)))) return;
    if (this.rng.chance(0.55)) {
      if (this.rng.chance(AGENT.tkCredit * 1.4)) {
        who.stat.tk++;
        B.stats.tk++;
        this.ev('takeaway', B.idx, who.id, c.id, undefined, { zone: this.zone });
      }
      this.takeawayAt = this.elapsed;
      this.takeawayOZ = who.x * dirOf(B.idx) > BLUE_LINE;
      this.setPoss(B.idx, who);
    } else {
      if (this.rng.chance(0.12)) {
        c.stat.gv++;
        A.stats.gv++;
        this.ev('giveaway', A.idx, c.id, who.id, undefined, { zone: this.zone });
      }
      this.loosePuck(c.x + this.rng.float(-6, 6), c.y + this.rng.float(-6, 6));
    }
  }

  private resolveLoose(): void {
    // Goalies smother pucks in the crease.
    for (const t of this.teams) {
      const g = t.goalie;
      if (!g) continue;
      const gx = -GOAL_LINE * dirOf(t.idx);
      if (dist(this.puck.x, this.puck.y, gx, 0) < 7) {
        const opp = this.teams[1 - t.idx].onIce;
        const near = this.nearestDist(this.puck.x, this.puck.y, opp);
        if (near > 2.5) {
          if (this.rng.chance(0.6)) {
            this.ev('freeze', t.idx, g.id);
            this.faceoff = t.idx;
            return;
          }
          const mates = t.onIce.filter((p) => !p.isF);
          const to = (mates.length ? mates : t.onIce).reduce<SP | null>((b, p) => (!b || dist(p.x, p.y, gx, 0) < dist(b.x, b.y, gx, 0) ? p : b), null);
          if (to) this.setPoss(t.idx, to);
          return;
        }
      }
    }
    const near: { p: SP; d: number }[] = [];
    for (const t of this.teams) for (const p of t.onIce) {
      const dd = dist(p.x, p.y, this.puck.x, this.puck.y);
      if (dd < 4.5) near.push({ p, d: dd });
    }
    if (!near.length) return;
    const teams = new Set(near.map((n) => n.p.team));
    const w = this.pickW(
      near.map((n) => n.p),
      (p) => Math.exp(-dist(p.x, p.y, this.puck.x, this.puck.y) / 2.5) * Math.exp(0.3 * (p.e.hands + p.e.skate + p.e.phys) / 3) * (p.plan?.act === 'chase' ? 1.4 : 1) * (p.team === this.dumpTeam && this.elapsed - this.dumpAt < 4 ? 1.5 : 1),
    );
    if (teams.size > 1) {
      const loser = near.filter((n) => n.p.team !== w.team).sort((a, b) => a.d - b.d)[0].p;
      this.ev('battle', w.team, w.id, loser.id);
      const hitter = this.rng.chance(0.5) ? w : loser;
      const target = hitter === w ? loser : w;
      if (this.rng.chance(perTick(0.1 * hitLean(hitter)))) {
        this.hit(hitter, target);
        if (this.faceoff !== null) return;
      }
    }
    this.setPoss(w.team, w);
    this.acquired = this.elapsed - this.reboundAt <= 2 ? 'rebound' : 'loose';
  }

  private agentShot(A: ST, B: ST, carrier: SP): void {
    const rng = this.rng;
    const d = dirOf(A.idx);
    const gx = GOAL_LINE * d;
    const sitA = this.situation(A.idx);
    const pp = sitA === 'PP' ? A.tactics.pp : null;
    const pkStyle = sitA === 'PP' ? B.tactics.pk : null;
    let shooter = carrier;
    let geo = shotGeometry(shooter.x * d, shooter.y);
    if (SHOT_DEBUG) {
      const k = `${geo.dist < 20 ? 'close' : geo.dist < 36 ? 'mid' : 'far'}:${this.acquired}:near${shooter.near < 4 ? '<4' : shooter.near < 8 ? '4-8' : shooter.near < 15 ? '8-15' : '15+'}`;
      SHOT_DEBUG[k] = (SHOT_DEBUG[k] ?? 0) + 1;
    }
    let danger = dangerOf(geo.dist);
    const rebound = this.elapsed - this.reboundAt <= 2 && geo.dist < 22;
    let type: ShotType;
    if (rebound) type = 'rebound';
    else if (this.elapsed - this.crossSlotAt <= 1 && this.lastReceiver === shooter && danger !== 'low' && rng.chance(0.7)) type = 'oneTimer';
    else if (danger === 'low') type = rng.chance(shooter.isF ? 0.15 : 0.6) ? 'slap' : rng.chance(0.25) ? 'snap' : 'wrist';
    else if (danger === 'high') type = shooter.x * d > GOAL_LINE - 1 ? 'wraparound' : rng.chance(0.2) ? 'backhand' : rng.chance(0.25) ? 'snap' : 'wrist';
    else type = rng.chance(0.1) ? 'slap' : rng.chance(0.25) ? 'snap' : rng.chance(0.06) ? 'backhand' : 'wrist';
    // Point shots get tipped by whoever is parked at the net.
    if (geo.dist > 33) {
      const tippers = A.onIce.filter((m) => m !== shooter && m.x * d > 76 && Math.abs(m.y) < 9);
      if (tippers.length) {
        const tipper = this.pickW(tippers, (m) => m.style.netFront);
        if (rng.chance(0.12 * tipper.style.netFront + (pp === 'netFront' ? 0.05 : 0))) {
          this.addChain(shooter);
          shooter = tipper;
          type = 'tip';
          geo = shotGeometry(shooter.x * d, shooter.y);
          danger = dangerOf(geo.dist);
        }
      }
    }
    const dist0 = geo.dist;
    const angle = geo.angle;
    const screened = B.goalie !== null && A.onIce.some((m) => m !== shooter && m.x * d > 72 && distToSegment(m.x, m.y, shooter.x, shooter.y, gx, 0) < 4) && rng.chance(0.55);
    const rush = this.entryRush && this.elapsed - this.entryAt <= 4;
    const oddMan = rush && this.entryOdd;
    const turnover = this.takeawayOZ && this.elapsed - this.takeawayAt <= 4;
    // A defender tight on him can lift his stick or tie him up before he gets it away.
    for (const o of B.onIce) {
      const pl = o.plan;
      if (!pl || pl.target !== shooter) continue;
      const dd = dist(o.x, o.y, shooter.x, shooter.y);
      if (dd > 4) continue;
      if (rng.chance(AGENT.shotDenial * (1 - dd / 5) * logistic(0.5 * (o.e.stickD + o.e.defIQ - shooter.e.hands - shooter.e.decide)) * 2)) {
        if (rng.chance(0.4)) {
          if (rng.chance(AGENT.tkCredit)) {
            o.stat.tk++;
            B.stats.tk++;
            this.ev('takeaway', B.idx, o.id, shooter.id, undefined, { zone: this.zone });
          }
          this.setPoss(B.idx, o);
        } else this.loosePuck(shooter.x + rng.float(-5, 5), shooter.y + rng.float(-5, 5));
        return;
      }
    }
    shooter.stat.att++;
    A.stats.attempts++;
    for (const p of A.onIce) p.stat.cf++;
    for (const p of B.onIce) p.stat.ca++;
    // The play that set this shot up (for tracing it back).
    const setup = this.setupFor(A.idx, type === 'rebound');
    this.reboundAt = -99;
    this.lastReboundEv = 0;
    // Blocks: anyone squarely in the lane.
    const lane = B.onIce
      .map((o) => ({ o, dl: distToSegment(o.x, o.y, shooter.x, shooter.y, gx, 0), t: along(o.x, o.y, shooter.x, shooter.y, gx, 0) }))
      .filter((x) => x.dl < AGENT.blockLane && x.t > 0.05 && x.t < 0.9)
      .sort((a, b) => a.t - b.t);
    for (const { o, dl } of lane) {
      let pb = AGENT.block * (1 - dl / (AGENT.blockLane + 1)) * (1 + 0.15 * o.e.block);
      if (type === 'oneTimer' || type === 'tip' || type === 'rebound') pb *= 0.55;
      if (pkStyle === 'box' || pkStyle === 'diamond') pb *= 1.1;
      if (rng.chance(clamp(pb, 0, 0.8))) {
        o.stat.blocks++;
        B.stats.blocks++;
        shooter.stat.blockedAtt++;
        A.stats.blockedAtt++;
        this.causeNext = setup;
        this.ev('blocked', B.idx, o.id, shooter.id, undefined, { dist: Math.round(dist0), angle: Math.round(angle), p: Math.round(clamp(pb, 0, 0.8) * 1000) / 1000 });
        if (rng.chance(TUNING.injuryBlock * o.injuryRisk * (type === 'slap' ? 1.5 : 1))) this.injure(o, 'block');
        this.loosePuck(o.x + rng.float(-7, 7), o.y + rng.float(-7, 7));
        return;
      }
    }
    // A defender on the shooter gets a stick or body on it, or forces him wide.
    let close = 99;
    let closer: SP | null = null;
    for (const o of B.onIce) {
      const dd = dist(o.x, o.y, shooter.x, shooter.y);
      if (dd < close) {
        close = dd;
        closer = o;
      }
    }
    const pClose = closer && close < 6 && type !== 'tip' ? 0.3 * (1 - close / 6) * (1 + 0.15 * closer.e.block) : 0;
    if (closer && close < 6 && type !== 'tip' && rng.chance(pClose)) {
      closer.stat.blocks++;
      B.stats.blocks++;
      shooter.stat.blockedAtt++;
      A.stats.blockedAtt++;
      this.causeNext = setup;
      this.ev('blocked', B.idx, closer.id, shooter.id, undefined, { dist: Math.round(dist0), angle: Math.round(angle), p: Math.round(pClose * 1000) / 1000 });
      this.loosePuck(closer.x + rng.float(-7, 7), closer.y + rng.float(-7, 7));
      return;
    }
    const pMissAvg = baseMissProbability(type, dist0);
    const xgOnNet = baseGoalProbability({ dist: dist0, angle, type, rush, oddMan, screened, turnover, empty: B.goalie === null });
    const xg = (1 - pMissAvg) * xgOnNet;
    shooter.stat.ixg += xg;
    A.stats.xg += xg;
    for (const p of A.onIce) p.stat.xgf += xg;
    for (const p of B.onIce) p.stat.xga += xg;
    const passer = this.chain.length ? this.chain[this.chain.length - 1] : null;
    if (passer && passer !== shooter && passer.team === A.idx) passer.stat.ixa += xg;
    const accSkill = type === 'slap' ? this.val(shooter, 'slap') : this.val(shooter, 'acc');
    let lMiss = logit(pMissAvg) - 0.3 * accSkill + (shooter.fat < 0 ? -shooter.fat * 0.5 : 0) + (close < 6 ? 0.35 * (1 - close / 6) : 0);
    if (B.goalie === null) lMiss = logit(clamp(0.15 + dist0 * 0.005, 0.1, 0.75)) - 0.3 * accSkill;
    if (B.tactics.defense === 'aggressive' || pkStyle === 'aggressive') lMiss += 0.08;
    if (rng.chance(logistic(lMiss))) {
      shooter.stat.missed++;
      A.stats.missed++;
      this.causeNext = setup;
      this.ev('missed', A.idx, shooter.id, undefined, undefined, { dist: Math.round(dist0), angle: Math.round(angle), shotType: type, xg, danger, en: B.goalie === null || undefined, p: Math.round(logistic(lMiss) * 1000) / 1000 });
      if (B.goalie === null && shooter.x * d < 0 && !this.isPK(A.idx)) {
        this.ev('icing', A.idx, shooter.id);
        this.faceoff = A.idx;
        this.noChange = A.idx;
        return;
      }
      if (rng.chance(0.06)) {
        this.ev('outOfPlay', B.idx, shooter.id);
        this.faceoff = B.idx;
        return;
      }
      this.addChain(shooter);
      this.loosePuck(gx + d * rng.float(3, 10), (Math.sign(shooter.y) || 1) * -1 * rng.float(5, 30));
      return;
    }
    shooter.stat.sog++;
    const zone = shotZone(dist0, angle);
    const zsArr = (this.shotZones[shooter.id] ??= new Array(ZONE_COUNT * 2).fill(0));
    zsArr[zone]++;
    A.stats.shots++;
    A.stats.shotsByPeriod[Math.min(this.period, 4) - 1] = (A.stats.shotsByPeriod[Math.min(this.period, 4) - 1] ?? 0) + 1;
    const hd = danger === 'high';
    if (hd) A.stats.hdShots++;
    const g = B.goalie;
    if (!g) {
      this.causeNext = setup;
      this.lastShotEv = this.ev('shot', A.idx, shooter.id, undefined, undefined, { dist: Math.round(dist0), angle: Math.round(angle), shotType: type, xg, danger, en: true, p: 1 });
      zsArr[ZONE_COUNT + zone]++;
      this.goalP = 1;
      this.causeNext = this.lastShotEv;
      this.scoreGoal(A, B, shooter, xg, type, true);
      return;
    }
    g.stat.sa++;
    g.stat.gxga += xgOnNet;
    if (hd) g.stat.hdsa++;
    const shooterSkill = this.shooterSkill(shooter, type);
    const gSkill = this.goalieSkill(g, B, danger, type, screened);
    const late = this.period >= 3 && this.periodLength - this.clock < 300 && Math.abs(this.score[0] - this.score[1]) <= 1;
    const clutch = late || this.input.playoff ? 0.05 * shooter.clutch : 0;
    const adj = TUNING.shooterWeight * shooterSkill - TUNING.goalieWeight * gSkill + clutch + TUNING.finishOffset + AGENT.finish + (this.isPK(B.idx) ? AGENT.ppFinish : 0) + this.ctx(A.idx) * 0.3 - this.ctx(B.idx) * 0.3;
    // This shooter on this goalie from here: the chance it goes in.
    const pGoal = logistic(logit(xgOnNet) + adj);
    const pRec = Math.round(pGoal * 1000) / 1000;
    this.causeNext = setup;
    this.lastShotEv = this.ev('shot', A.idx, shooter.id, g.id, undefined, { dist: Math.round(dist0), angle: Math.round(angle), shotType: type, xg, danger, p: pRec });
    if (rng.chance(pGoal)) {
      if (hd) g.stat.hdga++;
      zsArr[ZONE_COUNT + zone]++;
      this.goalP = pRec;
      this.causeNext = this.lastShotEv;
      this.scoreGoal(A, B, shooter, xg, type, false);
      return;
    }
    const big = xgOnNet > 0.2;
    this.causeNext = this.lastShotEv;
    this.lastSaveEv = this.ev('save', B.idx, g.id, shooter.id, undefined, { big, xg: xgOnNet, p: pRec });
    if (big) this.bumpMomentum(B.idx, 0.06);
    this.addChain(shooter);
    let pReb = 0.08 - 0.03 * (g.gReb + g.form) + (type === 'slap' ? 0.03 : 0) + (type === 'tip' ? 0.02 : 0) + (screened ? 0.02 : 0);
    if (pp === 'shooting') pReb += 0.01;
    pReb = clamp(pReb, 0.02, 0.2);
    if (type !== 'rebound' && rng.chance(pReb)) {
      g.stat.reb++;
      this.causeNext = this.lastSaveEv;
      this.lastReboundEv = this.ev('rebound', A.idx, shooter.id, undefined, undefined, { p: Math.round(pReb * 1000) / 1000 });
      this.reboundAt = this.elapsed + AGENT.tick;
      this.loosePuck(gx - d * rng.float(5, 11), rng.float(-9, 9));
      return;
    }
    const pFreeze = clamp(0.5 + 0.08 * g.gReb + (danger === 'low' ? -0.08 : 0.06), 0.25, 0.75);
    if (rng.chance(pFreeze)) {
      this.causeNext = this.lastSaveEv;
      this.ev('freeze', B.idx, g.id);
      this.faceoff = B.idx;
      return;
    }
    // Kicked into the corner.
    this.loosePuck(gx - d * rng.float(-6, 10), (rng.chance(0.5) ? 1 : -1) * rng.float(18, 34));
  }

  // ───────────────────────────── goals ─────────────────────────────

  private scoreGoal(A: ST, B: ST, shooter: SP, xg: number, type: ShotType | string, emptyNet: boolean): void {
    const sitA = this.situation(A.idx);
    const strength: GoalRecord['strength'] = emptyNet && sitA !== 'PP' ? 'EN' : sitA === 'PP' ? 'PP' : sitA === 'PK' ? 'SH' : 'EV';
    A.stats.goals++;
    const pi = Math.min(this.period, 4) - 1;
    A.stats.goalsByPeriod[pi] = (A.stats.goalsByPeriod[pi] ?? 0) + 1;
    shooter.stat.g++;
    if (strength === 'PP') {
      shooter.stat.ppg++;
      A.stats.ppg++;
    }
    if (strength === 'SH') {
      shooter.stat.shg++;
      A.stats.shg++;
    }
    const assists: SP[] = [];
    for (let i = this.chain.length - 1; i >= 0 && assists.length < 2; i--) {
      const p = this.chain[i];
      if (p !== shooter && p.team === A.idx && !assists.includes(p) && p.onIce) assists.push(p);
    }
    // Not every touch earns an assist (unassisted rushes, broken plays).
    if (assists.length === 2 && this.rng.chance(0.1)) assists.pop();
    // The possession model abstracts some puck movement (regroups, D-to-D passes, board
    // battles); credit those implied touches to on-ice teammates.
    if (!emptyNet || assists.length) {
      while (assists.length < 2) {
        const p = this.mode === 'agent' ? AGENT.assistPad[assists.length] : assists.length === 0 ? 0.78 : 0.58;
        if (!this.rng.chance(p)) break;
        const pool = A.onIce.filter((x) => x !== shooter && !assists.includes(x));
        if (!pool.length) break;
        assists.push(this.pickW(pool, (x) => Math.exp(0.5 * x.pass) * (x.isF ? 1 : 0.9)));
      }
    }
    assists.forEach((p, i) => {
      if (i === 0) p.stat.a1++;
      else p.stat.a2++;
      if (strength === 'PP') p.stat.ppa++;
      if (strength === 'SH') p.stat.sha++;
    });
    if (strength !== 'PP') {
      for (const p of A.onIce) p.stat.pm++;
      for (const p of B.onIce) p.stat.pm--;
    }
    if (B.goalie) B.goalie.stat.ga++;
    B.goalieConf -= 0.03 * (1 - clamp((B.goalie?.decide ?? 0) * 0.3, -0.5, 0.5));
    this.bumpMomentum(A.idx, 0.26);
    this.goals.push({
      team: A.idx,
      period: this.period,
      clock: this.clock,
      scorer: shooter.id,
      assists: assists.map((p) => p.id),
      strength,
      xg,
      shotType: String(type),
      winGoalie: A.goalie?.id ?? A.lastGoalie?.id ?? null,
      loseGoalie: B.goalie?.id ?? B.lastGoalie?.id ?? null,
    });
    this.ev('goal', A.idx, shooter.id, assists[0]?.id, assists[1]?.id, {
      assists: assists.map((p) => p.id),
      strength,
      score: this.score,
      xg,
      shotType: String(type),
      en: emptyNet,
      p: this.goalP,
    });
    this.goalP = undefined;
    if (strength === 'PP') {
      const minors = this.penalties.filter((p) => p.team === B.idx && !p.coincidental && p.minutes < 5).sort((a, b) => a.remaining - b.remaining);
      const pen = minors[0];
      if (pen) {
        if (pen.minutes === 4 && pen.remaining > 120) pen.remaining -= pen.remaining - 120;
        else this.endPenalty(pen, true);
      }
    }
    this.faceoff = 'C';
    this.resetPossession();
    if (this.period > 3) {
      this.finish();
      return;
    }
    // Pull a struggling starter.
    if (B.goalie && B.goalie === B.starter && !B.goalieChanged && B.backup && B.goalie.stat.ga >= 4 && (this.period <= 2 || B.goalie.stat.ga >= 5)) {
      if (this.rng.chance(0.45)) {
        const old = B.goalie;
        B.goalie = B.backup;
        B.lastGoalie = B.backup;
        B.goalieChanged = true;
        B.backup.stat.gp = 1;
        B.goalieConf = 0;
        this.ev('goalieChange', B.idx, B.backup.id, old.id);
      }
    }
  }

  private emptyNetAttempt(): boolean {
    const A = this.teams[this.poss];
    const B = this.teams[1 - this.poss];
    if (!B.pulled || B.goalie !== null) return false;
    const rng = this.rng;
    const pAttempt = this.zone === 'D' ? 0.2 : this.zone === 'N' ? 0.4 : 0;
    if (!pAttempt || !rng.chance(pAttempt)) return false;
    const shooter = this.pickW(A.onIce, (p) => Math.exp(0.3 * p.shot) * (p.isF ? 1 : 0.6));
    const pGoal = (this.zone === 'D' ? 0.22 : 0.45) + 0.05 * this.val(shooter, 'acc');
    this.advance(rng.float(3, 7));
    shooter.stat.att++;
    A.stats.attempts++;
    for (const p of A.onIce) p.stat.cf++;
    for (const p of B.onIce) p.stat.ca++;
    if (rng.chance(clamp(pGoal, 0.1, 0.8))) {
      shooter.stat.sog++;
      // Long-range empty-netter: the farthest zone of the shot chart.
      const ez = shotZone(this.zone === 'D' ? 160 : 100, 0);
      const zs = (this.shotZones[shooter.id] ??= new Array(ZONE_COUNT * 2).fill(0));
      zs[ez]++;
      zs[ZONE_COUNT + ez]++;
      A.stats.shots++;
      A.stats.xg += pGoal;
      shooter.stat.ixg += pGoal;
      this.ev('shot', A.idx, shooter.id, undefined, undefined, { dist: this.zone === 'D' ? 160 : 100, shotType: 'wrist', xg: pGoal, en: true });
      this.scoreGoal(A, B, shooter, pGoal, 'wrist', true);
      return true;
    }
    shooter.stat.missed++;
    A.stats.missed++;
    this.ev('missed', A.idx, shooter.id, undefined, undefined, { en: true });
    if (this.zone === 'D' && !this.isPK(A.idx)) {
      this.ev('icing', A.idx, shooter.id);
      this.faceoff = A.idx;
      this.noChange = A.idx;
    } else {
      this.changePossession(B.idx, 'D');
    }
    return true;
  }

  // ───────────────────────────── physical / penalties / injuries ─────────────────────────────

  private hit(hitter: SP, target: SP): void {
    if (hitter.team === target.team) return;
    hitter.hitAt = this.elapsed;
    target.hitTakenAt = this.elapsed;
    hitter.stat.hits++;
    this.teams[hitter.team].stats.hits++;
    target.energy = Math.max(5, target.energy - 1.5 * (1 + hitter.phys * 0.2));
    this.bumpMomentum(hitter.team, 0.015);
    this.ev('hit', hitter.team, hitter.id, target.id);
    if (this.rng.chance(TUNING.injuryHit * target.injuryRisk * (1 + Math.max(0, hitter.phys) * 0.3))) this.injure(target, 'hit');
    const aggr = hitter.hitProp;
    if (this.rng.chance(TUNING.hitPenalty * clamp(1 - hitter.disc * 0.35, 0.4, 1.8) * (0.6 + 0.4 * aggr) * this.teams[hitter.team].coachDisc * this.callFactor(hitter.team))) {
      this.callPenalty(hitter, this.rng.weighted(HIT_PENALTIES, (x) => x[1])[0]);
      return;
    }
    // Retaliation: occasionally a big hit leads to a fight.
    const tTeam = this.teams[target.team];
    const tough = tTeam.onIce.reduce((m, p) => (p.hitProp > m.hitProp ? p : m), tTeam.onIce[0]);
    if (tough && this.rng.chance(TUNING.fightRate * tough.hitProp * aggr * (this.input.playoff ? 0.5 : 1))) this.fight(tough, hitter);
  }

  private fight(a: SP, b: SP): void {
    if (this.faceoff !== null) return;
    const winner = this.rng.chance(logistic(0.8 * (a.phys - b.phys))) ? a : b;
    this.ev('fight', a.team, a.id, b.id, undefined, { penalty: 'Fighting', minutes: 5 });
    for (const p of [a, b]) {
      this.toBox(p);
      p.stat.pim += 5;
      this.teams[p.team].stats.pim += 5;
      this.penalties.push({ team: p.team, player: p, remaining: 300, minutes: 5, coincidental: true });
      this.pens.push({ team: p.team, period: this.period, clock: this.clock, player: p.id, infraction: 'Fighting', minutes: 5 });
      if (this.rng.chance(0.02 * p.injuryRisk)) this.injure(p, 'fight');
    }
    this.bumpMomentum(winner.team, 0.1);
    this.faceoff = 'C';
    this.resetPossession();
  }

  /**
   * Officials' game management: whistles get scarcer as penalties pile up in
   * a game, and a lopsided count tends to even out (make-up calls).
   */
  private callFactor(side: Side): number {
    let mine = 0, theirs = 0;
    for (const p of this.pens) if (p.minutes < 5) p.team === side ? mine++ : theirs++;
    const even = mine - theirs >= 2 ? 0.55 : theirs - mine >= 2 ? 1.3 : 1;
    return even / (1 + 0.08 * (mine + theirs));
  }

  /** Off to the box right away: he leaves the ice with the whistle, before the line change for the faceoff. */
  private toBox(p: SP): void {
    p.inBox = true;
    const t = this.teams[p.team];
    if (t.onIce.includes(p)) {
      t.onIce = t.onIce.filter((m) => m !== p);
      p.onIce = false;
      // A team never drops below three skaters: a third penalty is stacked and someone replaces him.
      if (t.onIce.length < 3) {
        const sub = t.players.find((m) => m.pos !== 'G' && !m.onIce && !m.inBox && !m.out);
        if (sub) {
          sub.onIce = true;
          t.onIce = [...t.onIce, sub];
        }
      }
    }
    if (this.puck.carrier === p) this.puck.carrier = null;
  }

  private callPenalty(offender: SP, infraction: string): void {
    const t = this.teams[offender.team];
    let minutes = 2;
    if (infraction === 'High-sticking' && this.rng.chance(0.25)) minutes = 4;
    if ((infraction === 'Boarding' || infraction === 'Charging' || infraction === 'Elbowing') && this.rng.chance(0.06)) minutes = 5;
    this.toBox(offender);
    offender.stat.pim += minutes;
    t.stats.pim += minutes;
    const opp = this.teams[1 - offender.team];
    if (this.boxCount(offender.team) < 2) opp.stats.ppOpp++;
    this.penalties.push({ team: offender.team, player: offender, remaining: minutes * 60, minutes, coincidental: false });
    this.pens.push({ team: offender.team, period: this.period, clock: this.clock, player: offender.id, infraction, minutes });
    this.ev('penalty', offender.team, offender.id, undefined, undefined, { penalty: infraction, minutes });
    this.bumpMomentum(opp.idx, 0.05);
    this.faceoff = offender.team;
    this.resetPossession();
  }

  private injure(p: SP, cause: InjuryCause): void {
    if (p.out) return;
    const inj = rollInjury(this.rng, cause, p.injurySeverity);
    const leftGame = inj.severity !== 'minor' || this.rng.chance(0.35);
    this.injuries.push({ team: p.team, playerId: p.id, period: this.period, clock: this.clock, cause, injury: inj, leftGame });
    this.ev('injury', p.team, p.id, undefined, undefined, { injury: inj.type, severity: inj.severity, success: leftGame });
    if (leftGame) {
      p.out = true;
      if (p.onIce) {
        const t = this.teams[p.team];
        this.deploy(t);
      }
    }
  }

  private randomEvents(dt: number): void {
    const rng = this.rng;
    if (dt <= 0) return;
    // Stick penalties.
    if (rng.chance(TUNING.penaltyRate * dt * 2)) {
      const defSide = (this.zone === 'O' ? 1 - this.poss : this.zone === 'D' ? this.poss : rng.chance(0.5) ? 0 : 1) as Side;
      const offSide = (rng.chance(0.64) ? defSide : 1 - defSide) as Side;
      const t = this.teams[offSide];
      const tacMult = (t.tactics.defense === 'physical' ? 1.15 : t.tactics.defense === 'aggressive' ? 1.08 : 1) * (this.isPK(offSide) ? 0.75 : 1) * t.coachDisc;
      if (rng.chance(clamp(tacMult * 0.8 * this.callFactor(offSide), 0, 1)) && t.onIce.length) {
        const offender = this.pickW(t.onIce, (p) => clamp(1 - p.disc * 0.35, 0.3, 2) * (0.6 + 0.4 * p.hitProp) * (p.fat < 0 ? 1.2 : 1));
        this.callPenalty(offender, rng.weighted(STICK_PENALTIES, (x) => x[1])[0]);
        return;
      }
    }
    // Open-ice / board hits not tied to a specific battle (the per-second engine has players choose their hits).
    if (this.mode !== 'agent' && rng.chance(TUNING.hitRate * dt)) {
      const defSide = (this.zone === 'O' ? 1 - this.poss : this.zone === 'D' ? this.poss : 1 - this.poss) as Side;
      const hitSide = (rng.chance(0.62) ? defSide : 1 - defSide) as Side;
      const H = this.teams[hitSide];
      const T = this.teams[1 - hitSide];
      if (H.onIce.length && T.onIce.length) {
        const hitter = this.pickW(H.onIce, (p) => p.hitProp * (H.tactics.defense === 'physical' ? 1.3 : 1));
        const target = this.pickW(T.onIce, () => 1);
        const pHit = clamp(0.55 * hitter.hitProp * (H.tactics.defense === 'physical' ? 1.35 : 1), 0.05, 0.95);
        if (rng.chance(pHit)) this.hit(hitter, target);
      }
    }
    // Non-contact injuries.
    for (const t of this.teams) {
      if (!t.onIce.length) continue;
      if (rng.chance(TUNING.injuryNonContact * dt)) {
        const p = this.pickW(t.onIce, (x) => x.injuryRisk * (x.fat < 0 ? 1.6 : 1));
        if (rng.chance(clamp(p.injuryRisk / 1.5, 0.1, 1))) this.injure(p, 'noncontact');
      }
    }
  }

  // ───────────────────────────── periods / end ─────────────────────────────

  private endPeriod(): void {
    this.ev('periodEnd', 0);
    const [h, a] = this.score;
    if (this.period >= 3 && h !== a) {
      this.finish();
      return;
    }
    if (this.period >= 3 && !this.input.playoff) {
      if (this.period === 3 && this.regOT.minutes > 0) {
        this.startPeriod(4, this.regOT.minutes * 60);
        return;
      }
      if (this.regOT.shootout) this.runShootout();
      this.finish();
      return;
    }
    this.startPeriod(this.period + 1, 1200);
  }

  private startPeriod(n: number, length: number): void {
    this.period = n;
    this.clock = 0;
    this.periodLength = length;
    this.faceoff = 'C';
    this.resetPossession();
    for (const t of this.teams) {
      for (const p of t.players) p.energy = Math.min(p.maxEnergy, p.energy + 45);
      if (t.pulled) {
        t.pulled = false;
        t.goalie = t.lastGoalie;
      }
      this.flushPairs(t);
      t.fIdx = 0;
      t.dIdx = 0;
      t.unitIdx = 0;
      t.fStart = t.dStart = this.elapsed;
      t.kind = this.kindFor(t.idx);
      this.deploy(t);
    }
    this.ev('periodStart', 0);
  }

  private runShootout(): void {
    this.inShootout = true;
    const order = (t: ST) =>
      t.players.filter((p) => p.pos !== 'G' && !p.out).sort((x, y) => y.so + y.form - (x.so + x.form));
    const shooters: [SP[], SP[]] = [order(this.teams[0]), order(this.teams[1])];
    const score: [number, number] = [0, 0];
    const attempt = (i: Side, round: number): void => {
      const list = shooters[i];
      const s = list[round % Math.max(1, list.length)];
      const g = this.teams[1 - i].goalie ?? this.teams[1 - i].lastGoalie;
      if (!s || !g) return;
      const p = logistic(logit(0.31) + 0.55 * (s.so + s.form) - 0.55 * (g.gSO + g.form));
      const scored = this.rng.chance(p);
      if (scored) score[i]++;
      this.shootout.push({ team: i, shooter: s.id, goalie: g.id, scored });
      this.ev('shootout', i, s.id, g.id, undefined, { success: scored, round: round + 1 });
    };
    for (let r = 0; r < 3; r++) {
      attempt(0, r);
      if (score[0] > score[1] + (3 - r) || score[1] > score[0] + (3 - r)) break;
      attempt(1, r);
      if (score[0] > score[1] + (2 - r) || score[1] > score[0] + (2 - r)) break;
    }
    let r = 3;
    while (score[0] === score[1] && r < 40) {
      attempt(0, r);
      attempt(1, r);
      r++;
    }
    if (score[0] === score[1]) score[this.rng.chance(0.5) ? 0 : 1]++;
    this.soScore = score[0] > score[1] ? [1, 0] : [0, 1];
  }

  private finalScore(): [number, number] {
    const [h, a] = this.score;
    return [h + this.soScore[0], a + this.soScore[1]];
  }

  private finish(): void {
    if (this.finished) return;
    for (const t of this.teams) this.flushPairs(t);
    this.finished = true;
    this.ev('gameEnd', 0, undefined, undefined, undefined, { score: this.finalScore() });
  }

  result(): GameResult {
    const [hg, ag] = this.finalScore();
    const winner: Side = hg > ag ? 0 : 1;
    const loser = (1 - winner) as Side;
    const ot = this.period > 3;
    const so = this.inShootout;
    const W = this.teams[winner];
    const Lt = this.teams[loser];
    // Game-winning goal: the winner's goal that put them one ahead of the loser's final total.
    let gwg: number | null = null;
    let winGoalie: number | null = W.lastGoalie?.id ?? W.starter?.id ?? null;
    let loseGoalie: number | null = Lt.lastGoalie?.id ?? Lt.starter?.id ?? null;
    if (!so) {
      const loserGoals = this.teams[loser].stats.goals;
      const wg = this.goals.filter((g) => g.team === winner);
      const g = wg[loserGoals];
      if (g) {
        gwg = g.scorer;
        winGoalie = g.winGoalie ?? winGoalie;
        loseGoalie = g.loseGoalie ?? loseGoalie;
      }
    }
    const players: Record<number, PlayerGameLine> = {};
    const goaliesUsed: number[] = [];
    for (const t of this.teams) {
      for (const p of t.players) {
        if (p.pos === 'G') {
          if (p.stat.gtoi > 0 || p.stat.gs) {
            p.stat.gp = 1;
            goaliesUsed.push(p.id);
          } else continue;
        } else p.stat.gp = 1;
        players[p.id] = p.stat;
      }
    }
    if (gwg !== null && players[gwg]) players[gwg].gwg = 1;
    if (winGoalie !== null && players[winGoalie]) players[winGoalie].w = 1;
    if (loseGoalie !== null && players[loseGoalie]) {
      if (ot) players[loseGoalie].otl = 1;
      else players[loseGoalie].l = 1;
    }
    // Shutout: winner allowed nothing and used one goalie.
    if (this.teams[loser].stats.goals === 0 && !so) {
      const used = W.players.filter((p) => p.pos === 'G' && p.stat.gtoi > 0);
      if (used.length === 1) used[0].stat.so = 1;
    }
    return {
      homeGoals: hg,
      awayGoals: ag,
      ot,
      so,
      periods: this.period,
      teams: [this.teams[0].stats, this.teams[1].stats],
      players,
      goals: this.goals.map(({ winGoalie: _w, loseGoalie: _l, ...g }) => g),
      penalties: this.pens,
      injuries: this.injuries,
      stars: this.threeStars(players, winner),
      winningGoalie: winGoalie,
      losingGoalie: loseGoalie,
      gwg,
      pairToi: this.pairToi,
      shotZones: this.shotZones,
      goaliesUsed,
      shootout: this.shootout,
      events: this.events,
      ...(this.mode === 'agent' ? { decisions: this.decisions } : {}),
      ...(this.input.recordTrack ? { track: this.track } : {}),
    };
  }

  private threeStars(players: Record<number, PlayerGameLine>, winner: Side): number[] {
    const scores: [number, number][] = [];
    for (const [idStr, s] of Object.entries(players)) {
      let v = s.g * 3 + (s.a1 + s.a2) * 1.8 + s.gwg * 1 + s.pm * 0.3 + s.sog * 0.15 + s.hits * 0.05 + s.blocks * 0.1 + s.ixg * 0.5;
      if (s.sa > 0) v += (s.sa - s.ga) * 0.1 - s.ga * 0.6 + s.so * 3 + (s.gxga - s.ga) * 1.2;
      if (s.team === winner) v += 0.8;
      scores.push([Number(idStr), v]);
    }
    return scores.sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]);
  }
}

export function simulateGame(input: GameInput): GameResult {
  return new GameSim(input).simulate();
}
