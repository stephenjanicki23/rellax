/**
 * Saving and resuming a game in progress.
 *
 * The engine is deterministic: a game is fully determined by its input (the
 * rosters, lines, tactics, ratings and seed it started with) and how many
 * steps have been played. So a saved game stores exactly that, and resuming
 * replays those steps to rebuild the identical state: clock, score,
 * fatigue, who is on the ice, penalties, possession, the random-number
 * generator, everything. Replaying a full game takes a fraction of a second.
 */
import { GameSim } from './engine';
import type { GameInput } from './gameTypes';
import { hydrateInput, portableInput, type PortableGameInput } from '../league/gameInput';

export interface SavedGame {
  version: 1;
  input: PortableGameInput;
  steps: number;
}

export function saveGame(sim: GameSim): SavedGame {
  return { version: 1, input: portableInput(sim.input), steps: sim.steps };
}

/** Rebuild a game from a save, `steps` engine steps in (defaults to where it was saved). */
export function loadGame(saved: SavedGame, steps = saved.steps): GameSim {
  const sim = new GameSim(hydrateInput(saved.input));
  while (!sim.finished && sim.steps < steps) sim.step();
  return sim;
}

/** A fresh copy of a game's input that will play out identically (for replays). */
export function cloneInput(input: GameInput): GameInput {
  return hydrateInput(JSON.parse(JSON.stringify(portableInput(input))) as PortableGameInput);
}
