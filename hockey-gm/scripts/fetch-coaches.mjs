#!/usr/bin/env node
/**
 * Builds data/coaches/records.json — real NHL head-coaching records — from the
 * NHL feed (api-web.nhle.com). Every game's box score names both head coaches,
 * so each coach's season-by-season record (regular season W-L-T-OTL, playoff
 * W-L, deepest round, Stanley Cups) is tallied game by game.
 *
 * Usage: npm run fetch:coaches [-- --from 1985 --to 2025]
 * Box-score coach names are cached per season in scripts/.cache/coaches, so a
 * re-run only fetches games it hasn't seen (re-run after each season).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api-web.nhle.com/v1';
const CACHE = join(ROOT, 'scripts/.cache/coaches');
const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? Number(args[args.indexOf(k) + 1]) : d);
const now = new Date();
const lastComplete = (now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1) - 1;
const FROM = arg('--from', 1985);
const TO = arg('--to', lastComplete);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(API + path, { headers: { accept: 'application/json' } });
      if (res.status === 404) return null;
      if (res.status === 429 && attempt < 12) {
        await sleep(Number(res.headers.get('retry-after')) * 1000 || 2000 * 2 ** Math.min(attempt, 4));
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${path}`);
      return await res.json();
    } catch (e) {
      if (attempt >= 5) throw e;
      await sleep(500 * 2 ** attempt);
    }
  }
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

const text = (v) => (typeof v === 'string' ? v : v?.default ?? null);

mkdirSync(CACHE, { recursive: true });
const seasonsMeta = (await get('/standings-season'))?.seasons ?? [];
/** coach name → season → team → line */
const coaches = new Map();
const line = (name, season, team) => {
  if (!coaches.has(name)) coaches.set(name, new Map());
  const bySeason = coaches.get(name);
  const key = `${season}|${team}`;
  if (!bySeason.has(key)) bySeason.set(key, { season, team, gp: 0, w: 0, l: 0, t: 0, otl: 0, pgp: 0, pw: 0, pl: 0, round: 0, cup: false });
  return bySeason.get(key);
};

for (let y = FROM; y <= TO; y++) {
  const id = Number(`${y}${y + 1}`);
  const meta = seasonsMeta.find((s) => s.id === id);
  if (!meta) continue;
  const cacheFile = join(CACHE, `${id}.json`);
  const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : { games: {}, coaches: {} };
  const teams = ((await get(`/standings/${meta.standingsEnd}`))?.standings ?? []).map((s) => text(s.teamAbbrev));
  for (const abbr of cache.complete ? [] : teams) {
    const sched = await get(`/club-schedule-season/${abbr}/${id}`);
    for (const g of sched?.games ?? []) {
      if (g.gameType !== 2 && g.gameType !== 3) continue;
      if (g.gameState !== 'OFF' && g.gameState !== 'FINAL') continue;
      cache.games[g.id] = { type: g.gameType, home: g.homeTeam.abbrev, away: g.awayTeam.abbrev, hs: g.homeTeam.score, as: g.awayTeam.score, last: g.gameOutcome?.lastPeriodType ?? 'REG' };
    }
  }
  const todo = Object.keys(cache.games).filter((g) => !cache.coaches[g]);
  let done = 0;
  await pool(todo, arg('--concurrency', 24), async (gid) => {
    const rail = await get(`/gamecenter/${gid}/right-rail`);
    cache.coaches[gid] = [text(rail?.gameInfo?.homeTeam?.headCoach), text(rail?.gameInfo?.awayTeam?.headCoach)];
    if (++done % 200 === 0) {
      writeFileSync(cacheFile, JSON.stringify(cache));
      console.log(`  ${id}: ${done}/${todo.length}`);
    }
  });
  cache.complete = true;
  writeFileSync(cacheFile, JSON.stringify(cache));

  // Tally.
  const seriesWins = new Map(); // `${round}|${team}` → wins
  for (const [gid, g] of Object.entries(cache.games)) {
    const [hc, ac] = cache.coaches[gid] ?? [];
    const sides = [
      { team: g.home, coach: hc, gf: g.hs, ga: g.as },
      { team: g.away, coach: ac, gf: g.as, ga: g.hs },
    ];
    const round = g.type === 3 ? Number(String(gid).slice(7, 8)) : 0;
    for (const s of sides) {
      if (!s.coach) continue;
      const r = line(s.coach, y, s.team);
      if (g.type === 2) {
        r.gp++;
        if (s.gf > s.ga) r.w++;
        else if (s.gf === s.ga) r.t++;
        else if (g.last !== 'REG' && meta.pointForOTlossInUse) r.otl++;
        else r.l++;
      } else {
        r.pgp++;
        if (s.gf > s.ga) {
          r.pw++;
          seriesWins.set(`${round}|${s.team}`, (seriesWins.get(`${round}|${s.team}`) ?? 0) + 1);
        } else r.pl++;
        r.round = Math.max(r.round, round);
      }
    }
  }
  // Stanley Cup: the team with four wins in the final round; credited to the coach behind the bench for the clincher.
  const final = Math.max(0, ...Object.keys(cache.games).filter((g) => cache.games[g].type === 3).map((g) => Number(g.slice(7, 8))));
  const champ = [...seriesWins].find(([k, w]) => k.startsWith(`${final}|`) && w >= 4)?.[0].split('|')[1];
  if (champ) {
    const clincher = Object.keys(cache.games)
      .filter((g) => cache.games[g].type === 3 && Number(g.slice(7, 8)) === final)
      .sort()
      .at(-1);
    const g = cache.games[clincher];
    const coach = cache.coaches[clincher]?.[g.home === champ ? 0 : 1];
    if (coach) line(coach, y, champ).cup = true;
  }
  console.log(`${id}: ${Object.keys(cache.games).length} games${champ ? ` · Cup: ${champ}` : ''}`);
}

// Keep coaches who were behind an NHL bench in the last 15 seasons (the game's candidate pool and current coaches).
const out = [...coaches]
  .filter(([, m]) => [...m.values()].some((l) => l.season >= TO - 15))
  .map(([name, m]) => ({ name, seasons: [...m.values()].sort((a, b) => a.season - b.season || b.gp - a.gp) }))
  .sort((a, b) => a.name.localeCompare(b.name));
mkdirSync(join(ROOT, 'data/coaches'), { recursive: true });
writeFileSync(
  join(ROOT, 'data/coaches/records.json'),
  JSON.stringify({ schemaVersion: 1, asOf: now.toISOString().slice(0, 10), source: `NHL game feed (api-web.nhle.com) box-score head coaches, ${FROM}-${String(FROM + 1).slice(2)} to ${TO}-${String(TO + 1).slice(2)}`, from: FROM, to: TO, coaches: out }, null, 0) + '\n',
);
console.log(`${out.length} coaches written to data/coaches/records.json`);
