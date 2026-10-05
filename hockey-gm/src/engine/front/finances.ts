/**
 * Fans and finances: arena attendance, ticket prices, fan mood and each club's
 * season books (revenue, expenses, profit), plus facility projects.
 *
 * SIMPLIFICATION: NHL clubs don't publish their books. Arena capacities are
 * the approximate published hockey capacities; every money figure (ticket
 * prices, concessions, media, sponsorship, operating costs) is a game model
 * scaled by market size, meant to produce plausible ranges, not real numbers.
 * All money is in thousands of dollars.
 */
import { clamp } from '../core/math';
import type { FanState, League, Team } from '../types';
import { addNews, playersOf, points, teamName } from '../league/helpers';
import { payroll } from '../economy/contracts';
import { staffSpend } from '../team/staffMarket';

/** Approximate hockey seating capacity by club. */
export const ARENA_CAPACITY: Record<string, number> = {
  ANA: 17174, BOS: 17850, BUF: 19070, CGY: 19289, CAR: 18700, CHI: 19717, COL: 18007, CBJ: 18500,
  DAL: 18532, DET: 19515, EDM: 18347, FLA: 19250, LAK: 18230, MIN: 17954, MTL: 21105, NSH: 17159,
  NJD: 16514, NYI: 17255, NYR: 18006, OTT: 18652, PHI: 19543, PIT: 18387, SJS: 17435, SEA: 17151,
  STL: 18096, TBL: 19092, TOR: 18800, UTA: 12478, VAN: 18910, VGK: 17500, WSH: 18573, WPG: 15225,
};

const HOME_GAMES = 41;

export function capacityOf(team: Team): number {
  return ARENA_CAPACITY[team.abbr] ?? 17500;
}

/** Average ticket price at "market" pricing (dollars), by market size. */
export function marketTicketPrice(team: Team): number {
  return 62 + team.marketSize * 16;
}

/** Season revenue a club books outside the gate (thousands): local media, sponsorship and the league's shared revenue. */
function localRevenue(team: Team): number {
  return 30000 + team.marketSize * 9000 + team.reputation * 120;
}
const LEAGUE_SHARE = 95000;
/** Hockey operations (travel, medical, scouting, front office) and arena operations, per season. */
function operatingCosts(team: Team): number {
  return 64000 + team.marketSize * 8000;
}
/** Game-day, arena and revenue-sharing costs that grow with revenue. */
const VARIABLE_COST = 0.22;

export function newFanState(team: Team): FanState {
  return {
    mood: Math.round(clamp(45 + team.reputation * 0.35 + team.marketSize * 2, 30, 85)),
    priceFactor: 1,
    season: emptyBooks(),
    history: [],
    games: [],
  };
}

function emptyBooks(): FanState['season'] {
  return { gate: 0, concessions: 0, media: 0, playoffs: 0, payroll: 0, staff: 0, operations: 0, projects: 0, homeGames: 0, attendance: 0 };
}

export function fans(league: League, teamId: number): FanState {
  const t = league.teams[teamId];
  return (t.fans ??= newFanState(t));
}

/** Share of seats sold for a home game. */
export function expectedFill(league: League, team: Team, opponent: Team | null, playoff: boolean): number {
  const f = fans(league, team.id);
  if (playoff) return clamp(0.97 + f.mood * 0.0004, 0.95, 1);
  const rival = opponent && (team.rivals[opponent.id] ?? 0) > 40 ? 0.03 : 0;
  const star = opponent ? Math.min(0.02, playersOf(league, opponent.id).filter((p) => p.ca >= 175).length * 0.01) : 0;
  return clamp(0.68 + f.mood * 0.0032 + team.marketSize * 0.012 - (f.priceFactor - 1) * 0.42 + rival + star, 0.5, 1);
}

