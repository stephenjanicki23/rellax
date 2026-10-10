import type { League, Player, SeasonAwardResult, StatLine } from '../types';
import { points, gsax, savePct, faceoffPct, corsiPct } from '../core/statline';
import { addNews, teamName, points as recPoints } from './helpers';
import { fullName } from '../player/ability';
import { Rng, seedFrom } from '../core/rng';
import { BROADCASTERS, GMS, PLAYERS, WRITERS, judgementSd, vote, type AllStarSlot, type AwardBallot, type AwardsNight, type Finalist, type VoteCand } from './awardsNight';

export const AWARD_NAMES = {
  mvp: 'Hart Trophy (MVP)',
  scoring: 'Art Ross Trophy (Points)',
  goals: 'Rocket Trophy (Goals)',
  goalie: 'Vezina Trophy (Goaltender)',
  defense: 'Norris Trophy (Defenseman)',
  rookie: 'Calder Trophy (Rookie)',
  selke: 'Selke Trophy (Defensive Forward)',
  coach: 'Jack Adams Award (Coach)',
  lindsay: "Ted Lindsay Award (Players' MVP)",
  byng: 'Lady Byng Trophy (Sportsmanship)',
  jennings: 'Jennings Trophy (Fewest Goals Against)',
  playoffMvp: 'Conn Smythe Trophy (Playoff MVP)',
  presidents: "Presidents' Trophy",
};

interface Cand {
  p: Player;
  s: StatLine;
  teamId: number;
}

export function isRookieSeason(p: Player, season: number): boolean {
  const age = season - p.birthYear;
  if (age > 26) return false;
  // NHL games before this save count too (the Calder excludes anyone with more than 25 prior games).
  if ((p.nhlGamesBefore ?? 0) > 25) return false;
  return !p.career.some((c) => !c.playoffs && c.season < season && c.stats.gp > 25);
}

function best<T>(arr: T[], score: (t: T) => number): T | undefined {
  let b: T | undefined;
  let bs = -Infinity;
  for (const x of arr) {
    const v = score(x);
    if (v > bs) {
      bs = v;
      b = x;
    }
  }
  return b;
}

export function teamPctOf(league: League, id: number): number {
  const r = league.standings[id];
  return r && r.gp ? recPoints(r) / (r.gp * 2) : 0.5;
}

/** Award scoring, shared by the season-end awards and the in-season race. */
export const SCORERS = {
  hartSkater: (league: League, c: Cand) => points(c.s) + c.s.g * 0.25 + (teamPctOf(league, c.teamId) - 0.5) * 45 + (c.p.pos === 'D' ? 8 : 0),
  hartGoalie: (league: League, c: Cand) => gsax(c.s) * 2.1 + c.s.w * 0.6 + (teamPctOf(league, c.teamId) - 0.5) * 45,
  vezina: (_l: League, c: Cand) => gsax(c.s) + (savePct(c.s) - 0.905) * 300 + c.s.w * 0.15,
  norris: (_l: League, c: Cand) => points(c.s) + (corsiPct(c.s) - 0.5) * 60 + c.s.pm * 0.4 + (c.s.toi / c.s.gp / 60) * 1.2 + c.s.blocks * 0.04,
  calder: (_l: League, c: Cand) => (c.p.pos === 'G' ? gsax(c.s) * 2.4 + c.s.w * 0.5 : points(c.s) * (c.p.pos === 'D' ? 1.3 : 1) + c.s.g * 0.2),
  selke: (_l: League, c: Cand) => {
    const s = c.s;
    const xgShare = s.xgf + s.xga > 0 ? s.xgf / (s.xgf + s.xga) : 0.5;
    const fo = s.fow + s.fol > 200 ? (faceoffPct(s) - 0.5) * 40 : 0;
    return s.tk * 0.25 + fo + (s.toiPK / s.gp / 60) * 4 + (xgShare - 0.5) * 60 + s.pm * 0.3 + points(s) * 0.12 + c.p.attrs.defAwareness * 0.05;
  },
};
export type AwardCand = Cand;

