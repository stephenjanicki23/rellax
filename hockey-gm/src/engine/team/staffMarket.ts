/**
 * Coaching staff management: the coaching market, contracts, firings, interim
 * coaches and head-coaching records.
 *
 * SIMPLIFICATION: coaches' pay is outside the NHL salary cap (as in the real
 * league) but comes out of an owner-set staff budget. A fired coach is paid
 * the rest of his contract, and that money stays on the staff budget until his
 * deal would have ended. The budget figure is a game construct, not an NHL rule.
 */
import { clamp } from '../core/math';
import type { Coach, CoachStint, League, Team } from '../types';
import { addNews, addTransaction, playersOf, teamName, withRng } from '../league/helpers';
import { coachOverall, coachTotals, tacticsForRoster } from './coaching';
import { coachChangeFamiliarity, fitNorm } from './fit';
import { contractStartSeason } from '../cba/capManager';
import { playoffResultFor } from '../league/playoffs';

export type StaffSlot = 'headCoach' | 'assistant' | 'goalieCoach';
export const SLOT_ROLE: Record<StaffSlot, Coach['role']> = { headCoach: 'head', assistant: 'assistant', goalieCoach: 'goalie' };
export const ROLE_SLOT: Record<Coach['role'], StaffSlot> = { head: 'headCoach', assistant: 'assistant', goalie: 'goalieCoach' };
export const ROLE_LABEL: Record<Coach['role'], string> = { head: 'Head coach', assistant: 'Assistant coach', goalie: 'Goaltending coach' };

/** Seasons a fired coach refuses to work for the club that fired him. */
const GRUDGE_SEASONS = 3;

/** Owner's annual budget for the coaching staff (thousands). Bigger markets spend more. */
export function staffBudget(team: Team): number {
  return 7600 + team.marketSize * 700;
}

/** First season a contract signed or paid out today covers. */
function payStart(league: League): number {
  return contractStartSeason(league);
}

export function deadStaffMoney(league: League, team: Team, season = payStart(league)): number {
  return (team.deadStaff ?? []).filter((d) => d.throughSeason >= season).reduce((s, d) => s + d.salary, 0);
}

/** Staff salaries this season plus money still owed to fired coaches. */
export function staffSpend(league: League, team: Team, except?: number): number {
  let s = deadStaffMoney(league, team);
  for (const id of [team.staff.headCoach, team.staff.assistant, team.staff.goalieCoach]) {
    if (id === null || id === except) continue;
    s += league.coaches[id]?.contract?.salary ?? 0;
  }
  return s;
}

export function coachOf(league: League, team: Team, slot: StaffSlot): Coach | undefined {
  const id = team.staff[slot];
  return id === null ? undefined : league.coaches[id];
}

/**
 * What a coach asks for a job: pay follows his standing (reputation, résumé,
 * Stanley Cups) and the role. Clubs with a poor reputation pay a premium.
 */
export function coachAsk(league: League, c: Coach, role: Coach['role'], teamId: number): { salary: number; years: number } {
  const team = league.teams[teamId];
  const ovr = coachOverall({ ...c, role });
  const tot = coachTotals(c);
  let salary: number;
  let years: number;
  if (role === 'head') {
    salary = 900 + c.reputation * 32 + Math.max(0, ovr - 100) * 22 + tot.cups * 450 + Math.min(tot.gp, 1000) * 0.6;
    salary = clamp(salary, 1000, 6500);
    years = c.reputation >= 70 ? 4 : c.reputation >= 45 ? 3 : 2;
  } else if (role === 'assistant') {
    salary = clamp(250 + ovr * 3.2 + c.reputation * 3, 300, 1200);
    years = 2;
  } else {
    salary = clamp(200 + c.ratings.goaltending * 3.4 + c.reputation * 2, 250, 950);
    years = 2;
  }
  salary *= 1 + clamp((55 - team.reputation) / 300, -0.05, 0.12);
  return { salary: Math.round(salary / 25) * 25, years };
}

