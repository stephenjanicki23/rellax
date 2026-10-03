/**
 * Trade valuation and execution.
 *
 * Every CPU team values assets through its own lens: contenders pay for
 * current ability and short-term help; rebuilders want youth, prospects and
 * picks; cap-strapped teams value cheap contracts. Teams also see potential
 * through their own (imperfect) scouting.
 */
import { clamp } from '../core/math';
import type { DraftPick, League, Player, Team } from '../types';
import { addNews, addTransaction, playersOf, teamName, withRng } from '../league/helpers';
import { aiPerceivedPA } from './scouting';
import { capSpace, marketValue, payroll } from './contracts';
import { fullName, isForward } from '../player/ability';
import { standingRows } from '../league/standings';
import { projectedPoints } from '../team/strength';
import { emptyStatLine } from '../core/statline';

export type TradeAsset = { kind: 'player'; id: number } | { kind: 'pick'; id: number };

export interface TradeProposal {
  /** Team making the proposal (often the user). */
  from: number;
  /** Team receiving the proposal. */
  to: number;
  /** Assets `from` sends to `to`. */
  give: TradeAsset[];
  /** Assets `from` receives from `to`. */
  get: TradeAsset[];
}

export interface TradeEvaluation {
  accept: boolean;
  valueIn: number;
  valueOut: number;
  errors: string[];
  reason: string;
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
  if (a.kind === 'player') {
    const p = league.players[a.id];
    return p ? `${fullName(p)} (${p.pos})` : 'Unknown player';
  }
  const pick = league.draftPicks.find((x) => x.id === a.id);
  if (!pick) return 'Unknown pick';
  const own = pick.originalTeamId === pick.ownerId ? '' : ` (${league.teams[pick.originalTeamId].abbr})`;
  return `${pick.season} Round ${pick.round} pick${own}`;
}

function ownsAsset(league: League, teamId: number, a: TradeAsset): boolean {
  if (a.kind === 'player') {
    const p = league.players[a.id];
    return !!p && p.teamId === teamId && (p.status === 'active' || p.status === 'prospect');
  }
  const pick = league.draftPicks.find((x) => x.id === a.id);
  return !!pick && pick.ownerId === teamId && pick.playerId === undefined;
}

function salaryOf(league: League, assets: TradeAsset[]): number {
  let s = 0;
  for (const a of assets) {
    if (a.kind !== 'player') continue;
    const p = league.players[a.id];
    if (p?.status === 'active' && p.contract) s += p.contract.salary;
  }
  return s;
}

function activeCount(league: League, assets: TradeAsset[]): number {
  return assets.filter((a) => a.kind === 'player' && league.players[a.id]?.status === 'active').length;
}

export function validateTrade(league: League, t: TradeProposal): string[] {
  const errors: string[] = [];
  if (t.from === t.to) errors.push('A team cannot trade with itself.');
  if (!t.give.length && !t.get.length) errors.push('The trade is empty.');
  for (const a of t.give) if (!ownsAsset(league, t.from, a)) errors.push(`${describeAsset(league, a)} is not available.`);
  for (const a of t.get) if (!ownsAsset(league, t.to, a)) errors.push(`${describeAsset(league, a)} is not available.`);
  if (league.phase === 'regular' && league.day > league.tradeDeadlineDay) errors.push('The trade deadline has passed.');
  if (league.phase === 'playoffs') errors.push('Trades are frozen during the playoffs.');
  const capLimit = league.phase === 'regular' ? league.cap.upper : league.cap.upper * 1.1;
  const fromAfter = payroll(league, t.from) - salaryOf(league, t.give) + salaryOf(league, t.get);
  const toAfter = payroll(league, t.to) - salaryOf(league, t.get) + salaryOf(league, t.give);
  if (fromAfter > capLimit && salaryOf(league, t.get) > salaryOf(league, t.give)) errors.push(`${teamName(league, t.from)} would exceed the salary cap.`);
  if (toAfter > capLimit && salaryOf(league, t.give) > salaryOf(league, t.get)) errors.push(`${teamName(league, t.to)} would exceed the salary cap.`);
  const max = league.config.economics.rosterMax + 3;
  if (playersOf(league, t.from).length - activeCount(league, t.give) + activeCount(league, t.get) > max) errors.push(`${teamName(league, t.from)} would have too many players.`);
  if (playersOf(league, t.to).length - activeCount(league, t.get) + activeCount(league, t.give) > max) errors.push(`${teamName(league, t.to)} would have too many players.`);
  return errors;
}

