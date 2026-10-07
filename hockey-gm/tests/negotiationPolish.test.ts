import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { playersOf } from '../src/engine/league/helpers';
import { hometownDiscount, previewNegotiation } from '../src/engine/cba/negotiation';
import { ARB_HEARING_DAY, arbitrationAward, rfaDay, setArbitrationBrief, settleArbitration } from '../src/engine/cba/rfa';
import { extensionOutlook } from '../src/engine/economy/freeAgency';
import { agentOf } from '../src/engine/cba/agents';
import { Rng } from '../src/engine/core/rng';
import type { League, Player } from '../src/engine/types';

function loyalVeteran(l: League): Player {
  const me = l.userTeamId;
  const p = playersOf(l, me).sort((a, b) => b.ca - a.ca)[3];
  p.prefs.loyalty = 1.6;
  p.morale = 85;
  p.career = Array.from({ length: 7 }, (_, i) => ({ season: l.season - 1 - i, teamId: me, playoffs: false, stats: p.career[0]?.stats ?? ({} as never) })) as Player['career'];
  return p;
}

/** Turn one of the user's players into a restricted free agent headed to arbitration. */
function arbCase(l: League) {
  const me = l.userTeamId;
  const p = playersOf(l, me).filter((x) => x.pos !== 'G').sort((a, b) => b.ca - a.ca)[6];
  p.status = 'fa';
  p.rfa = true;
  p.rightsTeamId = me;
  p.teamId = null;
  p.contract = null;
  const kase = { playerId: p.id, teamId: me, season: l.season, electedBy: 'player' as const, playerAsk: 5000, clubOffer: 2500, years: 2, hearingDay: ARB_HEARING_DAY, status: 'filed' as const };
  l.arbitration.push(kase);
  return { p, kase: l.arbitration[l.arbitration.length - 1] };
}

describe('contract negotiation polish', () => {
  it('gives loyal, long-serving, happy players a hometown discount on their own club only', () => {
    const l = createLeague({ seed: 'neg-1' });
    const p = loyalVeteran(l);
    agentOf(l, p).style = 'friendly';
    const home = hometownDiscount(l, p, l.userTeamId, 'open');
    expect(home.pct).toBeGreaterThan(0.03);
    expect(home.reasons.some((r) => r.includes('seasons'))).toBe(true);
    expect(hometownDiscount(l, p, (l.userTeamId + 1) % 32, 'open').pct).toBe(0);
    expect(hometownDiscount(l, p, l.userTeamId, 'testMarket').pct).toBe(0);
  });

  it('explains how the opening demand was built', () => {
    const l = createLeague({ seed: 'neg-2' });
    const p = loyalVeteran(l);
    const st = previewNegotiation(l, p, l.userTeamId);
    expect(st.factors?.[0].label).toBe('Market ask');
    expect(st.factors?.some((f) => f.label.startsWith('Agent'))).toBe(true);
  });

  it('settles an arbitration case only near the expected award', () => {
    const l = createLeague({ seed: 'neg-3' });
    const { p, kase } = arbCase(l);
    const expected = arbitrationAward(l, kase).award;
    expect(settleArbitration(l, p.id, kase.clubOffer).ok).toBe(expected * 0.97 <= kase.clubOffer);
    const r = settleArbitration(l, p.id, Math.round(expected / 5) * 5);
    expect(r.ok).toBe(true);
    expect(kase.status).toBe('settled');
    expect(p.contract?.salary).toBe(Math.round(expected / 5) * 5);
  });

  it('an aggressive brief trims the award but costs morale', () => {
    const run = (brief: 'respectful' | 'aggressive') => {
      const l = createLeague({ seed: 'neg-4' });
      const { p, kase } = arbCase(l);
      p.morale = 70;
      setArbitrationBrief(l, p.id, brief);
      l.faDay = ARB_HEARING_DAY;
      rfaDay(l, new Rng(1), false);
      return { award: kase.award!, morale: p.morale, status: kase.status };
    };
    const soft = run('respectful');
    const hard = run('aggressive');
    expect(soft.status).toBe('awarded');
    expect(hard.award).toBeLessThan(soft.award);
    expect(hard.morale).toBeLessThan(soft.morale);
  });

  it('projects whether waiting on an extension will cost more', () => {
    const l = createLeague({ seed: 'neg-5' });
    const players = playersOf(l, l.userTeamId).filter((p) => p.contract);
    const young = players.filter((p) => l.season - p.birthYear <= 23 && p.pa - p.ca > 10)[0];
    const old = players.filter((p) => l.season - p.birthYear >= 33)[0];
    if (young) expect(extensionOutlook(l, young).trend).toBe('rising');
    if (old) expect(extensionOutlook(l, old).trend).toBe('falling');
    expect(young || old).toBeTruthy();
  });
});
