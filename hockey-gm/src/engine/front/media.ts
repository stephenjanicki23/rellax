/**
 * The media: season previews, weekly power rankings, recaps of the user's
 * games and trade grades. Every article is written from league data only:
 * standings, stats, transactions, projections and the trade valuations.
 */
import type { Article, League, Player, ScheduledGame } from '../types';
import { assetValue, describeAsset, type TradeProposal } from '../economy/trade';
import { powerRankings } from '../team/strength';
import { playersOf, points as recPoints, teamName } from '../league/helpers';
import { fullName } from '../player/ability';
import { points } from '../core/statline';

const MAX_ARTICLES = 150;

function publish(league: League, a: Omit<Article, 'id' | 'season' | 'day'>): Article {
  const m = (league.media ??= { articles: [], nextId: 1 });
  const art: Article = { ...a, id: m.nextId++, season: league.season, day: league.day };
  m.articles.unshift(art);
  if (m.articles.length > MAX_ARTICLES) m.articles.length = MAX_ARTICLES;
  return art;
}

/** Deterministic variety: pick a phrasing from a seed. */
function pick<T>(seed: number, options: T[]): T {
  return options[Math.abs(seed) % options.length];
}

const record = (league: League, id: number) => {
  const r = league.standings[id];
  return r ? `${r.w}-${r.l}-${r.otl}` : '0-0-0';
};
const short = (league: League, id: number) => league.teams[id].name;

// ── Season preview ───────────────────────────────────────────────────────

export function seasonPreview(league: League): void {
  const proj = league.teams.map((t) => ({ t, pts: league.projections[t.id] ?? 92 })).sort((a, b) => b.pts - a.pts);
  const me = league.userTeamId;
  const mine = proj.find((x) => x.t.id === me)!;
  const rank = proj.indexOf(mine) + 1;
  const roster = playersOf(league, me);
  const best = roster.filter((p) => p.pos !== 'G').sort((a, b) => b.ca - a.ca).slice(0, 3);
  const goalie = league.players[league.teams[me].lines.goalies[0]];
  const hc = league.teams[me].staff.headCoach !== null ? league.coaches[league.teams[me].staff.headCoach!] : undefined;
  const moves = league.transactions.filter((t) => t.teamIds.includes(me) && (t.season === league.season || t.season === league.season - 1) && (t.kind === 'trade' || t.kind === 'signing')).slice(0, 4);
  const goals = league.owner?.teamId === me ? league.owner.goals.map((g) => g.label.toLowerCase()) : [];
  const verdict = rank <= 4 ? 'a Stanley Cup contender' : rank <= 10 ? 'a team that should be playing deep into the spring' : rank <= 18 ? 'a bubble team' : rank <= 26 ? 'a long shot for the playoffs' : 'a rebuilding club';
  publish(league, {
    kind: 'preview',
    title: `${league.season}-${String((league.season + 1) % 100).padStart(2, '0')} preview: ${teamName(league, me)} look like ${verdict}`,
    body: [
      `The preseason projections have the ${teamName(league, me)} at about ${mine.pts} points, ${rank}${rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th'} in the league. The favourites: ${proj
        .slice(0, 4)
        .map((x) => `${x.t.city} (${x.pts})`)
        .join(', ')}.`,
      best.length ? `It runs through ${best.map((p) => fullName(p)).join(', ')}${goalie ? `, with ${fullName(goalie)} in goal` : ''}${hc ? ` and ${hc.first} ${hc.last} behind the bench` : ''}.` : '',
      moves.length ? `The front office has been busy: ${moves.map((m) => m.description).join('; ')}.` : 'It was a quiet offseason in the front office.',
      goals.length ? `Ownership's expectations: ${goals.join('; ')}.` : '',
    ].filter(Boolean),
    teamIds: [me],
    playerIds: best.map((p) => p.id),
  });
}

// ── Power rankings ───────────────────────────────────────────────────────

