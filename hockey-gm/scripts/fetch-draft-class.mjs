#!/usr/bin/env node
/**
 * Builds data/draft/class.json — the real prospects for the game's first draft —
 * from NHL Central Scouting rankings (api-web.nhle.com).
 *
 *  - When Central Scouting has published rankings for the target draft year,
 *    every ranked skater and goalie (North American and International lists)
 *    is written with his rank, club, league and measurements.
 *  - Until then, the class holds the prospects ranked for the previous draft
 *    who went undrafted (they are eligible again), and the game fills the rest
 *    of the class with generated first-time-eligible players.
 *
 * Usage: npm run fetch:draftclass [-- --year 2027]
 * Re-run once Central Scouting publishes the year's rankings (preliminary
 * list in the fall, midterm in January, final in April).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api-web.nhle.com/v1';
const args = process.argv.slice(2);
const year = Number(args[args.indexOf('--year') + 1]) || 2027;
const CATEGORIES = { 1: 'NA-S', 2: 'INT-S', 3: 'NA-G', 4: 'INT-G' };

async function json(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'hockey-gm data import' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function rankings(y) {
  const out = [];
  for (const [id, category] of Object.entries(CATEGORIES)) {
    const d = await json(`${API}/draft/rankings/${y}/${id}`);
    if (!d || d.draftYear !== y) return null;
    for (const r of d.rankings ?? []) {
      const rank = r.finalRank ?? r.midtermRank ?? null;
      if (!rank) continue;
      out.push({
        first: r.firstName,
        last: r.lastName,
        pos: r.positionCode === 'L' ? 'LW' : r.positionCode === 'R' ? 'RW' : r.positionCode,
        shoots: r.shootsCatches ?? null,
        heightIn: r.heightInInches ?? null,
        weightLb: r.weightInPounds ?? null,
        birthDate: r.birthDate ?? null,
        birthCountry: r.birthCountry ?? null,
        club: r.lastAmateurClub ?? null,
        league: r.lastAmateurLeague ?? null,
        category,
        rank,
        stage: r.finalRank ? 'final' : 'midterm',
      });
    }
  }
  return out;
}

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

let prospects = await rankings(year);
let source;
if (prospects?.length) {
  source = `NHL Central Scouting ${year} rankings`;
} else {
  // Previous year's ranked prospects who were not drafted are eligible again.
  const prev = (await rankings(year - 1)) ?? [];
  const picks = (await json(`${API}/draft/picks/${year - 1}/all`))?.picks ?? [];
  const drafted = new Set(picks.map((p) => `${norm(p.firstName?.default)}|${norm(p.lastName?.default)}`));
  prospects = prev.filter((p) => !drafted.has(`${norm(p.first)}|${norm(p.last)}`)).map((p) => ({ ...p, reentry: true }));
  source = `NHL Central Scouting ${year - 1} rankings — undrafted prospects re-entering the ${year} draft (${year} rankings not published yet)`;
}

mkdirSync(join(ROOT, 'data/draft'), { recursive: true });
const asOf = new Date().toISOString().slice(0, 10);
writeFileSync(join(ROOT, 'data/draft/class.json'), JSON.stringify({ schemaVersion: 1, draftYear: year, asOf, source, prospects }, null, 1) + '\n');
console.log(`${prospects.length} prospects for the ${year} draft · ${source}`);
