/**
 * The CPU trade market. GMs generate trade ideas the way NHL front offices
 * do and only execute deals both sides value, that pass every CBA check
 * (cap, clauses, retention, roster) and that fit their plans:
 *
 *  - buy:   a team upgrades its weakest lineup slot from a team that can spare
 *           the player (sellers, rebuilders, teams with depth), paying in picks,
 *           prospects and depth; sellers retain salary to make it fit
 *  - sell:  a seller shops a veteran (often an expiring rental) to buyers
 *  - swap:  hockey trades between teams with complementary surpluses/needs
 *  - dump:  a capped-out team moves a contract plus a sweetener to a team
 *           with room
 *
 * Volume follows the NHL calendar: steady through the season, a spike in the
 * two weeks before the deadline, quiet after it, busy again around the draft.
 */
import type { League, Player, Team } from '../types';
import type { Rng } from '../core/rng';
import { addNews, isCpu, playersOf, withRng } from '../league/helpers';
import { standingRows } from '../league/standings';
import { fullName, isForward } from '../player/ability';
import { assetValue, checkTrade, evaluateTrade, executeTrade, findOfferForUser, playerTradeValue, teamTradeValue, proposalMoves, validateTrade, type TradeAsset, type TradeProposal } from '../economy/trade';
import { capSeason, contractFor, teamCapSheet, withCapCache } from '../cba/capManager';
import { fullCapHit, holderCapHit, endOf } from '../cba/contract';
import { retentionErrors, tradeConsent } from '../cba/tradeRules';
import { contractValue } from '../cba/market';
import { financialPlan } from './finance';
import { ensureDressable, enforceCap, trimRoster } from '../economy/roster';

type Group = 'F' | 'D' | 'G';
const grp = (p: Player): Group => (p.pos === 'G' ? 'G' : p.pos === 'D' ? 'D' : isForward(p.pos) ? 'F' : 'F');
/** Lineup slot that defines "need" for each group (6th forward, 4th defenceman, starting goalie). */
const SLOT: Record<Group, number> = { F: 6, D: 4, G: 1 };
/** Healthy bodies a team needs before it can spare one. */
const KEEP: Record<Group, number> = { F: 12, D: 6, G: 2 };
/** Active-roster ceiling the trade validator enforces (23-man roster + 3 to be sent down). */
const ROSTER_HARD_MAX = 26;

export type MarketRole = 'buyer' | 'seller' | 'neutral';

/**
 * In-season stance: contenders and teams in a playoff spot buy; teams well out
 * of the race (and rebuilders) sell. Early in the season stance follows the
 * long-term strategy.
 */
export function marketRole(league: League, team: Team): MarketRole {
  const rows = standingRows(league);
  const gp = rows.reduce((s, r) => s + r.rec.gp, 0) / Math.max(1, rows.length);
  if (league.phase !== 'regular' || gp < 15) return team.strategy === 'contend' ? 'buyer' : team.strategy === 'rebuild' ? 'seller' : 'neutral';
  const byPct = [...rows].sort((a, b) => b.pct - a.pct);
  const rank = byPct.findIndex((r) => r.team.id === team.id);
  const n = rows.length;
  if (team.strategy === 'rebuild' || rank >= n - 9) return 'seller';
  if (team.strategy === 'contend' || rank < 12) return 'buyer';
  return 'neutral';
}

function roster(league: League, teamId: number): Player[] {
  return playersOf(league, teamId, ['active']).filter((p) => !p.ltir);
}

function healthy(p: Player): boolean {
  return !p.injury || p.injury.daysRemaining <= 0;
}

/** Quality at the slot that defines need, per group. */
function slotQuality(league: League, teamId: number): Record<Group, number> {
  const r = roster(league, teamId).filter(healthy);
  const out = {} as Record<Group, number>;
  for (const g of ['F', 'D', 'G'] as Group[]) {
    const same = r.filter((p) => grp(p) === g).sort((a, b) => b.ca - a.ca);
    out[g] = same[SLOT[g] - 1]?.ca ?? 90;
  }
  return out;
}

/** The group where a team is weakest relative to the league. */
function biggestNeed(league: League, teamId: number, rng: Rng): { group: Group; bar: number } {
  const mine = slotQuality(league, teamId);
  const avg = { F: 0, D: 0, G: 0 };
  for (const t of league.teams) {
    const q = slotQuality(league, t.id);
    avg.F += q.F / league.teams.length;
    avg.D += q.D / league.teams.length;
    avg.G += q.G / league.teams.length;
  }
  const gaps = (['F', 'D', 'G'] as Group[]).map((g) => ({ group: g, gap: avg[g] - mine[g] + rng.normal(0, 3) }));
  gaps.sort((a, b) => b.gap - a.gap);
  return { group: gaps[0].group, bar: mine[gaps[0].group] };
}