/** Why a coach won't take a club's job, or null if he's open to it. */
export function coachRefusal(league: League, c: Coach, teamId: number, role: Coach['role']): string | null {
  if (c.retired) return `${c.first} ${c.last} has retired.`;
  if ((c.grudge?.[teamId] ?? 0) > 0) return `${c.first} ${c.last} won't work for the club that fired him.`;
  if (c.teamId === teamId && c.role === role) return `${c.first} ${c.last} already holds that job.`;
  if (c.teamId !== null) {
    // Clubs let assistants interview for head jobs elsewhere; lateral moves are blocked.
    if (!(role === 'head' && c.role !== 'head')) return `${c.first} ${c.last} is under contract with the ${teamName(league, c.teamId)}.`;
  }
  if (c.role === 'head' && role !== 'head' && coachTotals(c).gp >= 200) return `${c.first} ${c.last} is only interested in head-coaching jobs.`;
  const team = league.teams[teamId];
  // Established winners want a club that can contend.
  if (role === 'head' && c.reputation >= 72 && team.strategy === 'rebuild' && team.reputation < 50) return `${c.first} ${c.last} wants a club that's ready to win now.`;
  return null;
}

/** True if the coach is someone the club can approach for the role. */
export function isCandidate(_league: League, c: Coach, teamId: number, role: Coach['role']): boolean {
  if (c.retired) return false;
  if (c.teamId === null) return c.role === role || (role === 'head' && c.role === 'assistant') || (role === 'assistant' && c.role === 'head' && coachTotals(c).gp < 200);
  return role === 'head' && c.role === 'assistant' && c.teamId !== teamId && coachOverall({ ...c, role: 'head' }) >= 105;
}

export function candidatesFor(league: League, teamId: number, role: Coach['role']): Coach[] {
  return Object.values(league.coaches).filter((c) => isCandidate(league, c, teamId, role));
}

function installHeadCoach(league: League, team: Team, c: Coach): void {
  const roster = playersOf(league, team.id);
  withRng(league, (rng) => (team.tactics = tacticsForRoster(c.philosophy, roster, c.ratings.tactics, rng, team.lines, c.system, fitNorm(league))));
  // A new coach installs his own system: the players have to learn it.
  coachChangeFamiliarity(team);
}

/** Put a coach in a slot (the slot must be empty). Handles promotions from another club's bench. */
export function placeCoach(league: League, team: Team, c: Coach, role: Coach['role'], contract: { salary: number; years: number }, opts: { interim?: boolean } = {}): void {
  const slot = ROLE_SLOT[role];
  if (c.teamId !== null) {
    const from = league.teams[c.teamId];
    const fromSlot = ROLE_SLOT[c.role];
    if (from.staff[fromSlot] === c.id) from.staff[fromSlot] = null;
    if (from.id !== team.id) {
      addNews(league, { category: 'coach', headline: `${teamName(league, team.id)} hire ${teamName(league, from.id)} ${ROLE_LABEL[c.role].toLowerCase()} ${c.first} ${c.last} as ${ROLE_LABEL[role].toLowerCase()}`, teamIds: [team.id, from.id], playerIds: [], importance: 3 });
      if (from.id !== league.userTeamId) hireBest(league, from, c.role);
    }
  }
  c.teamId = team.id;
  c.role = role;
  c.hiredSeason = league.season;
  c.contract = contract;
  c.interim = opts.interim || undefined;
  team.staff[slot] = c.id;
  if (role === 'head') {
    installHeadCoach(league, team, c);
    startStint(league, c, team.id, opts.interim);
  }
}

function startStint(league: League, c: Coach, teamId: number, interim?: boolean): CoachStint | null {
  if (league.phase !== 'regular' && league.phase !== 'playoffs') return null;
  c.stints ??= [];
  const s: CoachStint = { season: league.season, teamId, gp: 0, w: 0, l: 0, otl: 0, pw: 0, pl: 0, ...(interim ? { interim: true } : {}) };
  c.stints.push(s);
  return s;
}

