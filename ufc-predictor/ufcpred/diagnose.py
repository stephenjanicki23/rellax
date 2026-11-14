"""Read-only page check: render recent event and fight pages and print the traceback of any that fail.

Run against the deployed database (GitHub Actions `diagnose` job) to find pages that return
"Internal server error" on the live site. It only issues GET requests.
"""
import sys
import traceback

from fastapi.testclient import TestClient


def main(n_events: int = 3) -> int:
    from .db import connect
    from .web.app import app
    conn = connect()
    events = conn.execute("SELECT id, name, date FROM events ORDER BY date DESC, id DESC LIMIT ?",
                          (n_events,)).fetchall()
    client = TestClient(app, raise_server_exceptions=True)
    failures = 0
    seen = set()
    for ev in events:
        urls = [f"/event/{ev['id']}", f"/edge/event/{ev['id']}"]
        for f in conn.execute("SELECT id FROM fights WHERE event_id=? ORDER BY bout_order, id", (ev["id"],)).fetchall():
            urls += [f"/fight/{f['id']}?mode=live", f"/fight/{f['id']}?mode=replay"]
        print(f"== {ev['date']} {ev['name']} (event {ev['id']}): {len(urls)} pages", flush=True)
        for u in urls:
            try:
                r = client.get(u)
                ok = r.status_code < 500
                print(f"{'ok ' if ok else 'ERR'} {r.status_code} {u}", flush=True)
            except Exception as e:
                failures += 1
                key = (type(e).__name__, str(e)[:200])
                print(f"ERR exception {u}: {type(e).__name__}: {e}", flush=True)
                if key not in seen:
                    seen.add(key)
                    traceback.print_exc(file=sys.stdout)
    print(f"{failures} page(s) failed", flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
