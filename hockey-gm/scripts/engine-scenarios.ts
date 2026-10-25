/**
 * Scenario calibration for the match engine: batches of games for set
 * match-ups, reported as plain numbers (no rendering, the same engine the
 * game uses everywhere).
 *
 *   npx tsx scripts/engine-scenarios.ts [gamesPerScenario=200] [seed=scenarios]
 *
 * Scenarios are built by editing real game inputs (ratings, energy, tactics),
 * never by touching the engine's outcomes.
 */
import { createLeague } from '../src/engine/league/create';
import { buildGameInput } from '../src/engine/league/gameInput';
import { simulateGame } from '../src/engine/sim/engine';
import { cloneInput } from '../src/engine/sim/savedGame';
import type { GameInput, GameResult, GameTeamInput } from '../src/engine/sim/gameTypes';
import type { Tactics } from '../src/engine/types';

const N = Number(process.argv[2] ?? 200);
const league = createLeague({ seed: process.argv[3] ?? 'scenarios' });
const games = league.schedule.filter((g) => !g.playoff);
const t0 = performance.now();
let simulated = 0;

type Edit = (inp: GameInput, i: number) => void;
const run = (edit: Edit, neutral = false): GameResult[] => {
  const out: GameResult[] = [];
  for (let i = 0; i < N; i++) {
    const g = games[i % games.length];
    const inp = cloneInput(buildGameInput(league, g.id, false, 9000 + i));
    if (neutral) inp.neutral = true;
    edit(inp, i);
    out.push(simulateGame(inp));
    simulated++;
  }
  return out;
};

// Rating edits: shift every attribute of the chosen players (clamped to the scale).
const shift = (t: GameTeamInput, d: number, who: (pos: string) => boolean) => {
  for (const p of t.players) {
    if (!who(p.pos)) continue;
    const a = { ...p.attrs } as Record<string, number>;
    for (const k of Object.keys(a)) a[k] = Math.max(20, Math.min(200, a[k] + d));
    p.attrs = a as typeof p.attrs;
  }
};
const goalies = (pos: string) => pos === 'G';
const forwards = (pos: string) => pos === 'C' || pos === 'LW' || pos === 'RW';
const TWIN = 500000;
const mirror = (inp: GameInput) => {
  // The same club on both benches (fresh copies with their own ids): any edge left is home ice or chance.
  const twin = cloneInput(inp).home;
  const m = (id: number) => id + TWIN;
  const L = twin.lines;
  inp.away = {
    ...twin,
    teamId: inp.away.teamId,
    abbr: 'TWN',
    players: twin.players.map((p) => ({ ...p, id: m(p.id) })),
    lines: { fwd: L.fwd.map((r) => r.map(m)), def: L.def.map((r) => r.map(m)), goalies: L.goalies.map(m), pp: L.pp.map((r) => r.map(m)), pk: L.pk.map((r) => r.map(m)) },
    chemistry: (a: number, b: number) => (twin.chemistry ? twin.chemistry(a - TWIN, b - TWIN) : 0),
  };
};

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const f2 = (x: number) => x.toFixed(2);
interface Summary {
  gf: [number, number];
  shots: [number, number];
  sv: [number, number];
  homeWin: number;
  ot: number;
  ppPct: [number, number];
}
function summarize(rs: GameResult[]): Summary {
  const n = rs.length;
  const sum = (f: (r: GameResult) => number) => rs.reduce((s, r) => s + f(r), 0);
  const svFor = (side: 0 | 1) => {
    const opp = (1 - side) as 0 | 1;
    const shots = sum((r) => r.teams[opp].shots);
    const goals = sum((r) => r.teams[opp].goals - r.goals.filter((g) => g.team === opp && g.strength === 'EN').length);
    const en = sum((r) => r.goals.filter((g) => g.team === opp && g.strength === 'EN').length);
    return 1 - goals / Math.max(1, shots - en);
  };
  const pp = (side: 0 | 1) => sum((r) => r.teams[side].ppg) / Math.max(1, sum((r) => r.teams[side].ppOpp));
  return {
    gf: [sum((r) => r.homeGoals) / n, sum((r) => r.awayGoals) / n],
    shots: [sum((r) => r.teams[0].shots) / n, sum((r) => r.teams[1].shots) / n],
    sv: [svFor(0), svFor(1)],
    homeWin: rs.filter((r) => r.homeGoals > r.awayGoals).length / n,
    ot: rs.filter((r) => r.ot || r.so).length / n,
    ppPct: [pp(0), pp(1)],
  };
}
const line = (name: string, s: Summary, note = '') =>
  console.log(
    `${name.padEnd(34)} A wins ${pct(s.homeWin).padStart(6)} · goals ${f2(s.gf[0])}-${f2(s.gf[1])} · shots ${s.shots[0].toFixed(1)}-${s.shots[1].toFixed(1)} · sv% ${s.sv[0].toFixed(3)}/${s.sv[1].toFixed(3)} · PP ${pct(s.ppPct[0])}/${pct(s.ppPct[1])} · OT ${pct(s.ot)}${note ? ` · ${note}` : ''}`,
  );

