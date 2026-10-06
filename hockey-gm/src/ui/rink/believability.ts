/**
 * Believability checks for the live rink: plays a whole simulated game
 * through the director and motion model (no browser) and measures the things
 * that make the picture look wrong. Used by the test suite as a regression
 * gate and by `npm run rink:check` for a readable report.
 */
import type { GameInput } from '../../engine/sim/gameTypes';
import { GameSim } from '../../engine/sim/engine';
import { CORNER_R, RINK, RinkDirector, attackDir, whistleHold, type RinkPlayer } from './director';
import { RinkMotion, RinkTimeline, type TimelineItem } from './motion';

export interface RinkMetrics {
  /** Live-play seconds analysed. */
  seconds: number;
  /** Share of frames with two markers stacked (< 5 ft), away from the puck carrier, crease and bench. */
  stacked: number;
  /** Fastest skater (ft/s) outside faceoff set-up. */
  maxSpeed: number;
  /** Sharpest turn at speed (deg/s). */
  maxTurn: number;
  /** Times the puck sat still for more than 3 s in live play, per 20 minutes. */
  idlePer20: number;
  /** Frames where the puck was outside the rounded boards. */
  offIce: number;
  /** Carried or sliding puck jumping more than 4 ft in a frame (teleports). */
  teleports: number;
  /** Share of zone entries with a teammate already over the line. */
  offside: number;
  /** Share of samples with the goalie square to the puck. */
  goalieSquare: number;
  /** Mean distance (ft) of players from their marks when the puck drops. */
  faceoffMiss: number;
  /** Shortest whistle-to-drop pause (presentation seconds). */
  minStoppage: number;
}

function outsideBoards(p: { x: number; y: number }): boolean {
  const cx = p.x < CORNER_R ? CORNER_R : p.x > RINK.w - CORNER_R ? RINK.w - CORNER_R : null;
  const cy = p.y < CORNER_R ? CORNER_R : p.y > RINK.h - CORNER_R ? RINK.h - CORNER_R : null;
  return cx !== null && cy !== null && Math.hypot(p.x - cx, p.y - cy) > CORNER_R - 0.5;
}

