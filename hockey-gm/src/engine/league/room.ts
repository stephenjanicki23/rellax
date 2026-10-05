/**
 * The dressing room: players' roles (what they expect vs what they get),
 * promises from the GM, trade requests and one-on-one meetings.
 *
 * Roles come from the lines the coach (or GM) sets: first line, top six,
 * middle six, fourth line, scratched; defence pairs; starter and backup.
 * A player expects a role from where he ranks on his own team, nudged by his
 * personality and standing.
 */
import { clamp } from '../core/math';
import type { League, Player, PlayerPromise, PromiseKind } from '../types';
import { PERSONALITIES } from '../player/personality';
import { addNews, playersOf, teamName } from './helpers';
import { fullName } from '../player/ability';

/** Role tiers: 0 = top (1st line / top pair / starter) … 3 = 4th line, 4 = out of the lineup. */
export type RoleTier = 0 | 1 | 2 | 3 | 4;

const F_LABEL = ['First line', 'Top six', 'Third line', 'Fourth line', 'Scratched'];
const D_LABEL = ['Top pair', 'Second pair', 'Third pair', 'Third pair', 'Scratched'];
const G_LABEL = ['Starter', 'Starter', 'Backup', 'Backup', 'Third goalie'];

export function roleLabel(p: Pick<Player, 'pos'> & { injury?: Player['injury'] }, tier: RoleTier, actual = false): string {
  if (actual && p.injury) return 'Injured';
  return (p.pos === 'G' ? G_LABEL : p.pos === 'D' ? D_LABEL : F_LABEL)[tier];
}

/** Current role from the team's lines. */
export function actualRole(league: League, p: Player): RoleTier {
  if (p.teamId === null) return 4;
  const lines = league.teams[p.teamId].lines;
  if (p.pos === 'G') return lines.goalies[0] === p.id ? 0 : lines.goalies[1] === p.id ? 2 : 4;
  if (p.pos === 'D') {
    const i = lines.def.findIndex((pair) => pair.includes(p.id));
    return (i < 0 ? 4 : i) as RoleTier;
  }
  const i = lines.fwd.findIndex((l) => l.includes(p.id));
  return (i < 0 ? 4 : i) as RoleTier;
}

/** The role a player believes he has earned. */
export function expectedRole(league: League, p: Player): RoleTier {
  if (p.teamId === null) return 4;
  const group = playersOf(league, p.teamId).filter((x) => (p.pos === 'G' ? x.pos === 'G' : p.pos === 'D' ? x.pos === 'D' : x.pos !== 'G' && x.pos !== 'D'));
  const rank = group.filter((x) => x.ca > p.ca).length;
  let tier: number;
  if (p.pos === 'G') tier = rank === 0 ? 0 : rank === 1 ? 2 : 4;
  else if (p.pos === 'D') tier = rank < 2 ? 0 : rank < 4 ? 1 : rank < 6 ? 2 : 4;
  else tier = rank < 3 ? 0 : rank < 6 ? 1 : rank < 9 ? 2 : rank < 12 ? 3 : 4;
  // Ambitious and difficult players think they deserve more; team players accept less.
  if ((p.personality === 'ambitious' || p.personality === 'difficult') && tier > 0 && tier < 4) tier--;
  if ((p.personality === 'teamPlayer' || p.personality === 'easygoing') && tier < 3) tier += 0.5;
  // Established veterans expect to play.
  if (p.reputation >= 70 && tier > 1 && tier < 4) tier--;
  return clamp(Math.floor(tier), 0, 4) as RoleTier;
}

/** Morale effect of role: playing above expectations helps a little, below hurts more. */
export function roleScore(league: League, p: Player): number {
  // Injured players don't hold their absence from the lineup against anyone.
  if (p.injury) return 0;
  const exp = expectedRole(league, p);
  const act = actualRole(league, p);
  const pers = PERSONALITIES[p.personality];
  // Goalie tiers jump 0 → 2, so one step down for a goalie is a full demotion.
  const diff = exp - act;
  let s = diff >= 0 ? Math.min(8, diff * 4) : Math.max(-22, diff * (p.pos === 'G' ? 5 : 7));
  if (act === 4 && exp < 4) s = Math.min(s, -18);
  return s * pers.role;
}

// ── Promises ────────────────────────────────────────────────────────────

export const PROMISE_LABEL: Record<PromiseKind, string> = {
  role: 'A bigger role',
  pp: 'Power-play time',
  noTrade: "He won't be traded this season",
  extension: 'A contract extension before the season ends',
};

