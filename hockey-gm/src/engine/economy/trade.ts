/**
 * Trade valuation and execution.
 *
 * Every CPU team values assets through its own lens: contenders pay for
 * current ability and short-term help; rebuilders want youth, prospects and
 * picks; cap-strapped teams value cheap contracts. Teams also see potential
 * through their own (imperfect) scouting.
 */
import { onPlayerTraded } from '../league/room';
import { onFavouriteTraded } from '../front/finances';
import { inDeadlineWindow, recordDeadlineEvent } from '../league/deadline';
import { clamp } from '../core/math';
import { describeTradeAsset, executeMoves, tradeConsent, validateMoves, type TradeAsset, type TradeCheck, type TradeMove } from '../cba/tradeRules';
import { fullCapHit, remainingYears } from '../cba/contract';
import { capSeason } from '../cba/capManager';
import { retentionErrors } from '../cba/tradeRules';
import { financialPlan } from '../ai/finance';
import { fitNorm, playerSystemFit } from '../team/fit';
import type { DraftPick, League, Player, Team } from '../types';
import { playersOf, withRng } from '../league/helpers';
import { aiPerceivedPA } from './scouting';
import { capSpace, marketValue } from './contracts';
import { fullName, isForward } from '../player/ability';
import { standingRows } from '../league/standings';
import { projectedPoints } from '../team/strength';

export type { TradeAsset, TradeMove, TradeCheck, TeamCapImpact } from '../cba/tradeRules';

export interface TradeProposal {
  /** Team making the proposal (often the user). */
  from: number;
  /** Team receiving the proposal. */
  to: number;
  /** Assets `from` sends to `to`. */
  give: TradeAsset[];
  /** Assets `from` receives from `to`. */
  get: TradeAsset[];
  /** Salary retained by the team sending a player (share of his cap hit, ≤ 50%). */
  retain?: { playerId: number; pct: number }[];
}

export interface TradeEvaluation {
  accept: boolean;
  valueIn: number;
  valueOut: number;
  errors: string[];
  reason: string;
}

/** A two-team proposal as a list of moves. */
export function proposalMoves(t: TradeProposal): TradeMove[] {
  const pct = (a: TradeAsset) => (a.kind === 'player' ? t.retain?.find((r) => r.playerId === a.id)?.pct : undefined);
  return [...t.give.map((a) => ({ asset: a, from: t.from, to: t.to, retainPct: pct(a) })), ...t.get.map((a) => ({ asset: a, from: t.to, to: t.from, retainPct: pct(a) }))];
}

/** Full legality check with per-team cap before/after (UI and AI). */
export function checkTrade(league: League, t: TradeProposal): TradeCheck {
  return validateMoves(league, proposalMoves(t));
}

function weights(team: Team): { now: number; fut: number } {
  switch (team.strategy) {
    case 'contend':
      return { now: 0.82, fut: 0.18 };
    case 'rebuild':
      return { now: 0.3, fut: 0.7 };
    default:
      return { now: 0.6, fut: 0.4 };
  }
}

const curve = (x: number) => (x > 100 ? ((x - 100) ** 2) / 30 : 0);