/** Simulate `input` and measure how believable the rink's picture of it is. */
export function analyzeGame(input: GameInput, opts: { seconds?: number; dt?: number } = {}): RinkMetrics {
  const sim = new GameSim(input);
  const players: RinkPlayer[] = ([input.home, input.away] as const).flatMap((t, team) => t.players.map((p) => ({ id: p.id, team: team as 0 | 1, pos: p.pos, number: p.number ?? null })));
  const meta = new Map(players.map((p) => [p.id, p]));
  const tl = new RinkTimeline(new RinkDirector(meta, ['H', 'A'], [input.home.tactics, input.away.tactics]));
  while (!sim.finished) {
    const evs = sim.step();
    const s = sim.snapshot();
    tl.add(evs.map((e): TimelineItem => ({ e, ice: { period: s.inShootout ? 5 : e.period, onIce: s.onIce, goalies: s.goalies } })));
  }
  const motion = new RinkMotion(tl, meta);
  const dt = opts.dt ?? 1 / 60;
  const until = Math.min(tl.end, opts.seconds ?? 3700);

  let frames = 0;
  let live = 0;
  let stackedFrames = 0;
  let maxSpeed = 0;
  let maxTurn = 0;
  let idle = 0;
  let still = 0;
  let offIce = 0;
  let teleports = 0;
  let entries = 0;
  let offside = 0;
  let gChecks = 0;
  let gSquare = 0;
  const miss: number[] = [];
  const stoppages: number[] = [];
  let stopped = false;
  let whistleAt: number | null = null;
  let lastDrop = -10;
  const lastVel = new Map<number, { x: number; y: number }>();
  const neutralAt = new Map<number, number>();

  while (motion.P < until) {
    let reset = false;
    const p0 = { ...motion.puck.pos };
    motion.step(dt, (k) => {
      if (k.motion === 'still') reset = true;
      if (k.event && whistleHold(k.event.type) > 0) {
        stopped = true;
        whistleAt = k.s;
      }
      if (k.faceoff?.phase === 'drop') {
        for (const [id, pt] of Object.entries(k.players)) {
          const b = motion.bodies.get(+id);
          if (b) miss.push(Math.hypot(b.pos.x - pt.x, b.pos.y - pt.y));
        }
        if (whistleAt !== null) stoppages.push(k.s - whistleAt);
        whistleAt = null;
        stopped = false;
        lastDrop = k.s;
      }
    });
    frames++;
    if (!stopped) live += dt;
    const settingUp = !!motion.next?.faceoff || motion.P - lastDrop < 1.5;
    const p = motion.puck.pos;
    const carrier = motion.puck.mode.kind === 'carried' ? motion.puck.mode.carrier : -1;

    // Puck: on the ice, no teleports, not idle in live play.
    if (outsideBoards(p)) offIce++;
    if (!reset && motion.puck.mode.kind !== 'flying' && Math.hypot(p.x - p0.x, p.y - p0.y) > 4) teleports++;
    if (!stopped && Math.hypot(p.x - p0.x, p.y - p0.y) / dt < 2) still += dt;
    else {
      if (still > 3) idle++;
      still = 0;
    }

    // Skaters: speed, turning, spacing; goalies square.
    const skaters = [...motion.bodies.values()].filter((b) => !b.goalie && b.leaving === 0);
    for (const b of motion.bodies.values()) {
      const sp = Math.hypot(b.vel.x, b.vel.y);
      const pv = lastVel.get(b.id);
      if (!b.goalie && !settingUp) {
        maxSpeed = Math.max(maxSpeed, sp);
        if (pv && sp > 15 && Math.hypot(pv.x, pv.y) > 15) {
          const a = Math.atan2(b.vel.y, b.vel.x) - Math.atan2(pv.y, pv.x);
          maxTurn = Math.max(maxTurn, (Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) / dt) * (180 / Math.PI));
        }
      }
      lastVel.set(b.id, { ...b.vel });
      if (b.goalie && motion.puck.mode.kind !== 'flying') {
        const netX = attackDir(b.team, motion.period) > 0 ? RINK.goalL : RINK.goalR;
        const ahead = (p.x - netX) * attackDir(b.team, motion.period);
        if (ahead > 15 && ahead < 70) {
          gChecks++;
          const a1 = Math.atan2(p.y - RINK.cy, p.x - netX);
          const a2 = Math.atan2(b.pos.y - RINK.cy, b.pos.x - netX);
          if (Math.abs(Math.atan2(Math.sin(a1 - a2), Math.cos(a1 - a2))) < 0.35) gSquare++;
        }
      }
    }
    const spaced = skaters.filter((b) => b.id !== carrier);
    if (spaced.some((a, i) => spaced.slice(i + 1).some((b) => Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) < 5))) stackedFrames++;

    // Zone entries: nobody over the line before the puck.
    if (carrier >= 0) {
      const team = meta.get(carrier)?.team;
      if (team !== undefined) {
        const dd = attackDir(team, motion.period);
        const pu = (p.x - RINK.cx) * dd;
        const before = (p0.x - RINK.cx) * dd;
        if (pu < 18) neutralAt.set(team, motion.P);
        // A real entry: the puck was clearly in the neutral zone a moment ago (not wobbling on the line).
        if (before < 25 && pu >= 25 && pu < 40 && motion.P - (neutralAt.get(team) ?? -99) < 1.5) {
          entries++;
          const offs = skaters.filter((b) => b.team === team && b.id !== carrier && (b.pos.x - RINK.cx) * dd > 27);
          if (offs.length) {
            offside++;
          }
        }
      }
    }
  }
  return {
    seconds: Math.round(live),
    stacked: stackedFrames / Math.max(1, frames),
    maxSpeed,
    maxTurn,
    idlePer20: (idle / Math.max(1, live)) * 1200,
    offIce,
    teleports,
    offside: entries ? offside / entries : 0,
    goalieSquare: gChecks ? gSquare / gChecks : 1,
    faceoffMiss: miss.length ? miss.reduce((a, b) => a + b, 0) / miss.length : 0,
    minStoppage: stoppages.length ? Math.min(...stoppages) : 0,
  };
}

/** The bar every game must clear (see tests/believability.test.ts). */
export const RINK_LIMITS = {
  stacked: 0.25,
  maxSpeed: 30,
  maxTurn: 160,
  idlePer20: 6,
  offIce: 0,
  teleports: 0,
  offside: 0.25,
  goalieSquare: 0.8,
  faceoffMiss: 3.5,
  minStoppage: 1.8,
} as const;
