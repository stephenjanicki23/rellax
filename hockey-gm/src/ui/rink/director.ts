/**
 * Live rink "director": turns the engine's event stream into positions for
 * the puck and every player on the ice. Pure and deterministic (positions are
 * derived from event data plus hashed jitter), so the rink always reflects
 * what the simulation actually did.
 *
 * Coordinates are feet on a 200 × 85 NHL rink. The home team attacks to the
 * right in periods 1, 3 and overtime, and to the left in period 2.
 */
import type { GameEvent } from '../../engine/sim/gameTypes';
import type { Position } from '../../engine/types';

export const RINK = { w: 200, h: 85, cx: 100, cy: 42.5, goalL: 11, goalR: 189 } as const;

export interface Pt {
  x: number;
  y: number;
}

export interface RinkPlayer {
  id: number;
  team: 0 | 1;
  pos: Position;
  number: number | null;
  /** Display names (presentation only). */
  first?: string;
  last?: string;
}

export type ShotKind = 'goal' | 'save' | 'miss' | 'block';

export interface ShotMark extends Pt {
  team: 0 | 1;
  kind: ShotKind;
  period: number;
}

export interface Flash {
  text: string;
  team: 0 | 1 | null;
  kind: 'goal' | 'save' | 'info' | 'penalty';
  id: number;
}

export interface Frame {
  puck: Pt;
  /** How the puck travels to this frame's position. */
  motion: 'carry' | 'pass' | 'shot' | 'still';
  carrier: number | null;
  players: Record<number, Pt>;
  flash: Flash | null;
  /** Team whose goal light is on (it scored), if any. */
  goalLight: 0 | 1 | null;
  /** Shot to add to the shot map when this frame is reached. */
  mark?: ShotMark;
  /** The engine event this frame completes (on the last frame of each event). */
  event?: GameEvent;
}

export interface IceState {
  period: number;
  onIce: [number[], number[]];
  goalies: [number | null, number | null];
}

