/**
 * The AHL. Every NHL club has an affiliate (real names from
 * data/ahl/affiliates.json) whose roster is the organisation's signed
 * prospects in the minors plus players on AHL-only contracts. Junior-age
 * players from the CHL stay in junior (CHL-NHL agreement) and unsigned draft
 * picks play elsewhere, so neither dresses for the affiliate.
 *
 * Games are simulated with a fast box-score model rather than the full NHL
 * engine: team strength sets each side's expected goals, and goals, assists,
 * shots and saves are shared out by role and ability. That gives every
 * prospect a real season line (and the affiliate a record) at a fraction of
 * the cost. The top 16 teams play for the Calder Cup.
 */
import { Rng, seedFrom } from '../core/rng';
import { clamp } from '../core/math';
import type { AhlLine, AhlState, AhlTeamRecord, League, Player, Position, Team } from '../types';
import { addNews, teamName } from './helpers';
import { generatePlayer } from '../player/generate';
import { isForward } from '../player/ability';
import AFFILIATES_JSON from '../../../data/ahl/affiliates.json';

interface AffiliateData {
  abbrev: string;
  name: string;
  players: { first: string; last: string; born: string | null; pos: string; term: number }[];
}
const AFFILIATES = (AFFILIATES_JSON as { teams: Record<string, AffiliateData> }).teams;

/** Games per AHL team in a season (the AHL plays 72). */
export const AHL_GAMES = 72;
const CHL = /^(OHL|WHL|QMJHL)$/i;

const emptyLine = (): AhlLine => ({ gp: 0, g: 0, a: 0, sog: 0, pim: 0, pm: 0, gs: 0, sa: 0, ga: 0, w: 0, l: 0, otl: 0, so: 0 });

export function newAhlState(teams: Team[], season: number): AhlState {
  return {
    season,
    champion: null,
    stats: {},
    teams: teams.map((t) => {
      const real = AFFILIATES[t.abbr];
      return { nhlTeamId: t.id, abbrev: real?.abbrev ?? t.abbr.slice(0, 2) + 'A', name: real?.name ?? `${t.city} Affiliate`, gp: 0, w: 0, l: 0, otl: 0, gf: 0, ga: 0 };
    }),
  };
}

export function affiliateOf(league: League, teamId: number): AhlTeamRecord | undefined {
  return league.ahl?.teams.find((t) => t.nhlTeamId === teamId);
}

/**
 * Real AHL-contract players for each organisation (AHL veterans and
 * prospects without NHL deals). Ability is estimated from age: most are AHL
 * regulars a step below NHL level. SIMPLIFICATION: no public ratings.
 */
export function buildAhlContractPlayers(rng: Rng, teams: Team[], season: number, nextId: () => number): Player[] {
  const out: Player[] = [];
  for (const t of teams) {
    const club = AFFILIATES[t.abbr];
    if (!club) continue;
    for (const r of club.players) {
      if (!r.born) continue;
      const birthYear = Number(r.born.slice(0, 4));
      const age = season - birthYear;
      const pos = (['C', 'LW', 'RW', 'D', 'G'].includes(r.pos) ? r.pos : 'C') as Position;
      const ca = Math.round(clamp((age <= 22 ? 98 : age <= 26 ? 106 : 110) + rng.normal(0, 6), 85, 128));
      const pa = Math.round(clamp(ca + (age <= 23 ? rng.float(4, 16) : age <= 26 ? rng.float(0, 6) : 0), ca, 140));
      const p = generatePlayer(rng, { id: nextId(), pos, targetCA: ca, age, season, pa });
      p.first = r.first;
      p.last = r.last;
      p.birthYear = birthYear;
      p.ca = Math.min(p.ca, p.pa);
      p.teamId = t.id;
      p.status = 'prospect';
      p.contract = null;
      p.rightsTeamId = null;
      p.ahlContract = true;
      p.proSeasons = Math.max(0, age - 20);
      p.reputation = Math.round(clamp((ca - 95) * 0.4, 1, 20));
      out.push(p);
    }
  }
  return out;
}

const healthy = (p: Player) => !p.injury || p.injury.daysRemaining <= 0;

