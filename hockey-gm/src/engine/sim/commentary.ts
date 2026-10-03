/**
 * Play-by-play text generated strictly from structured engine events.
 * Template choice is a deterministic function of the event, so the same game
 * always reads the same way.
 */
import type { GameEvent } from './gameTypes';

export interface CommentaryContext {
  name: (id: number | undefined) => string;
  team: (side: 0 | 1) => string;
}

export interface CommentaryLine {
  t: number;
  period: number;
  clock: number;
  text: string;
  kind: 'goal' | 'shot' | 'save' | 'penalty' | 'info' | 'hit' | 'injury' | 'big';
  team: 0 | 1;
}

function pick<T>(arr: T[], e: GameEvent): T {
  const h = Math.floor(e.t * 7 + (e.p1 ?? 0) * 13 + (e.p2 ?? 0) * 3);
  return arr[Math.abs(h) % arr.length];
}

const SHOT_WORDS: Record<string, string[]> = {
  wrist: ['wrist shot', 'quick wrister', 'wrist shot'],
  snap: ['snapshot', 'quick snapper'],
  slap: ['slap shot', 'blast from the point', 'one-knee slapper'],
  backhand: ['backhand', 'backhander'],
  oneTimer: ['one-timer', 'one-time blast'],
  tip: ['deflection', 'tip in front'],
  wraparound: ['wraparound attempt'],
  rebound: ['rebound chance', 'second-chance shot'],
};

export function periodLabel(p: number, playoff = false): string {
  if (p <= 3) return ['1st', '2nd', '3rd'][p - 1];
  if (!playoff) return 'OT';
  return p === 4 ? 'OT' : `${p - 3}OT`;
}

