import { beforeAll, describe, expect, it } from 'vitest';
import { createLeague } from '../src/engine/league/create';
import { simTo, advanceDay } from '../src/engine/league/season';
import { standingRows, conferenceSeeds } from '../src/engine/league/standings';
import { awardsRace } from '../src/engine/league/awards';
import { pairCounts, generateSchedule } from '../src/engine/league/schedule';
import { DEFAULT_CONFIG } from '../src/engine/data/leagueConfig';
import { Rng } from '../src/engine/core/rng';
import type { League } from '../src/engine/types';

describe('schedule', () => {
  const teams = DEFAULT_CONFIG.teams.map((t, i) => ({ id: i, divisionId: t.divisionId, conferenceId: DEFAULT_CONFIG.divisions.find((d) => d.id === t.divisionId)!.conferenceId }));
  it('gives every team 82 games, 41 at home', () => {
    const s = generateSchedule(teams, DEFAULT_CONFIG, new Rng('sched'), 1);
    expect(s.length).toBe(32 * 41);
    for (const t of teams) {
      const mine = s.filter((g) => g.home === t.id || g.away === t.id);
      expect(mine.length).toBe(82);
      const home = mine.filter((g) => g.home === t.id).length;
      expect(Math.abs(home - 41)).toBeLessThanOrEqual(1);
    }
  });
  it('never schedules a team twice on one day or three days in a row', () => {
    const s = generateSchedule(teams, DEFAULT_CONFIG, new Rng('sched2'), 1);
    for (const t of teams) {
      const days = s.filter((g) => g.home === t.id || g.away === t.id).map((g) => g.day).sort((a, b) => a - b);
      expect(new Set(days).size).toBe(days.length);
      for (let i = 2; i < days.length; i++) expect(days[i] - days[i - 2]).toBeGreaterThan(2);
    }
  });
  it('weights division opponents most', () => {
    const counts = pairCounts(teams, DEFAULT_CONFIG);
    const div = counts.get('0-1')!; // BOS-MTL same division
    const inter = counts.get('0-16')!; // BOS-CHI other conference
    expect(div).toBeGreaterThan(inter);
  });
});

describe('full season', () => {
  let league: League;
  beforeAll(() => {
    league = createLeague({ seed: 'season-suite' });
    league.settings.autoManageUser = true;
    simTo(league, 'endRegular');
  });

  it('plays every regular-season game with consistent standings', () => {
    expect(league.phase).toBe('playoffs');
    const rows = standingRows(league);
    let wins = 0;
    let gp = 0;
    for (const r of rows) {
      expect(r.rec.gp).toBe(82);
      expect(r.rec.w + r.rec.l + r.rec.otl).toBe(82);
      wins += r.rec.w;
      gp += r.rec.gp;
    }
    expect(wins).toBe(gp / 2);
    const gf = rows.reduce((s, r) => s + r.rec.gf, 0);
    const ga = rows.reduce((s, r) => s + r.rec.ga, 0);
    expect(gf).toBe(ga);
  });

  it('player goals add up to team goals (minus shootout winners)', () => {
    let playerGoals = 0;
    for (const e of Object.values(league.seasonStats)) playerGoals += e.reg.g;
    const games = league.schedule.filter((g) => !g.playoff && g.result);
    const so = games.filter((g) => g.result!.so).length;
    const teamGoals = games.reduce((s, g) => s + g.result!.hg + g.result!.ag, 0);
    expect(playerGoals).toBe(teamGoals - so);
  });

  it('tracks award races with ranked candidates', () => {
    const races = awardsRace(league);
    expect(races.length).toBe(6);
    for (const r of races) expect(r.candidates.length).toBeGreaterThan(2);
    const scoring = races.find((r) => r.award.includes('Art Ross'))!;
    expect(scoring.candidates[0].score).toBeGreaterThanOrEqual(scoring.candidates[1].score);
  });

  it('seeds 16 playoff teams, 8 per conference', () => {
    expect(league.playoffs!.seeds.length).toBe(16);
    for (const c of league.config.conferences) expect(conferenceSeeds(league, c.id).length).toBe(8);
    expect(league.playoffs!.rounds[0].length).toBe(8);
  });

  it('injuries happen, heal, and nobody is permanently stuck', () => {
    const injured = Object.values(league.players).filter((p) => p.injuryHistory.some((h) => h.season === league.season));
    expect(injured.length).toBeGreaterThan(200);
    const stillOut = Object.values(league.players).filter((p) => p.injury && p.injury.daysRemaining > 300);
    expect(stillOut.length).toBe(0);
  });

  it('completes playoffs, crowns a champion, records history and awards', () => {
    simTo(league, 'endSeason');
    expect(league.phase).toBe('draft');
    const h = league.history.at(-1)!;
    expect(h.champion).not.toBeNull();
    const finalSeries = league.playoffs!.rounds.at(-1)![0];
    expect(finalSeries.winner).toBe(h.champion);
    expect(Math.max(...finalSeries.wins)).toBe(4);
    const names = h.awards.map((a) => a.award);
    for (const k of ['Hart', 'Vezina', 'Norris', 'Calder', 'Conn Smythe', 'Art Ross']) expect(names.some((n) => n.includes(k))).toBe(true);
    expect(league.records.singleSeason.goals.value).toBeGreaterThan(30);
    expect(league.records.team.tPoints.value).toBeGreaterThan(90);
    // Career regular-season points can never trail career goals.
    expect(league.records.career.cPoints.value).toBeGreaterThanOrEqual(league.records.career.cGoals.value);
    // Careers archived.
    const scorer = league.players[league.records.singleSeason.points.playerId!];
    expect(scorer.career.some((c) => c.season === h.season)).toBe(true);
  });

  it('generates news from real events', () => {
    expect(league.news.length).toBeGreaterThan(50);
    const cats = new Set(league.news.map((n) => n.category));
    expect(cats.has('award')).toBe(true);
    expect(cats.has('game') || cats.has('injury')).toBe(true);
  });

  it('advanceDay is a no-op outside of the season phases', () => {
    const before = league.day;
    advanceDay(league);
    expect(league.day).toBe(before);
  });
});
