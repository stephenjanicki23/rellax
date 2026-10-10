import { createLeague } from '../src/engine/league/create';
import { buildGameInput } from '../src/engine/league/gameInput';
import { GameSim } from '../src/engine/sim/engine';
import { teamStrength } from '../src/engine/team/strength';
const league = createLeague({ seed: process.argv[2] ?? 'multi-season-validation' });
const games = league.schedule.filter((x) => !x.playoff).slice(0, Number(process.argv[3] ?? 480));
const pts: Record<number, { gp: number; pts: number; gf: number; ga: number }> = {};
for (const g of games) {
  const r = new GameSim(buildGameInput(league, g.id)).simulate();
  for (const [tid, gf, ga] of [[g.home, r.homeGoals, r.awayGoals], [g.away, r.awayGoals, r.homeGoals]] as const) {
    const e = (pts[tid] ??= { gp: 0, pts: 0, gf: 0, ga: 0 });
    e.gp++; e.gf += gf; e.ga += ga;
    e.pts += gf > ga ? 2 : r.ot ? 1 : 0;
  }
}
const rows = league.teams.map((t) => ({ t, e: pts[t.id], s: teamStrength(league, t.id).overall })).filter((x) => x.e).map((x) => ({ abbr: x.t.abbr, pace: Math.round((x.e.pts / x.e.gp) * 82), gf: (x.e.gf / x.e.gp).toFixed(2), ga: (x.e.ga / x.e.gp).toFixed(2), str: x.s.toFixed(1), off: x.t.tactics.offense, def: x.t.tactics.defense, fc: x.t.tactics.forecheck, pk: x.t.tactics.pk, pp: x.t.tactics.pp }));
rows.sort((a, b) => b.pace - a.pace);
for (const r of rows) console.log(Object.values(r).join('\t'));
const by = (k: 'off' | 'def' | 'fc') => { const m: Record<string, number[]> = {}; for (const r of rows) (m[r[k]] ??= []).push(r.pace); return Object.entries(m).map(([v, a]) => `${v}:${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(0)}(${a.length})`).join(' '); };
console.log('offense', by('off')); console.log('defense', by('def')); console.log('forecheck', by('fc'));
