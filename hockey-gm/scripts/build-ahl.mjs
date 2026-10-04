#!/usr/bin/env node
/**
 * Builds data/ahl/affiliates.json — each NHL club's AHL affiliate and the
 * players on AHL contracts there — from the cached CapWages team pages (run
 * `npm run fetch:contracts` first).
 *
 * Usage: npm run build:ahl
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'scripts/.cache/capwages/teams');
const TEAMS = {
  BOS: 'boston_bruins', BUF: 'buffalo_sabres', DET: 'detroit_red_wings', FLA: 'florida_panthers', MTL: 'montreal_canadiens',
  OTT: 'ottawa_senators', TBL: 'tampa_bay_lightning', TOR: 'toronto_maple_leafs', CAR: 'carolina_hurricanes',
  CBJ: 'columbus_blue_jackets', NJD: 'new_jersey_devils', NYI: 'new_york_islanders', NYR: 'new_york_rangers',
  PHI: 'philadelphia_flyers', PIT: 'pittsburgh_penguins', WSH: 'washington_capitals', CHI: 'chicago_blackhawks',
  COL: 'colorado_avalanche', DAL: 'dallas_stars', MIN: 'minnesota_wild', NSH: 'nashville_predators', STL: 'st_louis_blues',
  UTA: 'utah_mammoth', WPG: 'winnipeg_jets', ANA: 'anaheim_ducks', CGY: 'calgary_flames', EDM: 'edmonton_oilers',
  LAK: 'los_angeles_kings', SJS: 'san_jose_sharks', SEA: 'seattle_kraken', VAN: 'vancouver_canucks', VGK: 'vegas_golden_knights',
};
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const iso = (s) => {
  const m = String(s ?? '').match(/([A-Z][a-z]{2})\w*\.? (\d+),? (\d{4})/);
  return m ? `${m[3]}-${String(MONTHS[m[1]] ?? 1).padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
};
const POS = { LD: 'D', RD: 'D', D: 'D', C: 'C', LW: 'LW', RW: 'RW', F: 'C', W: 'LW', G: 'G' };

const teams = {};
let newest = 0;
for (const [abbr, slug] of Object.entries(TEAMS)) {
  const file = join(CACHE, `${slug}.json`);
  if (!existsSync(file)) {
    console.error(`Missing ${file} — run npm run fetch:contracts first.`);
    process.exit(1);
  }
  newest = Math.max(newest, statSync(file).mtimeMs);
  const club = JSON.parse(readFileSync(file, 'utf8')).ahlClub;
  if (!club) continue;
  teams[abbr] = {
    abbrev: club.abbrev,
    name: club.name,
    players: (club.players ?? []).map((p) => {
      const [last, first] = String(p.docName ?? p.name).split(',').map((s) => s.trim());
      return { first: first ?? '', last: last ?? p.name, born: iso(p.born), pos: POS[p.pos] ?? 'C', term: p.term ?? 1 };
    }),
  };
}
mkdirSync(join(ROOT, 'data/ahl'), { recursive: true });
const asOf = new Date(newest).toISOString().slice(0, 10);
writeFileSync(join(ROOT, 'data/ahl/affiliates.json'), JSON.stringify({ schemaVersion: 1, asOf, source: 'CapWages team pages (AHL affiliate and AHL-contract players)', teams }, null, 1) + '\n');
console.log(`${Object.keys(teams).length} affiliates, ${Object.values(teams).reduce((s, t) => s + t.players.length, 0)} AHL-contract players`);
