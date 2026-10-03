/** Synthetic NHL-shaped roster snapshot for testing the real-roster pipeline offline. */
import { Rng } from '../src/engine/core/rng';
import { DEFAULT_CONFIG } from '../src/engine/data/leagueConfig';
import type { NhlPlayerRecord, NhlSnapshot } from '../src/engine/data/nhl/types';

export function syntheticSnapshot(seed = 'nhl-fixture'): NhlSnapshot {
  const rng = new Rng(seed);
  const teams: Record<string, NhlPlayerRecord[]> = {};
  let id = 8470000;
  for (const t of DEFAULT_CONFIG.teams) {
    const list: NhlPlayerRecord[] = [];
    const add = (pos: NhlPlayerRecord['pos'], quality: number, i: number) => {
      const age = rng.int(20, 36);
      const rec: NhlPlayerRecord = {
        nhlId: id++,
        first: `${t.abbr}First${i}`,
        last: `${pos}Last${i}`,
        number: i + 2,
        pos,
        shoots: rng.chance(0.6) ? 'L' : 'R',
        heightCm: rng.int(178, 198),
        weightKg: rng.int(80, 105),
        birthDate: `${2026 - age}-03-15`,
        country: rng.pick(['CAN', 'USA', 'SWE', 'FIN', 'DEU', 'CHE', 'DNK']),
      };
      if (pos === 'G') {
        const gp = Math.round(15 + quality * 45);
        rec.goalie = [{ season: 2025, gp, gs: gp - 2, w: Math.round(gp * 0.5), l: Math.round(gp * 0.35), otl: 3, sv: 0.885 + quality * 0.035 + rng.normal(0, 0.004), gaa: 3.2 - quality, so: rng.int(0, 5) }];
      } else {
        const d = pos === 'D';
        const gp = rng.int(40, 82);
        const ppg = Math.max(0.05, (d ? 0.12 + quality * 0.6 : 0.15 + quality * 1.1) + rng.normal(0, 0.06));
        const pts = Math.round(ppg * gp);
        const g = Math.round(pts * (d ? 0.25 : rng.float(0.3, 0.6)));
        rec.skater = [{
          season: 2025, gp, g, a: pts - g, pim: rng.int(4, 60), pm: rng.int(-15, 20), shots: Math.round(gp * (d ? 1.5 : 2.2) * (0.6 + quality)),
          ppg: Math.round(g * 0.25), shg: 0, toi: Math.round((d ? 15 + quality * 9 : 10 + quality * 9) * 60),
          fo: pos === 'C' ? 0.44 + rng.float(0, 0.14) : null,
        }];
      }
      list.push(rec);
    };
    for (let i = 0; i < 15; i++) add(i % 3 === 0 ? 'C' : i % 3 === 1 ? 'L' : 'R', Math.max(0, 1 - i / 14 + rng.normal(0, 0.08)), i);
    for (let i = 0; i < 8; i++) add('D', Math.max(0, 1 - i / 7 + rng.normal(0, 0.08)), 20 + i);
    for (let i = 0; i < 3; i++) add('G', Math.max(0, 1 - i / 2 + rng.normal(0, 0.08)), 30 + i);
    teams[t.abbr] = list;
  }
  return { season: 2026, fetchedAt: null, source: 'test', teams };
}
