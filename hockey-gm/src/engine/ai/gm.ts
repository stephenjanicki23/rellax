/**
 * CPU front offices. The league keeps living without the user: teams trade,
 * extend players, call up prospects, fire and hire coaches, and shift between
 * contending and rebuilding.
 */
import { clamp } from '../core/math';
import type { Coach, League, Team } from '../types';
import { addNews, addTransaction, isCpu, playersOf, teamName, withRng, points } from '../league/helpers';
import { enforceCap, ensureDressable, promoteReadyProspects, trimProspects, trimRoster } from '../economy/roster';
import { executeTrade, findAiGoalieTrade, findAiTrade, findOfferForUser, validateTrade } from '../economy/trade';
import { weeklyScouting } from '../economy/scouting';
import { teamStrength } from '../team/strength';
import { coachOverall, tacticsForRoster } from '../team/coaching';
import { extensionEligible, offerContract, resignAsk, willingness } from '../economy/freeAgency';
import { autoLines } from '../team/lines';
import { fullName } from '../player/ability';

export function aiDaily(league: League): void {
  for (const t of league.teams) ensureDressable(league, t.id);
  if (league.day % 7 === 3) weeklyScouting(league);
  if (league.phase !== 'regular') return;
  const daysToDeadline = league.tradeDeadlineDay - league.day;
  if (daysToDeadline >= 0) {
    const pTrade = daysToDeadline <= 10 ? 0.3 : league.day < 20 ? 0.02 : 0.06;
    withRng(league, (rng) => rng.chance(pTrade)) && tryAiTrade(league);
    if (daysToDeadline <= 14 && league.day % 4 === 0) maybeRumor(league);
  }
  if (daysToDeadline === 0) {
    addNews(league, { category: 'league', headline: 'Trade deadline passes — rosters are set for the stretch run', teamIds: [], playerIds: [], importance: 3 });
  }
  if (league.day > 30 && league.day % 15 === 0) midseasonCoachReview(league);
  manageUserOffers(league, daysToDeadline);
  if (league.day % 30 === 15) aiExtensions(league);
}

function tryAiTrade(league: League): void {
  for (let i = 0; i < 3; i++) {
    const t = (i === 0 ? findAiGoalieTrade(league) : null) ?? findAiTrade(league);
    if (t) {
      executeTrade(league, t);
      for (const id of [t.from, t.to]) {
        trimRoster(league, id);
        ensureDressable(league, id);
      }
      return;
    }
  }
}

function maybeRumor(league: League): void {
  withRng(league, (rng) => {
    const sellers = league.teams.filter((t) => t.strategy === 'rebuild' && t.id !== league.userTeamId);
    if (!sellers.length || !rng.chance(0.5)) return;
    const s = rng.pick(sellers);
    const vets = playersOf(league, s.id).filter((p) => league.season - p.birthYear >= 28 && p.ca >= 140).sort((a, b) => b.ca - a.ca);
    const v = vets[0];
    if (!v) return;
    if (league.news.some((n) => n.category === 'rumor' && n.playerIds.includes(v.id) && n.season === league.season)) return;
    const role = v.pos === 'G' ? 'goaltender' : v.pos === 'D' ? 'defenseman' : v.pos === 'C' ? 'center' : 'winger';
    addNews(league, {
      category: 'rumor',
      headline: `Rumors circulate that the ${s.name} are shopping veteran ${role} ${fullName(v)}`,
      teamIds: [s.id],
      playerIds: [v.id],
      importance: 2,
    });
  });
}

function aiExtensions(league: League): void {
  for (const t of league.teams) {
    if (!isCpu(league, t.id)) continue;
    for (const p of extensionEligible(league, t.id)) {
      const age = league.season - p.birthYear;
      if (p.ca < 135 || age >= 33) continue;
      if (t.strategy === 'rebuild' && age >= 29) continue;
      if (willingness(league, p) < 0.55) continue;
      const ask = resignAsk(league, p);
      offerContract(league, p, ask.salary, ask.years);
    }
  }
}

function availableCoaches(league: League, role: Coach['role']): Coach[] {
  return Object.values(league.coaches).filter((c) => c.teamId === null && !c.retired && c.role === role);
}

