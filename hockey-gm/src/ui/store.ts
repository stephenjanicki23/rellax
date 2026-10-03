/**
 * UI store. Holds the live League object (mutated in place by engine
 * functions) plus a version counter that React subscribes to. All game logic
 * lives in the engine; this file only orchestrates and persists.
 */
import { useSyncExternalStore } from 'react';
import type { League } from '../engine/types';
import { createLeague, type CreateLeagueOptions } from '../engine/league/create';
import { advanceDay, userGameToday, type DayReport } from '../engine/league/season';
import { advanceOffseason } from '../engine/league/offseason';
import { serializeLeague, deserializeLeague, saveMeta } from '../engine/save';
import type { GameResult } from '../engine/sim/gameTypes';
import { putSave, getSave } from './db';

export interface Busy {
  label: string;
  progress: number; // 0..1
  cancel?: () => void;
}

interface State {
  league: League | null;
  version: number;
  saveId: string | null;
  busy: Busy | null;
  toasts: { id: number; text: string; kind: 'info' | 'good' | 'bad' }[];
  lastSaved: number | null;
  confirm: { text: string; ok: string; resolve: (v: boolean) => void } | null;
}

let state: State = { league: null, version: 0, saveId: null, busy: null, toasts: [], lastSaved: null, confirm: null };
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  emit();
}

export function useStore(): State {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => state,
  );
}

/** Convenience: league + version (use version as a memo dependency). */
export function useGame(): { league: League; version: number } {
  const s = useStore();
  return { league: s.league as League, version: s.version };
}

export function getLeague(): League {
  if (!state.league) throw new Error('No game loaded');
  return state.league;
}

/**
 * In-page confirmation (the browser's confirm() is unavailable in sandboxed hosts).
 * Resolves true when the user accepts.
 */
export function ask(text: string, ok = 'Continue'): Promise<boolean> {
  return new Promise((resolve) => {
    set({
      confirm: {
        text,
        ok,
        resolve: (v) => {
          set({ confirm: null });
          resolve(v);
        },
      },
    });
  });
}

let toastId = 1;
export function toast(text: string, kind: 'info' | 'good' | 'bad' = 'info'): void {
  const id = toastId++;
  set({ toasts: [...state.toasts, { id, text, kind }].slice(-4) });
  setTimeout(() => set({ toasts: state.toasts.filter((t) => t.id !== id) }), 4200);
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveNow(), 1500);
}

export async function saveNow(): Promise<void> {
  const { league, saveId } = state;
  if (!league || !saveId) return;
  try {
    const text = serializeLeague(league, saveId);
    await putSave(saveMeta(league, saveId), text);
    set({ lastSaved: Date.now() });
  } catch (e) {
    toast(`Save failed: ${(e as Error).message}`, 'bad');
  }
}

/** Apply a synchronous engine mutation and re-render. */
export function mutate<T>(fn: (league: League) => T, opts: { save?: boolean } = {}): T {
  const league = getLeague();
  const out = fn(league);
  set({ version: state.version + 1 });
  if (opts.save !== false) scheduleSave();
  return out;
}

export function newGame(opts: CreateLeagueOptions): void {
  const league = createLeague(opts);
  const saveId = `save-${Date.now()}`;
  set({ league, saveId, version: state.version + 1 });
  void saveNow();
}

export async function loadGame(id: string): Promise<void> {
  const text = await getSave(id);
  if (!text) throw new Error('Save not found');
  const { league } = deserializeLeague(text);
  set({ league, saveId: id, version: state.version + 1 });
}

export function importGame(text: string): void {
  const { league, meta } = deserializeLeague(text);
  set({ league, saveId: meta.id.startsWith('import') ? meta.id : `save-${Date.now()}`, version: state.version + 1 });
  void saveNow();
}

export function exportGame(): void {
  const { league, saveId } = state;
  if (!league || !saveId) return;
  const blob = new Blob([serializeLeague(league, saveId)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const t = league.teams[league.userTeamId];
  a.download = `hockey-gm-${t.abbr}-${league.season}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function quitToMenu(): void {
  void saveNow().then(() => set({ league: null, saveId: null }));
}

const frame = () => new Promise<void>((r) => setTimeout(r, 0));

export type SimKind = 'day' | 'week' | 'month' | 'toUserGame' | 'deadline' | 'endRegular' | 'endPlayoffs';

/**
 * Run a multi-day simulation without freezing the UI: one day per chunk,
 * with progress and cancellation. Stops early when the user's game is up
 * (if `stopAtUserGame`) so they can choose to play it live.
 */
export async function runSim(kind: SimKind, overrides?: Map<number, GameResult>): Promise<DayReport[]> {
  const league = getLeague();
  if (state.busy) return [];
  let cancelled = false;
  const startPhase = league.phase;
  const startDay = league.day;
  const totalDays = Math.max(1, (league.schedule.filter((g) => !g.playoff).reduce((m, g) => Math.max(m, g.day), 0) || 190) - league.day);
  const reports: DayReport[] = [];
  const done = (): boolean => {
    if (cancelled) return true;
    if (league.phase !== 'regular' && league.phase !== 'playoffs') return true;
    const n = league.day - startDay;
    switch (kind) {
      case 'day':
        return n >= 1;
      case 'week':
        return n >= 7 || league.phase !== startPhase;
      case 'month':
        return n >= 30 || league.phase !== startPhase;
      case 'toUserGame':
        return n >= 1 && !!userGameToday(league);
      case 'deadline':
        return league.phase !== 'regular' || league.day > league.tradeDeadlineDay;
      case 'endRegular':
        return league.phase !== 'regular';
      case 'endPlayoffs':
        return league.phase !== 'playoffs' && league.phase !== 'regular';
    }
  };
  set({ busy: { label: labelFor(kind), progress: 0, cancel: () => (cancelled = true) } });
  try {
    let first = true;
    while (!done()) {
      reports.push(advanceDay(league, first ? overrides : undefined));
      first = false;
      const n = league.day - startDay;
      const progress = kind === 'week' ? n / 7 : kind === 'month' ? n / 30 : kind === 'day' ? 1 : Math.min(0.99, n / (kind === 'endPlayoffs' ? totalDays + 60 : totalDays));
      state = { ...state, busy: { ...state.busy!, progress } };
      if (reports.length % 2 === 0) {
        set({ version: state.version + 1 });
        await frame();
      }
    }
  } finally {
    set({ busy: null, version: state.version + 1 });
    scheduleSave();
  }
  return reports;
}

function labelFor(kind: SimKind): string {
  switch (kind) {
    case 'day':
      return 'Simulating day';
    case 'week':
      return 'Simulating week';
    case 'month':
      return 'Simulating month';
    case 'toUserGame':
      return 'Simulating to your next game';
    case 'deadline':
      return 'Simulating to the trade deadline';
    case 'endRegular':
      return 'Simulating the regular season';
    case 'endPlayoffs':
      return 'Simulating the playoffs';
  }
}

/** Advance an offseason phase (draft → re-sign → free agency → preseason → regular). */
export async function nextPhase(auto = false): Promise<void> {
  const league = getLeague();
  set({ busy: { label: 'Processing offseason', progress: 0.5 } });
  await frame();
  try {
    advanceOffseason(league, auto);
  } finally {
    set({ busy: null, version: state.version + 1 });
    scheduleSave();
  }
}
