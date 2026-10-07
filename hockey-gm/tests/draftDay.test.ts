import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { aiSelect, currentPick, makeDraftPick, prepareDraft, runDraftUntilUser } from '../src/engine/economy/draft';
import { acceptDraftOffer, draftDayOffers, gradeDraft, pickVerdict, simNextPick } from '../src/engine/economy/draftDay';
import { draftGradesArticle } from '../src/engine/front/media';
import { publishCentralRankings } from '../src/engine/economy/scouting';

function openDraft(seed: string) {
  const l = createLeague({ seed });
  l.teams.forEach((t, i) => (l.standings[t.id].w = 20 + i));
  l.playoffs = null;
  prepareDraft(l);
  return l;
}

describe('draft day', () => {
  it('CPU clubs draft close to the consensus board (with their own scouts at the margin)', () => {
    const l = createLeague({ seed: 'dd-ai' });
    l.teams.forEach((t, i) => (l.standings[t.id].w = 20 + i));
    l.playoffs = null;
    publishCentralRankings(l, 'final');
    prepareDraft(l);
    runDraftUntilUser(l, true);
    const r1 = l.draftDay!.selections.filter((s) => s.round === 1);
    const dev = r1.reduce((a, s) => a + Math.abs(s.pickNumber - (s.consensus ?? 300)), 0) / r1.length;
    expect(dev).toBeLessThan(10);
    expect(r1.filter((s) => l.players[s.playerId].pos === 'G').length).toBeLessThanOrEqual(4);
    expect(Math.min(...r1.slice(0, 3).map((s) => s.consensus ?? 99))).toBeLessThanOrEqual(3);
  });

  it('records the lottery: odds, winners and the resulting order', () => {
    const l = openDraft('dd-1');
    expect(l.lottery?.season).toBe(l.season);
    expect(l.lottery!.entries.length).toBe(l.config.draft.lotteryTeams);
    expect(l.lottery!.winners.length).toBe(l.config.draft.lotteryDraws);
    expect(l.lottery!.order[0]).toBe(l.lottery!.winners[0]);
    // The pick order follows the lottery.
    const first = l.draftPicks.find((p) => p.id === l.draftOrder[0])!;
    expect(first.originalTeamId).toBe(l.lottery!.order[0]);
  });

  it('snapshots the consensus board and logs every selection against it', () => {
    const l = openDraft('dd-2');
    expect(l.draftDay?.board.length).toBeGreaterThan(200);
    let n = 0;
    while (simNextPick(l) && n < 5) n++;
    const sel = l.draftDay!.selections;
    expect(sel.length).toBe(n);
    for (const s of sel) expect(s.consensus === null || s.consensus >= 1).toBe(true);
  });

  it('calls steals and reaches against the board', () => {
    expect(pickVerdict(20, 4).tag).toBe('Steal');
    expect(pickVerdict(5, 6).tag).toBe('On the board');
    expect(pickVerdict(5, 30).tag).toBe('Big reach');
    expect(pickVerdict(40, null).tag).toBe('Off the board');
  });

  it('offers trade-downs when you are on the clock, and accepting swaps the picks', () => {
    // Give the user an early pick so clubs want to move up to it.
    const l = openDraft('dd-3');
    let offers: ReturnType<typeof draftDayOffers> = [];
    for (let i = 0; i < 6 && !offers.length; i++) {
      const pick = currentPick(l)!;
      pick.ownerId = l.userTeamId;
      offers = draftDayOffers(l);
      if (!offers.length) makeDraftPick(l, pick.id, aiSelect(l, pick.ownerId)!.id);
    }
    expect(offers.length).toBeGreaterThan(0);
    const o = offers[0];
    expect(o.value).toBeGreaterThanOrEqual(o.ask);
    const pick = currentPick(l)!;
    const r = acceptDraftOffer(l, o);
    expect(r.ok).toBe(true);
    expect(pick.ownerId).toBe(o.teamId);
    for (const id of o.picks) expect(l.draftPicks.find((p) => p.id === id)!.ownerId).toBe(l.userTeamId);
    expect(l.draftDay!.trades.length).toBe(1);
  });

  it('grades every team when the draft closes and publishes the column', () => {
    const l = openDraft('dd-4');
    runDraftUntilUser(l, true);
    const grades = gradeDraft(l);
    const teamsWithPicks = new Set(l.draftDay!.selections.map((s) => s.teamId));
    expect(grades.length).toBe(teamsWithPicks.size);
    for (const g of grades) expect(['A', 'A-', 'B+', 'B', 'B-', 'C', 'D']).toContain(g.grade);
    draftGradesArticle(l);
    expect(l.media!.articles[0].title).toContain('draft grades');
  });
});
