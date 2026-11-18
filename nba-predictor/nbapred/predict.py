"""Prediction service: full, explained predictions for a game night, written to the ledger."""
from __future__ import annotations

import math

import numpy as np

from . import ledger
from .config import ModelConfig
from .db import audit
from .evaluation import metrics as M
from .features.build import BUCKETS, StateCache, bucket_of
from .features.history import HistoryStore
from .models import engine, registry
from .providers.odds import devig
from .util import utcnow

BUCKET_LABEL = {"CLOSE": "by 1–5", "SOLID": "by 6–12", "BLOWOUT": "by 13+"}
KEY_STATS = ["n_games", "season_games", "wins", "losses", "elo", "net", "ortg", "drtg", "pace", "efg", "opp_efg",
             "tov_pct", "opp_tov_pct", "oreb_pct", "dreb_pct", "ftr", "opp_ftr", "fg3a_rate", "opp_fg3a_rate", "fg3_pct", "opp_fg3_pct", "adj_net",
             "win_pct", "d_net", "d_ortg", "d_drtg", "d_win", "d_perf", "d_opp_elo", "streak", "last10", "margin_sd",
             "close_win", "blowout_loss", "days_rest", "b2b", "games_last_4", "travel_km", "tz_shift", "road_trip",
             "venue_elevation", "is_home", "out", "early_season", "box_coverage", "prev_season", "debut"]


def odds_before(conn, game_id: int, as_of: str):
    row = conn.execute("SELECT * FROM odds WHERE game_id=? AND captured_at<=? ORDER BY captured_at DESC, id DESC LIMIT 1",
                       (game_id, as_of + "T23:59:59")).fetchone()
    return dict(row) if row else None


def historical_calibration(conn, mode: str, conf: float) -> dict | None:
    rows = conn.execute(
        """SELECT p.p_home, e.correct_winner FROM prediction_evaluations e JOIN predictions p ON p.id=e.prediction_id
           WHERE e.scored=1 AND p.mode=?""", (mode,)).fetchall()
    if not rows:
        return None
    p = np.array([r["p_home"] for r in rows])
    c = np.maximum(p, 1 - p)
    corr = np.array([r["correct_winner"] for r in rows], dtype=float)
    for lo, hi in zip(M.BINS[:-1], M.BINS[1:]):
        if lo <= conf < hi:
            m = (c >= lo) & (c < hi)
            n = int(m.sum())
            if n < 30:
                return {"bin": f"{lo:.1f}–{min(hi, 1):.1f}", "n": n, "sufficient": False}
            k = int(corr[m].sum())
            lo_ci, hi_ci = M.wilson(k, n)
            return {"bin": f"{lo:.1f}–{min(hi, 1):.1f}", "n": n, "sufficient": True, "accuracy": k / n,
                    "mean_conf": float(c[m].mean()), "ci": [lo_ci, hi_ci]}
    return None


def confidence(pred: dict, a: dict, b: dict, hist: dict | None) -> dict:
    sub = np.array(list(pred["submodel_p_home"].values()))
    disagreement = float(np.std(sub))
    sd = pred["logit_sd"]
    clip = lambda x: max(min(x, 1 - 1e-6), 1e-6)
    dis_logit = float(np.std([math.log(clip(x) / (1 - clip(x))) for x in sub]))
    total_sd = math.sqrt(sd ** 2 + dis_logit ** 2)
    z = pred["logit"]
    interval = [1 / (1 + math.exp(-(z - 1.2816 * total_sd))), 1 / (1 + math.exp(-(z + 1.2816 * total_sd)))]
    imputed = [c["feature"] for c in pred["contributions"] if c["imputed"]]
    min_games = min(a["season_games"], b["season_games"])
    reasons = []
    score = 1.0
    if min_games < 5:
        score -= 0.35
        reasons.append(f"early season: one team has played only {min_games} game(s), so ratings lean on last season")
    elif min_games < 15:
        score -= 0.15
        reasons.append(f"limited season sample (minimum {min_games} games played)")
    if a.get("out") is None or b.get("out") is None:
        score -= 0.05
        reasons.append("injury report not recorded for this game (players out are unknown)")
    elif max(a["out"], b["out"]) >= 2:
        score -= 0.15
        reasons.append(f"{max(a['out'], b['out'])} rotation players out on one side; the engine has little history "
                       "of how much that matters")
    # Uncertainty counts against confidence only when it puts the pick itself in doubt. Absolute spread grows
    # with how lopsided a game is, so fixed thresholds would mark down exactly the clearest games.
    fav_home = pred["p_home"] >= 0.5
    fav_low = interval[0] if fav_home else 1 - interval[1]
    if fav_low < 0.5:
        score -= 0.2
        reasons.append(f"wide model uncertainty: the 80% range ({fav_low:.0%} at the low end) includes the other "
                       f"team being favoured (logit sd {total_sd:.2f})")
    against = [k for k, v in pred["submodel_p_home"].items()
               if k in ("A_baseline", "B_form") and (v >= 0.5) != fav_home and abs(v - 0.5) > 0.03]
    if against:
        score -= 0.15
        reasons.append(f"sub-models disagree: {' and '.join(against)} favour the other team "
                       f"(sd of sub-model probabilities {disagreement:.2f})")
    if len(imputed) > 4:
        score -= 0.1
        reasons.append(f"{len(imputed)} inputs unknown and imputed")
    if hist and hist.get("sufficient") and abs(hist["accuracy"] - hist["mean_conf"]) > 0.08:
        score -= 0.1
        reasons.append(f"historical predictions in the {hist['bin']} band were miscalibrated "
                       f"({hist['accuracy']:.0%} correct vs {hist['mean_conf']:.0%} stated, n={hist['n']})")
    label = "High" if score >= 0.8 else "Medium" if score >= 0.5 else "Low"
    return {"label": label, "score": round(max(score, 0), 2), "logit_sd": sd, "submodel_disagreement": disagreement,
            "total_logit_sd": total_sd, "interval80_p_home": interval, "reasons": reasons,
            "historical_calibration": hist, "sufficient_data": min_games >= 15 and len(imputed) <= 4,
            "note": "Confidence describes how reliable this probability is, not how likely the favourite is to win."}


