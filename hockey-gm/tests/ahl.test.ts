import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { affiliateOf, AHL_GAMES, ahlDay, ahlEligible, ahlLeaders, ahlPlayoffs, ahlStandings, archiveAhlSeason } from '../src/engine/league/ahl';
import { startRegularSeason } from '../src/engine/league/offseason';
import { devContext } from '../src/engine/league/season';
import { promote, signAhlPlayer } from '../src/engine/economy/roster';
import { teamCapSheet } from '../src/engine/cba/capManager';

function playAhlSeason(seed: string) {
  const l = createLeague({ seed });
  startRegularSeason(l);
  const last = l.schedule.reduce((m, g) => Math.max(m, g.day), 0);
  for (let d = 0; d <= last; d++) {
    l.day = d;
    ahlDay(l);
  }
  return l;
}

describe('AHL affiliates', () => {
  it('every club has its real affiliate, with AHL-contract players who are not on NHL books', () => {
    const l = createLeague({ seed: 'ahl-1' });
    const bos = l.teams.find((t) => t.abbr === 'BOS')!;
    expect(affiliateOf(l, bos.id)!.name).toBe('Providence Bruins');
    expect(l.ahl!.teams).toHaveLength(32);
    const ahlGuys = Object.values(l.players).filter((p) => p.ahlContract);
    expect(ahlGuys.length).toBeGreaterThan(250);
    for (const p of ahlGuys.slice(0, 30)) {
      expect(p.contract).toBeNull();
      expect(p.status).toBe('prospect');
      expect(ahlEligible(l, p)).toBe(true);
    }
    // They don't count against the 50-contract limit.
    const sheet = teamCapSheet(l, bos.id);
    expect(sheet.rows.some((r) => l.players[r.playerId]?.ahlContract)).toBe(false);
  });

  it('junior-age CHL players and unsigned picks do not play in the AHL', () => {
    const l = createLeague({ seed: 'ahl-2' });
    const p = Object.values(l.players).find((x) => x.status === 'prospect' && x.contract && !x.ahlContract)!;
    p.birthYear = l.season - 19;
    p.junior = 'OHL';
    expect(ahlEligible(l, p)).toBe(false);
    const unsigned = Object.values(l.players).find((x) => x.status === 'prospect' && !x.contract && !x.ahlContract && x.rightsTeamId !== null)!;
    expect(ahlEligible(l, unsigned)).toBe(false);
  });

  it('plays a 72-game season with realistic scoring, stats and a Calder Cup', () => {
    const l = playAhlSeason('ahl-3');
    const st = ahlStandings(l);
    for (const t of st) expect(t.gp).toBeGreaterThanOrEqual(AHL_GAMES - 4);
    const gpg = st.reduce((s, t) => s + t.gf, 0) / st.reduce((s, t) => s + t.gp, 0);
    expect(gpg).toBeGreaterThan(2.7);
    expect(gpg).toBeLessThan(3.7);
    const top = ahlLeaders(l, 1)[0];
    expect(top.l.g + top.l.a).toBeGreaterThan(45);
    expect(top.l.g + top.l.a).toBeLessThan(115);
    const goalies = Object.entries(l.ahl!.stats).filter(([id, s]) => l.players[+id]?.pos === 'G' && s.gp >= 25);
    for (const [, s] of goalies) {
      const sv = 1 - s.ga / s.sa;
      expect(sv).toBeGreaterThan(0.85);
      expect(sv).toBeLessThan(0.94);
    }
    ahlPlayoffs(l);
    expect(l.ahl!.champion).not.toBeNull();
    expect(l.news.some((n) => /Calder Cup/.test(n.headline))).toBe(true);
    // Playing for the affiliate feeds development.
    const regular = Object.values(l.players).find((p) => p.status === 'prospect' && (l.ahl!.stats[p.id]?.gp ?? 0) > 50)!;
    expect(devContext(l, regular, 0.5).minorIce).toBeGreaterThan(0.9);
    archiveAhlSeason(l);
    expect(regular.ahlCareer?.length).toBe(1);
  });

  it('an AHL-contract player must sign an NHL deal before he can be called up', () => {
    const l = createLeague({ seed: 'ahl-4' });
    const p = Object.values(l.players).find((x) => x.ahlContract && x.teamId === l.userTeamId)!;
    promote(l, p);
    expect(p.status).toBe('prospect');
    const r = signAhlPlayer(l, p);
    expect(r.ok).toBe(true);
    expect(p.ahlContract).toBe(false);
    expect(p.contract?.twoWay).toBe(true);
    promote(l, p);
    expect(p.status).toBe('active');
  });
});
