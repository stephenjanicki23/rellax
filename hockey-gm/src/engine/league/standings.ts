import type { League, Team, TeamRecord } from '../types';
import type { GameResult } from '../sim/gameTypes';
import { emptyRecord, points } from './helpers';

export interface StandingRow {
  team: Team;
  rec: TeamRecord;
  pts: number;
  pct: number;
  gd: number;
}

export function applyToStandings(league: League, home: number, away: number, r: GameResult): void {
  const hr = (league.standings[home] ??= emptyRecord());
  const ar = (league.standings[away] ??= emptyRecord());
  const homeWin = r.homeGoals > r.awayGoals;
  const sides: [TeamRecord, TeamRecord] = [hr, ar];
  for (const i of [0, 1] as const) {
    const rec = sides[i];
    const ts = r.teams[i];
    const os = r.teams[1 - i];
    const won = i === 0 ? homeWin : !homeWin;
    rec.gp++;
    rec.gf += i === 0 ? r.homeGoals : r.awayGoals;
    rec.ga += i === 0 ? r.awayGoals : r.homeGoals;
    const split = i === 0 ? rec.home : rec.away;
    if (won) {
      rec.w++;
      split[0]++;
      if (!r.so) rec.row++;
      if (!r.ot) rec.rw++;
      rec.streak = rec.streak > 0 ? rec.streak + 1 : 1;
      rec.last10.push('W');
    } else if (r.ot) {
      rec.otl++;
      split[2]++;
      rec.streak = rec.streak < 0 ? rec.streak - 1 : -1;
      rec.last10.push('O');
    } else {
      rec.l++;
      split[1]++;
      rec.streak = rec.streak < 0 ? rec.streak - 1 : -1;
      rec.last10.push('L');
    }
    if (rec.last10.length > 10) rec.last10.shift();
    rec.ppOpp += ts.ppOpp;
    rec.ppg += ts.ppg;
    rec.tsh += os.ppOpp;
    rec.ppga += os.ppg;
    rec.sf += ts.shots;
    rec.sa += os.shots;
    rec.xgf += ts.xg;
    rec.xga += os.xg;
    rec.cf += ts.attempts;
    rec.ca += os.attempts;
    rec.hits += ts.hits;
    rec.blocks += ts.blocks;
    rec.fow += ts.fow;
    rec.fol += ts.fol;
    rec.tk += ts.tk;
    rec.gv += ts.gv;
    rec.pim += ts.pim;
  }
}

/** NHL-style tiebreakers: points, points %, regulation wins, ROW, wins, goal differential. */
export function compareRecords(a: TeamRecord, b: TeamRecord): number {
  const pa = points(a);
  const pb = points(b);
  if (pa !== pb) return pb - pa;
  const pcta = a.gp ? pa / (a.gp * 2) : 0;
  const pctb = b.gp ? pb / (b.gp * 2) : 0;
  if (pcta !== pctb) return pctb - pcta;
  if (a.rw !== b.rw) return b.rw - a.rw;
  if (a.row !== b.row) return b.row - a.row;
  if (a.w !== b.w) return b.w - a.w;
  return b.gf - b.ga - (a.gf - a.ga);
}

export function standingRows(league: League, filter?: (t: Team) => boolean): StandingRow[] {
  return league.teams
    .filter((t) => !filter || filter(t))
    .map((team) => {
      const rec = league.standings[team.id] ?? emptyRecord();
      const pts = points(rec);
      return { team, rec, pts, pct: rec.gp ? pts / (rec.gp * 2) : 0, gd: rec.gf - rec.ga };
    })
    .sort((a, b) => compareRecords(a.rec, b.rec) || a.team.id - b.team.id);
}

export function leagueRank(league: League, teamId: number): number {
  return standingRows(league).findIndex((r) => r.team.id === teamId) + 1;
}

export function ppPct(r: TeamRecord): number {
  return r.ppOpp ? r.ppg / r.ppOpp : 0;
}
export function pkPct(r: TeamRecord): number {
  return r.tsh ? 1 - r.ppga / r.tsh : 0;
}
export function recordString(r: TeamRecord): string {
  return `${r.w}-${r.l}-${r.otl}`;
}

/** Playoff seeding for one conference. Returns team ids in seed order with labels. */
export function conferenceSeeds(league: League, conferenceId: string): { teamId: number; seed: number; label: string; divisionId: string }[] {
  const cfg = league.config.playoffs;
  const confTeams = standingRows(league, (t) => t.conferenceId === conferenceId);
  if (cfg.format === 'conference') {
    return confTeams.slice(0, cfg.teamsPerConference).map((r, i) => ({ teamId: r.team.id, seed: i + 1, label: `${i + 1}`, divisionId: r.team.divisionId }));
  }
  const divisions = league.config.divisions.filter((d) => d.conferenceId === conferenceId);
  const qualified: { teamId: number; seed: number; label: string; divisionId: string }[] = [];
  const taken = new Set<number>();
  divisions.forEach((d) => {
    const rows = confTeams.filter((r) => r.team.divisionId === d.id).slice(0, cfg.divisionQualifiers);
    rows.forEach((r, i) => {
      qualified.push({ teamId: r.team.id, seed: 0, label: `${d.name[0]}${i + 1}`, divisionId: d.id });
      taken.add(r.team.id);
    });
  });
  const wildcards = confTeams.filter((r) => !taken.has(r.team.id)).slice(0, cfg.teamsPerConference - qualified.length);
  wildcards.forEach((r, i) => qualified.push({ teamId: r.team.id, seed: 0, label: `WC${i + 1}`, divisionId: r.team.divisionId }));
  // Overall seed number by record (used for home ice).
  const order = confTeams.map((r) => r.team.id);
  qualified.sort((a, b) => order.indexOf(a.teamId) - order.indexOf(b.teamId));
  qualified.forEach((q, i) => (q.seed = i + 1));
  return qualified;
}

/** Points-based playoff race: games behind the last playoff spot for each team in a conference. */
export function playoffRace(league: League, conferenceId: string): { teamId: number; inPosition: boolean; ptsBack: number }[] {
  const seeds = conferenceSeeds(league, conferenceId);
  const inSet = new Set(seeds.map((s) => s.teamId));
  const rows = standingRows(league, (t) => t.conferenceId === conferenceId);
  const cutoff = Math.min(...seeds.map((s) => points(league.standings[s.teamId])));
  return rows.map((r) => ({ teamId: r.team.id, inPosition: inSet.has(r.team.id), ptsBack: inSet.has(r.team.id) ? 0 : cutoff - r.pts }));
}