ADV = (("net", "Net rating", "{:+.1f}", 1), ("ortg", "Offensive rating", "{:.1f}", 1),
       ("drtg", "Defensive rating", "{:.1f}", -1), ("pace", "Pace", "{:.1f}", 0), ("efg", "Effective FG%", "{:.1%}", 1),
       ("tov_pct", "Turnover rate", "{:.1%}", -1), ("oreb_pct", "Offensive rebound %", "{:.1%}", 1),
       ("ftr", "Free-throw rate", "{:.3f}", 1), ("d_net", "Recent net rating", "{:+.1f}", 1), ("elo", "Elo", "{:.0f}", 1))


def explain(pred: dict, a: dict, b: dict, names: tuple[str, str]) -> dict:
    home, away = names
    contribs = sorted(pred["contributions"], key=lambda c: -abs(c["contribution"]))

    def item(c):
        return {"feature": c["feature"], "group": c["group"], "logit": round(c["contribution"], 4),
                "imputed": c["imputed"], "text": engine.describe_feature(c["feature"], a, b)}
    fav_home = [item(c) for c in contribs if c["contribution"] > 0.005][:5]
    fav_away = [item(c) for c in contribs if c["contribution"] < -0.005][:5]
    style = [item(c) for c in contribs if c["group"] == "C_style" and abs(c["contribution"]) > 0.005][:3]
    adv = []
    for k, lab, fmt, better in ADV:
        va, vb = a.get(k), b.get(k)
        if va is None or vb is None:
            adv.append({"stat": lab, "key": k, "home": None, "away": None, "edge": "unknown"})
            continue
        edge = "even" if better == 0 else "home" if (va - vb) * better > 0 else "away" if (va - vb) * better < 0 else "even"
        adv.append({"stat": lab, "key": k, "home": fmt.format(va), "away": fmt.format(vb), "edge": edge})
    unc = []
    for st, nm in ((a, home), (b, away)):
        if st["season_games"] < 10:
            unc.append(f"{nm} has played {st['season_games']} game(s) this season; ratings are mostly last season's, "
                       "pulled toward the league average.")
        if st.get("box_coverage") is not None and st["box_coverage"] < 0.8:
            unc.append(f"{nm}: full box scores exist for only {st['box_coverage']:.0%} of this season's games.")
        if st.get("out") is None:
            unc.append(f"{nm}: injury report not recorded (treated as unknown, not as 'everyone available').")
        if st.get("b2b") == 1.0:
            unc.append(f"{nm} is on the second night of a back-to-back.")
    imputed = sorted({c["feature"] for c in pred["contributions"] if c["imputed"]})
    if imputed:
        unc.append("Imputed (unknown) inputs: " + ", ".join(imputed) + ".")
    unc.append("Ratings are team-level: trades and roster changes show up only as games are played.")
    fav_is_home = pred["p_home"] >= 0.5
    dog = away if fav_is_home else home
    dog_factors = fav_away if fav_is_home else fav_home
    fail = [f"{dog}'s edge proves decisive: {f_['text']}." for f_ in dog_factors[:3]]
    p_dog = pred["p_away"] if fav_is_home else pred["p_home"]
    fail.append(f"{dog} wins outright ({p_dog:.0%}); a single NBA game is noisy — the margin's standard deviation "
                f"is about {pred['margin']['sigma']:.0f} points.")
    return {"favoring_home": fav_home, "favoring_away": fav_away, "statistical_advantages": adv,
            "style_interactions": style, "uncertainties": unc, "failure_modes": fail,
            "basis": "Factors are exact additive contributions to the calibrated log-odds from model inputs."}