export function computeAwards(league: League): SeasonAwardResult[] {
  const out: SeasonAwardResult[] = [];
  const cands: Cand[] = [];
  for (const [idStr, e] of Object.entries(league.seasonStats)) {
    const p = league.players[Number(idStr)];
    if (!p) continue;
    if (e.reg.gp > 0) cands.push({ p, s: e.reg, teamId: e.teamId });
  }
  const rng = new Rng(seedFrom(league.seed, 'awards', league.season));
  const ballots: AwardBallot[] = [];
  const skaters = cands.filter((c) => c.p.pos !== 'G');
  const goalies = cands.filter((c) => c.p.pos === 'G' && c.s.gp >= 25);
  const gLine = (c: Cand) => `${savePct(c.s).toFixed(3)} SV%, ${gsax(c.s).toFixed(1)} GSAx`;
  const vc = (c: Cand, score: number, value: string): VoteCand => ({
    playerId: c.p.id,
    teamId: c.teamId,
    score,
    value,
  });
  const push = (award: string, w: VoteCand | undefined) => {
    if (w)
      out.push({
        award,
        playerId: w.playerId,
        coachId: w.coachId,
        teamId: w.teamId,
        value: w.value,
      });
  };
  /** A voted award: the panel's winner takes it. */
  const voted = (award: string, who: { voters: string; panel: number; scale: number[] }, pool: VoteCand[]) => {
    const results = vote(rng, pool, who.panel, who.scale);
    ballots.push({ award, ...who, results });
    push(award, results[0]);
  };
  /** Decided by the numbers: the top five by the stat, no ballots. */
  const byNumbers = (award: string, pool: VoteCand[], note: string) => {
    const results = [...pool]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((c) => ({ ...c, pts: 0, firsts: 0, named: 0 }));
    ballots.push({ award, voters: '', panel: 0, scale: [], results, note });
    push(award, results[0]);
  };

  byNumbers(
    AWARD_NAMES.scoring,
    skaters.map((c) => vc(c, points(c.s) + c.s.g * 0.01, `${points(c.s)} pts (${c.s.g} G)`)),
    'Most regular-season points (goals break a tie).',
  );
  byNumbers(
    AWARD_NAMES.goals,
    skaters.map((c) => vc(c, c.s.g + points(c.s) * 0.001, `${c.s.g} goals`)),
    'Most regular-season goals.',
  );

  const hartPool = [...skaters.filter((c) => c.s.gp >= 40).map((c) => vc(c, SCORERS.hartSkater(league, c), `${points(c.s)} pts`)), ...goalies.map((c) => vc(c, SCORERS.hartGoalie(league, c), gLine(c)))];
  voted(AWARD_NAMES.mvp, WRITERS, hartPool);
  // The players' award: the same contenders, judged without the standings.
  voted(AWARD_NAMES.lindsay, PLAYERS, [
    ...skaters.filter((c) => c.s.gp >= 40).map((c) => vc(c, points(c.s) + c.s.g * 0.25 + (c.p.pos === 'D' ? 8 : 0), `${points(c.s)} pts`)),
    ...goalies.map((c) => vc(c, gsax(c.s) * 2.1 + c.s.w * 0.6, gLine(c))),
  ]);
  voted(
    AWARD_NAMES.goalie,
    GMS(league.teams.length),
    goalies.map((c) => vc(c, SCORERS.vezina(league, c), gLine(c))),
  );
  voted(
    AWARD_NAMES.defense,
    WRITERS,
    skaters.filter((c) => c.p.pos === 'D' && c.s.gp >= 40).map((c) => vc(c, SCORERS.norris(league, c), `${points(c.s)} pts, ${(c.s.toi / c.s.gp / 60).toFixed(1)} TOI`)),
  );
  voted(
    AWARD_NAMES.rookie,
    WRITERS,
    cands.filter((c) => isRookieSeason(c.p, league.season) && c.s.gp >= 25).map((c) => vc(c, SCORERS.calder(league, c), c.p.pos === 'G' ? `${savePct(c.s).toFixed(3)} SV%` : `${points(c.s)} pts`)),
  );
  voted(
    AWARD_NAMES.selke,
    WRITERS,
    skaters.filter((c) => c.p.pos !== 'D' && c.s.gp >= 50).map((c) => vc(c, SCORERS.selke(league, c), `${c.s.tk} TK, ${(faceoffPct(c.s) * 100).toFixed(1)} FO%`)),
  );
  // Sportsmanship with a high standard of play: production, with every penalty minute held against him.
  voted(
    AWARD_NAMES.byng,
    WRITERS,
    skaters.filter((c) => c.s.gp >= 60 && points(c.s) >= 40).map((c) => vc(c, points(c.s) - c.s.pim * 1.5, `${points(c.s)} pts, ${c.s.pim} PIM`)),
  );

  // Coach of the year: biggest over-achievement vs preseason projection.
  voted(
    AWARD_NAMES.coach,
    BROADCASTERS,
    league.teams
      .filter((t) => t.staff.headCoach !== null && league.standings[t.id])
      .map((t) => {
        const r = league.standings[t.id];
        const proj = league.projections[t.id] ?? 92;
        return {
          coachId: t.staff.headCoach!,
          teamId: t.id,
          score: recPoints(r) - proj,
          value: `${recPoints(r)} pts (proj. ${proj})`,
        };
      }),
  );

  // Jennings: the goalies (25+ games) of the club allowing the fewest goals.
  const fewest = best(league.teams, (t) => -(league.standings[t.id]?.ga ?? 999));
  if (fewest) {
    const ga = league.standings[fewest.id]?.ga ?? 0;
    const gs = cands.filter((c) => c.p.pos === 'G' && c.teamId === fewest.id && c.s.gp >= 25).sort((a, b) => b.s.gp - a.s.gp);
    const others = league.teams
      .filter((t) => t.id !== fewest.id && league.standings[t.id])
      .sort((a, b) => league.standings[a.id].ga - league.standings[b.id].ga)
      .slice(0, 4);
    const lead = gs[0];
    const results: Finalist[] = [];
    if (lead)
      results.push({
        playerId: lead.p.id,
        teamId: fewest.id,
        score: -ga,
        value: `${ga} GA${
          gs.length > 1
            ? `, shared with ${gs
                .slice(1)
                .map((g) => fullName(g.p))
                .join(', ')}`
            : ''
        }`,
        pts: 0,
        firsts: 0,
        named: 0,
      });
    for (const t of others)
      results.push({
        teamId: t.id,
        score: -league.standings[t.id].ga,
        value: `${league.standings[t.id].ga} GA`,
        pts: 0,
        firsts: 0,
        named: 0,
      });
    if (lead) {
      ballots.push({
        award: AWARD_NAMES.jennings,
        voters: '',
        panel: 0,
        scale: [],
        results,
        note: 'Goaltenders with 25+ games for the club allowing the fewest goals.',
      });
      out.push({
        award: AWARD_NAMES.jennings,
        playerId: lead.p.id,
        teamId: fewest.id,
        value: results[0].value,
      });
      for (const g of gs.slice(1)) g.p.awards.push({ season: league.season, award: AWARD_NAMES.jennings });
    }
  }

  // Presidents' Trophy
  const pres = best(league.teams, (t) => {
    const r = league.standings[t.id];
    return r ? recPoints(r) * 1000 + r.rw : -1;
  });
  if (pres)
    out.push({
      award: AWARD_NAMES.presidents,
      teamId: pres.id,
      value: `${recPoints(league.standings[pres.id])} pts`,
    });

  league.awardsNight = {
    season: league.season,
    ballots,
    allStars: allStarTeams(league, rng, cands),
    revealed: [],
  };
  return out;
}