/** Remove a coach from his club, paying out the rest of his deal. Returns the money owed per season. */
export function releaseCoach(league: League, team: Team, slot: StaffSlot, fired: boolean): Coach | null {
  const id = team.staff[slot];
  if (id === null) return null;
  const c = league.coaches[id];
  team.staff[slot] = null;
  if (fired && c.contract && c.contract.years > 0 && !c.interim) {
    team.deadStaff ??= [];
    team.deadStaff.push({ coachId: c.id, name: `${c.first} ${c.last}`, salary: c.contract.salary, throughSeason: payStart(league) + c.contract.years - 1 });
  }
  if (fired) {
    c.grudge = { ...(c.grudge ?? {}), [team.id]: GRUDGE_SEASONS };
    c.reputation = clamp(c.reputation - (c.role === 'head' ? 6 : 3), 0, 100);
  }
  // An interim head coach goes back to being an assistant.
  if (c.role === 'head' && c.interim) c.role = 'assistant';
  c.teamId = null;
  c.contract = null;
  c.interim = undefined;
  return c;
}

/** Best available coach for a CPU club (or a fallback when nobody is open). */
export function hireBest(league: League, team: Team, role: Coach['role']): Coach | null {
  const room = staffBudget(team) - staffSpend(league, team, team.staff[ROLE_SLOT[role]] ?? undefined);
  const open = candidatesFor(league, team.id, role).filter((c) => c.teamId === null && !coachRefusal(league, c, team.id, role));
  const affordable = open.filter((c) => coachAsk(league, c, role, team.id).salary <= room);
  // If nobody fits the budget, the cheapest coach available takes the job.
  const cheapest = [...open].sort((a, b) => coachAsk(league, a, role, team.id).salary - coachAsk(league, b, role, team.id).salary).slice(0, 1);
  const pool = (affordable.length ? affordable : cheapest)
    .map((c) => ({ c, s: coachOverall({ ...c, role }) + c.reputation * 0.35 + (c.real ? 4 : 0) + withRng(league, (rng) => rng.normal(0, 6)) }))
    .sort((a, b) => b.s - a.s);
  const c = pool[0]?.c;
  if (!c) return null;
  placeCoach(league, team, c, role, coachAsk(league, c, role, team.id));
  return c;
}

/**
 * Fire a head coach. The assistant steps in as interim head coach (the club
 * can then hire a permanent replacement); with no assistant, the club hires
 * from the market straight away.
 */
export function fireHeadCoach(league: League, team: Team, reason: string, opts: { interim?: boolean } = {}): { fired: Coach | null; replacement: Coach | null } {
  const fired = releaseCoach(league, team, 'headCoach', true);
  if (!fired) return { fired: null, replacement: null };
  let replacement: Coach | null = null;
  const asst = coachOf(league, team, 'assistant');
  const inSeason = league.phase === 'regular' || league.phase === 'playoffs';
  if (asst && inSeason && (opts.interim ?? true)) {
    team.staff.assistant = null;
    placeCoach(league, team, asst, 'head', asst.contract ?? { salary: 500, years: 1 }, { interim: true });
    replacement = asst;
  } else if (team.id !== league.userTeamId) {
    replacement = hireBest(league, team, 'head');
  }
  const who = `${fired.first} ${fired.last}`;
  addNews(league, {
    category: 'coach',
    headline: `${teamName(league, team.id)} fire head coach ${who}${replacement ? `; ${replacement.first} ${replacement.last} takes over${replacement.interim ? ' on an interim basis' : ''}` : ''}`,
    body: reason,
    teamIds: [team.id],
    playerIds: [],
    importance: 3,
  });
  addTransaction(league, { kind: 'coach', teamIds: [team.id], playerIds: [], description: `${teamName(league, team.id)} dismiss head coach ${who}${replacement ? ` · ${replacement.first} ${replacement.last} ${replacement.interim ? 'named interim' : 'hired'}` : ''}` });
  return { fired, replacement };
}

export interface StaffResult {
  ok: boolean;
  message: string;
}