console.log(`Scenario calibration · ${N} games each · seed ${process.argv[3] ?? 'scenarios'}\n(A = home bench, B = away bench)\n`);

// 1. Evenly matched: the same club on both benches, neutral ice.
line('1 Even (mirror, neutral ice)', summarize(run((inp) => mirror(inp), true)), 'expect ~50%');
// 2. Championship team vs rebuilding team (+18 / -18 on every skater and goalie rating).
line('2 Contender vs rebuilder', summarize(run((inp) => (mirror(inp), shift(inp.home, 18, () => true), shift(inp.away, -18, () => true)), true)));
// 3. Elite goalie vs weak offense.
line('3 Elite goalie vs weak offense', summarize(run((inp) => (mirror(inp), shift(inp.home, 35, goalies), shift(inp.away, -20, forwards)), true)), 'A sv% should be high');
// 4. Elite offense vs weak goalie.
line('4 Elite offense vs weak goalie', summarize(run((inp) => (mirror(inp), shift(inp.home, 22, forwards), shift(inp.away, -35, goalies)), true)), 'B sv% should be low');
// 5. Tactics: same rosters, different systems.
const tac = (t: GameTeamInput, x: Partial<Tactics>) => (t.tactics = { ...t.tactics, ...x });
const systems: [string, Partial<Tactics>][] = [
  ['aggressive forecheck', { forecheck: '2-1-2', defense: 'aggressive', offense: 'rush' }],
  ['neutral-zone trap', { forecheck: '1-3-1', defense: 'trap', offense: 'possession' }],
  ['dump and chase, physical', { forecheck: '1-2-2', defense: 'physical', offense: 'dumpChase' }],
  ['cycle, shot lanes', { forecheck: '1-2-2', defense: 'passive', offense: 'cycle' }],
];
for (let a = 0; a < systems.length; a++)
  for (let b = a + 1; b < systems.length; b++)
    line(`5 ${systems[a][0]} v ${systems[b][0]}`.slice(0, 34), summarize(run((inp) => (mirror(inp), tac(inp.home, systems[a][1]), tac(inp.away, systems[b][1])), true)));
// 6. Fatigue: B starts the night worn down (energy 70).
line('6 Rested vs fatigued (B at 70%)', summarize(run((inp) => (mirror(inp), inp.away.players.forEach((p) => (p.energy = 70))), true)));
// 7. Special teams: A's power-play specialists vs B's weak penalty killers.
line(
  '7 Strong PP (A) vs weak PK (B)',
  summarize(
    run((inp) => {
      mirror(inp);
      for (const p of inp.home.players) p.attrs = { ...p.attrs, passing: Math.min(200, p.attrs.passing + 25), wristAccuracy: Math.min(200, p.attrs.wristAccuracy + 20) };
      for (const p of inp.away.players) p.attrs = { ...p.attrs, defAwareness: Math.max(20, p.attrs.defAwareness - 25), stickChecking: Math.max(20, p.attrs.stickChecking - 20) };
    }, true),
  ),
);

