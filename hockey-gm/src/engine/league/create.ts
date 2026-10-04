import { Rng } from '../core/rng';
import { clamp } from '../core/math';
import { emptyStatLine } from '../core/statline';
import { DEFAULT_CONFIG, conferenceOfDivision, validateConfig, type LeagueConfig } from '../data/leagueConfig';
import { GM_FIRST, NAME_POOLS, OWNER_NAMES } from '../data/names';
import type { Coach, GmPhilosophy, League, Player, Position, Scout, Team } from '../types';
import { generatePlayer } from '../player/generate';
import { generateProspect } from '../player/prospects';
import { autoLines, emptyLines } from '../team/lines';
import { generateCoach, tacticsForRoster, DEFAULT_TACTICS } from '../team/coaching';
import { marketValue, typicalTerm, teamBudget } from '../economy/contracts';
import { rulesFor, STATIC } from '../cba/rules';
import { contractDbInfo, emptyFinancialState, estimateContract, estimateFirstSpcAge, estimatePriorExperience, importedDeadCap, importedPlayer, importedPlayers, parseBorn, playerContractsFromImport, type ImportedPlayer } from '../cba/import';
import { placeOnLTIR } from '../cba/capActions';
import { fitNormFrom, regulars } from '../team/fit';
import { teamCapSheet } from '../cba/capManager';
import { scaleContract, yearsOf, aav, termOf, totalValue, endOf } from '../cba/contract';
import { determineFreeAgentStatus } from '../cba/rulesEngine';
import { generateSchedule } from './schedule';
import { updateStrategies } from '../ai/gm';
import { applyRealPickOwnership, buildRealReserves, draftDataInfo } from './realDraft';
import { buildRealDraftClass, isReentryClass } from './realDraftClass';
import { emptyRecord } from './helpers';
import { projectedPoints } from '../team/strength';
import { buildRealPlayers, snapshotHasRosters } from '../data/nhl/realPlayers';
import type { NhlSnapshot } from '../data/nhl/types';
import { COACH_PROFILES, COACH_QUALITY, NHL_GMS, splitName } from '../data/nhl/staff';
import NHL_SNAPSHOT from '../data/nhl/rosters.json';

/**
 * Opening-day roster housekeeping for real rosters: clubs over the cap use
 * LTIR on their injured players (as NHL teams do), and active rosters are
 * trimmed to the limit by assigning the lowest-rated healthy depth players.
 */
function openingDayCompliance(league: League): void {
  const r = rulesFor(league.season);
  for (const t of league.teams) {
    const roster = () => Object.values(league.players).filter((p) => p.teamId === t.id && p.status === 'active');
    for (const p of roster().filter((x) => x.injury && !x.ltir).sort((a, b) => (b.contract?.salary ?? 0) - (a.contract?.salary ?? 0))) {
      const sheet = teamCapSheet(league, t.id);
      if (sheet.total <= sheet.effectiveLimit) break;
      placeOnLTIR(league, p);
    }
    // Still over: assign the lowest-rated depth player whose buried relief clears the overage.
    for (let guard = 0; guard < 4; guard++) {
      const sheet = teamCapSheet(league, t.id);
      const over = sheet.total - sheet.effectiveLimit;
      if (over <= 0) break;
      const relief = (p: Player) => Math.min(p.contract?.salary ?? 0, r.minimumSalary + r.buriedAllowance);
      const cand = roster()
        .filter((p) => !p.injury && p.contract && !p.contract.thirtyFivePlus && !(p.contract.clauses ?? []).some((c) => c.kind === 'NMC') && p.pos !== 'G')
        .sort((a, b) => (relief(b) >= over ? 1 : 0) - (relief(a) >= over ? 1 : 0) || a.ca - b.ca)[0];
      if (!cand) break;
      cand.status = 'prospect';
    }
    const counting = () => roster().filter((p) => !p.ltir && !(p.injury && p.injury.daysRemaining >= r.injuryReserveDays));
    for (let guard = 0; counting().length > r.rosterMax && guard < 10; guard++) {
      const healthy = counting();
      const g = (x: Player) => (x.pos === 'G' ? 'G' : x.pos === 'D' ? 'D' : 'F');
      const n = { F: healthy.filter((x) => g(x) === 'F').length, D: healthy.filter((x) => g(x) === 'D').length, G: healthy.filter((x) => g(x) === 'G').length };
      const spare = healthy.filter((x) => (g(x) === 'G' ? n.G > 2 : g(x) === 'D' ? n.D > 7 : n.F > 13)).sort((a, b) => (a.contract?.source === 'estimated' ? -1 : 0) - (b.contract?.source === 'estimated' ? -1 : 0) || a.ca - b.ca)[0];
      if (!spare) break;
      spare.status = 'prospect';
    }
  }
}

