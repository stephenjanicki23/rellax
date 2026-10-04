#!/usr/bin/env node
/**
 * Builds real draft data from the cached CapWages team pages (run
 * `npm run fetch:contracts` first so scripts/.cache/capwages/teams is filled):
 *
 *   data/draft/picks.json        — who owns every future pick (traded picks and conditions included)
 *   data/prospects/reserves.json — each team's unsigned draft picks (reserve list) with sign-by deadlines
 *
 * Usage: npm run build:draft
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'scripts/.cache/capwages/teams');

// Our team abbreviations → CapWages team slugs (same table as fetch-contracts.mjs).
const TEAMS = {
  BOS: 'boston_bruins', BUF: 'buffalo_sabres', DET: 'detroit_red_wings', FLA: 'florida_panthers', MTL: 'montreal_canadiens',
  OTT: 'ottawa_senators', TBL: 'tampa_bay_lightning', TOR: 'toronto_maple_leafs', CAR: 'carolina_hurricanes',
  CBJ: 'columbus_blue_jackets', NJD: 'new_jersey_devils', NYI: 'new_york_islanders', NYR: 'new_york_rangers',
  PHI: 'philadelphia_flyers', PIT: 'pittsburgh_penguins', WSH: 'washington_capitals', CHI: 'chicago_blackhawks',
  COL: 'colorado_avalanche', DAL: 'dallas_stars', MIN: 'minnesota_wild', NSH: 'nashville_predators', STL: 'st_louis_blues',
  UTA: 'utah_mammoth', WPG: 'winnipeg_jets', ANA: 'anaheim_ducks', CGY: 'calgary_flames', EDM: 'edmonton_oilers',
  LAK: 'los_angeles_kings', SJS: 'san_jose_sharks', SEA: 'seattle_kraken', VAN: 'vancouver_canucks', VGK: 'vegas_golden_knights',
};

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
function isoDate(s) {
  const m = String(s ?? '').match(/([A-Z][a-z]{2})\w*\.? (\d+),? (\d{4})/);
  if (!m) return null;
  return `${m[3]}-${String(MONTHS[m[1]] ?? 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}
const POS = { LD: 'D', RD: 'D', D: 'D', C: 'C', LW: 'LW', RW: 'RW', F: 'C', W: 'LW', G: 'G' };

const pages = {};
let newest = 0;
for (const [abbr, slug] of Object.entries(TEAMS)) {
  const file = join(CACHE, `${slug}.json`);
  if (!existsSync(file)) {
    console.error(`Missing ${file} — run npm run fetch:contracts first.`);
    process.exit(1);
  }
  pages[abbr] = JSON.parse(readFileSync(file, 'utf8'));
  newest = Math.max(newest, statSync(file).mtimeMs);
}
const asOf = new Date(newest).toISOString().slice(0, 10);

// Team names as they appear on pick rows ("Montreal Canadiens", "Montréal Canadiens", "Utah Mammoth"…).
const byName = new Map();
for (const [abbr, p] of Object.entries(pages)) {
  for (const n of [p.teamName, p.teamMetadata?.name, p.teamMetadata?.label]) if (n) byName.set(norm(n), abbr);
}
const abbrOf = (name) => byName.get(norm(name)) ?? null;
/** First team named in a trade note other than `except` (the receiving club). */
function teamIn(text, except) {
  const t = norm(text);
  let best = null;
  for (const [n, abbr] of byName) {
    if (abbr === except) continue;
    const i = t.indexOf(n);
    if (i >= 0 && (best === null || i < best.i)) best = { i, abbr };
  }
  return best?.abbr ?? null;
}

// ── Pick ownership
const owned = new Map(); // "year-round-ORIG" → pick
const away = new Map();
for (const [abbr, page] of Object.entries(pages)) {
  for (const row of page.draftPicks ?? []) {
    const original = abbrOf(row.team);
    if (!original) {
      console.warn(`Unknown team on pick row: ${row.team}`);
      continue;
    }
    const key = `${row.year}-${row.round}-${original}`;
    if (row.isTradedAway) {
      away.set(key, row);
      continue;
    }
    const raw = row.conditions == null ? [] : Array.isArray(row.conditions) ? row.conditions : [row.conditions];
    const conditions = raw.map((c) => (typeof c === 'string' ? c : (c?.text ?? c?.description ?? JSON.stringify(c)))).filter(Boolean);
    if (owned.has(key)) console.warn(`Pick ${key} listed by ${owned.get(key).owner} and ${abbr}; keeping the first.`);
    else owned.set(key, { year: Number(row.year), round: row.round, original, owner: abbr, ...(conditions.length ? { conditions } : {}) });
  }
}
let inferred = 0;
for (const [key, row] of away) {
  if (owned.has(key)) continue;
  // Traded away but no club lists it: read the receiving team from the trade note.
  const [year, round, original] = key.split('-');
  const owner = teamIn(row.tradeDetails ?? '', original);
  if (!owner) {
    console.warn(`Pick ${key} was traded away but its new owner is unknown; left with ${original}.`);
    continue;
  }
  inferred++;
  owned.set(key, { year: Number(year), round: Number(round), original, owner, note: 'owner inferred from trade note' });
}
const picks = [...owned.values()].sort((a, b) => a.year - b.year || a.round - b.round || a.original.localeCompare(b.original));
const traded = picks.filter((p) => p.owner !== p.original).length;

// ── Reserve lists (unsigned draft picks)
const prospects = [];
for (const [abbr, page] of Object.entries(pages)) {
  for (const r of page.reserves ?? []) {
    const [last, first] = String(r.name).split(',').map((s) => s.trim());
    prospects.push({
      team: abbr,
      first: first ?? '',
      last: last ?? r.name,
      slug: r.slug,
      born: isoDate(r.born),
      pos: POS[r.pos] ?? 'C',
      draftedBy: r.draftedBy,
      draftYear: Number(r.draftYear) || null,
      round: Number(r.round) || null,
      overall: Number(r.overall) || null,
      mustSignBy: isoDate(r.mustSignBy),
    });
  }
}

mkdirSync(join(ROOT, 'data/draft'), { recursive: true });
mkdirSync(join(ROOT, 'data/prospects'), { recursive: true });
writeFileSync(join(ROOT, 'data/draft/picks.json'), JSON.stringify({ schemaVersion: 1, asOf, source: 'CapWages team pages', picks }, null, 1) + '\n');
writeFileSync(join(ROOT, 'data/prospects/reserves.json'), JSON.stringify({ schemaVersion: 1, asOf, source: 'CapWages reserve lists', prospects }, null, 1) + '\n');
console.log(`picks: ${picks.length} (${traded} traded, ${inferred} owners inferred) · prospects: ${prospects.length} · as of ${asOf}`);