/** Players traded in the last three weeks are not flipped again. */
function recentlyMoved(league: League, playerId: number): boolean {
  for (const t of league.transactions) {
    if (t.season !== league.season) break;
    if (t.kind === 'trade' && t.playerIds.includes(playerId)) return league.day - t.day < 21;
  }
  return false;
}

function onCooldown(league: League, teamId: number): boolean {
  const last = league.aiMemory[teamId]?.lastTradeDay ?? -100;
  // Front offices work the phones nonstop in the final days before the deadline.
  const gap = league.tradeDeadlineDay - league.day <= 3 ? 1 : league.tradeDeadlineDay - league.day <= 14 ? 3 : 6;
  return league.phase === 'regular' && league.day - last < gap;
}

const isExpiring = (league: League, p: Player): boolean => !!p.contract && endOf(contractFor(p, capSeason(league)) ?? p.contract) <= capSeason(league);

/** The buyer's tradeable assets: picks in the next two drafts, prospects and depth players outside its core. */
/** A team's core: top-six forwards, top-four defence and its starting goalie. */
function coreOf(league: League, teamId: number): Set<number> {
  const r = roster(league, teamId);
  const core = new Set<number>();
  for (const g of ['F', 'D', 'G'] as Group[]) {
    const same = r.filter((p) => grp(p) === g).sort((a, b) => b.ca - a.ca);
    for (const p of same.slice(0, SLOT[g])) core.add(p.id);
  }
  return core;
}

function assetPool(league: League, teamId: number, exclude: Set<number>): TradeAsset[] {
  const core = coreOf(league, teamId);
  const players = [...playersOf(league, teamId, ['active', 'prospect'])].filter((p) => !core.has(p.id) && !exclude.has(p.id) && !recentlyMoved(league, p.id) && p.contract);
  const picks = league.draftPicks.filter((d) => d.ownerId === teamId && d.playerId === undefined && d.season <= league.season + 2);
  return [...players.map((p) => ({ kind: 'player' as const, id: p.id })), ...picks.map((d) => ({ kind: 'pick' as const, id: d.id }))];
}

/**
 * Package from `buyer` worth at least `need` to `seller`, preferring assets
 * the seller values more than the buyer does. Returns null if it can't be done
 * within a few assets.
 */
function buildPackage(league: League, buyer: number, seller: number, need: number, exclude: Set<number>, rng: Rng): TradeAsset[] | null {
  // The seller can only take back so many roster players (it loses one in the deal).
  let activeRoom = Math.max(0, ROSTER_HARD_MAX + 1 - playersOf(league, seller).filter((p) => !p.ltir).length);
  const isActive = (a: TradeAsset) => a.kind === 'player' && league.players[a.id]?.status === 'active';
  const firstRounder = (a: TradeAsset) => a.kind === 'pick' && league.draftPicks.find((d) => d.id === a.id)?.round === 1;
  let firsts = 0; // GMs part with at most one first-round pick in a deal.
  const pool = assetPool(league, buyer, exclude)
    .filter((a) => a.kind === 'pick' || tradeConsent(league, league.players[a.id], seller).granted)
    .map((a) => ({ a, sv: assetValue(league, seller, a), bv: assetValue(league, buyer, a) }))
    .filter((x) => x.sv > 0.5)
    .sort((x, y) => y.sv / Math.max(1, y.bv) - x.sv / Math.max(1, x.bv) + rng.normal(0, 0.05));
  const out: TradeAsset[] = [];
  let got = 0;
  // A single asset that covers it is the cleanest deal.
  const single = pool.filter((x) => x.sv >= need && (!isActive(x.a) || activeRoom > 0)).sort((x, y) => x.sv - y.sv)[0];
  if (single && single.sv <= need * 1.6) return [single.a];
  for (const x of pool) {
    if (got >= need) break;
    if (firstRounder(x.a) && firsts >= 1) continue;
    if (isActive(x.a)) {
      if (activeRoom <= 0) continue;
      activeRoom--;
    }
    if (firstRounder(x.a)) firsts++;
    out.push(x.a);
    got += x.sv;
    if (out.length >= 5) break;
  }
  if (got >= need) return out;
  // Fewer, bigger pieces: largest first, then drop whatever isn't needed.
  const big: typeof pool = [];
  let sum = 0;
  let room = Math.max(0, ROSTER_HARD_MAX + 1 - playersOf(league, seller).filter((p) => !p.ltir).length);
  let bigFirsts = 0;
  for (const x of [...pool].sort((a, b) => b.sv - a.sv)) {
    if (sum >= need || big.length >= 5) break;
    if (firstRounder(x.a) && bigFirsts >= 1) continue;
    if (isActive(x.a)) {
      if (room <= 0) continue;
      room--;
    }
    if (firstRounder(x.a)) bigFirsts++;
    big.push(x);
    sum += x.sv;
  }
  if (sum < need) return null;
  for (const x of [...big].sort((a, b) => a.sv - b.sv)) {
    if (sum - x.sv >= need) {
      big.splice(big.indexOf(x), 1);
      sum -= x.sv;
    }
  }
  return big.map((x) => x.a);
}

