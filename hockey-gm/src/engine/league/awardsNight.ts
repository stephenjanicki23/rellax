/**
 * Awards night: the voting behind the season-end trophies.
 *
 * Each voted award gets a simulated panel. Every voter ranks the candidates
 * by the award's score plus a personal judgement (noise scaled to how close
 * the race is), and the ballots are tallied on the award's points scale. The
 * top three are the finalists; the most points wins.
 *
 * SIMPLIFICATION: panel sizes are round numbers and the ballots are
 * simulated, not modelled on real voters. The points scales follow the
 * familiar formats (writers rank five, 10-7-5-3-1; general managers and
 * broadcasters rank three, 5-3-1). The players' vote for the Ted Lindsay
 * uses the 5-3-1 scale as a simplification.
 */
import type { Rng } from '../core/rng';

export interface VoteCand {
  playerId?: number;
  coachId?: number;
  teamId: number;
  score: number;
  value: string;
}

export interface Finalist extends VoteCand {
  /** Ballot points. */
  pts: number;
  /** First-place votes. */
  firsts: number;
  /** Ballots naming him anywhere. */
  named: number;
}

export interface AwardBallot {
  award: string;
  /** Who votes, e.g. "Hockey writers". Empty for awards decided by the numbers. */
  voters: string;
  panel: number;
  scale: number[];
  /** Ordered by points (first = winner). Up to five, the top three are the finalists. */
  results: Finalist[];
  /** For awards decided by the numbers: how. */
  note?: string;
}

export interface AllStarSlot {
  pos: string;
  playerId: number;
  teamId: number;
  pts: number;
  value: string;
}

export interface AwardsNight {
  season: number;
  ballots: AwardBallot[];
  allStars: { first: AllStarSlot[]; second: AllStarSlot[]; panel: number };
  /** Award names already revealed in the ceremony. */
  revealed: string[];
}

export const WRITERS = {
  voters: 'Hockey writers',
  panel: 190,
  scale: [10, 7, 5, 3, 1],
};
export const GMS = (teams: number) => ({
  voters: 'General managers',
  panel: teams,
  scale: [5, 3, 1],
});
export const BROADCASTERS = {
  voters: 'Broadcasters',
  panel: 70,
  scale: [5, 3, 1],
};
export const PLAYERS = { voters: 'Players', panel: 300, scale: [5, 3, 1] };

/** Spread of a voter's judgement: wide when the race is tight in absolute terms, never zero. */
export function judgementSd(scores: number[]): number {
  const s = [...scores].sort((a, b) => b - a);
  if (!s.length) return 1;
  const gap = s[0] - (s[Math.min(4, s.length - 1)] ?? s[0]);
  return Math.max(0.5, gap * 0.22 + Math.abs(s[0]) * 0.03);
}

/** Simulate a panel's ballots and tally them. */
export function vote(rng: Rng, cands: VoteCand[], panel: number, scale: number[], keep = 5): Finalist[] {
  if (!cands.length) return [];
  // Only the serious contenders can draw votes.
  const pool = [...cands].sort((a, b) => b.score - a.score).slice(0, Math.max(scale.length * 2, 8));
  const sd = judgementSd(pool.map((c) => c.score));
  const tally = pool.map((c) => ({ ...c, pts: 0, firsts: 0, named: 0 }));
  for (let v = 0; v < panel; v++) {
    const order = tally.map((t, i) => ({ i, s: t.score + rng.normal(0, sd) })).sort((a, b) => b.s - a.s);
    for (let k = 0; k < scale.length && k < order.length; k++) {
      const t = tally[order[k].i];
      t.pts += scale[k];
      t.named++;
      if (k === 0) t.firsts++;
    }
  }
  return tally
    .filter((t) => t.pts > 0)
    .sort((a, b) => b.pts - a.pts || b.firsts - a.firsts || b.score - a.score)
    .slice(0, keep);
}

/** Share of the maximum possible points (for the vote bars). */
export const voteShare = (b: AwardBallot, f: Finalist) => (b.panel && b.scale.length ? f.pts / (b.panel * b.scale[0]) : 0);

export function revealAward(night: AwardsNight, award: string): void {
  if (!night.revealed.includes(award)) night.revealed.push(award);
}
