/**
 * Continuous rink motion.
 *
 * RinkTimeline schedules the director's frames as keyframes on a
 * presentation clock: each event lands at its game time plus the whistle
 * pauses so far (the same pauses the live view holds the game clock for), and
 * long gaps get waypoints so the puck carrier keeps skating.
 *
 * RinkMotion advances skaters and the puck in small time steps. Skaters
 * steer toward the next keyframe with speed and acceleration limits, so they
 * glide, curve and arrive on time instead of sliding in straight lines. The
 * puck is carried on a stick, flies along passes and shots, or slides loose
 * with friction.
 */
import type { GameEvent, GameEventType } from '../../engine/sim/gameTypes';
import { RINK, attackDir, hash, onSurface, whistleHold, type Frame, type IceState, type Pt, type RinkDirector, type RinkPlayer } from './director';

export interface TimelineItem {
  e: GameEvent;
  ice: IceState;
}

export interface Key extends Frame {
  /** Presentation time (game seconds plus whistle pauses). */
  s: number;
  period: number;
}

/** Minimum spacing after the previous keyframe when events share a timestamp. */
const GAP: Partial<Record<GameEventType, number>> = {
  pass: 0.55,
  shot: 0.4,
  save: 0.22,
  goal: 0.25,
  missed: 0.35,
  blocked: 0.3,
  rebound: 0.45,
  battle: 0.5,
  hit: 0.4,
  takeaway: 0.4,
  giveaway: 0.4,
  lineChange: 0.1,
  ppEnd: 0.05,
  periodStart: 0.1,
};
const WAYPOINT_EVERY = 1.1;

export class RinkTimeline {
  keys: Key[] = [];
  private lastS = 0;
  /** Whistle pauses so far: presentation time = game time + holds (the live view's clock does the same). */
  private holdSum = 0;
  /** In a stoppage (between a whistle and the next faceoff). */
  private stopped = false;
  private lastIce: IceState | null = null;

  constructor(private director: RinkDirector) {}

  /** Presentation time of the latest scheduled keyframe. */
  get end(): number {
    return this.lastS;
  }

  add(items: TimelineItem[]): void {
    for (const { e, ice } of items) {
      const gap = GAP[e.type] ?? 0.35;
      // Anchored to game time: events sharing a timestamp are spread out by small gaps,
      // but the schedule catches back up instead of drifting behind the game clock.
      // During a stoppage, line changes and other housekeeping happen right after the whistle,
      // leaving the rest of the pause for everyone to line up for the faceoff.
      const housekeeping = this.stopped && e.type !== 'faceoff' && e.type !== 'periodStart' && whistleHold(e.type) === 0;
      const s = housekeeping ? this.lastS + Math.max(gap, 0.4) : Math.max(this.lastS + gap, e.t + this.holdSum);
      const frames = this.director.apply(e, ice);
      let placed = this.lastS;
      // Waypoints so play keeps moving between engine events (not during stoppages):
      // toward where the next play happens.
      const prev = this.keys[this.keys.length - 1];
      const firstAt = frames[0].at !== undefined ? s + frames[0].at : s - (frames.length - 1) * 0.32;
      if (prev && this.lastIce && !this.stopped && firstAt - this.lastS > WAYPOINT_EVERY * 1.2) {
        const span = firstAt - this.lastS;
        const n = Math.max(2, Math.round(span / WAYPOINT_EVERY));
        for (let i = 1; i < n; i++) {
          placed = this.lastS + (span * i) / n;
          this.push(this.director.tween(this.lastIce, prev, frames[0], i / n, i === 1), placed, this.lastIce.period);
        }
      }
      frames.forEach((f, i) => {
        // Staged frames carry their own offset; otherwise lead-in frames are spaced just before the event.
        const want = f.at !== undefined ? s + f.at : s - (frames.length - 1 - i) * 0.32;
        placed = Math.max(placed + 0.05, want);
        this.push(f, placed, e.period);
      });
      this.lastS = Math.max(s, placed);
      this.lastIce = ice;
      if (e.type === 'faceoff' || e.type === 'periodStart') this.stopped = false;
      const hold = whistleHold(e.type);
      if (hold > 0) {
        this.holdSum += hold;
        this.stopped = true;
      }
    }
  }

  private push(f: Frame, s: number, period: number): void {
    this.keys.push({ ...f, s, period });
  }
}

interface Body {
  id: number;
  team: 0 | 1;
  goalie: boolean;
  pos: Pt;
  vel: Pt;
  leaving: number;
  /** Which way he's facing (radians); differs from his travel when skating backwards. */
  face: number;
}