/** How far a team would be over its cap limit after the proposal (0 if fine). */
function capOver(league: League, p: TradeProposal, teamId: number): number {
  const c = checkTrade(league, p).cap.find((x) => x.teamId === teamId);
  return c && !c.ok ? c.after - c.limit : 0;
}

/**
 * Make the money work the way NHL teams do: the seller retains salary (up to
 * 50%, if it is willing), and/or the buyer sends one or two contracts back.
 */
function fitCap(league: League, p: TradeProposal, target: Player, buyer: number, seller: number): TradeProposal | null {
  let cur = p;
  let over = capOver(league, cur, buyer);
  if (over <= 0) return cur;
  // 1. Seller retention, in 5% steps.
  const full = fullCapHit(target.contract!);
  if (seller !== league.userTeamId && (financialPlan(league, seller).retainToSell || marketRole(league, league.teams[seller]) === 'seller')) {
    const pct = Math.min(0.5, Math.ceil((over / full) * 20) / 20);
    if (pct > 0 && !retentionErrors(league, target, seller, pct).length) {
      const withRet = { ...cur, retain: [...(cur.retain ?? []), { playerId: target.id, pct }] };
      const left = capOver(league, withRet, buyer);
      if (left <= 0) return withRet;
      cur = withRet;
      over = left;
    }
  }
  // 2. Contracts going back: the buyer's least valuable dollars first.
  const inDeal = new Set(cur.give.filter((a) => a.kind === 'player').map((a) => a.id));
  for (const id of coreOf(league, buyer)) inDeal.add(id);
  const fillers = roster(league, buyer)
    .filter((x) => x.contract && x.id !== target.id && grp(x) !== 'G' && !inDeal.has(x.id) && !recentlyMoved(league, x.id) && tradeConsent(league, x, seller).granted)
    .map((x) => ({ x, hit: holderCapHit(x.contract!), v: playerTradeValue(league, buyer, x) }))
    .filter((f) => f.hit >= 900)
    .sort((a, b) => a.v / a.hit - b.v / b.hit)
    .slice(0, 8);
  const tryWith = (extra: Player[]): TradeProposal | null => {
    const q = { ...cur, give: [...cur.give, ...extra.map((x) => ({ kind: 'player' as const, id: x.id }))] };
    return validateTrade(league, q).length ? null : q;
  };
  const singles = fillers.filter((f) => f.hit >= over).sort((a, b) => a.v - b.v);
  for (const f of singles.slice(0, 3)) {
    const q = tryWith([f.x]);
    if (q) return q;
  }
  for (let i = 0; i < fillers.length; i++)
    for (let j = i + 1; j < fillers.length; j++) {
      if (fillers[i].hit + fillers[j].hit < over) continue;
      const q = tryWith([fillers[i].x, fillers[j].x]);
      if (q) return q;
    }
  return null;
}

/**
 * When retention or a salary filler shifts the balance, the buyer adds a
 * little more (a pick or prospect) so the seller still says yes.
 */
function topUp(league: League, p: TradeProposal, rng: Rng): TradeProposal {
  if (validateTrade(league, p).length) return p;
  const ev = evaluateTrade(league, p);
  if (ev.accept) return p;
  const short = ev.valueOut * 1.02 * league.settings.tradeDifficulty + 1.5 - ev.valueIn + 0.5;
  if (short > Math.max(15, ev.valueIn * 0.4)) return p;
  const used = new Set([...p.give, ...p.get].filter((a) => a.kind === 'player').map((a) => a.id));
  const extra = buildPackage(league, p.from, p.to, short, used, rng)?.filter((a) => !p.give.some((g) => g.kind === a.kind && g.id === a.id));
  if (!extra?.length) return p;
  const firsts = [...p.give, ...extra].filter((a) => a.kind === 'pick' && league.draftPicks.find((d) => d.id === a.id)?.round === 1).length;
  return firsts > 1 ? p : { ...p, give: [...p.give, ...extra] };
}

