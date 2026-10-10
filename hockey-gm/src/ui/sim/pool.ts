/**
 * A small pool of worker threads for simulating a day's games in parallel.
 * Every player decides every second, so a game is real work; spreading a
 * day's games over the machine's cores keeps season sims quick. Falls back
 * to the main thread when workers aren't available.
 */
import type { GameInput, GameResult } from '../../engine/sim/gameTypes';
import { simulateGame } from '../../engine/sim/engine';
import { portableInput } from '../../engine/league/gameInput';
import type { SimMany } from '../../engine/league/season';

interface Job {
  resolve: (r: GameResult[]) => void;
  reject: (e: unknown) => void;
}

let workers: Worker[] | null = null;
let broken = false;
let nextId = 1;
const jobs = new Map<number, Job>();

function pool(): Worker[] | null {
  if (broken || typeof Worker === 'undefined') return null;
  if (workers) return workers;
  try {
    const n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
    workers = Array.from({ length: n }, () => {
      const w = new Worker(new URL('./simWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<{ id: number; results?: GameResult[]; error?: string }>) => {
        const job = jobs.get(e.data.id);
        if (!job) return;
        jobs.delete(e.data.id);
        if (e.data.results) job.resolve(e.data.results);
        else job.reject(new Error(e.data.error));
      };
      w.onerror = () => {
        broken = true;
      };
      return w;
    });
    return workers;
  } catch {
    broken = true;
    return null;
  }
}

function run(w: Worker, inputs: GameInput[]): Promise<GameResult[]> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    jobs.set(id, { resolve, reject });
    w.postMessage({ id, inputs: inputs.map(portableInput) });
  });
}

/** Simulate games across the pool; results come back in input order. */
export const simMany: SimMany = async (inputs) => {
  const ws = pool();
  if (!ws || inputs.length < 2) return inputs.map((i) => simulateGame(i));
  const chunks: GameInput[][] = ws.map(() => []);
  inputs.forEach((inp, i) => chunks[i % ws.length].push(inp));
  try {
    const parts = await Promise.all(chunks.map((c, k) => (c.length ? run(ws[k], c) : Promise.resolve([] as GameResult[]))));
    const out: GameResult[] = new Array(inputs.length);
    parts.forEach((res, k) => res.forEach((r, j) => (out[k + j * ws.length] = r)));
    return out;
  } catch {
    broken = true;
    return inputs.map((i) => simulateGame(i));
  }
};
