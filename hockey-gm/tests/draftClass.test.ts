import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { draftClassInfo } from '../src/engine/league/realDraftClass';
import { draftRankings } from '../src/engine/economy/draft';
import { centralRank, interviewProspect, interviewsLeft, INTERVIEWS_PER_YEAR, isShortlisted, prospectRegion, publishCentralRankings, runCombine, scoutReport, toggleShortlist, weeklyScouting } from '../src/engine/economy/scouting';

describe('real draft class', () => {
  const league = createLeague({ seed: 'draft-class' });
  const pool = Object.values(league.players).filter((p) => p.status === 'draft');

  it('includes the real Central Scouting prospects and fills out the class', () => {
    const info = draftClassInfo();
    expect(info.draftYear).toBe(league.season + 1);
    const real = pool.filter((p) => p.csRank);
    expect(real.length).toBeGreaterThan(200);
    expect(pool.length).toBeGreaterThanOrEqual(league.teams.length * league.config.draft.rounds);
    for (const p of real.slice(0, 50)) {
      expect(p.first.length).toBeGreaterThan(0);
      expect(p.junior).toBeTruthy();
      expect(p.ca).toBeLessThanOrEqual(p.pa);
    }
    // Better-ranked prospects project higher on average.
    const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
    const nas = real.filter((p) => p.csRank!.category === 'NA-S');
    expect(avg(nas.filter((p) => p.csRank!.rank <= 120).map((p) => p.pa))).toBeGreaterThan(avg(nas.filter((p) => p.csRank!.rank > 180).map((p) => p.pa)));
  });

  it('Central Scouting publishes lists that drive the consensus board', () => {
    const l = createLeague({ seed: 'draft-class-cs' });
    publishCentralRankings(l, 'midterm');
    const c = l.scouting.central!;
    const draftees = Object.values(l.players).filter((p) => p.status === 'draft');
    expect(Object.values(c.lists).reduce((s, x) => s + x.length, 0)).toBe(draftees.length);
    for (const id of c.lists['NA-S'].slice(0, 20)) expect(prospectRegion(l.players[id])).toBe('NA');
    for (const id of c.lists['INT-G']) expect(l.players[id].pos).toBe('G');
    expect(l.news.some((n) => /Central Scouting/.test(n.headline))).toBe(true);
    const board = draftRankings(l);
    expect(centralRank(l, board[0])!.rank).toBe(1);
  });

  it('combine interviews reveal character, limited per year', () => {
    const l = createLeague({ seed: 'draft-class-iv' });
    const ps = Object.values(l.players).filter((p) => p.status === 'draft');
    expect(interviewProspect(l, ps[0]).ok).toBe(false); // before the combine
    runCombine(l);
    const before = scoutReport(l, ps[0]).personality;
    const r = interviewProspect(l, ps[0]);
    expect(r.ok).toBe(true);
    expect(scoutReport(l, ps[0]).personality).not.toBeNull();
    expect(before === null || before === scoutReport(l, ps[0]).personality).toBe(true);
    expect(interviewProspect(l, ps[0]).ok).toBe(false); // once each
    for (let i = 1; i < INTERVIEWS_PER_YEAR; i++) interviewProspect(l, ps[i]);
    expect(interviewsLeft(l)).toBe(0);
    expect(interviewProspect(l, ps[INTERVIEWS_PER_YEAR + 1]).ok).toBe(false);
  });

  it('regional scouts only cover their region; shortlist toggles', () => {
    const l = createLeague({ seed: 'draft-class-region' });
    for (const s of l.scouts) s.assignment = { kind: 'draft', region: 'EU' };
    weeklyScouting(l);
    const seen = Object.keys(l.scouting.knowledge).map((id) => l.players[Number(id)]).filter((p) => p?.status === 'draft');
    expect(seen.length).toBeGreaterThan(0);
    for (const p of seen) expect(prospectRegion(p)).toBe('EU');
    const p = Object.values(l.players).find((x) => x.status === 'draft')!;
    expect(toggleShortlist(l, p)).toBe(true);
    expect(isShortlisted(l, p)).toBe(true);
    expect(toggleShortlist(l, p)).toBe(false);
  });
});
