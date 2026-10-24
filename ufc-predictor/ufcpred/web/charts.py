"""Server-rendered inline SVG charts. Colours come from CSS custom properties (see style.css),
so light/dark themes swap in one place. Every mark carries a hover tooltip."""
from __future__ import annotations

import html


def _esc(s) -> str:
    return html.escape(str(s), quote=True)


def calibration(table: list[dict], width: int = 360, height: int = 300) -> str:
    """Reliability diagram on predicted-winner probability (bins 0.5–1.0)."""
    if not any(t["n"] for t in table):
        return '<p class="muted">No graded predictions yet.</p>'
    pad_l, pad_b, pad_t, pad_r = 44, 36, 12, 12
    W, H = width - pad_l - pad_r, height - pad_t - pad_b
    x = lambda v: pad_l + (v - 0.5) / 0.5 * W
    y = lambda v: pad_t + (1 - (v - 0.3) / 0.7) * H
    out = [f'<svg class="chart" style="max-width:440px" viewBox="0 0 {width} {height}" role="img" aria-label="Calibration: stated '
           f'confidence versus observed accuracy">']
    for t in (0.3, 0.5, 0.7, 0.9, 1.0):
        out.append(f'<line class="grid" x1="{pad_l}" x2="{pad_l + W}" y1="{y(t):.1f}" y2="{y(t):.1f}"/>'
                   f'<text class="tick" x="{pad_l - 6}" y="{y(t) + 4:.1f}" text-anchor="end">{t:.0%}</text>')
    for t in (0.5, 0.6, 0.7, 0.8, 0.9, 1.0):
        out.append(f'<text class="tick" x="{x(t):.1f}" y="{pad_t + H + 16}" text-anchor="middle">{t:.0%}</text>')
    out.append(f'<line class="ref" x1="{x(0.5):.1f}" y1="{y(0.5):.1f}" x2="{x(1):.1f}" y2="{y(1):.1f}"/>')
    out.append(f'<text class="axis-label" x="{pad_l + W / 2}" y="{height - 4}" text-anchor="middle">'
               f'Stated probability for predicted winner</text>')
    pts = []
    for t in table:
        if not t["n"]:
            continue
        cx, cy = x(t["mean_conf"]), y(max(t["accuracy"], 0.3))
        lo, hi = y(max(t["ci_low"], 0.3)), y(min(t["ci_high"], 1.0))
        pts.append((cx, cy))
        tip = (f"{t['bin']}: stated {t['mean_conf']:.1%}, observed {t['accuracy']:.1%} "
               f"(95% CI {t['ci_low']:.0%}–{t['ci_high']:.0%}), n={t['n']}")
        out.append(f'<g class="mark"><title>{_esc(tip)}</title><line class="ci" x1="{cx:.1f}" x2="{cx:.1f}" '
                   f'y1="{lo:.1f}" y2="{hi:.1f}"/><circle class="dot s1" cx="{cx:.1f}" cy="{cy:.1f}" r="5"/>'
                   f'<circle class="hit" cx="{cx:.1f}" cy="{cy:.1f}" r="14"/></g>')
    if len(pts) > 1:
        out.insert(-len(pts), '<polyline class="line s1" points="' + " ".join(f"{a:.1f},{b:.1f}" for a, b in pts) + '"/>')
    out.append("</svg>")
    return "".join(out)


