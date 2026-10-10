/**
 * Calibration check for the per-second engine: runs a batch of games and
 * prints each core metric against its realistic band, plus extra counts
 * (faceoffs, giveaways, offsides, icings, decisions) and speed.
 *   npx tsx scripts/agent-check.ts [games] [engine]
 */
import { createLeague } from '../src/engine/league/create';
import { buildGameInput } from '../src/engine/league/gameInput';
import { GAME_TARGETS, checkTargets, runGameBatch } from '../src/engine/analytics';
import { GameSim } from '../src/engine/sim/engine';

const n = Number(process.argv[2] ?? 200);
const engine = (process.argv[3] ?? 'agent') as 'agent' | 'classic';
process.env.HGM_ENGINE = engine;
const league = createLeague({ seed: 'validation' });
const t0 = performance.now();
const b = runGameBatch(league, n) as unknown as Record<string, number>;
const ms = performance.now() - t0;
for (const r of checkTargets(b, GAME_TARGETS)) console.log(`${r.ok ? '  ' : '✗ '}${r.key.padEnd(18)} ${r.value.toFixed(3).padStart(8)}  [${r.lo}, ${r.hi}]`);
// Extra counts from event logs on a smaller sample.
const games = league.schedule.filter((g) => !g.playoff).slice(0, Math.min(40, n));
const cnt: Record<string, number> = {};
let decisions = 0;
let giveaways = 0, takeaways = 0, oz = 0;
const dists: number[] = [];
for (const g of games) {
  const sim = new GameSim({ ...buildGameInput(league, g.id, true), engine });
  const r = sim.simulate();
  decisions += r.decisions ?? 0;
  for (const e of r.events) {
    cnt[e.type] = (cnt[e.type] ?? 0) + 1;
    if ((e.type === 'shot' || e.type === 'missed' || e.type === 'blocked') && e.data?.dist !== undefined && !e.data?.en) {
      dists.push(e.data.dist);
    }
  }
  oz += r.teams[0].ozTime + r.teams[1].ozTime;
  giveaways += r.teams[0].gv + r.teams[1].gv;
  takeaways += r.teams[0].tk + r.teams[1].tk;
}
const per = (k: string) => ((cnt[k] ?? 0) / games.length).toFixed(1);
console.log(`per game: faceoffs ${per('faceoff')} · passes(OZ) ${per('pass')} · entries ${per('entry')} · dumps ${per('dumpIn')} · offside ${per('offside')} · icing ${per('icing')} · battles ${per('battle')} · hits ${per('hit')} · penalties ${per('penalty')} · freezes ${per('freeze')}`);
console.log(`giveaways/team ${(giveaways / games.length / 2).toFixed(1)} · takeaways/team ${(takeaways / games.length / 2).toFixed(1)} · decisions/game ${Math.round(decisions / games.length)}`);
const md = dists.reduce((a, b) => a + b, 0) / Math.max(1, dists.length);
console.log(`attempt distance: mean ${md.toFixed(1)} ft · <20ft ${((dists.filter((x) => x < 20).length / dists.length) * 100).toFixed(0)}% · 20-36 ${((dists.filter((x) => x >= 20 && x < 36).length / dists.length) * 100).toFixed(0)}% · 36+ ${((dists.filter((x) => x >= 36).length / dists.length) * 100).toFixed(0)}% · OZ time/team ${(oz / games.length / 2 / 60).toFixed(1)} min`);
console.log(`${engine}: ${(ms / n).toFixed(2)} ms/game`);
import { enableShotDebug } from '../src/engine/sim/engine';
{
  const dbg = enableShotDebug();
  for (const g of games.slice(0, 20)) new GameSim({ ...buildGameInput(league, g.id), engine }).simulate();
  console.log('shots by origin', JSON.stringify(Object.fromEntries(Object.entries(dbg).sort((a, b) => b[1] - a[1]))));
}
