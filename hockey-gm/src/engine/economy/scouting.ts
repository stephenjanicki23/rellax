/**
 * Imperfect information. The user only sees estimates of other players'
 * ability and potential; scouts narrow (and slightly bias) those estimates over
 * time. CPU teams have their own fixed scouting error per player.
 */
import { Rng, seedFrom } from '../core/rng';
import { clamp } from '../core/math';
import type { AttrKey, CsCategory, League, Player, Scout } from '../types';
import { addNews } from '../league/helpers';
import { roleForAbility, abilityWeights } from '../player/ability';
import { ARCHETYPES } from '../player/archetypes';
import { PERSONALITIES } from '../player/personality';

export interface Estimate {
  ca: number;
  pa: number;
  caLow: number;
  caHigh: number;
  paLow: number;
  paHigh: number;
  knowledge: number;
  exact: boolean;
}

export function knowledgeOf(league: League, p: Player): number {
  if (league.settings.godMode) return 100;
  const k = league.scouting.knowledge[p.id] ?? 0;
  if (p.teamId === league.userTeamId && p.status !== 'draft') return Math.max(k, 85);
  // Established NHL players are well known around the league.
  const base = p.status === 'active' ? 45 + Math.min(30, p.proSeasons * 6) : p.status === 'fa' ? 40 : 10;
  return clamp(Math.max(k, base), 0, 100);
}

// ───────────────────────────── scout specialities ─────────────────────────────

export const scoutRegion = (s: Scout): 'NA' | 'EU' => s.homeRegion ?? (s.id % 3 === 1 ? 'EU' : 'NA');
export const scoutFocus = (s: Scout): 'skaters' | 'goalies' | 'all' => s.focus ?? 'all';
export const scoutExperience = (s: Scout): number => s.experience ?? 8;

/** +1 when the player is the scout's speciality, -1 when he's the other kind, 0 for generalists. */
function focusMatch(s: Scout, p: Player): number {
  const f = scoutFocus(s);
  if (f === 'all') return 0;
  return (f === 'goalies') === (p.pos === 'G') ? 1 : -1;
}

/** A scout's effective judgement of one player: experience and speciality sharpen it. */
export function scoutJudgement(s: Scout, p: Player): { ca: number; pa: number } {
  const bonus = Math.min(20, scoutExperience(s)) + focusMatch(s, p) * 12;
  return { ca: clamp(s.judgingAbility + bonus, 1, 200), pa: clamp(s.judgingPotential + bonus, 1, 200) };
}

/** Weekly knowledge a scout gains on a player. */
export function scoutGain(s: Scout, p: Player): number {
  let gain = 7 + s.judgingAbility / 25;
  if (s.assignment.kind === 'draft' && s.assignment.region) gain *= 1.25;
  // He knows the rinks, coaches and contacts in his home region.
  if ((p.status === 'draft' || p.status === 'prospect') && prospectRegion(p) === scoutRegion(s)) gain *= 1.3;
  gain *= 1 + focusMatch(s, p) * 0.15;
  return gain * (1 + Math.min(15, scoutExperience(s)) * 0.01);
}

/** The scout who has watched this player the most (and how many weeks). */
export function leadScout(league: League, p: Player): { scout: Scout; weeks: number } | null {
  const seen = league.scouting.seenBy?.[p.id];
  if (!seen) return null;
  let best: { scout: Scout; weeks: number } | null = null;
  for (const s of league.scouts) {
    const w = seen[s.id] ?? 0;
    if (w > 0 && (!best || w > best.weeks)) best = { scout: s, weeks: w };
  }
  return best;
}

function scoutQuality(league: League, p: Player): { ca: number; pa: number } {
  if (!league.scouts.length) return { ca: 90, pa: 90 };
  const all = league.scouts.map((s) => scoutJudgement(s, p));
  const best = { ca: Math.max(...all.map((j) => j.ca)), pa: Math.max(...all.map((j) => j.pa)) };
  // The read comes mostly from the scout who has actually watched him.
  const lead = leadScout(league, p);
  if (!lead) return best;
  const j = scoutJudgement(lead.scout, p);
  return { ca: (j.ca * 2 + best.ca) / 3, pa: (j.pa * 2 + best.pa) / 3 };
}

