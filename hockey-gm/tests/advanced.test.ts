import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { simDays } from '../src/engine/league/season';
import { PLAYER_METRICS, TEAM_METRICS, leaders, playerMetric, rankOf, seasonRows, teamTotals } from '../src/engine/league/advanced';
import { ZONE_COUNT, shotZone, zoneBounds } from '../src/engine/core/shotZones';

describe('advanced stats and shot charts', () => {
  const l = createLeague({ seed: 'adv-1' });
  simDays(l, 20);
  const { rows } = seasonRows(l);

  it('records a shot chart for every shooter that matches his shots and goals', () => {
    expect(l.shotCharts?.season).toBe(l.season);
    const charts = l.shotCharts!.players;
    let checked = 0;
    for (const r of rows) {
      if (r.p.pos === 'G' || !r.s.sog) continue;
      const z = charts[r.p.id];
      expect(z).toBeDefined();
      expect(z.slice(0, ZONE_COUNT).reduce((a, b) => a + b, 0)).toBe(r.s.sog);
      expect(z.slice(ZONE_COUNT).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(r.s.g);
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('puts close shots in close zones and wide-angle shots in wide zones', () => {
    expect(zoneBounds(shotZone(5, 10))[0]).toBe(0);
    expect(zoneBounds(shotZone(50, 10))[0]).toBe(45);
    expect(zoneBounds(shotZone(15, 60))[2]).toBe(40);
  });

  it('links every team stat to a player stat for the leaders page', () => {
    for (const m of TEAM_METRICS) expect(playerMetric(m.player), m.key).toBeDefined();
  });

  it('ranks leaders best first, honouring lower-is-better stats and sample minimums', () => {
    for (const m of PLAYER_METRICS) {
      const list = leaders(rows, m);
      for (const x of list) expect(m.qualifies(x.row.s)).toBe(true);
      for (let i = 1; i < list.length; i++) {
        if (m.better === 'high') expect(list[i].value).toBeLessThanOrEqual(list[i - 1].value);
        else expect(list[i].value).toBeGreaterThanOrEqual(list[i - 1].value);
      }
    }
    const xga = leaders(rows, playerMetric('xga60')!);
    expect(xga.length).toBeGreaterThan(50);
    expect(xga[0].value).toBeLessThan(xga[xga.length - 1].value);
  });

  it('filters leaders by position and can leave out your own team', () => {
    const m = playerMetric('p60')!;
    expect(leaders(rows, m, { pos: 'D' }).every((x) => x.row.p.pos === 'D')).toBe(true);
    expect(leaders(rows, m, { excludeTeam: l.userTeamId }).every((x) => x.row.teamId !== l.userTeamId)).toBe(true);
  });

  it('computes team stats and ranks all 32 teams', () => {
    const teams = teamTotals(l, rows);
    expect(teams.length).toBe(32);
    for (const m of TEAM_METRICS) {
      const vals = teams.map((t) => m.value(t));
      expect(vals.every(Number.isFinite), m.key).toBe(true);
      const ranks = vals.map((v) => rankOf(v, vals, m.better));
      expect(Math.min(...ranks)).toBe(1);
    }
  });
});
