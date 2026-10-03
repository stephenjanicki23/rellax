import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { runGameBatch } from '../src/engine/analytics';
import { DEFAULT_CONFIG } from '../src/engine/data/leagueConfig';
import { caForPercentile } from '../src/engine/data/nhl/realPlayers';
import { syntheticSnapshot } from './nhlFixture';

const snap = syntheticSnapshot();
const league = createLeague({ seed: 'nhl-real', rosters: snap });
const players = Object.values(league.players);

describe('NHL league structure', () => {
  it('has the 32 NHL teams in their divisions', () => {
    expect(league.teams.map((t) => t.abbr)).toContain('UTA');
    expect(league.teams.length).toBe(32);
    expect(DEFAULT_CONFIG.championship).toBe('Stanley Cup');
    for (const d of DEFAULT_CONFIG.divisions) expect(DEFAULT_CONFIG.teams.filter((t) => t.divisionId === d.id).length).toBe(8);
  });
});

describe('real rosters', () => {
  it('puts every roster player on his team with real bio data', () => {
    for (const t of league.teams) {
      const mine = players.filter((p) => p.teamId === t.id && p.nhlId);
      expect(mine.length).toBe(snap.teams[t.abbr].length);
      const rec = snap.teams[t.abbr][0];
      const p = mine.find((x) => x.nhlId === rec.nhlId)!;
      expect(p.first).toBe(rec.first);
      expect(p.heightCm).toBe(rec.heightCm);
      expect(p.birthYear).toBe(Number(rec.birthDate.slice(0, 4)));
    }
  });
  it('builds a legal active roster for every team', () => {
    for (const t of league.teams) {
      const act = players.filter((p) => p.teamId === t.id && p.status === 'active');
      expect(act.filter((p) => p.pos === 'G').length).toBe(2);
      expect(act.filter((p) => p.pos === 'D').length).toBe(7);
      expect(act.filter((p) => p.pos !== 'G' && p.pos !== 'D').length).toBe(14);
      const pay = act.reduce((s, p) => s + (p.contract?.salary ?? 0), 0);
      expect(pay).toBeLessThanOrEqual(league.cap.upper);
    }
  });
  it('rates players by real production', () => {
    const fwd = players.filter((p) => p.nhlId && p.pos !== 'G' && p.pos !== 'D');
    const ppg = (id: number) => {
      const rec = Object.values(snap.teams).flat().find((r) => r.nhlId === id)!;
      const l = rec.skater![0];
      return (l.g + l.a) / l.gp;
    };
    const sorted = [...fwd].sort((a, b) => ppg(b.nhlId!) - ppg(a.nhlId!));
    const top = sorted.slice(0, 30).reduce((s, p) => s + p.ca, 0) / 30;
    const bottom = sorted.slice(-30).reduce((s, p) => s + p.ca, 0) / 30;
    expect(top).toBeGreaterThan(bottom + 30);
    expect(Math.max(...fwd.map((p) => p.ca))).toBeGreaterThan(170);
  });
  it('keeps the calibrated ability curve', () => {
    expect(caForPercentile('F', 0)).toBe(181);
    expect(caForPercentile('F', 0.5)).toBe(130);
    expect(caForPercentile('G', 1)).toBe(108);
  });
  it('is deterministic for a seed', () => {
    const again = createLeague({ seed: 'nhl-real', rosters: snap });
    expect(Object.values(again.players).map((p) => p.ca)).toEqual(players.map((p) => p.ca));
  });
  it('still produces realistic hockey', () => {
    const b = runGameBatch(league, 300);
    expect(b.goalsPerTeam).toBeGreaterThan(2.6);
    expect(b.goalsPerTeam).toBeLessThan(3.6);
    expect(b.svPct).toBeGreaterThan(0.89);
    expect(b.svPct).toBeLessThan(0.925);
  });
  it('uses the real head coaches and general managers', () => {
    const tbl = league.teams.find((t) => t.abbr === 'TBL')!;
    const coach = league.coaches[tbl.staff.headCoach!];
    expect(`${coach.first} ${coach.last}`).toBe('Jon Cooper');
    expect(coach.ratings.tactics).toBeGreaterThan(110);
    expect(tbl.gm.name).toBe('Julien BriseBois');
    const tor = league.teams.find((t) => t.abbr === 'TOR')!;
    expect(league.coaches[tor.staff.headCoach!].last).toBe('TOR');
  });
  it('falls back to generated rosters without a snapshot', () => {
    const gen = createLeague({ seed: 'gen', rosters: false });
    expect(Object.values(gen.players).some((p) => p.nhlId)).toBe(false);
    expect(gen.teams[0].name).toBe('Bruins');
  });
});
