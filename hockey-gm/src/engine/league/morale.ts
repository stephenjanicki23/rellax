import { clamp } from '../core/math';
import type { League } from '../types';
import { PERSONALITIES } from '../player/personality';
import { playersOf, points } from './helpers';
import { promiseScore, reviewPromises, reviewTradeRequests, roleScore } from './room';

/**
 * Weekly morale update. Players care about their role (the line they play on
 * against the role they expect), winning, promises from the GM and, depending
 * on personality, their contract. The room matters too: leaders lift it,
 * difficult players and public trade requests drag it down. Team morale is
 * the room's average, lifted by a motivating coach.
 */
export function updateMorale(league: League): void {
  reviewPromises(league);
  for (const team of league.teams) {
    const rec = league.standings[team.id];
    const pct = rec && rec.gp ? points(rec) / (rec.gp * 2) : 0.5;
    const roster = playersOf(league, team.id, ['active']);
    if (!roster.length) continue;
    const hc = team.staff.headCoach !== null ? league.coaches[team.staff.headCoach] : undefined;
    const motivation = ((hc?.ratings.motivation ?? 100) - 100) / 100;
    const leaders = roster.filter((p) => p.personality === 'leader' || p.attrs.leadership > 160).length;
    const unhappyLeaders = roster.filter((p) => (p.personality === 'leader' || p.attrs.leadership > 160) && p.morale < 35).length;
    const difficult = roster.filter((p) => p.personality === 'difficult').length;
    const publicRequests = roster.filter((p) => p.tradeRequest?.public).length;
    const streak = rec?.streak ?? 0;
    const room = clamp(leaders * 1.5 - difficult * 2 - publicRequests * 3 - unhappyLeaders * 3, -12, 8);
    let sum = 0;
    for (const p of roster) {
      const pers = PERSONALITIES[p.personality];
      const parts = {
        role: rec && rec.gp >= 3 ? roleScore(league, p) : 0,
        winning: (pct - 0.5) * 50 * pers.winning + clamp(streak, -5, 5) * 0.8,
        contract: p.contract && p.contract.years === 1 && !p.contract.next && p.ca > 140 ? -3 * pers.money : 0,
        promises: promiseScore(league, p),
        coach: motivation * 10,
        room,
      };
      p.moraleParts = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 10) / 10])) as typeof parts;
      const target = clamp(60 + parts.role + parts.winning + parts.contract + parts.promises + parts.coach + parts.room, 5, 98);
      const speed = 0.22 * pers.moraleVolatility;
      p.morale = clamp(p.morale + (target - p.morale) * speed, 0, 100);
      sum += p.morale;
      reviewTradeRequests(league, p);
    }
    team.morale = clamp(sum / roster.length + motivation * 4, 0, 100);
  }
}
