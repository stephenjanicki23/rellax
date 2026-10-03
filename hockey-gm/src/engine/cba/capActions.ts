/**
 * Cap transactions that create or remove cap charges: buyouts, LTIR,
 * performance-bonus overages, 35+ retirements, ELC slides and playoff cap
 * enforcement. Every charge is written to league.capLedger so the cap sheet,
 * projections and saves all read from one place.
 */
import type { CapCharge, Contract, League, Lines, Player } from '../types';
import { addNews, addTransaction, teamName } from '../league/helpers';
import { rulesFor, STATIC } from './rules';
import { ageSept15, fullCapHit, holderCapHit, refreshContract, retainedShare, yearIn, yearsOf } from './contract';
import { calculateBuyout, calculateLTIRRelief, ltirEligible, validatePlayoffRoster, fmtCap, type BuyoutCalc } from './rulesEngine';
import { capSeason, contractFor, teamCapSheet } from './capManager';
import { nhlGamesIn } from './experience';
import { isForward } from '../player/ability';

const name = (p: Player) => `${p.first} ${p.last}`;

function addCharge(league: League, ch: Omit<CapCharge, 'id'>): void {
  if (ch.amount <= 0.0005) return;
  const id = (league.capLedger.reduce((m, x) => Math.max(m, x.id), 0) || 0) + 1;
  league.capLedger.push({ id, ...ch, amount: Math.round(ch.amount * 1000) / 1000 });
}

/** Every team carrying part of a contract: [teamId, share]. */
function shares(p: Player, c: Contract): [number, number][] {
  const out: [number, number][] = [];
  if (p.teamId !== null) out.push([p.teamId, 1 - retainedShare(c)]);
  for (const r of c.retained ?? []) out.push([r.teamId, r.pct]);
  return out.filter(([, s]) => s > 0);
}

// ───────────────────────────── buyouts ─────────────────────────────

/** Buyout window: the offseason after the playoffs and before free agency (CBA 50.9(i)). */
export function inBuyoutWindow(league: League): boolean {
  return league.phase === 'draft' || league.phase === 'resign';
}

export interface BuyoutPreview extends BuyoutCalc {
  allowed: boolean;
  errors: string[];
  fromSeason: number;
}

export function previewBuyout(league: League, p: Player): BuyoutPreview {
  const fromSeason = league.season + 1;
  const c = contractFor(p, fromSeason);
  const errors: string[] = [];
  if (!inBuyoutWindow(league)) errors.push('Buyouts are only allowed in the offseason buyout window (after the playoffs, before free agency opens).');
  if (!c) errors.push(`${name(p)} has no contract years remaining after this season.`);
  if (p.injury && p.injury.daysRemaining > 0) errors.push(`${name(p)} is injured and cannot be bought out (CBA 50.9(i)).`);
  if (p.teamId === null) errors.push(`${name(p)} is not under contract with a team.`);
  const calc: BuyoutCalc = c ? calculateBuyout(p, c, fromSeason) : { eligible: false, reason: 'No contract.', ratio: 0, remainingSalary: 0, totalCost: 0, payments: {}, capCharges: {}, savings: 0 };
  if (c && !calc.eligible) errors.push(calc.reason ?? 'Not eligible.');
  return { ...calc, allowed: errors.length === 0, errors, fromSeason };
}

/** Buy out a contract: yearly charges go to the ledger (split by retained share) and the player becomes a UFA. */
export function buyoutPlayer(league: League, p: Player): { ok: boolean; errors: string[]; preview: BuyoutPreview } {
  const pv = previewBuyout(league, p);
  if (!pv.allowed) return { ok: false, errors: pv.errors, preview: pv };
  const c = contractFor(p, pv.fromSeason)!;
  const tid = p.teamId!;
  for (const [teamId, share] of shares(p, c))
    for (const [s, amt] of Object.entries(pv.capCharges))
      addCharge(league, { teamId, season: Number(s), amount: amt * share, kind: 'buyout', playerId: p.id, playerName: name(p), note: `Bought out ${league.season} (${Math.round(pv.ratio * 100)}% of remaining salary over ${Object.keys(pv.payments).length} seasons)${share < 1 ? `, ${Math.round(share * 100)}% share` : ''}` });
  const hist = p.contractHistory?.find((h) => h.startSeason === yearsOf(c)[0].season && h.teamId === (c.signingTeamId ?? h.teamId)) ?? p.contractHistory?.[p.contractHistory.length - 1];
  if (hist) hist.note = `${hist.note ? `${hist.note}; ` : ''}bought out by ${teamName(league, tid)} in ${league.season} (${fmtCap(pv.totalCost)} over ${Object.keys(pv.payments).length} seasons)`;
  p.contract = null;
  p.teamId = null;
  p.rightsTeamId = null;
  p.rfa = false;
  p.status = 'fa';
  p.ltir = false;
  const desc = `${teamName(league, tid)} buy out ${name(p)} (${fmtCap(pv.totalCost)} over ${Object.keys(pv.payments).length} seasons; cap savings ${fmtCap(pv.savings)})`;
  addTransaction(league, { kind: 'buyout', teamIds: [tid], playerIds: [p.id], description: desc });
  if (p.reputation >= 45 || tid === league.userTeamId) addNews(league, { category: 'signing', headline: desc, teamIds: [tid], playerIds: [p.id], importance: p.reputation >= 60 ? 3 : 2 });
  return { ok: true, errors: [], preview: pv };
}

