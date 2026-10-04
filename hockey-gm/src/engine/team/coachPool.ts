/**
 * Building coaches: real NHL head coaches (with their real records) and
 * generated staff/candidates with a coaching background.
 */
import type { Rng } from '../core/rng';
import { clamp } from '../core/math';
import type { Coach, League } from '../types';
import { generateCoach } from './coaching';
import { COACH_PROFILES, COACH_QUALITY, splitName } from '../data/nhl/staff';
import { COACH_BIRTH_YEAR, JACK_ADAMS, NOT_COACHING, allRealCoachNames, coachRecordsInfo, realCareerLines, realRecordSummary } from '../data/nhl/coachRecords';

/** Typical age of a coach when he gets his first NHL head job (used only to estimate an unknown birth year). */
const FIRST_JOB_AGE = 45;

/** Rating for a real coach without a hand-set quality: from his record, playoff success and Cups. */
function qualityFromRecord(name: string): number {
  const r = realRecordSummary(name);
  const weight = Math.min(1, r.gp / 300);
  return clamp(100 + (r.ptsPct - 0.53) * 280 * weight + r.cups * 9 + r.seriesWins * 1.4, 82, 156);
}

export function buildRealCoach(rng: Rng, id: number, season: number, name: string, teamIdOf: (abbr: string) => number | null): Coach {
  const quality = COACH_QUALITY[name] ?? qualityFromRecord(name);
  const c = generateCoach(rng, id, season, quality, 'head', COACH_PROFILES[name]);
  Object.assign(c, splitName(name));
  c.real = true;
  c.career = realCareerLines(name, teamIdOf);
  const sum = realRecordSummary(name);
  const known = COACH_BIRTH_YEAR[name];
  c.birthYear = known ?? (sum.first !== null ? sum.first - FIRST_JOB_AGE : c.birthYear);
  c.birthKnown = known !== undefined;
  c.awards = [
    ...c.career.filter((l) => l.cup).map((l) => ({ season: l.season, award: 'Stanley Cup' })),
    ...Object.entries(JACK_ADAMS).filter(([, n]) => n === name).map(([s]) => ({ season: Number(s), award: 'Jack Adams Award' })),
  ].sort((a, b) => a.season - b.season);
  c.reputation = Math.round(clamp(18 + Math.min(sum.gp, 1200) / 30 + sum.cups * 10 + sum.seriesWins * 1.5 + (sum.ptsPct - 0.5) * 60 + c.awards.filter((a) => a.award === 'Jack Adams Award').length * 5, 10, 95));
  const teams = [...new Set(c.career.map((l) => l.team).filter(Boolean))];
  c.background = sum.gp ? `NHL head coach since ${sum.first}-${String((sum.first! + 1) % 100).padStart(2, '0')} (${teams.join(', ')})` : 'First NHL head-coaching job';
  return c;
}

/**
 * Real former NHL head coaches without a bench job: coached in the NHL within
 * the last six seasons of the data, aren't in a front office, aren't too old.
 */
export function realCandidateNames(season: number, employed: Set<string>): string[] {
  const { to } = coachRecordsInfo();
  return allRealCoachNames().filter((n) => {
    if (employed.has(n) || NOT_COACHING.has(n)) return false;
    const r = realRecordSummary(n);
    if (r.last === null || r.last < to - 6 || r.gp < 30) return false;
    const born = COACH_BIRTH_YEAR[n] ?? (r.first ?? season) - FIRST_JOB_AGE;
    return season - born <= 68;
  });
}

const BACKGROUNDS: Record<Coach['role'], [string, number][]> = {
  head: [['AHL head coach', 4], ['NHL associate coach', 4], ['CHL head coach', 2], ['NCAA head coach', 1.5], ['European pro head coach', 1.5]],
  assistant: [['NHL assistant coach', 5], ['AHL head coach', 2], ['AHL assistant coach', 2], ['Former NHL defenceman', 1.5], ['Former NHL forward', 1.5], ['Video and analytics coach', 1]],
  goalie: [['Former NHL goaltender', 3], ['AHL goaltending coach', 3], ['Goaltending development coach', 2]],
};

/** A generated coach with a coaching background (never claims a real club). */
export function generateCandidate(rng: Rng, id: number, season: number, role: Coach['role'], quality?: number): Coach {
  const q = quality ?? clamp(rng.normal(role === 'head' ? 100 : 95, 17), 55, 150);
  const c = generateCoach(rng, id, season, q, role);
  c.background = rng.weighted(BACKGROUNDS[role], (b) => b[1])[0];
  c.birthKnown = true;
  return c;
}

/** Keep enough unemployed coaches for every role on the market. */
export function stockCoachPool(league: League, rng: Rng): void {
  const want: Record<Coach['role'], number> = { head: 10, assistant: 6, goalie: 5 };
  for (const role of ['head', 'assistant', 'goalie'] as const) {
    const have = Object.values(league.coaches).filter((c) => c.teamId === null && !c.retired && c.role === role).length;
    for (let i = have; i < want[role]; i++) {
      const c = generateCandidate(rng, league.nextId.coach++, league.season, role);
      league.coaches[c.id] = c;
    }
  }
}