/** Tightest turning radius at speed (feet): fast skaters carve, slow ones can pivot. */
const TURN_R = 9;
/** Braking (hockey stop) is quicker than accelerating. */
const BRAKE = 1.6;
/** Most sideways acceleration skate edges hold (ft/s²). */
const GRIP = 34;
/** How fast a skater can turn his body to face somewhere else (radians per second). */
const FACE_RATE = 7;

type PuckMode = { kind: 'carried'; carrier: number } | { kind: 'flying'; from: Pt; to: Pt; t0: number; t1: number; shot?: boolean } | { kind: 'loose' };

const SPEED = { F: 29, D: 26, G: 10 };
const ACCEL = { F: 36, D: 32, G: 30 };
const PASS_SPEED = 62;
const SHOT_SPEED = 115;
/** Short passes are soft, long stretch passes are fired (ft/s). */
const passSpeed = (len: number) => 48 + Math.min(34, len * 0.4);
/** Below this line (feet from the bottom boards) players heading to the bench may leave the ice. */
const CORNER_GATE = 6;

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
/** Keep a puck position on the ice surface. */
const onIce = (p: Pt): Pt => onSurface(p, 2);

export class RinkMotion {
  P = 0;
  bodies = new Map<number, Body>();
  puck: { pos: Pt; vel: Pt; mode: PuckMode } = { pos: { x: RINK.cx, y: RINK.cy }, vel: { x: 0, y: 0 }, mode: { kind: 'loose' } };
  period = 1;
  private k = 0;
  private flightFor = -1;
  /** Players on their way to the penalty box. */
  private boxBound = new Set<number>();
  /** Who picks the puck up when the current flight lands. */
  private pendingCarrier: number | null = null;

  constructor(
    private tl: RinkTimeline,
    private meta: Map<number, RinkPlayer>,
  ) {}

  /** Index of the next keyframe (all before it have been reached). */
  get next(): Key | undefined {
    return this.tl.keys[this.k];
  }

  /** Jump straight to presentation time `P`, placing everyone on their marks. */
  snapTo(P: number, onKey?: (k: Key) => void): void {
    const keys = this.tl.keys;
    while (this.k < keys.length && keys[this.k].s <= P) onKey?.(keys[this.k++]);
    this.P = P;
    const ref = keys[this.k] ?? keys[this.k - 1];
    if (!ref) return;
    const prev = keys[this.k - 1] ?? ref;
    this.period = prev.period;
    for (const id of [...this.bodies.keys()]) if (!ref.players[id]) this.bodies.delete(id);
    for (const [idStr, pt] of Object.entries(ref.players)) {
      const id = +idStr;
      const b = this.bodies.get(id) ?? this.newBody(id, pt);
      b.pos = { ...pt };
      b.vel = { x: 0, y: 0 };
      b.leaving = 0;
      this.bodies.set(id, b);
    }
    this.puck.pos = { ...prev.puck };
    this.puck.vel = { x: 0, y: 0 };
    this.puck.mode = prev.carrier !== null && this.bodies.has(prev.carrier) ? { kind: 'carried', carrier: prev.carrier } : { kind: 'loose' };
    this.flightFor = -1;
    this.pendingCarrier = null;
  }