/** Would a no-trade-clause player waive it for a move to this team? Deterministic per player/team/day. */
export function ntcWaived(league: League, p: Player, dest: number): boolean {
  if (!p.contract?.ntc) return true;
  const destTeam = league.teams[dest];
  const contender = destTeam.strategy === 'contend';
  const unhappy = p.morale < 35;
  const h = Math.abs(Math.sin(p.id * 97.13 + dest * 13.7 + league.season * 3.1)) % 1;
  const pWaive = (contender ? 0.45 : 0.12) + (unhappy ? 0.4 : 0);
  return h < pWaive;
}

/** CPU evaluation of a proposal from the receiving team's point of view. */
export function evaluateTrade(league: League, t: TradeProposal): TradeEvaluation {
  const errors = validateTrade(league, t);
  for (const a of t.get) {
    if (a.kind !== 'player') continue;
    const p = league.players[a.id];
    if (p && !ntcWaived(league, p, t.from)) errors.push(`${fullName(p)} will not waive his no-trade clause.`);
  }
  const valueIn = t.give.reduce((s, a) => s + assetValue(league, t.to, a), 0);
  const valueOut = t.get.reduce((s, a) => s + assetValue(league, t.to, a), 0);
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

export function executeTrade(league: League, t: TradeProposal): void {
  const move = (a: TradeAsset, toTeam: number) => {
    if (a.kind === 'player') {
      const p = league.players[a.id];
      p.teamId = toTeam;
      if (p.rightsTeamId !== null) p.rightsTeamId = toTeam;
      p.morale = Math.max(20, p.morale - 8);
      if (!league.seasonStats[p.id]) league.seasonStats[p.id] = { reg: emptyStatLine(), po: emptyStatLine(), teamId: toTeam };
      else league.seasonStats[p.id].teamId = toTeam;
    } else {
      const pick = league.draftPicks.find((x) => x.id === a.id);
      if (pick) pick.ownerId = toTeam;
    }
  };
  for (const a of t.give) move(a, t.to);
  for (const a of t.get) move(a, t.from);
  for (const tid of [t.from, t.to]) {
    league.teams[tid].autoLines = tid === league.userTeamId ? league.teams[tid].autoLines : true;
    league.aiMemory[tid] = { ...league.aiMemory[tid], lastTradeDay: league.day };
  }
  const desc = `${teamName(league, t.from)} acquire ${t.get.map((a) => describeAsset(league, a)).join(', ') || 'future considerations'} from ${teamName(league, t.to)} for ${t.give.map((a) => describeAsset(league, a)).join(', ') || 'future considerations'}`;
  const playerIds = [...t.give, ...t.get].filter((a) => a.kind === 'player').map((a) => a.id);
  const pickIds = [...t.give, ...t.get].filter((a) => a.kind === 'pick').map((a) => a.id);
  addTransaction(league, { kind: 'trade', teamIds: [t.from, t.to], playerIds, pickIds, description: desc });
  const stars = playerIds.map((id) => league.players[id]).filter((p) => p.reputation >= 55);
  addNews(league, {
    category: 'trade',
    headline: stars.length ? `Blockbuster: ${fullName(stars[0])} traded to ${teamName(league, stars[0].teamId)}` : `Trade completed between ${league.teams[t.from].city} and ${league.teams[t.to].city}`,
    body: desc,
    teamIds: [t.from, t.to],
    playerIds,
    importance: stars.length ? 4 : 2,
  });
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
    if (target.contract.salary > room) {
      const filler = roster
        .filter((p) => p.contract && p.contract.salary >= target.contract!.salary - room && p.ca < target.ca - 3 && p.id !== target.id)
        .sort((a, b) => a.ca - b.ca)[0];
      if (!filler) return null;
      give.push({ kind: 'player', id: filler.id });
    }
    const ranked = pool
      .map((a) => ({ a, sv: assetValue(league, seller.id, a), bv: assetValue(league, buyer.id, a) }))
      .filter((x) => x.sv > 1)
      .sort((x, y) => y.sv / Math.max(1, y.bv) - x.sv / Math.max(1, x.bv));
    let got = give.reduce((s, a) => s + assetValue(league, seller.id, a), 0);
    for (const x of ranked) {
      if (got >= targetValue * 1.05 + 2) break;
      give.push(x.a);
      got += x.sv;
    }
    const proposal: TradeProposal = { from: buyer.id, to: seller.id, give, get: [{ kind: 'player', id: target.id }] };
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