export function hireCoach(league: League, team: Team, role: Coach['role']): Coach | null {
  const pool = availableCoaches(league, role).sort((a, b) => coachOverall(b) + b.reputation * 0.3 - (coachOverall(a) + a.reputation * 0.3));
  const c = pool[0];
  if (!c) return null;
  c.teamId = team.id;
  c.hiredSeason = league.season;
  c.contract = { salary: role === 'head' ? 1500 + Math.round(c.reputation * 30) : 600, years: 3 };
  if (role === 'head') team.staff.headCoach = c.id;
  else if (role === 'goalie') team.staff.goalieCoach = c.id;
  else team.staff.assistant = c.id;
  if (role === 'head') {
    const roster = playersOf(league, team.id);
    withRng(league, (rng) => (team.tactics = tacticsForRoster(c.philosophy, roster, c.ratings.tactics, rng)));
  }
  return c;
}

export function fireCoach(league: League, team: Team, reason: string): void {
  const id = team.staff.headCoach;
  if (id === null) return;
  const c = league.coaches[id];
  c.teamId = null;
  c.contract = null;
  c.reputation = clamp(c.reputation - 8, 0, 100);
  team.staff.headCoach = null;
  const replacement = hireCoach(league, team, 'head');
  addNews(league, {
    category: 'coach',
    headline: `${teamName(league, team.id)} fire head coach ${c.first} ${c.last}${replacement ? `; ${replacement.first} ${replacement.last} takes over` : ''}`,
    body: reason,
    teamIds: [team.id],
    playerIds: [],
    importance: 3,
  });
  addTransaction(league, { kind: 'coach', teamIds: [team.id], playerIds: [], description: `${teamName(league, team.id)} dismiss ${c.first} ${c.last}${replacement ? ` and hire ${replacement.first} ${replacement.last}` : ''}` });
}

function midseasonCoachReview(league: League): void {
  for (const t of league.teams) {
    if (t.id === league.userTeamId) continue;
    const r = league.standings[t.id];
    if (!r || r.gp < 25) continue;
    const pace = (points(r) / r.gp) * league.config.season.games;
    const expected = league.projections[t.id] ?? 92;
    const mem = league.aiMemory[t.id];
    if (pace < expected - 14) mem.coachHotSeat += 1;
    else mem.coachHotSeat = Math.max(0, mem.coachHotSeat - 1);
    if (mem.coachHotSeat >= 3) {
      const roll = withRng(league, (rng) => rng.next());
      if (roll < 0.35 + t.gm.aggression * 0.3) {
        fireCoach(league, t, `The team is on pace for ${Math.round(pace)} points against expectations of ${expected}.`);
        mem.coachHotSeat = 0;
      }
    }
  }
}

/** Offseason: decide contend / balanced / rebuild for every CPU team. */
export function updateStrategies(league: League): void {
  const rows = league.teams.map((t) => {
    const s = teamStrength(league, t.id, true);
    const roster = playersOf(league, t.id);
    const core = [...roster].sort((a, b) => b.ca - a.ca).slice(0, 10);
    const avgAge = core.reduce((x, p) => x + (league.season - p.birthYear), 0) / Math.max(1, core.length);
    return { t, s: s.overall, avgAge };
  });
  const sorted = [...rows].sort((a, b) => b.s - a.s);
  for (const r of rows) {
    if (r.t.id === league.userTeamId) continue;
    const rank = sorted.indexOf(r);
    const n = rows.length;
    const ph = r.t.gm.philosophy;
    const contendCut = ph === 'winNow' ? 0.4 : ph === 'youth' ? 0.2 : 0.3;
    const rebuildCut = ph === 'youth' ? 0.65 : ph === 'winNow' ? 0.85 : 0.75;
    const prev = r.t.strategy;
    if (rank < n * contendCut) r.t.strategy = 'contend';
    else if (rank >= n * rebuildCut || (r.avgAge >= 30.5 && rank >= n * 0.5)) r.t.strategy = 'rebuild';
    else r.t.strategy = 'balanced';
    if (prev !== r.t.strategy && (r.t.strategy === 'rebuild' || prev === 'rebuild')) {
      addNews(league, {
        category: 'league',
        headline: r.t.strategy === 'rebuild' ? `${teamName(league, r.t.id)} signal a rebuild` : `${teamName(league, r.t.id)} declare their rebuild over — time to compete`,
        teamIds: [r.t.id],
        playerIds: [],
        importance: 2,
      });
    }
  }
}

