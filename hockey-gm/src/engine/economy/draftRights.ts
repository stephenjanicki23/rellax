/**
 * Unsigned draft picks (CBA 8.6). A club holds a drafted player's rights
 * without a contract until his sign-by date (two years for junior players,
 * longer for college and European players); unsigned rights then lapse and
 * he becomes a free agent. Unsigned picks don't count against the 50-contract
 * limit, can't play in the NHL and can be traded.
 */
import type { League, Player } from '../types';
import { addNews, addTransaction, isCpu, playersOf, teamName } from '../league/helpers';
import { capSeason, teamCapSheet } from '../cba/capManager';
import { rulesFor } from '../cba/rules';
import { fullName } from '../player/ability';
import { signDraftedElc } from './draft';

export interface RightsResult {
  ok: boolean;
  message: string;
}

export function isUnsignedPick(p: Player): boolean {
  return p.status === 'prospect' && !p.contract && p.rightsTeamId !== null && p.teamId !== null;
}

export function unsignedPicks(league: League, teamId: number): Player[] {
  return playersOf(league, teamId, ['prospect']).filter(isUnsignedPick);
}

/** Season-year label for a sign-by deadline ("June 1, 2028"). */
export function signByLabel(p: Player): string {
  return p.signBySeason === undefined ? '—' : `June 1, ${p.signBySeason + 1}`;
}

function contractCount(league: League, teamId: number): number {
  return teamCapSheet(league, teamId).rows.length;
}

/**
 * Sign an unsigned pick to his entry-level contract. In the offseason
 * (draft through free agency) the deal starts next season; during the season
 * it starts immediately and burns a year.
 */
export function signDraftPick(league: League, p: Player): RightsResult {
  if (!isUnsignedPick(p)) return { ok: false, message: `${fullName(p)} is not an unsigned draft pick.` };
  const teamId = p.rightsTeamId!;
  const limit = rulesFor(capSeason(league)).contractLimit;
  if (contractCount(league, teamId) >= limit) return { ok: false, message: `${teamName(league, teamId)} already have ${limit} contracts — make room before signing ${fullName(p)}.` };
  const start = league.phase === 'draft' ? league.season + 1 : capSeason(league);
  signDraftedElc(league, p, teamId, p.draft?.pick || 60, start);
  addTransaction(league, { kind: 'elc', teamIds: [teamId], playerIds: [p.id], description: `${teamName(league, teamId)} sign draft pick ${fullName(p)} (${p.pos}) to an entry-level contract` });
  return { ok: true, message: `${fullName(p)} signs his entry-level contract.` };
}

/**
 * Should a CPU club sign this pick now? Top prospects sign as soon as they are
 * ready, others when they've developed or their deadline arrives (if they
 * still project as NHL players).
 */
function cpuWantsToSign(league: League, p: Player): boolean {
  const age = league.season + 1 - p.birthYear;
  const deadline = p.signBySeason !== undefined && p.signBySeason <= league.season;
  if (deadline) return p.pa >= 130 || p.ca >= 110;
  if (age >= 19 && p.pa >= 165) return true;
  if (age >= 20 && (p.pa >= 152 || p.ca >= 116)) return true;
  return age >= 22 && (p.pa >= 140 || p.ca >= 114);
}

/** CPU clubs (and the user's, when it is AI-managed or `includeUser`) sign the picks they want, best first, within the contract limit. */
export function aiSignDraftPicks(league: League, includeUser = false): number {
  let signed = 0;
  const limit = rulesFor(capSeason(league)).contractLimit;
  for (const t of league.teams) {
    if (!isCpu(league, t.id) && !includeUser) continue;
    const picks = unsignedPicks(league, t.id).sort((a, b) => b.pa - a.pa);
    let count = contractCount(league, t.id);
    for (const p of picks) {
      if (count >= limit - 1) break;
      if (!cpuWantsToSign(league, p)) continue;
      if (signDraftPick(league, p).ok) {
        signed++;
        count++;
      }
    }
  }
  return signed;
}

/** Remind the user which picks must be signed before their rights lapse this summer. */
export function warnExpiringRights(league: League): void {
  const due = unsignedPicks(league, league.userTeamId).filter((p) => p.signBySeason !== undefined && p.signBySeason <= league.season);
  if (!due.length) return;
  addNews(league, {
    category: 'signing',
    headline: `${due.length} unsigned draft pick${due.length === 1 ? '' : 's'} must be signed before free agency or the rights are lost: ${due.map((p) => fullName(p)).join(', ')}`,
    teamIds: [league.userTeamId],
    playerIds: due.map((p) => p.id),
    importance: 3,
  });
}

/** Sign-by date passed: unsigned rights lapse and the player becomes a free agent. */
export function lapseDraftRights(league: League): number {
  let lapsed = 0;
  for (const p of Object.values(league.players)) {
    if (!isUnsignedPick(p) || p.signBySeason === undefined || p.signBySeason > league.season) continue;
    const tid = p.rightsTeamId!;
    p.status = 'fa';
    p.teamId = null;
    p.rightsTeamId = null;
    delete p.signBySeason;
    lapsed++;
    addTransaction(league, { kind: 'release', teamIds: [tid], playerIds: [p.id], description: `${teamName(league, tid)} lose the rights to unsigned draft pick ${fullName(p)}; he becomes a free agent` });
    if (tid === league.userTeamId) addNews(league, { category: 'signing', headline: `You did not sign ${fullName(p)} — his rights have lapsed and he is now a free agent`, teamIds: [tid], playerIds: [p.id], importance: 2 });
  }
  return lapsed;
}
