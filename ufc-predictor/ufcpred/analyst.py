"""AI analyst layer: narrative explanation of evidence, never a source of probabilities.

The deterministic analyst builds the required structured report directly from pipeline
outputs. The optional Claude analyst (`analyst.provider = anthropic`, `ANTHROPIC_API_KEY`)
may only rewrite the *narrative* fields; the experiment result and promotion decision are
always copied from the pipeline after the model responds, so an eloquent explanation
can never change a number or a decision.
"""
from __future__ import annotations

import json
import os

from .util import dumps, utcnow

NARRATIVE_FIELDS = ["observed_error", "supporting_evidence", "proposed_explanation", "confidence_in_explanation",
                    "proposed_change", "historical_support", "experiment_required"]
MODEL = "claude-opus-5-5"


def deterministic_report(event_summary: dict, hypotheses: list[dict], candidates: list[dict]) -> dict:
    items = []
    by_hyp = {}
    for c in candidates:
        by_hyp.setdefault(c.get("hypothesis_key"), []).append(c)
    for h in hypotheses:
        if h["status"] != "supported":
            continue
        cs = by_hyp.get(h["key"], [])
        items.append({
            "observed_error": f"{h['description']}: mean residual {h['effect']:+.3f} (actual − predicted win rate)",
            "supporting_evidence": f"n={h['n']} graded fights; 95% event-clustered CI [{h['ci_low']:+.3f}, "
                                   f"{h['ci_high']:+.3f}]; p={h['p_value']:.4f}, BH q={h['q_value']:.3f}",
            "proposed_explanation": h.get("interpretation", ""),
            "confidence_in_explanation": "moderate" if (h["q_value"] or 1) < 0.05 else "low",
            "proposed_change": "; ".join(c["description"] for c in cs) or "no mapped change",
            "historical_support": f"segment residuals computed over all graded {h['n']} fights, not one card",
            "experiment_required": "rolling-origin backtest of incumbent vs candidate on identical folds",
            "experiment_result": [c.get("result_summary") for c in cs],
            "promotion_decision": [c.get("status") for c in cs],
        })
    untested = [h["key"] for h in hypotheses if h["status"] == "insufficient_data"]
    return {
        "event": event_summary,
        "findings": items,
        "routine_experiments": [{"description": c["description"], "experiment_result": c.get("result_summary"),
                                 "promotion_decision": c.get("status")} for c in candidates
                                if not c.get("hypothesis_key")],
        "hypotheses_without_enough_data": untested,
        "caveat": "Narrative explanations are hypotheses. Only the backtest decides whether the model changes.",
    }


def anthropic_report(base: dict) -> dict:
    """Ask Claude to improve the narrative fields only. Returns base unchanged on any failure."""
    if not os.environ.get("ANTHROPIC_API_KEY") or not base["findings"]:
        return base
    try:
        import anthropic
    except ImportError:
        base["analyst_note"] = "anthropic SDK not installed; deterministic analyst used"
        return base
    schema = {"type": "object", "additionalProperties": False, "required": ["findings"],
              "properties": {"findings": {"type": "array", "items": {
                  "type": "object", "additionalProperties": False, "required": NARRATIVE_FIELDS,
                  "properties": {k: {"type": "string"} for k in NARRATIVE_FIELDS}}}}}
    prompt = ("You are the analyst for a UFC prediction model. Below are statistically tested findings from the "
              "model's own graded predictions. For each finding, write clear narrative fields. Do not invent "
              "numbers: quote only figures present in the input. Say plainly when evidence is weak. Keep the same "
              "order and count of findings.\n\n" + dumps(base["findings"]))
    try:
        client = anthropic.Anthropic()
        resp = client.beta.messages.create(
            model=MODEL, max_tokens=16000, betas=["server-side-fallback-2026-07-01"], fallbacks="default",
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": schema}},
            messages=[{"role": "user", "content": prompt}])
        if resp.stop_reason == "refusal":
            base["analyst_note"] = "LLM declined; deterministic narrative kept"
            return base
        text = next(b.text for b in resp.content if b.type == "text")
        out = json.loads(text)["findings"]
    except Exception as e:  # network, auth, schema — never block the learning loop
        base["analyst_note"] = f"LLM analyst unavailable ({type(e).__name__}); deterministic narrative kept"
        return base
    merged = []
    for orig, new in zip(base["findings"], out):
        m = dict(orig)
        m.update({k: new[k] for k in NARRATIVE_FIELDS if k in new})
        m["experiment_result"] = orig["experiment_result"]          # always from the pipeline
        m["promotion_decision"] = orig["promotion_decision"]
        merged.append(m)
    base = dict(base, findings=merged, analyst_note=f"narrative by {MODEL}; numbers and decisions from pipeline")
    return base


def write_report(conn, learning_run_id: int, event_id: int | None, event_summary: dict, hypotheses: list[dict],
                 candidates: list[dict], provider: str = "deterministic") -> dict:
    rep = deterministic_report(event_summary, hypotheses, candidates)
    used = "deterministic"
    if provider == "anthropic":
        rep = anthropic_report(rep)
        used = "anthropic" if "narrative by" in rep.get("analyst_note", "") else "deterministic"
    conn.execute("INSERT INTO analyst_reports(learning_run_id, event_id, provider, structured_json, created_at) "
                 "VALUES (?,?,?,?,?)", (learning_run_id, event_id, used, dumps(rep), utcnow()))
    conn.commit()
    return rep