/** A team doesn't trade for a player it dealt away earlier this season. */
function reacquires(league: League, p: TradeProposal): boolean {
  const moves = proposalMoves(p);
  for (const t of league.transactions) {
    if (t.season !== league.season) break;
    if (t.kind !== 'trade') continue;
    for (const m of moves) if (m.asset.kind === 'player' && t.playerIds.includes(m.asset.id) && t.teamIds.includes(m.to)) return true;
  }
  return false;
}

/** Both sides must like it: the receiving team via its usual evaluation, the initiator by its own valuation. */
function bothAgree(league: League, p: TradeProposal): boolean {
  if (reacquires(league, p) || validateTrade(league, p).length) return false;
  if (!evaluateTrade(league, p).accept) return false;
  const mine = teamTradeValue(league, p.from, proposalMoves(p));
  return mine.valueIn >= mine.valueOut * 0.97;
}

// ───────────────────────────── idea generators ─────────────────────────────

/** A buyer upgrades its weakest slot from a team that can spare the player. */
function buyIdea(league: League, rng: Rng, buyerTeam?: Team): TradeProposal | null {
  const buyers = league.teams.filter((t) => isCpu(league, t.id) && !onCooldown(league, t.id) && marketRole(league, t) !== 'seller');
  const buyer = buyerTeam ?? (buyers.length ? rng.pick(buyers) : null);
  if (!buyer) return null;
  const need = biggestNeed(league, buyer.id, rng);
  const candidates: Player[] = [];
  for (const t of league.teams) {
    if (t.id === buyer.id || t.id === league.userTeamId || onCooldown(league, t.id)) continue;
    const role = marketRole(league, t);
    const r = roster(league, t.id).filter(healthy);
    const same = r.filter((p) => grp(p) === need.group).sort((a, b) => b.ca - a.ca);
    for (const [i, p] of same.entries()) {
      if (p.ca < need.bar + 3 || !p.contract || recentlyMoved(league, p.id)) continue;
      const age = capSeason(league) - p.birthYear;
      // Sellers part with veterans; others only spare depth beyond their own lineup needs.
      const spare = role === 'seller' ? age >= 25 || isExpiring(league, p) : same.length > KEEP[need.group] && i >= SLOT[need.group];
      if (!spare) continue;
      if (!tradeConsent(league, p, buyer.id).granted) continue;
      candidates.push(p);
    }
  }
  if (!candidates.length) return null;
  // Best fit for the buyer: biggest upgrade per unit of value it would cost.
  candidates.sort((a, b) => (b.ca - need.bar) / Math.max(5, playerTradeValue(league, b.teamId!, b)) - (a.ca - need.bar) / Math.max(5, playerTradeValue(league, a.teamId!, a)) + rng.normal(0, 0.02));
  for (const target of candidates.slice(0, 3)) {
    const seller = target.teamId!;
    const price = playerTradeValue(league, seller, target) * 1.08 + 2;
    const pkg = buildPackage(league, buyer.id, seller, price, new Set([target.id]), rng);
    if (!pkg) continue;
    let p: TradeProposal | null = { from: buyer.id, to: seller, give: pkg, get: [{ kind: 'player', id: target.id }] };
    p = fitCap(league, p, target, buyer.id, seller);
    if (!p) continue;
    p = topUp(league, p, rng);
    if (bothAgree(league, p)) return p;
  }
  return null;
}

