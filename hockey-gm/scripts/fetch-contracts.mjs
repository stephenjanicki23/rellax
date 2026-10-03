#!/usr/bin/env node
/**
 * Imports real NHL contracts from CapWages (capwages.com) and writes:
 *   data/contracts/contracts.json   — every contract (current, signed extensions, history) per player
 *   data/transactions/dead_cap.json — buyout charges still on the books
 *
 * Team pages list every player in each organisation (roster, minors, LTIR,
 * dead cap); each player page carries his full contract history with
 * year-by-year salary, signing bonus, performance bonus, cap hit, clauses
 * and retention. Raw pages are cached in scripts/.cache/capwages so a re-run
 * only fetches what is missing (use --refresh to start over).
 *
 * Usage: npm run fetch:contracts [-- --refresh] [--concurrency 3]
 * Money is written in thousands of dollars (game units).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'scripts/.cache/capwages');
const BASE = 'https://capwages.com';
const args = process.argv.slice(2);
const conc = Number(args[args.indexOf('--concurrency') + 1]) || 3;
if (args.includes('--refresh')) rmSync(CACHE, { recursive: true, force: true });
mkdirSync(join(CACHE, 'teams'), { recursive: true });
mkdirSync(join(CACHE, 'players'), { recursive: true });

// Our team abbreviations → CapWages team slugs.
const TEAMS = {
  BOS: 'boston_bruins', BUF: 'buffalo_sabres', DET: 'detroit_red_wings', FLA: 'florida_panthers', MTL: 'montreal_canadiens',
  OTT: 'ottawa_senators', TBL: 'tampa_bay_lightning', TOR: 'toronto_maple_leafs', CAR: 'carolina_hurricanes',
  CBJ: 'columbus_blue_jackets', NJD: 'new_jersey_devils', NYI: 'new_york_islanders', NYR: 'new_york_rangers',
  PHI: 'philadelphia_flyers', PIT: 'pittsburgh_penguins', WSH: 'washington_capitals', CHI: 'chicago_blackhawks',
  COL: 'colorado_avalanche', DAL: 'dallas_stars', MIN: 'minnesota_wild', NSH: 'nashville_predators', STL: 'st_louis_blues',
  UTA: 'utah_mammoth', WPG: 'winnipeg_jets', ANA: 'anaheim_ducks', CGY: 'calgary_flames', EDM: 'edmonton_oilers',
  LAK: 'los_angeles_kings', SJS: 'san_jose_sharks', SEA: 'seattle_kraken', VAN: 'vancouver_canucks', VGK: 'vegas_golden_knights',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(path, cacheFile) {
  if (existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8'));
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(BASE + path, { headers: { 'user-agent': 'hockey-gm contract importer (personal game project)' } });
      if (res.status === 404) return null;
      if ((res.status === 429 || res.status >= 500) && attempt < 8) {
        await sleep((Number(res.headers.get('retry-after')) || 2 * 2 ** Math.min(attempt, 4)) * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${path}`);
      const html = await res.text();
      const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (!m) throw new Error(`No page data in ${path}`);
      const props = JSON.parse(m[1]).props.pageProps;
      writeFileSync(cacheFile, JSON.stringify(props));
      await sleep(250); // be polite
      return props;
    } catch (e) {
      if (attempt >= 4) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

async function pool(items, n, fn) {
  let i = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        await fn(items[k], k);
        if (++done % 100 === 0) console.log(`  ${done}/${items.length}`);
      }
    }),
  );
}

// ───────────────────────────── parsing helpers ─────────────────────────────

/** "$11,250,000" → 11250 (thousands); "" → null */
const money = (s) => {
  if (s === undefined || s === null || s === '') return null;
  const n = Number(String(s).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n / 10) / 100 : null;
};
const seasonOf = (label) => Number(String(label).slice(0, 4));
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
/** League year a date falls in (July 1 starts a new league year). */
function leagueYear(date) {
  const m = String(date ?? '').match(/([A-Z][a-z]{2})\w*\.? (\d+), (\d{4})/);
  if (!m) return null;
  const month = MONTHS[m[1]] ?? 7;
  const year = Number(m[3]);
  return month >= 7 ? year : year - 1;
}

