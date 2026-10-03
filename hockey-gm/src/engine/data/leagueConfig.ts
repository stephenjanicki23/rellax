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
  name: 'National Hockey League',
  shortName: 'NHL',
  championship: 'Stanley Cup',
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
    { abbr: 'BOS', city: 'Boston', name: 'Bruins', arena: 'TD Garden', divisionId: 'ATL', colors: ['#111111', '#ffb81c'], marketSize: 4, appeal: 0.72 },
    { abbr: 'BUF', city: 'Buffalo', name: 'Sabres', arena: 'KeyBank Center', divisionId: 'ATL', colors: ['#003087', '#ffb81c'], marketSize: 2, appeal: 0.4 },
    { abbr: 'DET', city: 'Detroit', name: 'Red Wings', arena: 'Little Caesars Arena', divisionId: 'ATL', colors: ['#ce1126', '#ffffff'], marketSize: 4, appeal: 0.55 },
    { abbr: 'FLA', city: 'Florida', name: 'Panthers', arena: 'Amerant Bank Arena', divisionId: 'ATL', colors: ['#c8102e', '#041e42'], marketSize: 3, appeal: 0.82 },
    { abbr: 'MTL', city: 'Montreal', name: 'Canadiens', arena: 'Bell Centre', divisionId: 'ATL', colors: ['#af1e2d', '#192168'], marketSize: 4, appeal: 0.62 },
    { abbr: 'OTT', city: 'Ottawa', name: 'Senators', arena: 'Canadian Tire Centre', divisionId: 'ATL', colors: ['#c52032', '#000000'], marketSize: 2, appeal: 0.46 },
    { abbr: 'TBL', city: 'Tampa Bay', name: 'Lightning', arena: 'Benchmark International Arena', divisionId: 'ATL', colors: ['#002868', '#ffffff'], marketSize: 3, appeal: 0.84 },
    { abbr: 'TOR', city: 'Toronto', name: 'Maple Leafs', arena: 'Scotiabank Arena', divisionId: 'ATL', colors: ['#00205b', '#ffffff'], marketSize: 5, appeal: 0.68 },
    // Metropolitan
    { abbr: 'CAR', city: 'Carolina', name: 'Hurricanes', arena: 'Lenovo Center', divisionId: 'MET', colors: ['#ce1126', '#000000'], marketSize: 3, appeal: 0.7 },
    { abbr: 'CBJ', city: 'Columbus', name: 'Blue Jackets', arena: 'Nationwide Arena', divisionId: 'MET', colors: ['#002654', '#ce1126'], marketSize: 2, appeal: 0.44 },
    { abbr: 'NJD', city: 'New Jersey', name: 'Devils', arena: 'Prudential Center', divisionId: 'MET', colors: ['#ce1126', '#000000'], marketSize: 4, appeal: 0.6 },
    { abbr: 'NYI', city: 'New York', name: 'Islanders', arena: 'UBS Arena', divisionId: 'MET', colors: ['#00539b', '#f47d30'], marketSize: 4, appeal: 0.62 },
    { abbr: 'NYR', city: 'New York', name: 'Rangers', arena: 'Madison Square Garden', divisionId: 'MET', colors: ['#0038a8', '#ce1126'], marketSize: 5, appeal: 0.8 },
    { abbr: 'PHI', city: 'Philadelphia', name: 'Flyers', arena: 'Xfinity Mobile Arena', divisionId: 'MET', colors: ['#f74902', '#000000'], marketSize: 4, appeal: 0.58 },
    { abbr: 'PIT', city: 'Pittsburgh', name: 'Penguins', arena: 'PPG Paints Arena', divisionId: 'MET', colors: ['#000000', '#fcb514'], marketSize: 3, appeal: 0.56 },
    { abbr: 'WSH', city: 'Washington', name: 'Capitals', arena: 'Capital One Arena', divisionId: 'MET', colors: ['#041e42', '#c8102e'], marketSize: 4, appeal: 0.66 },
    // Central
    { abbr: 'CHI', city: 'Chicago', name: 'Blackhawks', arena: 'United Center', divisionId: 'CEN', colors: ['#cf0a2c', '#000000'], marketSize: 5, appeal: 0.68 },
    { abbr: 'COL', city: 'Colorado', name: 'Avalanche', arena: 'Ball Arena', divisionId: 'CEN', colors: ['#6f263d', '#236192'], marketSize: 3, appeal: 0.76 },
    { abbr: 'DAL', city: 'Dallas', name: 'Stars', arena: 'American Airlines Center', divisionId: 'CEN', colors: ['#006847', '#8f8f8c'], marketSize: 4, appeal: 0.74 },
    { abbr: 'MIN', city: 'Minnesota', name: 'Wild', arena: 'Grand Casino Arena', divisionId: 'CEN', colors: ['#154734', '#a6192e'], marketSize: 3, appeal: 0.56 },
    { abbr: 'NSH', city: 'Nashville', name: 'Predators', arena: 'Bridgestone Arena', divisionId: 'CEN', colors: ['#ffb81c', '#041e42'], marketSize: 3, appeal: 0.7 },
    { abbr: 'STL', city: 'St. Louis', name: 'Blues', arena: 'Enterprise Center', divisionId: 'CEN', colors: ['#002f87', '#fcb514'], marketSize: 3, appeal: 0.54 },
    { abbr: 'UTA', city: 'Utah', name: 'Mammoth', arena: 'Delta Center', divisionId: 'CEN', colors: ['#090909', '#69b3e7'], marketSize: 2, appeal: 0.6 },
    { abbr: 'WPG', city: 'Winnipeg', name: 'Jets', arena: 'Canada Life Centre', divisionId: 'CEN', colors: ['#041e42', '#ac162c'], marketSize: 1, appeal: 0.36 },
    // Pacific
    { abbr: 'ANA', city: 'Anaheim', name: 'Ducks', arena: 'Honda Center', divisionId: 'PAC', colors: ['#fc4c02', '#000000'], marketSize: 3, appeal: 0.8 },
    { abbr: 'CGY', city: 'Calgary', name: 'Flames', arena: 'Scotiabank Saddledome', divisionId: 'PAC', colors: ['#c8102e', '#f1be48'], marketSize: 2, appeal: 0.45 },
    { abbr: 'EDM', city: 'Edmonton', name: 'Oilers', arena: 'Rogers Place', divisionId: 'PAC', colors: ['#041e42', '#ff4c00'], marketSize: 2, appeal: 0.44 },
    { abbr: 'LAK', city: 'Los Angeles', name: 'Kings', arena: 'Crypto.com Arena', divisionId: 'PAC', colors: ['#111111', '#a2aaad'], marketSize: 5, appeal: 0.84 },
    { abbr: 'SJS', city: 'San Jose', name: 'Sharks', arena: 'SAP Center', divisionId: 'PAC', colors: ['#006d75', '#000000'], marketSize: 3, appeal: 0.7 },
    { abbr: 'SEA', city: 'Seattle', name: 'Kraken', arena: 'Climate Pledge Arena', divisionId: 'PAC', colors: ['#001628', '#99d9d9'], marketSize: 4, appeal: 0.7 },
    { abbr: 'VAN', city: 'Vancouver', name: 'Canucks', arena: 'Rogers Arena', divisionId: 'PAC', colors: ['#00205b', '#00843d'], marketSize: 3, appeal: 0.7 },
    { abbr: 'VGK', city: 'Vegas', name: 'Golden Knights', arena: 'T-Mobile Arena', divisionId: 'PAC', colors: ['#b4975a', '#333f42'], marketSize: 3, appeal: 0.78 },
  ],
  season: {
    games: 84,
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
    salaryCap: 104_000,
    capFloor: 76_900,
    minSalary: 850,
    maxContractPct: 0.2,
    capGrowth: 0.03,
    rosterMax: 23,
    rosterMin: 20,
    prospectMax: 25,
    elcYears: 3,
    elcMaxSalary: 1_000,
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
