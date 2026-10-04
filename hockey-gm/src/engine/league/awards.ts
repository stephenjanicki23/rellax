import type { League, Player, SeasonAwardResult, StatLine } from '../types';
import { points, gsax, savePct, faceoffPct, corsiPct } from '../core/statline';
import { addNews, teamName, points as recPoints } from './helpers';
import { fullName } from '../player/ability';

export const AWARD_NAMES = {
  mvp: 'Hart Trophy (MVP)',
  scoring: 'Art Ross Trophy (Points)',
  goals: 'Rocket Trophy (Goals)',
  goalie: 'Vezina Trophy (Goaltender)',
  defense: 'Norris Trophy (Defenseman)',
  rookie: 'Calder Trophy (Rookie)',
  selke: 'Selke Trophy (Defensive Forward)',
  coach: 'Jack Adams Award (Coach)',
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

export function computeAwards(league: League): SeasonAwardResult[] {
  const out: SeasonAwardResult[] = [];
  const cands: Cand[] = [];
  const po: Cand[] = [];
  for (const [idStr, e] of Object.entries(league.seasonStats)) {
    const p = league.players[Number(idStr)];
    if (!p) continue;
    if (e.reg.gp > 0) cands.push({ p, s: e.reg, teamId: e.teamId });
    if (e.po.gp > 0) po.push({ p, s: e.po, teamId: e.teamId });
  }
  const teamPct = (id: number) => {
    const r = league.standings[id];
    return r && r.gp ? recPoints(r) / (r.gp * 2) : 0.5;
  };
  const skaters = cands.filter((c) => c.p.pos !== 'G');
  const goalies = cands.filter((c) => c.p.pos === 'G' && c.s.gp >= 25);
  const push = (award: string, c: Cand | undefined, value: string) => {
    if (!c) return;
    out.push({ award, playerId: c.p.id, teamId: c.teamId, value });
  };

  const artRoss = best(skaters, (c) => points(c.s) + c.s.g * 0.01);
  push(AWARD_NAMES.scoring, artRoss, artRoss ? `${points(artRoss.s)} pts` : '');
  const rocket = best(skaters, (c) => c.s.g + points(c.s) * 0.001);
  push(AWARD_NAMES.goals, rocket, rocket ? `${rocket.s.g} goals` : '');

  const hartSk = best(skaters.filter((c) => c.s.gp >= 40), (c) => points(c.s) + c.s.g * 0.25 + (teamPct(c.teamId) - 0.5) * 45 + (c.p.pos === 'D' ? 8 : 0));
  const hartG = best(goalies, (c) => gsax(c.s) * 2.1 + c.s.w * 0.6 + (teamPct(c.teamId) - 0.5) * 45);
  const hartSkScore = hartSk ? points(hartSk.s) + hartSk.s.g * 0.25 + (teamPct(hartSk.teamId) - 0.5) * 45 : -1;
  const hartGScore = hartG ? gsax(hartG.s) * 2.1 + hartG.s.w * 0.6 + (teamPct(hartG.teamId) - 0.5) * 45 : -1;
  const hart = hartGScore > hartSkScore ? hartG : hartSk;
  push(AWARD_NAMES.mvp, hart, hart ? (hart.p.pos === 'G' ? `${savePct(hart.s).toFixed(3)} SV%, ${gsax(hart.s).toFixed(1)} GSAx` : `${points(hart.s)} pts`) : '');

  const vezina = best(goalies, (c) => gsax(c.s) + (savePct(c.s) - 0.905) * 300 + c.s.w * 0.15);
  push(AWARD_NAMES.goalie, vezina, vezina ? `${savePct(vezina.s).toFixed(3)} SV%, ${gsax(vezina.s).toFixed(1)} GSAx` : '');

  const dmen = skaters.filter((c) => c.p.pos === 'D' && c.s.gp >= 40);
  const norris = best(dmen, (c) => points(c.s) + (corsiPct(c.s) - 0.5) * 60 + c.s.pm * 0.4 + (c.s.toi / c.s.gp / 60) * 1.2 + c.s.blocks * 0.04);
  push(AWARD_NAMES.defense, norris, norris ? `${points(norris.s)} pts, ${(norris.s.toi / norris.s.gp / 60).toFixed(1)} TOI` : '');

  const rookies = cands.filter((c) => isRookieSeason(c.p, league.season) && c.s.gp >= 25);
  const calder = best(rookies, (c) => (c.p.pos === 'G' ? gsax(c.s) * 2.4 + c.s.w * 0.5 : points(c.s) * (c.p.pos === 'D' ? 1.3 : 1) + c.s.g * 0.2));
  push(AWARD_NAMES.rookie, calder, calder ? (calder.p.pos === 'G' ? `${savePct(calder.s).toFixed(3)} SV%` : `${points(calder.s)} pts`) : '');

  const fwds = skaters.filter((c) => c.p.pos !== 'D' && c.s.gp >= 50);
  const selke = best(fwds, (c) => {
    const s = c.s;
    const xgShare = s.xgf + s.xga > 0 ? s.xgf / (s.xgf + s.xga) : 0.5;
    const fo = s.fow + s.fol > 200 ? (faceoffPct(s) - 0.5) * 40 : 0;
    return s.tk * 0.25 + fo + (s.toiPK / s.gp / 60) * 4 + (xgShare - 0.5) * 60 + s.pm * 0.3 + points(s) * 0.12 + c.p.attrs.defAwareness * 0.05;
  });
  push(AWARD_NAMES.selke, selke, selke ? `${selke.s.tk} TK, ${(faceoffPct(selke.s) * 100).toFixed(1)} FO%` : '');

  // Coach of the year: biggest over-achievement vs preseason projection.
  const coachPick = best(league.teams, (t) => {
    const r = league.standings[t.id];
    return r ? recPoints(r) - (league.projections[t.id] ?? 92) : -99;
  });
  if (coachPick && coachPick.staff.headCoach !== null) {
    const r = league.standings[coachPick.id];
    out.push({ award: AWARD_NAMES.coach, coachId: coachPick.staff.headCoach, teamId: coachPick.id, value: `${recPoints(r)} pts (proj. ${league.projections[coachPick.id] ?? 92})` });
  }

  // Presidents' Trophy
  const pres = best(league.teams, (t) => {
    const r = league.standings[t.id];
    return r ? recPoints(r) * 1000 + r.rw : -1;
  });
  if (pres) out.push({ award: AWARD_NAMES.presidents, teamId: pres.id, value: `${recPoints(league.standings[pres.id])} pts` });

  return out;
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