def market_view(odds: dict | None, raw: dict, params: dict) -> dict | None:
    if not odds:
        return None
    out = {"bookmaker": odds.get("bookmaker"), "captured_at": odds["captured_at"],
           "used_in_model": "F_market" in params["groups"]}
    if odds.get("home_decimal") and odds.get("away_decimal"):
        ph, pa, over = devig(odds["home_decimal"], odds["away_decimal"])
        out.update(p_home=ph, p_away=pa, overround=over, home_decimal=odds["home_decimal"],
                   away_decimal=odds["away_decimal"])
    mu, sigma = raw["margin"]["mu"], raw["margin"]["sigma"]
    if odds.get("spread_home") is not None:
        out["spread_home"] = odds["spread_home"]
        out["p_home_covers"] = engine.p_home_covers(mu, sigma, odds["spread_home"])
        out["engine_spread_home"] = -mu
    if odds.get("total") is not None:
        out["total"] = odds["total"]
        out["p_over"] = engine.p_over(raw["total"]["mu"], raw["total"]["sd"], odds["total"])
    return out


def build_prediction(raw: dict, a: dict, b: dict, game: dict, names: tuple[str, str], params: dict,
                     version_label: str, hist: dict | None, odds: dict | None) -> dict:
    home_id, away_id = game["home_team_id"], game["away_team_id"]
    winner_home = raw["p_home"] >= 0.5
    win_side = "home" if winner_home else "away"
    bands = raw["margin"]["bands"]
    pb = bucket_of(max(abs(raw["margin"]["mu"]), 0.5))     # the band the expected margin falls in
    joint = sorted(((s, k, v) for s in ("home", "away") for k, v in bands[s].items()), key=lambda t: -t[2])
    pred = {
        "game_id": game["id"], "home": {"id": home_id, "name": names[0]}, "away": {"id": away_id, "name": names[1]},
        "p_home": raw["p_home"], "p_away": 1 - raw["p_home"],
        "predicted_winner_id": home_id if winner_home else away_id,
        "predicted_margin": raw["margin"]["mu"], "predicted_total": raw["total"]["mu"], "predicted_bucket": pb,
        "margin": raw["margin"], "bands": bands, "p_overtime": raw["p_overtime"], "total": raw["total"],
        "most_likely_outcomes": [{"side": s, "bucket": k, "p": v} for s, k, v in joint[:4]],
        "spread_view": {"engine_line_home": -raw["margin"]["mu"],
                        "note": "Engine line: the handicap that would make each side a 50% bet (home perspective)."},
        "submodels": raw["submodel_p_home"], "ensemble_weights": engine.ensemble_weights(params),
        "logit": raw["logit"], "contributions": raw["contributions"],
        "model": {"version": version_label, "config_fingerprint": ModelConfig.from_dict(params["config"]).fingerprint(),
                  "training_cutoff": params["cutoff"], "n_train": params["diagnostics"]["n_train"],
                  "calibration": {k: v for k, v in params["calibration"].items() if k != "isotonic"}},
        "market": market_view(odds, raw, params),
        "season_type": game.get("season_type"), "neutral_site": bool(game.get("neutral_site")),
        "stats": {"home": {k: a.get(k) for k in KEY_STATS}, "away": {k: b.get(k) for k in KEY_STATS}},
        "last5": {"home": a.get("last5"), "away": b.get("last5")},
    }
    hca = 0 if game.get("neutral_site") else params["config"].get("elo_home", 100.0)
    pred["baselines"] = {
        "elo_only_p_home": 1 / (1 + 10 ** (-(a["elo"] + hca - b["elo"]) / 400)),
        "home_team_p_home": 0.5 if game.get("neutral_site") else params["diagnostics"]["calibration_slice"]["home_win_rate"],
        "better_record_p_home": 0.5 if a["win_pct"] == b["win_pct"] else (0.6 if a["win_pct"] > b["win_pct"] else 0.4),
        "coin_flip_p_home": 0.5,
    }
    pred["confidence"] = confidence(raw, a, b, hist)
    pred["explanation"] = explain(raw, a, b, names)
    pred["data_quality"] = {
        "imputed_features": sorted({c["feature"] for c in raw["contributions"] if c["imputed"]}),
        "home_season_games": a["season_games"], "away_season_games": b["season_games"],
        "home_box_coverage": a.get("box_coverage"), "away_box_coverage": b.get("box_coverage"),
        "injury_report": a.get("out") is not None and b.get("out") is not None,
    }
    for side, p_side in (("home", pred["p_home"]), ("away", pred["p_away"])):
        assert abs(sum(bands[side].values()) - p_side) < 1e-6, "margin bands must reconcile with the win probability"
    return pred