export function powerRankingsColumn(league: League): void {
  if (league.phase !== 'regular') return;
  const rows = powerRankings(league);
  const m = (league.media ??= { articles: [], nextId: 1 });
  const prev = m.lastPower ?? {};
  const me = league.userTeamId;
  const line = (teamId: number, i: number) => {
    const r = league.standings[teamId];
    const was = prev[teamId];
    const move = was ? (was > i + 1 ? ` ▲${was - i - 1}` : was < i + 1 ? ` ▼${i + 1 - was}` : ' (=)') : '';
    const top = playersOf(league, teamId)
      .map((p) => ({ p, s: league.seasonStats[p.id]?.reg }))
      .filter((x) => x.s?.gp)
      .sort((a, b) => points(b.s!) - points(a.s!))[0];
    const streak = r?.streak ?? 0;
    const note =
      streak >= 4 ? `winners of ${streak} straight` : streak <= -4 ? `lost ${-streak} in a row` : top ? `${fullName(top.p)} leads them with ${points(top.s!)} points` : 'still finding their game';
    return `${i + 1}. ${teamName(league, teamId)} (${record(league, teamId)})${move} — ${note}.`;
  };
  const top10 = rows.slice(0, 10).map((r, i) => line(r.teamId, i));
  const myIdx = rows.findIndex((r) => r.teamId === me);
  if (myIdx >= 10) top10.push('…', line(me, myIdx));
  const riser = rows
    .map((r, i) => ({ id: r.teamId, d: (prev[r.teamId] ?? i + 1) - (i + 1) }))
    .sort((a, b) => b.d - a.d)[0];
  publish(league, {
    kind: 'power',
    title: `Power rankings: ${teamName(league, rows[0].teamId)} on top${riser && riser.d >= 3 ? `, ${short(league, riser.id)} climb ${riser.d} spots` : ''}`,
    body: top10,
    teamIds: rows.slice(0, 3).map((r) => r.teamId).concat(myIdx >= 3 ? [me] : []),
    playerIds: [],
  });
  m.lastPower = Object.fromEntries(rows.map((r, i) => [r.teamId, i + 1]));
}

// ── Game recaps (the user's games) ──────────────────────────────────────

export function gameRecap(league: League, g: ScheduledGame): void {
  const me = league.userTeamId;
  if ((g.home !== me && g.away !== me) || !g.result) return;
  const res = g.result;
  const home = g.home === me;
  const us = home ? res.hg : res.ag;
  const them = home ? res.ag : res.hg;
  const opp = home ? g.away : g.home;
  const won = us > them;
  const extra = res.so ? ' in a shootout' : res.ot ? ' in overtime' : '';
  const mySide = home ? 0 : 1;
  const myGoals = res.goals.filter((x) => x.team === mySide);
  const tally = new Map<number, { g: number; a: number }>();
  for (const x of myGoals) {
    tally.set(x.s, { g: (tally.get(x.s)?.g ?? 0) + 1, a: tally.get(x.s)?.a ?? 0 });
    for (const a of x.a) tally.set(a, { g: tally.get(a)?.g ?? 0, a: (tally.get(a)?.a ?? 0) + 1 });
  }
  const leaders = [...tally].sort((a, b) => b[1].g * 1.2 + b[1].a - (a[1].g * 1.2 + a[1].a)).slice(0, 2);
  const seed = g.id;
  const verb = won ? pick(seed, ['beat', 'down', 'get past', 'top']) : pick(seed, ['fall to', 'lose to', 'drop one to']);
  const lead = leaders[0] ? league.players[leaders[0][0]] : undefined;
  const title = lead && won && leaders[0][1].g >= 2 ? `${fullName(lead)} scores ${leaders[0][1].g} as ${short(league, me)} ${verb} ${short(league, opp)} ${us}-${them}${extra}` : `${short(league, me)} ${verb} ${short(league, opp)} ${us}-${them}${extra}`;
  const body: string[] = [];
  if (leaders.length) body.push(`${leaders.map(([id, t]) => `${fullName(league.players[id])} (${t.g} G, ${t.a} A)`).join(' and ')} led the way.`);
  const myGoalie = home ? res.hGoalie : res.aGoalie;
  const shotsAgainst = home ? res.as : res.hs;
  if (myGoalie !== undefined && league.players[myGoalie]) body.push(`${fullName(league.players[myGoalie])} made ${Math.max(0, shotsAgainst - them)} saves on ${shotsAgainst} shots.`);
  // Context that ties the result to the GM's moves.
  const recentTrades = league.transactions.filter((t) => t.kind === 'trade' && t.season === league.season && league.day - t.day <= 21 && t.teamIds.includes(me));
  const newcomers = new Set(recentTrades.flatMap((t) => t.playerIds).filter((id) => league.players[id]?.teamId === me));
  const newcomerHit = [...tally.keys()].find((id) => newcomers.has(id));
  if (newcomerHit !== undefined) body.push(`Recent acquisition ${fullName(league.players[newcomerHit])} is already paying off: ${tally.get(newcomerHit)!.g} goal${tally.get(newcomerHit)!.g === 1 ? '' : 's'} and ${tally.get(newcomerHit)!.a} assist${tally.get(newcomerHit)!.a === 1 ? '' : 's'} tonight.`);
  const hc = league.teams[me].staff.headCoach !== null ? league.coaches[league.teams[me].staff.headCoach!] : undefined;
  const stint = hc?.stints?.at(-1);
  if (hc && stint && stint.season === league.season && stint.gp <= 15 && stint.gp >= 2) body.push(`The ${short(league, me)} are ${stint.w}-${stint.l}-${stint.otl} since ${hc.first} ${hc.last} took over${hc.interim ? ' on an interim basis' : ''}.`);
  const r = league.standings[me];
  if (r) {
    const streak = r.streak;
    body.push(`${short(league, me)} are ${record(league, me)} (${recPoints(r)} points)${streak >= 3 ? `, winners of ${streak} straight` : streak <= -3 ? `, losers of ${-streak} straight` : ''}.`);
  }
  publish(league, { kind: 'recap', title, body, teamIds: [me, opp], playerIds: leaders.map(([id]) => id), gameId: g.id });
}

