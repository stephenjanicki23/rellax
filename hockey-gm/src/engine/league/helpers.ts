import { Rng } from '../core/rng';
import type { League, NewsItem, Player, Team, TeamRecord, Transaction } from '../types';

export function leagueRng(league: League): Rng {
  return new Rng(league.rng);
}

/** Run a function with the league's persistent RNG and store the advanced state back. */
export function withRng<T>(league: League, fn: (rng: Rng) => T): T {
  const rng = new Rng(league.rng);
  const out = fn(rng);
  league.rng = rng.state();
  return out;
}

export function nextId(league: League, kind: keyof League['nextId']): number {
  return league.nextId[kind]++;
}

export function emptyRecord(): TeamRecord {
  return {
    gp: 0, w: 0, l: 0, otl: 0, row: 0, rw: 0, gf: 0, ga: 0, home: [0, 0, 0], away: [0, 0, 0], streak: 0, last10: [],
    ppOpp: 0, ppg: 0, tsh: 0, ppga: 0, sf: 0, sa: 0, xgf: 0, xga: 0, cf: 0, ca: 0, hits: 0, blocks: 0, fow: 0, fol: 0,
    tk: 0, gv: 0, pim: 0,
  };
}

export const points = (r: TeamRecord): number => r.w * 2 + r.otl;

export function teamById(league: League, id: number): Team {
  const t = league.teams[id];
  if (!t || t.id !== id) {
    const f = league.teams.find((x) => x.id === id);
    if (!f) throw new Error(`No team ${id}`);
    return f;
  }
  return t;
}

export function teamName(league: League, id: number | null | undefined): string {
  if (id === null || id === undefined) return 'Free Agent';
  const t = teamById(league, id);
  return `${t.city} ${t.name}`;
}

export function playersOf(league: League, teamId: number, statuses: Player['status'][] = ['active']): Player[] {
  const out: Player[] = [];
  for (const p of Object.values(league.players)) if (p.teamId === teamId && statuses.includes(p.status)) out.push(p);
  return out;
}

export function addNews(league: League, n: Omit<NewsItem, 'id' | 'season' | 'day'> & { day?: number }): NewsItem {
  const item: NewsItem = { id: nextId(league, 'news'), season: league.season, day: n.day ?? league.day, ...n };
  league.news.unshift(item);
  if (league.news.length > 600) league.news.length = 600;
  return item;
}

export function addTransaction(league: League, t: Omit<Transaction, 'id' | 'season' | 'day'>): Transaction {
  const tx: Transaction = { id: nextId(league, 'tx'), season: league.season, day: league.day, ...t };
  league.transactions.unshift(tx);
  if (league.transactions.length > 1500) league.transactions.length = 1500;
  return tx;
}

export function age(p: Player, season: number): number {
  return season - p.birthYear;
}

/** Is this team run by the AI (all CPU teams, plus the user's team in auto-manage mode)? */
export function isCpu(league: League, teamId: number): boolean {
  return teamId !== league.userTeamId || league.settings.autoManageUser;
}
