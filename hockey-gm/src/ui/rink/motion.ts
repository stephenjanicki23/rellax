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
import { RINK, attackDir, hash, whistleHold, type Frame, type IceState, type Pt, type RinkDirector, type RinkPlayer } from './director';

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
const WAYPOINT_EVERY = 1.6;

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
      // Waypoints so long possessions keep moving (not during stoppages).
      if (this.lastIce && !this.stopped && s - this.lastS > WAYPOINT_EVERY * 1.5) {
        const n = Math.floor((s - this.lastS) / WAYPOINT_EVERY);
        for (let i = 1; i < n; i++) this.push(this.director.idle(this.lastIce), this.lastS + ((s - this.lastS) * i) / n, this.lastIce.period);
      }
      const frames = this.director.apply(e, ice);
      let placed = this.lastS;
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
}

type PuckMode = { kind: 'carried'; carrier: number } | { kind: 'flying'; from: Pt; to: Pt; t0: number; t1: number } | { kind: 'loose' };

const SPEED = { F: 29, D: 26, G: 10 };
const ACCEL = { F: 36, D: 32, G: 30 };
const PASS_SPEED = 62;
const SHOT_SPEED = 115;

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
/** Keep a puck position on the ice surface. */
const onIce = (p: Pt): Pt => ({ x: Math.min(RINK.w - 2, Math.max(2, p.x)), y: Math.min(RINK.h - 2, Math.max(2, p.y)) });

export class RinkMotion {
  P = 0;
  bodies = new Map<number, Body>();
  puck: { pos: Pt; vel: Pt; mode: PuckMode } = { pos: { x: RINK.cx, y: RINK.cy }, vel: { x: 0, y: 0 }, mode: { kind: 'loose' } };
  period = 1;
  private k = 0;
  private flightFor = -1;
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
      const flyTime = Math.min(0.9, Math.max(0.1, dist(this.puck.pos, target.puck) / (target.motion === 'shot' ? SHOT_SPEED : PASS_SPEED)));
      if (target.s - this.P <= flyTime) {
        // Never faster than the pass/shot speed: a late start lands just after the keyframe.
        this.puck.mode = { kind: 'flying', from: { ...this.puck.pos }, to: onIce(target.puck), t0: this.P, t1: Math.max(target.s, this.P + flyTime) };
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
    else pos = { x: RINK.cx + (d > 0 ? -18 : 18), y: RINK.h - 2 }; // over the boards from the bench
    return { id, team, goalie, pos, vel: { x: 0, y: 0 }, leaving: 0 };
  }

  private reach(key: Key, idx: number): void {
    this.period = key.period;
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
      } else {
        // Line change: head for the bench and disappear (leaving the puck behind).
        b.leaving += dt;
        if (this.puck.mode.kind === 'carried' && this.puck.mode.carrier === b.id) {
          this.puck.mode = { kind: 'loose' };
          this.puck.vel = { x: 0, y: 0 };
        }
        tgt = { x: RINK.cx + (attackDir(b.team, this.period) > 0 ? -18 : 18), y: RINK.h + 2 };
        T = 1.2;
      }
      const desired = { x: (tgt.x - b.pos.x) / T, y: (tgt.y - b.pos.y) / T };
      const sp = Math.hypot(desired.x, desired.y);
      // Goalies shuffle in the crease but skate hard when far out of position.
      // Setting up for a faceoff, everyone glides into place a little quicker than game speed.
      const setup = target.faceoff && !b.goalie ? 1.7 : 1;
      const vmax = (b.goalie && Math.hypot(tgt.x - b.pos.x, tgt.y - b.pos.y) > 6 ? 20 : SPEED[kind]) * setup;
      if (sp > vmax) {
        desired.x *= vmax / sp;
        desired.y *= vmax / sp;
      }
      const dv = { x: desired.x - b.vel.x, y: desired.y - b.vel.y };
      const dvl = Math.hypot(dv.x, dv.y);
      const amax = ACCEL[kind] * setup * dt;
      if (dvl > amax) {
        dv.x *= amax / dvl;
        dv.y *= amax / dvl;
      }
      b.vel.x += dv.x;
      b.vel.y += dv.y;
      b.pos.x = Math.min(RINK.w - 2, Math.max(2, b.pos.x + b.vel.x * dt));
      b.pos.y = Math.min(RINK.h + 3, Math.max(2, b.pos.y + b.vel.y * dt));
      if (!want[b.id] && (b.leaving > 2.5 || b.pos.y > RINK.h)) this.bodies.delete(b.id);
    }
  }

  private movePuck(dt: number): void {
    const m = this.puck.mode;
    if (m.kind === 'flying') {
      const u = Math.min(1, (this.P - m.t0) / Math.max(0.01, m.t1 - m.t0));
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
      const tx = b.pos.x + dir.x * 3.6 + dir.y * 1.2;
      const ty = b.pos.y + dir.y * 3.6 - dir.x * 1.2 + 0.4;
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
      this.puck.pos = { x: Math.min(RINK.w - 2, Math.max(2, this.puck.pos.x + mx)), y: Math.min(RINK.h - 2, Math.max(2, this.puck.pos.y + my)) };
      return;
    }
    // Loose: slide with friction, bounce off the boards.
    const f = Math.exp(-1.4 * dt);
    this.puck.vel.x *= f;
    this.puck.vel.y *= f;
    let x = this.puck.pos.x + this.puck.vel.x * dt;
    let y = this.puck.pos.y + this.puck.vel.y * dt;
    if (x < 2 || x > RINK.w - 2) {
      this.puck.vel.x *= -0.5;
      x = Math.min(RINK.w - 2, Math.max(2, x));
    }
    if (y < 2 || y > RINK.h - 2) {
      this.puck.vel.y *= -0.5;
      y = Math.min(RINK.h - 2, Math.max(2, y));
    }
    this.puck.pos = { x, y };
  }
}
