/**
 * Rink geometry for the per-second player engine.
 *
 * Coordinates are feet: x runs the length of the ice (-100..100, the home
 * team attacks +x), y the width (-42.5..42.5). Most decisions work in a
 * team's own attacking frame: u = x * dir (u = +89 is the goal line it
 * attacks), v = y.
 */

export const GOAL_LINE = 89;
export const BLUE_LINE = 25;
export const END_BOARDS = 100;
export const HALF_WIDTH = 42.5;
/** Faceoff dots in the attacking frame (u, v). */
export const DOTS = {
  center: [0, 0],
  ozLeft: [69, -22],
  ozRight: [69, 22],
  dzLeft: [-69, -22],
  dzRight: [-69, 22],
  nzOzLeft: [20, -22],
  nzOzRight: [20, 22],
} as const;

/** Scratch output for the allocation-free helpers. */
export const OUT: [number, number] = [0, 0];

export const dirOf = (side: 0 | 1): 1 | -1 => (side === 0 ? 1 : -1);

export interface Pt {
  x: number;
  y: number;
}

export const dist = (ax: number, ay: number, bx: number, by: number): number => {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
};

/** Distance from point p to segment a→b. */
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) return dist(px, py, ax, ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return dist(px, py, ax + t * dx, ay + t * dy);
}

/** Parameter along a→b of the closest point to p (0..1). */
export function along(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) return 0;
  return Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
}

/** Shot distance and angle (degrees from the centre line) to the attacked goal, in the attacking frame. */
export function shotGeometry(u: number, v: number): { dist: number; angle: number } {
  const du = GOAL_LINE - u;
  const d = Math.sqrt(du * du + v * v);
  // Behind the goal line the angle is past 90: treat as a sharp wraparound angle.
  const angle = du <= 0.5 ? 85 : Math.min(85, (Math.atan2(Math.abs(v), du) * 180) / Math.PI);
  return { dist: Math.max(3, d), angle };
}

/** Keep a point on the ice (rounded corners approximated by a 28 ft radius). */
export function clampToIce(x: number, y: number): [number, number] {
  let cx = Math.max(-END_BOARDS + 1, Math.min(END_BOARDS - 1, x));
  let cy = Math.max(-HALF_WIDTH + 1, Math.min(HALF_WIDTH - 1, y));
  const R = 28;
  const ex = END_BOARDS - R;
  const ey = HALF_WIDTH - R;
  if (Math.abs(cx) > ex && Math.abs(cy) > ey) {
    const ox = Math.sign(cx) * ex;
    const oy = Math.sign(cy) * ey;
    const d = dist(cx, cy, ox, oy);
    if (d > R - 1) {
      cx = ox + ((cx - ox) / d) * (R - 1);
      cy = oy + ((cy - oy) / d) * (R - 1);
    }
  }
  return [cx, cy];
}

/** Keep skaters out of the goal crease (6 ft around each net, in front of the goal line). */
export function outOfCrease(x: number, y: number): [number, number] {
  for (const gx of [GOAL_LINE, -GOAL_LINE]) {
    const dx = x - gx;
    const d = Math.sqrt(dx * dx + y * y);
    if (d < 6.5 && Math.sign(dx) !== Math.sign(gx)) {
      if (d < 1e-3) return [gx - Math.sign(gx) * 6.5, y];
      return [gx + (dx / d) * 6.5, (y / d) * 6.5];
    }
  }
  return [x, y];
}

/** Move from (x, y) toward (tx, ty) by at most `step` feet. */
export function stepToward(x: number, y: number, tx: number, ty: number, step: number): [number, number] {
  const d = dist(x, y, tx, ty);
  if (d <= step || d < 1e-6) return [tx, ty];
  return [x + ((tx - x) / d) * step, y + ((ty - y) / d) * step];
}

export type Role = 'C' | 'LW' | 'RW' | 'LD' | 'RD' | 'X';

export interface StructureOpts {
  forecheck: string;
  defense: string;
  offense: string;
  pp: boolean;
  pk: boolean;
  onside: boolean;
}

/**
 * Where a skater wants to be by structure, in his team's attacking frame
 * (result in OUT), given the puck's position (pu, pv) in that frame and
 * whether his team has it.
 */
export function structureSpot(role: Role, hasPuck: boolean, pu: number, pv: number, opts: StructureOpts): void {
  const r = spotFor(role, hasPuck, pu, pv, opts);
  OUT[0] = r[0];
  OUT[1] = r[1];
}

