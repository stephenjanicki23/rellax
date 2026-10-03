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
import { makeContract, marketValue, typicalTerm, teamBudget } from '../economy/contracts';
import { generateSchedule } from './schedule';
import { emptyRecord } from './helpers';
import { projectedPoints } from '../team/strength';
import { buildRealPlayers, snapshotHasRosters } from '../data/nhl/realPlayers';
import type { NhlSnapshot } from '../data/nhl/types';
import { COACH_QUALITY, NHL_GMS, splitName } from '../data/nhl/staff';
import NHL_SNAPSHOT from '../data/nhl/rosters.json';

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

export const SAVE_VERSION = 1;

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

  const cap = { upper: cfg.economics.salaryCap, floor: cfg.economics.capFloor, minSalary: cfg.economics.minSalary };
  const valueCtx = { season, cap };

  const addPlayer = (p: Player) => {
    players[p.id] = p;
    return p;
  };

  const snap = opts.rosters === undefined ? (NHL_SNAPSHOT as NhlSnapshot) : opts.rosters;
  const abbrs = teams.map((t) => t.abbr);
  const real = snap && snapshotHasRosters(snap, abbrs) ? buildRealPlayers(rng, snap, abbrs, season, () => ids.player++) : null;

  const signContract = (p: Player) => {
    const age = season - p.birthYear;
    const mv = marketValue(p, valueCtx);
    const years = typicalTerm(p, season, rng);
    const elc = age <= 22 && rng.chance(0.6);
    p.contract = elc
      ? makeContract(rng.int(cfg.economics.minSalary, cfg.economics.elcMaxSalary), rng.int(1, 3), season - 1, false, 'ELC')
      : makeContract(mv * clamp(rng.normal(1, 0.15), 0.6, 1.35), rng.int(1, years), season - 1, mv > 6000 && age >= 27 && rng.chance(0.5));
  };

  // ── Rosters
  for (const t of teams) {
    const teamOffset = rng.normal(0, 3);
    const star = rng.chance(0.2) ? rng.float(10, 22) : 0;
    const fPos = forwardPositions(rng, F_SLOTS.length);
    let realExtras = 0;
    if (real) {
      // Best players by position make the active roster; the rest start in the system.
      const mine = real.get(t.abbr)!;
      const taken = { F: 0, D: 0, G: 0 };
      for (const p of mine) {
        const g = p.pos === 'G' ? 'G' : p.pos === 'D' ? 'D' : 'F';
        p.teamId = t.id;
        if (taken[g] < REAL_ACTIVE[g]) {
          taken[g]++;
          p.status = 'active';
        } else {
          p.status = 'prospect';
          realExtras++;
        }
        signContract(p);
        addPlayer(p);
      }
      // Fill any gaps (e.g. injured players missing from the feed) with depth players.
      const fill = (pos: Position, n: number) => {
        for (let i = 0; i < n; i++) {
          const target = clamp(108 + rng.normal(0, 5), 95, 120);
          const p = generatePlayer(rng, { id: ids.player++, pos, targetCA: Math.round(target), age: pickAge(rng, target), season });
          p.teamId = t.id;
          p.status = 'active';
          signContract(p);
          addPlayer(p);
        }
      };
      fill('C', REAL_ACTIVE.F - taken.F);
      fill('D', REAL_ACTIVE.D - taken.D);
      fill('G', REAL_ACTIVE.G - taken.G);
    }
    const make = (pos: Position, base: number, slotIdx: number) => {
      let target = base + teamOffset + rng.normal(0, 6);
      if (slotIdx === 0 && pos !== 'G' && pos !== 'D') target += star;
      target = clamp(target, 85, 192);
      const age = pickAge(rng, target);
      const p = generatePlayer(rng, { id: ids.player++, pos, targetCA: Math.round(target), age, season });
      p.teamId = t.id;
      p.status = 'active';
      const mv = marketValue(p, valueCtx);
      const years = typicalTerm(p, season, rng);
      const elc = age <= 22 && rng.chance(0.6);
      p.contract = elc
        ? makeContract(rng.int(cfg.economics.minSalary, cfg.economics.elcMaxSalary), rng.int(1, 3), season - 1, false, 'ELC')
        : makeContract(mv * clamp(rng.normal(1, 0.15), 0.6, 1.35), rng.int(1, years), season - 1, mv > 6000 && age >= 27 && rng.chance(0.5));
      return addPlayer(p);
    };
    if (!real) {
      F_SLOTS.forEach((ca, i) => make(fPos[i], ca, i));
      D_SLOTS.forEach((ca, i) => make('D', ca, i));
      G_SLOTS.forEach((ca, i) => make('G', ca, i));
    }
    // Prospects in the system.
    for (let i = 0; i < Math.max(3, 9 - realExtras); i++) {
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
      p.contract = makeContract(rng.int(cfg.economics.minSalary, cfg.economics.elcMaxSalary), rng.int(1, 3), season - 1, false, 'ELC');
      p.draft = { season: season - 1 - yearsIn, round: rng.int(1, 7), pick: rng.int(1, 32), teamId: t.id };
      addPlayer(p);
    }
    // Keep payroll under the cap (and under budget).
    const roster = Object.values(players).filter((p) => p.teamId === t.id && p.status === 'active');
    const total = roster.reduce((s, p) => s + (p.contract?.salary ?? 0), 0);
    const limit = Math.min(cap.upper * 0.985, t.budget);
    if (total > limit) {
      const scale = limit / total;
      for (const p of roster) if (p.contract) p.contract.salary = Math.max(cap.minSalary, Math.round(p.contract.salary * scale));
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

  // ── Draft class for the upcoming draft
  const draftClassSize = cfg.teams.length * cfg.draft.rounds + 40;
  for (let i = 0; i < draftClassSize; i++) addPlayer(generateProspect(rng, ids.player++, season));

  // ── Coaches
  const realStaff = !!snap && snapshotHasRosters(snap, abbrs);
  for (const t of teams) {
    const realCoach = realStaff ? snap.staff?.[t.abbr]?.headCoach : null;
    const quality = realCoach && COACH_QUALITY[realCoach] ? COACH_QUALITY[realCoach] : clamp(rng.normal(108, 18), 60, 170);
    const head = generateCoach(rng, ids.coach++, season, quality, 'head');
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
  for (const t of teams) {
    const roster = Object.values(players).filter((p) => p.teamId === t.id && p.status === 'active');
    t.lines = autoLines(roster);
    const hc = coaches[t.staff.headCoach!];
    t.tactics = tacticsForRoster(hc.philosophy, roster, hc.ratings.tactics, rng);
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
  };
  for (const p of Object.values(players)) p.caSeasonStart = p.ca;
  league.projections = Object.fromEntries(teams.map((t) => [t.id, projectedPoints(league, t.id)]));
  return league;
}
