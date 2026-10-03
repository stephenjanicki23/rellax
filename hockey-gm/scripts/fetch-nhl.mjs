#!/usr/bin/env node
/**
 * Pulls current NHL rosters plus each player's last three regular seasons
 * from the NHL's public stats feed and writes the snapshot the game bundles:
 *   src/engine/data/nhl/rosters.json
 *
 * Usage: npm run fetch:nhl [-- --season 2026]
 * (season = start year of the season the rosters are for; defaults to the
 * current hockey season.)
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const API = 'https://api-web.nhle.com/v1';
const TEAMS = [
  'BOS', 'BUF', 'DET', 'FLA', 'MTL', 'OTT', 'TBL', 'TOR', 'CAR', 'CBJ', 'NJD', 'NYI', 'NYR', 'PHI', 'PIT', 'WSH',
  'CHI', 'COL', 'DAL', 'MIN', 'NSH', 'STL', 'UTA', 'WPG', 'ANA', 'CGY', 'EDM', 'LAK', 'SJS', 'SEA', 'VAN', 'VGK',
];
const HISTORY = 3;

const argSeason = process.argv.indexOf('--season');
const now = new Date();
const season = argSeason > 0 ? Number(process.argv[argSeason + 1]) : now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
const wanted = Array.from({ length: HISTORY }, (_, i) => season - 1 - i); // completed seasons, newest first

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(API + path, { headers: { accept: 'application/json' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${res.status} ${path}`);
      return await res.json();
    } catch (e) {
      if (attempt === 4) throw e;
      await sleep(500 * 2 ** attempt);
    }
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

const text = (v) => (typeof v === 'string' ? v : v?.default ?? '');
const toiSec = (s) => {
  if (typeof s === 'number') return s;
  if (!s) return 0;
  const [m, sec] = String(s).split(':').map(Number);
  return m * 60 + (sec || 0);
};

function seasonLines(landing, goalie) {
  const rows = (landing?.seasonTotals ?? []).filter((r) => r.leagueAbbrev === 'NHL' && r.gameTypeId === 2);
  const lines = [];
  for (const y of wanted) {
    const code = Number(`${y}${y + 1}`);
    const rs = rows.filter((r) => r.season === code);
    if (!rs.length) continue;
    const sum = (k) => rs.reduce((s, r) => s + (Number(r[k]) || 0), 0);
    const gp = sum('gamesPlayed');
    if (!gp) continue;
    if (goalie) {
      const ga = sum('goalsAgainst');
      const sa = sum('shotsAgainst');
      const sv = sa > 0 ? (sa - ga) / sa : rs.reduce((s, r) => s + (r.savePctg ?? 0) * (r.gamesPlayed ?? 0), 0) / gp;
      lines.push({
        season: y, gp, gs: sum('gamesStarted'), w: sum('wins'), l: sum('losses'), otl: sum('otLosses'),
        sv: Math.round(sv * 10000) / 10000,
        gaa: Math.round((rs.reduce((s, r) => s + (r.goalsAgainstAvg ?? 0) * (r.gamesPlayed ?? 0), 0) / gp) * 100) / 100,
        so: sum('shutouts'),
      });
    } else {
      const toi = rs.reduce((s, r) => s + toiSec(r.avgToi) * (r.gamesPlayed ?? 0), 0) / gp;
      const foRows = rs.filter((r) => r.faceoffWinningPctg != null && r.faceoffWinningPctg > 0);
      const fo = foRows.length ? foRows.reduce((s, r) => s + r.faceoffWinningPctg * r.gamesPlayed, 0) / foRows.reduce((s, r) => s + r.gamesPlayed, 0) : null;
      lines.push({
        season: y, gp, g: sum('goals'), a: sum('assists'), pim: sum('pim'), pm: sum('plusMinus'), shots: sum('shots'),
        ppg: sum('powerPlayGoals'), shg: sum('shorthandedGoals'), toi: Math.round(toi),
        fo: fo === null ? null : Math.round(fo * 1000) / 1000,
      });
    }
  }
  return lines;
}

const teams = {};
let count = 0;
for (const abbr of TEAMS) {
  const roster = await get(`/roster/${abbr}/current`);
  if (!roster) throw new Error(`No roster for ${abbr}`);
  const people = [...(roster.forwards ?? []), ...(roster.defensemen ?? []), ...(roster.goalies ?? [])];
  teams[abbr] = await pool(people, 6, async (p) => {
    const goalie = p.positionCode === 'G';
    const landing = await get(`/player/${p.id}/landing`);
    const rec = {
      nhlId: p.id,
      first: text(p.firstName),
      last: text(p.lastName),
      number: p.sweaterNumber ?? null,
      pos: p.positionCode,
      shoots: p.shootsCatches === 'R' ? 'R' : 'L',
      heightCm: p.heightInCentimeters ?? Math.round((p.heightInInches ?? 73) * 2.54),
      weightKg: p.weightInKilograms ?? Math.round((p.weightInPounds ?? 200) * 0.4536),
      birthDate: p.birthDate ?? `${season - 26}-01-01`,
      country: p.birthCountry ?? 'CAN',
    };
    rec[goalie ? 'goalie' : 'skater'] = seasonLines(landing, goalie);
    return rec;
  });
  count += teams[abbr].length;
  console.log(`${abbr}: ${teams[abbr].length} players`);
}

const out = { season, fetchedAt: now.toISOString(), source: 'api-web.nhle.com', teams };
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'engine', 'data', 'nhl', 'rosters.json');
writeFileSync(file, JSON.stringify(out) + '\n');
console.log(`Wrote ${count} players for ${season}-${String(season + 1).slice(2)} to ${file}`);