/** Book one game for a club (home clubs get the gate). */
export function bookGame(league: League, teamId: number, home: boolean, opponentId: number, playoff: boolean, won: boolean, ot: boolean): void {
  const team = league.teams[teamId];
  const f = fans(league, teamId);
  const games = league.config.season.games;
  // Running costs accrue game by game through the regular season.
  if (!playoff) {
    f.season.payroll += payroll(league, teamId) / games;
    f.season.staff += staffSpend(league, team) / games;
    f.season.operations += operatingCosts(team) / games;
    const media = (localRevenue(team) + LEAGUE_SHARE) / games;
    f.season.media += media;
    f.season.operations += media * VARIABLE_COST;
  }
  if (home) {
    const opp = league.teams[opponentId];
    const fill = expectedFill(league, team, opp, playoff);
    const att = Math.round(capacityOf(team) * fill);
    const price = marketTicketPrice(team) * f.priceFactor * (playoff ? 1.7 : 1);
    const gate = (att * price) / 1000;
    const conc = (att * (24 + team.marketSize * 3)) / 1000;
    f.season.operations += (gate + conc) * VARIABLE_COST;
    if (playoff) f.season.playoffs += gate + conc;
    else {
      f.season.gate += gate;
      f.season.concessions += conc;
      f.season.homeGames++;
      f.season.attendance += att;
      f.games.push({ day: league.day, opp: opp.abbr, att, cap: capacityOf(team) });
      if (f.games.length > HOME_GAMES) f.games.shift();
    }
  }
  // Fans react to every result; a run in the playoffs lifts them most.
  const swing = won ? (playoff ? 1.6 : 0.55) : ot ? -0.15 : playoff ? -0.6 : -0.5;
  f.mood = clamp(f.mood + swing, 0, 100);
}

/** Weekly drift: fans settle toward what the team deserves; expensive tickets wear on them. */
export function fansWeekly(league: League): void {
  for (const team of league.teams) {
    const f = fans(league, team.id);
    const rec = league.standings[team.id];
    const pct = rec?.gp ? points(rec) / (2 * rec.gp) : 0.55;
    const stars = playersOf(league, team.id).filter((p) => p.ca >= 170 || p.traits.includes('fanFavorite')).length;
    const base = clamp(30 + (pct - 0.4) * 140 + stars * 3 + team.marketSize * 2, 15, 92);
    f.mood = clamp(f.mood + (base - f.mood) * 0.08 - (f.priceFactor - 1) * 3, 0, 100);
    // CPU clubs price to their fans.
    if (team.id !== league.userTeamId) f.priceFactor = clamp(0.9 + f.mood / 400, 0.9, 1.15);
  }
}

/** Fans take it personally when a favourite is traded away. */
export function onFavouriteTraded(league: League, teamId: number, wasFanFavourite: boolean, ca: number): void {
  const f = fans(league, teamId);
  const hit = (wasFanFavourite ? 6 : 0) + (ca >= 170 ? 4 : 0);
  if (hit) f.mood = clamp(f.mood - hit, 0, 100);
}

export function setTicketPrice(league: League, factor: number): void {
  fans(league, league.userTeamId).priceFactor = clamp(Math.round(factor * 100) / 100, 0.7, 1.5);
}

export interface Books {
  revenue: number;
  expenses: number;
  profit: number;
  lines: { key: string; label: string; value: number; kind: 'rev' | 'exp' }[];
}

export function booksOf(f: FanState): Books {
  const s = f.season;
  const lines: Books['lines'] = [
    { key: 'gate', label: 'Ticket sales', value: s.gate, kind: 'rev' },
    { key: 'concessions', label: 'Concessions & merchandise', value: s.concessions, kind: 'rev' },
    { key: 'media', label: 'Media, sponsorship & league share', value: s.media, kind: 'rev' },
    { key: 'playoffs', label: 'Playoff gates', value: s.playoffs, kind: 'rev' },
    { key: 'payroll', label: 'Player payroll', value: s.payroll, kind: 'exp' },
    { key: 'staff', label: 'Coaching staff', value: s.staff, kind: 'exp' },
    { key: 'operations', label: 'Hockey & arena operations', value: s.operations, kind: 'exp' },
    { key: 'projects', label: 'Facility projects', value: s.projects, kind: 'exp' },
  ];
  const revenue = lines.filter((l) => l.kind === 'rev').reduce((a, l) => a + l.value, 0);
  const expenses = lines.filter((l) => l.kind === 'exp').reduce((a, l) => a + l.value, 0);
  return { revenue, expenses, profit: revenue - expenses, lines };
}

