/**
 * Event-driven hockey game engine.
 *
 * A game is a sequence of puck-possession steps: faceoffs, breakouts, zone
 * entries, offensive-zone plays (passes / shots / turnovers), shot resolution
 * (block / miss / save / rebound / goal), penalties, line changes and goalie
 * decisions. Every probability is derived from the players on the ice, their
 * fatigue, tactics, coaching, chemistry, momentum and home ice. The final score
 * is simply what falls out of those events.
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
  InjuryRecord,
  PenaltyRecord,
  PlayerGameLine,
  TeamGameStats,
} from './gameTypes';
import { baseGoalProbability, baseMissProbability, type ShotType } from './shotModel';

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
  penaltyRate: 1 / 1150,
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

type Zone = 'D' | 'N' | 'O';
type Side = 0 | 1;

let BASE = 120;
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
  tactics: Tactics;
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
  };
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

  constructor(input: GameInput) {
    this.input = input;
    BASE = input.ratingBaseline ?? 120;
    this.rng = new Rng(`game|${input.seed}`);
    this.regOT = input.regularSeasonOT ?? { minutes: 5, skaters: 3, shootout: true };
    this.homeAdv = input.neutral ? 0 : TUNING.homeAdv;
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
      tactics: inp.tactics,
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
  step(): GameEvent[] {
    if (this.finished) return [];
    // Includes anything recorded before the first step (the opening periodStart).
    const before = this.emitted;
    const t0 = this.elapsed;
    this.manageGoalies();
    this.manageLines();
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
    while (!this.finished && guard++ < 20000) this.step();
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
    };
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private ev(type: GameEventType, team: Side, p1?: number, p2?: number, p3?: number, data?: GameEvent['data']): void {
    if (!this.input.recordEvents) return;
    this.events.push({ t: this.elapsed, period: this.period, clock: this.clock, type, team, p1, p2, p3, data });
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
    for (const p of out) p.onIce = true;
    t.onIce = out;
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
      const canChange = stoppage || this.poss === t.idx || this.zone === 'N';
      const shiftF = this.elapsed - t.fStart;
      const shiftD = this.elapsed - t.dStart;
      if (!canChange && shiftF < 95) continue;
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
        const p = assists.length === 0 ? 0.78 : 0.58;
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
    });
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
      p.inBox = true;
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

  private callPenalty(offender: SP, infraction: string): void {
    const t = this.teams[offender.team];
    let minutes = 2;
    if (infraction === 'High-sticking' && this.rng.chance(0.25)) minutes = 4;
    if ((infraction === 'Boarding' || infraction === 'Charging' || infraction === 'Elbowing') && this.rng.chance(0.06)) minutes = 5;
    offender.inBox = true;
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
    // Open-ice / board hits not tied to a specific battle.
    if (rng.chance(TUNING.hitRate * dt)) {
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
