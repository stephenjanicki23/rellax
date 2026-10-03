/**
 * Shape of the real-NHL roster snapshot (`rosters.json`), produced by
 * `scripts/fetch-nhl.mjs` from the NHL's public stats feed.
 */
export interface NhlSkaterSeason {
  /** Season start year, e.g. 2025 for 2025-26. */
  season: number;
  gp: number;
  g: number;
  a: number;
  pim: number;
  pm: number;
  shots: number;
  ppg: number;
  shg: number;
  /** Average time on ice per game, in seconds. */
  toi: number;
  /** Faceoff win share 0–1 (centres), or null. */
  fo: number | null;
}

export interface NhlGoalieSeason {
  season: number;
  gp: number;
  gs: number;
  w: number;
  l: number;
  otl: number;
  /** Save percentage 0–1. */
  sv: number;
  gaa: number;
  so: number;
}

export interface NhlPlayerRecord {
  nhlId: number;
  first: string;
  last: string;
  number: number | null;
  pos: 'C' | 'L' | 'R' | 'D' | 'G';
  shoots: 'L' | 'R';
  heightCm: number;
  weightKg: number;
  /** YYYY-MM-DD */
  birthDate: string;
  /** ISO-3 country code. */
  country: string;
  /** Recent NHL regular seasons, newest first. */
  skater?: NhlSkaterSeason[];
  goalie?: NhlGoalieSeason[];
}

export interface NhlSnapshot {
  /** Season the rosters are for (start year). */
  season: number;
  fetchedAt: string | null;
  source: string;
  /** Team abbreviation → current roster. */
  teams: Record<string, NhlPlayerRecord[]>;
}