def eligible_games(conn, event_id: int, mode: str) -> list[dict]:
    status = ("scheduled",) if mode == "live" else ("scheduled", "completed")
    rows = conn.execute(
        f"""SELECT g.*, e.date, th.name AS home_name, ta.name AS away_name FROM games g
            JOIN events e ON e.id=g.event_id JOIN teams th ON th.id=g.home_team_id JOIN teams ta ON ta.id=g.away_team_id
            WHERE g.event_id=? AND g.status IN ({','.join('?' * len(status))})
              AND g.season_type IN ('regular','playin','playoffs','cup_final')
              AND th.external_id LIKE 'nba:%' AND ta.external_id LIKE 'nba:%'
            ORDER BY COALESCE(g.tip_time_utc, ''), g.id""", (event_id, *status)).fetchall()
    return [dict(r) for r in rows]


def predict_event(conn, event_id: int, *, mode: str = "live", as_of: str | None = None, reason: str = "preliminary",
                  h: HistoryStore | None = None, cache: StateCache | None = None, version_id: int | None = None,
                  allow_post_lock: bool = False, game_ids: list[int] | None = None) -> list[int]:
    ev = conn.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
    if ev is None:
        raise KeyError(f"game night {event_id} not found")
    as_of = as_of or min(utcnow()[:10], ev["date"])
    if as_of > ev["date"]:
        raise ledger.LedgerError("cannot make a pre-game prediction after the game date")
    mv = conn.execute("SELECT * FROM model_versions WHERE id=?", (version_id,)).fetchone() if version_id \
        else registry.active_version(conn)
    if mv is None:
        raise RuntimeError("no active model version; run `nbapred train` (or the replay) first")
    params = registry.load_params(conn, mv["id"])
    if params["cutoff"] > as_of:
        raise ledger.LedgerError(f"model {mv['label']} was trained with data up to {params['cutoff']}, "
                                 f"after decision time {as_of}")
    cfg = params["config"]
    h = h or HistoryStore.load(conn, elo_k=cfg["elo_k"], elo_home=cfg.get("elo_home", 100.0))
    cache = cache or StateCache(h)
    games = eligible_games(conn, event_id, mode)
    if game_ids is not None:
        games = [g for g in games if g["id"] in set(game_ids)]
    if not games:
        return []
    metas = [dict(h.games[g["id"]]) for g in games]
    odds = {g["id"]: o for g in games if (o := odds_before(conn, g["id"], as_of))}
    raws, ds = engine.predict_metas(params, h, metas, as_of, cache, odds)
    audit_res = engine.leakage_audit(params, ds, as_of)
    if not audit_res["passed"]:
        raise ledger.LedgerError(f"leakage audit failed: {audit_res['problems']}")
    ids = []
    for g, raw, (a, b, _) in zip(games, raws, ds.pairs):
        conf_p = max(raw["p_home"], 1 - raw["p_home"])
        pred = build_prediction(raw, a, b, g, (g["home_name"], g["away_name"]), params, mv["label"],
                                historical_calibration(conn, mode, conf_p), odds.get(g["id"]))
        pred["leakage_audit"] = {"passed": True, "as_of": as_of}
        ids.append(ledger.record(conn, game=g, pred=pred, model_version_id=mv["id"], mode=mode, as_of=as_of,
                                 reason=reason, home_state=a, away_state=b, allow_post_lock=allow_post_lock,
                                 commit=False))
    audit(conn, "predictions.generated", "event", event_id, {"mode": mode, "count": len(ids), "reason": reason,
                                                             "model_version": mv["label"]})
    conn.commit()
    return ids


__all__ = ["predict_event", "build_prediction", "BUCKETS", "BUCKET_LABEL"]