const PROMISE_WEEKS = 10;
const KEEP_SHARE = 0.7;

function seasonEndDay(league: League): number {
  return league.schedule.reduce((m, g) => (g.playoff ? m : Math.max(m, g.day)), 0);
}

/** The role a "bigger role" promise commits to: one tier above his current one (top-six/top-four/starter at most). */
function promisedTier(p: Player, current: RoleTier): RoleTier {
  if (p.pos === 'G') return 0;
  return Math.max(0, Math.min(current, 4) - 1) as RoleTier;
}

export function promiseRefusal(league: League, p: Player, kind: PromiseKind): string | null {
  if (league.phase !== 'regular' && league.phase !== 'preseason') return 'Promises are made during the season.';
  if (p.teamId !== league.userTeamId) return 'He is not on your team.';
  if ((p.promises ?? []).some((x) => x.status === 'open' && x.kind === kind)) return 'You have already promised him that.';
  if ((p.trust ?? 60) < 25) return `${fullName(p)} doesn't believe your promises any more.`;
  if (kind === 'extension' && (!p.contract || p.contract.years > 1 || p.contract.next)) return 'Only players in the last year of their contract.';
  if (kind === 'role' && actualRole(league, p) === 0) return 'He already has a top role.';
  if (kind === 'pp' && p.pos === 'G') return 'Goalies do not play on the power play.';
  return null;
}

export function makePromise(league: League, p: Player, kind: PromiseKind): { ok: boolean; message: string } {
  const no = promiseRefusal(league, p, kind);
  if (no) return { ok: false, message: no };
  const end = seasonEndDay(league);
  const due = kind === 'role' || kind === 'pp' ? Math.min(end, league.day + PROMISE_WEEKS * 7) : end;
  const pr: PlayerPromise = { kind, season: league.season, day: league.day, dueDay: due, ok: 0, total: 0, status: 'open' };
  if (kind === 'role') pr.tier = promisedTier(p, actualRole(league, p));
  p.promises = [...(p.promises ?? []), pr];
  // A promise buys some goodwill straight away (more from players who trust the GM).
  p.morale = clamp(p.morale + 4 + ((p.trust ?? 60) - 50) / 10, 0, 100);
  if (p.tradeRequest && !p.tradeRequest.public) p.tradeRequest = undefined;
  return { ok: true, message: `${fullName(p)} takes you at your word: ${PROMISE_LABEL[kind].toLowerCase()}.` };
}

function promiseHonouredNow(league: League, p: Player, pr: PlayerPromise): boolean {
  const team = p.teamId !== null ? league.teams[p.teamId] : null;
  if (!team) return false;
  if (pr.kind === 'role') return actualRole(league, p) <= (pr.tier ?? 1);
  if (pr.kind === 'pp') return team.lines.pp.some((u) => u.includes(p.id));
  return true;
}

function settle(league: League, p: Player, pr: PlayerPromise, kept: boolean): void {
  pr.status = kept ? 'kept' : 'broken';
  p.trust = clamp((p.trust ?? 60) + (kept ? 12 : -30), 0, 100);
  p.morale = clamp(p.morale + (kept ? 8 : -22), 0, 100);
  if (p.teamId === league.userTeamId || (!kept && pr.kind === 'noTrade')) {
    addNews(league, {
      category: 'room',
      headline: kept ? `${fullName(p)} appreciates that the GM kept his word (${PROMISE_LABEL[pr.kind].toLowerCase()})` : `${fullName(p)} feels let down: a promise from the GM was broken (${PROMISE_LABEL[pr.kind].toLowerCase()})`,
      teamIds: [p.teamId ?? league.userTeamId],
      playerIds: [p.id],
      importance: kept ? 1 : 3,
    });
  }
  // The room notices broken promises.
  if (!kept && p.teamId !== null) for (const t of playersOf(league, p.teamId)) if (t.id !== p.id) t.trust = clamp((t.trust ?? 60) - 4, 0, 100);
}

/** Weekly: track and settle promises. */
export function reviewPromises(league: League): void {
  for (const p of Object.values(league.players)) {
    if (!p.promises?.length) continue;
    for (const pr of p.promises) {
      if (pr.status !== 'open') continue;
      if (pr.season !== league.season) {
        settle(league, p, pr, pr.kind === 'noTrade');
        continue;
      }
      if (pr.kind === 'role' || pr.kind === 'pp') {
        pr.total++;
        if (promiseHonouredNow(league, p, pr)) pr.ok++;
      }
      if (pr.kind === 'extension' && p.contract && (p.contract.next || p.contract.years > 1)) {
        settle(league, p, pr, true);
        continue;
      }
      if (league.day >= pr.dueDay || league.phase !== 'regular') {
        const kept = pr.kind === 'role' || pr.kind === 'pp' ? pr.total > 0 && pr.ok / pr.total >= KEEP_SHARE : pr.kind === 'noTrade';
        settle(league, p, pr, kept);
      }
    }
  }
}

