/**
 * Simulation analytics: run batches of games / seasons and summarise the
 * statistical distributions so the engine can be balanced against realistic
 * targets. Used by the validation test-suite and the developer analytics
 * screen.
 */
import { histogram, mean, percentile, stdev } from './core/math';
import { points as statPoints, savePct } from './core/statline';
import type { League } from './types';
import { simulateGame } from './sim/engine';
import { buildGameInput } from './league/gameInput';
import type { GameResult } from './sim/gameTypes';

export interface BatchSummary {
  games: number;
  ms: number;
  goalsPerTeam: number;
  shotsPerTeam: number;
  attemptsPerTeam: number;
  blockedPerTeam: number;
  missedPerTeam: number;
  xgPerTeam: number;
  shPct: number;
  svPct: number;
  ppOppPerTeam: number;
  ppPct: number;
  shGoalsPerTeam: number;
  hitsPerTeam: number;
  blocksPerTeam: number;
  takeawaysPerTeam: number;
  giveawaysPerTeam: number;
  pimPerTeam: number;
  homeWinPct: number;
  otPct: number;
  soPct: number;
  enGoalsPerGame: number;
  assistsPerGoal: number;
  injuriesPerGame: number;
  fightsPerGame: number;
  totalGoalsHist: { bin: number; count: number }[];
  marginHist: { label: string; count: number }[];
  shotsHist: { bin: number; count: number }[];
  highScoringPct: number; // 9+ total goals
}

/** Accumulates game results into a BatchSummary. */
export class BatchAccumulator {
  private totals: number[] = [];
  private shots: number[] = [];
  private margins: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5+': 0, OT: 0 };
  private acc = { goals: 0, shots: 0, att: 0, blocked: 0, missed: 0, xg: 0, ppOpp: 0, ppg: 0, shg: 0, hits: 0, blocks: 0, tk: 0, gv: 0, pim: 0, sa: 0, ga: 0, assists: 0, en: 0, inj: 0, fights: 0 };
  private homeWins = 0;
  private ot = 0;
  private so = 0;
  private n = 0;
  private t0 = Date.now();

  add(r: GameResult): void {
    const acc = this.acc;
    this.n++;
    this.totals.push(r.homeGoals + r.awayGoals);
    if (r.homeGoals > r.awayGoals) this.homeWins++;
    if (r.ot) this.ot++;
    if (r.so) this.so++;
    const m = Math.abs(r.homeGoals - r.awayGoals);
    this.margins[r.ot ? 'OT' : m >= 5 ? '5+' : String(m)]++;
    for (const t of r.teams) {
      acc.goals += t.goals;
      acc.shots += t.shots;
      acc.att += t.attempts;
      acc.blocked += t.blockedAtt;
      acc.missed += t.missed;
      acc.xg += t.xg;
      acc.ppOpp += t.ppOpp;
      acc.ppg += t.ppg;
      acc.shg += t.shg;
      acc.hits += t.hits;
      acc.blocks += t.blocks;
      acc.tk += t.tk;
      acc.gv += t.gv;
      acc.pim += t.pim;
      this.shots.push(t.shots);
    }
    for (const p of Object.values(r.players)) {
      acc.sa += p.sa;
      acc.ga += p.ga;
    }
    for (const gl of r.goals) {
      acc.assists += gl.assists.length;
      if (gl.strength === 'EN') acc.en++;
    }
    acc.inj += r.injuries.length;
    acc.fights += r.penalties.filter((p) => p.infraction === 'Fighting').length / 2;
  }

  summary(): BatchSummary {
    const acc = this.acc;
    const n = Math.max(1, this.n);
    const tg = n * 2;
    return {
      games: this.n,
      ms: Date.now() - this.t0,
      goalsPerTeam: acc.goals / tg,
      shotsPerTeam: acc.shots / tg,
      attemptsPerTeam: acc.att / tg,
      blockedPerTeam: acc.blocked / tg,
      missedPerTeam: acc.missed / tg,
      xgPerTeam: acc.xg / tg,
      shPct: acc.goals / Math.max(1, acc.shots),
      svPct: acc.sa ? (acc.sa - acc.ga) / acc.sa : 0,
      ppOppPerTeam: acc.ppOpp / tg,
      ppPct: acc.ppOpp ? acc.ppg / acc.ppOpp : 0,
      shGoalsPerTeam: acc.shg / tg,
      hitsPerTeam: acc.hits / tg,
      blocksPerTeam: acc.blocks / tg,
      takeawaysPerTeam: acc.tk / tg,
      giveawaysPerTeam: acc.gv / tg,
      pimPerTeam: acc.pim / tg,
      homeWinPct: this.homeWins / n,
      otPct: this.ot / n,
      soPct: this.so / n,
      enGoalsPerGame: acc.en / n,
      assistsPerGoal: acc.goals ? acc.assists / acc.goals : 0,
      injuriesPerGame: acc.inj / n,
      fightsPerGame: acc.fights / n,
      totalGoalsHist: histogram(this.totals, 0, 14),
      marginHist: Object.entries(this.margins).map(([label, count]) => ({ label, count })),
      shotsHist: histogram(this.shots, 15, 50),
      highScoringPct: this.totals.filter((t) => t >= 9).length / n,
    };
  }
}

