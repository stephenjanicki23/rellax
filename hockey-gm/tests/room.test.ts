import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { simDays } from '../src/engine/league/season';
import { playersOf } from '../src/engine/league/helpers';
import { actualRole, expectedRole, holdMeeting, honourPromisesInLines, makePromise, meetingCooldown, onPlayerTraded, reviewPromises, reviewTradeRequests } from '../src/engine/league/room';
import { updateMorale } from '../src/engine/league/morale';

function setup(seed: string) {
  const l = createLeague({ seed });
  const me = l.teams[l.userTeamId];
  return { l, me, roster: playersOf(l, me.id) };
}

describe('dressing room', () => {
  it('roles come from the lines; expectations from standing on the team', () => {
    const { l, me, roster } = setup('room-1');
    const top = l.players[me.lines.fwd[0][1]];
    expect(actualRole(l, top)).toBe(0);
    const best = [...roster].filter((p) => p.pos !== 'G' && p.pos !== 'D').sort((a, b) => b.ca - a.ca)[0];
    expect(expectedRole(l, best)).toBe(0);
    const starter = l.players[me.lines.goalies[0]];
    expect(actualRole(l, starter)).toBe(0);
    // Weekly morale records what drives each player.
    simDays(l, 14);
    updateMorale(l);
    expect(top.moraleParts).toBeTruthy();
    expect(Object.keys(top.moraleParts!)).toEqual(['role', 'winning', 'contract', 'promises', 'coach', 'room']);
  });

  it('a kept role promise builds trust; a broken one costs morale and trust', () => {
    const { l, me } = setup('room-2');
    l.phase = 'regular';
    const third = l.players[me.lines.fwd[2][0]];
    const fourth = l.players[me.lines.fwd[3][0]];
    expect(makePromise(l, third, 'role').ok).toBe(true);
    expect(makePromise(l, third, 'role').ok).toBe(false); // already promised
    expect(makePromise(l, fourth, 'role').ok).toBe(true);
    // Honour the first: move him up a line (swap with a second-liner).
    const second = me.lines.fwd[1][0];
    me.lines.fwd[1][0] = third.id;
    me.lines.fwd[2][0] = second;
    const t0 = third.trust ?? 60;
    const f0 = fourth.trust ?? 60;
    for (let w = 0; w < 10; w++) {
      l.day += 7;
      reviewPromises(l);
    }
    expect(third.promises![0].status).toBe('kept');
    expect(third.trust).toBeGreaterThan(t0 - 5);
    expect(fourth.promises![0].status).toBe('broken');
    expect(fourth.trust!).toBeLessThan(f0 - 20);
  });

  it('auto lines honour a role promise', () => {
    const { l, me } = setup('room-6');
    l.phase = 'regular';
    me.autoLines = true;
    const fourth = l.players[me.lines.fwd[3][0]];
    makePromise(l, fourth, 'role');
    honourPromisesInLines(l, me.id);
    expect(actualRole(l, fourth)).toBeLessThanOrEqual(fourth.promises![0].tier!);
  });

  it("trading a player breaks a no-trade promise", () => {
    const { l, roster } = setup('room-3');
    l.phase = 'regular';
    const p = roster[5];
    makePromise(l, p, 'noTrade');
    const m0 = p.morale;
    onPlayerTraded(l, p);
    expect(p.promises![0].status).toBe('broken');
    expect(p.morale).toBeLessThan(m0);
  });

  it('long unhappiness leads to a private trade request that goes public, and happiness withdraws it', () => {
    const { l, roster } = setup('room-4');
    l.phase = 'regular';
    const p = [...roster].sort((a, b) => b.ca - a.ca)[0];
    p.personality = 'difficult';
    p.morale = 10;
    let weeks = 0;
    while (!p.tradeRequest && weeks < 30) {
      l.day += 7;
      p.morale = 10;
      reviewTradeRequests(l, p);
      weeks++;
    }
    expect(p.tradeRequest).toBeTruthy();
    expect(p.tradeRequest!.public).toBe(false);
    l.day += 35;
    reviewTradeRequests(l, p);
    expect(p.tradeRequest!.public).toBe(true);
    p.morale = 70;
    reviewTradeRequests(l, p);
    expect(p.tradeRequest).toBeUndefined();
  });

  it('meetings: reassurance wears off, challenges depend on personality, and there is a cooldown', () => {
    const { l, roster } = setup('room-5');
    const a = roster[3];
    const b = roster[4];
    a.personality = 'competitive';
    b.personality = 'difficult';
    a.morale = 50;
    b.morale = 50;
    expect(holdMeeting(l, a, 'challenge').delta).toBeGreaterThan(0);
    expect(holdMeeting(l, b, 'challenge').delta).toBeLessThan(0);
    expect(meetingCooldown(l, a)).toBeGreaterThan(0);
    expect(holdMeeting(l, a, 'reassure').ok).toBe(false);
    l.day += 15;
    const first = holdMeeting(l, a, 'reassure').delta;
    l.day += 15;
    const second = holdMeeting(l, a, 'reassure').delta;
    expect(second).toBeLessThanOrEqual(first);
  });
});