/** Can he play for the affiliate? Signed (NHL or AHL deal), in the minors, not a junior-age CHL player. */
export function ahlEligible(league: League, p: Player): boolean {
  if (p.status !== 'prospect' || p.teamId === null) return false;
  if (!p.contract && !p.ahlContract) return false; // unsigned draft picks play junior/college/Europe
  const age = league.season - p.birthYear;
  if (age <= 19 && p.junior && CHL.test(p.junior) && !p.ahlContract) return false;
  return true;
}

/** Where a prospect is playing this season (for the UI). */
export function prospectLevel(league: League, p: Player): string {
  if (ahlEligible(league, p)) return affiliateOf(league, p.teamId!)?.abbrev ?? 'AHL';
  if (!p.contract && !p.ahlContract) return p.junior ?? 'Unsigned';
  return p.junior ? `${p.junior} (junior)` : 'Junior';
}

interface Dressed {
  F: Player[];
  D: Player[];
  G: Player[];
  strength: number;
}

/** Ice-time weights by depth-chart slot (top line plays most). */
const F_SHARE = [1.3, 1.3, 1.3, 1.1, 1.1, 1.1, 0.9, 0.9, 0.9, 0.6, 0.6, 0.6];
const D_SHARE = [1.25, 1.25, 1, 1, 0.8, 0.8];
/** AHL replacement level fills empty slots (call-ups, injuries, a thin system). */
const REPLACEMENT = 100;

function dress(league: League, teamId: number): Dressed {
  const pool = Object.values(league.players).filter((p) => p.teamId === teamId && healthy(p) && ahlEligible(league, p));
  const F = pool.filter((p) => isForward(p.pos)).sort((a, b) => b.ca - a.ca).slice(0, 12);
  const D = pool.filter((p) => p.pos === 'D').sort((a, b) => b.ca - a.ca).slice(0, 6);
  const G = pool.filter((p) => p.pos === 'G').sort((a, b) => b.ca - a.ca);
  const fv = F_SHARE.reduce((s, w, i) => s + w * (F[i]?.ca ?? REPLACEMENT), 0) / F_SHARE.reduce((s, w) => s + w, 0);
  const dv = D_SHARE.reduce((s, w, i) => s + w * (D[i]?.ca ?? REPLACEMENT), 0) / D_SHARE.reduce((s, w) => s + w, 0);
  return { F, D, G, strength: fv * 0.55 + dv * 0.3 + (G[0]?.ca ?? REPLACEMENT) * 0.15 };
}

function line(league: League, p: Player, team: string): AhlLine & { team: string } {
  const st = league.ahl!.stats;
  const cur = st[p.id];
  if (cur && cur.team === team) return cur;
  return (st[p.id] = { ...emptyLine(), team });
}

function poisson(rng: Rng, mean: number): number {
  // Knuth's method for small means; a normal approximation for larger ones (shot counts).
  if (mean > 12) return Math.max(0, Math.round(mean + Math.sqrt(mean) * rng.normal(0, 1)));
  const L = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng.next();
  } while (p > L);
  return k - 1;
}