// ───────────────────────────── LTIR ─────────────────────────────

/** Days left in the regular season plus a typical playoff run. */
function daysLeftInSeason(league: League): number {
  const last = league.schedule.filter((g) => !g.playoff).reduce((m, g) => Math.max(m, g.day), 0);
  return Math.max(0, last - league.day) + 60;
}

export function canPlaceOnLTIR(league: League, p: Player): { ok: boolean; reason: string; relief: number; explanation: string; seasonEnding: boolean } {
  const season = capSeason(league);
  const none = { relief: 0, explanation: '', seasonEnding: false };
  if (p.teamId === null || !p.contract) return { ok: false, reason: `${name(p)} is not under contract.`, ...none };
  if (p.ltir) return { ok: false, reason: `${name(p)} is already on LTIR.`, ...none };
  if (league.phase === 'playoffs') return { ok: false, reason: 'LTIR relief does not apply during the playoffs (2025 MOU playoff cap).', ...none };
  const el = ltirEligible(p, season);
  if (!el.eligible) return { ok: false, reason: el.reason, ...none };
  const sheet = teamCapSheet(league, p.teamId, season);
  const seasonEnding = (p.injury?.daysRemaining ?? 0) >= daysLeftInSeason(league);
  const capHit = holderCapHit(contractFor(p, season) ?? p.contract);
  const { relief, explanation } = calculateLTIRRelief(capHit, sheet.space, season, seasonEnding);
  return { ok: true, reason: el.reason, relief, explanation, seasonEnding };
}

export function placeOnLTIR(league: League, p: Player): { ok: boolean; message: string } {
  const chk = canPlaceOnLTIR(league, p);
  if (!chk.ok) return { ok: false, message: `LTIR placement rejected: ${chk.reason}` };
  const season = capSeason(league);
  league.ltir.push({ playerId: p.id, teamId: p.teamId!, season, day: league.day, relief: chk.relief, capHit: holderCapHit(p.contract!), seasonEnding: chk.seasonEnding });
  p.ltir = true;
  const msg = `${teamName(league, p.teamId)} place ${name(p)} on long-term injured reserve (relief ${fmtCap(chk.relief)}). ${chk.explanation}`;
  addTransaction(league, { kind: 'ltir', teamIds: [p.teamId!], playerIds: [p.id], description: msg });
  return { ok: true, message: msg };
}

/** Return a player from LTIR; the team must be cap compliant again (callers handle the roster move). */
export function activateFromLTIR(league: League, p: Player): { ok: boolean; message: string; overBy: number } {
  if (!p.ltir) return { ok: false, message: `${name(p)} is not on LTIR.`, overBy: 0 };
  league.ltir = league.ltir.filter((l) => l.playerId !== p.id);
  p.ltir = false;
  const tid = p.teamId;
  if (tid === null) return { ok: true, message: '', overBy: 0 };
  const sheet = teamCapSheet(league, tid);
  const overBy = Math.max(0, sheet.total - sheet.effectiveLimit);
  const msg = `${teamName(league, tid)} activate ${name(p)} from LTIR${overBy > 0 ? ` — now ${fmtCap(overBy)} over the cap and must clear space before he plays` : ''}`;
  addTransaction(league, { kind: 'ltirActivate', teamIds: [tid], playerIds: [p.id], description: msg });
  return { ok: true, message: msg, overBy };
}

