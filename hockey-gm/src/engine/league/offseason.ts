/**
 * Offseason flow:
 *   playoffs end → finishSeason (awards, careers, history, records, development,
 *   aging, retirements, coaching carousel, draft order) → 'draft'
 *   → 'resign' (expiring contracts, arbitration) → 'freeAgency' (FA days)
 *   → 'preseason' (new schedule, cap growth) → 'regular'
 */
import { clamp } from '../core/math';
import { Rng, seedFrom } from '../core/rng';
import { compactStatLine, emptyStatLine, points as statPoints } from '../core/statline';
import type { League, SeasonHistory } from '../types';
import { addNews, addTransaction, emptyRecord, isCpu, playersOf, points, teamName } from './helpers';
import { computeAwards, computePlayoffMvp, announceAwards } from './awards';
import { finalizeRecords } from './records';
import { playoffResultFor } from './playoffs';
import { standingRows } from './standings';
import { agePlayer, developPlayer, retirementChance } from '../player/development';
import { devContext } from './season';
import { runCombine } from '../economy/scouting';
import { prepareDraft, runDraftUntilUser, finishDraft } from '../economy/draft';
import { aiResign, startFreeAgency, processFADay, expiringPlayers } from '../economy/freeAgency';
import { generateDraftClass } from '../player/prospects';
import { generateSchedule } from './schedule';
import { aiPreseason, offseasonCoaching, updateStrategies } from '../ai/gm';
import { projectedPoints } from '../team/strength';
import { teamBudget } from '../economy/contracts';
import { expectedToiFor } from '../player/generate';
import { generateCoach } from '../team/coaching';
import { fullName } from '../player/ability';
import { trimRoster, ensureDressable } from '../economy/roster';
import { advanceContracts } from '../cba/contractService';
import { aiQualifyingDecisions, prepareExpiries } from '../cba/rfa';
import { processWaivers } from '../cba/waivers';
import { applyElcSlides, pruneLedger, settlePerformanceBonuses, thirtyFivePlusRetirement } from '../cba/capActions';
import { rulesFor } from '../cba/rules';
import { aiBuyouts } from '../ai/finance';

export function endRegularSeasonHooks(league: League): void {
  if (!league.draftCombineDone) runCombine(league);
}

function archiveCareers(league: League): void {
  for (const [idStr, e] of Object.entries(league.seasonStats)) {
    const p = league.players[Number(idStr)];
    if (!p) continue;
    if (e.reg.gp > 0) p.career.push({ season: league.season, teamId: e.teamId, playoffs: false, stats: compactStatLine(e.reg) });
    if (e.po.gp > 0) p.career.push({ season: league.season, teamId: e.teamId, playoffs: true, stats: compactStatLine(e.po) });
    if (e.reg.gp > 0) p.proSeasons++;
    // Playoff reputation: small, slow-moving, based on playoff production vs. regular season.
    if (e.po.gp >= 4) {
      const regRate = e.reg.gp ? statPoints(e.reg) / e.reg.gp : 0;
      const poRate = statPoints(e.po) / e.po.gp;
      const g = p.pos === 'G' ? (e.po.gxga - e.po.ga) / e.po.gp : poRate - regRate;
      p.playoffRep = clamp(p.playoffRep * 0.8 + clamp(g, -0.6, 0.6) * 0.3, -1, 1);
    }
  }
}

function seasonLeaders(league: League): SeasonHistory['leaders'] {
  const rows = Object.entries(league.seasonStats).map(([id, e]) => ({ id: Number(id), s: e.reg }));
  const top = (cat: string, f: (s: (typeof rows)[number]['s']) => number, filter: (r: (typeof rows)[number]) => boolean = () => true) => {
    const r = rows.filter(filter).sort((a, b) => f(b.s) - f(a.s))[0];
    return r ? { cat, playerId: r.id, value: Math.round(f(r.s) * 1000) / 1000 } : null;
  };
  return [
    top('Points', (s) => statPoints(s)),
    top('Goals', (s) => s.g),
    top('Assists', (s) => s.a1 + s.a2),
    top('Plus/Minus', (s) => s.pm),
    top('Wins', (s) => s.w),
    top('Save %', (s) => (s.sa ? (s.sa - s.ga) / s.sa : 0), (r) => r.s.gp >= 30 && league.players[r.id]?.pos === 'G'),
    top('Shutouts', (s) => s.so),
  ].filter((x): x is NonNullable<typeof x> => !!x);
}

