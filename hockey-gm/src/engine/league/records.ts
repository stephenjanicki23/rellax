import type { League, Player, RecordEntry, StatLine } from '../types';
import { savePct, points, emptyStatLine, addStatLine } from '../core/statline';
import { addNews, teamName } from './helpers';
import { fullName } from '../player/ability';

interface RecordDef {
  key: string;
  label: string;
  value: (s: StatLine, p: Player) => number;
  eligible?: (s: StatLine, p: Player, league: League) => boolean;
  lowerIsBetter?: boolean;
  fmt?: (v: number) => string;
}

const isRookie = (_s: StatLine, p: Player, league: League) => p.proSeasons === 0 || (p.proSeasons <= 1 && !p.career.some((c) => !c.playoffs && c.stats.gp > 25 && c.season < league.season));

export const SINGLE_SEASON: RecordDef[] = [
  { key: 'goals', label: 'Goals', value: (s) => s.g },
  { key: 'assists', label: 'Assists', value: (s) => s.a1 + s.a2 },
  { key: 'points', label: 'Points', value: (s) => points(s) },
  { key: 'ppg', label: 'Power-play goals', value: (s) => s.ppg },
  { key: 'shg', label: 'Shorthanded goals', value: (s) => s.shg },
  { key: 'gwg', label: 'Game-winning goals', value: (s) => s.gwg },
  { key: 'plusMinus', label: 'Plus/minus', value: (s) => s.pm },
  { key: 'pim', label: 'Penalty minutes', value: (s) => s.pim },
  { key: 'dPoints', label: 'Points by a defenseman', value: (s) => points(s), eligible: (_s, p) => p.pos === 'D' },
  { key: 'rookieGoals', label: 'Rookie goals', value: (s) => s.g, eligible: isRookie },
  { key: 'rookiePoints', label: 'Rookie points', value: (s) => points(s), eligible: isRookie },
  { key: 'wins', label: 'Goaltender wins', value: (s) => s.w, eligible: (_s, p) => p.pos === 'G' },
  { key: 'shutouts', label: 'Shutouts', value: (s) => s.so, eligible: (_s, p) => p.pos === 'G' },
  { key: 'savePct', label: 'Save percentage (min. 40 GP)', value: (s) => savePct(s), eligible: (s, p) => p.pos === 'G' && s.gp >= 40, fmt: (v) => v.toFixed(3).replace(/^0/, '') },
  { key: 'pointStreak', label: 'Longest point streak', value: (_s, p) => p.streak.bestPoints, eligible: (_s, p) => p.pos !== 'G' },
];

export const PLAYOFF_SEASON: RecordDef[] = [
  { key: 'poGoals', label: 'Playoff goals (single playoffs)', value: (s) => s.g },
  { key: 'poPoints', label: 'Playoff points (single playoffs)', value: (s) => points(s) },
];

export const CAREER: RecordDef[] = [
  { key: 'cGoals', label: 'Career goals', value: (s) => s.g },
  { key: 'cAssists', label: 'Career assists', value: (s) => s.a1 + s.a2 },
  { key: 'cPoints', label: 'Career points', value: (s) => points(s) },
  { key: 'cGames', label: 'Career games played', value: (s) => s.gp },
  { key: 'cWins', label: 'Career goaltender wins', value: (s) => s.w, eligible: (_s, p) => p.pos === 'G' },
  { key: 'cShutouts', label: 'Career shutouts', value: (s) => s.so, eligible: (_s, p) => p.pos === 'G' },
  { key: 'cPoGoals', label: 'Career playoff goals', value: (s) => s.g },
  { key: 'cPoPoints', label: 'Career playoff points', value: (s) => points(s) },
];

function better(def: RecordDef, v: number, cur: RecordEntry | undefined): boolean {
  if (!cur) return v > 0;
  return def.lowerIsBetter ? v < cur.value : v > cur.value;
}

