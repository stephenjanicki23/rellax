import { describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { simDays } from '../src/engine/league/season';
import { executeTrade } from '../src/engine/economy/trade';
import { playersOf } from '../src/engine/league/helpers';

describe('media', () => {
  it('writes a preview, recaps of the user games, weekly power rankings and trade grades', () => {
    const l = createLeague({ seed: 'media-1' });
    expect(l.media!.articles[0].kind).toBe('preview');
    expect(l.media!.articles[0].body.join(' ')).toMatch(/projections/);
    l.settings.autoManageUser = true;
    simDays(l, 15);
    const kinds = l.media!.articles.map((a) => a.kind);
    expect(kinds).toContain('recap');
    expect(kinds).toContain('power');
    const recap = l.media!.articles.find((a) => a.kind === 'recap')!;
    expect(recap.teamIds).toContain(l.userTeamId);
    const power = l.media!.articles.find((a) => a.kind === 'power')!;
    expect(power.body.length).toBeGreaterThanOrEqual(10);
    // A user trade gets graded.
    const me = l.userTeamId;
    const other = (me + 1) % 32;
    const give = playersOf(l, me).sort((a, b) => a.ca - b.ca)[0];
    const get = playersOf(l, other).sort((a, b) => a.ca - b.ca)[0];
    executeTrade(l, { from: me, to: other, give: [{ kind: 'player', id: give.id }], get: [{ kind: 'player', id: get.id }] });
    const grade = l.media!.articles[0];
    expect(grade.kind).toBe('grade');
    expect(['A', 'B', 'C', 'D', 'F']).toContain(grade.grade);
  });
});
