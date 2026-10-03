/**
 * CapManager: team cap accounting from contracts and the cap ledger.
 *
 * Cap charge to a team for a season:
 *  - active roster (incl. IR / LTIR): the contract's cap hit after retention
 *  - minor-league assignment: cap hit minus (minimum salary + $375K) ("buried"
 *    relief, CBA 50.5(d)); 35+ contracts get no relief
 *  - salary retained on players it traded away (cap hit × retained %)
 *  - dead cap: buyouts, bonus overages, 35+ retirements, terminations
 * Available space = upper limit + LTIR relief − total.
 */
import type { Contract, League, Player } from '../types';
import { rulesFor } from './rules';
import { activeClause, cashIn, fullCapHit, holderCapHit, yearIn, yearsOf } from './contract';
import { onInjuredReserve } from './rulesEngine';
import { isForward } from '../player/ability';

/** League year the books are currently kept for (offseason phases are the upcoming year). */
export function capSeason(league: Pick<League, 'phase' | 'season'>): number {
  return league.phase === 'resign' || league.phase === 'freeAgency' ? league.season + 1 : league.season;
}

/** Season a contract signed right now starts in. */
export function contractStartSeason(league: Pick<League, 'phase' | 'season'>): number {
  return league.phase === 'draft' || league.phase === 'resign' || league.phase === 'freeAgency' ? league.season + 1 : league.season;
}

/** The contract in force for a player in a season (the current one or a signed extension). */
export function contractFor(p: Player, season: number): Contract | null {
  const c = p.contract;
  if (!c) return null;
  if (yearIn(c, season)) return c;
  if (c.next && yearIn(c.next, season)) return c.next;
  return null;
}

export interface CapRow {
  playerId: number;
  name: string;
  pos: Player['pos'];
  age: number;
  group: 'F' | 'D' | 'G';
  status: 'Active' | 'IR' | 'LTIR' | 'Minors';
  /** Charge to this team this season. */
  capHit: number;
  /** Contract cap hit before retention. */
  fullCapHit: number;
  /** Actual salary this season (salary + signing bonus) paid by this team. */
  cash: number;
  aav: number;
  yearsLeft: number;
  endSeason: number;
  clause: string | null;
  type: Contract['type'];
  twoWay: boolean;
  retainedPct: number;
  buried: boolean;
  perfBonus: number;
  source: Contract['source'];
  thirtyFivePlus: boolean;
}

export interface DeadRow {
  kind: 'buyout' | 'retained' | 'bonusOverage' | 'thirtyFivePlus' | 'termination' | 'recapture' | 'other';
  playerId?: number;
  name: string;
  amount: number;
  note?: string;
}

export interface CapSheet {
  teamId: number;
  season: number;
  upper: number;
  lower: number;
  forwards: number;
  defense: number;
  goalies: number;
  /** Buried portion of minor-league contracts. */
  buried: number;
  activePlayers: number;
  deadCap: number;
  retained: number;
  buyouts: number;
  bonuses: number;
  /** Potential performance bonuses (not in cap hits; earned bonuses over the cap become next season's overage). */
  perfBonusPotential: number;
  ltirRelief: number;
  total: number;
  space: number;
  /** Ceiling that applies right now (upper limit, +10% in the offseason, + LTIR relief). */
  effectiveLimit: number;
  rows: CapRow[];
  dead: DeadRow[];
  compliant: boolean;
  belowFloor: boolean;
}

function chargeFor(p: Player, c: Contract, season: number): { charge: number; buried: boolean } {
  if (!yearIn(c, season)) return { charge: 0, buried: false };
  const hit = holderCapHit(c);
  if (p.status === 'prospect') {
    if (c.thirtyFivePlus) return { charge: hit, buried: true };
    const r = rulesFor(season);
    return { charge: Math.max(0, hit - (r.minimumSalary + r.buriedAllowance)), buried: true };
  }
  return { charge: hit, buried: false };
}

function rowStatus(p: Player, season: number): CapRow['status'] {
  if (p.status === 'prospect') return 'Minors';
  if (p.ltir) return 'LTIR';
  if (onInjuredReserve(p, season)) return 'IR';
  return 'Active';
}