function batchGame(league: League, i: number, salt: number): GameResult {
  const games = league.schedule.filter((g) => !g.playoff);
  const g = games[i % games.length];
  return simulateGame(buildGameInput(league, g.id, false, 7919 + salt * 100003 + i));
}

/** Simulate `n` games from the current schedule without touching league state. */
export function runGameBatch(league: League, n: number, salt = 0): BatchSummary {
  const acc = new BatchAccumulator();
  for (let i = 0; i < n; i++) acc.add(batchGame(league, i, salt));
  return acc.summary();
}

/** Same as runGameBatch but yields between chunks so a UI can stay responsive. */
export async function runGameBatchAsync(league: League, n: number, onProgress: (done: number) => void, salt = 0, isCancelled: () => boolean = () => false): Promise<BatchSummary> {
  const acc = new BatchAccumulator();
  for (let i = 0; i < n; i++) {
    acc.add(batchGame(league, i, salt));
    if (i % 40 === 39) {
      onProgress(i + 1);
      await new Promise((r) => setTimeout(r, 0));
      if (isCancelled()) break;
    }
  }
  onProgress(n);
  return acc.summary();
}

export interface SeasonSummary {
  season: number;
  teamPointsSd: number;
  bestPoints: number;
  worstPoints: number;
  pointsLeader: number;
  goalsLeader: number;
  assistsLeader: number;
  players100: number;
  players50Goals: number;
  players80Points: number;
  skaterPointsHist: { bin: number; count: number }[];
  starterSvPcts: number[];
  starterSvMin: number;
  starterSvMax: number;
  starterGaaMean: number;
  shutoutsTotal: number;
  injuriesPerTeam: number;
  manGamesLostPerTeam: number;
  avgActiveCA: number;
  top400CA: number;
  champion: number | null;
}

/**
 * Summarise a completed season (from history + careers), or the current
 * season in progress if `season` is the current one.
 */
export function seasonSummary(league: League, season = league.history.at(-1)?.season ?? league.season): SeasonSummary {
  const hist = league.history.find((h) => h.season === season);
  const lines: { pos: string; s: import('./types').StatLine }[] = [];
  if (season === league.season && !hist) {
    for (const [id, e] of Object.entries(league.seasonStats)) {
      const p = league.players[Number(id)];
      if (p && e.reg.gp) lines.push({ pos: p.pos, s: e.reg });
    }
  } else {
    for (const p of Object.values(league.players)) {
      for (const c of p.career) if (c.season === season && !c.playoffs) lines.push({ pos: p.pos, s: c.stats });
    }
  }
  const skaters = lines.filter((l) => l.pos !== 'G');
  const goalies = lines.filter((l) => l.pos === 'G');
  const pts = skaters.map((l) => statPoints(l.s));
  const starters = goalies.filter((l) => l.s.gp >= 40);
  const sv = starters.map((l) => savePct(l.s));
  const teamPts = hist ? hist.standings.map((r) => r.pts) : Object.values(league.standings).map((r) => r.w * 2 + r.otl);
  const injuries = Object.values(league.players).flatMap((p) => p.injuryHistory.filter((h) => h.season === season));
  const active = Object.values(league.players).filter((p) => p.status === 'active');
  const topSk = active.filter((p) => p.pos !== 'G').map((p) => p.ca).sort((a, b) => b - a).slice(0, 400);
  return {
    season,
    teamPointsSd: stdev(teamPts),
    bestPoints: Math.max(...teamPts),
    worstPoints: Math.min(...teamPts),
    pointsLeader: Math.max(0, ...pts),
    goalsLeader: Math.max(0, ...skaters.map((l) => l.s.g)),
    assistsLeader: Math.max(0, ...skaters.map((l) => l.s.a1 + l.s.a2)),
    players100: pts.filter((p) => p >= 100).length,
    players50Goals: skaters.filter((l) => l.s.g >= 50).length,
    players80Points: pts.filter((p) => p >= 80).length,
    skaterPointsHist: histogram(skaters.filter((l) => l.s.gp >= 40).map((l) => statPoints(l.s)), 0, 150, 10),
    starterSvPcts: sv,
    starterSvMin: sv.length ? Math.min(...sv) : 0,
    starterSvMax: sv.length ? Math.max(...sv) : 0,
    starterGaaMean: mean(starters.map((l) => (l.s.gtoi ? (l.s.ga * 3600) / l.s.gtoi : 0))),
    shutoutsTotal: goalies.reduce((s, l) => s + l.s.so, 0),
    injuriesPerTeam: injuries.length / league.teams.length,
    manGamesLostPerTeam: injuries.reduce((s, h) => s + h.days / 2.25, 0) / league.teams.length,
    avgActiveCA: mean(active.map((p) => p.ca)),
    top400CA: mean(topSk),
    champion: hist?.champion ?? null,
  };
}

