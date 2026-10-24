"""Historical provider: the public UFCStats CSV mirror.

Source: https://github.com/Greco1899/scrape_ufc_stats — a daily-refreshed scrape of
ufcstats.com published as CSV (GPL-3.0). We download it at runtime into the local cache
and never vendor it into this repository. Attribution is stored on every source record.

Caveats that are surfaced, not hidden:
  * UFCStats does not label corners. The first-listed fighter is stored in the red slot.
    The model never uses corner position as a feature.
  * Records are UFC-only. Pre-UFC professional records are not in this source.
  * Fighter "tale of the tape" (height, reach, stance, DOB) is the *current* profile. Those
    attributes are treated as time-invariant; stance changes are therefore not visible.
  * Fighters are referenced by name in bout rows. Identical names are resolved by listed
    weight and flagged as data-quality issues.
"""
from __future__ import annotations

import csv
import io
import os
from collections import defaultdict
from pathlib import Path

from ..util import sha256, utcnow
from . import parse as P
from .base import (Bundle, HistoricalProvider, PEvent, PFight, PFighter, PResult, PRoundStats,
                   SourceMeta)
from .http import fetch

FILES = ["ufc_event_details", "ufc_fight_results", "ufc_fight_stats", "ufc_fighter_details",
         "ufc_fighter_tott"]
LICENSE = "GPL-3.0 (Greco1899/scrape_ufc_stats); underlying data from ufcstats.com"
DEFAULT_BASE = "https://raw.githubusercontent.com/Greco1899/scrape_ufc_stats/main"