function recordHistory(league: League, awards: SeasonHistory['awards']): void {
  const b = league.playoffs;
  const final = b?.rounds[b.rounds.length - 1]?.[0];
  const rows = standingRows(league);
  league.history.push({
    season: league.season,
    champion: b?.champion ?? null,
    runnerUp: final ? (final.winner === final.high ? final.low : final.high) : null,
    presidentsTrophy: rows[0]?.team.id ?? null,
    awards,
    standings: rows.map((r) => ({ teamId: r.team.id, w: r.rec.w, l: r.rec.l, otl: r.rec.otl, pts: r.pts, gf: r.rec.gf, ga: r.rec.ga, playoff: playoffResultFor(league, r.team.id) })),
    leaders: seasonLeaders(league),
  });
  for (const c of Object.values(league.coaches)) {
    if (c.teamId === null || c.role !== 'head') continue;
    const r = league.standings[c.teamId];
    if (r) c.career.push({ season: league.season, teamId: c.teamId, w: r.w, l: r.l, otl: r.otl, playoffs: playoffResultFor(league, c.teamId) });
  }
}

/** Rivalries intensify with playoff meetings and division battles. */
function updateRivalries(league: League): void {
  for (const t of league.teams) for (const k of Object.keys(t.rivals)) t.rivals[Number(k)] = Math.round(t.rivals[Number(k)] * 0.85);
  for (const r of league.playoffs?.rounds ?? [])
    for (const s of r) {
      const bump = 12 + s.round * 6 + (s.wins[0] + s.wins[1] >= 7 ? 8 : 0);
      const a = league.teams[s.high];
      const b = league.teams[s.low];
      a.rivals[b.id] = clamp((a.rivals[b.id] ?? 0) + bump, 0, 100);
      b.rivals[a.id] = clamp((b.rivals[a.id] ?? 0) + bump, 0, 100);
    }
  for (const t of league.teams)
    for (const o of league.teams) {
      if (t.id === o.id || t.divisionId !== o.divisionId) continue;
      t.rivals[o.id] = clamp((t.rivals[o.id] ?? 0) + 3, 0, 100);
    }
}

/** Called when the final series ends. */
export function finishSeason(league: League): void {
  const champ = league.playoffs?.champion;
  // Awards (regular season + playoffs).
  const awards = computeAwards(league);
  const mvp = computePlayoffMvp(league);
  if (mvp) awards.push(mvp);
  processWaivers(league, true);
  settlePerformanceBonuses(league);
  archiveCareers(league);
  announceAwards(league, awards);
  if (champ != null) {
    for (const p of playersOf(league, champ, ['active'])) {
      p.awards.push({ season: league.season, award: `${league.config.championship} Champion` });
      p.reputation = Math.min(100, p.reputation + 3);
    }
    const t = league.teams[champ];
    t.reputation = clamp(t.reputation + 8, 0, 100);
  }
  recordHistory(league, awards);
  finalizeRecords(league);
  updateRivalries(league);
  offseasonCoaching(league);
  yearlyDevelopment(league);
  retirements(league);
  prepareDraft(league);
}

/** Offseason development + aging, using the just-finished season as context. */
export function yearlyDevelopment(league: League): void {
  const next = league.season + 1;
  const breakouts: { id: number; delta: number }[] = [];
  for (const p of Object.values(league.players)) {
    if (p.status === 'retired') continue;
    const before = p.ca;
    if (p.status === 'active' || p.status === 'prospect') (p.caHistory ??= []).push([league.season, p.ca]);
    const ctx = devContext(league, p, 0.62);
    if (p.status === 'draft' || p.status === 'fa') {
      ctx.minors = true;
      ctx.environment = p.status === 'draft' ? 0.95 : 0.85;
    }
    developPlayer(p, { ...ctx, season: next });
    agePlayer(p, next, league.seed);
    const delta = p.ca - before;
    if (p.status === 'active' || p.status === 'prospect') breakouts.push({ id: p.id, delta });
    p.expectedToi = expectedToiFor(p);
  }
  breakouts.sort((a, b) => b.delta - a.delta);
  for (const b of breakouts.slice(0, 3)) {
    const p = league.players[b.id];
    if (b.delta >= 8 && (p.teamId === league.userTeamId || p.reputation >= 30)) {
      addNews(league, { category: 'development', headline: `${fullName(p)} (${league.teams[p.teamId!]?.abbr ?? 'FA'}) makes a big leap over the summer`, teamIds: p.teamId !== null ? [p.teamId] : [], playerIds: [p.id], importance: 2 });
    }
  }
}

