/**
 * A player's career as a timeline: season-by-season lines, ratings, awards,
 * injuries and the moves in between. Built only from what this save has
 * recorded; anything before the save started is noted, not invented.
 */
import type { League, Player, StatLine, TimelineEvent } from '../types';
import { addStatLine, emptyStatLine, points, savePct } from '../core/statline';

export interface CareerRow {
  season: number;
  age: number;
  teamId: number | null;
  reg?: StatLine;
  po?: StatLine;
  /** The season is still being played. */
  current: boolean;
  /** Ability at season end (development history). */
  ca?: number;
  awards: string[];
  injuries: { type: string; bodyPart: string; days: number }[];
  events: TimelineEvent[];
}

export interface CareerSummary {
  seasons: number;
  reg: StatLine;
  po: StatLine;
  teams: { teamId: number; from: number; to: number }[];
  best?: { season: number; label: string };
  awards: { award: string; count: number; seasons: number[] }[];
  cups: number[];
  peakCa?: { ca: number; season: number };
  injuryDays: number;
}

const CAREER_KINDS = new Set(['trade', 'signing', 'release', 'draft', 'extension', 'retirement', 'waiverClaim', 'buyout', 'offerSheet', 'arbitration', 'elc', 'termination']);

/** Logged events, topped up from the league's (trimmed) logs for saves that predate the per-player log. */
export function careerEvents(league: League, p: Player): TimelineEvent[] {
  const seen = new Set<string>();
  const out: TimelineEvent[] = [];
  // Older saves logged career milestones counted from the save's start for veterans; those totals were partial.
  const partial = (e: TimelineEvent) => !!p.nhlGamesBefore && (e.kind === 'milestone' && /first career goal|career goal No\.|career points/.test(e.text));
  const add = (e: TimelineEvent) => {
    if (partial(e)) return;
    const k = `${e.season}|${e.day}|${e.text}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(e);
  };
  for (const e of p.timeline ?? []) add(e);
  for (const t of league.transactions) if (CAREER_KINDS.has(t.kind) && t.playerIds.includes(p.id)) add({ season: t.season, day: t.day, kind: t.kind, text: t.description, teamIds: t.teamIds });
  for (const n of league.news) if ((n.category === 'milestone' || n.category === 'record') && n.playerIds.length <= 2 && n.playerIds.includes(p.id)) add({ season: n.season, day: n.day, kind: n.category, text: n.headline, teamIds: n.teamIds });
  return out.sort((a, b) => a.season - b.season || a.day - b.day);
}

export function careerTimeline(league: League, p: Player): { rows: CareerRow[]; summary: CareerSummary; before: { draft?: string; junior?: string; nhlGamesBefore?: number } } {
  const events = careerEvents(league, p);
  const seasons = new Set<number>();
  for (const c of p.career) seasons.add(c.season);
  const cur = league.seasonStats[p.id];
  const curPlayed = !!cur && (cur.reg.gp > 0 || cur.po.gp > 0) && !p.career.some((c) => c.season === league.season);
  if (curPlayed) seasons.add(league.season);
  for (const a of p.awards) seasons.add(a.season);
  for (const i of p.injuryHistory) seasons.add(i.season);
  for (const e of events) seasons.add(e.season);
  for (const [s] of p.caHistory) seasons.add(s);
  const draftEvent = events.some((e) => e.kind === 'draft');
  const draftLabel = p.draft ? `Drafted in ${p.draft.season + 1}: round ${p.draft.round}${p.draft.pick ? `, No. ${p.draft.pick} overall` : ''} by the ${league.teams[p.draft.teamId]?.name ?? 'club'}` : undefined;
  const first = Math.min(...seasons, Infinity);
  // A draft inside the save's span gets its own entry (unless the log already has it).
  if (p.draft && !draftEvent && p.draft.season >= first) {
    seasons.add(p.draft.season);
    events.push({ season: p.draft.season, day: 9999, kind: 'draft', text: draftLabel!, teamIds: [p.draft.teamId] });
  }
  const caBy = new Map(p.caHistory.map(([s, ca]) => [s, ca]));
  const rows: CareerRow[] = [...seasons]
    .sort((a, b) => a - b)
    .map((season) => {
      const reg = season === league.season && curPlayed ? cur!.reg : p.career.find((c) => c.season === season && !c.playoffs)?.stats;
      const po = season === league.season && curPlayed ? cur!.po : p.career.find((c) => c.season === season && c.playoffs)?.stats;
      const teamId = p.career.find((c) => c.season === season)?.teamId ?? (season === league.season && curPlayed ? cur!.teamId : null);
      return {
        season,
        age: season - p.birthYear,
        teamId,
        reg: reg && reg.gp > 0 ? reg : undefined,
        po: po && po.gp > 0 ? po : undefined,
        current: season === league.season && curPlayed && (league.phase === 'regular' || league.phase === 'playoffs' || league.phase === 'preseason'),
        ca: caBy.get(season),
        awards: p.awards.filter((a) => a.season === season).map((a) => a.award),
        injuries: p.injuryHistory.filter((i) => i.season === season),
        events: events.filter((e) => e.season === season),
      };
    });

  // Summary.
  const reg = emptyStatLine();
  const po = emptyStatLine();
  for (const r of rows) {
    if (r.reg) addStatLine(reg, r.reg);
    if (r.po) addStatLine(po, r.po);
  }
  const teams: CareerSummary['teams'] = [];
  for (const r of rows) {
    if (r.teamId === null || !r.reg) continue;
    const last = teams.at(-1);
    if (last && last.teamId === r.teamId) last.to = r.season;
    else teams.push({ teamId: r.teamId, from: r.season, to: r.season });
  }
  const g = p.pos === 'G';
  const played = rows.filter((r) => r.reg && r.reg.gp >= (g ? 15 : 20));
  const bestRow = played.sort((a, b) => (g ? savePct(b.reg!) * 1000 + b.reg!.w * 0.1 - (savePct(a.reg!) * 1000 + a.reg!.w * 0.1) : points(b.reg!) - points(a.reg!)))[0];
  const best = bestRow ? { season: bestRow.season, label: g ? `${bestRow.reg!.w} W, ${savePct(bestRow.reg!).toFixed(3).replace(/^0/, '')} SV%` : `${points(bestRow.reg!)} points (${bestRow.reg!.g} G)` } : undefined;
  const byAward = new Map<string, number[]>();
  for (const a of p.awards) {
    if (a.award.endsWith('Champion')) continue;
    byAward.set(a.award, [...(byAward.get(a.award) ?? []), a.season]);
  }
  const peak = p.caHistory.reduce<{ ca: number; season: number } | undefined>((m, [season, ca]) => (!m || ca > m.ca ? { ca, season } : m), undefined);
  return {
    rows,
    summary: {
      seasons: rows.filter((r) => r.reg).length,
      reg,
      po,
      teams,
      best,
      awards: [...byAward].map(([award, s]) => ({ award, count: s.length, seasons: s })).sort((a, b) => b.count - a.count),
      cups: p.awards.filter((a) => a.award.endsWith('Champion')).map((a) => a.season),
      peakCa: peak,
      injuryDays: p.injuryHistory.reduce((t, i) => t + i.days, 0),
    },
    before: {
      draft: p.draft && p.draft.season < first ? draftLabel : undefined,
      junior: p.junior,
      nhlGamesBefore: p.nhlGamesBefore,
    },
  };
}