class UFCStatsMirrorProvider(HistoricalProvider):
    name = "ufcstats_mirror"

    def __init__(self, base_url: str = DEFAULT_BASE, local_dir: str | None = None,
                 max_age_s: float | None = 6 * 3600, min_interval_s: float = 1.0):
        self.base_url = base_url.rstrip("/")
        self.local_dir = local_dir or os.environ.get("UFCPRED_MIRROR_DIR")
        self.max_age_s = max_age_s
        self.min_interval_s = min_interval_s

    def _load(self, fname: str) -> tuple[list[dict], SourceMeta]:
        if self.local_dir:
            path = Path(self.local_dir) / f"{fname}.csv"
            text = path.read_text(encoding="utf-8")
            meta = SourceMeta(self.name, fname, f"file://{path}", utcnow(), sha256(text), "ok",
                              cache_path=str(path), license=LICENSE)
        else:
            text, meta = fetch(f"{self.base_url}/{fname}.csv", self.name, f"{fname}.csv",
                               min_interval_s=self.min_interval_s, max_age_s=self.max_age_s,
                               check_robots=False, license=LICENSE)
        rows = list(csv.DictReader(io.StringIO(text)))
        meta.rows = len(rows)
        return rows, meta

    def fetch_history(self) -> Bundle:
        b = Bundle(provider=self.name)
        data = {}
        for f in FILES:
            rows, meta = self._load(f)
            data[f] = rows
            b.sources.append(meta)

        # Events
        event_by_name = {}
        for r in data["ufc_event_details"]:
            eid = P.ufcstats_id(r.get("URL"))
            date = P.parse_long_date(r.get("DATE"))
            if not eid or not date:
                b.issues.append(("event", r.get("EVENT"), "unparseable_event", f"bad event row: {r}", "warning"))
                continue
            name = P.norm_name(r["EVENT"])
            ev = PEvent(eid, name, date, location=(r.get("LOCATION") or "").strip() or None,
                        source_url=r.get("URL"))
            event_by_name[name] = ev
            b.events.append(ev)

        # Fighters (tale of the tape carries the weight used for identity resolution)
        nick = {P.ufcstats_id(r["URL"]): (r.get("NICKNAME") or "").strip() or None
                for r in data["ufc_fighter_details"] if r.get("URL")}
        by_key = defaultdict(list)
        for r in data["ufc_fighter_tott"]:
            fid = P.ufcstats_id(r.get("URL"))
            if not fid:
                continue
            f = PFighter(fid, P.norm_name(r["FIGHTER"]), nickname=nick.get(fid),
                         dob=P.parse_long_date(r.get("DOB")), height_in=P.parse_height(r.get("HEIGHT")),
                         reach_in=P.parse_reach(r.get("REACH")), stance=(r.get("STANCE") or "").strip() or None,
                         listed_weight_lbs=P.parse_lbs(r.get("WEIGHT")))
            b.fighters.append(f)
            by_key[P.name_key(f.name)].append(f)
        for key, cands in by_key.items():
            if len(cands) > 1:
                b.issues.append(("fighter_name", cands[0].name, "duplicate_name",
                                 f"{len(cands)} distinct UFCStats fighters share the name '{cands[0].name}' "
                                 f"({', '.join(c.external_id for c in cands)}); bouts are resolved by listed weight",
                                 "warning"))

        def resolve(name: str, weight_class: str | None, fight_key: str):
            cands = by_key.get(P.name_key(name), [])
            if len(cands) == 1:
                return cands[0].external_id
            if not cands:
                synthetic = f"ufcstats-name:{P.name_key(name)}"
                if not any(f.external_id == synthetic for f in b.fighters):
                    b.fighters.append(PFighter(synthetic, P.norm_name(name)))
                    b.issues.append(("fighter", synthetic, "missing_profile",
                                     f"'{name}' appears in bouts but has no UFCStats profile row", "warning"))
                return synthetic
            limit = P.class_limit(weight_class)
            if limit is not None:
                scored = sorted(cands, key=lambda c: abs((c.listed_weight_lbs or 1e9) - limit))
                d0 = abs((scored[0].listed_weight_lbs or 1e9) - limit)
                d1 = abs((scored[1].listed_weight_lbs or 1e9) - limit)
                if d1 - d0 >= 10:
                    return scored[0].external_id
            b.issues.append(("fight", fight_key, "ambiguous_identity",
                             f"cannot disambiguate '{name}' between {[c.external_id for c in cands]}; "
                             f"first candidate used — verify manually", "error"))
            return cands[0].external_id

        # Fights and results
        seen_urls = set()
        fight_by_eb = {}
        for i, r in enumerate(data["ufc_fight_results"]):
            fid = P.ufcstats_id(r.get("URL"))
            ev = event_by_name.get(P.norm_name(r.get("EVENT", "")))
            if not fid or not ev:
                b.issues.append(("fight", r.get("URL"), "orphan_fight", f"fight without event/id: {r.get('BOUT')}",
                                 "warning"))
                continue
            if fid in seen_urls:
                b.issues.append(("fight", fid, "duplicate_fight",
                                 f"duplicate fight row for {r.get('BOUT')} at {ev.name}; later copy ignored", "warning"))
                continue
            seen_urls.add(fid)
            parts = r["BOUT"].split(" vs. ")
            if len(parts) != 2:
                b.issues.append(("fight", fid, "bad_bout", f"cannot split bout '{r['BOUT']}'", "error"))
                continue
            red, blue = P.norm_name(parts[0]), P.norm_name(parts[1])
            wc, is_title, is_women = P.parse_weight_class(r.get("WEIGHTCLASS"))
            rounds = P.parse_time_format(r.get("TIME FORMAT"))
            red_id, blue_id = resolve(red, wc, fid), resolve(blue, wc, fid)
            if red_id == blue_id:
                b.issues.append(("fight", fid, "self_fight", f"both corners resolve to {red_id}", "error"))
                continue
            b.fights.append(PFight(fid, ev.external_id, red, blue, red_id, blue_id, wc, is_title, is_women,
                                   rounds, (r.get("TIME FORMAT") or "").strip() or None))
            fight_by_eb[(ev.name, P.norm_name(r["BOUT"]))] = (fid, red, blue)

            oc = (r.get("OUTCOME") or "").strip()
            if oc == "W/L":
                outcome, corner = "win", "red"
            elif oc == "L/W":
                outcome, corner = "win", "blue"
            elif oc == "D/D":
                outcome, corner = "draw", None
            elif oc == "NC/NC":
                outcome, corner = "nc", None
            else:
                b.issues.append(("fight", fid, "unknown_outcome", f"outcome '{oc}'", "error"))
                continue
            method, detail = P.parse_method(r.get("METHOD"), outcome)
            rnd = P.parse_int(r.get("ROUND"))
            b.results.append(PResult(fid, outcome, corner, method, detail, rnd, P.parse_clock(r.get("TIME")),
                                     referee=(r.get("REFEREE") or "").strip() or None,
                                     details=(r.get("DETAILS") or "").strip() or None, source_url=r.get("URL")))

        # Per-round stats
        for r in data["ufc_fight_stats"]:
            if not r.get("ROUND"):
                continue
            key = (P.norm_name(r["EVENT"]), P.norm_name(r["BOUT"]))
            hit = fight_by_eb.get(key)
            if not hit:
                continue
            fid, red, blue = hit
            name = P.norm_name(r["FIGHTER"])
            corner = "red" if name == red else "blue" if name == blue else None
            if corner is None:
                b.issues.append(("fight", fid, "stats_name_mismatch", f"stats row for '{name}' matches neither corner",
                                 "warning"))
                continue
            rnd = P.parse_int(r["ROUND"].replace("Round", ""))
            st = {"kd": P.parse_int(r.get("KD")), "sub_att": P.parse_int(r.get("SUB.ATT")),
                  "rev": P.parse_int(r.get("REV.")), "ctrl_sec": P.parse_clock(r.get("CTRL"))}
            for col, key2 in (("SIG.STR.", "sig"), ("TOTAL STR.", "tot"), ("TD", "td"), ("HEAD", "head"),
                              ("BODY", "body"), ("LEG", "leg"), ("DISTANCE", "dist"), ("CLINCH", "clinch"),
                              ("GROUND", "ground")):
                landed, att = P.parse_of(r.get(col))
                st[f"{key2}_l"], st[f"{key2}_a"] = landed, att
            b.stats.append(PRoundStats(fid, corner, rnd, st))
        return b