/** A seller shops a veteran (often an expiring rental) to the buyers who need him. */
function sellIdea(league: League, rng: Rng): TradeProposal | null {
  const sellers = league.teams.filter((t) => isCpu(league, t.id) && !onCooldown(league, t.id) && marketRole(league, t) === 'seller');
  if (!sellers.length) return null;
  const seller = rng.pick(sellers);
  const vets = roster(league, seller.id)
    .filter((p) => healthy(p) && p.contract && capSeason(league) - p.birthYear >= 26 && p.ca >= 128 && !recentlyMoved(league, p.id))
    .sort((a, b) => (isExpiring(league, b) ? 12 : 0) + b.ca - ((isExpiring(league, a) ? 12 : 0) + a.ca));
  for (const vet of vets.slice(0, 2)) {
    const buyers = league.teams
      .filter((t) => t.id !== seller.id && isCpu(league, t.id) && !onCooldown(league, t.id) && marketRole(league, t) === 'buyer')
      .filter((t) => slotQuality(league, t.id)[grp(vet)] + 3 <= vet.ca && tradeConsent(league, vet, t.id).granted);
    for (const buyer of rng.shuffle(buyers).slice(0, 3)) {
      const price = playerTradeValue(league, seller.id, vet) * 1.05 + 1.5;
      const pkg = buildPackage(league, buyer.id, seller.id, price, new Set([vet.id]), rng);
      if (!pkg) continue;
      let p: TradeProposal | null = { from: buyer.id, to: seller.id, give: pkg, get: [{ kind: 'player', id: vet.id }] };
      p = fitCap(league, p, vet, buyer.id, seller.id);
      if (!p) continue;
      p = topUp(league, p, rng);
      if (bothAgree(league, p)) return p;
    }
  }
  return null;
}

/** Hockey trade: two teams swap from surplus to need (player for player, plus a pick to balance). */
function swapIdea(league: League, rng: Rng): TradeProposal | null {
  const teams = league.teams.filter((t) => isCpu(league, t.id) && !onCooldown(league, t.id));
  if (teams.length < 2) return null;
  const a = rng.pick(teams);
  const needA = biggestNeed(league, a.id, rng).group;
  const rosterA = roster(league, a.id).filter(healthy);
  const surplusGroups = (['F', 'D', 'G'] as Group[]).filter((g) => g !== needA && rosterA.filter((p) => grp(p) === g).length > KEEP[g]);
  if (!surplusGroups.length) return null;
  const give = rng.pick(surplusGroups);
  // Hockey trades move middle-of-the-lineup players, not a team's cornerstones.
  const coreA = coreOf(league, a.id);
  const offerable = rosterA.filter((p) => grp(p) === give && p.contract && !coreA.has(p.id) && !recentlyMoved(league, p.id)).sort((x, y) => y.ca - x.ca).slice(0, 5);
  for (const b of rng.shuffle(teams.filter((t) => t.id !== a.id)).slice(0, 6)) {
    if (biggestNeed(league, b.id, rng).group !== give) continue;
    const rosterB = roster(league, b.id).filter(healthy);
    if (rosterB.filter((p) => grp(p) === needA).length <= KEEP[needA]) continue;
    const coreB = coreOf(league, b.id);
    const theirs = rosterB.filter((p) => grp(p) === needA && p.contract && !coreB.has(p.id) && !recentlyMoved(league, p.id)).sort((x, y) => y.ca - x.ca).slice(0, 5);
    for (const mine of offerable) {
      if (!tradeConsent(league, mine, b.id).granted) continue;
      const vMine = playerTradeValue(league, b.id, mine);
      const match = theirs
        .filter((p) => tradeConsent(league, p, a.id).granted && Math.abs(p.ca - mine.ca) <= 10)
        .map((p) => ({ p, d: Math.abs(playerTradeValue(league, a.id, p) - vMine) }))
        .sort((x, y) => x.d - y.d)[0];
      if (!match) continue;
      let p: TradeProposal = { from: a.id, to: b.id, give: [{ kind: 'player', id: mine.id }], get: [{ kind: 'player', id: match.p.id }] };
      if (bothAgree(league, p)) return p;
      // Balance with a mid-round pick from whichever side is short.
      const ev = evaluateTrade(league, p);
      if (ev.valueIn < ev.valueOut) {
        const pick = league.draftPicks.filter((d) => d.ownerId === a.id && d.playerId === undefined && d.round >= 2 && d.round <= 4 && d.season <= league.season + 1).sort((x, y) => y.round - x.round)[0];
        if (pick) {
          p = { ...p, give: [...p.give, { kind: 'pick', id: pick.id }] };
          if (bothAgree(league, p)) return p;
        }
      }
    }
  }
  return null;
}