export interface CreateLeagueOptions {
  seed?: string;
  season?: number;
  userTeamId?: number;
  config?: LeagueConfig;
  /** Real roster snapshot to use; `false` forces generated rosters. Defaults to the bundled NHL snapshot. */
  rosters?: NhlSnapshot | false;
}

/** Active roster shape taken from a real roster (the rest go to the minors / system). */
const REAL_ACTIVE = { F: 14, D: 7, G: 2 };

/** Contract-database statuses that mean the player starts outside the NHL roster. */
const MINOR_STATUSES = new Set(['Minor', 'Junior', 'Loan', 'Inactive', 'PTO']);

export const SAVE_VERSION = 2;

const AGE_WEIGHTS: [number, number][] = [
  [19, 0.6], [20, 2.5], [21, 4.5], [22, 6.5], [23, 8], [24, 9], [25, 9], [26, 9], [27, 9], [28, 8], [29, 7.5], [30, 7],
  [31, 6], [32, 5], [33, 4], [34, 3], [35, 2], [36, 1.2], [37, 0.6], [38, 0.3],
];

const F_SLOTS = [160, 151, 146, 141, 137, 133, 129, 126, 123, 120, 117, 114, 110, 106];
const D_SLOTS = [155, 146, 139, 133, 127, 121, 112];
const G_SLOTS = [148, 124];

function pickAge(rng: Rng, targetCA: number): number {
  // Very young players rarely start near the top of a lineup; adjust weights.
  const w = AGE_WEIGHTS.map(([a, x]) => {
    let m = x;
    if (a <= 21 && targetCA > 150) m *= 0.45;
    if (a >= 35 && targetCA > 150) m *= 0.5;
    return m;
  });
  return AGE_WEIGHTS[rng.weightedIndex(w)][0];
}

function forwardPositions(rng: Rng, n: number): Position[] {
  const out: Position[] = [];
  for (let i = 0; i < n; i++) out.push(i % 14 < 5 ? 'C' : i % 2 === 0 ? 'LW' : 'RW');
  return rng.shuffle(out);
}

