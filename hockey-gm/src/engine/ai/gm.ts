/**
 * CPU front offices. The league keeps living without the user: teams trade,
 * extend players, call up prospects, fire and hire coaches, and shift between
 * contending and rebuilding.
 */
import { clamp } from '../core/math';
import type { League } from '../types';
import { addNews, isCpu, playersOf, teamName, withRng, points } from '../league/helpers';
import { enforceCap, ensureDressable, promoteReadyProspects, trimProspects, trimRoster } from '../economy/roster';
import { executeTrade, findAiGoalieTrade, validateTrade } from '../economy/trade';
import { marketDay, offerForUser, offseasonMarket, tradeBlock } from './tradeMarket';
import { publishCentralRankings, weeklyScouting } from '../economy/scouting';

/** Schedule day of the Central Scouting midterm rankings (about January 15). */
const CS_MIDTERM_DAY = 99;
import { teamStrength } from '../team/strength';
import { tacticsForRoster } from '../team/coaching';
import { coachOf, extensionAsk, fireHeadCoach, hireBest, releaseCoach } from '../team/staffMarket';
import { demandedExtras, extensionEligible, offerContract, resignAsk, willingness } from '../economy/freeAgency';
import { autoLines } from '../team/lines';
import { fullName } from '../player/ability';
import { aiCapHousekeeping } from './finance';
import { holdoutDay } from '../cba/holdouts';
import { startNegotiation } from '../cba/negotiation';
import { fitNorm } from '../team/fit';
import { ownerWeekly, setOwnerGoals } from '../front/owner';
import { recordDeadlineEvent } from '../league/deadline';

export function aiDaily(league: League): void {
  // Older saves (or a new job mid-season) get this season's owner goals.
  if (league.phase === 'regular' && league.owner?.season !== league.season) setOwnerGoals(league);
  if (league.phase === 'regular' && league.day % 7 === 0) ownerWeekly(league);
  holdoutDay(league);
  for (const t of league.teams) ensureDressable(league, t.id);
  if (league.day % 7 === 3) weeklyScouting(league);
  // Mid-January: Central Scouting's midterm rankings.
  if (league.phase === 'regular' && league.day === CS_MIDTERM_DAY) publishCentralRankings(league, 'midterm');
  if (league.phase !== 'regular') return;
  if (league.day % 7 === 1) aiCapHousekeeping(league);
  const daysToDeadline = league.tradeDeadlineDay - league.day;
  if (daysToDeadline >= 0) {
    marketDay(league);
    if (daysToDeadline <= 14 && league.day % 4 === 0) maybeRumor(league);
  }
  if (daysToDeadline === 0) remindExpiringCoaches(league);
  if (daysToDeadline === 0) {
    recordDeadlineEvent(league, 'close', 'The trade deadline has passed. Rosters are set for the stretch run.', []);
    addNews(league, { category: 'league', headline: 'Trade deadline passes — rosters are set for the stretch run', teamIds: [], playerIds: [], importance: 3 });
  }
  if (league.day > 30 && league.day % 15 === 0) midseasonCoachReview(league);
  manageUserOffers(league, daysToDeadline);
  if (league.day % 30 === 15) aiExtensions(league);
}

/** Remind the GM which staff contracts run out after the season (they can be extended until then). */
function remindExpiringCoaches(league: League): void {
  if (league.settings.autoManageUser) return;
  const t = league.teams[league.userTeamId];
  const names = (['headCoach', 'assistant', 'goalieCoach'] as const)
    .map((s) => coachOf(league, t, s))
    .filter((c) => c?.contract && c.contract.years <= 1 && !c.interim)
    .map((c) => `${c!.first} ${c!.last}`);
  if (names.length) addNews(league, { category: 'coach', headline: `Contracts expiring after this season: ${names.join(', ')}. Extend them on the Coaching Staff page or they will leave.`, teamIds: [t.id], playerIds: [], importance: 3 });
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
    recordDeadlineEvent(league, 'rumor', `The ${s.name} are shopping veteran ${role} ${fullName(v)}`, [s.id], [v.id]);
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
      // CPU clubs meet the agent's demand when it's within reach of what the player is worth to them.
      const ask = resignAsk(league, p);
      const demand = startNegotiation(league, p, t.id).demand;
      if (demand.aav > ask.salary * 1.12) continue;
      offerContract(league, p, demand.aav, demand.years, demandedExtras(league, p, t.id));
    }
  }
}

