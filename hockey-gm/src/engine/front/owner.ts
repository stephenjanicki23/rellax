/**
 * The owner: season goals for the GM, a job-security meter that moves with
 * results, end-of-season reviews, and firing (with job offers elsewhere).
 *
 * SIMPLIFICATION: owners' priorities and patience are game constructs derived
 * from the club's market, reputation and direction, not portrayals of the
 * real owners.
 */
import { clamp } from '../core/math';
import type { League, OwnerGoal, OwnerPriority, OwnerState, Team } from '../types';
import { addNews, points, teamName } from '../league/helpers';
import { payroll, fmtMoney } from '../economy/contracts';
import { booksOf, projectedProfit } from './finances';

export const PRIORITY_LABEL: Record<OwnerPriority, string> = {
  winNow: 'Win now',
  patient: 'Patient builder',
  frugal: 'Watches the budget',
  youth: 'Develop from within',
};

/** Security below this at the end of a season (or far below it mid-season) costs the GM his job. */
export const FIRE_LINE = 15;
const MIDSEASON_FIRE_LINE = 6;

function ownerProfile(team: Team): { priority: OwnerPriority; patience: number } {
  if (team.strategy === 'rebuild') return { priority: team.marketSize >= 4 ? 'patient' : 'youth', patience: 70 };
  if (team.marketSize >= 4 && team.reputation >= 55) return { priority: 'winNow', patience: 40 };
  if (team.marketSize <= 2) return { priority: 'frugal', patience: 55 };
  return { priority: team.strategy === 'contend' ? 'winNow' : 'patient', patience: team.strategy === 'contend' ? 45 : 60 };
}

/** Projected league rank (1 = best) from preseason projections. */
function projectedRank(league: League, teamId: number): number {
  const mine = league.projections[teamId] ?? 92;
  return 1 + league.teams.filter((t) => (league.projections[t.id] ?? 92) > mine).length;
}

export function newOwnerState(league: League, teamId: number, security = 60): OwnerState {
  const team = league.teams[teamId];
  const prof = ownerProfile(team);
  return { teamId, name: team.owner, priority: prof.priority, patience: prof.patience, security, season: -1, goals: [], history: [], messages: [], hiredSeason: league.season, career: [] };
}

function say(league: League, o: OwnerState, text: string, tone: 'good' | 'bad' | 'neutral'): void {
  o.messages.unshift({ season: league.season, day: league.day, text, tone });
  o.messages = o.messages.slice(0, 40);
}

/** Set this season's goals (once per season) from expectations and the owner's priorities. */
export function setOwnerGoals(league: League): void {
  const o = (league.owner ??= newOwnerState(league, league.userTeamId));
  if (o.teamId !== league.userTeamId) Object.assign(o, newOwnerState(league, league.userTeamId, o.security), { career: o.career, history: [] });
  if (o.season === league.season) return;
  const team = league.teams[o.teamId];
  const rank = projectedRank(league, team.id);
  const proj = Math.round(league.projections[team.id] ?? 92);
  const goals: OwnerGoal[] = [];
  if (rank <= 4) goals.push({ kind: 'round', target: 2, weight: 3, label: 'Win at least two playoff rounds' });
  else if (rank <= 10) goals.push({ kind: 'round', target: 1, weight: 3, label: 'Win a playoff round' });
  else if (rank <= 20) goals.push({ kind: 'playoffs', target: 1, weight: 3, label: 'Make the playoffs' });
  // Last season's points, for the "improve" goal (none in a club's first season here).
  const last = league.history.at(-1)?.standings.find((s) => s.teamId === team.id);
  if (rank > 20 && last) goals.push({ kind: 'improve', target: last.pts + 1, weight: 2, label: `Show progress: beat last season's ${last.pts} points` });
  // Preseason projections run optimistic for strong rosters: the owner's bar sits a little under them.
  const ptsTarget = Math.round(rank <= 20 ? Math.min(proj - 4, 104) : proj - 2);
  goals.push({ kind: 'points', target: ptsTarget, weight: rank > 20 && !last ? 3 : 2, label: `Finish with at least ${ptsTarget} points` });
  if (o.priority === 'youth' || o.priority === 'patient') goals.push({ kind: 'youth', target: 3, weight: o.priority === 'youth' ? 2 : 1, label: 'Give three players aged 23 or younger 40+ games' });
  if (o.priority === 'frugal') {
    goals.push({ kind: 'budget', target: team.budget, weight: 1, label: `Keep payroll at or under ${fmtMoney(team.budget)}` });
    goals.push({ kind: 'profit', target: 0, weight: 1.5, label: 'Turn a profit this season' });
  }
  if (o.priority === 'winNow') goals.push({ kind: 'division', target: 3, weight: 1, label: 'Finish top three in the division' });
  o.goals = goals;
  o.season = league.season;
  o.seasonStart = o.security;
  o.warned = undefined;
  say(league, o, `Here's what I expect this season: ${goals.map((g) => g.label.toLowerCase()).join('; ')}.`, 'neutral');
}

