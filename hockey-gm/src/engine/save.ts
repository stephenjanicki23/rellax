/**
 * Save / load. A League is plain JSON, so saving is serialisation plus a
 * version stamp and light migrations for older saves.
 */
import type { League } from './types';
import { SAVE_VERSION } from './league/create';
import { newAhlState } from './league/ahl';
import { emptyFinancialState } from './cba/import';
import { buildContract } from './cba/contract';
import { capSeason } from './cba/capManager';
import { determineFreeAgentStatus } from './cba/rulesEngine';

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
  league.ahl ??= newAhlState(league.teams, league.season);
  // v2: NHL contract & cap system.
  const fin = emptyFinancialState();
  league.capLedger ??= fin.capLedger;
  league.ltir ??= fin.ltir;
  league.waivers ??= fin.waivers;
  league.qualifyingOffers ??= fin.qualifyingOffers;
  league.arbitration ??= fin.arbitration;
  league.offerSheets ??= fin.offerSheets;
  league.negotiations ??= fin.negotiations;
  league.nextContractId ??= 1;
  const books = capSeason(league);
  const upgrade = (c: NonNullable<(typeof league.players)[number]['contract']>, start: number) => {
    if (c.yearsDetail?.length) return c;
    const years = Math.max(1, c.years);
    const full = buildContract({ startSeason: start, salaries: new Array(years).fill(c.salary), type: c.type, clauses: c.ntc ? [{ kind: 'NTC', from: start, to: start + years - 1 }] : [], signedSeason: c.signedSeason, source: 'game', origin: 'signing' }, books);
    full.id = league.nextContractId++;
    return full;
  };
  for (const p of Object.values(league.players)) {
    if (!p.contract) continue;
    const legacyNext = p.contract.next as unknown as { salary: number; years: number; ntc: boolean } | undefined;
    const hadDetail = !!p.contract.yearsDetail?.length;
    p.contract = upgrade(p.contract, p.contract.years <= 0 ? books - 1 : books);
    if (!hadDetail && legacyNext) {
      const end = books + Math.max(1, p.contract.years) - 1;
      p.contract.next = upgrade({ salary: legacyNext.salary, years: legacyNext.years, type: 'standard', ntc: legacyNext.ntc, signedSeason: league.season }, end + 1);
    }
    p.contract.expiryStatus ??= determineFreeAgentStatus(p, p.contract.endSeason ?? books).status;
    p.contractHistory ??= [{ teamId: p.teamId, signingTeamId: p.teamId, startSeason: p.contract.startSeason ?? books, endSeason: p.contract.endSeason ?? books, years: p.contract.yearsDetail?.length ?? 1, totalValue: (p.contract.yearsDetail ?? []).reduce((s, y) => s + y.salary + y.signingBonus, 0), aav: p.contract.salary, type: p.contract.type, origin: p.contract.origin, source: p.contract.source }];
  }
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