/** Offseason coaching carousel: underachievers make changes; contracts expire. */
export function offseasonCoaching(league: League): void {
  for (const c of Object.values(league.coaches)) {
    if (c.teamId === null || !c.contract) continue;
    c.contract.years--;
  }
  for (const t of league.teams) {
    if (t.id === league.userTeamId) continue;
    const r = league.standings[t.id];
    const hc = t.staff.headCoach !== null ? league.coaches[t.staff.headCoach] : undefined;
    if (!hc || !r) {
      if (!hc) hireCoach(league, t, 'head');
      continue;
    }
    const diff = points(r) - (league.projections[t.id] ?? 92);
    const tenure = league.season - (hc.hiredSeason ?? league.season);
    const missed = !league.playoffs?.seeds.some((s) => s.teamId === t.id);
    let pFire = 0;
    if (diff < -10) pFire += 0.45;
    if (missed && tenure >= 2) pFire += 0.25;
    if (hc.contract && hc.contract.years <= 0) pFire += 0.3;
    if (diff > 8) pFire -= 0.4;
    if (withRng(league, (rng) => rng.chance(clamp(pFire, 0, 0.9)))) fireCoach(league, t, missed ? 'The team missed the playoffs.' : 'Results fell short of expectations.');
    else if (hc.contract && hc.contract.years <= 0) hc.contract = { salary: hc.contract.salary + 200, years: 3 };
    if (t.staff.goalieCoach === null) hireCoach(league, t, 'goalie');
    if (t.staff.assistant === null) hireCoach(league, t, 'assistant');
  }
  // Coaches age out.
  for (const c of Object.values(league.coaches)) {
    const age = league.season - c.birthYear;
    if (c.teamId === null && age >= 68) c.retired = true;
  }
}

/** Preseason roster tidy-up for CPU teams. */
export function aiPreseason(league: League): void {
  for (let i = 0; i < 6; i++) {
    const t = findAiGoalieTrade(league) ?? (i < 3 ? findAiTrade(league) : null);
    if (t) executeTrade(league, t);
  }
  for (const t of league.teams) {
    if (isCpu(league, t.id)) {
      promoteReadyProspects(league, t.id);
      trimProspects(league, t.id);
    }
    trimRoster(league, t.id);
    if (isCpu(league, t.id)) enforceCap(league, t.id);
    ensureDressable(league, t.id);
    const roster = playersOf(league, t.id);
    if (t.autoLines || isCpu(league, t.id)) t.lines = autoLines(roster);
    if (isCpu(league, t.id)) {
      const hc = t.staff.headCoach !== null ? league.coaches[t.staff.headCoach] : undefined;
      if (hc) withRng(league, (rng) => (t.tactics = tacticsForRoster(hc.philosophy, roster, hc.ratings.tactics, rng)));
      const cap = [...roster].sort((a, b) => b.attrs.leadership + b.ca * 0.5 + (league.season - b.birthYear) * 2 - (a.attrs.leadership + a.ca * 0.5 + (league.season - a.birthYear) * 2));
      if (!t.captain || !roster.some((p) => p.id === t.captain)) t.captain = cap[0]?.id ?? null;
      t.alternates = cap.filter((p) => p.id !== t.captain).slice(0, 2).map((p) => p.id);
    }
  }
}

/** CPU teams occasionally call the user with trade offers; stale offers expire. */
function manageUserOffers(league: League, daysToDeadline: number): void {
  league.tradeOffers = league.tradeOffers.filter(
    (o) => o.season === league.season && league.day - o.day <= 6 && validateTrade(league, { from: o.from, to: league.userTeamId, give: o.give, get: o.get }).length === 0,
  );
  if (daysToDeadline < 0 || league.settings.autoManageUser || league.tradeOffers.length >= 3) return;
  const p = daysToDeadline <= 14 ? 0.18 : 0.06;
  if (!withRng(league, (rng) => rng.chance(p))) return;
  const found = findOfferForUser(league);
  if (!found) return;
  const id = league.nextId.tx++;
  league.tradeOffers.push({ id, from: found.proposal.from, give: found.proposal.give, get: found.proposal.get, day: league.day, season: league.season, note: found.note });
  addNews(league, { category: 'rumor', headline: found.note, teamIds: [found.proposal.from, league.userTeamId], playerIds: found.proposal.get.map((a) => a.id), importance: 3 });
}