/** Playoff rounds the team has won this season. */
function roundsWon(league: League, teamId: number): number {
  return league.playoffs?.rounds.reduce((n, r) => n + r.filter((s) => s.winner === teamId).length, 0) ?? 0;
}

function madePlayoffs(league: League, teamId: number): boolean {
  return !!league.playoffs?.seeds.some((s) => s.teamId === teamId);
}

function divisionRank(league: League, teamId: number): number {
  const team = league.teams[teamId];
  const mine = league.standings[teamId];
  const p = mine ? points(mine) : 0;
  return 1 + league.teams.filter((t) => t.divisionId === team.divisionId && t.id !== teamId && league.standings[t.id] && points(league.standings[t.id]) > p).length;
}

function youthCount(league: League, teamId: number): number {
  return Object.entries(league.seasonStats).filter(([id, s]) => {
    const p = league.players[Number(id)];
    return p && s.teamId === teamId && s.reg.gp >= 40 && league.season - p.birthYear <= 23;
  }).length;
}

/**
 * Progress on a goal: value now, whether it's met, and an achievement score
 * (0 = nowhere near, 1 = met, a little more for blowing it away).
 */
export function goalProgress(league: League, g: OwnerGoal, teamId: number): { value: string; met: boolean; score: number; pct: number } {
  const rec = league.standings[teamId];
  const gp = rec?.gp ?? 0;
  const games = league.config.season.games;
  const pts = rec ? points(rec) : 0;
  const pace = gp ? (pts / gp) * games : 0;
  switch (g.kind) {
    case 'points':
    case 'improve': {
      const done = league.phase !== 'regular' && league.phase !== 'preseason';
      const v = done ? pts : pace;
      const score = clamp(1 + (v - g.target) / 15, 0, 1.25);
      return { value: done ? `${pts} pts` : gp ? `${pts} pts · on pace for ${Math.round(pace)}` : 'No games yet', met: v >= g.target, score, pct: clamp(v / Math.max(1, g.target), 0, 1) };
    }
    case 'playoffs': {
      const inNow = madePlayoffs(league, teamId);
      const decided = !!league.playoffs;
      const score = inNow ? 1 + roundsWon(league, teamId) * 0.1 : decided ? 0.15 : clamp((pace - 90) / 16 + 0.5, 0, 1);
      return { value: decided ? (inNow ? `In the playoffs${roundsWon(league, teamId) ? ` · won ${roundsWon(league, teamId)} round(s)` : ''}` : 'Missed the playoffs') : gp ? `On pace for ${Math.round(pace)} pts (≈92 usually gets in)` : 'Season not started', met: decided ? inNow : gp >= 10 && pace >= 92, score, pct: decided ? (inNow ? 1 : 0) : clamp(pace / 92, 0, 1) };
    }
    case 'round': {
      const won = roundsWon(league, teamId);
      const decided = !!league.playoffs;
      const inNow = madePlayoffs(league, teamId);
      const score = decided ? (won >= g.target ? 1 + (won - g.target) * 0.12 : inNow ? 0.35 + (won / g.target) * 0.4 : 0) : clamp((pace - 95) / 16 + 0.5, 0, 1);
      return { value: decided ? (inNow ? `Won ${won} of ${g.target} round(s)` : 'Missed the playoffs') : gp ? `On pace for ${Math.round(pace)} pts` : 'Season not started', met: won >= g.target, score, pct: decided ? clamp(won / g.target, 0, 1) : clamp(pace / 100, 0, 1) * 0.5 };
    }
    case 'division': {
      const r = divisionRank(league, teamId);
      return { value: gp ? `${r}${r === 1 ? 'st' : r === 2 ? 'nd' : r === 3 ? 'rd' : 'th'} in the division` : 'Season not started', met: gp > 0 && r <= g.target, score: gp ? clamp(1 - (r - g.target) * 0.25, 0, 1.1) : 0.5, pct: gp ? clamp((9 - r) / (9 - g.target), 0, 1) : 0 };
    }
    case 'youth': {
      const n = youthCount(league, teamId);
      return { value: `${n} of ${g.target}`, met: n >= g.target, score: clamp(n / g.target, 0, 1.15), pct: clamp(n / g.target, 0, 1) };
    }
    case 'profit': {
      // Through the regular season, the projection; once it's over, the actual books (the review runs before they close).
      const done = league.phase !== 'regular' && league.phase !== 'preseason';
      const f = league.teams[teamId].fans;
      const v = done && f ? booksOf(f).profit : projectedProfit(league, teamId);
      return { value: gp ? `${done ? '' : 'Projected '}${v >= 0 ? 'profit' : 'loss'} ${fmtMoney(Math.abs(v))}` : 'Season not started', met: gp > 0 && v >= g.target, score: gp ? clamp(1 + v / 30000, 0, 1.15) : 0.6, pct: gp ? clamp(0.5 + v / 40000, 0, 1) : 0 };
    }
    case 'budget': {
      const pay = payroll(league, teamId);
      return { value: `Payroll ${fmtMoney(pay)}`, met: pay <= g.target, score: pay <= g.target ? 1 : clamp(1 - (pay - g.target) / 6000, 0, 1), pct: pay <= g.target ? 1 : clamp(g.target / pay, 0, 1) };
    }
  }
}

