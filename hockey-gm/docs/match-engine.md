# The match engine

How a hockey game is played in Hockey GM, and how to check it.

## The short version

Every game is played out on the ice and nothing is decided in advance. That covers NHL games, AHL games and the Calder Cup, whether you watch live, fast-forward, hit Instant or let the season sim run.

Each skater and goalie looks at the ice and decides what to do four times a second. Those decisions resolve against each other: passes, checks, shots, saves, rebounds, penalties and line changes. The score is the goals that happen, and the box score is a record of the same play.

## How a game flows

All of this lives in `src/engine/sim/engine.ts`, class `GameSim`.

1. **Setup** (`buildGameInput`): the dressed lineup, lines and power-play/penalty-kill units, tactics, coaching staff, chemistry, fatigue, form and a per-game seed.
   - Every rating is turned into the abilities the engine uses: skating, hands, passing, shooting, offensive and defensive IQ, stick checking, blocking, strength, faceoffs, composure and decisions, plus the goaltending abilities. The table below shows the mapping.
2. **Each 0.25 s step:**
   1. **Bench management:** goalie pulls, line changes on the fly and at stoppages, and the power-play and penalty-kill units. Changes depend on fatigue and shift length, and nobody changes while his team is carrying the puck.
   2. **Decisions, all made from the same picture of the ice:**
      - The puck carrier weighs shooting, a pass to each teammate, carrying, dumping, clearing or protecting the puck.
      - His teammates choose open spots, drive the net or tag up.
      - Defenders choose to pressure, finish a check, mark a man, cover space or block a lane.
      - Goalies set their angle.
      - Utilities come from the ratings, the team's system, fatigue, the score and the clock. A little noise shrinks as decision-making improves.
   3. **Resolution:**
      - **Passes:** each defender in the lane may intercept; the pass can be off target or stripped as it arrives.
      - **Shots** go through stages: a stick on the shooter, blocks in the lane, then missing the net. A shot that gets through has its scoring chance computed from distance, angle, shot type, rush or one-timer, screen, the shooter's skill against the goalie's, special teams and pressure. After that comes a save, a goal or a rebound, and then a freeze or a scramble.
      - **Contact and loose pucks:** stick checks, hits, puck battles and races.
      - **Rules:** offside (the puck must fully cross the blue line), icing, penalties.
   4. **Clock and fatigue:** players tire on the ice and recover on the bench. Fatigue lowers skating, hands and decisions.
3. **Coaches adjust the system** about every 15 game seconds:
   - Trailing late: a two-man forecheck with pinching defence.
   - Leading late: a 1-3-1 trap.
   - After a run of giveaways in their own end: get pucks deep.
   - Pinned in their own zone: collapse in front of the net.

   Sharper tactical coaches react sooner. These are changes to how the team plays, never to the score.
4. **Regulation, overtime and shootout:** NHL rules, read from the league's rule set.

## Layers

| Concern | Where |
|---|---|
| Simulation (authoritative state, hockey logic) | `src/engine/sim/engine.ts` (`GameSim`), geometry in `ice.ts`, shot model in `shotModel.ts` |
| Decisions | `decideCarrier`, `decideSupport`, `decideDefender`, `decideLoose` and the goalies in `engine.ts`, plus in-game coaching in `coachAdjust` |
| Events | `GameEvent` in `gameTypes.ts`: id, cause, period, clock, type, players, team, puck zone and the outcome probability (see below) |
| Statistics | Accumulated by the engine at the moment each event resolves, booked into the league by `applyGameResult` (`season.ts`) |
| Presentation | Live game (`ui/pages/LiveGame.tsx`), 2D and 3D rinks (`ui/rink/`), play-by-play (`sim/commentary.ts`). They read the engine and never change it |
| Persistence | `sim/savedGame.ts` (a game is its input plus the steps played) and `league.liveGame` for a game you left part-way |
| Calibration | `scripts/agent-check.ts`, `scripts/agent-season.ts`, `scripts/engine-scenarios.ts`, and the tests in `tests/engine*.test.ts` |

## Events

Every event has an `id` and, where it applies, a `cause`, which is the event that led to it:
- a save or goal points to its shot
- a shot points to the pass or rebound that set it up
- a rebound points to its save
- a turnover points to the pass it picked off

Shots, saves and goals record the engine's own chance that the shot went in at that moment. Passes record the chance they got through and how they ended. Blocks, misses and rebounds record their own chances.

The live play-by-play shows these probabilities, for example "It had a 14% chance of going in". Recording them changes no rolls.

## Saving, resuming, replaying

The engine is deterministic. A seeded generator is the only randomness, and no clocks or browser state affect the result. So a game is fully described by its input and the number of steps played.

