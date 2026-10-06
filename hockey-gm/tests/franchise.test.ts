import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { playersOf } from '../src/engine/league/helpers';
import { emptyStatLine } from '../src/engine/core/statline';
import { franchiseLeaders, honourRetiree, numberCandidates, retireNumber } from '../src/engine/league/franchise';
import type { League, Player } from '../src/engine/types';

function giveCareer(l: League, p: Player, teamId: number, seasons: number, gpPer: number, gPer: number, aPer: number) {
  for (let i = 0; i < seasons; i++) {
    const s = emptyStatLine();
    s.gp = gpPer;
    s.g = gPer;
    s.a1 = aPer;
    p.career.push({ season: l.season - seasons + i, teamId, playoffs: false, stats: s });
  }
}

describe('franchise honours', () => {
  it('CPU clubs induct and retire the numbers of icons; your club gets candidates to decide on', () => {
    const l = createLeague({ seed: 'fr-1' });
    const cpu = (l.userTeamId + 1) % 32;
    const icon = playersOf(l, cpu).find((p) => p.pos === 'C')!;
    giveCareer(l, icon, cpu, 10, 80, 30, 40);
    icon.status = 'retired';
    honourRetiree(l, icon);
    expect(l.teams[cpu].hallOfFame!.some((h) => h.playerId === icon.id)).toBe(true);
    expect(l.teams[cpu].retiredNumbers!.some((r) => r.playerId === icon.id)).toBe(true);

    const good = playersOf(l, cpu).find((p) => p.pos === 'D')!;
    giveCareer(l, good, cpu, 6, 75, 6, 30);
    good.status = 'retired';
    honourRetiree(l, good);
    expect(l.teams[cpu].hallOfFame!.some((h) => h.playerId === good.id)).toBe(true);
    expect((l.teams[cpu].retiredNumbers ?? []).some((r) => r.playerId === good.id)).toBe(false);

    const mine = playersOf(l, l.userTeamId).find((p) => p.pos !== 'G')!;
    giveCareer(l, mine, l.userTeamId, 10, 80, 30, 40);
    mine.status = 'retired';
    honourRetiree(l, mine);
    expect((l.teams[l.userTeamId].retiredNumbers ?? []).length).toBe(0);
    const cands = numberCandidates(l, l.userTeamId);
    expect(cands.map((c) => c.p.id)).toContain(mine.id);
    expect(retireNumber(l, l.teams[l.userTeamId], mine).ok).toBe(true);
    expect(numberCandidates(l, l.userTeamId).map((c) => c.p.id)).not.toContain(mine.id);
    expect(franchiseLeaders(l, cpu).pts[0].playerId).toBe(icon.id);
  });
});
