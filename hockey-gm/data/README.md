# Game data

All money values are in **thousands of US dollars** (`95500` = $95.5M).

| Folder | File | What it holds |
| --- | --- | --- |
| `league_rules/` | `rules.json` | Versioned CBA and cap rules by season |
| `contracts/` | `contracts.json` | Real player contracts (keyed by NHL player id) |
| `transactions/` | `dead_cap.json` | Existing dead-cap charges (buyouts, retained salary, overages) |
| `nhl/` | `rosters.json` | Real rosters, coaches and GMs (from `scripts/fetch-nhl.mjs`) |
| `players/`, `teams/` | — | Reserved for future imports |

The game reads these files at build time. To refresh the data, replace a file and rebuild; no code changes are needed.

## `league_rules/rules.json`

Each season under `seasons` inherits from the previous one, so a season only lists what changes. Seasons past the end of the table are projected with `projection.annualGrowth` and flagged `projected`.

Every value carries a `source`:

- `CBA2013`: the 2013 CBA as amended in 2020 (rules through 2025-26).
- `MOU2025`: the June 2025 memorandum (the new CBA from 2026-27).
- `NHL`: published league figures.
- `PROJECTED`: not published yet. Update these when the league announces the figure.
- `SIMPLIFICATION`: a game simplification of a more detailed rule.

The UI and the rules engine show these provenance tags, so a rule's origin stays visible.

## `contracts/contracts.json`

```jsonc
{
  "schemaVersion": 1,
  "asOf": "2026-10-01",            // date the data was captured
  "source": "where it came from",
  "contracts": [
    {
      "nhlId": 8478402,             // NHL player id (matches rosters.json)
      "teamAbbr": "EDM",            // current team
      "signingTeamAbbr": "EDM",     // optional, defaults to teamAbbr
      "type": "standard",           // "standard" | "ELC"
      "twoWay": false,
      "signedSeason": 2025,         // league year the deal was signed in (start year)
      "expiryStatus": "UFA",        // optional: "RFA" | "UFA"
      "years": [
        { "season": 2026, "salary": 12000, "signingBonus": 500, "perfBonus": 0, "minorSalary": 0 }
      ],
      "clauses": [
        { "kind": "NMC", "from": 2026, "to": 2027 },
        { "kind": "M-NTC", "from": 2028, "to": 2030, "teams": 10, "mode": "block" }
      ],
      "retained": [{ "teamAbbr": "TOR", "pct": 0.25 }],
      "firstSpcAge": 18,            // optional, used for waivers/RFA rules
      "firstSpcSeason": 2015
    }
  ]
}
```

- **What the engine computes:** the cap hit (AAV, plus performance bonuses on ELC/35+ deals), 35+ status, retained cap charges and expiry status.
- **Real vs estimated:** imported contracts are marked `source: "real"` and are never rescaled. Players without a record get a structurally valid estimate marked `source: "estimated"`, shown as *est.* in the UI.

## `transactions/dead_cap.json`

```jsonc
{
  "schemaVersion": 1,
  "charges": [
    { "teamAbbr": "NYR", "season": 2026, "amount": 1500, "kind": "buyout", "playerName": "Player Name", "note": "optional" }
  ]
}
```

`kind` is one of `buyout`, `bonusOverage`, `thirtyFivePlus`, `termination`, `recapture` or `other`. Salary retained on traded players belongs in the contract record (`retained`), not here.

## Getting real contract data

The current build has no contract database, so every contract is an estimate. Public cap sites (for example capwages.com or puckpedia.com) publish per-year salary, bonus and clause data. To import them:

1. Allow one of these sites in the environment's network settings.
2. Run an importer that writes `contracts/contracts.json` and `transactions/dead_cap.json` in the schemas above.
