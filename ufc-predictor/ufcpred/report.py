"""Generate a Markdown report of graded performance and learning decisions, straight from the database."""
from __future__ import annotations

from . import ledger, services
from .util import loads, utcnow


def _pct(v, d=1):
    return "—" if v is None else f"{v * 100:.{d}f}%"


def build(conn, mode: str = "replay") -> str:
    perf = services.performance(conn, mode)
    lines = [f"# {'Historical replay' if mode == 'replay' else 'Live'} report", "",
             f"_Generated {utcnow()} by `python -m ufcpred report --mode {mode}` from the database; "
             "every number below is computed by the pipeline._", ""]
    if not perf.get("n"):
        return "\n".join(lines + ["No graded predictions."])
    evs = conn.execute("""SELECT MIN(e.date), MAX(e.date), COUNT(DISTINCT e.id) FROM prediction_locks l
                          JOIN events e ON e.id=l.event_id WHERE l.mode=?""", (mode,)).fetchone()
    n_pred = conn.execute("SELECT COUNT(*) FROM predictions WHERE mode=?", (mode,)).fetchone()[0]
    excl = conn.execute("""SELECT COUNT(*) FROM prediction_evaluations e JOIN predictions p ON p.id=e.prediction_id
                           WHERE p.mode=? AND e.scored=0""", (mode,)).fetchone()[0]
    v = ledger.verify(conn)
    lines += [
        "## Protocol", "",
        f"* {evs[2]} real UFC events from {evs[0]} to {evs[1]}, processed one at a time in date order.",
        "* For each event: predict with the active model using only fights strictly before the event date → lock "
        "in the ledger → grade against the official result → run the learning loop with data up to the day after.",
        f"* {n_pred} predictions locked; {perf['n']} graded on winner; {excl} draws/no-contests recorded but not scored.",
        f"* Ledger verification: {'intact' if v['ok'] else 'FAILED'} ({v['rows']} rows, hash chain checked).",
        "* Data: UFCStats CSV mirror (github.com/Greco1899/scrape_ufc_stats, GPL-3.0). No betting odds were available, "
        "so there is no market baseline.", "",
        "## Winner prediction and probability quality", "",
        "| Metric | Value | 95% interval |", "| --- | --- | --- |",
        f"| Accuracy (n={perf['n']}) | {_pct(perf['accuracy'])} | {_pct(perf['accuracy_ci'][0])}–{_pct(perf['accuracy_ci'][1])} (Wilson) |",
        f"| Log loss | {perf['log_loss']:.4f} | {perf['log_loss_ci'][0]:.4f}–{perf['log_loss_ci'][1]:.4f} (event bootstrap) |",
        f"| Brier | {perf['brier']:.4f} | {perf['brier_ci'][0]:.4f}–{perf['brier_ci'][1]:.4f} |",
        f"| ECE (5 bins) | {_pct(perf['ece'])} | |", "",
        "### Baselines on the same fights", "", "| Model | Log loss | Brier | Accuracy |", "| --- | --- | --- | --- |",
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
    lines += ["", "## Method and round", "", "| Method | Actual | Predicted | Recall | Precision |", "| --- | --- | --- | --- | --- |"]
    for m, x in perf["method"].items():
        lines.append(f"| {services.METHOD_LABEL[m]} | {x['actual']} | {x['predicted']} | {_pct(x['recall'])} | {_pct(x['precision'])} |")
    lines += ["", f"8-way (corner × method) log loss {perf.get('method_mc_log_loss', 0):.3f} (uniform guess 2.079); "
              f"round/decision accuracy {_pct(perf['round_accuracy'])}.", "",
              "## By confidence label", "", "| Label | n | Accuracy | Log loss |", "| --- | --- | --- | --- |"]
    for r in perf["by_confidence"]:
        lines.append(f"| {r['key']} | {r['n']} | {_pct(r['accuracy'])} | {r['log_loss']:.3f} |")
    lines += ["", "## Learning loop decisions", "",
              "| Date (as of) | Decision | Detail |", "| --- | --- | --- |"]
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
            lines.append(f"| {s['description']} | {s['n']} | {s['effect'] * 100:+.1f} pts | {s['q_value']:.3f} |")
    else:
        lines.append("None. No segment's bias survived the false-discovery-rate control at any learning run.")
    act = conn.execute("SELECT label, config_json, training_cutoff FROM model_versions WHERE status='active'").fetchone()
    if act:
        cfg = loads(act["config_json"])
        lines += ["", "## Active model at the end of the replay", "",
                  f"`{act['label']}` — trained on fights before {act['training_cutoff']}; half-life "
                  f"{cfg['half_life_days']:.0f} days, calibration {cfg['calibration']}, evidence gating "
                  f"{cfg['evidence_gating']}, style v2 {cfg['style_v2']}."]
    lines += ["", "## Reading these numbers", "",
              "* A ~60–65% winner accuracy without odds is typical for UFC models; closing betting lines "
              "usually do better, and this report cannot compare against them because no odds were available.",
              "* The 'more-experienced fighter' base rate is estimated from fights before each model's cutoff "
              "(≈51% from 2005 on); if it falls below a coin flip here, the experience edge reversed in this "
              "period. It is reported as measured.",
              "* Intervals are wide: a few points of accuracy is within noise at this sample size.",
              "* A `refit` re-estimates the validated configuration on new data; it is not a claim of improvement. "
              "Only a `promote` reflects a methodology change that beat the incumbent out of sample."]
    return "\n".join(lines) + "\n"