/** The user's offer to a coach. */
export function offerCoach(league: League, teamId: number, coachId: number, role: Coach['role'], salary: number, years: number): StaffResult {
  const team = league.teams[teamId];
  const c = league.coaches[coachId];
  if (!c) return { ok: false, message: 'Unknown coach.' };
  const slot = ROLE_SLOT[role];
  const current = coachOf(league, team, slot);
  if (current && !current.interim) return { ok: false, message: `You already have a ${ROLE_LABEL[role].toLowerCase()}. Let ${current.first} ${current.last} go first.` };
  const refusal = coachRefusal(league, c, teamId, role);
  if (refusal) return { ok: false, message: refusal };
  if (years < 1 || years > 5) return { ok: false, message: 'Coaching contracts run one to five years.' };
  const ask = coachAsk(league, c, role, teamId);
  const budget = staffBudget(team);
  const spend = staffSpend(league, team, current?.id) + salary;
  if (spend > budget) return { ok: false, message: `That would put the coaching staff at $${(spend / 1000).toFixed(2)}M, over the owner's $${(budget / 1000).toFixed(2)}M staff budget.` };
  // Shorter terms than he wants cost a premium; longer ones he'll take at a small discount.
  const needed = ask.salary * (1 + Math.max(0, ask.years - years) * 0.06 - Math.max(0, years - ask.years) * 0.03);
  if (salary < needed * 0.98) return { ok: false, message: `${c.first} ${c.last} turns it down. He's looking for about $${(needed / 1000).toFixed(2)}M a year over ${ask.years} years.` };
  if (current?.interim) {
    // The interim coach returns to the assistant's chair if it's open.
    releaseCoach(league, team, slot, false);
    if (team.staff.assistant === null) {
      placeCoach(league, team, current, 'assistant', { salary: 500, years: 1 });
    }
  }
  placeCoach(league, team, c, role, { salary: Math.round(salary), years });
  addNews(league, { category: 'coach', headline: `${teamName(league, teamId)} name ${c.first} ${c.last} ${ROLE_LABEL[role].toLowerCase()}`, body: `${years}-year contract.`, teamIds: [teamId], playerIds: [], importance: role === 'head' ? 3 : 1 });
  addTransaction(league, { kind: 'coach', teamIds: [teamId], playerIds: [], description: `${teamName(league, teamId)} hire ${ROLE_LABEL[role].toLowerCase()} ${c.first} ${c.last} (${years} yr, $${(salary / 1000).toFixed(2)}M)` });
  return { ok: true, message: `${c.first} ${c.last} is your new ${ROLE_LABEL[role].toLowerCase()}.` };
}

/** The user fires a member of the staff. */
export function userFireCoach(league: League, teamId: number, slot: StaffSlot): StaffResult {
  const team = league.teams[teamId];
  const c = coachOf(league, team, slot);
  if (!c) return { ok: false, message: 'Nobody holds that job.' };
  const owed = c.contract && !c.interim ? c.contract.salary * c.contract.years : 0;
  if (slot === 'headCoach') {
    const { replacement } = fireHeadCoach(league, team, 'The general manager made the change.');
    return { ok: true, message: `${c.first} ${c.last} has been fired${owed ? ` ($${(owed / 1000).toFixed(2)}M still owed)` : ''}.${replacement ? ` ${replacement.first} ${replacement.last} takes over as interim head coach.` : ' Hire a replacement before the next game.'}` };
  }
  releaseCoach(league, team, slot, true);
  addTransaction(league, { kind: 'coach', teamIds: [teamId], playerIds: [], description: `${teamName(league, teamId)} dismiss ${ROLE_LABEL[c.role].toLowerCase()} ${c.first} ${c.last}` });
  return { ok: true, message: `${c.first} ${c.last} has been let go${owed ? ` ($${(owed / 1000).toFixed(2)}M still owed)` : ''}.` };
}

/** Extension ask: a coach coming off a good run wants a raise. */
export function extensionAsk(league: League, c: Coach): { salary: number; years: number } {
  const ask = coachAsk(league, c, c.role, c.teamId ?? league.userTeamId);
  return { salary: Math.max(ask.salary, Math.round(((c.contract?.salary ?? 0) * 1.05) / 25) * 25), years: ask.years };
}