/** Strongest clause in force in one season: "M-NTC, NMC" → NMC. */
function clauseKind(s) {
  const t = String(s ?? '').toUpperCase();
  if (/\bNMC\b/.test(t)) return 'NMC';
  if (/M-NTC/.test(t)) return 'M-NTC';
  if (/\bNTC\b/.test(t)) return 'NTC';
  return null;
}

/** Group per-season clauses into ranges; modified NTC lists get their size from the clause text. */
function clauses(details, text) {
  const out = [];
  const teams = Number(String(text ?? '').match(/(\d+)[- ]team/i)?.[1]) || undefined;
  const mode = /to[- ]trade list|approve|can be traded to/i.test(text ?? '') ? 'approve' : 'block';
  for (const d of details) {
    const kind = clauseKind(d.clause);
    if (!kind) continue;
    const s = seasonOf(d.season);
    const last = out[out.length - 1];
    if (last && last.kind === kind && last.to === s - 1) last.to = s;
    else out.push({ kind, from: s, to: s, ...(kind === 'M-NTC' ? { teams: teams ?? 10, mode } : {}) });
  }
  return out;
}

function contractType(t) {
  if (/entry[- ]level/i.test(t)) return 'ELC';
  return 'standard';
}

// ───────────────────────────── import ─────────────────────────────

console.log('Team pages…');
const teamPages = {};
const nameToAbbr = {};
const slugs = new Set();
const teamOfSlug = {};
await pool(Object.entries(TEAMS), conc, async ([abbr, slug]) => {
  const p = await page(`/teams/${slug}`, join(CACHE, 'teams', `${slug}.json`));
  if (!p) throw new Error(`Team page missing: ${slug}`);
  teamPages[abbr] = p;
  nameToAbbr[p.teamMetadata?.name ?? p.teamName] = abbr;
  const groups = [p.data?.roster, p.data?.['non-roster'], p.data?.inactive, p.data?.['dead cap']];
  for (const g of groups) for (const list of Object.values(g ?? {})) for (const pl of list ?? []) {
    if (!pl?.slug) continue;
    slugs.add(pl.slug);
    teamOfSlug[pl.slug] ??= abbr;
  }
});
const abbrOf = (name) => nameToAbbr[name] ?? null;
console.log(`${slugs.size} players across ${Object.keys(teamPages).length} teams`);

console.log('Player pages…');
const players = {};
await pool([...slugs], conc, async (slug) => {
  try {
    const p = await page(`/players/${slug}`, join(CACHE, 'players', `${slug}.json`));
    if (p?.player) players[slug] = p.player;
  } catch (e) {
    console.warn(`  skip ${slug}: ${e.message}`);
  }
});