/** During the season: announce single-season records as they fall. */
export function checkLiveRecords(league: League): void {
  const announce = league.history.length > 0;
  for (const def of SINGLE_SEASON) {
    let best: { p: Player; v: number } | null = null;
    for (const [idStr, e] of Object.entries(league.seasonStats)) {
      const p = league.players[Number(idStr)];
      if (!p || e.reg.gp === 0) continue;
      if (def.eligible && !def.eligible(e.reg, p, league)) continue;
      if (def.key === 'savePct') continue; // only evaluated at season end
      const v = def.value(e.reg, p);
      if (!best || v > best.v) best = { p, v };
    }
    if (!best) continue;
    const cur = league.records.singleSeason[def.key];
    if (better(def, best.v, cur)) {
      const wasOther = cur && (cur.playerId !== best.p.id || cur.season !== league.season);
      league.records.singleSeason[def.key] = { key: def.key, label: def.label, value: best.v, playerId: best.p.id, teamId: best.p.teamId ?? undefined, season: league.season };
      if (announce && wasOther && best.v >= 10) {
        addNews(league, {
          category: 'record',
          headline: `${fullName(best.p)} sets a new league record for ${def.label.toLowerCase()} in a season (${def.fmt ? def.fmt(best.v) : best.v})`,
          teamIds: best.p.teamId !== null ? [best.p.teamId] : [],
          playerIds: [best.p.id],
          importance: 5,
        });
      }
    }
  }
}

/** End of season: finalise single-season, playoff, career and team records. */
export function finalizeRecords(league: League): void {
  checkLiveRecords(league);
  const rb = league.records;
  for (const [idStr, e] of Object.entries(league.seasonStats)) {
    const p = league.players[Number(idStr)];
    if (!p) continue;
    const sv = SINGLE_SEASON.find((d) => d.key === 'savePct')!;
    if (sv.eligible!(e.reg, p, league)) {
      const v = sv.value(e.reg, p);
      if (better(sv, v, rb.singleSeason.savePct)) rb.singleSeason.savePct = { key: 'savePct', label: sv.label, value: v, playerId: p.id, teamId: e.teamId, season: league.season };
    }
    for (const def of PLAYOFF_SEASON) {
      if (e.po.gp === 0) continue;
      const v = def.value(e.po, p);
      if (better(def, v, rb.singleSeason[def.key])) rb.singleSeason[def.key] = { key: def.key, label: def.label, value: v, playerId: p.id, teamId: e.teamId, season: league.season };
    }
  }
  // Career records (careers already include this season when called).
  for (const p of Object.values(league.players)) {
    if (!p.career.length) continue;
    const reg = careerSum(p, false);
    const po = careerSum(p, true);
    for (const def of CAREER) {
      const playoff = def.key.startsWith('cPo');
      const s = playoff ? po : reg;
      if (def.eligible && !def.eligible(s, p, league)) continue;
      const v = def.value(s, p);
      if (better(def, v, rb.career[def.key])) {
        const prev = rb.career[def.key];
        rb.career[def.key] = { key: def.key, label: def.label, value: v, playerId: p.id, season: league.season };
        if (league.history.length > 2 && prev && prev.playerId !== p.id && v >= 50) {
          addNews(league, { category: 'record', headline: `${fullName(p)} becomes the league's all-time leader in ${def.label.replace('Career ', '').toLowerCase()} (${v})`, teamIds: p.teamId !== null ? [p.teamId] : [], playerIds: [p.id], importance: 5 });
        }
      }
    }
  }
  // Team records.
  for (const t of league.teams) {
    const r = league.standings[t.id];
    if (!r || r.gp === 0) continue;
    const pts = r.w * 2 + r.otl;
    const team: [string, string, number, boolean][] = [
      ['tPoints', 'Most points in a season', pts, false],
      ['tWins', 'Most wins in a season', r.w, false],
      ['tGoals', 'Most goals in a season', r.gf, false],
      ['tFewestGA', 'Fewest goals against in a season', r.ga, true],
    ];
    for (const [key, label, v, lower] of team) {
      const cur = rb.team[key];
      if (!cur || (lower ? v < cur.value : v > cur.value)) {
        rb.team[key] = { key, label, value: v, teamId: t.id, season: league.season, detail: teamName(league, t.id) };
      }
    }
  }
}

export function careerSum(p: Player, playoffs: boolean): StatLine {
  const s = emptyStatLine();
  for (const c of p.career) if (c.playoffs === playoffs) addStatLine(s, c.stats);
  return s;
}