/** Morale lift from promises currently being honoured (and the sting of recent broken ones). */
export function promiseScore(league: League, p: Player): number {
  let s = 0;
  for (const pr of p.promises ?? []) {
    if (pr.season !== league.season) continue;
    if (pr.status === 'open') s += promiseHonouredNow(league, p, pr) ? 4 : -3;
    else if (pr.status === 'broken') s -= 8;
  }
  return s;
}

/** Called when a player is traded: a no-trade promise is broken. */
export function onPlayerTraded(league: League, p: Player): void {
  for (const pr of p.promises ?? []) if (pr.status === 'open') settle(league, p, pr, false);
  // A traded player starts fresh with his new club.
  p.tradeRequest = undefined;
  p.unhappyWeeks = 0;
  p.promises = (p.promises ?? []).filter((x) => x.status !== 'open');
}

// ── Trade requests ──────────────────────────────────────────────────────

const REQUEST_AFTER_WEEKS = 3;
const PUBLIC_AFTER_DAYS = 28;

export function topConcern(p: Player): string {
  const m = p.moraleParts;
  if (!m) return '—';
  const items: [string, number][] = [
    ['his role', m.role],
    ['losing', m.winning],
    ['his contract', m.contract],
    ['broken promises', m.promises],
    ['the coach', m.coach],
    ['the room', m.room],
  ];
  const worst = items.sort((a, b) => a[1] - b[1])[0];
  return worst[1] < -6 ? `Unhappy with ${worst[0]}` : p.morale >= 70 ? 'Happy' : 'Content';
}

/** Weekly: unhappy players ask out; requests go public if they sit; happy players withdraw them. */
export function reviewTradeRequests(league: League, p: Player): void {
  if (p.teamId === null || league.phase !== 'regular') return;
  const pers = PERSONALITIES[p.personality];
  p.unhappyWeeks = p.morale < 36 ? (p.unhappyWeeks ?? 0) + 1 : Math.max(0, (p.unhappyWeeks ?? 0) - 1);
  const tr = p.tradeRequest;
  if (tr) {
    if (p.morale >= 50) {
      p.tradeRequest = undefined;
      if (p.teamId === league.userTeamId) addNews(league, { category: 'room', headline: `${fullName(p)} has withdrawn his trade request`, teamIds: [p.teamId], playerIds: [p.id], importance: 2 });
      return;
    }
    if (!tr.public && league.day - tr.since >= PUBLIC_AFTER_DAYS) {
      tr.public = true;
      addNews(league, { category: 'rumor', headline: `${fullName(p)} has asked the ${teamName(league, p.teamId)} for a trade`, body: tr.reason, teamIds: [p.teamId], playerIds: [p.id], importance: 3 });
    }
    return;
  }
  if ((p.unhappyWeeks ?? 0) < REQUEST_AFTER_WEEKS) return;
  // Regulars and better ask out; fringe players mostly grumble.
  const weight = pers.tradeRequest * (p.ca >= 130 ? 1 : 0.4) * 0.45;
  const roll = ((p.id * 7919 + league.day * 104729) % 1000) / 1000;
  if (roll > weight) return;
  const reason = topConcern(p).replace('Unhappy with', 'He is unhappy with');
  const user = p.teamId === league.userTeamId;
  p.tradeRequest = { season: league.season, day: league.day, reason, public: !user, since: league.day };
  addNews(league, {
    category: user ? 'room' : 'rumor',
    headline: user ? `${fullName(p)} has privately asked you for a trade` : `${fullName(p)} has asked the ${teamName(league, p.teamId)} for a trade`,
    body: reason,
    teamIds: [p.teamId],
    playerIds: [p.id],
    importance: 3,
  });
}

/** Refuse a trade request: he stays, and he's not happy about it. */
export function denyTradeRequest(league: League, p: Player): string {
  if (!p.tradeRequest) return 'He has not asked for a trade.';
  p.trust = clamp((p.trust ?? 60) - 10, 0, 100);
  p.morale = clamp(p.morale - 6, 0, 100);
  p.tradeRequest.since = Math.min(p.tradeRequest.since, league.day - 14);
  return `You told ${fullName(p)} he isn't going anywhere. He's not happy about it.`;
}