/** New season: scouts gain experience (and a little judgement while still learning). */
export function scoutsNewSeason(league: League): void {
  const rng = new Rng(seedFrom(league.seed, 'scouts', league.season));
  for (const s of league.scouts) {
    const exp = scoutExperience(s);
    s.experience = exp + 1;
    if (exp < 12) {
      s.judgingAbility = clamp(s.judgingAbility + rng.int(0, 3), 1, 200);
      s.judgingPotential = clamp(s.judgingPotential + rng.int(0, 3), 1, 200);
    }
  }
  const seen = league.scouting.seenBy;
  if (seen) for (const id of Object.keys(seen)) if (!league.players[Number(id)] || league.players[Number(id)].status === 'retired') delete seen[Number(id)];
}

/** User-facing estimate of a player's current and potential ability. */
export function estimate(league: League, p: Player): Estimate {
  const k = knowledgeOf(league, p);
  if (k >= 100 || league.settings.godMode) return { ca: p.ca, pa: p.pa, caLow: p.ca, caHigh: p.ca, paLow: p.pa, paHigh: p.pa, knowledge: 100, exact: true };
  const q = scoutQuality(league, p);
  const r = new Rng(seedFrom(league.seed, 'est', p.id));
  const biasCa = r.normal(0, 1);
  const biasPa = r.normal(0, 1);
  const unk = (100 - k) / 100;
  const sdCa = 4 + unk * 26 * (1.15 - q.ca / 250);
  const sdPa = 5 + unk * 34 * (1.15 - q.pa / 250) + (p.status === 'draft' || p.status === 'prospect' ? 4 : 0);
  // Your own staff knows exactly what your players can do today; the ceiling is still a guess.
  const own = p.teamId === league.userTeamId && p.status !== 'draft';
  const ca = own ? p.ca : Math.round(clamp(p.ca + biasCa * sdCa * 0.55, 1, 200));
  const pa = Math.round(clamp(Math.max(ca, p.pa + biasPa * sdPa * 0.55), 1, 200));
  if (own) {
    return { ca, pa, caLow: ca, caHigh: ca, paLow: Math.round(clamp(Math.max(ca, pa - sdPa), 1, 200)), paHigh: Math.round(clamp(pa + sdPa, 1, 200)), knowledge: k, exact: false };
  }
  return {
    ca,
    pa,
    caLow: Math.round(clamp(ca - sdCa, 1, 200)),
    caHigh: Math.round(clamp(ca + sdCa, 1, 200)),
    paLow: Math.round(clamp(Math.max(ca, pa - sdPa), 1, 200)),
    paHigh: Math.round(clamp(pa + sdPa, 1, 200)),
    knowledge: k,
    exact: false,
  };
}

/** Displayed attribute (0-200) with uncertainty for poorly-scouted players. */
export function displayedAttr(league: League, p: Player, k: AttrKey): { value: number; range: number } {
  const know = knowledgeOf(league, p);
  if (know >= 95 || (p.teamId === league.userTeamId && p.status !== 'draft')) return { value: p.attrs[k], range: 0 };
  const r = new Rng(seedFrom(league.seed, 'attr', p.id, k));
  const sd = ((100 - know) / 100) * 30;
  return { value: Math.round(clamp(p.attrs[k] + r.normal(0, sd * 0.5), 1, 200)), range: Math.round(sd) };
}

/** CPU team's private view of a player's potential (fixed error per team/player). */
export function aiPerceivedPA(league: League, teamId: number, p: Player): number {
  const r = new Rng(seedFrom(league.seed, 'ai-scout', teamId, p.id));
  const sd = p.status === 'draft' || p.status === 'prospect' ? 11 : 5;
  return clamp(p.pa + r.normal(0, sd), p.ca, 200);
}