- **Saving** stores exactly that.
- **Resuming** replays those steps to rebuild the identical state: clock, score, fatigue, lines, penalties, possession and the random generator. A full game replays in about a quarter of a second.
- **Replays** in the viewer rewind the presentation; the engine is not re-run.

## Ratings in play

| Engine ability | Built from |
|---|---|
| Skating (speed, races, recovery) | speed, acceleration, agility, balance, edgework |
| Hands (keeping the puck under pressure) | stickhandling, puck control, creativity |
| Passing | passing, creativity, decision-making, hockey sense |
| Shooting (wrist and snap shots) | wrist accuracy, wrist power, shot selection, composure |
| Slap shot | slap power, slap accuracy, shot selection |
| One-timer | one-timer, wrist accuracy, receiving |
| Offensive IQ (where to go, what to try) | offensive awareness, anticipation, hockey sense, positioning |
| Defensive IQ (coverage, gaps, interceptions) | defensive awareness, defensive positioning, positioning, anticipation, backchecking |
| Stick checking | stick checking, anticipation, defensive awareness |
| Shot blocking | shot blocking, defensive positioning, determination |
| Strength (battles, protecting the puck) | strength, body checking, balance |
| Hitting appetite | body checking, aggression, archetype |
| Faceoffs | faceoffs, strength |
| Receiving | receiving |
| Decisions (choices, noise) | decision-making, composure |
| Discipline (penalties) | discipline |
| Goaltending | reflexes, positioning, glove, blocker, athleticism, lateral movement, high-danger saves, rebound control |
| Stamina | endurance |

Ratings move probabilities; they don't guarantee outcomes. Over a season a star beats a replacement player, but any night the replacement can make the play.

## Calibration targets

- **Single games:** `scripts/agent-check.ts` checks 15 single-game targets, including goals, shots, attempts, shooting %, save %, power-play % and opportunities, hits, blocks, home wins, overtime rate, assists per goal, empty-net goals, injuries and high-scoring games.
- **Seasons:** `scripts/agent-season.ts` checks season spreads (team points, top scorers, goalie save % range, games lost to injury).
- **Scenarios:** `scripts/engine-scenarios.ts` covers even teams, contender against rebuilder, elite goalie and elite offense match-ups, systems against each other, fatigue and special teams. It also reports score distribution, shutouts, overtime and blowout rates, talent against winning, goalie quality against save %, late-game behaviour, events per game and runtime.

## Known simplifications

- The rink is continuous, but players are points with a reach. There's no full body physics.
- The shot model's base scoring chance by distance, angle and shot type is a hand-tuned expected-goals curve aimed at typical NHL shooting percentages, not a fit to a shot dataset. Shooter and goalie skill sit on top of it.
- Coaches choose from a fixed set of systems, and in-game adjustments are limited to the four situations above.
- Regular-season overtime follows the league's rule set; playoff overtime is continuous 5-on-5.

## Latest scenario results

From `scripts/engine-scenarios.ts 150` (150 games per scenario, one core, about 0.28 s per game).

| Scenario | Result |
|---|---|
| Even (same club on both benches, neutral ice) | 55% / 45% (within noise of 50/50 at 150 games), 3.4–3.3 goals, 28% to overtime |
| Contender vs rebuilder (±18 on every rating) | 92% wins, 4.9–1.9 goals, 37–22 shots |
| Elite goalie vs weak offense | 71% wins, the goalie stops .913 against the twin side's .911, weak side scores 2.4 |
| Elite offense vs weak goalie | 76% wins, the weak goalie stops .880 |
| Aggressive forecheck v trap · v dump-and-chase · v cycle | 62% · 57% · 45% |
| Trap v dump-and-chase · v cycle | 43% · 48% |
| Dump-and-chase (physical) v cycle | 57% |
| Rested vs fatigued (energy 70%) | 77% wins, 35–23 shots |
| Strong PP (A) vs weak PK (B) | A's PP 20% (league ~18%) |
| Real match-ups | 3-2 13%, 4-3 11%, 5-4 9%, 2-1 8% · shutouts 7% · one-goal games 43% · 4+ goal margins 15% · overtime 21% · shootouts 7% |
| Goalie quality vs save % | bottom third .897, middle .898, top third .908 |
| Last 5 minutes of close games | trailing team 3.4 shots vs leader 2.0 · goalie pulls 0.65 per game |

Weak spots right now:
- **Special teams:** the quality of the power-play and penalty-kill players moves conversion only a little (20% against a ~18% league rate in the strong-PP test).
- **Goalies:** in this batch each goalie faced only about 120 shots, so the save-% sampling error is about ±.027 and the thirds can't be told apart reliably. Full seasons are the real check: starting goalies there range from about .866 to .931.