/** Daily: healthy players come off LTIR; entries from past seasons are cleared. */
export function dailyLtir(league: League): Player[] {
  const back: Player[] = [];
  const season = capSeason(league);
  league.ltir = league.ltir.filter((l) => l.season >= season);
  for (const l of [...league.ltir]) {
    const p = league.players[l.playerId];
    if (!p || p.status === 'retired' || p.teamId !== l.teamId) {
      league.ltir = league.ltir.filter((x) => x !== l);
      if (p) p.ltir = false;
      continue;
    }
    if (!p.injury || p.injury.daysRemaining <= 0) {
      activateFromLTIR(league, p);
      back.push(p);
    }
  }
  return back;
}

// ───────────────────────────── performance bonuses ─────────────────────────────

/**
 * Share of a player's performance bonuses earned this season.
 * SIMPLIFICATION: real Schedule A / B bonuses are individually negotiated
 * targets; the game scores them from games played and production.
 */
export function earnedBonusFraction(league: League, p: Player, c: Contract): number {
  const s = league.seasonStats[p.id]?.reg;
  if (!s || s.gp === 0) return 0;
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  if (c.type !== 'ELC') return clamp01(s.gp / 60) * 0.85; // 35+ / veteran games-played bonuses
  if (p.pos === 'G') {
    const sv = s.sa ? (s.sa - s.ga) / s.sa : 0.88;
    return clamp01((sv - 0.895) / 0.025) * clamp01(s.gp / 30);
  }
  const ppg = (s.g + s.a1 + s.a2) / s.gp;
  return clamp01((ppg - (p.pos === 'D' ? 0.2 : 0.35)) / 0.5) * clamp01(s.gp / 41);
}

export interface BonusResult {
  teamId: number;
  earned: number;
  overage: number;
  players: { playerId: number; name: string; earned: number; max: number }[];
}

/**
 * End of season: performance bonuses are settled. Bonuses that push a team
 * past the upper limit (+ LTIR relief) are charged against next season's cap
 * (CBA 50.5(h), bonus cushion).
 */