const clampPt = (p: Pt, m = 3.5): Pt => ({ x: Math.min(RINK.w - m, Math.max(m, p.x)), y: Math.min(RINK.h - m, Math.max(m, p.y)) });
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Deterministic 0..1 noise from a few integers. */
export function hash(...n: number[]): number {
  let h = 2166136261;
  for (const v of n) {
    h ^= Math.floor(v * 1000) | 0;
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** +1 if the team attacks toward the right-hand net this period. */
export function attackDir(team: 0 | 1, period: number): 1 | -1 {
  const homeRight = period % 2 === 1 || period > 4;
  return (team === 0) === homeRight ? 1 : -1;
}

export const attackNetX = (team: 0 | 1, period: number) => (attackDir(team, period) > 0 ? RINK.goalR : RINK.goalL);
export const ownNetX = (team: 0 | 1, period: number) => (attackDir(team, period) > 0 ? RINK.goalL : RINK.goalR);

type Zone = 'D' | 'N' | 'O';

/** Zone of a point from `team`'s perspective (O = its attacking zone). */
export function zoneOf(p: Pt, team: 0 | 1, period: number): Zone {
  const u = (p.x - RINK.cx) * attackDir(team, period);
  return u > 25 ? 'O' : u < -25 ? 'D' : 'N';
}

/** Where every player stands given the puck, who has it and the zone. */
export function formation(ice: IceState, meta: Map<number, RinkPlayer>, puck: Pt, carrier: number | null, poss: 0 | 1, beat: number): Record<number, Pt> {
  const out: Record<number, Pt> = {};
  const { period } = ice;
  for (const team of [0, 1] as const) {
    const d = attackDir(team, period);
    const aN = attackNetX(team, period);
    const oN = ownNetX(team, period);
    const aBlue = RINK.cx + d * 25;
    const dBlue = RINK.cx - d * 25;
    const skaters = ice.onIce[team].filter((id) => id !== ice.goalies[team]);
    const ds = skaters.filter((id) => meta.get(id)?.pos === 'D');
    const fs = skaters.filter((id) => meta.get(id)?.pos !== 'D');
    const z = zoneOf(puck, team, period);
    const attacking = team === poss;
    const side = puck.y < RINK.cy ? -1 : 1;
    let dSlots: Pt[];
    let fSlots: Pt[];
    if (attacking) {
      if (z === 'O') {
        dSlots = [{ x: aBlue + d * 4, y: 21 }, { x: aBlue + d * 4, y: 64 }];
        fSlots = [
          { x: aN - d * 9, y: RINK.cy + side * -3 },
          { x: aN - d * 26, y: side < 0 ? 70 : 15 },
          { x: aN - d * 20, y: RINK.cy + side * 9 },
        ];
      } else if (z === 'N') {
        dSlots = [{ x: puck.x - d * 18, y: 30 }, { x: puck.x - d * 18, y: 55 }];
        fSlots = [{ x: puck.x + d * 7, y: 16 }, { x: puck.x + d * 4, y: RINK.cy }, { x: puck.x + d * 7, y: 69 }];
      } else {
        dSlots = [{ x: oN + d * 9, y: 27 }, { x: oN + d * 9, y: 58 }];
        fSlots = [{ x: oN + d * 32, y: 9 }, { x: oN + d * 17, y: RINK.cy }, { x: oN + d * 32, y: 76 }];
      }
    } else if (z === 'D') {
      // Defending in our own end: box in front of the net, centre on the puck.
      const shade = (puck.y - RINK.cy) * 0.25;
      dSlots = [{ x: oN + d * 8, y: 34 + shade }, { x: oN + d * 8, y: 51 + shade }];
      const press = { x: lerp(puck.x, oN, 0.12) + d * 2, y: lerp(puck.y, RINK.cy, 0.15) };
      fSlots = [press, { x: oN + d * 30, y: 22 }, { x: oN + d * 30, y: 63 }];
    } else if (z === 'N') {
      fSlots = [{ x: puck.x - d * 6, y: puck.y }, { x: puck.x - d * 15, y: 24 }, { x: puck.x - d * 15, y: 61 }];
      dSlots = [{ x: puck.x - d * 27, y: 31 }, { x: puck.x - d * 27, y: 54 }];
    } else {
      // Forechecking in their end.
      fSlots = [{ x: puck.x - d * 3, y: lerp(puck.y, RINK.cy, 0.2) }, { x: aN - d * 22, y: RINK.cy }, { x: aN - d * 42, y: 30 }];
      dSlots = [{ x: dBlue + d * 52, y: 24 }, { x: dBlue + d * 52, y: 61 }];
    }
    const place = (ids: number[], slots: Pt[]) =>
      ids.forEach((id, i) => {
        const s = slots[i % slots.length];
        out[id] = { x: s.x + (hash(id, beat, 1) - 0.5) * 4, y: s.y + (hash(id, beat, 2) - 0.5) * 4 };
      });
    place(fs, fSlots);
    place(ds, dSlots);
    const g = ice.goalies[team];
    if (g !== null) out[g] = { x: oN + d * 3.5, y: lerp(RINK.cy, puck.y, 0.1) };
  }
  if (carrier !== null && out[carrier]) out[carrier] = { x: puck.x - 1.6 * attackDir(meta.get(carrier)?.team ?? poss, ice.period), y: puck.y + 1 };
  for (const id of Object.keys(out)) out[+id] = clampPt(out[+id]);
  return out;
}

/** Stateful director: feed it events in order, read frames back. */
export class RinkDirector {
  puck: Pt = { x: RINK.cx, y: RINK.cy };
  carrier: number | null = null;
  poss: 0 | 1 = 0;
  players: Record<number, Pt> = {};
  shots: ShotMark[] = [];
  private beat = 0;
  private flashId = 0;
  private pendingMark: ShotMark | undefined;

  constructor(
    private meta: Map<number, RinkPlayer>,
    private abbr: [string, string],
  ) {}

  private frame(ice: IceState, motion: Frame['motion'], flash: Flash | null = null, goalLight: 0 | 1 | null = null): Frame {
    this.beat++;
    this.puck = clampPt(this.puck, 2);
    this.players = formation(ice, this.meta, this.puck, this.carrier, this.poss, this.beat);
    const mark = this.pendingMark;
    this.pendingMark = undefined;
    return { puck: { ...this.puck }, motion, carrier: this.carrier, players: this.players, flash, goalLight, mark };
  }

  private flash(text: string, kind: Flash['kind'], team: 0 | 1 | null = null): Flash {
    return { text, kind, team, id: ++this.flashId };
  }

  /** Spot a shooter at `dist` feet from the net his team attacks. */
  private shooterSpot(team: 0 | 1, period: number, dist: number, seed: number): Pt {
    const d = attackDir(team, period);
    const net = attackNetX(team, period);
    const r = Math.min(Math.max(dist, 5), 75);
    const a = (hash(seed, 7) - 0.5) * (r < 15 ? 1.6 : 1.9);
    return clampPt({ x: net - d * Math.cos(a) * r, y: RINK.cy + Math.sin(a) * r * 0.9 });
  }

  /** Frames to play for one event (usually one; shots get a wind-up frame). */
  apply(e: GameEvent, ice: IceState): Frame[] {
    const frames = this.applyInner(e, ice);
    frames[frames.length - 1].event = e;
    return frames;
  }

  private applyInner(e: GameEvent, ice: IceState): Frame[] {
    const p = ice.period;
    const seed = e.t * 13 + (e.p1 ?? 0);
    const t = e.team;
    const d = attackDir(t, p);
    const side = hash(seed, 3) < 0.5 ? -1 : 1;
    const dot = (x: number) => ({ x, y: RINK.cy + side * 22 });
    switch (e.type) {
      case 'periodStart':
        this.puck = { x: RINK.cx, y: RINK.cy };
        this.carrier = null;
        this.shots = this.shots.filter((s) => s.period === e.period);
        return [this.frame(ice, 'still', this.flash(e.period > 3 ? 'OVERTIME' : `PERIOD ${e.period}`, 'info'))];
      case 'faceoff': {
        const z = e.data?.zone ?? 'N';
        if (z === 'N') this.puck = hash(seed, 4) < 0.55 ? { x: RINK.cx, y: RINK.cy } : dot(RINK.cx + side * 20);
        else this.puck = dot(z === 'O' ? attackNetX(t, p) - d * 20 : ownNetX(t, p) + d * 20);
        this.poss = t;
        this.carrier = e.p1 ?? null;
        return [this.frame(ice, 'still')];
      }
      case 'breakout':
        this.poss = t;
        this.carrier = e.p1 ?? null;
        this.puck = { x: RINK.cx - d * 27, y: 15 + hash(seed, 5) * 55 };
        return [this.frame(ice, 'carry')];
      case 'entry':
        this.poss = t;
        this.carrier = e.p1 ?? null;
        this.puck = { x: RINK.cx + d * (32 + hash(seed, 6) * 14), y: 14 + hash(seed, 5) * 57 };
        return [this.frame(ice, 'carry', e.data?.oddMan ? this.flash('ODD-MAN RUSH', 'info', t) : null)];
      case 'offside':
        this.puck = { x: RINK.cx + d * 25, y: 20 + hash(seed, 5) * 45 };
        this.carrier = null;
        return [this.frame(ice, 'still', this.flash('OFFSIDE', 'info'))];
      case 'dumpIn':
        this.poss = t;
        this.carrier = null;
        this.puck = { x: attackNetX(t, p) + d * 4, y: side < 0 ? 7 : 78 };
        return [this.frame(ice, 'pass')];
      case 'battle':
      case 'takeaway':
        this.poss = t;
        this.carrier = e.p1 ?? null;
        return [this.frame(ice, 'carry')];
      case 'giveaway':
        this.poss = (1 - t) as 0 | 1;
        this.carrier = e.p2 ?? null;
        return [this.frame(ice, 'carry')];
      case 'pass': {
        this.poss = t;
        const to = e.p2 !== undefined ? this.players[e.p2] : undefined;
        this.puck = to ? { ...to } : { x: this.puck.x + d * 8, y: RINK.cy + side * 12 };
        this.carrier = e.p2 ?? null;
        return [this.frame(ice, 'pass')];
      }
      case 'shot': {
        this.poss = t;
        const dist = e.data?.dist ?? 30;
        this.carrier = e.p1 ?? null;
        this.puck = e.data?.en && dist > 80 ? { x: RINK.cx - d * (dist > 120 ? 45 : 0), y: RINK.cy + side * 15 } : this.shooterSpot(t, p, dist, seed);
        return [this.frame(ice, 'carry')];
      }
      case 'save': {
        // Saving team is e.team; the shot came at its own net.
        const net = ownNetX(t, p);
        const dd = attackDir(t, p);
        this.addShot({ ...this.puck, team: (1 - t) as 0 | 1, kind: 'save', period: p });
        this.puck = { x: net + dd * 4, y: RINK.cy + (hash(seed, 8) - 0.5) * 5 };
        this.carrier = null;
        return [this.frame(ice, 'shot', e.data?.big ? this.flash('BIG SAVE!', 'save', t) : this.flash('SAVE', 'save', t))];
      }
      case 'goal': {
        const net = attackNetX(t, p);
        if (this.carrier === null || this.carrier !== e.p1) this.puck = this.shooterSpot(t, p, e.data?.dist ?? 18, seed);
        this.addShot({ ...this.puck, team: t, kind: 'goal', period: p });
        this.puck = { x: net + d * 2.2, y: RINK.cy + (hash(seed, 9) - 0.5) * 3 };
        this.carrier = null;
        return [this.frame(ice, 'shot', this.flash(`${this.abbr[t]} GOAL!`, 'goal', t), t)];
      }
      case 'missed': {
        this.poss = t;
        const dist = e.data?.dist ?? 35;
        this.puck = this.shooterSpot(t, p, dist, seed);
        const wind = this.frame(ice, 'carry');
        this.addShot({ ...this.puck, team: t, kind: 'miss', period: p });
        this.puck = { x: attackNetX(t, p) + d * 5, y: RINK.cy + side * (7 + hash(seed, 10) * 8) };
        this.carrier = null;
        return [wind, this.frame(ice, 'shot')];
      }
      case 'blocked': {
        // e.team is the blocking side; the shooter (p2) is on the other team.
        const st = (1 - t) as 0 | 1;
        this.puck = this.shooterSpot(st, p, e.data?.dist ?? 40, seed);
        this.carrier = e.p2 ?? null;
        this.poss = st;
        const wind = this.frame(ice, 'carry');
        this.addShot({ ...this.puck, team: st, kind: 'block', period: p });
        const net = attackNetX(st, p);
        this.puck = { x: lerp(this.puck.x, net, 0.18), y: lerp(this.puck.y, RINK.cy, 0.18) };
        this.carrier = null;
        return [wind, this.frame(ice, 'shot', this.flash('BLOCKED', 'info', t))];
      }
      case 'rebound':
        this.poss = t;
        this.carrier = null;
        this.puck = { x: attackNetX(t, p) - d * (6 + hash(seed, 11) * 6), y: RINK.cy + side * (4 + hash(seed, 12) * 9) };
        return [this.frame(ice, 'pass', this.flash('REBOUND', 'info', t))];
      case 'freeze':
        this.carrier = null;
        return [this.frame(ice, 'still')];
      case 'clear':
        this.poss = t;
        this.carrier = null;
        this.puck = { x: RINK.cx + d * (hash(seed, 13) * 30 - 5), y: side < 0 ? 10 : 75 };
        return [this.frame(ice, 'pass')];
      case 'icing':
        this.carrier = null;
        this.puck = { x: attackNetX(t, p) + d * 6, y: side < 0 ? 9 : 76 };
        return [this.frame(ice, 'pass', this.flash('ICING', 'info'))];
      case 'hit':
        return [this.frame(ice, 'carry', this.flash('HIT', 'info', t))];
      case 'penalty':
        return [this.frame(ice, 'still', this.flash(`PENALTY · ${this.abbr[t]}`, 'penalty', t))];
      case 'fight':
        return [this.frame(ice, 'still', this.flash('FIGHT!', 'penalty'))];
      case 'goaliePulled':
        return [this.frame(ice, 'carry', this.flash(`${this.abbr[t]} PULL THE GOALIE`, 'info', t))];
      case 'periodEnd':
        this.carrier = null;
        return [this.frame(ice, 'still', this.flash('END OF PERIOD', 'info'))];
      case 'gameEnd':
        this.carrier = null;
        return [this.frame(ice, 'still', this.flash('FINAL', 'info'))];
      case 'shootout': {
        const net = attackNetX(t, p);
        this.puck = { x: net - d * 12, y: RINK.cy + side * 4 };
        this.carrier = e.p1 ?? null;
        const wind = this.frame(ice, 'carry');
        this.puck = e.data?.success ? { x: net + d * 2, y: RINK.cy } : { x: net - d * 3, y: RINK.cy + side * 6 };
        this.carrier = null;
        return [wind, this.frame(ice, 'shot', this.flash(e.data?.success ? 'SCORES!' : 'STOPPED', e.data?.success ? 'goal' : 'save', t))];
      }
      default:
        // Line changes, injuries, PP ends etc.: re-form with whoever is on the ice now.
        return [this.frame(ice, 'carry')];
    }
  }

  private addShot(m: ShotMark): void {
    this.shots.push(m);
    this.pendingMark = m;
  }

  /** Small movement between events so the play never looks frozen. */
  idle(ice: IceState): Frame {
    const d = attackDir(this.poss, ice.period);
    const z = zoneOf(this.puck, this.poss, ice.period);
    if (this.carrier !== null) {
      const step = z === 'O' ? (hash(this.beat, 21) - 0.45) * 8 : (hash(this.beat, 21) + 0.2) * 6;
      this.puck = { x: this.puck.x + d * step, y: this.puck.y + (hash(this.beat, 22) - 0.5) * 9 };
      // Stay inside the current zone so the picture never contradicts the sim.
      const u = (this.puck.x - RINK.cx) * d;
      const lim = z === 'O' ? [27, 88] : z === 'N' ? [-23, 23] : [-88, -27];
      const uc = Math.min(lim[1], Math.max(lim[0], u));
      this.puck.x = RINK.cx + uc * d;
    }
    return this.frame(ice, 'carry');
  }
}

/**
 * How long (game seconds) play stops at a whistle before the next faceoff.
 * The live view holds the game clock this long and the rink uses the same
 * pause to show the reset, so the two stay in sync.
 */
export function whistleHold(type: GameEvent['type']): number {
  switch (type) {
    case 'goal':
      return 3.2;
    case 'periodEnd':
      return 2.5;
    case 'penalty':
    case 'fight':
      return 2;
    case 'freeze':
    case 'icing':
    case 'offside':
    case 'goalieChange':
    case 'injury':
      return 1.5;
    default:
      return 0;
  }
}