export function retirements(league: League): void {
  const rng = new Rng(seedFrom(league.seed, 'retire', league.season));
  for (const p of Object.values(league.players)) {
    if (p.status === 'retired' || p.status === 'draft') continue;
    if (p.status === 'prospect' && league.season - p.birthYear < 24) continue;
    // Unsigned depth free agents drift out of the league (Europe, minors, retirement).
    const faAge = league.season - p.birthYear;
    if (p.status === 'fa' && p.ca < 112 && (faAge >= 23 || (faAge >= 21 && p.pa < 125)) && rng.chance(0.7)) {
      if (p.career.reduce((s, c) => s + c.stats.gp, 0) < 40) {
        delete league.players[p.id];
        delete league.scouting.knowledge[p.id];
        continue;
      }
    }
    if (!rng.chance(retirementChance(p, league.season + 1))) continue;
    const tid = p.teamId;
    // A 35+ contract stays on the books after retirement.
    if (p.contract && tid !== null) thirtyFivePlusRetirement(league, p, league.season);
    p.status = 'retired';
    p.ltir = false;
    p.retiredSeason = league.season;
    p.teamId = null;
    p.contract = null;
    p.injury = null;
    const games = p.career.filter((c) => !c.playoffs).reduce((s, c) => s + c.stats.gp, 0);
    const pts = p.career.filter((c) => !c.playoffs).reduce((s, c) => s + statPoints(c.stats), 0);
    if (games >= 300 || p.reputation >= 55) {
      addNews(league, {
        category: 'retirement',
        headline: `${fullName(p)} announces his retirement after ${p.proSeasons} seasons${p.pos !== 'G' ? ` (${pts} points in ${games} games)` : ''}`,
        teamIds: tid !== null ? [tid] : [],
        playerIds: [p.id],
        importance: games >= 800 ? 4 : 2,
      });
    }
    if (tid !== null) addTransaction(league, { kind: 'retirement', teamIds: [tid], playerIds: [p.id], description: `${fullName(p)} retires` });
  }
}

/** Contract years tick down once the season is over; extensions kick in. */
function rollContracts(league: League): void {
  for (const p of applyElcSlides(league, league.season))
    if (p.teamId === league.userTeamId) addNews(league, { category: 'signing', headline: `${fullName(p)}'s entry-level contract slides a year (fewer than 10 NHL games at age ${league.season - p.birthYear})`, teamIds: [p.teamId], playerIds: [p.id], importance: 1 });
  advanceContracts(league, league.season + 1);
}

/** Draft finished → begin re-signing period. */
export function startResignPhase(league: League): void {
  finishDraft(league);
  rollContracts(league);
  league.phase = 'resign';
  league.offseasonStep = 'qualifyingOffers';
  // Classify expiring contracts and build the qualifying-offer list.
  prepareExpiries(league);
  aiBuyouts(league);
  for (const t of league.teams) {
    if (!isCpu(league, t.id)) continue;
    aiResign(league, t.id);
    aiQualifyingDecisions(league, t.id);
  }
  const mine = expiringPlayers(league, league.userTeamId);
  if (mine.length) {
    addNews(league, { category: 'signing', headline: `${mine.length} of your players have expiring contracts — re-sign them before free agency opens`, teamIds: [league.userTeamId], playerIds: mine.map((p) => p.id), importance: 3 });
  }
}

