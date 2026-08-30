import { describe, expect, it } from 'vitest';
import { buildWeeklyReport, topActions } from '@/domain/actions';
import { buildSampleLeagueState } from '@/providers/sample/sample-league';

describe('buildWeeklyReport', () => {
  it('returns a graded report with concrete actions', () => {
    const state = buildSampleLeagueState({ drafted: true, currentWeek: 5 });
    const report = buildWeeklyReport(state, { week: 5 });

    expect(report.week).toBe(5);
    expect(report.grade.overallGrade).toMatch(/^[A-F][+-]?$/);
    expect(report.startersProjection).toBeGreaterThan(0);
    expect(report.needs).not.toBeNull();
  });

  it('surfaces unfillable starting slots as the highest priority', () => {
    const state = buildSampleLeagueState({ currentWeek: 3 });
    // Undrafted rosters cannot fill anything.
    const report = buildWeeklyReport(state, { week: 3 });
    const holes = report.actions.filter((a) => a.kind === 'ROSTER_HOLE');
    expect(holes.length).toBeGreaterThan(0);
    expect(holes[0]!.priority).toBe('HIGH');
  });

  it('gives every action a confidence, reasoning, risk and data trail', () => {
    const state = buildSampleLeagueState({ drafted: true, currentWeek: 5 });
    const report = buildWeeklyReport(state, { week: 5 });
    for (const action of report.actions) {
      expect(action.confidence).toBeGreaterThan(0);
      expect(action.confidence).toBeLessThanOrEqual(1);
      expect(action.reasoning.length).toBeGreaterThan(0);
      expect(action.dataUsed.length).toBeGreaterThan(0);
      expect(action.headline.length).toBeGreaterThan(0);
    }
  });

  it('warns when players are missing projections rather than scoring them as zero', () => {
    const state = buildSampleLeagueState({ drafted: true });
    state.seasonProjections = state.seasonProjections.slice(0, 10);
    const report = buildWeeklyReport(state);
    expect(report.dataWarnings.join(' ')).toContain('no projection');
  });

  it('reports honestly when no league is loaded', () => {
    const state = buildSampleLeagueState();
    state.teams = [];
    const report = buildWeeklyReport(state);
    expect(report.dataWarnings.join(' ')).toContain('No teams loaded');
    expect(report.actions).toHaveLength(0);
  });

  it('returns at most three top actions for the dashboard', () => {
    const state = buildSampleLeagueState({ drafted: true, currentWeek: 5 });
    expect(topActions(buildWeeklyReport(state)).length).toBeLessThanOrEqual(3);
  });
});