/** Overall achievement 0..~1.2, weighted across goals. */
export function goalScore(league: League, o: OwnerState): number {
  const w = o.goals.reduce((s, g) => s + g.weight, 0) || 1;
  return o.goals.reduce((s, g) => s + g.weight * goalProgress(league, g, o.teamId).score, 0) / w;
}

export function gradeFor(score: number): string {
  return score >= 1.05 ? 'A' : score >= 0.9 ? 'B' : score >= 0.7 ? 'C' : score >= 0.5 ? 'D' : 'F';
}

export function securityLabel(s: number): { text: string; cls: string } {
  if (s >= 75) return { text: 'Very secure', cls: 'good' };
  if (s >= 50) return { text: 'Secure', cls: 'good' };
  if (s >= 30) return { text: 'Under pressure', cls: 'warn' };
  if (s >= FIRE_LINE) return { text: 'Hot seat', cls: 'bad' };
  return { text: 'On the brink', cls: 'bad' };
}

function canBeFired(league: League): boolean {
  return league.settings.canBeFired !== false && !league.settings.autoManageUser;
}

/** Weekly in-season check-in: security drifts with the team's pace against expectations. */
export function ownerWeekly(league: League): void {
  const o = league.owner;
  if (!o || o.fired || league.phase !== 'regular' || o.season !== league.season) return;
  const rec = league.standings[o.teamId];
  if (!rec || rec.gp < 10) return;
  const score = goalScore(league, o);
  // Impatient owners react faster; a good run rebuilds trust.
  const speed = 1 - o.patience / 150;
  // In-season mood swings are bounded; the big verdict comes at the season review.
  const start = o.seasonStart ?? o.security;
  // Happy fans buy the GM a little patience; angry ones cost some.
  const mood = league.teams[o.teamId].fans?.mood ?? 60;
  o.security = clamp(o.security + (score - 0.7) * 1.6 * speed + (mood - 55) / 120, Math.max(0, start - 30), Math.min(100, start + 15));
  if (o.security < 30 && !o.warned) {
    o.warned = true;
    say(league, o, `I'm not happy with where this is heading. Results need to improve, and soon.`, 'bad');
    addNews(league, { category: 'league', headline: `Reports: ${teamName(league, o.teamId)} ownership growing impatient with the front office`, teamIds: [o.teamId], playerIds: [], importance: 3 });
  }
  if (o.security < MIDSEASON_FIRE_LINE && league.day > 50 && canBeFired(league)) fireGm(league, 'The owner made a change in the middle of the season.');
}