/** One AHL game between two affiliates. */
function playGame(league: League, rng: Rng, home: AhlTeamRecord, away: AhlTeamRecord): void {
  const sides = [home, away].map((t) => ({ t, d: dress(league, t.nhlTeamId) }));
  const xg = sides.map((s, i) => clamp(3.05 * Math.exp(0.035 * (s.d.strength - sides[1 - i].d.strength)) + (i === 0 ? 0.12 : 0), 1.2, 5.5));
  const goals = xg.map((m) => poisson(rng, m));
  let ot = false;
  let so = false;
  if (goals[0] === goals[1]) {
    ot = true;
    const homeWins = rng.chance(clamp(0.5 + (sides[0].d.strength - sides[1].d.strength) * 0.01, 0.3, 0.7));
    if (rng.chance(0.6)) goals[homeWins ? 0 : 1]++;
    else so = true;
    if (so) goals[homeWins ? 0 : 1]++; // shootout winner credited one goal on the scoreboard
  }
  const winner = goals[0] > goals[1] ? 0 : 1;
  sides.forEach((s, i) => {
    const rec = s.t;
    const ga = goals[1 - i];
    rec.gp++;
    rec.gf += goals[i];
    rec.ga += ga;
    if (i === winner) rec.w++;
    else if (ot) rec.otl++;
    else rec.l++;
    const skaters = [...s.d.F.map((p, k) => ({ p, w: F_SHARE[k] })), ...s.d.D.map((p, k) => ({ p, w: D_SHARE[k] * 0.75 }))];
    for (const { p } of skaters) line(league, p, rec.abbrev).gp++;
    const shots = Math.max(goals[i] + 8, poisson(rng, 29 + (xg[i] - 3) * 4));
    // Shots and goals go to the dressed players by role and skill; empty slots are replacement players (not tracked).
    const slots = [...skaters, ...Array.from({ length: Math.max(0, 18 - skaters.length) }, () => null)];
    const scorer = (forAssist: boolean) => {
      const weights = slots.map((x) => (x ? x.w * Math.exp(((forAssist ? x.p.attrs.passing : x.p.attrs.wristAccuracy) - 100) / 60) * (isForward(x.p.pos) ? 1 : forAssist ? 0.8 : 0.45) : 0.7));
      const total = weights.reduce((a, b) => a + b, 0);
      let r = rng.next() * total;
      for (let k = 0; k < slots.length; k++) {
        r -= weights[k];
        if (r <= 0) return slots[k];
      }
      return null;
    };
    for (let k = 0; k < shots; k++) {
      const x = scorer(false);
      if (x) line(league, x.p, rec.abbrev).sog++;
    }
    const regGoals = so && i === winner ? goals[i] - 1 : goals[i];
    for (let k = 0; k < regGoals; k++) {
      const sc = scorer(false);
      if (sc) line(league, sc.p, rec.abbrev).g++;
      const assists = rng.chance(0.9) ? (rng.chance(0.7) ? 2 : 1) : 0;
      const used = new Set<Player>(sc ? [sc.p] : []);
      for (let a = 0; a < assists; a++) {
        const as = scorer(true);
        if (as && !used.has(as.p)) {
          used.add(as.p);
          line(league, as.p, rec.abbrev).a++;
        }
      }
    }
    for (const { p } of skaters) {
      const l = line(league, p, rec.abbrev);
      if (rng.chance(0.12)) l.pim += 2;
      l.pm += goals[i] > ga ? (rng.chance(0.5) ? 1 : 0) : goals[i] < ga ? (rng.chance(0.5) ? -1 : 0) : 0;
    }
    // Goalie: the backup gets about a third of the starts.
    const g = s.d.G[1] && rng.chance(0.32) ? s.d.G[1] : s.d.G[0];
    if (g) {
      const gl = line(league, g, rec.abbrev);
      const oppShots = Math.max(ga + 8, poisson(rng, 29 + (xg[1 - i] - 3) * 4));
      const regGa = so && i !== winner ? ga - 1 : ga;
      gl.gp++;
      gl.gs++;
      gl.sa += oppShots;
      gl.ga += regGa;
      if (i === winner) gl.w++;
      else if (ot) gl.otl++;
      else gl.l++;
      if (regGa === 0) gl.so++;
    }
  });
}

/** Daily: about 42% of AHL teams play on a given NHL game day (72 games over the season). */
export function ahlDay(league: League): void {
  if (league.phase !== 'regular' || !league.ahl) return;
  const lastDay = league.schedule.reduce((m, g) => (g.playoff ? m : Math.max(m, g.day)), 0);
  if (league.day > lastDay) return;
  const rng = new Rng(seedFrom(league.seed, 'ahl', league.season, league.day));
  const remainingDays = Math.max(1, lastDay - league.day + 1);
  const playing = rng.shuffle(league.ahl.teams.filter((t) => t.gp < AHL_GAMES && rng.chance(clamp((AHL_GAMES - t.gp) / remainingDays, 0, 1))));
  for (let i = 0; i + 1 < playing.length; i += 2) playGame(league, rng, playing[i], playing[i + 1]);
}