export function scoutReport(league: League, p: Player): { projection: string; strengths: string[]; weaknesses: string[]; personality: string | null; injury: string | null; summary: string } {
  const e = estimate(league, p);
  const k = e.knowledge;
  const w = abilityWeights(p.pos);
  const keys = (Object.keys(w) as AttrKey[]).filter((x) => (w[x] ?? 0) >= 0.5);
  const sorted = [...keys].sort((a, b) => p.attrs[b] - p.attrs[a]);
  const label = (x: AttrKey) => x.replace(/([A-Z])/g, ' $1').replace(/^g /, '').replace(/^./, (c) => c.toUpperCase());
  const strengths = k >= 25 ? sorted.slice(0, k >= 60 ? 3 : 2).map(label) : [];
  const weaknesses = k >= 40 ? sorted.slice(-2).map(label) : [];
  const personality = k >= 60 || league.scouting.interviewed?.[p.id] !== undefined ? PERSONALITIES[p.personality].label : null;
  const injury = k >= 50 ? (p.durability < 95 || p.traits.includes('injuryProne') ? 'Medical staff have durability concerns' : 'No significant injury concerns') : null;
  const ceiling = roleForAbility(p.pos, e.pa);
  const confidence = k >= 75 ? 'Projects as' : k >= 45 ? 'Likely projects as' : 'Early viewings suggest';
  const projection = `${confidence} a potential ${ceiling}.`;
  const arch = ARCHETYPES[p.archetype].label;
  const summary = `${arch}. ${projection}${strengths.length ? ` Strengths: ${strengths.join(', ')}.` : ''}`;
  return { projection, strengths, weaknesses, personality, injury, summary };
}

/** Weekly scouting progress for the user's scouts. */
export function weeklyScouting(league: League): void {
  const seen = (league.scouting.seenBy ??= {});
  for (const s of league.scouts) {
    const targets = scoutTargets(league, s);
    for (const p of targets) {
      const cur = league.scouting.knowledge[p.id] ?? 0;
      league.scouting.knowledge[p.id] = clamp(cur + scoutGain(s, p) * (cur > 70 ? 0.5 : 1), 0, 100);
      (seen[p.id] ??= {})[s.id] = (seen[p.id][s.id] ?? 0) + 1;
    }
  }
}

function scoutTargets(league: League, s: Scout): Player[] {
  const all = Object.values(league.players);
  const k = (p: Player) => league.scouting.knowledge[p.id] ?? 0;
  let pool: Player[] = [];
  switch (s.assignment.kind) {
    case 'draft': {
      // A scout focused on one region covers more of its prospects.
      const region = s.assignment.region;
      pool = all
        .filter((p) => p.status === 'draft' && (!region || prospectRegion(p) === region))
        .sort((a, b) => b.reputation - a.reputation)
        .slice(0, region ? 90 : 120);
      break;
    }
    case 'team': {
      const tid = s.assignment.teamId;
      pool = all.filter((p) => p.teamId === tid && (p.status === 'active' || p.status === 'prospect'));
      break;
    }
    case 'freeAgents':
      pool = all.filter((p) => p.status === 'fa').sort((a, b) => b.reputation - a.reputation).slice(0, 80);
      break;
    default:
      return [];
  }
  return pool.filter((p) => k(p) < 100).sort((a, b) => k(a) - k(b)).slice(0, 12);
}

/** Draft combine: physical testing reveals more about every prospect. */
export function runCombine(league: League): void {
  for (const p of Object.values(league.players)) {
    if (p.status !== 'draft') continue;
    const cur = league.scouting.knowledge[p.id] ?? 0;
    league.scouting.knowledge[p.id] = clamp(cur + 12, 0, 100);
  }
  league.draftCombineDone = true;
}

export function combineResults(p: Player): { label: string; value: number }[] {
  const a = p.attrs;
  return [
    { label: 'Skating speed', value: a.speed },
    { label: 'Acceleration', value: a.acceleration },
    { label: 'Strength', value: a.strength },
    { label: 'Endurance (VO2)', value: a.endurance },
    { label: 'Agility', value: a.agility },
  ];
}

// ───────────────────────────── draft scouting ─────────────────────────────

const NA_LEAGUES = /OHL|WHL|QMJHL|USHL|NCAA|USNTDP|USDP|BIG10|NCHC|HOCKEY EAST|ECAC|CCHA|ATLANTIC|BCHL|AJHL|SJHL|MJHL|CCHL|OJHL|NAHL|HIGH|PREP|U18|U-18/i;

/** Where a prospect plays: North America or Europe (drives regional scouting and the Central Scouting list). */
export function prospectRegion(p: Player): 'NA' | 'EU' {
  if (p.csRank) return p.csRank.category.startsWith('NA') ? 'NA' : 'EU';
  if (p.junior && NA_LEAGUES.test(p.junior)) return 'NA';
  return p.nat === 'CAN' || p.nat === 'USA' ? 'NA' : 'EU';
}

export function csCategoryOf(p: Player): CsCategory {
  const g = p.pos === 'G';
  return prospectRegion(p) === 'NA' ? (g ? 'NA-G' : 'NA-S') : g ? 'INT-G' : 'INT-S';
}

