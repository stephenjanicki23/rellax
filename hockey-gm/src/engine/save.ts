/**
 * Save / load. A League is plain JSON, so saving is serialisation plus a
 * version stamp and light migrations for older saves.
 */
import type { League } from './types';
import { SAVE_VERSION } from './league/create';

export interface SaveMeta {
  id: string;
  name: string;
  teamName: string;
  season: number;
  phase: string;
  day: number;
  savedAt: number;
  version: number;
}

export interface SaveFile {
  format: 'hockey-gm-save';
  meta: SaveMeta;
  league: League;
}

export function saveMeta(league: League, id: string): SaveMeta {
  const t = league.teams[league.userTeamId];
  return {
    id,
    name: league.name,
    teamName: `${t.city} ${t.name}`,
    season: league.season,
    phase: league.phase,
    day: league.day,
    savedAt: Date.now(),
    version: league.version,
  };
}

export function serializeLeague(league: League, id: string): string {
  const file: SaveFile = { format: 'hockey-gm-save', meta: saveMeta(league, id), league };
  return JSON.stringify(file);
}

/** Bring older saves up to date. Each step must be idempotent. */
function migrate(league: League): League {
  const defaults = { godMode: false, injuryRate: 1, tradeDifficulty: 1, autoManageUser: false };
  league.settings = Object.assign(defaults, league.settings);
  league.projections ??= {};
  league.ratingBaseline ??= 120;
  league.aiMemory ??= {};
  for (const t of league.teams) league.aiMemory[t.id] ??= { lastTradeDay: -100, coachHotSeat: 0 };
  for (const p of Object.values(league.players)) p.caHistory ??= [];
  league.tradeOffers ??= [];
  league.version = SAVE_VERSION;
  return league;
}

export function deserializeLeague(text: string): { meta: SaveMeta; league: League } {
  const data = JSON.parse(text) as Partial<SaveFile> & Partial<League>;
  if (data.format === 'hockey-gm-save' && data.league && data.meta) {
    if (data.league.version > SAVE_VERSION) throw new Error('This save was made with a newer version of the game.');
    return { meta: data.meta, league: migrate(data.league) };
  }
  // Bare league JSON.
  if ((data as League).teams && (data as League).players) {
    const league = migrate(data as League);
    return { meta: saveMeta(league, `import-${Date.now()}`), league };
  }
  throw new Error('Not a valid save file.');
}
