/**
 * League Simulation Analytics (CLI).
 *   npm run analyze -- [games=2000] [seasons=2] [seed]
 */
import { createLeague } from '../src/engine/league/create';
import { simTo } from '../src/engine/league/season';
import { simOffseason } from '../src/engine/league/offseason';
import { runGameBatch, seasonSummary, checkTargets, GAME_TARGETS, SEASON_TARGETS } from '../src/engine/analytics';

const games = Number(process.argv[2] ?? 2000);
const seasons = Number(process.argv[3] ?? 2);
const seed = process.argv[4] ?? 'analytics';
const league = createLeague({ seed });
league.settings.autoManageUser = true;

const fmt = (v: number) => (Math.abs(v) < 1 && v !== 0 ? v.toFixed(3) : v.toFixed(2));
const show = (rows: ReturnType<typeof checkTargets>) => {
  for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(36)} ${fmt(r.value).padStart(8)}   [${fmt(r.lo)} – ${fmt(r.hi)}]`);
};
if (games > 0) {
  const b = runGameBatch(league, games);
  console.log(`\nGame batch: ${b.games} games in ${b.ms} ms (${(b.ms / b.games).toFixed(2)} ms/game)`);
  show(checkTargets(b as unknown as Record<string, number>, GAME_TARGETS));
  console.log('  total goals:', b.totalGoalsHist.map((h) => `${h.bin}:${((h.count / b.games) * 100).toFixed(1)}%`).join(' '));
  console.log('  margins:', b.marginHist.map((h) => `${h.label}:${((h.count / b.games) * 100).toFixed(1)}%`).join(' '));
}
for (let s = 0; s < seasons; s++) {
  const t0 = Date.now();
  simTo(league, 'endSeason');
  const sum = seasonSummary(league);
  console.log(`\nSeason ${sum.season} (${Date.now() - t0} ms) champion: ${league.teams[sum.champion ?? 0].abbr}`);
  show(checkTargets(sum as unknown as Record<string, number>, SEASON_TARGETS));
  console.log(`  injuries/team ${sum.injuriesPerTeam.toFixed(1)}, shutouts ${sum.shutoutsTotal}, starter GAA ${sum.starterGaaMean.toFixed(2)}, top-400 CA ${sum.top400CA.toFixed(1)}`);
  if (s < seasons - 1) simOffseason(league);
}