/** Cap dump: a team tight to the cap moves a contract plus a sweetener to a team with room. */
function dumpIdea(league: League, rng: Rng): TradeProposal | null {
  const tight = league.teams.filter((t) => isCpu(league, t.id) && !onCooldown(league, t.id)).filter((t) => teamCapSheet(league, t.id).space < 1500);
  if (!tight.length) return null;
  const from = rng.pick(tight);
  const r = roster(league, from.id);
  const counts = { F: r.filter((p) => grp(p) === 'F').length, D: r.filter((p) => grp(p) === 'D').length, G: r.filter((p) => grp(p) === 'G').length };
  const cands = r
    .filter((p) => p.contract && holderCapHit(p.contract) >= 1500 && counts[grp(p)] > KEEP[grp(p)] && capSeason(league) - p.birthYear >= 27 && !recentlyMoved(league, p.id))
    .map((p) => ({ p, surplus: contractValue(p, league).value - holderCapHit(p.contract!) }))
    .filter((x) => x.surplus < -750)
    .sort((a, b) => a.surplus - b.surplus);
  for (const { p, surplus } of cands.slice(0, 3)) {
    const takers = league.teams
      .filter((t) => t.id !== from.id && isCpu(league, t.id) && teamCapSheet(league, t.id).space > holderCapHit(p.contract!) + 2000)
      .sort((a, b) => teamCapSheet(league, b.id).space - teamCapSheet(league, a.id).space)
      .slice(0, 4);
    for (const to of takers) {
      if (!tradeConsent(league, p, to.id).granted) continue;
      let prop: TradeProposal = { from: from.id, to: to.id, give: [{ kind: 'player', id: p.id }], get: [] };
      if (surplus < -1500) {
        // Overpaid: attach a pick roughly worth the burden.
        const burden = (-surplus / 1000) * Math.min(3, Math.max(1, (endOf(p.contract!) - capSeason(league) + 1))) * 2;
        const pick = league.draftPicks
          .filter((d) => d.ownerId === from.id && d.playerId === undefined && d.season <= league.season + 2)
          .map((d) => ({ d, v: assetValue(league, to.id, { kind: 'pick', id: d.id }) }))
          .filter((x) => x.v >= burden * 0.6 && (x.d.round > 1 || burden > 20))
          .sort((a, b) => a.v - b.v)[0];
        if (!pick) continue;
        prop = { ...prop, give: [...prop.give, { kind: 'pick', id: pick.d.id }] };
      }
      if (dumpAgreed(league, prop, surplus)) return prop;
    }
  }
  return null;
}

/**
 * A dump is judged differently by the team shedding salary: it gives up value
 * on paper to buy cap room, so it only checks that the sweetener isn't worth
 * more than the burden it sheds. The taker evaluates it normally.
 */
function dumpAgreed(league: League, p: TradeProposal, surplus: number): boolean {
  if (reacquires(league, p) || validateTrade(league, p).length || !evaluateTrade(league, p).accept) return false;
  const player = league.players[p.give[0].id];
  const years = Math.min(3, Math.max(1, endOf(player.contract!) - capSeason(league) + 1));
  const relief = (Math.max(0, -surplus) / 1000) * years * 3 + 3;
  const cost = p.give.slice(1).reduce((s, a) => s + assetValue(league, p.from, a), 0) + playerTradeValue(league, p.from, player) * 0.5;
  return cost <= relief;
}

// ───────────────────────────── running the market ─────────────────────────────

/** Expected trade attempts today. */
function attemptsToday(league: League, rng: Rng): number {
  if (league.phase === 'regular') {
    const toDeadline = league.tradeDeadlineDay - league.day;
    if (toDeadline < 0) return 0;
    const base = league.day < 15 ? 0.25 : 0.8;
    const rate = toDeadline <= 3 ? 12 : toDeadline <= 14 ? 5 : base;
    return Math.floor(rate) + (rng.chance(rate - Math.floor(rate)) ? 1 : 0);
  }
  return 0;
}

function announce(league: League, p: TradeProposal): void {
  const deadline = league.phase === 'regular' && league.tradeDeadlineDay - league.day <= 3;
  if (deadline) {
    const big = [...p.give, ...p.get].some((a) => a.kind === 'player' && (league.players[a.id]?.reputation ?? 0) >= 50);
    if (big) addNews(league, { category: 'trade', headline: 'Deadline frenzy: another deal goes through as contenders load up', teamIds: [p.from, p.to], playerIds: [...p.give, ...p.get].filter((a) => a.kind === 'player').map((a) => a.id), importance: 2 });
  }
}