/**
 * First and second All-Star teams: each writer names a first and a second
 * team at every position (two defencemen per team).
 * SIMPLIFICATION: three points for a first-team vote, one for a second.
 */
function allStarTeams(league: League, rng: Rng, cands: Cand[]): AwardsNight['allStars'] {
  const panel = WRITERS.panel;
  const first: AllStarSlot[] = [];
  const second: AllStarSlot[] = [];
  const fwdScore = (c: Cand) => points(c.s) + c.s.g * 0.25 + (teamPctOf(league, c.teamId) - 0.5) * 20;
  const slots: {
    pos: string;
    n: number;
    pool: Cand[];
    score: (c: Cand) => number;
    value: (c: Cand) => string;
  }[] = [
    {
      pos: 'C',
      n: 1,
      pool: cands.filter((c) => c.p.pos === 'C' && c.s.gp >= 40),
      score: fwdScore,
      value: (c) => `${points(c.s)} pts`,
    },
    {
      pos: 'LW',
      n: 1,
      pool: cands.filter((c) => c.p.pos === 'LW' && c.s.gp >= 40),
      score: fwdScore,
      value: (c) => `${points(c.s)} pts`,
    },
    {
      pos: 'RW',
      n: 1,
      pool: cands.filter((c) => c.p.pos === 'RW' && c.s.gp >= 40),
      score: fwdScore,
      value: (c) => `${points(c.s)} pts`,
    },
    {
      pos: 'D',
      n: 2,
      pool: cands.filter((c) => c.p.pos === 'D' && c.s.gp >= 40),
      score: (c) => SCORERS.norris(league, c),
      value: (c) => `${points(c.s)} pts, ${(c.s.toi / c.s.gp / 60).toFixed(1)} TOI`,
    },
    {
      pos: 'G',
      n: 1,
      pool: cands.filter((c) => c.p.pos === 'G' && c.s.gp >= 25),
      score: (c) => SCORERS.vezina(league, c),
      value: (c) => `${savePct(c.s).toFixed(3)} SV%`,
    },
  ];
  for (const sl of slots) {
    const pool = sl.pool
      .map((c) => ({ c, s: sl.score(c) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 8);
    if (!pool.length) continue;
    const sd = judgementSd(pool.map((x) => x.s));
    const pts = new Array(pool.length).fill(0);
    for (let v = 0; v < panel; v++) {
      const order = pool.map((x, i) => ({ i, s: x.s + rng.normal(0, sd) })).sort((a, b) => b.s - a.s);
      for (let k = 0; k < sl.n * 2 && k < order.length; k++) pts[order[k].i] += k < sl.n ? 3 : 1;
    }
    const ranked = pool.map((x, i) => ({ ...x, pts: pts[i] })).sort((a, b) => b.pts - a.pts || b.s - a.s);
    ranked.forEach((x, k) => {
      if (k >= sl.n * 2) return;
      (k < sl.n ? first : second).push({
        pos: sl.pos,
        playerId: x.c.p.id,
        teamId: x.c.teamId,
        pts: x.pts,
        value: sl.value(x.c),
      });
    });
  }
  return { first, second, panel };
}

export function computePlayoffMvp(league: League): SeasonAwardResult | null {
  const champ = league.playoffs?.champion;
  if (champ == null) return null;
  const cands: Cand[] = [];
  for (const [idStr, e] of Object.entries(league.seasonStats)) {
    const p = league.players[Number(idStr)];
    if (p && e.po.gp > 0) cands.push({ p, s: e.po, teamId: e.teamId });
  }
  const score = (c: Cand) => {
    const mult = c.teamId === champ ? 1.35 : c.teamId === league.playoffs?.rounds.at(-1)?.[0]?.high || c.teamId === league.playoffs?.rounds.at(-1)?.[0]?.low ? 0.8 : 0.4;
    const v = c.p.pos === 'G' ? gsax(c.s) * 2 + c.s.w * 0.9 : points(c.s) + c.s.g * 0.35 + c.s.gwg * 1.2;
    return v * mult;
  };
  const w = best(cands, score);
  if (!w) return null;
  return { award: AWARD_NAMES.playoffMvp, playerId: w.p.id, teamId: w.teamId, value: w.p.pos === 'G' ? `${savePct(w.s).toFixed(3)} SV%, ${w.s.w} W` : `${points(w.s)} pts in ${w.s.gp} GP` };
}

export function announceAwards(league: League, awards: SeasonAwardResult[]): void {
  for (const a of awards) {
    if (a.playerId != null) {
      const p = league.players[a.playerId];
      p.awards.push({ season: league.season, award: a.award });
      p.reputation = Math.min(100, p.reputation + (a.award === AWARD_NAMES.mvp ? 8 : 4));
      addNews(league, { category: 'award', headline: `${fullName(p)} (${league.teams[a.teamId].abbr}) wins the ${a.award} — ${a.value}`, teamIds: [a.teamId], playerIds: [p.id], importance: 4 });
    } else if (a.coachId != null) {
      const c = league.coaches[a.coachId];
      c.reputation = Math.min(100, c.reputation + 10);
      c.awards ??= [];
      c.awards.push({ season: league.season, award: 'Jack Adams Award' });
      addNews(league, { category: 'award', headline: `${c.first} ${c.last} of the ${teamName(league, a.teamId)} wins the ${a.award}`, teamIds: [a.teamId], playerIds: [], importance: 3 });
    } else {
      addNews(league, { category: 'award', headline: `${teamName(league, a.teamId)} claim the ${a.award} (${a.value})`, teamIds: [a.teamId], playerIds: [], importance: 3 });
    }
  }
  const night = league.awardsNight;
  if (night?.season === league.season) {
    for (const [team, label] of [
      [night.allStars.first, 'First'],
      [night.allStars.second, 'Second'],
    ] as const)
      for (const x of team) {
        const p = league.players[x.playerId];
        if (!p) continue;
        p.awards.push({
          season: league.season,
          award: `${label} All-Star Team`,
        });
        p.reputation = Math.min(100, p.reputation + (label === 'First' ? 3 : 1));
      }
    const names = night.allStars.first
      .map((x) => league.players[x.playerId])
      .filter(Boolean)
      .map((p) => `${fullName(p)} (${p.pos})`);
    if (names.length)
      addNews(league, {
        category: 'award',
        headline: `First All-Star Team: ${names.join(', ')}`,
        teamIds: [...new Set(night.allStars.first.map((x) => x.teamId))],
        playerIds: night.allStars.first.map((x) => x.playerId),
        importance: 3,
      });
  }
}

export interface AwardRace {
  award: string;
  candidates: { playerId: number; teamId: number; value: string; score: number }[];
}

/** Live award races for the current season (top five per award). */
export function awardsRace(league: League): AwardRace[] {
  const cands: Cand[] = [];
  let maxGp = 1;
  for (const [idStr, e] of Object.entries(league.seasonStats)) {
    const p = league.players[Number(idStr)];
    if (!p || !e.reg.gp) continue;
    cands.push({ p, s: e.reg, teamId: e.teamId });
    maxGp = Math.max(maxGp, e.reg.gp);
  }
  const minGp = Math.max(1, Math.round(maxGp * 0.45));
  const teamPct = (id: number) => {
    const r = league.standings[id];
    return r && r.gp ? recPoints(r) / (r.gp * 2) : 0.5;
  };
  const top = (award: string, pool: Cand[], score: (c: Cand) => number, value: (c: Cand) => string): AwardRace => ({
    award,
    candidates: pool
      .map((c) => ({ c, sc: score(c) }))
      .sort((a, b) => b.sc - a.sc)
      .slice(0, 5)
      .map(({ c, sc }) => ({ playerId: c.p.id, teamId: c.teamId, value: value(c), score: sc })),
  });
  const sk = cands.filter((c) => c.p.pos !== 'G');
  const g = cands.filter((c) => c.p.pos === 'G' && c.s.gp >= Math.max(1, Math.round(maxGp * 0.35)));
  const pts = (c: Cand) => `${c.s.g}G ${c.s.a1 + c.s.a2}A ${points(c.s)}P`;
  return [
    top(AWARD_NAMES.mvp, [...sk.filter((c) => c.s.gp >= minGp), ...g], (c) => (c.p.pos === 'G' ? gsax(c.s) * 2.1 + c.s.w * 0.6 : points(c.s) + c.s.g * 0.25 + (c.p.pos === 'D' ? 8 : 0)) + (teamPct(c.teamId) - 0.5) * 45 * (maxGp / 82), (c) => (c.p.pos === 'G' ? `${savePct(c.s).toFixed(3)} SV%, ${gsax(c.s).toFixed(1)} GSAx` : pts(c))),
    top(AWARD_NAMES.scoring, sk, (c) => points(c.s) + c.s.g * 0.01, pts),
    top(AWARD_NAMES.goals, sk, (c) => c.s.g + points(c.s) * 0.001, (c) => `${c.s.g} goals`),
    top(AWARD_NAMES.goalie, g, (c) => gsax(c.s) + (savePct(c.s) - 0.905) * 300 * (maxGp / 82) + c.s.w * 0.15, (c) => `${savePct(c.s).toFixed(3)} SV%, ${gsax(c.s).toFixed(1)} GSAx`),
    top(AWARD_NAMES.defense, sk.filter((c) => c.p.pos === 'D' && c.s.gp >= minGp), (c) => points(c.s) + (corsiPct(c.s) - 0.5) * 60 + c.s.pm * 0.4 + (c.s.toi / c.s.gp / 60) * 1.2 * (maxGp / 82), (c) => `${points(c.s)} pts, ${(c.s.toi / c.s.gp / 60).toFixed(1)} min`),
    top(AWARD_NAMES.rookie, cands.filter((c) => isRookieSeason(c.p, league.season) && c.s.gp >= Math.round(minGp * 0.6)), (c) => (c.p.pos === 'G' ? gsax(c.s) * 2.4 + c.s.w * 0.5 : points(c.s) * (c.p.pos === 'D' ? 1.3 : 1) + c.s.g * 0.2), (c) => (c.p.pos === 'G' ? `${savePct(c.s).toFixed(3)} SV%` : pts(c))),
  ];
}