  /** Jump to presentation time `P`, backwards or forwards (replays), without firing keyframe callbacks. */
  seek(P: number): void {
    const keys = this.tl.keys;
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[mid].s <= P) lo = mid + 1;
      else hi = mid;
    }
    this.k = lo;
    this.snapTo(P);
  }

  /** Advance by `dt` presentation seconds (call in small steps, e.g. ≤ 1/30 s). */
  step(dt: number, onKey?: (k: Key) => void): void {
    if (dt <= 0) return;
    this.P += dt;
    const keys = this.tl.keys;
    // Reach keyframes.
    while (this.k < keys.length && keys[this.k].s <= this.P) {
      const idx = this.k++;
      const key = keys[idx];
      this.reach(key, idx);
      onKey?.(key);
    }
    const target = keys[this.k] ?? keys[this.k - 1];
    if (!target) return;
    const remaining = Math.max(0.3, target.s - this.P);
    // Start a pass/shot flight so it lands exactly on its keyframe.
    if ((target.motion === 'pass' || target.motion === 'shot') && this.flightFor !== this.k) {
      const len = dist(this.puck.pos, target.puck);
      const flyTime = Math.min(0.9, Math.max(0.1, len / (target.motion === 'shot' ? SHOT_SPEED : passSpeed(len))));
      if (target.s - this.P <= flyTime) {
        // Never faster than the pass/shot speed: a late start lands just after the keyframe.
        this.puck.mode = { kind: 'flying', from: { ...this.puck.pos }, to: onIce(target.puck), t0: this.P, t1: Math.max(target.s, this.P + flyTime), shot: target.motion === 'shot' };
        this.flightFor = this.k;
      }
    }
    this.moveBodies(target, remaining, dt);
    this.movePuck(dt);
  }

  private newBody(id: number, at?: Pt): Body {
    const m = this.meta.get(id);
    const team = m?.team ?? 0;
    const goalie = m?.pos === 'G';
    const d = attackDir(team, this.period);
    let pos: Pt;
    if (goalie) pos = { x: (d > 0 ? RINK.goalL : RINK.goalR) + d * 3.5, y: RINK.cy };
    else if (at && (this.P < 1 || this.bodies.size < 6)) pos = { ...at };
    else pos = { x: RINK.cx + (d > 0 ? -18 : 18) + (hash(id, 41) - 0.5) * 16, y: RINK.h - 2 - hash(id, 42) * 3 }; // over the boards from the bench, spread along the gate
    return { id, team, goalie, pos, vel: { x: 0, y: 0 }, leaving: 0, face: d > 0 ? 0 : Math.PI };
  }

  private reach(key: Key, idx: number): void {
    this.period = key.period;
    for (const id of key.toBox ?? []) this.boxBound.add(id);
    // Still playing in a later frame (not sent off after all): not box-bound.
    for (const id of this.boxBound) if (key.players[id] && !key.toBox?.includes(id)) this.boxBound.delete(id);
    this.pendingCarrier = null;
    const carrier = key.carrier;
    if (key.motion === 'still') {
      this.puck.pos = { ...key.puck };
      this.puck.vel = { x: 0, y: 0 };
      this.puck.mode = carrier !== null ? { kind: 'carried', carrier } : { kind: 'loose' };
      return;
    }
    // A flight aimed at this keyframe that is still in the air finishes first.
    if (this.puck.mode.kind === 'flying' && this.flightFor === idx && this.P < this.puck.mode.t1 - 1e-6) {
      this.pendingCarrier = carrier !== null && this.bodies.has(carrier) ? carrier : null;
      return;
    }
    if (this.puck.mode.kind === 'flying' && this.flightFor === idx) this.puck.pos = { ...this.puck.mode.to };
    const cb = carrier !== null ? this.bodies.get(carrier) : undefined;
    if (carrier !== null && cb) {
      const gap = dist(this.puck.pos, cb.pos);
      if (gap > 5) {
        // A new carrier away from the puck: it gets there by a pass, not by magic.
        const to = onIce({ x: cb.pos.x + cb.vel.x * (gap / PASS_SPEED), y: cb.pos.y + cb.vel.y * (gap / PASS_SPEED) });
        this.puck.mode = { kind: 'flying', from: { ...this.puck.pos }, to, t0: this.P, t1: this.P + Math.min(0.8, Math.max(0.1, dist(this.puck.pos, to) / PASS_SPEED)) };
        this.pendingCarrier = carrier;
        return;
      }
      this.puck.mode = { kind: 'carried', carrier };
      return;
    }
    // Loose puck: keep a little of its momentum (rebounds, clears, dumps).
    const mode = this.puck.mode;
    if (mode.kind === 'flying') {
      const d = Math.max(0.1, dist(mode.from, mode.to));
      const v = key.motion === 'shot' ? 18 : 10;
      this.puck.vel = { x: ((mode.to.x - mode.from.x) / d) * v * (hash(key.s, 3) < 0.5 ? -0.6 : 0.4), y: ((mode.to.y - mode.from.y) / d) * v * 0.5 + (hash(key.s, 4) - 0.5) * 8 };
    } else if (key.motion === 'carry') {
      // Nobody has it: slide toward the spot (never faster than a hard pass).
      const v = { x: (key.puck.x - this.puck.pos.x) * 1.2, y: (key.puck.y - this.puck.pos.y) * 1.2 };
      const sp = Math.hypot(v.x, v.y);
      const k = sp > PASS_SPEED ? PASS_SPEED / sp : 1;
      this.puck.vel = { x: v.x * k, y: v.y * k };
    }
    this.puck.mode = { kind: 'loose' };
  }

  private moveBodies(target: Key, remaining: number, dt: number): void {
    const want = target.players;
    for (const idStr of Object.keys(want)) {
      const id = +idStr;
      if (!this.bodies.has(id)) this.bodies.set(id, this.newBody(id, want[id]));
    }
    // The team carrying the puck toward (but not yet over) the blue line it attacks.
    const pc = this.puck.mode.kind === 'carried' ? this.puck.mode.carrier : null;
    const pcTeam = pc !== null ? (this.meta.get(pc)?.team ?? null) : null;
    const pu = pcTeam !== null ? (this.puck.pos.x - RINK.cx) * attackDir(pcTeam, this.period) : 0;
    const onsideFor = pcTeam !== null && pu > -45 && pu < 25 ? pcTeam : null;
    for (const b of this.bodies.values()) {
      const m = this.meta.get(b.id);
      const kind = b.goalie ? 'G' : m?.pos === 'D' ? 'D' : 'F';
      let tgt: Pt;
      let T = remaining;
      if (want[b.id]) {
        b.leaving = 0;
        const w = want[b.id];
        // Gentle individual wander so nobody stands frozen.
        // Nearly still while lined up for a faceoff.
        const amp = b.goalie ? 0.6 : target.faceoff ? 0.2 : 1.8;
        const ph = b.id * 0.37;
        tgt = { x: w.x + Math.sin(this.P * 0.9 + ph) * amp, y: w.y + Math.cos(this.P * 0.7 + ph * 1.3) * amp };
        // The carrier skates the puck to where the next keyframe wants it.
        if (this.puck.mode.kind === 'carried' && this.puck.mode.carrier === b.id && target.carrier === b.id) tgt = { ...w };
        if (b.goalie) {
          tgt = this.goalieSpot(b);
          T = 0.25;
        }
        // Onside: until the puck is in the zone, attackers hold at the blue line.
        else if (onsideFor !== null && b.team === onsideFor && !(this.puck.mode.kind === 'carried' && this.puck.mode.carrier === b.id)) {
          const dd = attackDir(b.team, this.period);
          const lim = RINK.cx + dd * 22;
          if ((tgt.x - lim) * dd > 0) tgt = { x: lim, y: tgt.y };
          // Already in the zone: get out now (tag up).
          if ((b.pos.x - lim) * dd > 0) T = Math.min(T, 0.5);
        }
      } else {
        // Line change: head for the bench and disappear (leaving the puck behind).
        b.leaving += dt;
        if (this.puck.mode.kind === 'carried' && this.puck.mode.carrier === b.id) {
          this.puck.mode = { kind: 'loose' };
          this.puck.vel = { x: 0, y: 0 };
        }
        // Penalized players go to the box across from the benches; the rest change at the bench.
        tgt = this.boxBound.has(b.id) ? { x: RINK.cx + (b.team === 0 ? -7 : 7), y: -2 } : { x: RINK.cx + (attackDir(b.team, this.period) > 0 ? -18 : 18), y: RINK.h + 2 };
        T = this.boxBound.has(b.id) ? 2.2 : 1.2;
      }
      const desired = { x: (tgt.x - b.pos.x) / T, y: (tgt.y - b.pos.y) / T };
      // Goalies shuffle in the crease but skate hard when far out of position.
      // Setting up for a faceoff, everyone glides into place a little quicker than game speed.
      // (players coming a long way, e.g. off the bench for a faceoff in the far end, hurry more).
      const setup = target.faceoff && !b.goalie ? (Math.hypot(tgt.x - b.pos.x, tgt.y - b.pos.y) > 35 ? 2.3 : 1.7) : 1;
      const vmax = (b.goalie && Math.hypot(tgt.x - b.pos.x, tgt.y - b.pos.y) > 6 ? 20 : SPEED[kind]) * setup;
      const cap = (v: Pt, m: number) => {
        const l = Math.hypot(v.x, v.y);
        if (l > m) {
          v.x *= m / l;
          v.y *= m / l;
        }
      };
      cap(desired, vmax);
      const carrying = this.puck.mode.kind === 'carried' && this.puck.mode.carrier === b.id;
      if (!b.goalie && want[b.id]) {
        // Personal space: teammates spread out, opponents can close in to contact but don't stack up.
        // Applied after the seek is capped, so hurrying to a spot never overrides it.
        for (const o of this.bodies.values()) {
          if (o === b || (o.leaving > 0 && !want[o.id])) continue;
          const dx = b.pos.x - o.pos.x;
          const dy = b.pos.y - o.pos.y;
          const d = Math.hypot(dx, dy);
          const R = o.goalie ? 7.5 : o.team === b.team ? 9 : target.faceoff ? 4 : 7.5;
          if (d >= R) continue;
          // The puck carrier holds his line; others give way to him.
          const weight = carrying ? 0.35 : 1;
          const push = ((R - d) / R) * 40 * weight;
          const ux = d > 1e-3 ? dx / d : Math.cos(b.id);
          const uy = d > 1e-3 ? dy / d : Math.sin(b.id);
          desired.x += ux * push;
          desired.y += uy * push;
        }
        cap(desired, vmax);
      }
      const dv = { x: desired.x - b.vel.x, y: desired.y - b.vel.y };
      const amax = ACCEL[kind] * setup;
      const v = Math.hypot(b.vel.x, b.vel.y);
      if (v > 1e-3 && !b.goalie) {
        // Split the change into along-track (speed up / stop) and sideways (turning).
        const tx = b.vel.x / v;
        const ty = b.vel.y / v;
        let along = dv.x * tx + dv.y * ty;
        let side = -dv.x * ty + dv.y * tx;
        along = Math.max(-amax * BRAKE * dt, Math.min(amax * dt, along));
        // Turning: nearly stopped he can pivot; moving, the turn is limited by the tightest
        // radius (v²/r) and by how much the edges can grip, so fast skaters carve wide arcs.
        const sideMax = (v < 7 ? amax : Math.min(GRIP * Math.min(setup, 1.15), Math.max((v * v) / TURN_R, amax * 0.6))) * dt;
        side = Math.max(-sideMax, Math.min(sideMax, side));
        dv.x = along * tx - side * ty;
        dv.y = along * ty + side * tx;
      } else {
        const dvl = Math.hypot(dv.x, dv.y);
        if (dvl > amax * dt) {
          dv.x *= (amax * dt) / dvl;
          dv.y *= (amax * dt) / dvl;
        }
      }
      b.vel.x += dv.x;
      b.vel.y += dv.y;
      this.turnBody(b, dt);
      const nx = b.pos.x + b.vel.x * dt;
      const ny = b.pos.y + b.vel.y * dt;
      // Players leaving for the bench may step off the bottom edge; everyone else stays inside the boards.
      const toBox = !want[b.id] && this.boxBound.has(b.id);
      const offEdge = !want[b.id] && (toBox ? ny < CORNER_GATE : ny > RINK.h - CORNER_GATE);
      b.pos = offEdge ? { x: Math.min(RINK.w - 2, Math.max(2, nx)), y: Math.min(RINK.h + 3, Math.max(-3, ny)) } : onSurface({ x: nx, y: ny }, 2);
      if (!want[b.id] && (b.leaving > (toBox ? 7 : 2.5) || b.pos.y > RINK.h || b.pos.y < 0)) {
        this.bodies.delete(b.id);
        this.boxBound.delete(b.id);
      }
    }
  }

  /**
   * Where a goalie stands right now: on the line from the puck to the middle
   * of his net, further out when the puck is far away (cutting down the
   * angle), sealing the post when it's behind the goal line.
   */
  private goalieSpot(b: Body): Pt {
    const d = attackDir(b.team, this.period);
    const netX = d > 0 ? RINK.goalL : RINK.goalR;
    const p = this.puck.mode.kind === 'flying' ? this.puck.mode.to : this.puck.pos;
    const ahead = (p.x - netX) * d;
    if (ahead < 1) return { x: netX + d * 1.4, y: RINK.cy + (p.y < RINK.cy ? -2.6 : 2.6) };
    // Only his own half matters; at the far end he sits at the top of his crease.
    const far = ahead > 100;
    const px = far ? netX + d * 100 : p.x;
    const dx = px - netX;
    const dy = p.y - RINK.cy;
    const len = Math.hypot(dx, dy) || 1;
    const depth = Math.min(5.2, Math.max(2.4, len * 0.07));
    const y = RINK.cy + (dy / len) * depth;
    return { x: netX + (dx / len) * depth, y: Math.min(RINK.cy + 4.5, Math.max(RINK.cy - 4.5, y)) };
  }

  /**
   * Face the way he's skating, except when backing into his own end with the
   * play in front of him (a defender gapping up on a rush): then he skates
   * backwards, facing the puck.
   */
  private turnBody(b: Body, dt: number): void {
    const v = Math.hypot(b.vel.x, b.vel.y);
    const own = -attackDir(b.team, this.period);
    const carrier = this.puck.mode.kind === 'carried' ? this.puck.mode.carrier : null;
    const theirs = carrier !== null && this.meta.get(carrier)?.team !== b.team;
    const retreating = v > 4 && (b.vel.x * own) / v > 0.55;
    const puckAhead = (this.puck.pos.x - b.pos.x) * own < -6;
    let want: number;
    if (!b.goalie && theirs && retreating && puckAhead) want = Math.atan2(this.puck.pos.y - b.pos.y, this.puck.pos.x - b.pos.x);
    else if (v > 3) want = Math.atan2(b.vel.y, b.vel.x);
    else if (b.goalie) want = own > 0 ? Math.PI : 0;
    else return;
    let da = want - b.face;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    const step = FACE_RATE * dt;
    b.face += Math.max(-step, Math.min(step, da));
  }

  private movePuck(dt: number): void {
    const m = this.puck.mode;
    if (m.kind === 'flying') {
      const lin = Math.min(1, (this.P - m.t0) / Math.max(0.01, m.t1 - m.t0));
      // Passes come off the stick fast and slow on the ice; shots stay quick all the way.
      const u = m.shot ? lin : 1 - Math.pow(1 - lin, 1.45);
      this.puck.pos = { x: m.from.x + (m.to.x - m.from.x) * u, y: m.from.y + (m.to.y - m.from.y) * u };
      if (u >= 1) {
        const c = this.pendingCarrier;
        this.puck.mode = c !== null && this.bodies.has(c) ? { kind: 'carried', carrier: c } : { kind: 'loose' };
        const inNet = m.to.x < RINK.goalL + 1 || m.to.x > RINK.goalR - 1;
        if (this.puck.mode.kind === 'loose') this.puck.vel = inNet ? { x: 0, y: 0 } : { x: (m.to.x - m.from.x) * 0.15, y: (m.to.y - m.from.y) * 0.15 };
        this.pendingCarrier = null;
      }
      return;
    }
    if (m.kind === 'carried') {
      const b = this.bodies.get(m.carrier);
      if (!b) {
        // The carrier left the ice (line change): the puck stays where he left it.
        this.puck.mode = { kind: 'loose' };
        this.puck.vel = { x: 0, y: 0 };
        return;
      }
      const sp = Math.hypot(b.vel.x, b.vel.y);
      const dir = sp > 3 ? { x: b.vel.x / sp, y: b.vel.y / sp } : { x: attackDir(b.team, this.period), y: 0 };
      // On the blade, just outside the jersey so the puck stays visible.
      const tx = b.pos.x + dir.x * 4.6 + dir.y * 1.2;
      const ty = b.pos.y + dir.y * 4.6 - dir.x * 1.2 + 0.4;
      // Stickhandling: ease toward the blade, never faster than a quick pass.
      const ease = Math.min(1, dt * 14);
      let mx = (tx - this.puck.pos.x) * ease;
      let my = (ty - this.puck.pos.y) * ease;
      const ml = Math.hypot(mx, my);
      const cap = (sp + 40) * dt;
      if (ml > cap) {
        mx *= cap / ml;
        my *= cap / ml;
      }
      // The puck never leaves the ice surface, even if its carrier heads off over the boards.
      this.puck.pos = onIce({ x: this.puck.pos.x + mx, y: this.puck.pos.y + my });
      return;
    }
    // Loose: slide with friction, bounce off the boards.
    const f = Math.exp(-1.4 * dt);
    this.puck.vel.x *= f;
    this.puck.vel.y *= f;
    const want = { x: this.puck.pos.x + this.puck.vel.x * dt, y: this.puck.pos.y + this.puck.vel.y * dt };
    const at = onIce(want);
    if (Math.abs(at.x - want.x) > 1e-6 || Math.abs(at.y - want.y) > 1e-6) {
      // Off the boards: bounce back along the inward normal, losing speed.
      const nx = at.x - want.x;
      const ny = at.y - want.y;
      const nl = Math.hypot(nx, ny) || 1;
      const vn = (this.puck.vel.x * nx + this.puck.vel.y * ny) / nl;
      if (vn < 0) {
        this.puck.vel.x -= 1.5 * vn * (nx / nl);
        this.puck.vel.y -= 1.5 * vn * (ny / nl);
      }
      this.puck.vel.x *= 0.7;
      this.puck.vel.y *= 0.7;
    }
    this.puck.pos = at;
  }
}
