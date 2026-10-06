import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { buildGameInput } from '../src/engine/league/gameInput';
import { GameSim } from '../src/engine/sim/engine';
import { RINK, RinkDirector, attackDir, whistleHold, type Frame, type RinkPlayer } from '../src/ui/rink/director';

describe('live rink director', () => {
  const league = createLeague({ seed: 'rink' });
  const input = buildGameInput(league, league.schedule[0].id, true);
  const sim = new GameSim(input);
  const players: RinkPlayer[] = ([input.home, input.away] as const).flatMap((t, team) => t.players.map((p) => ({ id: p.id, team: team as 0 | 1, pos: p.pos, number: p.number ?? null })));
  const dir = new RinkDirector(new Map(players.map((p) => [p.id, p])), ['H', 'A']);
  const frames: Frame[] = [];
  const goals: { team: 0 | 1; x: number; period: number }[] = [];
  while (!sim.finished) {
    const evs = sim.step();
    const s = sim.snapshot();
    for (const e of evs) {
      const fr = dir.apply(e, { period: s.inShootout ? 5 : e.period, onIce: s.onIce, goalies: s.goalies });
      frames.push(...fr);
      if (e.type === 'goal') goals.push({ team: e.team, x: fr[fr.length - 1].puck.x, period: e.period });
    }
  }

  it('keeps the puck and every player on the ice', () => {
    expect(frames.length).toBeGreaterThan(300);
    for (const f of frames) {
      for (const pt of [f.puck, ...Object.values(f.players)]) {
        expect(Number.isFinite(pt.x) && Number.isFinite(pt.y)).toBe(true);
        expect(pt.x).toBeGreaterThanOrEqual(0);
        expect(pt.x).toBeLessThanOrEqual(RINK.w);
        expect(pt.y).toBeGreaterThanOrEqual(0);
        expect(pt.y).toBeLessThanOrEqual(RINK.h);
      }
    }
  });
  it('puts goals in the net the scoring team attacks that period', () => {
    for (const g of goals) {
      if (g.period > 4) continue;
      const right = attackDir(g.team, g.period) > 0;
      expect(right ? g.x > RINK.goalR : g.x < RINK.goalL).toBe(true);
    }
  });
  it('switches ends between periods', () => {
    expect(attackDir(0, 1)).toBe(1);
    expect(attackDir(0, 2)).toBe(-1);
    expect(attackDir(1, 2)).toBe(1);
  });
  it('draws all ten skaters and both goalies at even strength', () => {
    const f = frames[Math.floor(frames.length / 3)];
    expect(Object.keys(f.players).length).toBeGreaterThanOrEqual(10);
  });
});

import { RinkMotion, RinkTimeline, type TimelineItem } from '../src/ui/rink/motion';