/** Projected full-season profit from the books so far (regular season pace, no playoffs). */
export function projectedProfit(league: League, teamId: number): number {
  const f = fans(league, teamId);
  const b = booksOf(f);
  const rec = league.standings[teamId];
  const gp = rec?.gp ?? 0;
  if (!gp) return 0;
  const games = league.config.season.games;
  return ((b.revenue - f.season.playoffs) / gp) * games - ((b.expenses - f.season.projects) / gp) * games - f.season.projects + f.season.playoffs;
}

// ── Facility projects ────────────────────────────────────────────────────

export const PROJECTS = [
  { id: 'training', label: 'Training centre upgrade', cost: 6000, facilities: 8, mood: 0, note: 'Better practice facilities: young players develop a little faster.' },
  { id: 'renovation', label: 'Arena renovation', cost: 18000, facilities: 6, mood: 6, note: 'A better game-night experience: fans are happier and fill more seats.' },
  { id: 'performance', label: 'Sports science & performance centre', cost: 14000, facilities: 18, mood: 0, note: 'State-of-the-art development and recovery.' },
] as const;

export function startProject(league: League, id: string): { ok: boolean; message: string } {
  const team = league.teams[league.userTeamId];
  const f = fans(league, team.id);
  const p = PROJECTS.find((x) => x.id === id);
  if (!p) return { ok: false, message: 'Unknown project.' };
  if (f.projectSeason === league.season) return { ok: false, message: 'The owner funds one facility project per season.' };
  const proj = projectedProfit(league, team.id);
  if (league.history.length && proj - p.cost < -25000) return { ok: false, message: "The owner won't fund it while the club is losing this much money." };
  f.season.projects += p.cost;
  f.projectSeason = league.season;
  team.facilities = clamp(team.facilities + p.facilities, 0, 200);
  f.mood = clamp(f.mood + p.mood, 0, 100);
  addNews(league, { category: 'league', headline: `${teamName(league, team.id)} announce a ${p.label.toLowerCase()}`, teamIds: [team.id], playerIds: [], importance: 2 });
  return { ok: true, message: `${p.label} approved.` };
}

/** End of season: archive the books, settle the fans after the playoffs, and adjust next season's budget. */
export function closeBooks(league: League): void {
  for (const team of league.teams) {
    const f = fans(league, team.id);
    const b = booksOf(f);
    const s = f.season;
    const rounds = league.playoffs?.rounds.reduce((n, r) => n + r.filter((x) => x.winner === team.id).length, 0) ?? 0;
    const made = !!league.playoffs?.seeds.some((x) => x.teamId === team.id);
    f.mood = clamp(f.mood + (made ? 3 + rounds * 3 : -6) + (league.playoffs?.champion === team.id ? 12 : 0), 0, 100);
    f.history.push({
      season: league.season,
      revenue: Math.round(b.revenue),
      expenses: Math.round(b.expenses),
      profit: Math.round(b.profit),
      avgAttendance: s.homeGames ? Math.round(s.attendance / s.homeGames) : 0,
      fill: s.homeGames ? Math.round((s.attendance / s.homeGames / capacityOf(team)) * 1000) / 10 : 0,
      mood: Math.round(f.mood),
      priceFactor: f.priceFactor,
    });
    f.lastProfit = Math.round(b.profit);
    f.season = emptyBooks();
    f.games = [];
  }
}

/** Owner's payroll budget multiplier for next season, from last season's profit and the fans. */
export function budgetMultiplier(f: FanState | undefined): number {
  if (!f || f.lastProfit === undefined) return 1;
  return clamp(1 + f.lastProfit / 600000 + (f.mood - 60) / 1500, 0.94, 1.05);
}
