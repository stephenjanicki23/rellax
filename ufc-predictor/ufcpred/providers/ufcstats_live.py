"""Upcoming-card provider: ufcstats.com upcoming events (HTML).

Respects robots.txt and a minimum request interval, and caches every page. The parser
targets the public UFCStats markup (`b-statistics__table-events` rows and
`b-fight-details__table-row` bout rows). If the markup changes the provider raises
ProviderError rather than guessing — a card is never invented.

Note: ufcstats.com is plain HTTP and was unreachable from the environment this engine was
built in, so this adapter is covered by fixture-based tests only. Use the manual JSON/CSV
import (`templates/import/`) when it cannot reach the site.
"""
from __future__ import annotations

import html
import re

from . import parse as P
from .base import Bundle, PEvent, PFight, ProviderError, UpcomingProvider
from .http import fetch

BASE = "http://ufcstats.com"
_EVENT_ROW = re.compile(
    r'<a href="(?P<url>https?://ufcstats\.com/event-details/[0-9a-f]+)"[^>]*>\s*(?P<name>[^<]+?)\s*</a>\s*'
    r'<span class="b-statistics__date">\s*(?P<date>[^<]+?)\s*</span>.*?'
    r'<td class="b-statistics__table-col b-statistics__table-col_style_big-top-padding">\s*(?P<loc>[^<]*?)\s*</td>',
    re.S)
_FIGHT_ROW = re.compile(r'<tr class="b-fight-details__table-row[^"]*"[^>]*data-link="(?P<url>[^"]+)"(?P<body>.*?)</tr>',
                        re.S)
_FIGHTER_LINK = re.compile(r'<a[^>]+href="(?P<url>https?://ufcstats\.com/fighter-details/[0-9a-f]+)"[^>]*>\s*'
                           r'(?P<name>[^<]+?)\s*</a>', re.S)
_WEIGHT = re.compile(r'<p class="b-fight-details__table-text">\s*((?:Women\'s )?[A-Z][a-z]+(?: [A-Z][a-z]+)?'
                     r'(?:weight)?)\s*</p>', re.S)


def parse_upcoming_list(page: str) -> list[PEvent]:
    out = []
    for m in _EVENT_ROW.finditer(page):
        date = P.parse_long_date(html.unescape(m.group("date")))
        eid = P.ufcstats_id(m.group("url"))
        if date and eid:
            out.append(PEvent(eid, P.norm_name(html.unescape(m.group("name"))), date,
                              location=html.unescape(m.group("loc")).strip() or None, source_url=m.group("url")))
    return out


def describe_page(page: str) -> str:
    """A short, safe description of an unexpected page, for the error message."""
    title = re.search(r"<title[^>]*>(.*?)</title>", page or "", re.S | re.I)
    text = re.sub(r"\s+", " ", re.sub(r"<script.*?</script>|<style.*?</style>|<[^>]+>", " ", page or "", flags=re.S | re.I))
    table = "events table present but no rows matched (markup changed)" if "b-statistics__table-events" in (page or "") \
        else "no events table"
    return (f"{len(page or '')} characters; title {html.unescape(title.group(1).strip()) if title else 'none'!r}; "
            f"{table}; text starts {html.unescape(text.strip())[:160]!r}")


def parse_event_card(page: str, event: PEvent) -> list[PFight]:
    fights = []
    for order, m in enumerate(_FIGHT_ROW.finditer(page), start=1):
        links = _FIGHTER_LINK.findall(m.group("body"))
        if len(links) < 2:
            continue
        (red_url, red), (blue_url, blue) = links[0], links[1]
        wm = _WEIGHT.search(m.group("body"))
        wc, is_title, is_women = P.parse_weight_class(wm.group(1) if wm else None)
        is_title = is_title or "belt.png" in m.group("body")
        fid = P.ufcstats_id(m.group("url")) or f"{event.external_id}:{order}"
        fights.append(PFight(fid, event.external_id, P.norm_name(html.unescape(red)), P.norm_name(html.unescape(blue)),
                             P.ufcstats_id(red_url), P.ufcstats_id(blue_url), wc, is_title, is_women,
                             scheduled_rounds=5 if (order == 1 or is_title) else 3,
                             card_segment="main" if order <= 5 else "prelim", bout_order=order))
    return fights


class UFCStatsLiveProvider(UpcomingProvider):
    name = "ufcstats_live"

    def __init__(self, min_interval_s: float = 2.0, max_events: int = 2):
        self.min_interval_s = min_interval_s
        self.max_events = max_events

    def fetch_upcoming(self) -> Bundle:
        b = Bundle(provider=self.name)
        page, meta = fetch(f"{BASE}/statistics/events/upcoming", self.name, "events_upcoming.html",
                           min_interval_s=self.min_interval_s, max_age_s=1800)
        b.sources.append(meta)
        events = parse_upcoming_list(page)
        if not events:
            # never report "nothing new" when the page simply wasn't what we expected: say what came back
            raise ProviderError("UFCStats upcoming page gave no events (" + describe_page(page) + ")")
        for ev in sorted(events, key=lambda e: e.date)[: self.max_events]:
            card, meta2 = fetch(ev.source_url, self.name, f"event_{ev.external_id.split(':')[1]}.html",
                                min_interval_s=self.min_interval_s, max_age_s=1800)
            b.sources.append(meta2)
            fights = parse_event_card(card, ev)
            if not fights:
                b.issues.append(("event", ev.external_id, "empty_card",
                                 "event page listed no bouts (card not yet announced or markup changed)", "warning"))
            b.events.append(ev)
            b.fights.extend(fights)
            b.issues.append(("event", ev.external_id, "rounds_inferred",
                             "scheduled rounds inferred (main event/title = 5, otherwise 3); card segments inferred "
                             "from bout order — confirm via manual import if they matter", "info"))
        return b
