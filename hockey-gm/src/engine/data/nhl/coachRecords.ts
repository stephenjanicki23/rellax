/**
 * Real NHL head-coaching records from data/coaches/records.json (built by
 * `npm run fetch:coaches` from the NHL feed's box scores: every game names
 * both head coaches, so records are tallied game by game).
 *
 * Also holds a few hand-kept facts the feed doesn't carry: Jack Adams Award
 * winners and coaches' birth years. Only facts we're confident in are listed;
 * anyone missing gets an estimated birth year that is never shown.
 */
import RECORDS_JSON from '../../../../data/coaches/records.json';
import type { CoachSeasonLine } from '../../types';

export interface RealSeasonLine {
  season: number;
  team: string;
  gp: number;
  w: number;
  l: number;
  t: number;
  otl: number;
  pgp: number;
  pw: number;
  pl: number;
  round: number;
  cup: boolean;
}

interface RecordsFile {
  asOf: string;
  source: string;
  from: number;
  to: number;
  coaches: { name: string; seasons: RealSeasonLine[] }[];
}

const DATA = RECORDS_JSON as unknown as RecordsFile;
const BY_NAME = new Map(DATA.coaches.map((c) => [c.name, c.seasons]));

export function coachRecordsInfo(): { asOf: string; source: string; from: number; to: number; count: number } {
  return { asOf: DATA.asOf, source: DATA.source, from: DATA.from, to: DATA.to, count: DATA.coaches.length };
}

export function realCoachSeasons(name: string): RealSeasonLine[] {
  return BY_NAME.get(name) ?? [];
}

export function allRealCoachNames(): string[] {
  return [...BY_NAME.keys()];
}

/** Jack Adams Award winners (NHL coach of the year), by the season it was won (start year). */
export const JACK_ADAMS: Record<number, string> = {
  2014: 'Bob Hartley',
  2015: 'Barry Trotz',
  2016: 'John Tortorella',
  2017: 'Gerard Gallant',
  2018: 'Barry Trotz',
  2019: 'Bruce Cassidy',
  2020: "Rod Brind'Amour",
  2021: 'Darryl Sutter',
  2022: 'Jim Montgomery',
  2023: 'Rick Tocchet',
  2024: 'Spencer Carbery',
};

/** Birth years of NHL head coaches. */
export const COACH_BIRTH_YEAR: Record<string, number> = {
  'Jon Cooper': 1967, 'Paul Maurice': 1967, 'Mike Sullivan': 1968, 'Jared Bednar': 1972, 'Joel Quenneville': 1958,
  "Rod Brind'Amour": 1970, 'Mike Babcock': 1963, 'Peter DeBoer': 1968, 'Peter Laviolette': 1964, 'Rick Tocchet': 1964,
  'Spencer Carbery': 1981, 'Jim Montgomery': 1969, 'Sheldon Keefe': 1980, 'Lindy Ruff': 1960, 'Rick Bowness': 1955,
  'Martin St. Louis': 1975, 'John Hynes': 1975, 'Todd McLellan': 1967, 'Travis Green': 1970, 'Marco Sturm': 1978,
  'Jeff Blashill': 1973, 'Andrew Brunette': 1973, 'Scott Arniel': 1962, 'Ryan Huska': 1975, 'Glen Gulutzan': 1971,
  'André Tourigny': 1974, 'Lane Lambert': 1964, 'Manny Malhotra': 1980, 'Dan Muse': 1982, 'Ryan Warsofsky': 1987,
  'Bruce Cassidy': 1965, 'John Tortorella': 1958, 'Patrick Roy': 1965, 'Gerard Gallant': 1963, 'Bruce Boudreau': 1955,
  'Darryl Sutter': 1958, 'Claude Julien': 1960, 'Craig Berube': 1965, 'Dan Bylsma': 1970, 'Dave Hakstol': 1968,
  'Barry Trotz': 1962, 'Kris Knoblauch': 1978, 'Dean Evason': 1964, 'Derek Lalonde': 1972, 'Luke Richardson': 1969,
  'Jim Hiller': 1969, 'Ryan Craig': 1982, 'Mike Yeo': 1973, 'Jay Woodcroft': 1976, 'Greg Cronin': 1963, 'Don Granato': 1967,
  'Bob Boughner': 1971, 'David Quinn': 1966, 'Dallas Eakins': 1967, 'Todd Reirden': 1971, 'Bill Peters': 1965,
  'Jeremy Colliton': 1985, 'Ralph Krueger': 1959, 'Dave Lowry': 1965, 'Joe Sacco': 1969, 'Derek King': 1967,
  'Dominique Ducharme': 1973, 'Adam Foote': 1971, 'Brad Larsen': 1977, 'Brad Shaw': 1964, 'D.J. Smith': 1977,
};

/**
 * Former head coaches who now hold front-office jobs (not candidates for a
 * bench job).
 */
export const NOT_COACHING = new Set(['Barry Trotz']);

const ROUND_LABEL = ['Lost qualifying round', 'Lost First Round', 'Lost Second Round', 'Lost Conference Final', 'Lost Stanley Cup Final'];

/** The real record as career lines. `teamIdOf` maps an abbreviation to a league team (null if none). */
export function realCareerLines(name: string, teamIdOf: (abbr: string) => number | null): CoachSeasonLine[] {
  return realCoachSeasons(name).map((s) => ({
    season: s.season,
    teamId: teamIdOf(s.team),
    team: s.team,
    role: 'head',
    gp: s.gp,
    w: s.w,
    l: s.l,
    ...(s.t ? { t: s.t } : {}),
    otl: s.otl,
    pw: s.pw,
    pl: s.pl,
    playoffs: s.cup ? 'Champion' : s.pgp ? ROUND_LABEL[s.round] ?? 'Playoffs' : '—',
    ...(s.cup ? { cup: true } : {}),
    real: true,
  }));
}

/** Summary used to rate real coaches who have no hand-set quality. */
export function realRecordSummary(name: string): { gp: number; ptsPct: number; seriesWins: number; cups: number; first: number | null; last: number | null } {
  const ss = realCoachSeasons(name);
  let gp = 0, pts = 0, seriesWins = 0, cups = 0;
  for (const s of ss) {
    gp += s.gp;
    pts += 2 * s.w + s.t + s.otl;
    // Rounds won: a team that played in round r won every round before it (round 0 is the 2020 qualifier).
    if (s.pgp) seriesWins += Math.max(0, s.round - 1) + (s.cup ? 1 : 0);
    if (s.cup) cups++;
  }
  return { gp, ptsPct: gp ? pts / (2 * gp) : 0, seriesWins, cups, first: ss[0]?.season ?? null, last: ss.at(-1)?.season ?? null };
}