/** Value of a player to a given team (roughly: 1 point ≈ a depth player, 100 ≈ a star). */
export function playerTradeValue(league: League, teamId: number, p: Player): number {
  const team = league.teams[teamId];
  const age = league.season - p.birthYear;
  const w = weights(team);
  const pa = teamId === league.userTeamId ? p.pa : aiPerceivedPA(league, teamId, p);
  const growth = age <= 21 ? 0.7 : age <= 23 ? 0.55 : age <= 25 ? 0.3 : age <= 27 ? 0.1 : 0;
  const decline = Math.max(0, age - 30) * 3;
  const future = p.ca + (pa - p.ca) * growth - decline;
  let v = w.now * curve(p.ca) + w.fut * curve(future);
  // Contract surplus (per year, in $M) × years of control.
  if (p.contract) {
    const surplus = (marketValue(p, league) - p.contract.salary) / 1000;
    const years = Math.min(4, p.contract.years + (p.contract.next ? p.contract.next.years : 0));
    const capTight = capSpace(league, teamId) < 3000 ? 1.5 : 1;
    v += surplus * years * 3 * capTight;
  }
  if (team.strategy === 'rebuild' && age >= 29) v *= 0.55;
  if (team.strategy === 'contend' && age <= 20 && p.ca < 120) v *= 0.8;
  if (team.strategy === 'contend') v *= 1 + p.playoffRep * 0.08;
  if (p.pos === 'G') v *= 0.85;
  if (p.injury && p.injury.daysRemaining > 30) v *= team.strategy === 'contend' ? 0.4 : 0.7;
  // Players who suit the team's systems are worth more to it (and less to a team whose system they don't fit).
  v *= 1 + clamp(playerSystemFit(fitNorm(league), p, team.tactics).overall, -1, 1) * 0.1;
  // Positional need.
  const same = playersOf(league, teamId, ['active']).filter((x) => (p.pos === 'G' ? x.pos === 'G' : p.pos === 'D' ? x.pos === 'D' : isForward(x.pos)));
  const rank = same.filter((x) => x.ca > p.ca && x.id !== p.id).length;
  const topSlots = p.pos === 'G' ? 1 : p.pos === 'D' ? 4 : 6;
  if (rank < topSlots) v *= 1.12;
  return Math.max(0, v);
}

/** Estimated overall pick number for a pick, from current standings (or projections). */
export function projectedPickNumber(league: League, pick: DraftPick): number {
  const n = league.teams.length;
  let rank: number;
  const played = Object.values(league.standings).reduce((s, r) => s + r.gp, 0);
  if (pick.season === league.season && played > n * 10) {
    const rows = standingRows(league);
    rank = n - rows.findIndex((r) => r.team.id === pick.originalTeamId);
  } else {
    const proj = league.teams.map((t) => ({ id: t.id, pts: league.projections[t.id] ?? projectedPoints(league, t.id) })).sort((a, b) => a.pts - b.pts);
    rank = proj.findIndex((x) => x.id === pick.originalTeamId) + 1;
    rank = Math.round(rank * 0.6 + (n / 2) * 0.4); // future picks regress to the middle
  }
  if (pick.pickNumber) return pick.pickNumber;
  return (pick.round - 1) * n + clamp(rank, 1, n);
}

export function pickTradeValue(league: League, teamId: number, pick: DraftPick): number {
  const team = league.teams[teamId];
  const n = league.teams.length;
  const num = projectedPickNumber(league, pick);
  const inRound = ((num - 1) % n) + 1;
  let v = pick.round === 1 ? 70 * Math.exp(-(inRound - 1) / 7) + 14 : pick.round === 2 ? 11 : pick.round === 3 ? 6 : 3;
  const yearsOut = pick.season - league.season;
  v *= 0.88 ** Math.max(0, yearsOut);
  if (team.strategy === 'rebuild') v *= 1.35;
  else if (team.strategy === 'contend') v *= 0.72;
  return v;
}

export function assetValue(league: League, teamId: number, a: TradeAsset): number {
  if (a.kind === 'player') {
    const p = league.players[a.id];
    return p ? playerTradeValue(league, teamId, p) : 0;
  }
  const pick = league.draftPicks.find((x) => x.id === a.id);
  return pick ? pickTradeValue(league, teamId, pick) : 0;
}

export function describeAsset(league: League, a: TradeAsset): string {
  return describeTradeAsset(league, a);
}

export function validateTrade(league: League, t: TradeProposal): string[] {
  return checkTrade(league, t).errors;
}

/** Would a clause player agree to a move to this team? (no clause, or not on his M-NTC list → true) */
export function ntcWaived(league: League, p: Player, dest: number): boolean {
  return tradeConsent(league, p, dest).granted;
}

/** Value of salary retention to a team: retained dollars × years, positive for the receiver, a cost for the retainer. */
function retentionValue(league: League, m: TradeMove): number {
  if (m.asset.kind !== 'player' || !m.retainPct) return 0;
  const p = league.players[m.asset.id];
  if (!p?.contract) return 0;
  return ((fullCapHit(p.contract) * m.retainPct) / 1000) * Math.min(4, remainingYears(p.contract, capSeason(league))) * 3;
}

