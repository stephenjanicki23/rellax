#!/usr/bin/env node
/**
 * Adds a draft ranking you provide (e.g. copied from a public big board) to
 * data/draft/class.json so those prospects lead the game's first draft class.
 *
 * Input: a CSV file with a header row. Columns (case-insensitive, any order):
 *   rank, name (or first + last), pos, born (YYYY-MM-DD or year), club, league, nation, shoots, height (cm or 6'1"), weight (lbs or kg)
 * Only rank, name and pos are required.
 *
 * Usage: npm run import:draftboard -- data/draft/board.csv
 * Re-running replaces the previously imported board (Central Scouting data is kept).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run import:draftboard -- <board.csv>');
  process.exit(1);
}

function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (q && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = !q;
      } else if (c === ',' && !q) {
        cells.push(cur.trim());
        cur = '';
      } else cur += c;
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  return rows;
}

const NA = /OHL|WHL|QMJHL|LHJMQ|USHL|NCAA|USNTDP|NTDP|BIG ?10|NCHC|HOCKEY EAST|ECAC|CCHA|BCHL|AJHL|NAHL|HIGH|PREP|USDP/i;
const POS = { C: 'C', LW: 'LW', RW: 'RW', L: 'LW', R: 'RW', W: 'LW', F: 'C', D: 'D', LD: 'D', RD: 'D', G: 'G' };

const [head, ...body] = parseCsv(readFileSync(file, 'utf8'));
const col = (name) => head.findIndex((h) => h.toLowerCase().replace(/[^a-z]/g, '') === name);
const ix = { rank: col('rank'), name: col('name'), first: col('first'), last: col('last'), pos: col('pos'), born: col('born'), club: col('club'), league: col('league'), nation: col('nation'), shoots: col('shoots'), height: col('height'), weight: col('weight') };
if (ix.rank < 0 || ix.pos < 0 || (ix.name < 0 && ix.last < 0)) {
  console.error('The CSV needs rank, pos and name (or first and last) columns.');
  process.exit(1);
}
const get = (row, k) => (ix[k] >= 0 ? (row[ix[k]] ?? '').trim() : '');

function height(s) {
  const ft = s.match(/(\d)'\s*(\d{1,2})/);
  if (ft) return Number(ft[1]) * 12 + Number(ft[2]);
  const n = Number(s.replace(/[^\d.]/g, ''));
  if (!n) return null;
  return n > 100 ? Math.round(n / 2.54) : Math.round(n); // cm → inches
}
function weight(s) {
  const n = Number(s.replace(/[^\d.]/g, ''));
  if (!n) return null;
  return /kg/i.test(s) || n < 120 ? Math.round(n / 0.4536) : Math.round(n);
}

const board = [];
for (const row of body) {
  const rank = Number(get(row, 'rank'));
  let first = get(row, 'first');
  let last = get(row, 'last');
  if (!last) {
    const name = get(row, 'name');
    const parts = name.includes(',') ? name.split(',').map((x) => x.trim()).reverse() : name.split(/\s+/);
    first = parts[0];
    last = parts.slice(1).join(' ');
  }
  const pos = POS[get(row, 'pos').toUpperCase()] ?? null;
  if (!rank || !last || !pos) continue;
  const born = get(row, 'born');
  const league = get(row, 'league') || null;
  const nation = get(row, 'nation').toUpperCase() || null;
  const na = league ? NA.test(league) : nation === 'CAN' || nation === 'USA';
  const shoots = get(row, 'shoots').toUpperCase();
  board.push({
    first,
    last,
    pos,
    shoots: shoots === 'L' || shoots === 'R' ? shoots : null,
    heightIn: height(get(row, 'height')),
    weightLb: weight(get(row, 'weight')),
    birthDate: /^\d{4}-\d{2}-\d{2}$/.test(born) ? born : /^\d{4}$/.test(born) ? `${born}-06-30` : null,
    birthCountry: nation,
    club: get(row, 'club') || null,
    league,
    category: `${na ? 'NA' : 'INT'}-${pos === 'G' ? 'G' : 'S'}`,
    rank,
    boardRank: rank,
    stage: 'board',
  });
}

const path = join(ROOT, 'data/draft/class.json');
const data = JSON.parse(readFileSync(path, 'utf8'));
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const onBoard = new Set(board.map((p) => `${norm(p.first)}|${norm(p.last)}`));
// Replace any earlier board import; a Central Scouting entry for the same player gives way to the board entry.
data.prospects = [...board, ...data.prospects.filter((p) => !p.boardRank && !onBoard.has(`${norm(p.first)}|${norm(p.last)}`))];
data.board = { file: file.split('/').pop(), count: board.length, importedOn: new Date().toISOString().slice(0, 10) };
writeFileSync(path, JSON.stringify(data, null, 1) + '\n');
console.log(`Imported ${board.length} ranked prospects; class now has ${data.prospects.length}.`);
