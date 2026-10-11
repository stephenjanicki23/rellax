/** One full simulated season with the chosen engine, checked against the season-level realism targets. */
import { createLeague } from '../src/engine/league/create';
import { simTo } from '../src/engine/league/season';
import { seasonSummary, checkTargets, SEASON_TARGETS } from '../src/engine/analytics';
const engine = process.argv[2] ?? 'agent';
process.env.HGM_ENGINE = engine;
const league = createLeague({ seed: process.argv[3] ?? 'multi-season-validation' });
league.settings.autoManageUser = true;
const t0 = performance.now();
simTo(league, 'endSeason');
const ms = performance.now() - t0;
const sum = seasonSummary(league) as unknown as Record<string, number>;
for (const r of checkTargets(sum, SEASON_TARGETS)) console.log(`${r.ok ? '  ' : '✗ '}${r.key.padEnd(22)} ${String(+r.value.toFixed(3)).padStart(8)}  [${r.lo}, ${r.hi}]`);
console.log(`${engine}: season + playoffs in ${(ms / 1000).toFixed(1)} s`);
