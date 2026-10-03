import { clamp } from '../core/math';
import type { League, Lines, Player, Team } from '../types';
import type { GameInput, GamePlayerInput, GameTeamInput } from '../sim/gameTypes';
import { injuryRisk, severityShift } from '../player/injuries';
import { dressedIds, repairLines, autoLines } from '../team/lines';
import { enforcePlayoffCap } from '../cba/capActions';
import { addNews } from './helpers';
import { effectiveCoachRatings } from '../team/coaching';
import { pairChemistry, pairKey } from '../team/chemistry';
import { seedFrom } from '../core/rng';
import { playersOf } from './helpers';

export function toGamePlayer(p: Player, season: number): GamePlayerInput {
  const energy = clamp(100 - p.fatigue * 0.3, 55, 100);
  return {
    id: p.id,
    first: p.first,
    last: p.last,
    number: p.number,
    pos: p.pos,
    archetype: p.archetype,
    attrs: p.attrs,
    age: season - p.birthYear,
    energy,
    form: p.form,
    morale: p.morale,
    confidence: p.confidence,
    injuryRisk: injuryRisk(p, season),
    injurySeverity: severityShift(p, season),
    streaky: p.traits.includes('streaky'),
    playoffRep: p.playoffRep,
  };
}

/** Did this team play yesterday? */
export function playedYesterday(league: League, teamId: number, day: number): boolean {
  return league.schedule.some((g) => g.day === day - 1 && g.played && (g.home === teamId || g.away === teamId));
}

/** Choose tonight's goalie: starters rest on back-to-backs and when worn down. */
export function chooseStarter(league: League, team: Team, lines: Lines, day: number, playoff: boolean, salt: number): Lines {
  const [s, b] = lines.goalies;
  if (b === undefined) return lines;
  const starter = league.players[s];
  const backup = league.players[b];
  if (!starter || !backup) return lines;
  const b2b = playedYesterday(league, team.id, day);
  let pBackup = 0.06;
  if (b2b) pBackup = 0.8;
  if (starter.fatigue > 55) pBackup = Math.max(pBackup, 0.45);
  if (backup.ca > starter.ca - 4) pBackup = Math.max(pBackup, 0.35);
  if (playoff) pBackup = starter.fatigue > 80 ? 0.2 : 0.02;
  const roll = (seedFrom(league.seed, league.season, day, team.id, salt) % 10000) / 10000;
  if (roll < pBackup) return { ...lines, goalies: [b, s] };
  return lines;
}

export function teamGameInput(league: League, team: Team, day: number, playoff: boolean, salt: number): GameTeamInput {
  const roster = playersOf(league, team.id, ['active']);
  if (team.autoLines || team.id !== league.userTeamId) {
    // CPU teams (and users on auto) refresh lines every game.
    team.lines = autoLines(roster);
  } else {
    repairLines(team.lines, roster);
  }
  let lines = chooseStarter(league, team, team.lines, day, playoff, salt);
  if (playoff) {
    // Playoff cap (2025 MOU): dressed cap hits + dead cap must fit under the upper limit.
    const pc = enforcePlayoffCap(league, team.id, lines, dressedIds);
    if (pc.changes.length) {
      lines = pc.lines;
      if (team.id === league.userTeamId)
        addNews(league, { category: 'league', headline: `Playoff cap: lineup adjusted — ${pc.changes.join('; ')}`, body: pc.errors.join(' '), teamIds: [team.id], playerIds: [], importance: 3 });
    }
  }
  const ids = dressedIds(lines);
  const dressed = ids.map((id) => league.players[id]).filter((p): p is Player => !!p);
  const head = team.staff.headCoach !== null ? league.coaches[team.staff.headCoach] : undefined;
  const gk = team.staff.goalieCoach !== null ? league.coaches[team.staff.goalieCoach] : undefined;
  const asst = team.staff.assistant !== null ? league.coaches[team.staff.assistant] : undefined;
  const chemCache = new Map<string, number>();
  const chemistry = (a: number, b: number): number => {
    const k = pairKey(a, b);
    let v = chemCache.get(k);
    if (v === undefined) {
      const pa = league.players[a];
      const pb = league.players[b];
      v = pa && pb ? pairChemistry(pa, pb, league.chemistry[k] ?? 0, team.morale) : 0;
      chemCache.set(k, v);
    }
    return v;
  };
  return {
    teamId: team.id,
    abbr: team.abbr,
    name: `${team.city} ${team.name}`,
    players: dressed.map((p) => toGamePlayer(p, league.season)),
    lines,
    tactics: team.tactics,
    coach: effectiveCoachRatings(head, gk, asst),
    chemistry,
    morale: team.morale,
  };
}

export function buildGameInput(league: League, gameId: number, recordEvents = false, seedSalt = 0): GameInput {
  const g = league.schedule.find((x) => x.id === gameId);
  if (!g) throw new Error(`No game ${gameId}`);
  const home = league.teams[g.home];
  const away = league.teams[g.away];
  return {
    home: teamGameInput(league, home, g.day, !!g.playoff, 0),
    away: teamGameInput(league, away, g.day, !!g.playoff, 1),
    seed: seedFrom(league.seed, league.season, g.id, seedSalt),
    playoff: !!g.playoff,
    recordEvents,
    regularSeasonOT: league.config.season.regularSeasonOT,
    ratingBaseline: league.ratingBaseline ?? 120,
  };
}