export const CS_LABEL: Record<CsCategory, string> = { 'NA-S': 'North American skaters', 'INT-S': 'International skaters', 'NA-G': 'North American goalies', 'INT-G': 'International goalies' };

/**
 * NHL Central Scouting rankings for the upcoming draft: a public consensus
 * from the league's bureau, which sees potential imperfectly (more so at the
 * midterm). Everyone can read it; it is not the truth.
 */
export function publishCentralRankings(league: League, stage: 'midterm' | 'final'): void {
  const r = new Rng(seedFrom(league.seed, 'central', league.season, stage));
  const lists: Record<CsCategory, number[]> = { 'NA-S': [], 'INT-S': [], 'NA-G': [], 'INT-G': [] };
  const scored = Object.values(league.players)
    .filter((p) => p.status === 'draft')
    .map((p) => ({ p, v: p.pa + p.ca * 0.25 + r.normal(0, stage === 'midterm' ? 9 : 6) + (p.devCurve === 'early' ? 3 : 0) }))
    .sort((a, b) => b.v - a.v);
  for (const { p } of scored) lists[csCategoryOf(p)].push(p.id);
  league.scouting.central = { season: league.season, stage, lists };
  const top = (c: CsCategory) => league.players[lists[c][0]];
  const na = top('NA-S');
  const intl = top('INT-S');
  addNews(league, {
    category: 'draft',
    headline: `NHL Central Scouting releases its ${stage} rankings: ${na ? `${na.first} ${na.last} tops North American skaters` : ''}${na && intl ? ', ' : ''}${intl ? `${intl.first} ${intl.last} leads the International list` : ''}`,
    teamIds: [],
    playerIds: [na?.id, intl?.id].filter((x): x is number => x !== undefined),
    importance: 3,
  });
}

/** A prospect's Central Scouting rank this season, if published. */
export function centralRank(league: League, p: Player): { category: CsCategory; rank: number; stage: 'midterm' | 'final' } | null {
  const c = league.scouting.central;
  if (!c || c.season !== league.season) return null;
  const category = csCategoryOf(p);
  const i = c.lists[category].indexOf(p.id);
  return i >= 0 ? { category, rank: i + 1, stage: c.stage } : null;
}

export const INTERVIEWS_PER_YEAR = 12;

export function interviewsLeft(league: League): number {
  const used = Object.values(league.scouting.interviewed ?? {}).filter((s) => s === league.season).length;
  return Math.max(0, INTERVIEWS_PER_YEAR - used);
}

/**
 * Combine interview: a sit-down with a prospect reveals his character and
 * sharpens your read on him. A limited number per draft.
 */
export function interviewProspect(league: League, p: Player): { ok: boolean; message: string } {
  if (p.status !== 'draft') return { ok: false, message: 'Only draft prospects can be interviewed.' };
  if (!league.draftCombineDone) return { ok: false, message: 'Interviews happen at the draft combine, after the regular season.' };
  if (league.scouting.interviewed?.[p.id] === league.season) return { ok: false, message: `You already interviewed ${p.first} ${p.last}.` };
  if (interviewsLeft(league) <= 0) return { ok: false, message: `You've used all ${INTERVIEWS_PER_YEAR} combine interviews this year.` };
  league.scouting.interviewed = { ...(league.scouting.interviewed ?? {}), [p.id]: league.season };
  league.scouting.knowledge[p.id] = clamp((league.scouting.knowledge[p.id] ?? 0) + 25, 0, 100);
  const pers = PERSONALITIES[p.personality];
  const d = p.attrs.determination;
  const drive = d >= 150 ? 'relentless work ethic' : d >= 115 ? 'a strong work ethic' : d >= 85 ? 'an average work ethic' : 'questions about his work ethic';
  return { ok: true, message: `Interview with ${p.first} ${p.last}: ${pers.label.toLowerCase()} personality, ${drive}. ${pers.description}` };
}

export function isShortlisted(league: League, p: Player): boolean {
  return (league.scouting.shortlist ?? []).includes(p.id);
}

export function toggleShortlist(league: League, p: Player): boolean {
  const list = (league.scouting.shortlist ?? []).filter((id) => league.players[id]?.status === 'draft');
  const on = !list.includes(p.id);
  league.scouting.shortlist = on ? [...list, p.id] : list.filter((id) => id !== p.id);
  return on;
}
