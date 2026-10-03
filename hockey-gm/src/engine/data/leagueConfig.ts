/**
 * Data-driven league structure. Teams, divisions, conferences, schedule size,
 * playoff format and economics all live here so the league can be reshaped
 * without touching engine code.
 */

export interface TeamSeed {
  abbr: string;
  city: string;
  name: string;
  arena: string;
  divisionId: string;
  colors: [string, string];
  /** 1 (small) – 5 (huge). Drives budget and free-agent appeal. */
  marketSize: number;
  /** 0-1 desirability as a place to live/play. */
  appeal: number;
}

export interface LeagueConfig {
  name: string;
  shortName: string;
  championship: string;
  conferences: { id: string; name: string }[];
  divisions: { id: string; name: string; conferenceId: string }[];
  teams: TeamSeed[];
  season: {
    games: number;
    /** Games vs each opponent in the same division / conference / other conference (targets). */
    divisionGames: number;
    conferenceGames: number;
    interConferenceGames: number;
    tradeDeadlineFraction: number;
    regularSeasonOT: { minutes: number; skaters: number; shootout: boolean };
  };
  playoffs: {
    /** 'divisional' = top N per division + wildcards per conference; 'conference' = top N per conference. */
    format: 'divisional' | 'conference';
    teamsPerConference: number;
    divisionQualifiers: number;
    seriesLength: number[]; // per round
  };
  economics: {
    salaryCap: number;
    capFloor: number;
    minSalary: number;
    maxContractPct: number;
    capGrowth: number;
    rosterMax: number;
    rosterMin: number;
    prospectMax: number;
    elcYears: number;
    elcMaxSalary: number;
  };
  draft: { rounds: number; lotteryTeams: number; lotteryDraws: number };
}