/** End of season: grade the goals, move security, maybe fire the GM. */
export function ownerSeasonReview(league: League): void {
  const o = league.owner;
  if (!o || o.fired || o.season !== league.season) return;
  const score = goalScore(league, o);
  const grade = gradeFor(score);
  const champ = league.playoffs?.champion === o.teamId;
  const before = o.security;
  const swing = (score - 0.75) * 50 * (1 - o.patience / 200) + (champ ? 25 : 0);
  o.security = clamp(o.security + swing, 0, 100);
  const met = o.goals.filter((g) => goalProgress(league, g, o.teamId).met).length;
  const rec = league.standings[o.teamId];
  const summary = `${met} of ${o.goals.length} goals met${champ ? ' · Stanley Cup champions' : ''}`;
  o.history.push({ season: league.season, teamId: o.teamId, grade, security: Math.round(o.security), change: Math.round(o.security - before), summary, record: rec ? `${rec.w}-${rec.l}-${rec.otl}` : '' });
  say(
    league,
    o,
    champ
      ? 'A championship. Thank you — this city will never forget it.'
      : grade === 'A' || grade === 'B'
        ? `A good season (${grade}). Keep building on it.`
        : grade === 'C'
          ? `A mixed season (${grade}). I expect more next year.`
          : `That season (${grade}) was not good enough.`,
    grade === 'A' || grade === 'B' || champ ? 'good' : grade === 'C' ? 'neutral' : 'bad',
  );
  if (o.security < FIRE_LINE && canBeFired(league)) fireGm(league, `The owner graded the season ${grade}: ${summary.toLowerCase()}.`);
}

function closeCareerStint(league: League, o: OwnerState): void {
  const seasons = o.history.filter((h) => h.teamId === o.teamId);
  o.career.push({ teamId: o.teamId, from: o.hiredSeason, to: league.season, seasons: seasons.length, record: seasons.map((h) => h.record).filter(Boolean).join(', '), cups: league.history.filter((h) => h.champion === o.teamId && h.season >= o.hiredSeason).length });
}

export function fireGm(league: League, reason: string): void {
  const o = league.owner!;
  o.fired = { season: league.season, day: league.day, reason, offers: jobOffers(league) };
  say(league, o, `I've decided to make a change. ${reason}`, 'bad');
  addNews(league, { category: 'league', headline: `${teamName(league, o.teamId)} fire general manager`, body: reason, teamIds: [o.teamId], playerIds: [], importance: 5 });
}

/** Clubs that would interview a fired GM: weaker clubs, more so with a better track record. */
export function jobOffers(league: League): number[] {
  const o = league.owner!;
  const pool = league.teams.filter((t) => t.id !== o.teamId).sort((a, b) => (league.projections[a.id] ?? 92) - (league.projections[b.id] ?? 92));
  const cups = o.history.filter((h) => h.summary.includes('Stanley Cup')).length;
  const reach = clamp(6 + cups * 6 + o.history.filter((h) => h.grade === 'A' || h.grade === 'B').length * 2, 6, 24);
  const candidates = pool.slice(0, reach);
  // Deterministic but varied: spread picks across the candidate list.
  const out: number[] = [];
  for (let i = 0; i < candidates.length && out.length < 3; i += Math.max(1, Math.floor(candidates.length / 3))) out.push(candidates[(i + league.season) % candidates.length].id);
  return [...new Set(out)];
}

/** Take a job with another club after being fired: the clubs swap front offices. */
export function takeJob(league: League, teamId: number): void {
  const o = league.owner!;
  if (!o.fired?.offers.includes(teamId)) return;
  closeCareerStint(league, o);
  const oldId = o.teamId;
  const oldTeam = league.teams[oldId];
  const newTeam = league.teams[teamId];
  // The new club's GM moves to the old club's chair.
  const theirGm = newTeam.gm;
  newTeam.gm = oldTeam.gm;
  oldTeam.gm = theirGm;
  oldTeam.tradeBlock = [];
  newTeam.tradeBlock = [];
  newTeam.autoLines = true;
  league.userTeamId = teamId;
  league.tradeOffers = [];
  const career = o.career;
  league.owner = { ...newOwnerState(league, teamId, 62), career };
  // A GM hired in season gets this season's goals right away; otherwise they come in preseason.
  if (league.phase === 'regular' || league.phase === 'preseason') setOwnerGoals(league);
  say(league, league.owner, `Welcome aboard. I believe you can turn this club around.`, 'good');
  addNews(league, { category: 'league', headline: `${teamName(league, teamId)} hire a new general manager`, teamIds: [teamId], playerIds: [], importance: 4 });
}

/** Ignore the firing and keep going (turns firing off). */
export function stayOn(league: League): void {
  const o = league.owner!;
  o.fired = undefined;
  o.security = Math.max(o.security, 30);
  league.settings.canBeFired = false;
}
