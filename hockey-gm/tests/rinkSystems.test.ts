import { describe, expect, it } from 'vitest';
import { formation, RINK, type IceState, type RinkPlayer } from '../src/ui/rink/director';
import type { Tactics } from '../src/engine/types';

const T = (over: Partial<Tactics> = {}): Tactics => ({ offense: 'balanced', defense: 'balanced', forecheck: '1-2-2', pp: 'umbrella', pk: 'box', lineUsage: 'balanced', pullGoalie: 'normal', ...over }) as Tactics;
// Home (team 0) attacks right in period 1.
const mk = (id: number, team: 0 | 1, pos: RinkPlayer['pos']): RinkPlayer => ({ id, team, pos, number: id });
const home = [mk(1, 0, 'C'), mk(2, 0, 'LW'), mk(3, 0, 'RW'), mk(4, 0, 'D'), mk(5, 0, 'D'), mk(6, 0, 'G')];
const away = [mk(11, 1, 'C'), mk(12, 1, 'LW'), mk(13, 1, 'RW'), mk(14, 1, 'D'), mk(15, 1, 'D'), mk(16, 1, 'G')];
const meta = new Map([...home, ...away].map((p) => [p.id, p]));
const ice = (h: number[], a: number[]): IceState => ({ period: 1, onIce: [[...h, 6], [...a, 16]], goalies: [6, 16] });

describe('team systems on the live rink', () => {
  it('runs an umbrella power play: a quarterback up top and a net-front presence', () => {
    const f = formation(ice([1, 2, 3, 4, 5], [11, 12, 14, 15]), meta, { x: 150, y: 20 }, 2, 0, 1, [T({ pp: 'umbrella' }), T()]);
    const att = [1, 3, 4, 5].map((id) => f[id]);
    expect(att.some((p) => p.x < 135 && Math.abs(p.y - RINK.cy) < 6)).toBe(true); // QB at the top
    expect(att.some((p) => p.x > 175 && Math.abs(p.y - RINK.cy) < 8)).toBe(true); // net front
  });
  it('kills a penalty in a tight box in front of its net', () => {
    const f = formation(ice([1, 2, 3, 4, 5], [11, 12, 14, 15]), meta, { x: 160, y: 30 }, 2, 0, 1, [T(), T({ pk: 'box' })]);
    for (const id of [11, 12, 14, 15]) {
      expect(f[id].x).toBeGreaterThan(155);
      expect(Math.abs(f[id].y - RINK.cy)).toBeLessThan(25);
    }
    // Defencemen low, forwards high.
    expect(Math.min(f[14].x, f[15].x)).toBeGreaterThan(Math.max(f[11].x, f[12].x));
  });
  it('forechecks 2-1-2 with two forwards deep, 1-2-2 with one', () => {
    const puck = { x: 20, y: 70 }; // home's puck deep in its own end; away forechecks
    const deep = (tac: Tactics) => {
      const f = formation(ice([1, 2, 3, 4, 5], [11, 12, 13, 14, 15]), meta, puck, 4, 0, 1, [T(), tac]);
      return [11, 12, 13].filter((id) => f[id].x < 35).length;
    };
    expect(deep(T({ forecheck: '2-1-2' }))).toBe(2);
    expect(deep(T({ forecheck: '1-2-2' }))).toBe(1);
  });
  it('sets a neutral-zone trap: four players back near their blue line', () => {
    const f = formation(ice([1, 2, 3, 4, 5], [11, 12, 13, 14, 15]), meta, { x: 95, y: 40 }, 1, 0, 1, [T(), T({ defense: 'trap' })]);
    // Away defends the right-hand net; its blue line is at x = 125.
    expect([11, 12, 13, 14, 15].filter((id) => f[id].x > 118).length).toBeGreaterThanOrEqual(4);
  });
});
