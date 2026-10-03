# Hockey GM

A hockey franchise simulation in the spirit of Football Manager. You run one team in a fictional 32-team league (the **Premier Hockey League**). You set lines and tactics, scout prospects, draft, trade, sign free agents and manage the cap. Over the seasons the league builds up its own history.

> **Repository note.** This app lives in `hockey-gm/`. The repository also holds the unrelated [`rellax`](https://github.com/dixonandmoe/rellax) parallax library and a `fantasy-football/` app. This project does not modify either of them.

```bash
cd hockey-gm
npm install
npm run dev                # http://localhost:5173
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Typecheck + production build to `dist/` (a static site with no server) |
| `npm test` | Unit, integration and 100-game validation tests (~15 s) |
| `npm run test:validation` | Heavy validation: 1,000 and 10,000-game batches plus a 5-season league run (~2–3 min) |
| `npm run analyze -- 2000 3 [seed]` | CLI analytics: N-game batch plus N full seasons, checked against realistic ranges |
| `npm run typecheck` | `tsc --noEmit` |

---

## What's in the game

**League.** The league has 32 teams, 2 conferences and 4 divisions, and plays an 82-game schedule with 41 home games per team, division weighting, and no three games in three nights. Playoffs use a divisional and wild-card bracket with best-of-seven series in a 2-2-1-1-1 format, played for the Dominion Cup. All of it is data-driven in [`src/engine/data/leagueConfig.ts`](src/engine/data/leagueConfig.ts): teams, divisions, conferences, season length, playoff format and economics.

**Players.** Each player has 42 attributes on a 0–200 scale: skating, shooting, puck skills, hockey IQ, physical, defensive, mental, and 9 goalie attributes. Players also have:
- an **archetype** (Sniper, Playmaker, Power Forward, Two-Way, Grinder, Enforcer, Defensive Forward, five defenseman types and three goalie styles) that shapes both the attribute profile *and* how ratings turn into on-ice performance
- a **personality** (Professional, Driven, Loyal, Ambitious, Team Player, Quiet, Competitive, Difficult, Leader, Easygoing)
- **traits** (injury prone, durable, streaky, big-game)
- hidden **potential** and a **development curve** (early, normal, late bloomer, plateau, bust, opportunity-dependent)

**Development & aging.** Players close the gap to their potential at a rate driven by age, dev curve, ice time, coaching, facilities, determination, personality, injuries and per-season luck. Potential is not guaranteed: busts lose ceiling and plateaus stall. Aging works attribute by attribute and gradually. Speed and acceleration fade from about 28, while hockey sense keeps improving into the early 30s. Goalies mature and decline later than skaters.

**Game engine.** Games are simulated possession by possession with a real shot and xG model — see [Simulation engine](#simulation-engine).

**Tactics.** You choose an offensive style, defensive style, forecheck (1-2-2 / 2-1-2 / 1-3-1), power-play and penalty-kill systems, line usage, and goalie-pull aggressiveness. Each one changes probabilities inside the engine as a trade-off, not a flat bonus.

**Lines.** You set 4 forward lines, 3 defensive pairs, 2 goalies, 2 PP units and 2 PK units. Ice time follows line role, fatigue and game state; coaches shorten the bench late when trailing. The engine tracks ES, PP and PK TOI.

**Chemistry.** Chemistry comes from stylistic complement (playmaker + sniper, offensive D + stay-at-home), handedness, personality, passing, shared ice time and team morale. It is deliberately a small modifier.

**Coaching.** Coaches are rated on offence, defence, development, goaltending, motivation and tactics, and each has a philosophy. Head, assistant and goalie coaches all feed the engine and player development. CPU teams fire underachieving coaches during and after the season.

**Economy.** The economy has a salary cap and floor that grow each season, contracts with no-trade clauses, entry-level deals, RFA/UFA status, arbitration (RFA) and in-season extensions. In free agency, players weigh money, team quality, role, location, loyalty and career stage across a 12-day period.

**Trades.** Each CPU team values assets through its own lens. Contenders pay for current ability; rebuilders want youth, prospects and picks; cap-strapped teams value cheap contracts. Each team also sees potential through its own scouting error. You can ask a CPU team "what would it take?". CPU teams trade with each other, run a goalie market, and leak rumors before the deadline.

**Draft & scouting.** The draft has a weighted lottery, 7 rounds, and roughly 260 generated prospects with archetypes and scouting reports. A combine runs at the end of the regular season. **You never see true ratings for other teams' players**: you see ranges whose width depends on your scouts' quality and how long they have watched. Each scout carries a stable bias. Your own staff knows exactly what your players can do today, but not their ceiling.

**Dynamic league.** CPU teams switch between contending and rebuilding, re-sign or let players walk, bid in free agency, call up prospects, and get under the cap. They also hire and fire coaches and build rivalries through playoff meetings.

**News, records & history.** News is generated from real events: hat tricks, shutouts, milestones, streaks, injuries, trades, signings, rumors, awards, firings, records, retirements and the draft. The game keeps a single-season, career, playoff and team record book. Each season adds champions, awards (MVP, scoring, goals, goalie, defenseman, rookie, defensive forward, coach, playoff MVP, Presidents' Trophy), archived standings and leaders, and a Legends page for retired greats.

**UI.** The UI includes a dashboard plus Roster, Lines, Tactics, Prospects, Contracts, Scouting, Trades, Free Agency, Draft, Schedule, Standings (with bracket), Statistics (with advanced metrics such as ixG, xA, CF%, xGF%, GSAx and HDSV%), Players, League, News, History, Sim Analytics and Settings.
- The **live game** screen shows the scoreboard, a rink view, a momentum bar, on-ice units with energy bars, game stats and play-by-play written from engine events. It runs at Pause / 1× / 2× / 5× / 10× / Instant, and the live result is the official result.
- **Save / load:** the game autosaves to IndexedDB, and you can export or import a JSON save file.

---

## Architecture

```
src/
  engine/                 ← pure TypeScript, no DOM, fully testable
    core/                 rng (seeded sfc32), math, stat lines
    data/                 league config (data-driven), name pools
    player/               archetypes, ability (CA), generation, prospects,
                          personality, development & aging, injuries
    team/                 lines, coaching & tactics, chemistry, strength
    sim/                  game engine, shot/xG model, commentary, types
    league/               create, schedule, season loop, standings, playoffs,
                          awards, records, news, morale, offseason
    economy/              contracts & cap, roster rules, free agency,
                          trades, draft, scouting
    ai/                   CPU general managers
    analytics.ts          batch/season distributions + realistic targets
    save.ts               serialisation, versioning, migrations
  ui/                     React; only orchestrates engine calls
    store.ts              holds the League, version counter, chunked sims, autosave
    db.ts                 IndexedDB save slots
    pages/, components/
tests/                    vitest: unit, integration, validation/
scripts/analyze.ts        CLI simulation analytics
```

Design rules:

1. **No simulation logic in UI components.** Every number the UI shows comes from `src/engine/**`. The UI calls engine functions inside `mutate()` and re-renders.
2. **The whole universe is plain JSON** (`League` in [`types.ts`](src/engine/types.ts)). Saving is serialisation; the RNG state is part of the save.
3. **Deterministic.** All randomness flows through seeded generators. A game's seed is derived from the league seed, the season and the game id. The same rosters, ratings, tactics, injuries and seed always produce the same game, whether it is played live or instantly, and before or after a save/load. The tests check this.
4. **The engine is independent of the league.** `simulateGame(GameInput)` takes plain inputs (players, lines, tactics, coach, chemistry function, seed). `league/gameInput.ts` is the adapter between the two.

### Season flow

```
regular season ─(day by day)─▶ playoffs ─▶ finishSeason
  (awards, careers archived, history, records, rivalries,
   coaching carousel, development + aging, retirements, draft order)
─▶ draft ─▶ re-sign (contracts roll, arbitration) ─▶ free agency (12 days)
─▶ preseason (new schedule, cap growth, new draft class, AI roster prep) ─▶ …
```

---

## Simulation engine

[`src/engine/sim/engine.ts`](src/engine/sim/engine.ts) runs a game as a sequence of possession steps, about 700 per game:

| Step | What decides it |
| --- | --- |
| Faceoff | Centers' faceoff skill; winner's zone sets the next state (an offensive-zone win allows set plays) |
| Breakout | Puck mover's passing/hands vs the forecheck (system, intensity, forecheckers' skating, physicality, stick work). Failures are high-danger turnovers; icing is possible |
| Neutral zone | Carry or dump (style, carrier skill, opponent trap / 1-3-1). Carry success vs the defence's gap control can produce rushes and odd-man rushes. Dumps lead to retrieval battles (forechecker vs defenseman) |
| Offensive zone | Each play is a pass (builds setup quality, one-timer looks, chemistry), a shot or a turnover. Probabilities depend on on-ice offence vs defence, coaching, tactics, strength state, open ice (4v4 / 3v3) and fatigue |
| Shot | Location (danger tier from setup quality, net-front play, rush, odd-man, turnovers, PP/PK systems), shot type (wrist, snap, slap, backhand, one-timer, tip, wraparound, rebound), screens, blocks, misses |
| Save / goal | `xG` comes from the league-average [shot model](src/engine/sim/shotModel.ts) (distance, angle, type, context). Goal probability = logistic(logit(xG) + shooter skill (by shot type) − goalie skill (by danger) + clutch + context). Elite skill has diminishing returns |
| Aftermath | Rebound battles and second chances, freezes, faceoffs, momentum swings |

Also modelled:
- penalties (stick fouls, hit penalties, double minors, majors, fights) with discipline and tactics effects; PP/PK units; a PP ends on a goal
- shift-based line changes (you can't change while pinned in your own zone; icing team can't change); the home team's last-change matchups
- energy per player (endurance, age, PK/defending load, hits) that hurts skating, decisions and shooting
- season fatigue and back-to-backs (goalie rotation)
- injuries from hits, blocks and non-contact, with severity, recovery and re-injury risk
- empty-net pulls (trailing by 1 or 2, by style) and empty-net goals; pulling a struggling starter
- score effects; 3v3 OT and shootout (regular season); 20-minute sudden-death OT (playoffs)
- small home-ice and momentum effects, form/streaks, goalie confidence, playoff reputation

Every action is drawn from these probabilities; the final score is simply what the events add up to.

### Balance

Run `npm run analyze` or open **Sim Analytics** in the app. A 10,000-game batch with default rosters (all inside the target bands):

| Metric | Engine | Target band |
| --- | --- | --- |
| Goals per team-game | 3.0–3.1 | 2.8–3.4 |
| Shots on goal per team-game | ~31.5 | 28–33.5 |
| Shot attempts per team-game | ~56 | 50–62 |
| Shooting % / Save % | ~9.7% / ~.908 | 8.8–11.2% / .895–.913 |
| PP opportunities / PP% | ~3.1 / ~18% | 2.6–3.7 / 16–25% |
| Hits / blocks per team-game | ~21 / ~13 | 17–28 / 11–17 |
| Home win % | ~53% | 51–57% |
| Games to OT | ~21% | 17–27% |
| Assists per goal | 1.66 | 1.5–1.8 |
| Empty-net goals per game | ~0.38 | 0.2–0.5 |

Season level, across many seeds:
- team points std. dev. ~15–19 (best ~120–135, worst ~45–60)
- scoring leader ~115–145 points
- 4–10 50-goal scorers
- starting goalies between ~.880 and ~.930
- ~20 injuries and ~200 man-games lost per team

Over 5 or more simulated seasons, the talent level stays flat (top-400 ability drift < 1 point/season) and the league produces different champions.

To keep scoring stable over decades even if ratings drift, the engine measures ratings relative to the league's current talent level (`ratingBaseline`).

Balance knobs live in `TUNING` in `engine.ts`; the analytics screen shows them read-only.

---

## Testing

- `tests/rng.test.ts`: determinism, serialisable state, distribution sanity
- `tests/engine.test.ts`:
  - same input + seed gives the same result
  - live play matches instant play
  - box-score consistency (goals, assists, goalie decisions, TOI)
  - commentary comes from events
  - the shot model behaves sensibly
- `tests/season.test.ts`: schedule balance, a full season (standings integrity, goals add up, playoff seeding), playoffs, champion, awards, records, news, injuries heal
- `tests/economy.test.ts`: cap compliance, contract values, trade evaluation by strategy, trade execution, the full offseason (user draft pick, scouting uncertainty, free agency, roster and cap legality)
- `tests/development.test.ts`: generation hits target ability, development isn't guaranteed, ice time matters, aging is gradual
- `tests/save.test.ts`: save → load → the league continues identically
- `tests/validation/`: 100 / 1,000 / 10,000-game batches and a 5-season league run against realistic ranges

---

## Known limitations / ideas for later

- Box scores store a game summary (goals, shots, xG, stars, goalies). Full per-player game logs are not kept, to keep saves small.
- No waivers, offer sheets, dead cap from buyouts, or minor-league standings. Prospects simply develop "in the system".
- The league is fictional, and team logos are generated placeholders.
- Simulation runs on the main thread in daily chunks, which keeps the UI responsive. A full season takes about 7–10 s in a browser. A Web Worker would make it fully non-blocking.