describe('continuous rink motion', () => {
  const league = createLeague({ seed: 'rink-motion' });
  const input = buildGameInput(league, league.schedule[3].id, true);
  const sim = new GameSim(input);
  const players: RinkPlayer[] = ([input.home, input.away] as const).flatMap((t, team) => t.players.map((p) => ({ id: p.id, team: team as 0 | 1, pos: p.pos, number: p.number ?? null })));
  const meta = new Map(players.map((p) => [p.id, p]));
  const tl = new RinkTimeline(new RinkDirector(meta, ['H', 'A']));
  while (!sim.finished) {
    const evs = sim.step();
    const s = sim.snapshot();
    tl.add(evs.map((e): TimelineItem => ({ e, ice: { period: s.inShootout ? 5 : e.period, onIce: s.onIce, goalies: s.goalies } })));
  }
  const motion = new RinkMotion(tl, meta);
  const dt = 1 / 60;
  let maxSkaterSpeed = 0;
  let maxPuckJump = 0;
  let nan = false;
  const goalPucks: number[] = [];
  let prev = { ...motion.puck.pos };
  const until = Math.min(tl.end, 1500);
  let jumps = 0;
  const dropMiss: number[] = [];
  const stoppages: number[] = [];
  let whistleAt: number | null = null;
  let lastDrop = -10;
  while (motion.P < until) {
    let reset = false;
    motion.step(dt, (k) => {
      if (k.goalLight !== null && k.period <= 3) goalPucks.push(k.puck.x);
      if (k.motion === 'still') reset = true;
      if (k.event && whistleHold(k.event.type) > 0) whistleAt = k.s;
      if (k.faceoff?.phase === 'drop') {
        // Everyone on his mark when the puck drops.
        for (const [id, pt] of Object.entries(k.players)) {
          const b = motion.bodies.get(+id);
          if (b) dropMiss.push(Math.hypot(b.pos.x - pt.x, b.pos.y - pt.y));
        }
        lastDrop = k.s;
        if (whistleAt !== null) stoppages.push(k.s - whistleAt);
        whistleAt = null;
      }
    });
    // Setting up for a faceoff, players glide into place faster than game speed.
    const settingUp = !!motion.next?.faceoff || motion.P - lastDrop < 1.5;
    for (const b of motion.bodies.values()) {
      const sp = Math.hypot(b.vel.x, b.vel.y);
      if (!b.goalie && !settingUp) maxSkaterSpeed = Math.max(maxSkaterSpeed, sp);
      if (!Number.isFinite(b.pos.x + b.pos.y)) nan = true;
    }
    const p = motion.puck.pos;
    const jump = Math.hypot(p.x - prev.x, p.y - prev.y);
    if (!reset && motion.puck.mode.kind !== 'flying') {
      maxPuckJump = Math.max(maxPuckJump, jump);
      if (jump > 4) jumps++;
    }
    prev = { ...p };
  }

  it('schedules keyframes in order', () => {
    for (let i = 1; i < tl.keys.length; i++) expect(tl.keys[i].s).toBeGreaterThanOrEqual(tl.keys[i - 1].s);
    expect(tl.keys.length).toBeGreaterThan(400);
  });
  it('moves skaters within realistic speed limits with no NaNs', () => {
    expect(nan).toBe(false);
    expect(maxSkaterSpeed).toBeLessThanOrEqual(29.5);
    expect(maxSkaterSpeed).toBeGreaterThan(10);
  });
  it('moves a carried or loose puck smoothly (no teleports outside stoppages)', () => {
    // 60 fps: a carried or sliding puck moves well under a foot per frame; only faceoff resets snap.
    expect(jumps).toBe(0);
    expect(maxPuckJump).toBeLessThan(4);
  });
  it('lines everyone up at the dot before the puck drops', () => {
    expect(dropMiss.length).toBeGreaterThan(20);
    const mean = dropMiss.reduce((a, b) => a + b, 0) / dropMiss.length;
    expect(mean).toBeLessThan(3);
    expect(dropMiss.filter((d) => d > 12).length / dropMiss.length).toBeLessThan(0.05);
  });
  it('pauses at every whistle before the next faceoff', () => {
    expect(stoppages.length).toBeGreaterThan(3);
    for (const s of stoppages) expect(s).toBeGreaterThan(1.8);
  });
  it('keeps everyone on the ice', () => {
    for (const b of motion.bodies.values()) {
      expect(b.pos.x).toBeGreaterThanOrEqual(0);
      expect(b.pos.x).toBeLessThanOrEqual(RINK.w);
    }
  });
});

describe('rink timeline stays in sync with the game clock', () => {
  it('never drifts behind game time plus whistle pauses over a full game', () => {
    const l = createLeague({ seed: 'rink-sync', rosters: false });
    const input = buildGameInput(l, l.schedule[0].id, true);
    const sim = new GameSim(input);
    const players: RinkPlayer[] = ([input.home, input.away] as const).flatMap((t, team) => t.players.map((p) => ({ id: p.id, team: team as 0 | 1, pos: p.pos, number: p.number ?? null })));
    const tl = new RinkTimeline(new RinkDirector(new Map(players.map((p) => [p.id, p])), ['H', 'A']));
    let holds = 0;
    let maxLag = 0;
    while (!sim.finished) {
      const evs = sim.step();
      const snap = sim.snapshot();
      for (const e of evs) {
        tl.add([{ e, ice: { period: e.period, onIce: snap.onIce, goalies: snap.goalies } }]);
        // Before the shootout/end-of-game burst the rink must sit on the game clock.
        if (e.period <= 3) maxLag = Math.max(maxLag, tl.end - (e.t + holds));
        holds += whistleHold(e.type);
      }
    }
    expect(maxLag).toBeLessThan(6);
  });
});
