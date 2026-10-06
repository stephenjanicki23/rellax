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
import type { Position, Tactics } from '../../engine/types';
import { systemSpots } from './systems';

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
  /** Seconds relative to the event's scheduled time (negative = before it); default spacing otherwise. */
  at?: number;
  /** Players heading to the penalty box from this frame on. */
  toBox?: number[];
  /** Faceoff staging: players lined up at the dot, then the puck drop. */
  faceoff?: { phase: 'lineup' | 'drop'; team: 0 | 1; p1?: number; p2?: number; dot: Pt };
}

export interface IceState {
  period: number;
  onIce: [number[], number[]];
  goalies: [number | null, number | null];
}

/** Corner radius of the boards (the drawn rink uses the same). */
export const CORNER_R = 28;

/** Keep a point on the ice surface, `m` feet inside the boards, including the rounded corners. */
export function onSurface(p: Pt, m = 2): Pt {
  let x = Math.min(RINK.w - m, Math.max(m, p.x));
  let y = Math.min(RINK.h - m, Math.max(m, p.y));
  const cx = x < CORNER_R ? CORNER_R : x > RINK.w - CORNER_R ? RINK.w - CORNER_R : null;
  const cy = y < CORNER_R ? CORNER_R : y > RINK.h - CORNER_R ? RINK.h - CORNER_R : null;
  if (cx !== null && cy !== null) {
    const dx = x - cx;
    const dy = y - cy;
    const d = Math.hypot(dx, dy);
    const lim = CORNER_R - m;
    if (d > lim) {
      x = cx + (dx / d) * lim;
      y = cy + (dy / d) * lim;
    }
  }
  return { x, y };
}