/** One team's view of a set of moves. */
export function teamTradeValue(league: League, teamId: number, moves: TradeMove[]): { valueIn: number; valueOut: number } {
  let valueIn = 0, valueOut = 0;
  for (const m of moves) {
    if (m.to === teamId) valueIn += assetValue(league, teamId, m.asset) + retentionValue(league, m);
    if (m.from === teamId) valueOut += assetValue(league, teamId, m.asset) + retentionValue(league, m) * 0.8;
  }
  return { valueIn, valueOut };
}

/** CPU evaluation of a proposal from the receiving team's point of view. */
export function evaluateTrade(league: League, t: TradeProposal): TradeEvaluation {
  const moves = proposalMoves(t);
  const errors = validateMoves(league, moves).errors;
  const { valueIn, valueOut } = teamTradeValue(league, t.to, moves);
  if (errors.length) return { accept: false, valueIn, valueOut, errors, reason: errors[0] };
  const team = league.teams[t.to];
  // User proposals face a slightly higher bar (CPU GMs are wary of being fleeced).
  const margin = (t.from === league.userTeamId ? 1.08 : 1.02) * league.settings.tradeDifficulty;
  const accept = valueIn >= valueOut * margin + 1.5;
  let reason: string;
  if (accept) reason = `${team.gm.name} (${team.abbr}) accepts the deal.`;
  else if (valueIn < valueOut * 0.6) reason = `${team.gm.name} laughs it off — the offer isn't close.`;
  else if (team.strategy === 'rebuild') reason = `${team.abbr} are rebuilding and want more young talent or picks.`;
  else if (team.strategy === 'contend') reason = `${team.abbr} are contending and won't weaken their current roster for this.`;
  else reason = `${team.abbr} need a bit more value to make this work.`;
  return { accept, valueIn, valueOut, errors, reason };
}

export interface MultiTradeEvaluation {
  accept: boolean;
  check: TradeCheck;
  teams: { teamId: number; valueIn: number; valueOut: number; accept: boolean; reason: string }[];
}

/** Multi-team trade: every CPU team must like its part and the whole thing must be legal. */
export function evaluateMultiTrade(league: League, moves: TradeMove[]): MultiTradeEvaluation {
  const check = validateMoves(league, moves);
  const userIn = moves.some((m) => m.from === league.userTeamId || m.to === league.userTeamId);
  const ids = [...new Set(moves.flatMap((m) => [m.from, m.to]))];
  const teams = ids.map((teamId) => {
    const { valueIn, valueOut } = teamTradeValue(league, teamId, moves);
    if (teamId === league.userTeamId) return { teamId, valueIn, valueOut, accept: true, reason: '' };
    const margin = (userIn ? 1.08 : 1.02) * league.settings.tradeDifficulty;
    const accept = valueIn >= valueOut * margin + 1.5;
    const t = league.teams[teamId];
    return { teamId, valueIn, valueOut, accept, reason: accept ? `${t.abbr} are on board.` : `${t.abbr} want more for their part.` };
  });
  return { accept: check.ok && teams.every((t) => t.accept), check, teams };
}

export function executeMultiTrade(league: League, moves: TradeMove[]): void {
  executeMoves(league, moves);
}

export function executeTrade(league: League, t: TradeProposal): void {
  const moved = [...t.give, ...t.get].filter((a) => a.kind === 'player').map((a) => league.players[a.id]).filter(Boolean);
  const from = new Map(moved.map((p) => [p.id, p.teamId]));
  const summary = inDeadlineWindow(league)
    ? `${league.teams[t.to].abbr} acquire ${t.give.map((a) => describeTradeAsset(league, a)).join(', ') || 'future considerations'} from ${league.teams[t.from].abbr} for ${t.get.map((a) => describeTradeAsset(league, a)).join(', ') || 'future considerations'}`
    : null;
  executeMoves(league, proposalMoves(t));
  if (summary) recordDeadlineEvent(league, 'trade', summary, [t.from, t.to], moved.map((p) => p.id));
  for (const p of moved) {
    onPlayerTraded(league, p);
    const old = from.get(p.id);
    if (old != null && p.status === 'active') onFavouriteTraded(league, old, p.traits.includes('fanFavorite'), p.ca);
  }
}