/** Realistic target ranges (modern NHL-like) used to flag anomalies. */
export const GAME_TARGETS: Record<string, { lo: number; hi: number; label: string; fmt?: 'pct' | 'pct1' | 'num' }> = {
  goalsPerTeam: { lo: 2.8, hi: 3.4, label: 'Goals per team-game' },
  shotsPerTeam: { lo: 28, hi: 33.5, label: 'Shots on goal per team-game' },
  attemptsPerTeam: { lo: 50, hi: 62, label: 'Shot attempts per team-game' },
  shPct: { lo: 0.088, hi: 0.112, label: 'Shooting %', fmt: 'pct1' },
  svPct: { lo: 0.895, hi: 0.913, label: 'Save %', fmt: 'pct1' },
  ppPct: { lo: 0.16, hi: 0.25, label: 'Power-play %', fmt: 'pct1' },
  ppOppPerTeam: { lo: 2.5, hi: 3.3, label: 'PP opportunities per team-game' },
  hitsPerTeam: { lo: 17, hi: 28, label: 'Hits per team-game' },
  blocksPerTeam: { lo: 11, hi: 17, label: 'Blocked shots per team-game' },
  homeWinPct: { lo: 0.51, hi: 0.57, label: 'Home win %', fmt: 'pct1' },
  otPct: { lo: 0.17, hi: 0.27, label: 'Games to overtime', fmt: 'pct1' },
  assistsPerGoal: { lo: 1.5, hi: 1.8, label: 'Assists per goal' },
  enGoalsPerGame: { lo: 0.2, hi: 0.5, label: 'Empty-net goals per game' },
  injuriesPerGame: { lo: 0.2, hi: 0.7, label: 'In-game injuries per game' },
  highScoringPct: { lo: 0.05, hi: 0.23, label: 'Games with 9+ total goals', fmt: 'pct' },
};

export const SEASON_TARGETS: Record<string, { lo: number; hi: number; label: string; fmt?: 'pct' | 'pct1' | 'num' | 'sv' }> = {
  teamPointsSd: { lo: 8, hi: 22, label: 'Std. dev. of team points' },
  bestPoints: { lo: 105, hi: 140, label: 'Best team points' },
  worstPoints: { lo: 40, hi: 80, label: 'Worst team points' },
  pointsLeader: { lo: 95, hi: 165, label: 'Scoring leader points' },
  goalsLeader: { lo: 42, hi: 80, label: 'Goals leader' },
  players100: { lo: 0, hi: 14, label: '100-point players' },
  players50Goals: { lo: 0, hi: 10, label: '50-goal scorers' },
  starterSvMin: { lo: 0.86, hi: 0.905, label: 'Worst starter save %', fmt: 'sv' },
  starterSvMax: { lo: 0.912, hi: 0.94, label: 'Best starter save %', fmt: 'sv' },
  manGamesLostPerTeam: { lo: 60, hi: 420, label: 'Man-games lost to injury per team' },
};

export function checkTargets(values: Record<string, number>, targets: Record<string, { lo: number; hi: number; label: string }>): { key: string; label: string; value: number; lo: number; hi: number; ok: boolean }[] {
  return Object.entries(targets)
    .filter(([k]) => values[k] !== undefined)
    .map(([key, t]) => ({ key, label: t.label, value: values[key], lo: t.lo, hi: t.hi, ok: values[key] >= t.lo && values[key] <= t.hi }));
}

export { percentile };
