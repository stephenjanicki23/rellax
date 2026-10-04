import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { protectionFrom } from '../src/engine/league/realDraft';
import { describeTradeAsset } from '../src/engine/cba/tradeRules';
import { isUnsignedPick, lapseDraftRights, signDraftPick, unsignedPicks } from '../src/engine/economy/draftRights';
import { promote } from '../src/engine/economy/roster';
import { teamCapSheet } from '../src/engine/cba/capManager';
import { prepareDraft } from '../src/engine/economy/draft';
import PICKS from '../data/draft/picks.json';

describe('real draft picks and prospects', () => {
  const league = createLeague({ seed: 'draft-data' });
  const team = (abbr: string) => league.teams.find((t) => t.abbr === abbr)!;

  it('imports every club’s unsigned draft picks with sign-by deadlines', () => {
    const un = Object.values(league.players).filter(isUnsignedPick);
    expect(un.length).toBeGreaterThan(500);
    for (const t of league.teams) expect(unsignedPicks(league, t.id).length).toBeGreaterThan(3);
    for (const p of un) {
      expect(p.contract).toBeNull();
      expect(p.rightsTeamId).toBe(p.teamId);
      expect(p.signBySeason).toBeGreaterThanOrEqual(league.season);
      expect(league.season - p.birthYear).toBeLessThanOrEqual(28);
    }
    // Earlier picks project higher on average.
    const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const firsts = un.filter((p) => p.draft?.round === 1).map((p) => p.pa);
    const late = un.filter((p) => (p.draft?.round ?? 0) >= 5).map((p) => p.pa);
    expect(avg(firsts)).toBeGreaterThan(avg(late) + 10);
  });

  it('applies real pick ownership, including traded and protected picks', () => {
    const rows = (PICKS as { picks: { year: number; round: number; original: string; owner: string; conditions?: string[] }[] }).picks;
    const traded = rows.filter((r) => r.owner !== r.original && r.year <= league.season + 3);
    expect(traded.length).toBeGreaterThan(30);
    for (const r of traded) {
      const pick = league.draftPicks.find((d) => d.season + 1 === r.year && d.round === r.round && d.originalTeamId === team(r.original).id)!;
      expect(pick.ownerId).toBe(team(r.owner).id);
    }
    expect(league.draftPicks.some((d) => d.protectedTop)).toBe(true);
    // Labels use the NHL draft year.
    const pick = league.draftPicks.find((d) => d.season === league.season)!;
    expect(describeTradeAsset(league, { kind: 'pick', id: pick.id })).toContain(String(league.season + 1));
  });

  it('parses pick protections', () => {
    expect(protectionFrom(['Top-10 protected'])).toBe(10);
    expect(protectionFrom(['1st round pick is Top 12 protected.'])).toBe(12);
    expect(protectionFrom(['conditional 2027 second-round pick'])).toBeUndefined();
  });

  it('unsigned picks cannot play until signed, and signing gives an ELC on the books', () => {
    const p = unsignedPicks(league, league.userTeamId).sort((a, b) => b.pa - a.pa)[0];
    promote(league, p);
    expect(p.status).toBe('prospect');
    const before = teamCapSheet(league, league.userTeamId).rows.length;
    const r = signDraftPick(league, p);
    expect(r.ok).toBe(true);
    expect(p.contract?.type).toBe('ELC');
    expect(p.signBySeason).toBeUndefined();
    expect(teamCapSheet(league, league.userTeamId).rows.length).toBe(before + 1);
    expect(signDraftPick(league, p).ok).toBe(false);
  });

  it('rights lapse at the sign-by date', () => {
    const l = createLeague({ seed: 'draft-lapse' });
    const p = unsignedPicks(l, 3)[0];
    p.signBySeason = l.season;
    const keep = unsignedPicks(l, 3).find((x) => x.id !== p.id && (x.signBySeason ?? 0) > l.season)!;
    lapseDraftRights(l);
    expect(p.status).toBe('fa');
    expect(p.teamId).toBeNull();
    expect(p.rightsTeamId).toBeNull();
    expect(isUnsignedPick(keep)).toBe(true);
  });

  it('a protected pick that lands inside its protection stays with the original team', () => {
    const l = createLeague({ seed: 'draft-protect' });
    const pick = l.draftPicks.find((d) => d.season === l.season && d.protectedTop)!;
    const holder = pick.ownerId;
    // Make the original team the worst in the league so the pick lands near the top.
    for (const t of l.teams) l.standings[t.id].w = t.id === pick.originalTeamId ? 0 : 50;
    l.playoffs = null;
    const top = pick.protectedTop!;
    prepareDraft(l);
    expect(pick.pickNumber! - (pick.round - 1) * l.teams.length).toBeLessThanOrEqual(top);
    expect(pick.ownerId).toBe(pick.originalTeamId);
    const next = l.draftPicks.find((d) => d.season === l.season + 1 && d.round === pick.round && d.originalTeamId === pick.originalTeamId)!;
    expect(next.ownerId).toBe(holder);
  });
});