/** Ask the CPU team what it would want added to make a proposal work. */
export function balanceTrade(league: League, t: TradeProposal): TradeProposal | null {
  const ev = evaluateTrade(league, t);
  if (ev.accept) return t;
  if (ev.errors.length) return null;
  const candidates: TradeAsset[] = [
    ...playersOf(league, t.from, ['active', 'prospect']).map((p) => ({ kind: 'player' as const, id: p.id })),
    ...league.draftPicks.filter((p) => p.ownerId === t.from && p.playerId === undefined).map((p) => ({ kind: 'pick' as const, id: p.id })),
  ].filter((a) => !t.give.some((g) => g.kind === a.kind && g.id === a.id));
  // Prefer the cheapest single addition that closes the gap.
  const gap = ev.valueOut * 1.08 * league.settings.tradeDifficulty + 1.5 - ev.valueIn;
  const scored = candidates
    .map((a) => ({ a, v: assetValue(league, t.to, a) }))
    .filter((x) => x.v > 0)
    .sort((x, y) => x.v - y.v);
  const single = scored.find((x) => x.v >= gap);
  const tryWith = (extra: TradeAsset[]) => {
    const nt = { ...t, give: [...t.give, ...extra] };
    return evaluateTrade(league, nt).accept ? nt : null;
  };
  if (single) {
    const r = tryWith([single.a]);
    if (r) return r;
  }
  // Greedy: add the most valuable assets until it works (max 3).
  const extra: TradeAsset[] = [];
  for (const x of [...scored].reverse().slice(0, 3)) {
    extra.push(x.a);
    const r = tryWith(extra);
    if (r) return r;
  }
  return null;
}

/** CPU-to-CPU trade search: contenders buy veterans from rebuilders. */
export function findAiTrade(league: League): TradeProposal | null {
  return withRng(league, (rng) => {
    const contenders = league.teams.filter((t) => t.id !== league.userTeamId && t.strategy === 'contend');
    const sellers = league.teams.filter((t) => t.id !== league.userTeamId && t.strategy === 'rebuild');
    if (!contenders.length || !sellers.length) return null;
    const buyer = rng.pick(contenders);
    const seller = rng.pick(sellers);
    // Buyer's weakest regular position.
    const roster = playersOf(league, buyer.id);
    const fwd = roster.filter((p) => isForward(p.pos)).sort((a, b) => b.ca - a.ca);
    const def = roster.filter((p) => p.pos === 'D').sort((a, b) => b.ca - a.ca);
    const sixthF = fwd[5]?.ca ?? 120;
    const fourthD = def[3]?.ca ?? 120;
    const wantD = fourthD - 5 < sixthF - 10 ? true : rng.chance(0.4);
    const bar = wantD ? fourthD : sixthF;
    const targets = playersOf(league, seller.id)
      .filter((p) => (wantD ? p.pos === 'D' : isForward(p.pos)) && league.season - p.birthYear >= 25 && p.ca >= bar + 4 && !p.injury)
      .sort((a, b) => b.ca - a.ca);
    const target = targets[0];
    if (!target || !target.contract) return null;
    if (!ntcWaived(league, target, buyer.id)) return null;
    const room = capSpace(league, buyer.id);
    const targetValue = playerTradeValue(league, seller.id, target);
    // Package from the buyer: prospects, picks and (if needed for cap) a salary going back.
    const pool: TradeAsset[] = [
      ...playersOf(league, buyer.id, ['prospect']).map((p) => ({ kind: 'player' as const, id: p.id })),
      ...league.draftPicks.filter((p) => p.ownerId === buyer.id && p.playerId === undefined && p.season <= league.season + 1).map((p) => ({ kind: 'pick' as const, id: p.id })),
    ];
    const give: TradeAsset[] = [];
    let retain: TradeProposal['retain'];
    let targetValue2 = targetValue;
    if (target.contract.salary > room) {
      // Sellers may retain salary (up to 50%) to make the deal fit, and ask more for it.
      const pct = Math.ceil(((target.contract.salary - room) / fullCapHit(target.contract)) * 20) / 20;
      if (financialPlan(league, seller.id).retainToSell && pct <= 0.5 && !retentionErrors(league, target, seller.id, pct).length) {
        retain = [{ playerId: target.id, pct }];
        targetValue2 += retentionValue(league, { asset: { kind: 'player', id: target.id }, from: seller.id, to: buyer.id, retainPct: pct }) * 0.8;
      } else {
        const filler = roster
          .filter((p) => p.contract && p.contract.salary >= target.contract!.salary - room && p.ca < target.ca - 3 && p.id !== target.id)
          .sort((a, b) => a.ca - b.ca)[0];
        if (!filler) return null;
        give.push({ kind: 'player', id: filler.id });
      }
    }
    const ranked = pool
      .map((a) => ({ a, sv: assetValue(league, seller.id, a), bv: assetValue(league, buyer.id, a) }))
      .filter((x) => x.sv > 1)
      .sort((x, y) => y.sv / Math.max(1, y.bv) - x.sv / Math.max(1, x.bv));
    let got = give.reduce((s, a) => s + assetValue(league, seller.id, a), 0);
    for (const x of ranked) {
      if (got >= targetValue2 * 1.05 + 2) break;
      give.push(x.a);
      got += x.sv;
    }
    const proposal: TradeProposal = { from: buyer.id, to: seller.id, give, get: [{ kind: 'player', id: target.id }], retain };
    const sellerSide = evaluateTrade(league, proposal);
    if (!sellerSide.accept) return null;
    // Buyer must also believe it's worth it.
    const buyerIn = playerTradeValue(league, buyer.id, target);
    const buyerOut = give.reduce((s, a) => s + assetValue(league, buyer.id, a), 0);
    if (buyerIn < buyerOut * 0.95) return null;
    return proposal;
  });
}