/** Full cap sheet for a team in a season (defaults to the current books). */
export function teamCapSheet(league: League, teamId: number, season = capSeason(league)): CapSheet {
  const r = rulesFor(season);
  const rows: CapRow[] = [];
  const dead: DeadRow[] = [];
  let forwards = 0, defense = 0, goalies = 0, buried = 0, perf = 0, retained = 0;
  for (const p of Object.values(league.players)) {
    if (p.status === 'retired') continue;
    const c = contractFor(p, season);
    if (!c) continue;
    if (p.teamId === teamId && (p.status === 'active' || p.status === 'prospect')) {
      const { charge, buried: isBuried } = chargeFor(p, c, season);
      const group = p.pos === 'G' ? 'G' : p.pos === 'D' ? 'D' : 'F';
      const y = yearIn(c, season);
      if (isBuried) buried += charge;
      else if (group === 'F') forwards += charge;
      else if (group === 'D') defense += charge;
      else goalies += charge;
      if (!isBuried) perf += (y?.perfBonus ?? 0) * (1 - (c.retained ?? []).reduce((s, x) => s + x.pct, 0));
      const share = 1 - (c.retained ?? []).reduce((s, x) => s + x.pct, 0);
      const cl = activeClause(c, season);
      rows.push({
        playerId: p.id,
        name: `${p.first} ${p.last}`,
        pos: p.pos,
        age: season - p.birthYear,
        group,
        status: rowStatus(p, season),
        capHit: charge,
        fullCapHit: fullCapHit(c),
        cash: cashIn(c, season) * share,
        aav: yearsOf(c).reduce((s, x) => s + x.salary + x.signingBonus, 0) / yearsOf(c).length,
        yearsLeft: yearsOf(c).filter((x) => x.season >= season).length,
        endSeason: yearsOf(c)[yearsOf(c).length - 1].season,
        clause: cl ? cl.kind + (cl.kind === 'M-NTC' && cl.teams ? ` (${cl.teams})` : '') : null,
        type: c.type,
        twoWay: !!c.twoWay,
        retainedPct: 1 - share,
        buried: isBuried,
        perfBonus: y?.perfBonus ?? 0,
        source: c.source,
        thirtyFivePlus: !!c.thirtyFivePlus,
      });
    }
    // Retained salary this team carries on players it traded away.
    for (const ret of c.retained ?? []) {
      if (ret.teamId !== teamId || !yearIn(c, season)) continue;
      const amt = fullCapHit(c) * ret.pct;
      retained += amt;
      dead.push({ kind: 'retained', playerId: p.id, name: `${p.first} ${p.last}`, amount: amt, note: `${Math.round(ret.pct * 100)}% retained` });
    }
  }
  let buyouts = 0, bonuses = 0, other = 0;
  for (const ch of league.capLedger) {
    if (ch.teamId !== teamId || ch.season !== season) continue;
    dead.push({ kind: ch.kind, playerId: ch.playerId, name: ch.playerName, amount: ch.amount, note: ch.note });
    if (ch.kind === 'buyout') buyouts += ch.amount;
    else if (ch.kind === 'bonusOverage') bonuses += ch.amount;
    else other += ch.amount;
  }
  const ltirRelief = league.ltir.filter((l) => l.teamId === teamId && l.season === season).reduce((s, l) => s + l.relief, 0);
  const deadCap = retained + buyouts + bonuses + other;
  const activePlayers = forwards + defense + goalies;
  const total = activePlayers + buried + deadCap;
  const offseason = league.phase === 'draft' || league.phase === 'resign' || league.phase === 'freeAgency';
  const effectiveLimit = r.upperLimit * (offseason ? 1 + r.offseasonOveragePct : 1) + ltirRelief;
  const space = r.upperLimit + ltirRelief - total;
  rows.sort((a, b) => b.capHit - a.capHit);
  return {
    teamId,
    season,
    upper: r.upperLimit,
    lower: r.lowerLimit,
    forwards,
    defense,
    goalies,
    buried,
    activePlayers,
    deadCap,
    retained,
    buyouts,
    bonuses,
    perfBonusPotential: perf,
    ltirRelief,
    total,
    space,
    effectiveLimit,
    rows,
    dead,
    compliant: total <= effectiveLimit + 1e-6,
    belowFloor: total < r.lowerLimit,
  };
}

