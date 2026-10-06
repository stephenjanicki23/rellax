/**
 * Believability report for the live rink: simulates a few games and prints
 * each metric against its limit. Usage: npm run rink:check [games]
 */
import { createLeague } from '../src/engine/league/create';
import { buildGameInput } from '../src/engine/league/gameInput';
import { analyzeGame, RINK_LIMITS, type RinkMetrics } from '../src/ui/rink/believability';

const n = Number(process.argv[2] ?? 4);
const league = createLeague({ seed: 'rink-check' });
const rows: RinkMetrics[] = [];
for (let i = 0; i < n; i++) {
  const g = league.schedule[i * 5];
  const m = analyzeGame(buildGameInput(league, g.id, true));
  rows.push(m);
  console.log(`${league.teams[g.away].abbr} at ${league.teams[g.home].abbr}: ${m.seconds}s of live play`);
}
const higherIsBetter = new Set(['goalieSquare', 'minStoppage']);
const fmt = (k: string, v: number) => (k === 'stacked' || k === 'offside' || k === 'goalieSquare' ? `${(v * 100).toFixed(1)}%` : v.toFixed(1));
console.log('\nmetric          worst      limit   ok');
for (const k of Object.keys(RINK_LIMITS) as (keyof typeof RINK_LIMITS)[]) {
  const vals = rows.map((r) => r[k]);
  const worst = higherIsBetter.has(k) ? Math.min(...vals) : Math.max(...vals);
  const lim = RINK_LIMITS[k];
  const ok = higherIsBetter.has(k) ? worst > lim : k === 'offIce' || k === 'teleports' ? worst <= lim : worst < lim;
  console.log(`${k.padEnd(15)} ${fmt(k, worst).padStart(8)} ${fmt(k, lim).padStart(10)}   ${ok ? '✓' : '✗'}`);
}