export const DEFAULT_CONFIG: LeagueConfig = {
  name: 'Premier Hockey League',
  shortName: 'PHL',
  championship: 'Dominion Cup',
  conferences: [
    { id: 'E', name: 'Eastern Conference' },
    { id: 'W', name: 'Western Conference' },
  ],
  divisions: [
    { id: 'ATL', name: 'Atlantic', conferenceId: 'E' },
    { id: 'MET', name: 'Metropolitan', conferenceId: 'E' },
    { id: 'CEN', name: 'Central', conferenceId: 'W' },
    { id: 'PAC', name: 'Pacific', conferenceId: 'W' },
  ],
  teams: [
    // Atlantic
    { abbr: 'BOS', city: 'Boston', name: 'Harbormen', arena: 'Seaport Garden', divisionId: 'ATL', colors: ['#0b3d5c', '#f2b632'], marketSize: 4, appeal: 0.72 },
    { abbr: 'MTL', city: 'Montreal', name: 'Voyageurs', arena: 'Centre Laurentien', divisionId: 'ATL', colors: ['#a6192e', '#1c3f94'], marketSize: 4, appeal: 0.66 },
    { abbr: 'TOR', city: 'Toronto', name: 'Lynx', arena: 'Lakeshore Arena', divisionId: 'ATL', colors: ['#1d3b8f', '#e8e8e8'], marketSize: 5, appeal: 0.7 },
    { abbr: 'BUF', city: 'Buffalo', name: 'Blizzard', arena: 'Niagara Center', divisionId: 'ATL', colors: ['#5aa9e6', '#ffffff'], marketSize: 2, appeal: 0.4 },
    { abbr: 'OTT', city: 'Ottawa', name: 'Sentinels', arena: 'Rideau Place', divisionId: 'ATL', colors: ['#c8102e', '#111111'], marketSize: 2, appeal: 0.48 },
    { abbr: 'QUE', city: 'Quebec City', name: 'Citadels', arena: 'Colisée Champlain', divisionId: 'ATL', colors: ['#2a5caa', '#d7263d'], marketSize: 2, appeal: 0.5 },
    { abbr: 'HFD', city: 'Hartford', name: 'Foresters', arena: 'Charter Oak Arena', divisionId: 'ATL', colors: ['#00573f', '#a2aaad'], marketSize: 2, appeal: 0.46 },
    { abbr: 'HAL', city: 'Halifax', name: 'Mariners', arena: 'Citadel Hill Centre', divisionId: 'ATL', colors: ['#003b5c', '#7fc8f8'], marketSize: 1, appeal: 0.44 },
    // Metropolitan
    { abbr: 'NYE', city: 'New York', name: 'Empire', arena: 'Hudson Square Garden', divisionId: 'MET', colors: ['#002d72', '#c8102e'], marketSize: 5, appeal: 0.8 },
    { abbr: 'PHI', city: 'Philadelphia', name: 'Liberty', arena: 'Independence Arena', divisionId: 'MET', colors: ['#f74902', '#000000'], marketSize: 4, appeal: 0.6 },
    { abbr: 'PIT', city: 'Pittsburgh', name: 'Forge', arena: 'Three Rivers Ice Palace', divisionId: 'MET', colors: ['#111111', '#fcb514'], marketSize: 3, appeal: 0.55 },
    { abbr: 'WSH', city: 'Washington', name: 'Monuments', arena: 'Capitol Ice Center', divisionId: 'MET', colors: ['#041e42', '#c8102e'], marketSize: 4, appeal: 0.65 },
    { abbr: 'BAL', city: 'Baltimore', name: 'Harbor Hawks', arena: 'Inner Harbor Arena', divisionId: 'MET', colors: ['#3a2f6b', '#ff8200'], marketSize: 3, appeal: 0.52 },
    { abbr: 'CBJ', city: 'Columbus', name: 'Pioneers', arena: 'Scioto Arena', divisionId: 'MET', colors: ['#002654', '#ce1126'], marketSize: 2, appeal: 0.45 },
    { abbr: 'CHA', city: 'Charlotte', name: 'Monarchs', arena: 'Queen City Coliseum', divisionId: 'MET', colors: ['#5b2c83', '#00a3ad'], marketSize: 3, appeal: 0.62 },
    { abbr: 'ATL', city: 'Atlanta', name: 'Firebirds', arena: 'Peachtree Ice Dome', divisionId: 'MET', colors: ['#b5121b', '#f2a900'], marketSize: 4, appeal: 0.64 },
    // Central
    { abbr: 'CHI', city: 'Chicago', name: 'Gales', arena: 'Lakefront Center', divisionId: 'CEN', colors: ['#cf0a2c', '#000000'], marketSize: 5, appeal: 0.7 },
    { abbr: 'DET', city: 'Detroit', name: 'Motormen', arena: 'Woodward Arena', divisionId: 'CEN', colors: ['#ce1126', '#ffffff'], marketSize: 4, appeal: 0.5 },
    { abbr: 'MIN', city: 'Minnesota', name: 'Lumberjacks', arena: 'North Woods Center', divisionId: 'CEN', colors: ['#154734', '#a6192e'], marketSize: 3, appeal: 0.55 },
    { abbr: 'WPG', city: 'Winnipeg', name: 'Huskies', arena: 'Red River Place', divisionId: 'CEN', colors: ['#041e42', '#a2aaad'], marketSize: 1, appeal: 0.35 },
    { abbr: 'STL', city: 'St. Louis', name: 'Riverhawks', arena: 'Gateway Arena', divisionId: 'CEN', colors: ['#002f87', '#fcb514'], marketSize: 3, appeal: 0.52 },
    { abbr: 'DEN', city: 'Denver', name: 'Summit', arena: 'Front Range Arena', divisionId: 'CEN', colors: ['#6f263d', '#236192'], marketSize: 3, appeal: 0.74 },
    { abbr: 'DAL', city: 'Dallas', name: 'Rattlers', arena: 'Trinity Ice Center', divisionId: 'CEN', colors: ['#006847', '#8f8f8c'], marketSize: 4, appeal: 0.7 },
    { abbr: 'KCS', city: 'Kansas City', name: 'Stampede', arena: 'Prairie Fire Arena', divisionId: 'CEN', colors: ['#0e3386', '#c09a5b'], marketSize: 2, appeal: 0.5 },
    // Pacific
    { abbr: 'VAN', city: 'Vancouver', name: 'Orcas', arena: 'Pacific Rim Arena', divisionId: 'PAC', colors: ['#00205b', '#00843d'], marketSize: 3, appeal: 0.72 },
    { abbr: 'SEA', city: 'Seattle', name: 'Totems', arena: 'Sound Arena', divisionId: 'PAC', colors: ['#001628', '#99d9d9'], marketSize: 4, appeal: 0.7 },
    { abbr: 'SFF', city: 'San Francisco', name: 'Fog', arena: 'Bayside Center', divisionId: 'PAC', colors: ['#5f6a72', '#e35205'], marketSize: 4, appeal: 0.78 },
    { abbr: 'LAS', city: 'Los Angeles', name: 'Stars', arena: 'Sunset Arena', divisionId: 'PAC', colors: ['#111111', '#a2aaad'], marketSize: 5, appeal: 0.85 },
    { abbr: 'SDT', city: 'San Diego', name: 'Tritons', arena: 'Mission Bay Arena', divisionId: 'PAC', colors: ['#00467f', '#f4b223'], marketSize: 3, appeal: 0.82 },
    { abbr: 'POR', city: 'Portland', name: 'Rapids', arena: 'Willamette Center', divisionId: 'PAC', colors: ['#00482b', '#d69a00'], marketSize: 2, appeal: 0.6 },
    { abbr: 'CGY', city: 'Calgary', name: 'Mavericks', arena: 'Chinook Centre', divisionId: 'PAC', colors: ['#c8102e', '#f1be48'], marketSize: 2, appeal: 0.45 },
    { abbr: 'EDM', city: 'Edmonton', name: 'Prospectors', arena: 'Gold Rush Arena', divisionId: 'PAC', colors: ['#041e42', '#fc4c02'], marketSize: 2, appeal: 0.42 },
  ],
  season: {
    games: 82,
    divisionGames: 4,
    conferenceGames: 3,
    interConferenceGames: 2,
    tradeDeadlineFraction: 0.72,
    regularSeasonOT: { minutes: 5, skaters: 3, shootout: true },
  },
  playoffs: {
    format: 'divisional',
    teamsPerConference: 8,
    divisionQualifiers: 3,
    seriesLength: [7, 7, 7, 7],
  },
  economics: {
    salaryCap: 92_000,
    capFloor: 68_000,
    minSalary: 775,
    maxContractPct: 0.2,
    capGrowth: 0.03,
    rosterMax: 23,
    rosterMin: 20,
    prospectMax: 25,
    elcYears: 3,
    elcMaxSalary: 950,
  },
  draft: { rounds: 7, lotteryTeams: 16, lotteryDraws: 2 },
};

export function conferenceOfDivision(cfg: LeagueConfig, divisionId: string): string {
  const d = cfg.divisions.find((x) => x.id === divisionId);
  if (!d) throw new Error(`Unknown division ${divisionId}`);
  return d.conferenceId;
}

/** Throws if the config is internally inconsistent. */
export function validateConfig(cfg: LeagueConfig): void {
  const confIds = new Set(cfg.conferences.map((c) => c.id));
  for (const d of cfg.divisions) {
    if (!confIds.has(d.conferenceId)) throw new Error(`Division ${d.id} references unknown conference`);
  }
  const divIds = new Set(cfg.divisions.map((d) => d.id));
  const abbrs = new Set<string>();
  for (const t of cfg.teams) {
    if (!divIds.has(t.divisionId)) throw new Error(`Team ${t.abbr} references unknown division`);
    if (abbrs.has(t.abbr)) throw new Error(`Duplicate team abbreviation ${t.abbr}`);
    abbrs.add(t.abbr);
  }
  if (cfg.teams.length < 4) throw new Error('A league needs at least 4 teams');
}