def line(series: list[dict], key: str, label: str, fmt: str = "{:.1%}", baseline: float | None = None,
         baseline_label: str = "", width: int = 640, height: int = 220, lo: float | None = None,
         hi: float | None = None) -> str:
    if len(series) < 2:
        return '<p class="muted">Not enough graded fights for a trend yet.</p>'
    vals = [s[key] for s in series]
    lo = min(vals + ([baseline] if baseline is not None else [])) if lo is None else lo
    hi = max(vals + ([baseline] if baseline is not None else [])) if hi is None else hi
    if hi - lo < 1e-9:
        hi = lo + 0.01
    pad_l, pad_b, pad_t, pad_r = 48, 26, 12, 12
    W, H = width - pad_l - pad_r, height - pad_t - pad_b
    n = len(series)
    x = lambda i: pad_l + i / (n - 1) * W
    y = lambda v: pad_t + (1 - (v - lo) / (hi - lo)) * H
    out = [f'<svg class="chart linechart" viewBox="0 0 {width} {height}" role="img" aria-label="{_esc(label)}" '
           f'data-n="{n}">']
    for k in range(5):
        v = lo + (hi - lo) * k / 4
        out.append(f'<line class="grid" x1="{pad_l}" x2="{pad_l + W}" y1="{y(v):.1f}" y2="{y(v):.1f}"/>'
                   f'<text class="tick" x="{pad_l - 6}" y="{y(v) + 4:.1f}" text-anchor="end">{_esc(fmt.format(v))}</text>')
    if baseline is not None:
        out.append(f'<line class="ref" x1="{pad_l}" x2="{pad_l + W}" y1="{y(baseline):.1f}" y2="{y(baseline):.1f}"/>'
                   f'<text class="tick" x="{pad_l + W}" y="{y(baseline) - 4:.1f}" text-anchor="end">'
                   f'{_esc(baseline_label)}</text>')
    pts = " ".join(f"{x(i):.1f},{y(v):.1f}" for i, v in enumerate(vals))
    out.append(f'<polyline class="line s1" points="{pts}"/>')
    step = max(1, n // 60)
    for i in range(0, n, step):
        s = series[i]
        tip = f"Fight #{s['i']} ({s['date']}): {label} {fmt.format(s[key])} over last {s['n']}"
        out.append(f'<g class="mark"><title>{_esc(tip)}</title><rect class="hit" x="{x(i) - W / n * step / 2:.1f}" '
                   f'y="{pad_t}" width="{max(W / n * step, 2):.1f}" height="{H}"/></g>')
    out.append(f'<text class="tick" x="{pad_l}" y="{height - 6}">{_esc(series[0]["date"])}</text>'
               f'<text class="tick" x="{pad_l + W}" y="{height - 6}" text-anchor="end">{_esc(series[-1]["date"])}</text>')
    out.append("</svg>")
    return "".join(out)


def prob_bar(p_red: float, red: str, blue: str, interval=None) -> str:
    r = max(min(p_red, 1), 0) * 100
    tip_r, tip_b = f"{red}: {p_red:.1%}", f"{blue}: {1 - p_red:.1%}"
    ci = ""
    if interval:
        a, b = interval
        ci = (f'<span class="pb-ci" style="left:{a * 100:.1f}%;width:{max((b - a) * 100, 0.5):.1f}%" '
              f'title="80% uncertainty interval for {_esc(red)}: {a:.0%}–{b:.0%}"></span>')
    return (f'<div class="probbar" role="img" aria-label="{_esc(tip_r)}; {_esc(tip_b)}">'
            f'<span class="pb-red" style="width:{r:.1f}%" title="{_esc(tip_r)}"></span>'
            f'<span class="pb-blue" style="width:{100 - r:.1f}%" title="{_esc(tip_b)}"></span>{ci}</div>')


def hbars(items: list[tuple[str, float, str]], fmt: str = "{:.0%}", maxv: float | None = None) -> str:
    """Horizontal bars: (label, value, css class)."""
    if not items:
        return ""
    maxv = maxv or max(v for _, v, _ in items) or 1
    rows = []
    for lab, v, cls in items:
        rows.append(f'<div class="hb-row" title="{_esc(lab)}: {_esc(fmt.format(v))}"><span class="hb-label">{_esc(lab)}'
                    f'</span><span class="hb-track"><span class="hb-bar {cls}" style="width:{v / maxv * 100:.1f}%">'
                    f'</span></span><span class="hb-val">{_esc(fmt.format(v))}</span></div>')
    return '<div class="hbars">' + "".join(rows) + "</div>"
