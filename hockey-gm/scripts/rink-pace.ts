/**
 * Live-rink pacing check: feeds whole games to the rink timeline the way the
 * live view does and measures how far the drawn play runs behind or ahead of
 * the game clock, and how often it plays in slow motion (and after what).
 *   npx tsx scripts/rink-pace.ts [games]
 */
import { createLeague } from '../src/engine/league/create';
import { buildGameInput } from '../src/engine/league/gameInput';
import { GameSim } from '../src/engine/sim/engine';
import { RinkDirector, type RinkPlayer } from '../src/ui/rink/director';
import { RinkTimeline, type TimelineItem } from '../src/ui/rink/motion';
import type { TrackFrame } from '../src/engine/sim/gameTypes';

const n = Number(process.argv[2] ?? 5);
const league = createLeague({ seed: 'pace' });
let tracks = 0;
let slow = 0;
let fast = 0;
let maxDrift = 0;
let sumAbs = 0;
const slowAfter: Record<string, number> = {};
for (let gi = 0; gi < n; gi++) {
  const g = league.schedule[gi];
  const input = buildGameInput(league, g.id, true, 77 + gi);
  const sim = new GameSim(input);
  const meta = new Map<number, RinkPlayer>();
  ([input.home, input.away] as const).forEach((t, team) => t.players.forEach((p) => meta.set(p.id, { id: p.id, team: team as 0 | 1, pos: p.pos, number: p.number ?? null, first: p.first, last: p.last })));
  const tl = new RinkTimeline(new RinkDirector(meta, ['H', 'A'], [input.home.tactics, input.away.tactics]));
  const tlx = tl as unknown as { holdSum: number };
  let recent: string[] = [];
  let prev: { s: number; t: number } | null = null;
  while (!sim.finished) {
    const evs = sim.step();
    const snap = sim.snapshot();
    const items: TimelineItem[] = evs.map((e) => ({ e, ice: { period: snap.inShootout ? 5 : e.period, onIce: snap.onIce, goalies: snap.goalies } }));
    const tr: { track: TrackFrame; ice: { period: number; onIce: typeof snap.onIce; goalies: typeof snap.goalies } }[] = [];
    if (snap.ice && !snap.inShootout) tr.push({ track: snap.ice, ice: { period: snap.ice.period, onIce: snap.onIce, goalies: snap.goalies } });
    if (snap.inShootout) break;
    if (!tr.length) {
      if (items.length) tl.add(items);
      continue;
    }
    const before = tl.keys.length;
    tl.addMixed(items, tr);
    recent = [...recent, ...evs.map((e) => e.type)].slice(-6);
    const k = tl.keys.slice(before).reverse().find((x) => x.track);
    if (!k) continue;
    const t = tr[0].track.t;
    const drift = k.s - (t + tlx.holdSum);
    tracks++;
    sumAbs += Math.abs(drift);
    maxDrift = Math.max(maxDrift, drift);
    if (prev && t - prev.t > 0 && t - prev.t < 0.3) {
      const rate = (t - prev.t) / (k.s - prev.s);
      if (rate < 0.8) {
        slow++;
        for (const ty of new Set(recent)) slowAfter[ty] = (slowAfter[ty] ?? 0) + 1;
      } else if (rate > 1.25) fast++;
    }
    prev = { s: k.s, t };
    recent = [];
  }
}
console.log(`track frames ${tracks}  mean |drift| ${(sumAbs / tracks).toFixed(3)} s  max ahead ${maxDrift.toFixed(2)} s`);
console.log(`slow-motion steps ${(100 * slow / tracks).toFixed(1)}%  fast-forward steps ${(100 * fast / tracks).toFixed(1)}%`);
console.log('slow steps follow:', Object.entries(slowAfter).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} ${v}`).join(', '));