export const CapManager = {
  getUpperLimit: (season: number) => rulesFor(season).upperLimit,
  getLowerLimit: (season: number) => rulesFor(season).lowerLimit,
  getTeamCapHit: (league: League, teamId: number, season = capSeason(league)) => teamCapSheet(league, teamId, season).total,
  getAvailableCapSpace: (league: League, teamId: number, season = capSeason(league)) => teamCapSheet(league, teamId, season).space,
  /**
   * Can this contract be registered now? In season the team must stay under
   * the upper limit (+ LTIR relief); in the offseason it may be up to 10% over.
   */
  canRegisterContract(league: League, teamId: number, c: Contract, opts: { replacingPlayerId?: number; toMinors?: boolean } = {}): { ok: boolean; errors: string[]; capAfter: number; limit: number } {
    const season = yearsOf(c)[0].season < capSeason(league) ? capSeason(league) : yearsOf(c)[0].season;
    const sheet = teamCapSheet(league, teamId, season);
    let base = sheet.total;
    if (opts.replacingPlayerId !== undefined) {
      const row = sheet.rows.find((x) => x.playerId === opts.replacingPlayerId);
      if (row) base -= row.capHit;
    }
    const r = rulesFor(season);
    let add = holderCapHit(c);
    if (opts.toMinors && !c.thirtyFivePlus) add = Math.max(0, add - (r.minimumSalary + r.buriedAllowance));
    const after = base + add;
    const limit = sheet.effectiveLimit;
    const ok = after <= limit + 1e-6;
    const t = league.teams[teamId];
    const f = (k: number) => `$${(k / 1000).toFixed(2)}M`;
    return {
      ok,
      errors: ok ? [] : [`Contract rejected: ${t.city} ${t.name} would be at ${f(after)}, over the ${f(limit)} ${limit > r.upperLimit ? 'limit (upper limit + offseason allowance/LTIR)' : 'salary cap'} by ${f(after - limit)}.`],
      capAfter: after,
      limit,
    };
  },
  teamCapSheet,
};

export interface ProjectionYear {
  season: number;
  label: string;
  upper: number;
  projected: boolean;
  /** Signed contracts (incl. extensions) counting toward the cap. */
  committed: number;
  deadCap: number;
  /** Estimated cost of re-signing RFAs whose rights the team holds. */
  rfaHolds: number;
  /** Space after commitments and dead cap. */
  space: number;
  /** Space after also re-signing projected RFAs. */
  projectedSpace: number;
  contracts: number;
  expiring: { playerId: number; name: string; status: 'RFA' | 'UFA'; capHit: number }[];
}

/** Future cap projection for planning (human GM and AI). */
export function capProjection(league: League, teamId: number, years = 5, rfaCost?: (p: Player, season: number) => number): ProjectionYear[] {
  const out: ProjectionYear[] = [];
  const start = capSeason(league);
  const roster = Object.values(league.players).filter((p) => p.teamId === teamId && p.contract && (p.status === 'active' || p.status === 'prospect'));
  for (let i = 0; i < years; i++) {
    const s = start + i;
    const r = rulesFor(s);
    const sheet = teamCapSheet(league, teamId, s);
    let rfa = 0;
    const expiring: ProjectionYear['expiring'] = [];
    for (const p of roster) {
      const c = contractFor(p, s - 1);
      if (!c || contractFor(p, s)) continue;
      const end = yearsOf(c)[yearsOf(c).length - 1].season;
      if (end !== s - 1) continue;
      const age = s - p.birthYear;
      const status: 'RFA' | 'UFA' = age < 27 ? 'RFA' : 'UFA';
      expiring.push({ playerId: p.id, name: `${p.first} ${p.last}`, status, capHit: holderCapHit(c) });
      if (status === 'RFA' && p.status === 'active') rfa += rfaCost ? rfaCost(p, s) : holderCapHit(c) * 1.15;
    }
    // RFA holds carry forward as long-term costs in later years.
    const priorHolds = out.length ? out[out.length - 1].rfaHolds : 0;
    const holds = priorHolds + rfa;
    out.push({
      season: s,
      label: r.label,
      upper: r.upperLimit,
      projected: r.projected,
      committed: sheet.activePlayers + sheet.buried,
      deadCap: sheet.deadCap,
      rfaHolds: holds,
      space: r.upperLimit - sheet.total,
      projectedSpace: r.upperLimit - sheet.total - holds,
      contracts: sheet.rows.length,
      expiring,
    });
  }
  return out;
}

/** Players under contract with this team in a group (F/D/G) for quick AI checks. */
export function groupOf(p: Player): 'F' | 'D' | 'G' {
  return p.pos === 'G' ? 'G' : p.pos === 'D' ? 'D' : isForward(p.pos) ? 'F' : 'F';
}