const clampPt = (p: Pt, m = 3.5): Pt => onSurface(p, m);
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
export function formation(ice: IceState, meta: Map<number, RinkPlayer>, puck: Pt, carrier: number | null, poss: 0 | 1, beat: number, tactics?: [Tactics | undefined, Tactics | undefined]): Record<number, Pt> {
  const out: Record<number, Pt> = {};
  const { period } = ice;
  // The team with the puck sets up first; the other team reads off where its players are.
  const marks: Record<number, Pt> = {};
  for (const team of [poss, (1 - poss) as 0 | 1]) {
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
        dSlots = [{ x: aBlue + d * 7, y: 21 }, { x: aBlue + d * 7, y: 64 }];
        fSlots = [
          { x: aN - d * 14, y: RINK.cy + side * -4 },
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
        // More players than slots (power play, extra attacker): the extra one takes the gap between two.
        const s = i < slots.length ? slots[i] : { x: (slots[i % slots.length].x + slots[(i + 1) % slots.length].x) / 2, y: (slots[i % slots.length].y + slots[(i + 1) % slots.length].y) / 2 };
        out[id] = { x: s.x + (hash(id, beat, 1) - 0.5) * 4, y: s.y + (hash(id, beat, 2) - 0.5) * 4 };
      });
    // The coach's system for this situation (forecheck, trap, power play, penalty kill, offensive style).
    const them = ice.onIce[1 - team].filter((id) => id !== ice.goalies[1 - team]).length;
    const sys = systemSpots({ d, zone: z, attacking, us: skaters.length, them, puckU: (puck.x - RINK.cx) * d, puckY: puck.y, tactics: tactics?.[team] });
    if (sys) {
      const jit = (id: number, p: Pt): Pt => ({ x: p.x + (hash(id, beat, 1) - 0.5) * 3, y: p.y + (hash(id, beat, 2) - 0.5) * 3 });
      const order = [...ds, ...fs];
      order.forEach((id, i) => {
        const spot = i < sys.length ? sys[i] : { x: (sys[i % sys.length].x + sys[(i + 1) % sys.length].x) / 2, y: (sys[i % sys.length].y + sys[(i + 1) % sys.length].y) / 2 };
        out[id] = jit(id, spot);
      });
    } else if (!attacking && z === 'D' && Object.keys(marks).length >= 3) {
      // Own-end coverage: one forward pressures the puck, defencemen take the attackers nearest
      // the net and the other forwards the ones further out, always goal-side of their man.
      const net = { x: oN, y: RINK.cy };
      const opp = Object.entries(marks)
        .map(([id, pt]) => ({ id: +id, pt, dn: Math.hypot(pt.x - net.x, pt.y - net.y) }))
        .filter((o) => o.id !== carrier)
        .sort((a, b) => a.dn - b.dn);
      // Between his man and the net, but never inside the crease area (the goalie's ice).
      const goalSide = (pt: Pt, by: number): Pt => {
        const len = Math.hypot(pt.x - net.x, pt.y - net.y) || 1;
        const r = Math.max(10, len - by);
        return { x: net.x + ((pt.x - net.x) / len) * r, y: net.y + ((pt.y - net.y) / len) * r };
      };
      const near = opp.slice(0, ds.length);
      const far = opp.slice(ds.length);
      ds.forEach((id, i) => (out[id] = near[i] ? goalSide(near[i].pt, 7) : dSlots[i % dSlots.length]));
      const [presser, ...rest] = fs;
      if (presser !== undefined) out[presser] = fSlots[0];
      rest.forEach((id, i) => (out[id] = far[i] ? goalSide(far[i].pt, 8) : fSlots[(i + 1) % fSlots.length]));
    } else {
      place(fs, fSlots);
      place(ds, dSlots);
    }
    const g = ice.goalies[team];
    if (g !== null) out[g] = { x: oN + d * 3.5, y: lerp(RINK.cy, puck.y, 0.1) };
    if (attacking) {
      if (carrier !== null && out[carrier]) out[carrier] = { x: puck.x - 1.6 * d, y: puck.y + 1 };
      for (const id of skaters) if (out[id]) marks[id] = out[id];
    }
  }
  if (carrier !== null && out[carrier] && meta.get(carrier)?.team !== poss) out[carrier] = { x: puck.x - 1.6 * attackDir(meta.get(carrier)?.team ?? poss, ice.period), y: puck.y + 1 };
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
  /** The last whistle (decides where the next faceoff is). */
  private whistle: { type: GameEvent['type']; team: 0 | 1 } | null = null;
  /** Where the coming faceoff should be, predicted at the whistle so players head there during the stoppage. */
  private nextDot: Pt | null = null;
  private pendingMark: ShotMark | undefined;

  constructor(
    private meta: Map<number, RinkPlayer>,
    private abbr: [string, string],
    /** Each team's tactics (home, away): the systems the players set up in. */
    private tactics?: [Tactics | undefined, Tactics | undefined],
  ) {}

  private frame(ice: IceState, motion: Frame['motion'], flash: Flash | null = null, goalLight: 0 | 1 | null = null, players?: Record<number, Pt>): Frame {
    this.beat++;
    this.puck = clampPt(this.puck, 2);
    this.players = players ?? formation(ice, this.meta, this.puck, this.carrier, this.poss, this.beat, this.tactics);
    const mark = this.pendingMark;
    this.pendingMark = undefined;
    return { puck: { ...this.puck }, motion, carrier: this.carrier, players: this.players, flash, goalLight, mark };
  }

  private flash(text: string, kind: Flash['kind'], team: 0 | 1 | null = null): Flash {
    return { text, kind, team, id: ++this.flashId };
  }

  /** Spot a shooter at `dist` feet from the net his team attacks. */
  private shooterSpot(team: 0 | 1, period: number, dist: number, seed: number, angleDeg?: number): Pt {
    const d = attackDir(team, period);
    const net = attackNetX(team, period);
    const r = Math.min(Math.max(dist, 5), 75);
    // The engine's shot angle when it has one (side of the ice chosen by seed); otherwise a spread around the slot.
    const a = angleDeg !== undefined ? (hash(seed, 7) < 0.5 ? -1 : 1) * (angleDeg * Math.PI) / 180 : (hash(seed, 7) - 0.5) * (r < 15 ? 1.6 : 1.9);
    return clampPt({ x: net - d * Math.cos(a) * r, y: RINK.cy + Math.sin(a) * r * 0.9 });
  }

  /** Frames to play for one event (usually one; shots get a wind-up frame). */
  apply(e: GameEvent, ice: IceState): Frame[] {
    const frames = this.applyInner(e, ice);
    frames[frames.length - 1].event = e;
    if (whistleHold(e.type) > 0 || e.type === 'periodStart') {
      this.whistle = { type: e.type, team: e.team };
      this.nextDot = this.predictDot(e, ice);
    } else if (e.type === 'faceoff') {
      this.whistle = null;
      this.nextDot = null;
    }
    return frames;
  }

  /** The faceoff spot a whistle implies (rulebook locations; null when it can't be known yet). */
  private predictDot(e: GameEvent, ice: IceState): Pt | null {
    const p = ice.period;
    const ySide = this.puck.y < RINK.cy ? -1 : 1;
    const ownZone = (t: 0 | 1): Pt => ({ x: ownNetX(t, p) + attackDir(t, p) * 20, y: RINK.cy + ySide * 22 });
    switch (e.type) {
      case 'goal':
      case 'fight':
      case 'periodStart':
        return { x: RINK.cx, y: RINK.cy };
      case 'icing':
      case 'freeze':
      case 'penalty':
        return ownZone(e.team);
      case 'offside':
        return { x: RINK.cx + attackDir(e.team, p) * 20, y: RINK.cy + ySide * 22 };
      default:
        return null;
    }
  }

  /**
   * An odd-man rush: the carrier and a winger drive the net with speed, one
   * defender back to take away the pass, the others caught up ice and
   * chasing from behind.
   */
  private oddManRush(ice: IceState, t: 0 | 1, seed: number): Record<number, Pt> {
    const p = ice.period;
    const d = attackDir(t, p);
    const u = (x: number) => (x - RINK.cx) * d;
    const at = (uu: number, y: number): Pt => ({ x: RINK.cx + d * uu, y });
    const pu = u(this.puck.x);
    const side = this.puck.y < RINK.cy ? -1 : 1;
    const out: Record<number, Pt> = {};
    const atk = ice.onIce[t].filter((id) => id !== ice.goalies[t] && id !== this.carrier);
    const def = ice.onIce[1 - t].filter((id) => id !== ice.goalies[1 - t]);
    // The rushing winger on the far side, the rest trailing.
    const fwdA = atk.filter((id) => this.meta.get(id)?.pos !== 'D');
    const wide = fwdA[0] ?? atk[0];
    atk.forEach((id, i) => {
      if (id === wide) out[id] = at(pu + 2, RINK.cy - side * 18);
      else out[id] = at(pu - 22 - i * 9, RINK.cy + (i % 2 ? 14 : -14));
    });
    if (this.carrier !== null) out[this.carrier] = { x: this.puck.x - 1.6 * d, y: this.puck.y + 1 };
    // One defender back between the two attackers, everyone else behind the play.
    const back = def.find((id) => this.meta.get(id)?.pos === 'D') ?? def[0];
    def.forEach((id, i) => {
      if (id === back) out[id] = at(Math.min(pu + 16, 72), RINK.cy + side * 4);
      else out[id] = at(pu - 9 - i * 7 - hash(seed, id) * 6, RINK.cy + ((i % 2 ? 1 : -1) * (8 + i * 4)));
    });
    for (const team of [0, 1] as const) {
      const g = ice.goalies[team];
      if (g !== null) out[g] = { x: ownNetX(team, p) + attackDir(team, p) * 3.5, y: RINK.cy };
    }
    for (const id of Object.keys(out)) out[+id] = clampPt(out[+id]);
    return out;
  }

  /** Turnovers happen in the zone the engine says (e.g. a neutral-zone takeaway isn't drawn on the blue line). */
  private puckInZone(e: GameEvent): void {
    if (e.data?.zone !== 'N') return;
    const u = this.puck.x - RINK.cx;
    if (Math.abs(u) > 19) this.puck = { x: RINK.cx + Math.sign(u) * (12 + hash(e.t, 17) * 7), y: this.puck.y };
  }

  /** A hit: the hitter arrives on his man and knocks him off his line. */
  private hitPlayers(ice: IceState, e: GameEvent): Record<number, Pt> {
    const out = formation(ice, this.meta, this.puck, this.carrier, this.poss, this.beat, this.tactics);
    const h = e.p1;
    const v = e.p2;
    if (h === undefined || v === undefined || !out[v]) return out;
    const from = this.players[h] ?? out[h] ?? out[v];
    const dx = out[v].x - from.x;
    const dy = out[v].y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    out[v] = clampPt({ x: out[v].x + (dx / len) * 2.5, y: out[v].y + (dy / len) * 2.5 });
    out[h] = clampPt({ x: out[v].x - (dx / len) * 4.2, y: out[v].y - (dy / len) * 4.2 });
    return out;
  }

  /** A fight: the two square off where they are; everyone else backs away and watches. */
  private fightPlayers(ice: IceState, e: GameEvent): Record<number, Pt> {
    const out = formation(ice, this.meta, this.puck, null, this.poss, this.beat, this.tactics);
    const a = e.p1;
    const b = e.p2;
    if (a === undefined || b === undefined) return out;
    const pa = this.players[a] ?? out[a] ?? this.puck;
    const pb = this.players[b] ?? out[b] ?? this.puck;
    const spot = clampPt({ x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 }, 8);
    for (const [id, pt] of Object.entries(out)) {
      if (ice.goalies.includes(+id)) continue;
      const dx = pt.x - spot.x;
      const dy = pt.y - spot.y;
      const dd = Math.hypot(dx, dy);
      if (dd < 18) out[+id] = clampPt({ x: spot.x + ((dd > 0.1 ? dx : 1) / (dd || 1)) * 18, y: spot.y + ((dd > 0.1 ? dy : 0) / (dd || 1)) * 18 });
    }
    // They are still on the ice until the officials step in, even if the engine has sent them off.
    out[a] = { x: spot.x - 2.2, y: spot.y };
    out[b] = { x: spot.x + 2.2, y: spot.y };
    return out;
  }

  /** Where the next faceoff is: centre after goals and period starts, the nearest neutral dot after offside. */
  private faceoffDot(e: GameEvent, ice: IceState, seed: number): Pt {
    const p = ice.period;
    const t = e.team;
    const d = attackDir(t, p);
    const z = e.data?.zone ?? 'N';
    const side = hash(seed, 3) < 0.5 ? -1 : 1;
    const w = this.whistle;
    const want = z === 'N' ? null : z === 'O' ? attackNetX(t, p) - d * 20 : ownNetX(t, p) + d * 20;
    const pred = this.nextDot;
    if (pred && (z === 'N' ? Math.abs(pred.x - RINK.cx) <= 20 : Math.abs(pred.x - want!) < 1)) return pred;
    if (z === 'N') {
      if (!w || w.type === 'goal' || w.type === 'periodStart' || w.type === 'periodEnd') return { x: RINK.cx, y: RINK.cy };
      // Offside: just outside the blue line the offending team was crossing.
      if (w.type === 'offside') return { x: RINK.cx + attackDir(w.team, p) * 20, y: RINK.cy + side * 22 };
      return hash(seed, 4) < 0.55 ? { x: RINK.cx, y: RINK.cy } : { x: RINK.cx + side * 20, y: RINK.cy + side * 22 };
    }
    // Same side of the ice the puck was on when play stopped.
    const ySide = this.puck.y < RINK.cy ? -1 : 1;
    return { x: z === 'O' ? attackNetX(t, p) - d * 20 : ownNetX(t, p) + d * 20, y: RINK.cy + ySide * 22 };
  }

  /** Faceoff alignment: centres at the dot, wingers on the hash marks, defence behind, goalies in net. */
  private lineup(ice: IceState, dot: Pt, centres: [number | undefined, number | undefined]): Record<number, Pt> {
    const out: Record<number, Pt> = {};
    for (const team of [0, 1] as const) {
      const d = attackDir(team, ice.period);
      const skaters = ice.onIce[team].filter((id) => id !== ice.goalies[team]);
      const c = centres[team] !== undefined && skaters.includes(centres[team]!) ? centres[team]! : skaters.find((id) => this.meta.get(id)?.pos === 'C') ?? skaters.find((id) => this.meta.get(id)?.pos !== 'D');
      const ds = skaters.filter((id) => id !== c && this.meta.get(id)?.pos === 'D');
      const ws = skaters.filter((id) => id !== c && !ds.includes(id));
      // Short-handed or extra skaters: fill wing spots first, then the point.
      const wingSlots = [{ x: dot.x - d * 3.2, y: dot.y - 9 }, { x: dot.x - d * 3.2, y: dot.y + 9 }];
      const dSlots = [{ x: dot.x - d * 15, y: dot.y - 10 }, { x: dot.x - d * 15, y: dot.y + 10 }, { x: dot.x - d * 15, y: dot.y }];
      if (c !== undefined) out[c] = { x: dot.x - d * 1.9, y: dot.y };
      ws.forEach((id, i) => (out[id] = wingSlots[i] ?? dSlots[2 - (i - 2)] ?? dSlots[2]));
      ds.forEach((id, i) => (out[id] = dSlots[i] ?? wingSlots[i % 2]));
      const g = ice.goalies[team];
      if (g !== null) out[g] = { x: ownNetX(team, ice.period) + d * 3.5, y: lerp(RINK.cy, dot.y, 0.12) };
    }
    for (const id of Object.keys(out)) out[+id] = clampPt(out[+id]);
    return out;
  }

  private applyInner(e: GameEvent, ice: IceState): Frame[] {
    const p = ice.period;
    const seed = e.t * 13 + (e.p1 ?? 0);
    const t = e.team;
    const d = attackDir(t, p);
    const side = hash(seed, 3) < 0.5 ? -1 : 1;
    switch (e.type) {
      case 'periodStart':
        this.puck = { x: RINK.cx, y: RINK.cy };
        this.carrier = null;
        this.shots = this.shots.filter((s) => s.period === e.period);
        return [this.frame(ice, 'still', this.flash(e.period > 3 ? 'OVERTIME' : `PERIOD ${e.period}`, 'info'))];
      case 'faceoff': {
        // Line up at the dot (players skate there during the stoppage), drop the puck, win it back.
        const dot = this.faceoffDot(e, ice, seed);
        const centres: [number | undefined, number | undefined] = t === 0 ? [e.p1, e.p2] : [e.p2, e.p1];
        const spots = this.lineup(ice, dot, centres);
        this.puck = { ...dot };
        this.carrier = null;
        const info = { team: t, p1: e.p1, p2: e.p2, dot };
        const lineup = { ...this.frame(ice, 'still', null, null, spots), at: -1, faceoff: { phase: 'lineup' as const, ...info } };
        const drop = { ...this.frame(ice, 'still', null, null, spots), at: 0, faceoff: { phase: 'drop' as const, ...info } };
        // Won back to a defenceman (or a winger when there's none).
        const mine = ice.onIce[t].filter((id) => id !== ice.goalies[t] && id !== e.p1);
        const back = mine.find((id) => this.meta.get(id)?.pos === 'D') ?? mine[0] ?? e.p1 ?? null;
        this.poss = t;
        this.carrier = back;
        if (back !== null && spots[back]) this.puck = { ...spots[back] };
        const won = { ...this.frame(ice, 'pass', null, null, spots), at: 0.5 };
        return [lineup, drop, won];
      }
      case 'breakout':
        this.poss = t;
        this.carrier = e.p1 ?? null;
        this.puck = { x: RINK.cx - d * 27, y: 15 + hash(seed, 5) * 55 };
        return [this.frame(ice, 'carry')];
      case 'entry': {
        this.poss = t;
        this.carrier = e.p1 ?? null;
        this.puck = { x: RINK.cx + d * (32 + hash(seed, 6) * 14), y: 14 + hash(seed, 5) * 57 };
        if (!e.data?.oddMan) return [this.frame(ice, 'carry')];
        return [this.frame(ice, 'carry', this.flash('ODD-MAN RUSH', 'info', t), null, this.oddManRush(ice, t, seed))];
      }
      case 'offside':
        this.puck = { x: RINK.cx + d * 25, y: 20 + hash(seed, 5) * 45 };
        this.carrier = null;
        return [this.frame(ice, 'still', this.flash('OFFSIDE', 'info'))];
      case 'dumpIn': {
        // Fired into the corner, then it rims around the boards behind the net.
        this.poss = t;
        this.carrier = e.p1 ?? this.carrier;
        // Dumped in from over the red line (from his own side it would be icing).
        this.puck = { x: RINK.cx + d * (4 + hash(seed, 14) * 14), y: Math.min(68, Math.max(17, this.puck.y)) };
        const release = { ...this.frame(ice, 'carry'), at: 0 };
        this.carrier = null;
        const net = attackNetX(t, p);
        this.puck = { x: net - d * 3, y: side < 0 ? 5 : 80 };
        const corner = { ...this.frame(ice, 'pass'), at: 0.9 };
        this.puck = { x: net + d * 7, y: RINK.cy - side * 14 };
        const rim = { ...this.frame(ice, 'pass'), at: 1.7 };
        return [release, corner, rim];
      }
      case 'battle':
      case 'takeaway':
        this.poss = t;
        this.carrier = e.p1 ?? null;
        this.puckInZone(e);
        return [this.frame(ice, 'carry')];
      case 'giveaway':
        this.poss = (1 - t) as 0 | 1;
        this.carrier = e.p2 ?? null;
        this.puckInZone(e);
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
        this.puck = e.data?.en && dist > 80 ? { x: RINK.cx - d * (dist > 120 ? 45 : 0), y: RINK.cy + side * 15 } : this.shooterSpot(t, p, dist, seed, e.data?.angle);
        // He gets set before he shoots; a slap shot needs a proper wind-up.
        const slap = /slap/i.test(e.data?.shotType ?? '');
        return [{ ...this.frame(ice, 'carry'), at: slap ? -0.35 : -0.1 }];
      }
      case 'save': {
        // Saving team is e.team; the shot came at its own net.
        const net = ownNetX(t, p);
        const dd = attackDir(t, p);
        this.addShot({ ...this.puck, team: (1 - t) as 0 | 1, kind: 'save', period: p });
        // Most saves are smothered or dropped at the pads; some are kicked out to the side.
        const kick = e.data?.big || hash(seed, 18) < 0.35;
        const ks = this.puck.y < RINK.cy ? -1 : 1;
        this.puck = kick ? { x: net + dd * (7 + hash(seed, 19) * 7), y: RINK.cy + ks * (9 + hash(seed, 20) * 10) } : { x: net + dd * 4, y: RINK.cy + (hash(seed, 8) - 0.5) * 5 };
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
        this.puck = this.shooterSpot(t, p, dist, seed, e.data?.angle);
        const wind = this.frame(ice, 'carry');
        this.addShot({ ...this.puck, team: t, kind: 'miss', period: p });
        this.puck = { x: attackNetX(t, p) + d * 5, y: RINK.cy + side * (7 + hash(seed, 10) * 8) };
        this.carrier = null;
        return [wind, this.frame(ice, 'shot')];
      }
      case 'blocked': {
        // e.team is the blocking side; the shooter (p2) is on the other team.
        const st = (1 - t) as 0 | 1;
        this.puck = this.shooterSpot(st, p, e.data?.dist ?? 40, seed, e.data?.angle);
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
        // A loose puck: the player who got hit was the one going for it.
        if (this.carrier === null && e.p2 !== undefined) {
          this.carrier = e.p2;
          this.poss = (1 - t) as 0 | 1;
        }
        return [this.frame(ice, 'carry', this.flash('HIT', 'info', t), null, this.hitPlayers(ice, e))];
      case 'penalty':
        return [{ ...this.frame(ice, 'still', this.flash(`PENALTY · ${this.abbr[t]}`, 'penalty', t)), toBox: e.p1 !== undefined ? [e.p1] : [] }];
      case 'fight':
        return [{ ...this.frame(ice, 'still', this.flash('FIGHT!', 'penalty'), null, this.fightPlayers(ice, e)), toBox: [e.p1, e.p2].filter((x): x is number => x !== undefined) }];
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
        // Line changes, injuries, PP ends etc.: re-form with whoever is on the ice now
        // (during a stoppage, heading for the coming faceoff).
        if (this.whistle && this.nextDot) return [this.frame(ice, 'carry', null, null, this.lineup(ice, this.nextDot, [undefined, undefined]))];
        return [this.frame(ice, 'carry')];
    }
  }

  private addShot(m: ShotMark): void {
    this.shots.push(m);
    this.pendingMark = m;
  }

  /**
   * A waypoint between two keyframes during live play: the carrier skates the
   * puck toward where the next play happens (curving, cycling when it's close),
   * and a loose puck is chased down by whoever wins it next. Doesn't change the
   * director's own state.
   */
  tween(ice: IceState, from: Frame, to: Frame, u: number, first: boolean): Frame {
    this.beat++;
    const onIce = new Set([...ice.onIce[0], ...ice.onIce[1]]);
    const next = to.carrier !== null && onIce.has(to.carrier) ? to.carrier : null;
    const cur = from.carrier !== null && onIce.has(from.carrier) ? from.carrier : null;
    let carrier = cur ?? next;
    let chaser: number | null = null;
    let puck: Pt;
    if (carrier === null) {
      // A loose puck nobody wins yet: the nearest skater goes after it.
      puck = { ...from.puck };
      let best = Infinity;
      for (const [id, pt] of Object.entries(from.players)) {
        if (ice.goalies.includes(+id) || !onIce.has(+id)) continue;
        const dd = Math.hypot(pt.x - puck.x, pt.y - puck.y);
        if (dd < best) {
          best = dd;
          chaser = +id;
        }
      }
    } else if (cur === null && first) {
      // Loose puck: the next carrier gets to it first, then picks it up.
      puck = { ...from.puck };
    } else {
      const a = from.puck;
      const b = to.puck;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      const e = u * u * (3 - 2 * u);
      const side = hash(this.beat, from.puck.x, 31) < 0.5 ? -1 : 1;
      // Close by: cycle around (a loop); far: a gentle curve up ice.
      const amp = len < 25 ? 14 : Math.min(10, len * 0.15);
      const nx = len > 0.1 ? -dy / len : 0;
      const ny = len > 0.1 ? dx / len : 1;
      const bend = Math.sin(Math.PI * u) * amp * side;
      puck = onSurface({ x: a.x + dx * e + nx * bend, y: a.y + dy * e + ny * bend }, 4);
      // A play that starts and ends in the same zone stays in it (no phantom exits and re-entries).
      const owner = this.meta.get(carrier)?.team ?? this.poss;
      const za = zoneOf(a, owner, ice.period);
      if (za === zoneOf(b, owner, ice.period)) {
        const dd = attackDir(owner, ice.period);
        const uu = (puck.x - RINK.cx) * dd;
        const [lo, hi] = za === 'O' ? [31, 95] : za === 'D' ? [-95, -31] : [-21, 21];
        puck = onSurface({ x: RINK.cx + Math.min(hi, Math.max(lo, uu)) * dd, y: puck.y }, 4);
      }
    }
    const lead = carrier ?? chaser;
    const team = lead !== null ? (this.meta.get(lead)?.team ?? this.poss) : this.poss;
    const players = formation(ice, this.meta, puck, lead, team, this.beat, this.tactics);
    // On the first waypoint toward a loose puck the chaser is placed at it, but hasn't touched it yet.
    if (cur === null && first) carrier = null;
    return { puck, motion: 'carry', carrier, players, flash: null, goalLight: null };
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
      return 5.5;
    case 'fight':
      return 4.5;
    case 'penalty':
      return 4;
    case 'icing':
    case 'injury':
      return 3.5;
    case 'freeze':
    case 'offside':
    case 'goalieChange':
      return 3.2;
    case 'periodStart':
    case 'periodEnd':
      return 2.8;
    default:
      return 0;
  }
}
