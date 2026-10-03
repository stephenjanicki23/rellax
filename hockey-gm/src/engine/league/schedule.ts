import type { Rng } from '../core/rng';
import type { LeagueConfig } from '../data/leagueConfig';
import type { ScheduledGame } from '../types';

interface TeamRef {
  id: number;
  divisionId: string;
  conferenceId: string;
}

/**
 * Number of games between every pair of teams so that each team plays
 * `config.season.games`. Starts from the division / conference /
 * inter-conference targets and then trims (or adds) games along rotating
 * cycles inside divisions (or conferences) so every team stays balanced.
 */
export function pairCounts(teams: TeamRef[], cfg: LeagueConfig): Map<string, number> {
  const counts = new Map<string, number>();
  const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  for (let i = 0; i < teams.length; i++)
    for (let j = i + 1; j < teams.length; j++) {
      const a = teams[i];
      const b = teams[j];
      const c =
        a.divisionId === b.divisionId
          ? cfg.season.divisionGames
          : a.conferenceId === b.conferenceId
            ? cfg.season.conferenceGames
            : cfg.season.interConferenceGames;
      counts.set(key(a.id, b.id), c);
    }
  const perTeam = (id: number) => {
    let s = 0;
    for (const t of teams) if (t.id !== id) s += counts.get(key(id, t.id)) ?? 0;
    return s;
  };
  const adjustAlongCycles = (groupKey: 'divisionId' | 'conferenceId', delta: -1 | 1) => {
    const groups = new Map<string, TeamRef[]>();
    for (const t of teams) groups.set(t[groupKey], [...(groups.get(t[groupKey]) ?? []), t]);
    for (const g of groups.values()) {
      const n = g.length;
      let k = 1;
      while (k <= Math.floor((n - 1) / 2)) {
        const diff = perTeam(g[0].id) - cfg.season.games;
        if ((delta < 0 && diff < 2) || (delta > 0 && diff > -2)) break;
        for (let i = 0; i < n; i++) {
          const kk = key(g[i].id, g[(i + k) % n].id);
          counts.set(kk, Math.max(0, (counts.get(kk) ?? 0) + delta));
        }
        k++;
      }
    }
  };
  if (teams.length && perTeam(teams[0].id) > cfg.season.games) adjustAlongCycles('divisionId', -1);
  if (teams.length && perTeam(teams[0].id) > cfg.season.games) adjustAlongCycles('conferenceId', -1);
  if (teams.length && perTeam(teams[0].id) < cfg.season.games) adjustAlongCycles('conferenceId', 1);
  return counts;
}

export function generateSchedule(teams: TeamRef[], cfg: LeagueConfig, rng: Rng, firstGameId: number): ScheduledGame[] {
  const counts = pairCounts(teams, cfg);
  const homeCount = new Map<number, number>(teams.map((t) => [t.id, 0]));
  const games: { home: number; away: number }[] = [];
  const odd: [number, number][] = [];
  for (const [k, c] of counts) {
    const [a, b] = k.split('-').map(Number);
    for (let i = 0; i < Math.floor(c / 2); i++) {
      games.push({ home: a, away: b }, { home: b, away: a });
      homeCount.set(a, homeCount.get(a)! + 1);
      homeCount.set(b, homeCount.get(b)! + 1);
    }
    if (c % 2 === 1) odd.push([a, b]);
  }
  rng.shuffle(odd);
  for (const [a, b] of odd) {
    const ha = homeCount.get(a)!;
    const hb = homeCount.get(b)!;
    const aHome = ha < hb || (ha === hb && rng.chance(0.5));
    games.push(aHome ? { home: a, away: b } : { home: b, away: a });
    homeCount.set(aHome ? a : b, (aHome ? ha : hb) + 1);
  }
  rng.shuffle(games);

  // Assign days.
  const remaining = new Map<number, number>(teams.map((t) => [t.id, 0]));
  for (const g of games) {
    remaining.set(g.home, remaining.get(g.home)! + 1);
    remaining.set(g.away, remaining.get(g.away)! + 1);
  }
  const lastDay = new Map<number, number>(teams.map((t) => [t.id, -10]));
  const prevDay = new Map<number, number>(teams.map((t) => [t.id, -10]));
  const capacityPattern = [5, 10, 7, 10, 7, 13, 7];
  const scale = teams.length / 32;
  const out: ScheduledGame[] = [];
  let pool = games;
  let day = 0;
  let id = firstGameId;
  while (pool.length && day < 400) {
    const cap = Math.max(1, Math.round(capacityPattern[day % 7] * scale));
    const playing = new Set<number>();
    // Prioritise teams that are furthest behind.
    pool.sort((x, y) => remaining.get(y.home)! + remaining.get(y.away)! - (remaining.get(x.home)! + remaining.get(x.away)!) + (rng.next() - 0.5) * 6);
    const left: typeof pool = [];
    let scheduled = 0;
    for (const g of pool) {
      if (scheduled >= cap || playing.has(g.home) || playing.has(g.away)) {
        left.push(g);
        continue;
      }
      const ok = [g.home, g.away].every((t) => {
        const ld = lastDay.get(t)!;
        if (ld === day - 1 && prevDay.get(t)! === day - 2) return false; // no 3-in-3
        if (ld === day - 1 && rng.chance(0.62)) return false; // limit back-to-backs
        return true;
      });
      if (!ok) {
        left.push(g);
        continue;
      }
      playing.add(g.home);
      playing.add(g.away);
      for (const t of [g.home, g.away]) {
        prevDay.set(t, lastDay.get(t)!);
        lastDay.set(t, day);
        remaining.set(t, remaining.get(t)! - 1);
      }
      out.push({ id: id++, day, home: g.home, away: g.away, played: false });
      scheduled++;
    }
    pool = left;
    day++;
  }
  return out;
}