/** CPU goalie market: teams without a starter acquire one from a team with a surplus or a rebuilder. */
export function findAiGoalieTrade(league: League): TradeProposal | null {
  return withRng(league, (rng) => {
    const bestG = (tid: number) => playersOf(league, tid).filter((p) => p.pos === 'G' && !p.injury).sort((a, b) => b.ca - a.ca);
    const needy = league.teams.filter((t) => t.id !== league.userTeamId && (bestG(t.id)[0]?.ca ?? 0) < 138);
    if (!needy.length) return null;
    const buyer = rng.pick(needy);
    const cur = bestG(buyer.id)[0]?.ca ?? 0;
    const options: Player[] = [];
    for (const t of league.teams) {
      if (t.id === buyer.id || t.id === league.userTeamId) continue;
      const gs = bestG(t.id);
      // Surplus: second goalie good enough to start elsewhere, or a rebuilder's veteran.
      if (gs[1] && gs[1].ca >= cur + 6 && gs[1].ca >= 134) options.push(gs[1]);
      if (t.strategy === 'rebuild' && gs[0] && gs[0].ca >= cur + 6 && league.season - gs[0].birthYear >= 27) options.push(gs[0]);
    }
    const target = options.sort((a, b) => b.ca - a.ca)[0];
    if (!target || !target.contract || target.teamId === null) return null;
    if (!ntcWaived(league, target, buyer.id)) return null;
    const seller = target.teamId;
    const targetValue = playerTradeValue(league, seller, target);
    const pool: TradeAsset[] = [
      ...playersOf(league, buyer.id, ['prospect']).map((p) => ({ kind: 'player' as const, id: p.id })),
      ...league.draftPicks.filter((p) => p.ownerId === buyer.id && p.playerId === undefined && p.season <= league.season + 1).map((p) => ({ kind: 'pick' as const, id: p.id })),
    ];
    const give: TradeAsset[] = [];
    const room = capSpace(league, buyer.id);
    if (target.contract.salary > room) {
      const filler = playersOf(league, buyer.id).filter((p) => p.contract && p.contract.salary >= target.contract!.salary - room && p.pos !== 'G').sort((a, b) => a.ca - b.ca)[0];
      if (!filler) return null;
      give.push({ kind: 'player', id: filler.id });
    }
    const ranked = pool.map((a) => ({ a, sv: assetValue(league, seller, a) })).filter((x) => x.sv > 1).sort((x, y) => y.sv - x.sv);
    let got = give.reduce((s, a) => s + assetValue(league, seller, a), 0);
    for (const x of ranked.reverse()) {
      if (got >= targetValue * 1.05 + 2) break;
      give.push(x.a);
      got += x.sv;
    }
    const proposal: TradeProposal = { from: buyer.id, to: seller, give, get: [{ kind: 'player', id: target.id }] };
    return evaluateTrade(league, proposal).accept ? proposal : null;
  });
}