// ── Trade grades ─────────────────────────────────────────────────────────

/** Graded before the trade executes (values are from each club's point of view). */
export function gradeTrade(league: League, t: TradeProposal): void {
  const me = league.userTeamId;
  if (t.from !== me && t.to !== me) return;
  const partner = t.from === me ? t.to : t.from;
  const incoming = t.from === me ? t.get : t.give;
  const outgoing = t.from === me ? t.give : t.get;
  const sum = (teamId: number, list: typeof incoming) => list.reduce((s, a) => s + Math.max(0, assetValue(league, teamId, a)), 0);
  // Neutral view: average both clubs' valuations of each side.
  const getV = (sum(me, incoming) + sum(partner, incoming)) / 2;
  const giveV = (sum(me, outgoing) + sum(partner, outgoing)) / 2;
  const ratio = getV / Math.max(1, giveV);
  const grade = ratio >= 1.25 ? 'A' : ratio >= 1.08 ? 'B' : ratio >= 0.93 ? 'C' : ratio >= 0.8 ? 'D' : 'F';
  const verdict =
    grade === 'A' ? 'a clear win' : grade === 'B' ? 'a smart piece of business' : grade === 'C' ? 'a fair hockey trade' : grade === 'D' ? 'a steep price' : 'an overpay that could haunt them';
  const players = [...incoming, ...outgoing].filter((a) => a.kind === 'player').map((a) => league.players[a.id]).filter((p): p is Player => !!p);
  const young = players.filter((p) => league.season - p.birthYear <= 23);
  publish(league, {
    kind: 'grade',
    title: `Grading the deal: ${short(league, me)} get a ${grade} for their trade with ${short(league, partner)}`,
    body: [
      `The ${teamName(league, me)} acquire ${incoming.map((a) => describeAsset(league, a)).join(', ') || 'future considerations'} from the ${teamName(league, partner)} for ${outgoing.map((a) => describeAsset(league, a)).join(', ') || 'future considerations'}.`,
      `Weighing what both clubs think each piece is worth, it looks like ${verdict}.`,
      young.length ? `The long-term piece${young.length > 1 ? 's' : ''} to watch: ${young.map((p) => `${fullName(p)} (${league.season - p.birthYear})`).join(', ')}.` : '',
    ].filter(Boolean),
    teamIds: [me, partner],
    playerIds: players.map((p) => p.id),
    grade,
  });
}
