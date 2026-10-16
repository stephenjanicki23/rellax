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
import { autoLines } from '../team/lines';
import { toGamePlayer } from './gameInput';
import { simulateGame } from '../sim/engine';
import type { GameInput, GameResult, GameTeamInput } from '../sim/gameTypes';
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

/** Replacement-level players for empty AHL slots (call-ups, injuries, a thin system): they play, but aren't tracked. */
function filler(rng: Rng, league: League, pos: Position, id: number): Player {
  const p = generatePlayer(rng, { id, pos, targetCA: REPLACEMENT, age: 24, season: league.season });
  return { ...p, teamId: null, status: 'active' };
}

/** Phantom ids are negative and never collide with real players (or with the other bench). */
const PHANTOM_BASE = -1_000_000;

/** A full AHL lineup for tonight: the affiliate's dressed players plus replacement-level fill. */
function lineup(league: League, rec: AhlTeamRecord, rng: Rng): Player[] {
  const d = dress(league, rec.nhlTeamId);
  const out = [...d.F, ...d.D, ...d.G.slice(0, 2)];
  let k = 0;
  const fill = (pos: Position) => out.push(filler(rng, league, pos, PHANTOM_BASE - rec.nhlTeamId * 100 - k++));
  const fwdPos: Position[] = ['C', 'LW', 'RW'];
  for (let i = d.F.length; i < 12; i++) fill(fwdPos[i % 3]);
  for (let i = d.D.length; i < 6; i++) fill('D');
  for (let i = Math.min(2, d.G.length); i < 2; i++) fill('G');
  return out;
}

/** Reference: the average rating of NHL skaters (the engine's baseline is measured against it). */
let nhlAttrRef: { key: string; v: number } | null = null;
const meanAttr = (p: Player) => {
  const v = Object.values(p.attrs) as number[];
  return v.reduce((a, b) => a + b, 0) / v.length;
};
/**
 * AHL players are rated well below NHL players, so the engine measures them against an AHL
 * "average" instead: the NHL baseline shifted by how far AHL ratings sit below NHL ratings.
 * An AHL game then plays like AHL hockey (similar scoring), not like two NHL fourth lines.
 */
function ahlBaseline(league: League, players: Player[]): number {
  const key = `${league.season}`;
  if (!nhlAttrRef || nhlAttrRef.key !== key) {
    const nhl = Object.values(league.players).filter((p) => p.status === 'active' && p.teamId !== null && p.pos !== 'G');
    nhlAttrRef = { key, v: nhl.length ? nhl.reduce((a, p) => a + meanAttr(p), 0) / nhl.length : 102 };
  }
  const sk = players.filter((p) => p.pos !== 'G' && p.id >= 0);
  const ahlMean = sk.length ? sk.reduce((a, p) => a + meanAttr(p), 0) / sk.length : nhlAttrRef.v - 21;
  return (league.ratingBaseline ?? 120) + (ahlMean - nhlAttrRef.v);
}

function ahlTeamInput(league: League, rec: AhlTeamRecord, players: Player[]): GameTeamInput {
  const lines = autoLines(players.map((p) => ({ ...p, status: 'active' as const })));
  const parent = league.teams[rec.nhlTeamId];
  return {
    teamId: rec.nhlTeamId,
    abbr: rec.abbrev,
    name: rec.name,
    players: players.map((p) => toGamePlayer(p, league.season)),
    lines,
    // Affiliates play their parent club's system.
    tactics: parent.tactics,
    coach: null,
    morale: 0,
  };
}

export interface AhlGame {
  home: AhlTeamRecord;
  away: AhlTeamRecord;
  input: GameInput;
}

/** One AHL game, set up for the engine (the same engine the NHL plays on). */
function ahlGame(league: League, home: AhlTeamRecord, away: AhlTeamRecord, seed: number, playoff: boolean): AhlGame {
  const rng = new Rng(seed);
  const hp = lineup(league, home, rng);
  const ap = lineup(league, away, rng);
  return {
    home,
    away,
    input: {
      home: ahlTeamInput(league, home, hp),
      away: ahlTeamInput(league, away, ap),
      seed,
      playoff,
      recordEvents: false,
      regularSeasonOT: league.config.season.regularSeasonOT,
      ratingBaseline: ahlBaseline(league, [...hp, ...ap]),
    },
  };
}