const records = [];
const charges = [];
let contractsOut = 0;
for (const [slug, pl] of Object.entries(players)) {
  if (!pl.nhlId) continue;
  const teamAbbr = pl.currentTeamTricode && TEAMS[pl.currentTeamTricode] ? pl.currentTeamTricode : (teamOfSlug[slug] ?? null);
  const contracts = [];
  for (const c of pl.contracts ?? []) {
    const details = (c.details ?? []).filter((d) => money(d.capHit) !== null || money(d.baseSalary) !== null);
    if (!details.length) continue;
    const years = details.map((d) => {
      const total = money(d.totalSalary) ?? 0;
      const sb = money(d.signingBonuses) ?? 0;
      const base = money(d.baseSalary) ?? Math.max(0, total - sb);
      const minors = money(d.minorsSalary);
      const perf = money(d.performanceBonuses) ?? 0;
      // Zero bonuses are omitted to keep the bundled file small.
      return { season: seasonOf(d.season), salary: base, ...(sb ? { signingBonus: sb } : {}), ...(perf ? { perfBonus: perf } : {}), ...(minors !== null && minors < base + sb ? { minorSalary: minors } : {}) };
    });
    const twoWay = years.some((y) => y.minorSalary !== undefined);
    const last = details[details.length - 1];
    // Retention on the most recent season: every team other than the holder ("*" or the current team).
    const retained = [];
    for (const [team, r] of Object.entries(last.retention ?? details.find((d) => d.retention)?.retention ?? {})) {
      const ab = abbrOf(team);
      if (team === '*' || !ab || ab === teamAbbr) continue;
      retained.push({ teamAbbr: ab, pct: Math.round(parseFloat(r.retention) * 100) / 10000 });
    }
    // Buyout: per-season cap charges.
    for (const d of c.details ?? []) {
      if (!d.buyout) continue;
      const ab = abbrOf(d.buyout.teamName);
      const amt = money(d.buyout.capHit);
      if (ab && amt) charges.push({ teamAbbr: ab, season: seasonOf(d.season), amount: amt, kind: 'buyout', playerName: pl.name.split(', ').reverse().join(' '), nhlId: pl.nhlId, note: c.buyout || 'Buyout' });
    }
    contracts.push({
      type: contractType(c.type),
      ...(/extension/i.test(c.type) ? { extension: true } : {}),
      signingTeamAbbr: abbrOf(c.signingTeam),
      signingDate: c.signingDate ?? null,
      signedSeason: leagueYear(c.signingDate) ?? years[0].season - 1,
      expiryStatus: /RFA/i.test(c.expiryStatus ?? '') ? 'RFA' : /UFA/i.test(c.expiryStatus ?? '') ? 'UFA' : undefined,
      ...(/arb/i.test(c.expiryStatus ?? '') ? { arbitrationAtExpiry: true } : {}),
      capHit: money(details.find((d) => money(d.capHit))?.capHit),
      totalValue: money(c.value),
      ...(twoWay ? { twoWay } : {}),
      years,
      ...(clauses(details, c.clauseDetails).length ? { clauses: clauses(details, c.clauseDetails) } : {}),
      ...(retained.length ? { retained } : {}),
      ...(c.buyout ? { boughtOut: true } : {}),
      ...(c.qualifyingOffer ? { qualifyingOffer: money(c.qualifyingOffer) } : {}),
    });
    contractsOut++;
  }
  if (!contracts.length) continue;
  contracts.sort((a, b) => a.years[0].season - b.years[0].season);
  const elcAge = Number(pl.elc_signing_age) || undefined;
  const elc = contracts.find((c) => c.type === 'ELC');
  records.push({
    nhlId: pl.nhlId,
    name: pl.name.split(', ').reverse().join(' '),
    teamAbbr,
    status: pl.status ?? null,
    born: pl.born ?? null,
    pos: pl.officialPosition ?? pl.pos ?? null,
    shoots: pl.shootsCatches ?? null,
    nationality: pl.nationality ?? null,
    number: pl.sweaterNumber ?? null,
    ...(pl.termsWaiversExempt ? { waiversExempt: true } : {}),
    ...(pl.termsSlideCandidate ? { slideCandidate: true } : {}),
    ...(elcAge ? { firstSpcAge: elcAge } : {}),
    ...(elc ? { firstSpcSeason: elc.years[0].season } : {}),
    careerGames: pl.careerGamesPlayed ?? undefined,
    contracts,
  });
}
records.sort((a, b) => a.nhlId - b.nhlId);

const asOf = new Date().toISOString().slice(0, 10);
writeFileSync(
  join(ROOT, 'data/contracts/contracts.json'),
  JSON.stringify({ schemaVersion: 2, asOf, source: 'CapWages (capwages.com) player contract pages', players: records }) + '\n',
);
writeFileSync(join(ROOT, 'data/transactions/dead_cap.json'), JSON.stringify({ schemaVersion: 1, asOf, source: 'CapWages buyout history', charges }, null, 1) + '\n');
console.log(`Wrote ${records.length} players / ${contractsOut} contracts, ${charges.length} buyout charges.`);