function midseasonCoachReview(league: League): void {
  for (const t of league.teams) {
    if (t.id === league.userTeamId) continue;
    if (t.staff.assistant === null) hireBest(league, t, 'assistant');
    if (t.staff.headCoach === null) hireBest(league, t, 'head');
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
        // Most clubs promote an assistant on an interim basis; some go straight to the market.
        const interim = withRng(league, (rng) => rng.chance(0.6));
        fireHeadCoach(league, t, `The team is on pace for ${Math.round(pace)} points against expectations of ${expected}.`, { interim });
        mem.coachHotSeat = 0;
      }
    }
  }
}

/** Offseason: decide contend / balanced / rebuild for every CPU team. */
export function updateStrategies(league: League, quiet = false): void {
  const rows = league.teams.map((t) => {
    const s = teamStrength(league, t.id, true);
    const roster = playersOf(league, t.id);
    const core = [...roster].sort((a, b) => b.ca - a.ca).slice(0, 10);
    const avgAge = core.reduce((x, p) => x + (league.season - p.birthYear), 0) / Math.max(1, core.length);
    // A franchise player in his prime keeps a team out of a teardown.
    const franchise = roster.some((p) => p.ca >= 170 && league.season - p.birthYear <= 31);
    return { t, s: s.overall, avgAge, franchise };
  });
  const sorted = [...rows].sort((a, b) => b.s - a.s);
  const leagueAge = rows.reduce((x, r) => x + r.avgAge, 0) / Math.max(1, rows.length);
  for (const r of rows) {
    if (r.t.id === league.userTeamId) continue;
    const rank = sorted.indexOf(r);
    const n = rows.length;
    const ph = r.t.gm.philosophy;
    const contendCut = ph === 'winNow' ? 0.4 : ph === 'youth' ? 0.2 : 0.3;
    const rebuildCut = ph === 'youth' ? 0.7 : ph === 'winNow' ? 0.88 : 0.8;
    const prev = r.t.strategy;
    if (rank < n * contendCut) r.t.strategy = 'contend';
    else if (!r.franchise && (rank >= n * rebuildCut || (r.avgAge >= leagueAge + 2 && rank >= n * 0.6))) r.t.strategy = 'rebuild';
    else r.t.strategy = 'balanced';
    if (!quiet && prev !== r.t.strategy && (r.t.strategy === 'rebuild' || prev === 'rebuild')) {
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
    const user = t.id === league.userTeamId && !league.settings.autoManageUser;
    // Expired deals: CPU clubs decide below; the user's coaches leave unless extended.
    for (const slot of ['headCoach', 'assistant', 'goalieCoach'] as const) {
      const c = coachOf(league, t, slot);
      if (!c?.contract || c.contract.years > 0) continue;
      if (user || slot !== 'headCoach') {
        if (!user && withRng(league, (rng) => rng.chance(0.75))) {
          c.contract = { ...extensionAsk(league, c), years: 2 };
          continue;
        }
        releaseCoach(league, t, slot, false);
        addNews(league, { category: 'coach', headline: `${c.first} ${c.last}'s contract with the ${teamName(league, t.id)} expires; he is free to join another club`, teamIds: [t.id], playerIds: [], importance: user ? 3 : 1 });
      }
    }
    if (t.id === league.userTeamId) continue;
    const r = league.standings[t.id];
    const hc = coachOf(league, t, 'headCoach');
    if (!hc || !r) {
      if (!hc) hireBest(league, t, 'head');
    } else {
      const diff = points(r) - (league.projections[t.id] ?? 92);
      const tenure = league.season - (hc.hiredSeason ?? league.season);
      const missed = !league.playoffs?.seeds.some((s) => s.teamId === t.id);
      let pFire = 0;
      if (diff < -10) pFire += 0.45;
      if (missed && tenure >= 2) pFire += 0.25;
      if (hc.contract && hc.contract.years <= 0) pFire += 0.3;
      if (hc.interim) pFire += diff > 5 ? 0.1 : 0.6;
      if (diff > 8) pFire -= 0.4;
      if (withRng(league, (rng) => rng.chance(clamp(pFire, 0, 0.9)))) {
        if (hc.interim) {
          releaseCoach(league, t, 'headCoach', false);
          hireBest(league, t, 'head');
        } else fireHeadCoach(league, t, missed ? 'The team missed the playoffs.' : 'Results fell short of expectations.', { interim: false });
      } else if (hc.interim || (hc.contract && hc.contract.years <= 0)) {
        hc.interim = undefined;
        hc.contract = { ...extensionAsk(league, hc), years: 3 };
      }
    }
    if (t.staff.goalieCoach === null) hireBest(league, t, 'goalie');
    if (t.staff.assistant === null) hireBest(league, t, 'assistant');
  }
  // Coaches age out.
  for (const c of Object.values(league.coaches)) {
    const age = league.season - c.birthYear;
    if (c.teamId === null && (age >= 70 || (age >= 64 && withRng(league, (rng) => rng.chance(0.25))))) c.retired = true;
  }
}

/** Preseason roster tidy-up for CPU teams. */
export function aiPreseason(league: League): void {
  // Training-camp trades: goalie fixes first (a team without a starter), then the open market.
  for (let i = 0; i < 2; i++) {
    const t = findAiGoalieTrade(league);
    if (t) executeTrade(league, t);
  }
  offseasonMarket(league, 8);
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
    // A club can't open the season without a head coach: the owner fills an empty bench.
    if (t.staff.headCoach === null) {
      const c = hireBest(league, t, 'head');
      if (c && t.id === league.userTeamId) addNews(league, { category: 'coach', headline: `With the bench still empty, ownership hires ${c.first} ${c.last} as head coach`, teamIds: [t.id], playerIds: [], importance: 3 });
    }
    // Every head coach (the user's included) sets his team's systems for the season.
    const hc = t.staff.headCoach !== null ? league.coaches[t.staff.headCoach] : undefined;
    if (hc) withRng(league, (rng) => (t.tactics = tacticsForRoster(hc.philosophy, roster, hc.ratings.tactics, rng, t.lines, hc.system, fitNorm(league))));
    if (isCpu(league, t.id)) {
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
  // The phone rings most in the final days: up to four offers at once.
  const maxOffers = daysToDeadline <= 1 ? 4 : 3;
  if (daysToDeadline < 0 || league.settings.autoManageUser || league.tradeOffers.length >= maxOffers) return;
  let p = daysToDeadline <= 1 ? 0.75 : daysToDeadline <= 3 ? 0.45 : daysToDeadline <= 14 ? 0.28 : league.day < 15 ? 0.04 : 0.1;
  // Shopping players gets the phone ringing.
  if (tradeBlock(league).length) p = Math.max(p, 0.3);
  if (!withRng(league, (rng) => rng.chance(p))) return;
  const found = offerForUser(league);
  if (!found) return;
  const id = league.nextId.tx++;
  league.tradeOffers.push({ id, from: found.proposal.from, give: found.proposal.give, get: found.proposal.get, day: league.day, season: league.season, note: found.note });
  addNews(league, { category: 'rumor', headline: found.note, teamIds: [found.proposal.from, league.userTeamId], playerIds: found.proposal.get.map((a) => a.id), importance: 3 });
  recordDeadlineEvent(league, 'call', `${league.teams[found.proposal.from].city} called: ${found.note}`, [found.proposal.from, league.userTeamId], found.proposal.get.map((a) => a.id));
}