// League-wide batch for distributions (real match-ups).
const real = run(() => {});
const n = real.length;
const margins = real.map((r) => Math.abs(r.homeGoals - r.awayGoals));
const totals = new Map<string, number>();
for (const r of real) {
  const k = `${Math.max(r.homeGoals, r.awayGoals)}-${Math.min(r.homeGoals, r.awayGoals)}`;
  totals.set(k, (totals.get(k) ?? 0) + 1);
}
const top = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${pct(v / n)}`).join(' · ');
const shutouts = real.filter((r) => r.homeGoals === 0 || r.awayGoals === 0).length / n;
const blowouts = margins.filter((m) => m >= 4).length / n;
const oneGoal = margins.filter((m) => m === 1).length / n;
console.log(`\n8 Real match-ups (${n}): most common finals ${top}`);
console.log(`  shutouts ${pct(shutouts)} · one-goal games ${pct(oneGoal)} · 4+ goal margins ${pct(blowouts)} · to OT ${pct(real.filter((r) => r.ot || r.so).length / n)} · shootouts ${pct(real.filter((r) => r.so).length / n)}`);

// 9. Talent and winning: rating gap between the benches vs how often the better one wins.
const strength = (t: GameTeamInput) => {
  const sk = t.players.filter((p) => p.pos !== 'G');
  const mean = (p: (typeof sk)[number]) => Object.values(p.attrs).reduce((a, b) => a + b, 0) / Object.values(p.attrs).length;
  return sk.reduce((s, p) => s + mean(p), 0) / Math.max(1, sk.length);
};
const buckets = [0, 1, 2, 3, 5, 99];
const rows: string[] = [];
const ins: { gap: number; betterWon: boolean }[] = [];
for (let i = 0; i < n; i++) {
  const g = games[i % games.length];
  const inp = buildGameInput(league, g.id, false, 9000 + i);
  const gap = strength(inp.home) - strength(inp.away);
  const r = real[i];
  ins.push({ gap: Math.abs(gap), betterWon: gap >= 0 ? r.homeGoals > r.awayGoals : r.awayGoals > r.homeGoals });
}
for (let b = 0; b < buckets.length - 1; b++) {
  const sel = ins.filter((x) => x.gap >= buckets[b] && x.gap < buckets[b + 1]);
  if (sel.length) rows.push(`gap ${buckets[b]}-${buckets[b + 1] === 99 ? '+' : buckets[b + 1]}: better side wins ${pct(sel.filter((x) => x.betterWon).length / sel.length)} (${sel.length})`);
}
console.log(`\n9 Talent vs winning (average skater rating gap):\n  ${rows.join('\n  ')}`);

// 10. Goalie quality vs save percentage, across starters in the batch.
const gq = new Map<number, { q: number; sa: number; ga: number }>();
for (let i = 0; i < n; i++) {
  const inp = buildGameInput(league, games[i % games.length].id, false, 9000 + i);
  for (const t of [inp.home, inp.away]) {
    const gid = t.lines.goalies[0];
    const gp = t.players.find((p) => p.id === gid);
    const pl = real[i].players[gid];
    if (!gp || !pl) continue;
    const a = gp.attrs;
    const q = (a.reflexes + a.gPositioning + a.glove + a.blocker + a.highDanger) / 5;
    const e = gq.get(gid) ?? { q, sa: 0, ga: 0 };
    e.sa += pl.sa;
    e.ga += pl.ga;
    gq.set(gid, e);
  }
}
const gl = [...gq.values()].filter((x) => x.sa > 60).sort((a, b) => a.q - b.q);
const third = Math.max(1, Math.floor(gl.length / 3));
const sv = (xs: typeof gl) => 1 - xs.reduce((s, x) => s + x.ga, 0) / Math.max(1, xs.reduce((s, x) => s + x.sa, 0));
console.log(`\n10 Goalie quality vs save %: bottom third ${sv(gl.slice(0, third)).toFixed(3)} · middle ${sv(gl.slice(third, -third)).toFixed(3)} · top third ${sv(gl.slice(-third)).toFixed(3)} (${gl.length} goalies)`);

// 11. Late game: trailing teams push, leaders sit back; goalies pulled.
const late = run((inp) => (inp.recordEvents = true));
let trailShots = 0;
let leadShots = 0;
let lateGames = 0;
let pulls = 0;
let adjusts = 0;
const evCount: Record<string, number> = {};
for (const r of late) {
  for (const e of r.events) evCount[e.type] = (evCount[e.type] ?? 0) + 1;
  pulls += r.events.filter((e) => e.type === 'goaliePulled').length;
  adjusts += r.events.filter((e) => e.type === 'adjustment' && e.data?.adjust !== 'reset').length;
  // Score with 5 minutes left in the third.
  const cut = 2 * 1200 + 900;
  const g = r.events.filter((e) => e.type === 'goal' && e.t < cut);
  const s0 = g.filter((e) => e.team === 0).length;
  const s1 = g.filter((e) => e.team === 1).length;
  if (s0 === s1 || Math.abs(s0 - s1) > 2) continue;
  lateGames++;
  const trailer = s0 < s1 ? 0 : 1;
  const shots = r.events.filter((e) => e.type === 'shot' && e.t >= cut && e.period === 3);
  trailShots += shots.filter((e) => e.team === trailer).length;
  leadShots += shots.filter((e) => e.team !== trailer).length;
}
console.log(`\n11 Last 5 minutes of close games (${lateGames}): trailing team ${(trailShots / Math.max(1, lateGames)).toFixed(2)} shots vs leading team ${(leadShots / Math.max(1, lateGames)).toFixed(2)} · goalie pulls ${(pulls / late.length).toFixed(2)}/game · coach adjustments ${(adjusts / late.length).toFixed(2)}/game`);
const per = (k: string) => ((evCount[k] ?? 0) / late.length).toFixed(1);
console.log(`\n12 Events per game: passes ${per('pass')} · shots on goal ${per('shot')} · missed ${per('missed')} · blocked ${per('blocked')} · saves ${per('save')} · rebounds ${per('rebound')} · goals ${per('goal')} · entries ${per('entry')} · dump-ins ${per('dumpIn')} · takeaways ${per('takeaway')} · giveaways ${per('giveaway')} · hits ${per('hit')} · penalties ${per('penalty')} · icings ${per('icing')} · offsides ${per('offside')} · faceoffs ${per('faceoff')} · line changes ${per('lineChange')}`);
const secs = (performance.now() - t0) / 1000;
console.log(`\n13 Runtime: ${simulated} games in ${secs.toFixed(0)} s (${((secs / simulated) * 1000).toFixed(0)} ms per game, one core)`);
