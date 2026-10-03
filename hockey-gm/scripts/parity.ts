import { createLeague } from '../src/engine/league/create';
import { buildGameInput } from '../src/engine/league/gameInput';
import { simulateGame } from '../src/engine/sim/engine';
const league = createLeague({ seed: process.argv[2] ?? 'calib' });
const pts: number[] = new Array(32).fill(0), gp: number[] = new Array(32).fill(0), gf = new Array(32).fill(0), ga = new Array(32).fill(0);
for (const g of league.schedule) {
  const r = simulateGame(buildGameInput(league, g.id));
  gp[g.home]++; gp[g.away]++;
  gf[g.home] += r.homeGoals; ga[g.home] += r.awayGoals; gf[g.away] += r.awayGoals; ga[g.away] += r.homeGoals;
  const hw = r.homeGoals > r.awayGoals;
  pts[hw ? g.home : g.away] += 2;
  if (r.ot) pts[hw ? g.away : g.home] += 1;
}
const rows = league.teams.map((t) => ({ t: t.abbr, pct: pts[t.id] / (gp[t.id] * 2), pts: pts[t.id], gf: gf[t.id], ga: ga[t.id] })).sort((a, b) => b.pct - a.pct);
console.log(rows.map((r) => `${r.t} ${r.pts} ${r.pct.toFixed(3)} GF${r.gf} GA${r.ga}`).join('\n'));
const p = rows.map((r) => r.pct); const m = p.reduce((a, b) => a + b) / p.length;
console.log('sd', Math.sqrt(p.reduce((s, x) => s + (x - m) ** 2, 0) / p.length).toFixed(3));
