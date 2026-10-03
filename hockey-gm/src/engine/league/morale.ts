import { clamp } from '../core/math';
import type { League } from '../types';
import { PERSONALITIES } from '../player/personality';
import { addNews, playersOf, points } from './helpers';
import { fullName } from '../player/ability';

/**
 * Weekly morale update. Players care about their role (ice time vs. what
 * they expect), winning, and — depending on personality — their contract.
 * Team morale is the room's average, lifted by leaders and a motivating coach.
 */
export function updateMorale(league: League): void {
  for (const team of league.teams) {
    const rec = league.standings[team.id];
    const pct = rec && rec.gp ? points(rec) / (rec.gp * 2) : 0.5;
    const roster = playersOf(league, team.id, ['active']);
    if (!roster.length) continue;
    const hc = team.staff.headCoach !== null ? league.coaches[team.staff.headCoach] : undefined;
    const motivation = ((hc?.ratings.motivation ?? 100) - 100) / 100;
    const leaders = roster.filter((p) => p.personality === 'leader' || p.attrs.leadership > 160).length;
    const difficult = roster.filter((p) => p.personality === 'difficult').length;
    const streak = rec?.streak ?? 0;
    let sum = 0;
    for (const p of roster) {
      const pers = PERSONALITIES[p.personality];
      const st = league.seasonStats[p.id]?.reg;
      const gp = st?.gp ?? 0;
      let role = 0;
      if (p.pos === 'G') {
        const share = rec && rec.gp ? gp / rec.gp : 0.5;
        role = (share - (p.ca >= 145 ? 0.65 : 0.25)) * 40;
      } else if (gp > 0) {
        const toi = (st!.toi / gp) / 60;
        role = clamp((toi - p.expectedToi) * 2.2, -20, 15);
      } else if (rec && rec.gp > 5) role = -15;
      role *= pers.role;
      const winning = (pct - 0.5) * 50 * pers.winning + clamp(streak, -5, 5) * 0.8;
      const contract = p.contract && p.contract.years === 1 && p.ca > 140 ? -3 * pers.money : 0;
      const target = clamp(60 + role + winning + contract + motivation * 10 + leaders * 1.5 - difficult * 2, 5, 98);
      const speed = 0.22 * pers.moraleVolatility;
      p.morale = clamp(p.morale + (target - p.morale) * speed, 0, 100);
      sum += p.morale;
      if (p.morale < 22 && pers.tradeRequest > 1 && p.ca >= 140 && league.phase === 'regular') {
        const key = `${league.season}-${p.id}`;
        const already = league.news.some((n) => n.category === 'rumor' && n.playerIds.includes(p.id) && n.season === league.season && n.headline.includes('trade'));
        if (!already && key) {
          addNews(league, {
            category: 'rumor',
            headline: `Unhappy ${fullName(p)} reportedly wants a trade out of ${team.city}`,
            teamIds: [team.id],
            playerIds: [p.id],
            importance: 3,
          });
        }
      }
    }
    team.morale = clamp(sum / roster.length + motivation * 4, 0, 100);
  }
}