/** Start the next season: schedule, cap growth, resets. */
export function startNewSeason(league: League): void {
  league.season++;
  const cfg = league.config;
  const capRules = rulesFor(league.season);
  league.cap = { upper: capRules.upperLimit, floor: capRules.lowerLimit, minSalary: capRules.minimumSalary };
  pruneLedger(league);
  for (const t of league.teams) t.budget = teamBudget(t, league.cap.upper);
  const rng = new Rng(league.rng);
  league.schedule = generateSchedule(league.teams, cfg, rng, league.nextId.game);
  league.nextId.game += league.schedule.length;
  league.rng = rng.state();
  const lastDay = league.schedule.reduce((m, g) => Math.max(m, g.day), 0);
  league.tradeDeadlineDay = Math.floor(lastDay * cfg.season.tradeDeadlineFraction);
  league.standings = Object.fromEntries(league.teams.map((t) => [t.id, emptyRecord()]));
  league.seasonStats = {};
  for (const p of Object.values(league.players)) {
    if ((p.status === 'active' || p.status === 'prospect') && p.teamId !== null) league.seasonStats[p.id] = { reg: emptyStatLine(), po: emptyStatLine(), teamId: p.teamId };
    p.streak = { points: 0, goalless: 0, bestPoints: 0 };
    p.seasonToiMin = 0;
    p.fatigue = 0;
    p.form = p.form * 0.3;
    p.confidence = p.confidence * 0.5;
    p.caSeasonStart = p.ca;
    if (p.injury) {
      p.injury.daysRemaining -= 110;
      if (p.injury.daysRemaining <= 0) p.injury = null;
    }
    p.morale = clamp(p.morale * 0.6 + 65 * 0.4, 0, 100);
  }
  league.playoffs = null;
  league.day = 0;
  league.draftCombineDone = false;
  league.faOffers = [];
  // New draft class for this season's draft, plus picks three years out.
  const classSize = cfg.teams.length * cfg.draft.rounds + 40;
  const dRng = new Rng(seedFrom(league.seed, 'draftclass', league.season));
  for (const p of generateDraftClass(dRng, () => league.nextId.player++, league.season, classSize)) league.players[p.id] = p;
  for (const t of league.teams)
    for (let r = 1; r <= cfg.draft.rounds; r++)
      if (!league.draftPicks.some((d) => d.season === league.season + 2 && d.round === r && d.originalTeamId === t.id))
        league.draftPicks.push({ id: league.nextId.pick++, season: league.season + 2, round: r, originalTeamId: t.id, ownerId: t.id });
  // Keep the coaching pool stocked.
  const unemployed = Object.values(league.coaches).filter((c) => c.teamId === null && !c.retired).length;
  for (let i = unemployed; i < 16; i++) {
    const c = generateCoach(dRng, league.nextId.coach++, league.season, clamp(dRng.normal(95, 18), 50, 160), dRng.chance(0.7) ? 'head' : dRng.chance(0.5) ? 'goalie' : 'assistant');
    league.coaches[c.id] = c;
  }
  // Prune chemistry for pairs who are no longer teammates; decay the rest.
  const teamOf = new Map(Object.values(league.players).map((p) => [p.id, p.teamId]));
  for (const k of Object.keys(league.chemistry)) {
    const [a, b] = k.split('-').map(Number);
    if (teamOf.get(a) == null || teamOf.get(a) !== teamOf.get(b)) delete league.chemistry[k];
    else league.chemistry[k] *= 0.7;
  }
  // Purge long-retired players with negligible careers to keep saves small.
  for (const p of Object.values(league.players)) {
    if (p.status === 'retired' && (p.retiredSeason ?? 0) < league.season - 1 && p.career.reduce((s, c) => s + c.stats.gp, 0) < 40 && !p.awards.length) {
      delete league.players[p.id];
      delete league.scouting.knowledge[p.id];
    }
  }
  updateStrategies(league);
  aiPreseason(league);
  league.projections = Object.fromEntries(league.teams.map((t) => [t.id, projectedPoints(league, t.id)]));
  league.ratingBaseline = ratingBaselineFor(league);
  league.phase = 'preseason';
  addNews(league, { category: 'league', headline: `The ${league.season}-${(league.season + 1) % 100} season is set to begin. Salary cap: $${(league.cap.upper / 1000).toFixed(1)}M`, teamIds: [], playerIds: [], importance: 3 });
}

export function startRegularSeason(league: League): void {
  if (league.phase !== 'preseason') return;
  processWaivers(league, true);
  for (const t of league.teams) {
    trimRoster(league, t.id);
    ensureDressable(league, t.id);
    // Filling a positional hole can push the roster back over the limit.
    trimRoster(league, t.id);
  }
  league.phase = 'regular';
}

/**
 * Move to the next offseason phase. With `auto`, the user's decisions are made
 * by the AI as well (used for fast-forwarding and validation runs).
 */
export function advanceOffseason(league: League, auto = false): void {
  switch (league.phase) {
    case 'draft': {
      const done = runDraftUntilUser(league, auto);
      if (done) startResignPhase(league);
      break;
    }
    case 'resign':
      if (auto) {
        aiResign(league, league.userTeamId);
        aiQualifyingDecisions(league, league.userTeamId);
      }
      startFreeAgency(league);
      break;
    case 'freeAgency': {
      let done = false;
      if (auto) while (!done) done = processFADay(league);
      else done = processFADay(league);
      if (done) startNewSeason(league);
      break;
    }
    case 'preseason':
      startRegularSeason(league);
      break;
    default:
      break;
  }
}

/** Run the entire offseason with AI decisions for everyone. */
export function simOffseason(league: League): void {
  let guard = 0;
  while (league.phase !== 'regular' && guard++ < 100) advanceOffseason(league, true);
}

export { teamName, points };

/** Reference talent level of a freshly generated league (average CA of the top 400 skaters). */
export const REFERENCE_TALENT = 142.5;

export function ratingBaselineFor(league: League): number {
  const top = Object.values(league.players)
    .filter((p) => p.status === 'active' && p.pos !== 'G')
    .map((p) => p.ca)
    .sort((a, b) => b - a)
    .slice(0, 400);
  if (top.length < 100) return 120;
  const avg = top.reduce((a, b) => a + b, 0) / top.length;
  return 120 + (avg - REFERENCE_TALENT) * 0.9;
}