// ── Meetings ────────────────────────────────────────────────────────────

export const MEETING_COOLDOWN = 14;

export function meetingCooldown(league: League, p: Player): number {
  const m = p.meetings;
  if (!m || m.season !== league.season) return 0;
  return Math.max(0, MEETING_COOLDOWN - (league.day - m.day));
}

/**
 * One-on-one with the GM. Reassurance helps most players a little (less each
 * time); challenging him fires up competitors and professionals but rubs
 * sensitive and difficult players the wrong way.
 */
export function holdMeeting(league: League, p: Player, approach: 'reassure' | 'challenge'): { ok: boolean; message: string; delta: number } {
  if (p.teamId !== league.userTeamId) return { ok: false, message: 'He is not on your team.', delta: 0 };
  const wait = meetingCooldown(league, p);
  if (wait) return { ok: false, message: `You met with him recently. Give it ${wait} more day${wait === 1 ? '' : 's'}.`, delta: 0 };
  const count = p.meetings?.season === league.season ? p.meetings.count : 0;
  const trust = p.trust ?? 60;
  let delta: number;
  let message: string;
  if (approach === 'reassure') {
    delta = Math.round(clamp((6 + (trust - 50) / 8) / (1 + count * 0.5), 0, 10));
    message = delta >= 4 ? `${fullName(p)} appreciated the talk.` : delta > 0 ? `${fullName(p)} listened, but he has heard it before.` : `${fullName(p)} shrugged it off. Words aren't enough any more.`;
  } else {
    const responds = ['professional', 'driven', 'competitive', 'leader'].includes(p.personality);
    const bristles = ['difficult', 'ambitious', 'easygoing'].includes(p.personality);
    delta = responds ? 7 : bristles ? -9 : 1;
    if (responds) p.form = clamp(p.form + 0.15, -1, 1);
    message = responds ? `${fullName(p)} took the challenge to heart. Expect a response on the ice.` : bristles ? `${fullName(p)} didn't take it well.` : `${fullName(p)} nodded and went back to work.`;
    if (bristles) p.trust = clamp(trust - 5, 0, 100);
  }
  p.morale = clamp(p.morale + delta, 0, 100);
  p.meetings = { season: league.season, day: league.day, count: count + 1 };
  return { ok: true, message, delta };
}

/**
 * When the coach builds the lines (auto lines), he honours the GM's open role
 * and power-play promises: a promised player swaps in for the weakest player
 * in the promised spot.
 */
export function honourPromisesInLines(league: League, teamId: number): void {
  const team = league.teams[teamId];
  const L = team.lines;
  const ca = (id: number) => league.players[id]?.ca ?? 0;
  for (const p of playersOf(league, teamId)) {
    for (const pr of p.promises ?? []) {
      if (pr.status !== 'open' || pr.season !== league.season) continue;
      if (pr.kind === 'role') {
        const tier = pr.tier ?? 1;
        if (p.pos === 'G') {
          if (L.goalies[0] !== p.id) L.goalies = [p.id, ...L.goalies.filter((g) => g !== p.id)].slice(0, 2);
          continue;
        }
        const groups = p.pos === 'D' ? L.def : L.fwd;
        const cur = groups.findIndex((g) => g.includes(p.id));
        if (cur >= 0 && cur <= tier) continue;
        // Weakest player at or above the promised line, not himself promised a spot.
        let best: { line: number; slot: number } | null = null;
        for (let li = 0; li <= tier && li < groups.length; li++)
          groups[li].forEach((id, slot) => {
            const promised = league.players[id]?.promises?.some((x) => x.status === 'open' && x.kind === 'role');
            if (!promised && (!best || ca(id) < ca(groups[best.line][best.slot]))) best = { line: li, slot };
          });
        if (!best) continue;
        const b = best as { line: number; slot: number };
        const out = groups[b.line][b.slot];
        groups[b.line][b.slot] = p.id;
        if (cur >= 0) groups[cur][groups[cur].indexOf(p.id)] = out;
      } else if (pr.kind === 'pp' && p.pos !== 'G' && !L.pp.some((u) => u.includes(p.id)) && L.pp.length) {
        const unit = L.pp[L.pp.length - 1];
        let worst = 0;
        unit.forEach((id, i) => {
          if (ca(id) < ca(unit[worst])) worst = i;
        });
        if (unit.length) unit[worst] = p.id;
      }
    }
  }
}