/** Extend a coach (the interim tag comes off for a head coach). */
export function extendCoach(league: League, coachId: number, salary: number, years: number): StaffResult {
  const c = league.coaches[coachId];
  if (!c || c.teamId === null || !c.contract) return { ok: false, message: 'He is not under contract.' };
  if (!c.interim && c.contract.years > 1) return { ok: false, message: 'Coaches discuss extensions in the last year of their deal.' };
  const team = league.teams[c.teamId];
  const ask = extensionAsk(league, c);
  if (years < 1 || years > 5) return { ok: false, message: 'Coaching contracts run one to five years.' };
  if (salary < ask.salary * 0.98) return { ok: false, message: `${c.first} ${c.last} wants about $${(ask.salary / 1000).toFixed(2)}M a year.` };
  if (staffSpend(league, team, c.id) + salary > staffBudget(team)) return { ok: false, message: "That would break the owner's staff budget." };
  // An extension adds years after the current season.
  c.contract = { salary: Math.round(salary), years: c.interim ? years : c.contract.years + years };
  const wasInterim = !!c.interim;
  c.interim = undefined;
  addNews(league, { category: 'coach', headline: wasInterim ? `${teamName(league, team.id)} remove the interim tag: ${c.first} ${c.last} signs on as head coach` : `${teamName(league, team.id)} extend ${ROLE_LABEL[c.role].toLowerCase()} ${c.first} ${c.last}`, teamIds: [team.id], playerIds: [], importance: c.role === 'head' ? 2 : 1 });
  return { ok: true, message: `${c.first} ${c.last} signed through ${league.season + c.contract.years}.` };
}

// ── Records ──────────────────────────────────────────────────────────────

const MILESTONES = [1, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

/** Credit a finished game to each team's head coach. */
export function tallyCoachGame(league: League, teamId: number, won: boolean, ot: boolean, playoff: boolean): void {
  const team = league.teams[teamId];
  const c = coachOf(league, team, 'headCoach');
  if (!c) return;
  c.stints ??= [];
  let s = c.stints.at(-1);
  if (!s || s.season !== league.season || s.teamId !== teamId) s = startStint(league, c, teamId, c.interim)!;
  if (!s) return;
  if (playoff) {
    if (won) s.pw++;
    else s.pl++;
    return;
  }
  s.gp++;
  if (won) s.w++;
  else if (ot) s.otl++;
  else s.l++;
  if (won) {
    const w = coachTotals(c).w;
    if (MILESTONES.includes(w)) {
      addNews(league, {
        category: 'coach',
        headline: w === 1 ? `${c.first} ${c.last} earns his first NHL win as a head coach` : `${c.first} ${c.last} picks up his ${w}th career win as an NHL head coach`,
        teamIds: [teamId],
        playerIds: [],
        importance: w >= 500 || w === 1 ? 3 : 2,
      });
    }
  }
}

/** End of season: turn this season's stints into career lines and update reputations. */
export function closeCoachSeason(league: League): void {
  const champion = league.playoffs?.champion ?? null;
  for (const c of Object.values(league.coaches)) {
    const stints = (c.stints ?? []).filter((s) => s.season === league.season);
    for (const s of stints) {
      const behindBench = c.teamId === s.teamId && c.role === 'head';
      const result = behindBench ? playoffResultFor(league, s.teamId) : s.pw + s.pl ? playoffResultFor(league, s.teamId) : '—';
      const cup = behindBench && champion === s.teamId;
      c.career.push({ season: s.season, teamId: s.teamId, role: 'head', gp: s.gp, w: s.w, l: s.l, otl: s.otl, pw: s.pw, pl: s.pl, playoffs: result, ...(cup ? { cup: true } : {}), ...(s.interim ? { interim: true } : {}) });
      if (cup) {
        c.awards ??= [];
        c.awards.push({ season: league.season, award: 'Stanley Cup' });
      }
      if (behindBench && s.gp >= 20) {
        const pct = (2 * s.w + s.otl) / (2 * s.gp);
        const rounds = league.playoffs?.rounds.filter((r) => r.some((x) => x.winner === s.teamId)).length ?? 0;
        c.reputation = Math.round(clamp(c.reputation + (pct - 0.55) * 40 + rounds * 2 + (cup ? 8 : 0), 0, 100));
      }
    }
    if (c.teamId !== null && c.role !== 'head') c.career.push({ season: league.season, teamId: c.teamId, role: c.role, w: 0, l: 0, otl: 0, playoffs: '' });
    c.stints = (c.stints ?? []).filter((s) => s.season > league.season);
    if (c.grudge) for (const k of Object.keys(c.grudge)) if (--c.grudge[Number(k)] <= 0) delete c.grudge[Number(k)];
  }
  for (const t of league.teams) if (t.deadStaff) t.deadStaff = t.deadStaff.filter((d) => d.throughSeason > league.season);
}
