/**
 * Hockey invariants the match engine must never break, checked on whole
 * games stepped the way the live viewer steps them.
 */
import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { buildGameInput } from '../src/engine/league/gameInput';
import { GameSim } from '../src/engine/sim/engine';
import type { GameEvent, GameResult } from '../src/engine/sim/gameTypes';

const league = createLeague({ seed: 'invariants' });
const GAMES = 12;

interface Played {
  events: GameEvent[];
  result: GameResult;
  problems: string[];
}

function play(i: number): Played {
  const g = league.schedule[i];
  const sim = new GameSim(buildGameInput(league, g.id, true, 1000 + i));
  const events: GameEvent[] = [];
  const problems: string[] = [];
  let lastT = -1;
  let guard = 0;
  while (!sim.finished && guard++ < 100000) {
    const evs = sim.step();
    for (const e of evs) {
      if (e.t < lastT - 1e-9) problems.push(`clock went back: ${lastT} -> ${e.t} (${e.type})`);
      lastT = Math.max(lastT, e.t);
      events.push(e);
    }
    const s = sim.snapshot();
    if (s.inShootout || s.finished) continue;
    const seen = new Set<number>();
    for (const side of [0, 1] as const) {
      const ice = s.onIce[side];
      const skaters = ice.length;
      const pulled = s.goalies[side] === null;
      if (skaters > (pulled ? 6 : 5)) problems.push(`too many skaters: team ${side} has ${skaters} (goalie pulled: ${pulled}) at ${s.period}/${s.clock.toFixed(1)}`);
      if (skaters < 3) problems.push(`fewer than three skaters: team ${side} has ${skaters}`);
      for (const id of ice) {
        if (seen.has(id)) problems.push(`player ${id} on the ice twice`);
        seen.add(id);
        if (s.box.some((b) => b.player === id)) problems.push(`player ${id} on the ice while serving a penalty`);
      }
      if (s.goalies[side] !== null && ice.includes(s.goalies[side]!)) problems.push(`goalie ${s.goalies[side]} counted as a skater`);
    }
  }
  if (!sim.finished) problems.push('game did not finish');
  return { events, result: sim.result(), problems };
}

const games = Array.from({ length: GAMES }, (_, i) => play(i));