/** Book an engine result: standings, and every tracked player's line straight from the box score. */
function applyAhlGame(league: League, g: AhlGame, r: GameResult): void {
  const sides = [g.home, g.away] as const;
  const goals = [r.homeGoals, r.awayGoals];
  const winner = goals[0] > goals[1] ? 0 : 1;
  sides.forEach((rec, i) => {
    rec.gp++;
    rec.gf += goals[i];
    rec.ga += goals[1 - i];
    if (i === winner) rec.w++;
    else if (r.ot || r.so) rec.otl++;
    else rec.l++;
  });
  for (const [idStr, pl] of Object.entries(r.players)) {
    const id = Number(idStr);
    if (id < 0 || !league.players[id]) continue;
    const rec = sides[pl.team];
    const l = line(league, league.players[id], rec.abbrev);
    const goalie = league.players[id].pos === 'G';
    if (goalie) {
      if (pl.gtoi <= 0 && pl.sa <= 0) continue;
      l.gp++;
      const starter = (pl.team === 0 ? g.input.home : g.input.away).lines.goalies[0];
      if (starter === id) l.gs++;
      l.sa += pl.sa;
      l.ga += pl.ga;
      if (r.winningGoalie === id) {
        l.w++;
        if (pl.ga === 0) l.so++;
      }
      if (r.losingGoalie === id) {
        if (r.ot || r.so) l.otl++;
        else l.l++;
      }
      continue;
    }
    l.gp++;
    l.g += pl.g;
    l.a += pl.a1 + pl.a2;
    l.sog += pl.sog;
    l.pim += pl.pim;
    l.pm += pl.pm;
  }
}

/** Tonight's AHL slate: about 42% of teams play on a given NHL game day (72 games over the season). */
export function planAhlDay(league: League): AhlGame[] {
  if (league.phase !== 'regular' || !league.ahl) return [];
  const lastDay = league.schedule.reduce((m, g) => (g.playoff ? m : Math.max(m, g.day)), 0);
  if (league.day > lastDay) return [];
  const rng = new Rng(seedFrom(league.seed, 'ahl', league.season, league.day));
  const remainingDays = Math.max(1, lastDay - league.day + 1);
  const playing = rng.shuffle(league.ahl.teams.filter((t) => t.gp < AHL_GAMES && rng.chance(clamp((AHL_GAMES - t.gp) / remainingDays, 0, 1))));
  const games: AhlGame[] = [];
  for (let i = 0; i + 1 < playing.length; i += 2) games.push(ahlGame(league, playing[i], playing[i + 1], seedFrom(league.seed, 'ahl-game', league.season, league.day, i), false));
  return games;
}

/** Play (or book already-played results for) tonight's AHL games. */
export function ahlDay(league: League, planned?: { games: AhlGame[]; results: GameResult[] }): void {
  const games = planned?.games ?? planAhlDay(league);
  games.forEach((g, i) => applyAhlGame(league, g, planned?.results[i] ?? simulateGame(g.input)));
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

/** Calder Cup: the top 16 by points play best-of-five then best-of-seven series, every game on the engine. */
export function ahlPlayoffs(league: League): void {
  if (!league.ahl || league.ahl.champion !== null) return;
  let alive = ahlStandings(league).slice(0, 16);
  if (alive.length < 2) return;
  let round = 0;
  while (alive.length > 1) {
    const next: AhlTeamRecord[] = [];
    const need = round === 0 ? 3 : 4;
    for (let i = 0; i < alive.length / 2; i++) {
      const a = alive[i];
      const b = alive[alive.length - 1 - i];
      let wa = 0;
      let wb = 0;
      // Higher seed has home ice: 2-2-1 (best of five) / 2-2-1-1-1 (best of seven).
      const homeA = need === 3 ? [true, true, false, false, true] : [true, true, false, false, true, false, true];
      for (let gno = 0; wa < need && wb < need; gno++) {
        const aHome = homeA[gno];
        const g = ahlGame(league, aHome ? a : b, aHome ? b : a, seedFrom(league.seed, 'calder', league.season, round, i, gno), true);
        const r = simulateGame(g.input);
        const homeWon = r.homeGoals > r.awayGoals;
        if (homeWon === aHome) wa++;
        else wb++;
      }
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