export function settlePerformanceBonuses(league: League): BonusResult[] {
  const season = league.season;
  const out: BonusResult[] = [];
  for (const t of league.teams) {
    const sheet = teamCapSheet(league, t.id, season);
    const players: BonusResult['players'] = [];
    for (const row of sheet.rows) {
      if (row.perfBonus <= 0 || row.buried) continue;
      const p = league.players[row.playerId];
      const c = contractFor(p, season);
      if (!c) continue;
      const max = row.perfBonus * (1 - row.retainedPct);
      const earned = Math.round(max * earnedBonusFraction(league, p, c));
      if (earned > 0) players.push({ playerId: p.id, name: row.name, earned, max });
    }
    const earned = players.reduce((s, x) => s + x.earned, 0);
    const base = sheet.total - sheet.perfBonusPotential;
    const overage = Math.max(0, Math.round(base + earned - (sheet.upper + sheet.ltirRelief)));
    if (overage > 0)
      addCharge(league, { teamId: t.id, season: season + 1, amount: overage, kind: 'bonusOverage', playerName: players.map((x) => x.name).join(', ') || 'Performance bonuses', note: `${season}-${(season + 1) % 100} performance bonuses: ${fmtCap(earned)} earned, ${fmtCap(overage)} over the cap carried into ${season + 1}-${(season + 2) % 100}` });
    if (t.id === league.userTeamId && earned > 0)
      addNews(league, { category: 'signing', headline: `Performance bonuses settled: ${fmtCap(earned)} earned${overage > 0 ? `, ${fmtCap(overage)} bonus overage charged to next season's cap` : ''}`, teamIds: [t.id], playerIds: players.map((x) => x.playerId), importance: 2 });
    out.push({ teamId: t.id, earned, overage, players });
  }
  return out;
}

// ───────────────────────────── 35+ contracts ─────────────────────────────

/**
 * A 35+ contract stays on the cap if the player retires (or is otherwise off
 * the roster) before it ends (CBA 50.5(d)(i)(B)(4)). Called before the
 * contract is removed; charges every remaining season after `lastSeasonPlayed`.
 */
export function thirtyFivePlusRetirement(league: League, p: Player, lastSeasonPlayed: number): number {
  let total = 0;
  for (const c of [p.contract, p.contract?.next].filter((x): x is Contract => !!x)) {
    if (!c.thirtyFivePlus) continue;
    const hit = fullCapHit(c);
    for (const y of yearsOf(c)) {
      if (y.season <= lastSeasonPlayed) continue;
      for (const [teamId, share] of shares(p, c)) {
        addCharge(league, { teamId, season: y.season, amount: hit * share, kind: 'thirtyFivePlus', playerId: p.id, playerName: name(p), note: `35+ contract: cap hit remains after retirement` });
        total += hit * share;
      }
    }
  }
  return total;
}

// ───────────────────────────── ELC slide ─────────────────────────────

/**
 * ELC slide (CBA 9.1(d)): an 18- or 19-year-old (age at Sept 15) who plays
 * fewer than 10 NHL games has his entry-level contract extended by a year.
 */
export function applyElcSlides(league: League, finishedSeason: number): Player[] {
  const rule = STATIC().elcSlide;
  const slid: Player[] = [];
  for (const p of Object.values(league.players)) {
    const c = p.contract;
    if (!c || c.type !== 'ELC' || p.status === 'retired' || !yearIn(c, finishedSeason)) continue;
    if (!rule.ages.includes(ageSept15(p, finishedSeason))) continue;
    if (nhlGamesIn(p, finishedSeason, finishedSeason, league) > rule.maxNhlGames) continue;
    for (const y of yearsOf(c)) if (y.season >= finishedSeason) y.season += 1;
    c.slid = (c.slid ?? 0) + 1;
    refreshContract(c, finishedSeason);
    slid.push(p);
  }
  return slid;
}

// ───────────────────────────── playoff cap ─────────────────────────────

function replaceInLines(lines: Lines, from: number, to: number): Lines {
  const sw = (ids: number[]) => ids.map((id) => (id === from ? to : id));
  return { fwd: lines.fwd.map(sw), def: lines.def.map(sw), goalies: sw(lines.goalies), pp: lines.pp.map(sw), pk: lines.pk.map(sw) };
}

/**
 * Playoff cap check for a lineup. If illegal, the most expensive skaters are
 * scratched for the cheapest healthy players of the same position group
 * until it complies. Returns the (possibly) adjusted lines and explanations.
 */
export function enforcePlayoffCap(league: League, teamId: number, lines: Lines, dressedOf: (l: Lines) => number[]): { lines: Lines; ok: boolean; changes: string[]; errors: string[] } {
  const deadCap = teamCapSheet(league, teamId, league.season).deadCap;
  let check = validatePlayoffRoster(league, teamId, dressedOf(lines), deadCap);
  if (!check.applies || check.ok) return { lines, ok: true, changes: [], errors: [] };
  const errors = [...check.errors];
  const changes: string[] = [];
  const grp = (p: Player) => (p.pos === 'G' ? 'G' : p.pos === 'D' ? 'D' : isForward(p.pos) ? 'F' : 'F');
  const hit = (p: Player) => (p.contract ? holderCapHit(p.contract) : 0);
  for (let guard = 0; guard < 12 && !check.ok; guard++) {
    const dressed = dressedOf(lines).map((id) => league.players[id]).filter((p) => p && p.pos !== 'G');
    const scratches = Object.values(league.players).filter((p) => p.teamId === teamId && p.status === 'active' && p.pos !== 'G' && (!p.injury || p.injury.daysRemaining <= 0) && !dressedOf(lines).includes(p.id));
    let best: { out: Player; inn: Player; save: number } | null = null;
    for (const out of dressed)
      for (const inn of scratches) {
        if (grp(inn) !== grp(out)) continue;
        const save = hit(out) - hit(inn);
        if (save > 0 && (!best || save > best.save)) best = { out, inn, save };
      }
    if (!best) break;
    lines = replaceInLines(lines, best.out.id, best.inn.id);
    changes.push(`${name(best.out)} (${fmtCap(hit(best.out))}) scratched for ${name(best.inn)} (${fmtCap(hit(best.inn))})`);
    check = validatePlayoffRoster(league, teamId, dressedOf(lines), deadCap);
  }
  return { lines, ok: check.ok, changes, errors: check.ok ? errors : check.errors };
}

/** Cap ledger entries for seasons that are over are pruned to keep saves small. */
export function pruneLedger(league: League): void {
  const keepFrom = league.season - 1;
  league.capLedger = league.capLedger.filter((c) => c.season >= keepFrom);
}

export { rulesFor };