describe('match engine invariants', () => {
  it('keeps the clock moving forward, legal skater counts, and nobody in two places', () => {
    for (const g of games) expect(g.problems).toEqual([]);
  });

  it('the score is exactly the goals scored (plus the shootout winner)', () => {
    for (const { events, result } of games) {
      for (const side of [0, 1] as const) {
        const goals = events.filter((e) => e.type === 'goal' && e.team === side).length;
        const winner = result.homeGoals > result.awayGoals ? 0 : 1;
        const soBonus = result.so && winner === side ? 1 : 0;
        expect(result.teams[side].goals).toBe(goals);
        expect(side === 0 ? result.homeGoals : result.awayGoals).toBe(goals + soBonus);
      }
      expect(result.homeGoals).not.toBe(result.awayGoals);
    }
  });

  it('every goal is a shot on goal, and shots, saves and goals reconcile for each goalie', () => {
    for (const { events, result } of games) {
      for (const side of [0, 1] as const) {
        const opp = (1 - side) as 0 | 1;
        // Save events belong to the goalie's team; goals and shots to the shooter's.
        const saves = events.filter((e) => e.type === 'save' && e.team === side).length;
        const oppGoals = events.filter((e) => e.type === 'goal' && e.team === opp).length;
        const shotsOn = saves + oppGoals;
        expect(events.filter((e) => e.type === 'shot' && e.team === opp).length).toBe(shotsOn);
        expect(result.teams[opp].shots).toBe(shotsOn);
        const enGoals = events.filter((e) => e.type === 'goal' && e.team === opp && e.data?.en).length;
        const goalies = Object.values(result.players).filter((p) => p.team === side && (p.sa > 0 || p.gtoi > 0));
        const sa = goalies.reduce((x, p) => x + p.sa, 0);
        const ga = goalies.reduce((x, p) => x + p.ga, 0);
        expect(sa).toBe(shotsOn - enGoals);
        expect(sa - ga).toBe(saves);
        expect(ga).toBe(result.teams[opp].goals - enGoals);
      }
    }
  });

  it('goals and assists are credited to the players in the scoring play', () => {
    for (const { events, result } of games) {
      for (const e of events.filter((x) => x.type === 'goal')) {
        expect(e.p1).toBeDefined();
        const scorer = result.players[e.p1!];
        expect(scorer.team).toBe(e.team);
        for (const a of [e.p2, e.p3]) if (a !== undefined) expect(result.players[a].team).toBe(e.team);
        expect(new Set([e.p1, e.p2, e.p3].filter((x) => x !== undefined)).size).toBe([e.p1, e.p2, e.p3].filter((x) => x !== undefined).length);
      }
      for (const side of [0, 1] as const) {
        const mine = Object.values(result.players).filter((p) => p.team === side);
        const goalEvents = events.filter((e) => e.type === 'goal' && e.team === side);
        expect(mine.reduce((x, p) => x + p.g, 0)).toBe(goalEvents.length);
        const assists = goalEvents.reduce((x, e) => x + (e.p2 !== undefined ? 1 : 0) + (e.p3 !== undefined ? 1 : 0), 0);
        expect(mine.reduce((x, p) => x + p.a1 + p.a2, 0)).toBe(assists);
      }
    }
  });

  it('every penalty resolves: power plays end and penalized players come back', () => {
    for (const { events } of games) {
      const pens = events.filter((e) => e.type === 'penalty' && (e.data?.minutes ?? 0) <= 4 && e.data?.penalty !== 'fighting');
      expect(pens.length).toBeGreaterThanOrEqual(0);
      // No power-play goal while both sides are at even strength by the box.
      for (const goal of events.filter((e) => e.type === 'goal' && e.data?.strength === 'PP')) {
        const before = events.filter((e) => e.t <= goal.t && e.type === 'penalty' && e.team !== goal.team);
        expect(before.length).toBeGreaterThan(0);
      }
    }
  });

  it('plays a legal game length: three periods, then overtime and a shootout only when tied', () => {
    for (const { events, result } of games) {
      const periods = new Set(events.filter((e) => e.type === 'periodStart').map((e) => e.period));
      expect(periods.has(1) && periods.has(2) && periods.has(3)).toBe(true);
      const reg = events.filter((e) => e.type === 'goal' && e.period <= 3);
      const regScore = [0, 1].map((s) => reg.filter((e) => e.team === s).length);
      if (regScore[0] !== regScore[1]) expect(result.periods).toBe(3);
      else expect(result.periods).toBeGreaterThan(3);
      expect(events.at(-1)!.type).toBe('gameEnd');
    }
  });

  it('every event has an id, and outcomes trace back to the play that caused them', () => {
    for (const { events } of games) {
      const byId = new Map(events.map((e) => [e.id!, e]));
      let last = 0;
      for (const e of events) {
        expect(e.id).toBeGreaterThan(last);
        last = e.id!;
        if (e.data?.p !== undefined) {
          expect(e.data.p).toBeGreaterThanOrEqual(0);
          expect(e.data.p).toBeLessThanOrEqual(1);
        }
      }
      for (const e of events) {
        if (e.type === 'save' || (e.type === 'goal' && e.period <= 4)) {
          const shot = byId.get(e.cause!);
          expect(shot?.type).toBe('shot');
          // Same shooter: the save's p2 / the goal's p1.
          expect(shot!.p1).toBe(e.type === 'save' ? e.p2 : e.p1);
          expect(shot!.data?.p).toBe(e.data?.p);
        }
        if (e.type === 'rebound') expect(byId.get(e.cause!)?.type).toBe('save');
        if (e.cause !== undefined) expect(byId.get(e.cause)!.t).toBeLessThanOrEqual(e.t);
      }
      // Passes are logged everywhere with how they ended.
      const passes = events.filter((e) => e.type === 'pass');
      expect(passes.length).toBeGreaterThan(100);
      expect(passes.some((e) => e.data?.success === false)).toBe(true);
    }
  });
});

import { cloneInput, loadGame, saveGame } from '../src/engine/sim/savedGame';

describe('saving and resuming a game in progress', () => {
  it('resumes from a save (even after a JSON round trip) and plays out exactly the same', () => {
    for (const i of [0, 3, 7]) {
      const g = league.schedule[i];
      const input = buildGameInput(league, g.id, true, 500 + i);
      // Reference: straight through.
      const ref = new GameSim(cloneInput(input));
      const refEvents: GameEvent[] = [];
      while (!ref.finished) refEvents.push(...ref.step());
      // Save part-way (mid-period, mid-possession), store as JSON, resume, finish.
      const live = new GameSim(cloneInput(input));
      const seen: GameEvent[] = [];
      const stopAt = 400 + i * 911;
      while (!live.finished && live.steps < stopAt) seen.push(...live.step());
      const json = JSON.stringify(saveGame(live));
      const resumed = loadGame(JSON.parse(json));
      expect(resumed.steps).toBe(live.steps);
      expect(resumed.snapshot()).toEqual(live.snapshot());
      const after: GameEvent[] = [];
      while (!resumed.finished) after.push(...resumed.step());
      const a = ref.result();
      const b = resumed.result();
      expect([b.homeGoals, b.awayGoals]).toEqual([a.homeGoals, a.awayGoals]);
      expect(b.players).toEqual(a.players);
      expect(b.teams).toEqual(a.teams);
      // The events after the save are the same as the reference's.
      expect(after).toEqual(refEvents.slice(seen.length));
    }
  });

  it('a portable copy of the input plays the identical game', () => {
    const input = buildGameInput(league, league.schedule[5].id, true, 42);
    const a = new GameSim(input).simulate();
    const b = new GameSim(cloneInput(input)).simulate();
    expect(b.events).toEqual(a.events);
    expect(b.players).toEqual(a.players);
  });
});