export function createLeague(opts: CreateLeagueOptions = {}): League {
  const cfg = opts.config ?? DEFAULT_CONFIG;
  validateConfig(cfg);
  const seed = opts.seed ?? `nhl-${Date.now()}`;
  const season = opts.season ?? 2026;
  const rng = new Rng(seed);
  const ids = { player: 1, coach: 1, news: 1, game: 1, tx: 1, pick: 1, scout: 1 };
  const players: Record<number, Player> = {};
  const coaches: Record<number, Coach> = {};

  const teams: Team[] = cfg.teams.map((seedT, idx) => {
    const ph: GmPhilosophy = rng.pick(['winNow', 'youth', 'analytics', 'oldSchool', 'balanced', 'balanced']);
    const pool = rng.weighted(NAME_POOLS.slice(0, 4), (p) => p.weight);
    const t: Team = {
      id: idx,
      abbr: seedT.abbr,
      city: seedT.city,
      name: seedT.name,
      arena: seedT.arena,
      conferenceId: conferenceOfDivision(cfg, seedT.divisionId),
      divisionId: seedT.divisionId,
      colors: seedT.colors,
      logo: seedT.logo,
      marketSize: seedT.marketSize,
      appeal: seedT.appeal,
      budget: 0,
      reputation: Math.round(clamp(40 + seedT.marketSize * 6 + rng.normal(0, 10), 15, 90)),
      facilities: Math.round(clamp(100 + seedT.marketSize * 10 + rng.normal(0, 22), 50, 190)),
      strategy: 'balanced',
      gm: { name: `${rng.pick(GM_FIRST)} ${rng.pick(pool.last)}`, philosophy: ph, aggression: clamp(rng.normal(0.5, 0.18), 0.1, 0.95) },
      owner: rng.pick(OWNER_NAMES),
      staff: { headCoach: null, assistant: null, goalieCoach: null },
      lines: emptyLines(),
      autoLines: true,
      tactics: { ...DEFAULT_TACTICS },
      captain: null,
      alternates: [],
      morale: 60,
      rivals: {},
    };
    t.budget = teamBudget(t, cfg.economics.salaryCap);
    return t;
  });

  const capRules = rulesFor(season);
  const cap = { upper: capRules.upperLimit, floor: capRules.lowerLimit, minSalary: capRules.minimumSalary };
  let contractIds = 1;
  const valueCtx = { season, cap };

  const addPlayer = (p: Player) => {
    players[p.id] = p;
    return p;
  };

  const snap = opts.rosters === undefined ? (NHL_SNAPSHOT as NhlSnapshot) : opts.rosters;
  const abbrs = teams.map((t) => t.abbr);
  const real = snap && snapshotHasRosters(snap, abbrs) ? buildRealPlayers(rng, snap, abbrs, season, () => ids.player++) : null;

  const hasReserves = !!real && draftDataInfo().prospects > 0;
  const realIds = new Set<number>();
  if (real) for (const list of real.values()) for (const p of list) if (p.nhlId !== undefined) realIds.add(p.nhlId);
  const ltirAtStart: Player[] = [];
  /** Injured-reserve statuses from the contract database become injuries (LTIR players are placed on LTIR once the league exists). */
  const markInjury = (p: Player, st: string) => {
    const days = st === 'LTIR' || st === 'SEIR' ? 300 : st === 'SOIR' ? 30 : st === 'IR' ? 21 : 0;
    if (!days) return;
    p.injury = { type: 'Undisclosed injury', bodyPart: 'other', severity: days >= 60 ? 'severe' : 'moderate', daysRemaining: days, totalDays: days, season, dayInjured: 0 };
    if (st === 'LTIR' || st === 'SEIR') ltirAtStart.push(p);
  };
  /** Build a player who is under contract in the database but not in the roster feed. Ratings are estimated from his contract and experience. */
  const playerFromImport = (rec: ImportedPlayer, teamId: number): Player | null => {
    const born = parseBorn(rec.born);
    const pos = (rec.pos === 'F' ? 'C' : rec.pos) as Position;
    if (!born || !['C', 'LW', 'RW', 'D', 'G'].includes(pos)) return null;
    const probe = { birthYear: born.year } as Player;
    const cur = playerContractsFromImport(rec, teams, season, probe).current;
    if (!cur) return null;
    const age = season - born.year;
    const hit = Math.max(cap.minSalary, cur.capHitOverride ?? cur.salary);
    const minors = MINOR_STATUSES.has(rec.status ?? '');
    const games = rec.careerGames ?? 0;
    const target = clamp(100 + 21.5 * Math.log(hit / 850) + Math.min(8, games / 60) - (minors ? 4 : 0), 88, 165);
    const p = generatePlayer(rng, { id: ids.player++, pos, targetCA: Math.round(target), age, season, nat: rec.nationality ?? undefined });
    const [first, ...rest] = rec.name.split(' ');
    p.first = first;
    p.last = rest.join(' ') || first;
    p.birthYear = born.year;
    p.nhlId = rec.nhlId;
    if (rec.number) p.number = rec.number;
    if (rec.shoots === 'L' || rec.shoots === 'R') p.shoots = rec.shoots;
    p.headshot = `https://assets.nhle.com/mugs/nhl/latest/${rec.nhlId}.png`;
    if (age <= 23) p.pa = Math.max(p.pa, Math.min(195, p.ca + Math.round(rng.float(8, 30))));
    p.proSeasons = Math.max(0, season - (rec.firstSpcSeason ?? season - Math.max(0, age - 21)));
    p.teamId = teamId;
    p.status = minors ? 'prospect' : 'active';
    markInjury(p, rec.status ?? '');
    return p;
  };

  /** Contract for a player already in the league: real (imported) if available, otherwise an estimate. */
  const signContract = (p: Player, teamId: number) => {
    const age = season - p.birthYear;
    if (p.nhlGamesBefore === undefined) {
      const exp = estimatePriorExperience(p, season);
      p.nhlGamesBefore = exp.games;
      p.accruedBefore = exp.accrued;
    }
    const rec = importedPlayer(p.nhlId);
    const imp = rec ? playerContractsFromImport(rec, teams, season, p) : null;
    if (rec && imp?.current) {
      p.contract = imp.current;
      p.firstSpcAge = rec.firstSpcAge ?? estimateFirstSpcAge(p, season);
      p.firstSpcSeason = rec.firstSpcSeason ?? season - p.proSeasons;
      if (rec.careerGames !== undefined) p.nhlGamesBefore = rec.careerGames;
    } else {
      p.firstSpcAge ??= estimateFirstSpcAge(p, season);
      p.firstSpcSeason ??= season - Math.max(0, p.proSeasons);
      const elcTerm = STATIC().elcTermByAge[String(Math.min(24, Math.max(18, p.firstSpcAge)))] ?? 0;
      const intoContract = season - p.firstSpcSeason;
      const elc = p.firstSpcAge < 25 && intoContract < elcTerm && age <= 24;
      const mv = marketValue(p, valueCtx) * clamp(rng.normal(1, 0.15), 0.6, 1.35);
      p.contract = estimateContract(rng, p, {
        season,
        marketValue: mv,
        yearsLeft: elc ? elcTerm - intoContract : rng.int(1, Math.max(1, typicalTerm(p, season, rng))),
        elc,
        teamId,
      });
    }
    p.contract.id = contractIds++;
    if (p.contract.next) p.contract.next.id = contractIds++;
    p.contract.expiryStatus ??= determineFreeAgentStatus(p, endOf(p.contract)).status;
    if (imp?.current && imp.history.length) {
      p.contractHistory = imp.history;
      return;
    }
    p.contractHistory = [{ teamId, signingTeamId: p.contract.signingTeamId ?? teamId, startSeason: yearsOf(p.contract)[0].season, endSeason: endOf(p.contract), years: termOf(p.contract), totalValue: totalValue(p.contract), aav: aav(p.contract), type: p.contract.type, origin: p.contract.origin, source: p.contract.source }];
  };

  // ── Rosters
  for (const t of teams) {
    const teamOffset = rng.normal(0, 3);
    const star = rng.chance(0.2) ? rng.float(10, 22) : 0;
    const fPos = forwardPositions(rng, F_SLOTS.length);
    let realExtras = 0;
    let importedMinors = 0;
    let usedStatuses = false;
    if (real) {
      // Best players by position make the active roster; the rest start in the system.
      const mine = real.get(t.abbr)!;
      const taken = { F: 0, D: 0, G: 0 };
      for (const p of mine) {
        const g = p.pos === 'G' ? 'G' : p.pos === 'D' ? 'D' : 'F';
        p.teamId = t.id;
        const st = importedPlayer(p.nhlId)?.status;
        if (st && st !== 'Retired') {
          usedStatuses = true;
          // Real roster status from the contract database (NHL roster vs minors/junior).
          p.status = MINOR_STATUSES.has(st) ? 'prospect' : 'active';
          if (p.status === 'active') taken[g]++;
          else realExtras++;
          markInjury(p, st);
        } else if (taken[g] < REAL_ACTIVE[g]) {
          taken[g]++;
          p.status = 'active';
        } else {
          p.status = 'prospect';
          realExtras++;
        }
        signContract(p, t.id);
        addPlayer(p);
      }
      // Fill any gaps (e.g. injured players missing from the feed) with depth players.
      const fill = (pos: Position, n: number) => {
        for (let i = 0; i < n; i++) {
          const target = clamp(108 + rng.normal(0, 5), 95, 120);
          const p = generatePlayer(rng, { id: ids.player++, pos, targetCA: Math.round(target), age: pickAge(rng, target), season });
          p.teamId = t.id;
          p.status = 'active';
          signContract(p, t.id);
          addPlayer(p);
        }
      };
      // Contracted organisation players missing from the roster feed (minor leagues, long-term injured).
      for (const rec of importedPlayers()) {
        if (rec.teamAbbr !== t.abbr || realIds.has(rec.nhlId) || !rec.status || rec.status === 'Retired') continue;
        const p = playerFromImport(rec, t.id);
        if (!p) continue;
        realIds.add(rec.nhlId);
        if (p.status === 'prospect') importedMinors++;
        else taken[p.pos === 'G' ? 'G' : p.pos === 'D' ? 'D' : 'F']++;
        signContract(p, t.id);
        addPlayer(p);
      }
      // With real roster statuses only fill holes below a dressable lineup; otherwise use the default roster shape.
      const shape = usedStatuses ? { F: 13, D: 7, G: 2 } : REAL_ACTIVE;
      fill('C', shape.F - taken.F);
      fill('D', shape.D - taken.D);
      fill('G', shape.G - taken.G);
    }
    const make = (pos: Position, base: number, slotIdx: number) => {
      let target = base + teamOffset + rng.normal(0, 6);
      if (slotIdx === 0 && pos !== 'G' && pos !== 'D') target += star;
      target = clamp(target, 85, 192);
      const age = pickAge(rng, target);
      const p = generatePlayer(rng, { id: ids.player++, pos, targetCA: Math.round(target), age, season });
      p.teamId = t.id;
      p.status = 'active';
      signContract(p, t.id);
      return addPlayer(p);
    };
    if (!real) {
      F_SLOTS.forEach((ca, i) => make(fPos[i], ca, i));
      D_SLOTS.forEach((ca, i) => make('D', ca, i));
      G_SLOTS.forEach((ca, i) => make('G', ca, i));
    }
    // Prospects in the system.
    const orgContracts = Object.values(players).filter((p) => p.teamId === t.id && p.contract).length;
    // Real organisations already carry their signed prospects; only top up with unsigned-style prospects within the contract limit.
    // With real reserve lists (unsigned draft picks) imported below, real organisations need no invented prospects.
    const prospectCount = usedStatuses ? (hasReserves ? 0 : Math.max(0, Math.min(2, 48 - orgContracts))) : Math.max(3, 9 - realExtras);
    for (let i = 0; i < prospectCount; i++) {
      let p = generateProspect(rng, ids.player++, season, rng.int(18, 21));
      // Every organisation starts with at least one goaltending prospect.
      if (i === 0 && p.pos !== 'G') {
        do p = generateProspect(rng, p.id, season, rng.int(19, 21));
        while (p.pos !== 'G');
      }
      // Already a year or more into development.
      const yearsIn = season - p.birthYear - 18;
      p.ca = Math.min(p.pa, p.ca + yearsIn * 6);
      p.teamId = t.id;
      p.status = 'prospect';
      p.draft = { season: season - 1 - yearsIn, round: rng.int(1, 7), pick: rng.int(1, 32), teamId: t.id };
      p.proSeasons = Math.max(0, yearsIn - 1);
      p.firstSpcAge = clamp(p.draft.season + 1 - p.birthYear, 18, 21);
      p.firstSpcSeason = season - p.proSeasons;
      signContract(p, t.id);
      addPlayer(p);
    }
  }

  // Calibrate estimated contracts to league payroll levels: NHL teams spend
  // close to the upper limit, so estimated (never real) veteran deals are
  // scaled toward an average of 95% of the cap (SIMPLIFICATION until real
  // contract data is imported), then each team is fitted under its limit.
  {
    const rostered = Object.values(players).filter((p) => p.teamId !== null && p.status === 'active' && p.contract);
    // Star deals are left alone (the market model already prices them); the gap is in the middle class.
    const scalable = rostered.filter((p) => p.contract!.source === 'estimated' && p.contract!.type !== 'ELC' && p.contract!.salary < cap.upper * 0.07);
    const total = rostered.reduce((s, p) => s + p.contract!.salary, 0);
    const est = scalable.reduce((s, p) => s + p.contract!.salary, 0);
    const target = cap.upper * 0.94 * teams.length;
    const realShare = rostered.filter((p) => p.contract!.source === 'real').length / Math.max(1, rostered.length);
    const factor = realShare > 0.5 ? 1 : clamp((target - (total - est)) / Math.max(1, est), 1, 1.3);
    if (factor > 1.001) for (const p of scalable) scaleContract(p.contract!, factor, season);
  }
  for (const t of teams) {
    // Keep payroll under the cap (and under budget).
    const roster = Object.values(players).filter((p) => p.teamId === t.id && p.status === 'active');
    const total = roster.reduce((s, p) => s + (p.contract?.salary ?? 0), 0);
    const limit = Math.min(cap.upper * 0.985, t.budget);
    if (total > limit) {
      // Scale estimated (never real) veteran contracts so the team starts cap compliant.
      const scalable = roster.filter((p) => p.contract && p.contract.source === 'estimated' && p.contract.type !== 'ELC');
      const fixed = total - scalable.reduce((s, p) => s + p.contract!.salary, 0);
      const scale = Math.max(0.5, (limit - fixed) / Math.max(1, total - fixed));
      for (const p of scalable) scaleContract(p.contract!, scale, season);
    }
  }

  // ── Free agents
  for (let i = 0; i < 80; i++) {
    const pos: Position = rng.pick(['C', 'LW', 'RW', 'D', 'D', 'C', 'G']);
    const target = clamp(rng.normal(112, 9), 85, 135);
    const p = generatePlayer(rng, { id: ids.player++, pos, targetCA: Math.round(target), age: rng.int(22, 35), season });
    p.status = 'fa';
    addPlayer(p);
  }

  // ── Real reserve lists: each club's unsigned draft picks.
  if (hasReserves) for (const p of buildRealReserves(rng, teams, season, Object.values(players), () => ids.player++)) addPlayer(p);

  // ── Draft class for the upcoming draft
  const draftClassSize = cfg.teams.length * cfg.draft.rounds + 40;
  // Real prospects (NHL Central Scouting lists) first; generated players fill out the class.
  const realClass = real ? buildRealDraftClass(rng, season, Object.values(players), () => ids.player++) : [];
  for (const p of realClass) addPlayer(p);
  // Re-entries alone are a late-round crop: the first-time-eligible class is generated until Central Scouting publishes it.
  const firstTimers = isReentryClass() ? realClass.filter((p) => p.boardRank).length : realClass.length;
  for (let i = firstTimers; i < draftClassSize; i++) addPlayer(generateProspect(rng, ids.player++, season));

  // ── Coaches
  const realStaff = !!snap && snapshotHasRosters(snap, abbrs);
  for (const t of teams) {
    const realCoach = realStaff ? snap.staff?.[t.abbr]?.headCoach : null;
    const quality = realCoach && COACH_QUALITY[realCoach] ? COACH_QUALITY[realCoach] : clamp(rng.normal(108, 18), 60, 170);
    const head = generateCoach(rng, ids.coach++, season, quality, 'head', realCoach ? COACH_PROFILES[realCoach] : undefined);
    if (realCoach) Object.assign(head, splitName(realCoach));
    if (realStaff && NHL_GMS[t.abbr]) t.gm.name = NHL_GMS[t.abbr];
    const asst = generateCoach(rng, ids.coach++, season, clamp(rng.normal(95, 15), 50, 150), 'assistant');
    const gk = generateCoach(rng, ids.coach++, season, clamp(rng.normal(100, 18), 50, 160), 'goalie');
    for (const c of [head, asst, gk]) {
      c.teamId = t.id;
      c.hiredSeason = season - rng.int(0, 4);
      c.contract = { salary: c.role === 'head' ? rng.int(1200, 4500) : rng.int(400, 1200), years: rng.int(1, 4) };
      coaches[c.id] = c;
    }
    t.staff = { headCoach: head.id, assistant: asst.id, goalieCoach: gk.id };
  }
  for (let i = 0; i < 18; i++) {
    const c = generateCoach(rng, ids.coach++, season, clamp(rng.normal(95, 20), 50, 160), rng.chance(0.75) ? 'head' : 'goalie');
    coaches[c.id] = c;
  }

  // ── Lines, tactics, captains, strategy
  const norm = fitNormFrom(regulars(Object.values(players).filter((p) => p.status === 'active' && p.teamId !== null)));
  for (const t of teams) {
    const roster = Object.values(players).filter((p) => p.teamId === t.id && p.status === 'active');
    t.lines = autoLines(roster);
    const hc = coaches[t.staff.headCoach!];
    t.tactics = tacticsForRoster(hc.philosophy, roster, hc.ratings.tactics, rng, t.lines, hc.system, norm);
    t.famTactics = { ...t.tactics };
    const cap = [...roster].sort((a, b) => b.attrs.leadership + b.ca * 0.5 - (a.attrs.leadership + a.ca * 0.5));
    t.captain = cap[0]?.id ?? null;
    t.alternates = cap.slice(1, 3).map((p) => p.id);
  }

  // ── Schedule
  const schedule = generateSchedule(teams, cfg, rng, ids.game);
  ids.game += schedule.length;
  const lastDay = schedule.reduce((m, g) => Math.max(m, g.day), 0);

  // ── Draft picks: next three drafts.
  const draftPicks = [];
  for (let s = season; s < season + 3; s++)
    for (let r = 1; r <= cfg.draft.rounds; r++)
      for (const t of teams) draftPicks.push({ id: ids.pick++, season: s, round: r, originalTeamId: t.id, ownerId: t.id });
  // Real ownership: traded picks (and their conditions) are where they are in the NHL today.
  if (real) applyRealPickOwnership(draftPicks, teams);

  // ── Scouts for the user's team
  const scouts: Scout[] = [];
  for (let i = 0; i < 3; i++) {
    const pool = rng.weighted(NAME_POOLS, (p) => p.weight);
    scouts.push({
      id: ids.scout++,
      first: rng.pick(pool.first),
      last: rng.pick(pool.last),
      judgingAbility: Math.round(clamp(rng.normal(110, 25), 50, 190)),
      judgingPotential: Math.round(clamp(rng.normal(105, 25), 50, 190)),
      salary: rng.int(80, 250),
      assignment: i === 0 ? { kind: 'draft' } : i === 1 ? { kind: 'freeAgents' } : { kind: 'idle' },
    });
  }

  const seasonStats: League['seasonStats'] = {};
  for (const p of Object.values(players)) if (p.status === 'active' && p.teamId !== null) seasonStats[p.id] = { reg: emptyStatLine(), po: emptyStatLine(), teamId: p.teamId };

  const league: League = {
    version: SAVE_VERSION,
    name: cfg.name,
    seed,
    rng: rng.state(),
    userTeamId: opts.userTeamId ?? 0,
    season,
    phase: 'regular',
    day: 0,
    config: cfg,
    settings: { godMode: false, injuryRate: 1, tradeDifficulty: 1, autoManageUser: false },
    cap,
    teams,
    players,
    coaches,
    scouts,
    schedule,
    tradeDeadlineDay: Math.floor(lastDay * cfg.season.tradeDeadlineFraction),
    standings: Object.fromEntries(teams.map((t) => [t.id, emptyRecord()])),
    seasonStats,
    playoffs: null,
    draftPicks,
    draftOrder: [],
    draftCombineDone: false,
    faOffers: [],
    faDay: 0,
    news: [],
    transactions: [],
    history: [],
    records: { singleSeason: {}, career: {}, team: {} },
    scouting: { knowledge: {} },
    chemistry: {},
    nextId: ids,
    projections: {},
    ratingBaseline: 120,
    tradeOffers: [],
    aiMemory: Object.fromEntries(teams.map((t) => [t.id, { lastTradeDay: -100, coachHotSeat: 0 }])),
    ...emptyFinancialState(),
  };
  league.nextContractId = contractIds;
  let chargeId = 1;
  league.capLedger = importedDeadCap(teams, () => chargeId++, season);
  for (const p of ltirAtStart) if (p.teamId !== null && p.contract) placeOnLTIR(league, p);
  if (real && contractDbInfo().count > 0) openingDayCompliance(league);
  for (const p of Object.values(players)) p.caSeasonStart = p.ca;
  // Front offices start the season with a plan: contend, stay the course, or rebuild.
  updateStrategies(league, true);
  league.projections = Object.fromEntries(teams.map((t) => [t.id, projectedPoints(league, t.id)]));
  return league;
}