/** Run one trade idea; returns the executed proposal or null. */
export function tryMarketTrade(league: League): TradeProposal | null {
  return withRng(league, (rng) => {
    const toDeadline = league.phase === 'regular' ? league.tradeDeadlineDay - league.day : 99;
    const deadline = toDeadline >= 0 && toDeadline <= 14;
    const anyTight = league.teams.some((t) => isCpu(league, t.id) && teamCapSheet(league, t.id).space < 1500);
    const kinds: [string, number][] = [
      ['buy', deadline ? 0.4 : 0.38],
      ['sell', deadline ? 0.35 : 0.2],
      ['swap', deadline ? 0.1 : 0.27],
      ['dump', anyTight ? 0.15 : 0],
    ];
    const order = [...kinds].sort((a, b) => b[1] * rng.next() - a[1] * rng.next());
    for (const [kind] of order) {
      // Weighing ideas never changes the league, so cap sheets can be shared.
      const p = withCapCache(() => (kind === 'buy' ? buyIdea(league, rng) : kind === 'sell' ? sellIdea(league, rng) : kind === 'swap' ? swapIdea(league, rng) : dumpIdea(league, rng)));
      if (!p) continue;
      executeTrade(league, p);
      for (const id of [p.from, p.to]) {
        trimRoster(league, id);
        ensureDressable(league, id);
        if (isCpu(league, id)) enforceCap(league, id);
      }
      announce(league, p);
      return p;
    }
    return null;
  });
}

/** Daily in-season market activity. */
export function marketDay(league: League): number {
  const n = withRng(league, (rng) => attemptsToday(league, rng));
  let done = 0;
  for (let i = 0; i < n; i++) if (tryMarketTrade(league)) done++;
  return done;
}

/** A burst of offseason trading (draft weekend, free agency, training camp). */
export function offseasonMarket(league: League, attempts: number): number {
  let done = 0;
  for (let i = 0; i < attempts; i++) if (tryMarketTrade(league)) done++;
  return done;
}


// ───────────────────────────── offers to the user ─────────────────────────────

/** CPU offer that the user can accept or ignore (it is not executed here). */
export interface UserOffer {
  proposal: TradeProposal;
  note: string;
}

/** The CPU side of an offer to the user must still be worth it to the CPU team. */
function cpuLikes(league: League, p: TradeProposal, margin = 1): boolean {
  if (validateTrade(league, p).length) return false;
  const v = teamTradeValue(league, p.from, proposalMoves(p));
  return v.valueIn >= v.valueOut * margin;
}

/**
 * Rental call: the user is out of the race near the deadline, and a buyer
 * wants one of the user's veterans (often on an expiring deal).
 */
function rentalOffer(league: League, rng: Rng): UserOffer | null {
  const me = league.userTeamId;
  const myTeam = league.teams[me];
  if (marketRole(league, { ...myTeam, strategy: 'balanced' }) !== 'seller') return null;
  const vets = roster(league, me)
    .filter((p) => healthy(p) && p.contract && capSeason(league) - p.birthYear >= 26 && p.ca >= 125)
    .sort((a, b) => (isExpiring(league, b) ? 15 : 0) + b.ca - ((isExpiring(league, a) ? 15 : 0) + a.ca));
  for (const vet of vets.slice(0, 3)) {
    const buyers = league.teams.filter(
      (t) => t.id !== me && !onCooldown(league, t.id) && marketRole(league, t) === 'buyer' && slotQuality(league, t.id)[grp(vet)] + 2 <= vet.ca && tradeConsent(league, vet, t.id).granted,
    );
    for (const buyer of rng.shuffle(buyers).slice(0, 3)) {
      // Priced at what the user would accept for him, paid in what the buyer can spare.
      const price = playerTradeValue(league, me, vet) * 1.02 + 1;
      const pkg = buildPackage(league, buyer.id, me, price, new Set([vet.id]), rng);
      if (!pkg) continue;
      let p: TradeProposal | null = { from: buyer.id, to: me, give: pkg, get: [{ kind: 'player', id: vet.id }] };
      p = fitCap(league, p, vet, buyer.id, me);
      if (!p || !cpuLikes(league, p, 0.95)) continue;
      const rental = isExpiring(league, vet) ? ' as a deadline rental' : '';
      return { proposal: p, note: `The ${buyer.city} ${buyer.name} are loading up for a playoff run and want ${fullName(vet)}${rental}.` };
    }
  }
  return null;
}

