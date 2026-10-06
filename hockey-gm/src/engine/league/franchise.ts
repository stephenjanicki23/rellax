/**
 * Franchise history: what each player did for each club, team Halls of Fame,
 * retired numbers, and franchise records.
 *
 * SIMPLIFICATION: careers before this league began aren't recorded by team,
 * so franchise honours are earned with games played in this league.
 */
import type { League, Player, StatLine, Team } from '../types';
import { addStatLine, emptyStatLine, points } from '../core/statline';
import { addNews, teamName } from './helpers';
import { fullName } from '../player/ability';

const MAJOR = ['Hart', 'Norris', 'Vezina', 'Conn Smythe', 'Art Ross', 'Rocket', 'Calder', 'Selke'];

export interface FranchiseLine {
  seasons: number;
  stats: StatLine;
  cups: number;
  majorAwards: string[];
}

/** A player's regular-season totals, Cups and major awards with one club (this league only). */
export function franchiseLine(league: League, p: Player, teamId: number): FranchiseLine {
  const stats = emptyStatLine();
  const seasons = new Set<number>();
  for (const c of p.career) {
    if (c.teamId !== teamId || c.playoffs) continue;
    addStatLine(stats, c.stats);
    seasons.add(c.season);
  }
  const cur = league.seasonStats[p.id];
  if (cur && cur.teamId === teamId && cur.reg.gp && !p.career.some((c) => c.season === league.season)) {
    addStatLine(stats, cur.reg);
    seasons.add(league.season);
  }
  const cups = league.history.filter((h) => h.champion === teamId && p.career.some((c) => c.season === h.season && c.teamId === teamId && c.playoffs)).length;
  const majorAwards = p.awards.filter((a) => seasons.has(a.season) && MAJOR.some((m) => a.award.startsWith(m))).map((a) => `${a.award.split(' (')[0]} ${a.season + 1}`);
  return { seasons: seasons.size, stats, cups, majorAwards };
}

/** Good enough for the club's Hall of Fame. */
export function hallOfFameWorthy(p: Player, f: FranchiseLine): boolean {
  const gp = f.stats.gp;
  if (p.pos === 'G') return (gp >= 250 && f.stats.w >= 120) || f.majorAwards.length >= 1 || (f.cups >= 1 && gp >= 200);
  const pts = points(f.stats);
  return (gp >= 400 && pts >= (p.pos === 'D' ? 180 : 250)) || f.majorAwards.length >= 1 || (f.cups >= 1 && gp >= 300);
}

/** A true franchise icon: worthy of having his number retired. */
export function numberWorthy(p: Player, f: FranchiseLine): boolean {
  const gp = f.stats.gp;
  if (p.pos === 'G') return (gp >= 450 && f.stats.w >= 250) || (f.majorAwards.length >= 2 && gp >= 250) || (f.cups >= 2 && gp >= 300);
  const pts = points(f.stats);
  return (gp >= 700 && pts >= (p.pos === 'D' ? 400 : 600)) || (f.majorAwards.length >= 2 && gp >= 400) || (f.cups >= 2 && gp >= 400);
}

/** Called when a player retires: Halls of Fame induct him; CPU clubs retire icons' numbers. */
export function honourRetiree(league: League, p: Player): void {
  const teams = new Set(p.career.filter((c) => !c.playoffs).map((c) => c.teamId));
  for (const teamId of teams) {
    const team = league.teams[teamId];
    if (!team) continue;
    const f = franchiseLine(league, p, teamId);
    if (f.seasons < 2) continue;
    if (hallOfFameWorthy(p, f) && !(team.hallOfFame ?? []).some((h) => h.playerId === p.id)) {
      (team.hallOfFame ??= []).push({ playerId: p.id, name: fullName(p), pos: p.pos, season: league.season, line: summaryOf(p, f) });
      addNews(league, { category: 'retirement', headline: `${teamName(league, teamId)} induct ${fullName(p)} into the team Hall of Fame`, body: summaryOf(p, f), teamIds: [teamId], playerIds: [p.id], importance: 2 });
    }
    if (teamId !== league.userTeamId && numberWorthy(p, f)) retireNumber(league, team, p);
  }
}

export function summaryOf(p: Player, f: FranchiseLine): string {
  const core = p.pos === 'G' ? `${f.stats.gp} GP, ${f.stats.w} wins` : `${f.stats.gp} GP, ${f.stats.g} goals, ${points(f.stats)} points`;
  return `${f.seasons} seasons · ${core}${f.cups ? ` · ${f.cups} Cup${f.cups > 1 ? 's' : ''}` : ''}${f.majorAwards.length ? ` · ${f.majorAwards.join(', ')}` : ''}`;
}

