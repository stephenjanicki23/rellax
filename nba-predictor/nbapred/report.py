"""Generate a Markdown report of graded performance and learning decisions, straight from the database."""
from __future__ import annotations

from . import ledger, services
from .util import loads, utcnow


def _pct(v, d=1):
    return "—" if v is None else f"{v * 100:.{d}f}%"


def build(conn, mode: str = "replay") -> str:
    perf = services.performance(conn, mode)
    lines = [f"# {'Historical replay' if mode == 'replay' else 'Live'} report", "",
             f"_Generated {utcnow()} by `python -m nbapred report --mode {mode}` from the database; "
             "every number below is computed by the pipeline._", ""]
    if not perf.get("n"):
        return "\n".join(lines + ["No graded predictions."])
    evs = conn.execute("""SELECT MIN(e.date), MAX(e.date), COUNT(DISTINCT e.id) FROM prediction_locks l
                          JOIN events e ON e.id=l.event_id WHERE l.mode=?""", (mode,)).fetchone()
    n_pred = conn.execute("SELECT COUNT(*) FROM predictions WHERE mode=?", (mode,)).fetchone()[0]
    v = ledger.verify(conn)
    lines += [
        "## Protocol", "",
        f"* {evs[2]} real NBA game nights from {evs[0]} to {evs[1]}, processed one night at a time in date order.",
        "* For each night: predict with the active model using only games strictly before that date → lock in the "
        "ledger → grade against the official final score → run the learning loop with data up to the next day "
        "(retraining is considered once enough new games have accumulated).",
        f"* {n_pred} predictions locked; {perf['n']} graded.",
        f"* Ledger verification: {'intact' if v['ok'] else 'FAILED'} ({v['rows']} rows, hash chain checked).",
        "* Data: NBA.com team box scores via the NocturneBear/NBA-Data-2010-2024 GitHub mirror. No betting lines were "
        "stored for these seasons, so there is no market baseline or against-the-spread record here.", "",
        "## Winner prediction and probability quality", "",
        "| Metric | Value | 95% interval |", "| --- | --- | --- |",
        f"| Accuracy (n={perf['n']}) | {_pct(perf['accuracy'])} | {_pct(perf['accuracy_ci'][0])}–{_pct(perf['accuracy_ci'][1])} (Wilson) |",
        f"| Log loss | {perf['log_loss']:.4f} | {perf['log_loss_ci'][0]:.4f}–{perf['log_loss_ci'][1]:.4f} (night bootstrap) |",
        f"| Brier | {perf['brier']:.4f} | {perf['brier_ci'][0]:.4f}–{perf['brier_ci'][1]:.4f} |",
        f"| ECE (5 bins) | {_pct(perf['ece'])} | |", "",
        "### Baselines on the same games", "", "| Model | Log loss | Brier | Accuracy |", "| --- | --- | --- | --- |",
        f"| **This engine** | **{perf['log_loss']:.4f}** | {perf['brier']:.4f} | {_pct(perf['accuracy'])} |"]
    for name, b in perf["baselines"].items():
        if b:
            lines.append(f"| {name} | {b['log_loss']:.4f} | {b['brier']:.4f} | {_pct(b['accuracy'])} |")
    lines += ["", "### Calibration (probability given to the predicted winner)", "",
              "| Band | n | Mean stated | Observed | 95% CI |", "| --- | --- | --- | --- | --- |"]
    for b in perf["calibration"]:
        if b["n"]:
            lines.append(f"| {b['bin']} | {b['n']} | {_pct(b['mean_conf'])} | {_pct(b['accuracy'])} | "
                         f"{_pct(b['ci_low'], 0)}–{_pct(b['ci_high'], 0)} |")
    lines += ["", "### Rolling windows", "", "| Window | Accuracy | Log loss |", "| --- | --- | --- |"]
    for w in perf["windows"]:
        if w["accuracy"] is not None:
            lines.append(f"| last {w['n']} | {_pct(w['accuracy'])} | {w['log_loss']:.3f} |")
    mz = perf["margin_z"]
    lines += ["", "## Margin, winning-margin bands and totals", "",
              f"* Margin: mean absolute error {perf['margin_mae']:.2f} points (bias {perf['margin_bias']:+.2f}); "
              f"{_pct(mz['within_1sd'])} of results fell within one stated standard deviation "
              f"(a well-specified Normal would give 68.3%).",
              f"* Total points: mean absolute error {perf['total_mae']:.2f} (bias {perf['total_bias']:+.2f}, "
              "actual − projected).",
              f"* Overtime: {_pct(perf['overtime']['actual'])} of games, {_pct(perf['overtime']['stated'])} stated.",
              f"* Winner and band both right: {_pct(perf['bucket_accuracy'])}; 6-way (winner × band) log loss "
              f"{perf['bucket_log_loss']:.3f} (uniform guess 1.792).", "",
              "| Winning margin | Games | Share actual | Share stated |", "| --- | --- | --- | --- |"]
    for b, x in perf["bands"].items():
        lines.append(f"| {services.BUCKET_LABEL[b]} | {x['actual']} | {_pct(x['share_actual'])} | {_pct(x['share_stated'])} |")
    lines += ["", "## By confidence label", "", "| Label | n | Accuracy | Log loss |", "| --- | --- | --- | --- |"]
    for r in perf["by_confidence"]:
        lines.append(f"| {r['key']} | {r['n']} | {_pct(r['accuracy'])} | {r['log_loss']:.3f} |")
    lines += ["", "## By month", "", "| Month | n | Accuracy | Log loss |", "| --- | --- | --- | --- |"]
    for r in perf["by_month"]:
        lines.append(f"| {r['key']} | {r['n']} | {_pct(r['accuracy'])} | {r['log_loss']:.3f} |")
    lines += ["", "## Learning loop decisions", "", "| Date (as of) | Decision | Detail |", "| --- | --- | --- |"]
    for d in conn.execute("""SELECT d.*, COALESCE(lr.as_of, mv.training_cutoff, substr(d.decided_at, 1, 10)) AS as_of
                             FROM promotion_decisions d LEFT JOIN candidate_changes c ON c.id=d.candidate_change_id
                             LEFT JOIN learning_runs lr ON lr.id=c.learning_run_id
                             LEFT JOIN model_versions mv ON mv.id=d.candidate_version_id ORDER BY d.id"""):
        lines.append(f"| {d['as_of']} | {d['decision']} | {d['reason'].replace('|', '/')[:220]} |")
    counts = dict(conn.execute("SELECT decision, COUNT(*) FROM promotion_decisions GROUP BY decision").fetchall())
    lines += ["", "Decision counts: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())), ""]
    sup = conn.execute("""SELECT key, description, n, effect, q_value FROM weakness_hypotheses WHERE status='supported'
                          ORDER BY id""").fetchall()
    lines += ["## Weakness hypotheses that reached statistical support", ""]
    if sup:
        lines += ["| Hypothesis | n | Bias | q |", "| --- | --- | --- | --- |"]
        seen = set()
        for s in sup:
            if s["key"] in seen:
                continue
            seen.add(s["key"])
            lines.append(f"| {s['description']} | {s['n']} | {s['effect']:+.3f} | {s['q_value']:.3f} |")
    else:
        lines.append("None. No segment's bias survived the false-discovery-rate control at any learning run.")
    act = conn.execute("SELECT label, config_json, training_cutoff FROM model_versions WHERE status='active'").fetchone()
    if act:
        cfg = loads(act["config_json"])
        lines += ["", "## Active model at the end of the replay", "",
                  f"`{act['label']}` — trained on games before {act['training_cutoff']}; form half-life "
                  f"{cfg['half_life_days']:.0f} days, season prior {cfg['prior_games']:.0f} games, calibration "
                  f"{cfg['calibration']}, early-season gating {cfg['evidence_gating']}, three-point terms "
                  f"{cfg['style_v2']}, schedule-adjusted rating {cfg['opp_adjusted']}."]
    lines += ["", "## Reading these numbers", "",
              "* NBA favourites win often, so accuracy around two-thirds is typical for good public models; closing "
              "betting lines are the real benchmark and are not available for this replay.",
              "* Log loss and Brier matter more than accuracy: they reward honest probabilities.",
              "* A `refit` re-estimates the validated configuration on new data; it is not a claim of improvement. "
              "Only a `promote` reflects a methodology change that beat the incumbent out of sample."]
    return "\n".join(lines) + "\n"