/** A capped-out CPU team asks the user (who has room) to take a contract, and pays a pick to do it. */
function dumpOffer(league: League, rng: Rng): UserOffer | null {
  const me = league.userTeamId;
  const room = teamCapSheet(league, me).space;
  if (room < 2500) return null;
  const tight = rng.shuffle(league.teams.filter((t) => t.id !== me && teamCapSheet(league, t.id).space < 1500));
  for (const from of tight.slice(0, 4)) {
    const r = roster(league, from.id);
    const counts = { F: r.filter((p) => grp(p) === 'F').length, D: r.filter((p) => grp(p) === 'D').length, G: r.filter((p) => grp(p) === 'G').length };
    const cands = r
      .filter((p) => p.contract && holderCapHit(p.contract) >= 1500 && holderCapHit(p.contract) <= room - 500 && counts[grp(p)] > KEEP[grp(p)] && capSeason(league) - p.birthYear >= 27 && !recentlyMoved(league, p.id) && tradeConsent(league, p, me).granted)
      .map((p) => ({ p, surplus: contractValue(p, league).value - holderCapHit(p.contract!) }))
      .filter((x) => x.surplus < -750)
      .sort((a, b) => a.surplus - b.surplus);
    for (const { p, surplus } of cands.slice(0, 2)) {
      const years = Math.min(3, Math.max(1, endOf(p.contract!) - capSeason(league) + 1));
      const burden = (Math.max(0, -surplus) / 1000) * years * 3;
      // The pick has to make the user whole for the dead weight.
      const pick = league.draftPicks
        .filter((d) => d.ownerId === from.id && d.playerId === undefined && d.season <= league.season + 2)
        .map((d) => ({ d, mine: assetValue(league, me, { kind: 'pick', id: d.id }), theirs: assetValue(league, from.id, { kind: 'pick', id: d.id }) }))
        .filter((x) => x.mine >= burden * 0.9 + 2 && x.theirs <= burden * 1.5 + 4 && (x.d.round > 1 || burden > 20))
        .sort((a, b) => a.theirs - b.theirs)[0];
      if (!pick) continue;
      const prop: TradeProposal = { from: from.id, to: me, give: [{ kind: 'player', id: p.id }, { kind: 'pick', id: pick.d.id }], get: [] };
      if (validateTrade(league, prop).length) continue;
      const d = pick.d;
      const pickName = `${d.season} ${d.round === 1 ? '1st' : d.round === 2 ? '2nd' : d.round === 3 ? '3rd' : `${d.round}th`}-round pick`;
      return { proposal: prop, note: `The ${from.city} ${from.name} need cap room and will attach a ${pickName} if you take ${fullName(p)}'s contract.` };
    }
  }
  return null;
}

/** A CPU team with a hole calls about one of the user's players who would fill it. */
function needOffer(league: League, rng: Rng): UserOffer | null {
  const me = league.userTeamId;
  const cpus = rng.shuffle(league.teams.filter((t) => t.id !== me && !onCooldown(league, t.id) && marketRole(league, t) !== 'seller'));
  const mine = roster(league, me).filter((p) => healthy(p) && p.contract && capSeason(league) - p.birthYear >= 21);
  for (const cpu of cpus.slice(0, 5)) {
    const need = biggestNeed(league, cpu.id, rng);
    const targets = mine.filter((p) => grp(p) === need.group && p.ca >= need.bar + 3 && tradeConsent(league, p, cpu.id).granted).sort((a, b) => a.ca - b.ca);
    for (const target of targets.slice(0, 2)) {
      const price = playerTradeValue(league, me, target) * 1.02 + 1;
      const pkg = buildPackage(league, cpu.id, me, price, new Set([target.id]), rng);
      if (!pkg) continue;
      let p: TradeProposal | null = { from: cpu.id, to: me, give: pkg, get: [{ kind: 'player', id: target.id }] };
      p = fitCap(league, p, target, cpu.id, me);
      if (!p || !cpuLikes(league, p, 0.95)) continue;
      const what = need.group === 'G' ? 'a starting goaltender' : need.group === 'D' ? 'help on the blue line' : 'scoring help up front';
      return { proposal: p, note: `The ${cpu.city} ${cpu.name} are looking for ${what} and have called about ${fullName(target)}.` };
    }
  }
  return null;
}

/**
 * Unsolicited offers to the user: buyers calling about the user's players
 * when the user is selling, cap dumps that pay a pick, and teams with a need
 * the user's roster can fill.
 */
export function offerForUser(league: League): UserOffer | null {
  return withCapCache(() => offerForUserInner(league));
}

function offerForUserInner(league: League): UserOffer | null {
  const kind = withRng(league, (rng) => {
    const deadline = league.phase === 'regular' && league.tradeDeadlineDay - league.day <= 14;
    const r = rng.next();
    return r < (deadline ? 0.4 : 0.15) ? 'rental' : r < (deadline ? 0.55 : 0.35) ? 'dump' : 'need';
  });
  const first = withRng(league, (rng) => (kind === 'rental' ? rentalOffer(league, rng) : kind === 'dump' ? dumpOffer(league, rng) : needOffer(league, rng)));
  return first ?? withRng(league, (rng) => needOffer(league, rng)) ?? findOfferForUser(league);
}
