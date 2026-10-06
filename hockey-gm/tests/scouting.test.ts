import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { estimate, leadScout, scoutGain, scoutsNewSeason, weeklyScouting } from '../src/engine/economy/scouting';
import { writtenReport } from '../src/engine/economy/scoutReport';
import type { League, Player } from '../src/engine/types';

const prospects = (l: League) => Object.values(l.players).filter((p) => p.status === 'draft');

describe('scouting reports 2.0', () => {
  it('scouts cover their home region and speciality faster', () => {
    const l = createLeague({ seed: 'scout-1' });
    const s = l.scouts[0];
    s.focus = 'skaters';
    s.homeRegion = 'NA';
    s.assignment = { kind: 'draft' };
    const ps = prospects(l);
    const naSkater = ps.find((p) => p.pos !== 'G' && (p.nat === 'CAN' || p.nat === 'USA') && !p.csRank && !p.junior) ?? ps.find((p) => p.pos !== 'G')!;
    const g = ps.find((p) => p.pos === 'G')!;
    expect(scoutGain(s, naSkater)).toBeGreaterThan(scoutGain(s, g));
    s.focus = 'goalies';
    expect(scoutGain(s, g)).toBeGreaterThan(scoutGain({ ...s, focus: 'skaters' }, g));
  });

  it('records who watched a player and files a byline', () => {
    const l = createLeague({ seed: 'scout-2' });
    for (const s of l.scouts) s.assignment = { kind: 'idle' };
    l.scouts[0].assignment = { kind: 'draft' };
    for (let w = 0; w < 6; w++) weeklyScouting(l);
    const seen = Object.keys(l.scouting.seenBy ?? {}).map(Number);
    expect(seen.length).toBeGreaterThan(0);
    const p = l.players[seen[0]];
    expect(leadScout(l, p)?.scout.id).toBe(l.scouts[0].id);
    expect(writtenReport(l, p).byline).toBe(`${l.scouts[0].first} ${l.scouts[0].last}`);
  });

  it('a well-scouted prospect gets a full report with an NHL comparison', () => {
    const l = createLeague({ seed: 'scout-3' });
    const p = prospects(l).sort((a, b) => b.pa - a.pa)[0];
    l.scouting.knowledge[p.id] = 80;
    const r = writtenReport(l, p);
    expect(r.projecting).toBe(true);
    expect(r.areas.length).toBe(p.pos === 'G' ? 4 : 6);
    expect(r.hiddenAreas).toBe(0);
    for (const a of r.areas) expect(a.text.length).toBeGreaterThan(5);
    expect(r.comparison).not.toBeNull();
    expect(r.comparison!.player.status).toBe('active');
    expect(r.comparison!.player.id).not.toBe(p.id);
  });

  it('a barely scouted prospect gets a thin report', () => {
    const l = createLeague({ seed: 'scout-4' });
    const p = prospects(l)[5];
    l.scouting.knowledge[p.id] = 10;
    const r = writtenReport(l, p);
    expect(r.areas.length).toBe(0);
    expect(r.comparison).toBeNull();
    l.scouting.knowledge[p.id] = 35;
    expect(writtenReport(l, p).areas.length).toBe(3);
  });

  it('elite NHL players grade out near the top of their position', () => {
    const l = createLeague({ seed: 'scout-5' });
    const best = Object.values(l.players)
      .filter((p): p is Player => p.status === 'active' && p.pos !== 'G' && p.pos !== 'D' && l.season - p.birthYear >= 25)
      .sort((a, b) => b.ca - a.ca)[0];
    l.scouting.knowledge[best.id] = 100;
    const r = writtenReport(l, best);
    expect(r.projecting).toBe(false);
    const avgPct = r.areas.reduce((s, a) => s + a.percentile, 0) / r.areas.length;
    expect(avgPct).toBeGreaterThan(65);
  });

  it('a specialist reads his speciality more sharply; scouts gain experience', () => {
    const l = createLeague({ seed: 'scout-6' });
    l.scouts = [l.scouts[0]];
    const s = l.scouts[0];
    const p = prospects(l).find((x) => x.pos === 'G')!;
    l.scouting.knowledge[p.id] = 40;
    s.focus = 'skaters';
    const wide = estimate(l, p);
    s.focus = 'goalies';
    const sharp = estimate(l, p);
    expect(sharp.paHigh - sharp.paLow).toBeLessThan(wide.paHigh - wide.paLow);
    const exp = s.experience ?? 8;
    scoutsNewSeason(l);
    expect(s.experience).toBe(exp + 1);
  });
});
