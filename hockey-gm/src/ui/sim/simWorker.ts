/// <reference lib="webworker" />
/** Runs games off the main thread. Receives portable inputs, returns results in the same order. */
import { simulateGame } from '../../engine/sim/engine';
import { hydrateInput, type PortableGameInput } from '../../engine/league/gameInput';
import type { GameResult } from '../../engine/sim/gameTypes';

self.onmessage = (e: MessageEvent<{ id: number; inputs: PortableGameInput[] }>) => {
  const { id, inputs } = e.data;
  try {
    const results: GameResult[] = inputs.map((p) => simulateGame(hydrateInput(p)));
    (self as unknown as Worker).postMessage({ id, results });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
