/**
 * Trade deadline: a running feed of the deals, rumours and calls in the two
 * weeks before the deadline, with times on deadline day itself.
 */
import type { DeadlineEvent, League } from '../types';

export const DEADLINE_WINDOW = 14;

export function daysToDeadline(league: League): number {
  return league.phase === 'regular' ? league.tradeDeadlineDay - league.day : -1;
}

export function inDeadlineWindow(league: League): boolean {
  const d = daysToDeadline(league);
  return d >= 0 && d <= DEADLINE_WINDOW;
}

/** Deadline-day clock: events through the day, from 9:00 AM to the 3:00 PM ET close. */
function clockFor(n: number): string {
  const minutes = Math.min(9 * 60 + n * 11, 14 * 60 + 59);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h > 12 ? h - 12 : h}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

export function recordDeadlineEvent(league: League, kind: DeadlineEvent['kind'], text: string, teamIds: number[], playerIds: number[] = []): void {
  if (!inDeadlineWindow(league)) return;
  if (league.deadlineFeed?.season !== league.season) league.deadlineFeed = { season: league.season, events: [] };
  const feed = league.deadlineFeed;
  const today = feed.events.filter((e) => e.day === league.day).length;
  const time = league.day === league.tradeDeadlineDay ? (kind === 'close' ? '3:00 PM' : clockFor(today)) : undefined;
  feed.events.push({ day: league.day, time, kind, text, teamIds, playerIds });
}