export function ahlStandings(league: League): AhlTeamRecord[] {
  return [...(league.ahl?.teams ?? [])].sort((a, b) => b.w * 2 + b.otl - (a.w * 2 + a.otl) || a.gp - b.gp || b.gf - b.ga - (a.gf - a.ga));
}

/** AHL scoring leaders. */
export function ahlLeaders(league: League, n = 10): { p: Player; l: AhlLine & { team: string } }[] {
  return Object.entries(league.ahl?.stats ?? {})
    .map(([id, l]) => ({ p: league.players[Number(id)], l }))
    .filter((x) => x.p && x.p.pos !== 'G' && x.l.gp > 0)
    .sort((a, b) => b.l.g + b.l.a - (a.l.g + a.l.a) || b.l.g - a.l.g)
    .slice(0, n);
}

/** Calder Cup: the top 16 by points, best-of-five then best-of-seven rounds decided by team strength. */
export function ahlPlayoffs(league: League): void {
  if (!league.ahl || league.ahl.champion !== null) return;
  const rng = new Rng(seedFrom(league.seed, 'calder', league.season));
  let alive = ahlStandings(league).slice(0, 16);
  if (alive.length < 2) return;
  let round = 0;
  while (alive.length > 1) {
    const next: AhlTeamRecord[] = [];
    const need = round === 0 ? 3 : 4;
    for (let i = 0; i < alive.length / 2; i++) {
      const a = alive[i];
      const b = alive[alive.length - 1 - i];
      const pa = clamp(0.5 + (dress(league, a.nhlTeamId).strength - dress(league, b.nhlTeamId).strength) * 0.012 + 0.03, 0.2, 0.8);
      let wa = 0;
      let wb = 0;
      while (wa < need && wb < need) rng.chance(pa) ? wa++ : wb++;
      next.push(wa > wb ? a : b);
    }
    alive = next;
    round++;
  }
  const champ = alive[0];
  league.ahl.champion = champ.nhlTeamId;
  addNews(league, {
    category: 'league',
    headline: `The ${champ.name} (${teamName(league, champ.nhlTeamId)} affiliate) win the Calder Cup`,
    teamIds: [champ.nhlTeamId],
    playerIds: [],
    importance: champ.nhlTeamId === league.userTeamId ? 3 : 1,
  });
}

/** Season over: archive AHL lines to players' AHL careers and reset for next season. */
export function archiveAhlSeason(league: League): void {
  const ahl = league.ahl;
  if (!ahl) return;
  for (const [id, l] of Object.entries(ahl.stats)) {
    const p = league.players[Number(id)];
    if (!p || l.gp === 0) continue;
    const { team, ...stats } = l;
    (p.ahlCareer ??= []).push({ season: ahl.season, team, stats });
  }
}

export function resetAhlSeason(league: League): void {
  league.ahl = newAhlState(league.teams, league.season);
}

/** Share of his affiliate's games a player has dressed for, and his points per game (for development and call-ups). */
export function ahlUsage(league: League, p: Player): { share: number; ppg: number; gp: number } | null {
  const l = league.ahl?.stats[p.id];
  const team = p.teamId !== null ? affiliateOf(league, p.teamId) : undefined;
  if (!l || !team || team.gp === 0) return null;
  return { share: clamp(l.gp / team.gp, 0, 1), ppg: l.gp ? (l.g + l.a) / l.gp : 0, gp: l.gp };
}

/** Monthly note on the user's affiliate. */
export function affiliateReport(league: League): void {
  const t = affiliateOf(league, league.userTeamId);
  if (!t || t.gp < 5) return;
  const top = ahlLeaders(league, 400).find((x) => x.l.team === t.abbrev);
  const rank = ahlStandings(league).findIndex((x) => x.nhlTeamId === t.nhlTeamId) + 1;
  addNews(league, {
    category: 'development',
    headline: `AHL: the ${t.name} are ${t.w}-${t.l}-${t.otl} (${rank}${rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th'} in the league)${top ? `; ${top.p.first} ${top.p.last} leads them with ${top.l.g + top.l.a} points` : ''}`,
    teamIds: [league.userTeamId],
    playerIds: top ? [top.p.id] : [],
    importance: 1,
  });
}