export function clockLabel(clock: number, periodLength: number): string {
  const rem = Math.max(0, periodLength - clock);
  const m = Math.floor(rem / 60);
  const s = Math.floor(rem % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function describe(e: GameEvent, c: CommentaryContext): CommentaryLine | null {
  const n1 = c.name(e.p1);
  const n2 = c.name(e.p2);
  const tm = c.team(e.team);
  const base = { t: e.t, period: e.period, clock: e.clock, team: e.team };
  const d = e.data ?? {};
  switch (e.type) {
    case 'periodStart':
      return { ...base, kind: 'info', text: e.period === 1 ? 'The puck is dropped and we are under way!' : e.period > 3 ? 'Overtime is under way — next goal wins!' : `Start of the ${periodLabel(e.period)} period.` };
    case 'periodEnd':
      return { ...base, kind: 'info', text: `End of the ${periodLabel(e.period)} period.` };
    case 'faceoff':
      return d.zone === 'O' ? { ...base, kind: 'info', text: `${n1} wins the offensive-zone draw for ${tm}.` } : null;
    case 'entry':
      if (d.oddMan) return { ...base, kind: 'big', text: pick([`${n1} leads an odd-man rush for ${tm}!`, `${tm} break out on a 2-on-1, ${n1} carrying!`, `${n1} has numbers going the other way!`], e) };
      return { ...base, kind: 'info', text: pick([`${n1} carries the puck into the offensive zone.`, `${n1} gains the blue line with speed.`, `${n1} skates it in over the line.`], e) };
    case 'dumpIn':
      return { ...base, kind: 'info', text: pick([`${n1} dumps it in deep.`, `${n1} chips it in behind the defence.`, `${n1} rims it around the boards.`], e) };
    case 'battle':
      return { ...base, kind: 'info', text: pick([`${n1} wins the puck battle along the boards.`, `${n1} outmuscles ${n2} to the loose puck.`], e) };
    case 'pass':
      if (d.big) return { ...base, kind: 'info', text: pick([`${n1} finds ${n2} wide open across the slot!`, `Cross-ice feed from ${n1} to ${n2}!`], e) };
      return null;
    case 'shot': {
      if (d.en) return { ...base, kind: 'shot', text: `${n1} fires at the empty net...` };
      const w = pick(SHOT_WORDS[d.shotType ?? 'wrist'] ?? ['shot'], e);
      if (d.danger === 'high') return { ...base, kind: 'shot', text: pick([`${n1} finds space in the slot — ${w}!`, `${n1} in tight — ${w}!`, `SHOT! ${n1} from close range!`], e) };
      if (d.danger === 'low') return { ...base, kind: 'shot', text: pick([`${n1} with a ${w} from the point.`, `${n1} lets one go from distance.`], e) };
      return { ...base, kind: 'shot', text: pick([`${n1} with a ${w}.`, `SHOT! ${n1} from the circle.`, `${n1} lets go a ${w}.`], e) };
    }
    case 'save':
      if (d.big) return { ...base, kind: 'save', text: pick([`What a save by ${n1}!`, `${n1} robs ${n2}!`, `Huge stop by ${n1}!`, `${n1} flashes the leather!`], e) };
      return { ...base, kind: 'save', text: pick([`Saved by ${n1}.`, `${n1} makes the save.`, `${n1} turns it aside.`, `Kicked out by ${n1}.`], e) };
    case 'rebound':
      return { ...base, kind: 'big', text: 'Rebound!' };
    case 'freeze':
      return { ...base, kind: 'info', text: `${n1} covers up for the whistle.` };
    case 'blocked':
      return { ...base, kind: 'info', text: pick([`${n1} blocks the shot from ${n2}.`, `${n2}'s shot is blocked by ${n1}.`, `${n1} gets in the lane to block it.`], e) };
    case 'missed':
      if (d.en) return { ...base, kind: 'info', text: `${n1} misses the empty net!` };
      return { ...base, kind: 'info', text: pick([`${n1} misses the net.`, `${n1} fires wide.`, `${n1}'s shot sails high.`], e) };
    case 'goal': {
      const a = d.assists ?? [];
      const asst = a.length ? ` Assisted by ${a.map((id) => c.name(id)).join(' and ')}.` : ' Unassisted.';
      const str = d.strength === 'PP' ? ' Power-play goal!' : d.strength === 'SH' ? ' Shorthanded!' : d.strength === 'EN' ? ' Into the empty net.' : '';
      const score = d.score ? ` ${c.team(0)} ${d.score[0]} – ${d.score[1]} ${c.team(1)}` : '';
      return { ...base, kind: 'goal', text: `GOAL! ${n1} scores for ${tm}!${str}${asst}${score}` };
    }
    case 'hit':
      return { ...base, kind: 'hit', text: pick([`${n1} lays a big hit on ${n2}!`, `${n1} finishes the check on ${n2}.`, `Thunderous hit by ${n1}!`], e) };
    case 'takeaway':
      return { ...base, kind: 'info', text: pick([`${n1} strips ${n2} of the puck.`, `Takeaway by ${n1}.`], e) };
    case 'giveaway':
      return { ...base, kind: 'info', text: pick([`${n1} turns it over.`, `Giveaway by ${n1}.`], e) };
    case 'icing':
      return { ...base, kind: 'info', text: `Icing on ${tm}.` };
    case 'offside':
      return { ...base, kind: 'info', text: `${n1} is offside.` };
    case 'clear':
      return null;
    case 'penalty':
      return { ...base, kind: 'penalty', text: `PENALTY: ${n1} (${tm}), ${d.minutes} minutes for ${d.penalty?.toLowerCase()}.` };
    case 'fight':
      return { ...base, kind: 'penalty', text: `FIGHT! ${n1} and ${n2} drop the gloves! Five minutes each for fighting.` };
    case 'ppEnd':
      return d.success ? { ...base, kind: 'info', text: `${tm} kill off the penalty.` } : null;
    case 'injury':
      return { ...base, kind: 'injury', text: d.success ? `${n1} is hurt and heads to the room (${d.injury}).` : `${n1} is slow to get up but stays in the game.` };
    case 'lineChange':
      return {
        ...base,
        kind: 'info',
        text: d.unit?.startsWith('PP') ? `${tm} send out the power-play unit.` : d.unit?.startsWith('PK') ? `${tm} change penalty killers.` : `${tm} change lines.`,
      };
    case 'goaliePulled':
      return { ...base, kind: 'big', text: `${tm} pull ${n1} for the extra attacker!` };
    case 'goalieReturn':
      return { ...base, kind: 'info', text: `${n1} returns to the ${tm} net.` };
    case 'goalieChange':
      return { ...base, kind: 'info', text: `${tm} make a goaltending change: ${n1} replaces ${n2}.` };
    case 'shootout':
      return { ...base, kind: d.success ? 'goal' : 'save', text: d.success ? `Shootout round ${d.round}: ${n1} SCORES on ${n2}!` : `Shootout round ${d.round}: ${n1} is stopped by ${n2}.` };
    case 'gameEnd':
      return { ...base, kind: 'info', text: `Final: ${c.team(0)} ${d.score?.[0]} – ${d.score?.[1]} ${c.team(1)}.` };
    default:
      return null;
  }
}