function spotFor(role: Role, hasPuck: boolean, pu: number, pv: number, opts: StructureOpts): [number, number] {
  const side = role === 'LW' || role === 'LD' ? -1 : role === 'RW' || role === 'RD' ? 1 : 0;
  const isD = role === 'LD' || role === 'RD';
  if (hasPuck) {
    if (pu > BLUE_LINE) {
      // Offensive zone.
      if (isD) return [opts.pp ? 58 : 62, side * (opts.pp ? 24 : 20)];
      if (role === 'C') return opts.pp ? [80, 0] : [76, pv * 0.25];
      return [opts.pp ? 70 : 74, side * 24];
    }
    if (pu > -BLUE_LINE) {
      // Neutral zone: forwards spread ahead of the puck but stay onside until it enters.
      const cap = opts.onside ? BLUE_LINE - 1.5 : 60;
      if (isD) return [pu - 22, side * 16];
      if (role === 'C') return [Math.min(pu + 12, cap), pv * 0.3];
      return [Math.min(pu + 18, cap), side * 28];
    }
    // Defensive zone: breakout.
    if (isD) return [Math.max(-84, pu - 6), side * 18];
    if (role === 'C') return [Math.min(-55, pu + 18), 0];
    return [Math.min(-28, pu + 30), side * 34];
  }
  // Without the puck (defending). The goal we protect is at u = -89 in our frame.
  if (pu < -BLUE_LINE) {
    // Defensive zone coverage.
    if (opts.pk) {
      const box = isD ? [-80, side * 9] : [-62, (side || 1) * 15];
      return [box[0], box[1]];
    }
    if (isD) return [-80, side * 8];
    if (role === 'C') return [-73, pv * 0.3];
    return [-62, side * 20];
  }
  // Defencemen always keep a gap between the puck and our net.
  const trap = opts.defense === 'trap' || opts.forecheck === '1-3-1';
  const gap = trap ? 30 : opts.defense === 'aggressive' ? 18 : 24;
  if (pu < BLUE_LINE) {
    // Neutral zone.
    if (isD) return [Math.max(-80, pu - gap), side * 14];
    if (role === 'C') return [pu - gap * 0.5, pv * 0.5];
    return [pu - gap * 0.3, side * 24];
  }
  // Forechecking in their zone.
  const deep = opts.forecheck === '2-1-2' ? 2 : opts.forecheck === '1-3-1' || opts.defense === 'trap' ? 0 : 1;
  if (isD) return [Math.min(opts.defense === 'trap' ? 12 : 30, pu - gap), side * 18];
  if (role === 'C') return deep >= 1 ? [pu - 8, pv * 0.6] : [40, 0];
  if (deep === 2) return [pu - 12, side * 22];
  return [opts.defense === 'trap' ? 22 : 45, side * 24];
}

/** One second of skating: step toward the target, stay on the ice and out of the crease (result in OUT). */
export function moveTo(x: number, y: number, tx: number, ty: number, step: number): void {
  const dx = tx - x;
  const dy = ty - y;
  const d = Math.sqrt(dx * dx + dy * dy);
  let nx = tx;
  let ny = ty;
  if (d > step && d > 1e-6) {
    nx = x + (dx / d) * step;
    ny = y + (dy / d) * step;
  }
  // On the ice (rounded corners)…
  nx = nx < -END_BOARDS + 1 ? -END_BOARDS + 1 : nx > END_BOARDS - 1 ? END_BOARDS - 1 : nx;
  ny = ny < -HALF_WIDTH + 1 ? -HALF_WIDTH + 1 : ny > HALF_WIDTH - 1 ? HALF_WIDTH - 1 : ny;
  const ex = END_BOARDS - 28;
  const ey = HALF_WIDTH - 28;
  if ((nx > ex || nx < -ex) && (ny > ey || ny < -ey)) {
    const ox = nx > 0 ? ex : -ex;
    const oy = ny > 0 ? ey : -ey;
    const cd = Math.sqrt((nx - ox) * (nx - ox) + (ny - oy) * (ny - oy));
    if (cd > 27) {
      nx = ox + ((nx - ox) / cd) * 27;
      ny = oy + ((ny - oy) / cd) * 27;
    }
  }
  // …and out of the crease.
  const gx = nx > 0 ? GOAL_LINE : -GOAL_LINE;
  const cx = nx - gx;
  if (Math.abs(cx) < 6.5 && Math.abs(ny) < 6.5 && (gx > 0 ? cx < 0 : cx > 0)) {
    const cd = Math.sqrt(cx * cx + ny * ny);
    if (cd < 6.5) {
      if (cd < 1e-3) nx = gx - Math.sign(gx) * 6.5;
      else {
        nx = gx + (cx / cd) * 6.5;
        ny = (ny / cd) * 6.5;
      }
    }
  }
  OUT[0] = nx;
  OUT[1] = ny;
}
