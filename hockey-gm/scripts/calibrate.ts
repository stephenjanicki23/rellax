import { createLeague } from '../src/engine/league/create';
import { buildGameInput } from '../src/engine/league/gameInput';
import { simulateGame } from '../src/engine/sim/engine';

const N = Number(process.argv[2] ?? 1000);
const league = createLeague({ seed: 'calib' });
const t0 = Date.now();
const acc: Record<string, number> = {};
const add = (k: string, v: number) => (acc[k] = (acc[k] ?? 0) + v);
let homeWins = 0, ot = 0, so = 0, en = 0, pp = 0, sh = 0;
const totals: number[] = []; const margins: Record<string, number> = {};
for (let i = 0; i < N; i++) {
  const g = league.schedule[i % league.schedule.length];
  const inp = buildGameInput(league, g.id, false, i);
  const r = simulateGame(inp);
  totals.push(r.homeGoals + r.awayGoals); const m = Math.abs(r.homeGoals - r.awayGoals); const mk = r.ot ? 'OT' : String(Math.min(m, 5)); margins[mk] = (margins[mk] ?? 0) + 1;
  if (r.homeGoals > r.awayGoals) homeWins++;
  if (r.ot) ot++;
  if (r.so) so++;
  for (const t of r.teams) {
    add('goals', t.goals); add('shots', t.shots); add('att', t.attempts); add('missed', t.missed); add('blocked', t.blockedAtt);
    add('hits', t.hits); add('blocks', t.blocks); add('tk', t.tk); add('gv', t.gv); add('ppOpp', t.ppOpp); add('ppg', t.ppg);
    add('pim', t.pim); add('xg', t.xg); add('hd', t.hdShots); add('fow', t.fow); add('shg', t.shg);
  }
  for (const g2 of r.goals) { if (g2.strength === 'EN') en++; if (g2.strength === 'PP') pp++; if (g2.strength === 'SH') sh++; }
  add('assists', r.goals.reduce((s, g2) => s + g2.assists.length, 0));
  add('injuries', r.injuries.length);
  let sa = 0, ga = 0;
  for (const p of Object.values(r.players)) { sa += p.sa; ga += p.ga; add('toiMax', 0); }
  add('sa', sa); add('ga', ga);
}
const per = (k: string, d = N * 2) => (acc[k] / d).toFixed(2);
console.log(`games=${N} time=${Date.now() - t0}ms`);
console.log(`goals/team ${per('goals')} shots ${per('shots')} att ${per('att')} missed ${per('missed')} blocked ${per('blocked')} xg ${per('xg')} hd ${per('hd')}`);
console.log(`sh% ${(acc.goals / acc.shots * 100).toFixed(1)} sv% ${((acc.sa - acc.ga) / acc.sa).toFixed(3)} hits ${per('hits')} blocks ${per('blocks')} tk ${per('tk')} gv ${per('gv')}`);
console.log(`ppOpp ${per('ppOpp')} pp% ${(acc.ppg / acc.ppOpp * 100).toFixed(1)} pim ${per('pim')} shg/team ${per('shg')}`);
console.log(`home win% ${(homeWins / N * 100).toFixed(1)} OT% ${(ot / N * 100).toFixed(1)} SO% ${(so / N * 100).toFixed(1)} EN/game ${(en / N).toFixed(2)} assists/goal ${(acc.assists / acc.goals).toFixed(2)} injuries/game ${(acc.injuries / N).toFixed(2)}`);
const dist: Record<number, number> = {};
for (const t of totals) dist[t] = (dist[t] ?? 0) + 1;
console.log('total goals dist', Object.entries(dist).map(([k, v]) => `${k}:${(v / N * 100).toFixed(1)}`).join(' '));
console.log('margins', Object.entries(margins).map(([k, v]) => `${k}:${(v / N * 100).toFixed(1)}`).join(' '));