export function retireNumber(league: League, team: Team, p: Player): { ok: boolean; message: string } {
  const list = (team.retiredNumbers ??= []);
  if (list.some((r) => r.playerId === p.id)) return { ok: false, message: 'Already retired.' };
  if (list.some((r) => r.number === p.number)) return { ok: false, message: `No. ${p.number} is already retired for ${list.find((r) => r.number === p.number)!.name}.` };
  list.push({ number: p.number, playerId: p.id, name: fullName(p), season: league.season });
  addNews(league, { category: 'retirement', headline: `${teamName(league, team.id)} retire No. ${p.number} in honour of ${fullName(p)}`, teamIds: [team.id], playerIds: [p.id], importance: 4 });
  return { ok: true, message: `No. ${p.number} will hang from the rafters for ${fullName(p)}.` };
}

/** Retired players worthy of a jersey retirement by the user's club who haven't been honoured. */
export function numberCandidates(league: League, teamId: number): { p: Player; f: FranchiseLine }[] {
  const team = league.teams[teamId];
  const done = new Set((team.retiredNumbers ?? []).map((r) => r.playerId));
  return Object.values(league.players)
    .filter((p) => p.status === 'retired' && !done.has(p.id) && p.career.some((c) => c.teamId === teamId))
    .map((p) => ({ p, f: franchiseLine(league, p, teamId) }))
    .filter(({ p, f }) => numberWorthy(p, f));
}

export interface FranchiseLeader {
  playerId: number;
  name: string;
  value: number;
  active: boolean;
}

/** Franchise career leaders (this league) in games, goals, assists, points and goalie wins. */
export function franchiseLeaders(league: League, teamId: number, top = 5): Record<'gp' | 'g' | 'a' | 'pts' | 'w', FranchiseLeader[]> {
  const rows = Object.values(league.players)
    .filter((p) => p.career.some((c) => c.teamId === teamId) || league.seasonStats[p.id]?.teamId === teamId)
    .map((p) => ({ p, f: franchiseLine(league, p, teamId) }))
    .filter((r) => r.f.stats.gp > 0);
  const lead = (val: (r: (typeof rows)[number]) => number, filter: (r: (typeof rows)[number]) => boolean = () => true) =>
    rows
      .filter(filter)
      .map((r) => ({ playerId: r.p.id, name: fullName(r.p), value: val(r), active: r.p.teamId === teamId }))
      .filter((x) => x.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, top);
  return {
    gp: lead((r) => r.f.stats.gp),
    g: lead((r) => r.f.stats.g, (r) => r.p.pos !== 'G'),
    a: lead((r) => r.f.stats.a1 + r.f.stats.a2, (r) => r.p.pos !== 'G'),
    pts: lead((r) => points(r.f.stats), (r) => r.p.pos !== 'G'),
    w: lead((r) => r.f.stats.w, (r) => r.p.pos === 'G'),
  };
}

/** Best single seasons for the club (this league). */
export function franchiseSeasonRecords(league: League, teamId: number): { label: string; value: number; playerId: number; name: string; season: number }[] {
  const lines: { p: Player; s: StatLine; season: number }[] = [];
  for (const p of Object.values(league.players)) {
    for (const c of p.career) if (c.teamId === teamId && !c.playoffs) lines.push({ p, s: c.stats, season: c.season });
    const cur = league.seasonStats[p.id];
    if (cur && cur.teamId === teamId && cur.reg.gp && !p.career.some((c) => c.season === league.season)) lines.push({ p, s: cur.reg, season: league.season });
  }
  const best = (label: string, val: (l: (typeof lines)[number]) => number, f: (l: (typeof lines)[number]) => boolean) => {
    const b = lines.filter(f).sort((x, y) => val(y) - val(x))[0];
    return b && val(b) > 0 ? [{ label, value: val(b), playerId: b.p.id, name: fullName(b.p), season: b.season }] : [];
  };
  return [
    ...best('Goals', (l) => l.s.g, (l) => l.p.pos !== 'G'),
    ...best('Assists', (l) => l.s.a1 + l.s.a2, (l) => l.p.pos !== 'G'),
    ...best('Points', (l) => points(l.s), (l) => l.p.pos !== 'G'),
    ...best('Points by a defenceman', (l) => points(l.s), (l) => l.p.pos === 'D'),
    ...best('Goalie wins', (l) => l.s.w, (l) => l.p.pos === 'G'),
    ...best('Shutouts', (l) => l.s.so, (l) => l.p.pos === 'G'),
  ];
}
