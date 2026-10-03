import type { StatLine } from '../types';

const KEYS: (keyof StatLine)[] = [
  'gp', 'g', 'a1', 'a2', 'pm', 'pim', 'sog', 'att', 'missed', 'blockedAtt', 'hits', 'blocks', 'tk', 'gv', 'fow', 'fol',
  'toi', 'toiES', 'toiPP', 'toiPK', 'ppg', 'ppa', 'shg', 'sha', 'gwg', 'ixg', 'ixa', 'cf', 'ca', 'xgf', 'xga',
  'gs', 'w', 'l', 'otl', 'sa', 'ga', 'so', 'gxga', 'hdsa', 'hdga', 'reb', 'gtoi',
];

export function emptyStatLine(): StatLine {
  const s = {} as StatLine;
  for (const k of KEYS) s[k] = 0;
  return s;
}

export function addStatLine(into: StatLine, from: StatLine): StatLine {
  for (const k of KEYS) into[k] += from[k];
  return into;
}

export const assists = (s: StatLine): number => s.a1 + s.a2;
export const points = (s: StatLine): number => s.g + s.a1 + s.a2;
export const shootingPct = (s: StatLine): number => (s.sog ? s.g / s.sog : 0);
export const savePct = (s: StatLine): number => (s.sa ? (s.sa - s.ga) / s.sa : 0);
export const gaa = (s: StatLine): number => (s.gtoi ? (s.ga * 3600) / s.gtoi : 0);
export const gsax = (s: StatLine): number => s.gxga - s.ga;
export const hdSavePct = (s: StatLine): number => (s.hdsa ? (s.hdsa - s.hdga) / s.hdsa : 0);
export const faceoffPct = (s: StatLine): number => (s.fow + s.fol ? s.fow / (s.fow + s.fol) : 0);
export const toiPerGame = (s: StatLine): number => (s.gp ? s.toi / s.gp / 60 : 0);
export const corsiPct = (s: StatLine): number => (s.cf + s.ca ? s.cf / (s.cf + s.ca) : 0.5);
export const xgPct = (s: StatLine): number => (s.xgf + s.xga ? s.xgf / (s.xgf + s.xga) : 0.5);
export const ppPoints = (s: StatLine): number => s.ppg + s.ppa;
export const reboundRate = (s: StatLine): number => (s.sa - s.ga ? s.reb / (s.sa - s.ga) : 0);

export function fmtToi(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Round fractional fields (xG etc.) for compact archival storage. */
export function compactStatLine(s: StatLine): StatLine {
  const out = { ...s };
  for (const k of KEYS) if (!Number.isInteger(out[k])) out[k] = Math.round(out[k] * 100) / 100;
  return out;
}