/**
 * A CPU team looks at the user's roster and makes an unsolicited offer for a
 * player who would fill one of its needs. Offers are priced so the CPU team
 * still thinks it wins slightly, and the user values the return fairly.
 */
export function findOfferForUser(league: League): { proposal: TradeProposal; note: string } | null {
  return withRng(league, (rng) => {
    const me = league.userTeamId;
    const cpus = league.teams.filter((t) => t.id !== me && t.strategy !== 'rebuild');
    if (!cpus.length) return null;
    const cpu = rng.pick(cpus);
    const roster = playersOf(league, cpu.id);
    const grpOf = (p: Player) => (p.pos === 'G' ? 'G' : p.pos === 'D' ? 'D' : 'F');
    const bar = (g: string) => {
      const same = roster.filter((p) => grpOf(p) === g).sort((a, b) => b.ca - a.ca);
      return g === 'G' ? (same[0]?.ca ?? 120) : g === 'D' ? (same[3]?.ca ?? 120) : (same[5]?.ca ?? 120);
    };
    const targets = playersOf(league, me)
      .filter((p) => league.season - p.birthYear >= 21 && !p.injury && p.ca >= bar(grpOf(p)) + 3 && p.contract && ntcWaived(league, p, cpu.id))
      .sort((a, b) => b.ca - a.ca);
    if (!targets.length) return null;
    const target = targets[Math.min(targets.length - 1, rng.int(0, 2))];
    const cpuValue = playerTradeValue(league, cpu.id, target);
    const userValue = playerTradeValue(league, me, target);
    const keep = new Set(roster.sort((a, b) => b.ca - a.ca).slice(0, 8).map((p) => p.id));
    const pool: TradeAsset[] = [
      ...playersOf(league, cpu.id, ['active', 'prospect']).filter((p) => !keep.has(p.id)).map((p) => ({ kind: 'player' as const, id: p.id })),
      ...league.draftPicks.filter((p) => p.ownerId === cpu.id && p.playerId === undefined).map((p) => ({ kind: 'pick' as const, id: p.id })),
    ];
    const ranked = pool
      .map((a) => ({ a, mine: assetValue(league, me, a), theirs: assetValue(league, cpu.id, a) }))
      .filter((x) => x.mine > 2)
      .sort((x, y) => y.mine / Math.max(1, y.theirs) - x.mine / Math.max(1, x.theirs));
    const give: TradeAsset[] = [];
    let mine = 0;
    let theirs = 0;
    for (const x of ranked) {
      if (mine >= userValue * 0.98) break;
      if (theirs + x.theirs > cpuValue * 1.02) continue;
      give.push(x.a);
      mine += x.mine;
      theirs += x.theirs;
      if (give.length >= 3) break;
    }
    if (!give.length || mine < userValue * 0.9) return null;
    const proposal: TradeProposal = { from: cpu.id, to: me, give, get: [{ kind: 'player', id: target.id }] };
    const errs = validateTrade(league, proposal);
    if (errs.length) return null;
    const need = grpOf(target) === 'G' ? 'a starting goaltender' : grpOf(target) === 'D' ? 'a top-four defenseman' : 'a top-six forward';
    return { proposal, note: `The ${cpu.city} ${cpu.name} are looking for ${need} and have called about ${fullName(target)}.` };
  });
}
