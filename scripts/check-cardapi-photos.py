#!/usr/bin/env python3
"""One-off: do the sales a Card API run saved carry photo links, and do they load?
Reads the run's saved pages (raw/*.jsonl), counts photo fields by platform, and
tries loading a few, with and without our site as the referrer."""
import json, sys
from collections import Counter
from pathlib import Path
import requests

rows = []
for f in sorted(Path(sys.argv[1]).rglob("*.jsonl")):
    rows += [json.loads(l) for l in f.read_text().splitlines() if l.strip()]
print(f"{len(rows)} saved sales")
c = Counter()
for r in rows:
    p = r.get("platform") or "?"
    c[(p, "image_url" if r.get("image_url") else "-", "thumbnail_url" if r.get("thumbnail_url") else "-")] += 1
for k, v in c.most_common():
    print("  ", k, v)
by_p = {}
for r in rows:
    by_p.setdefault(r.get("platform") or "?", []).append(r)
for p, rs in by_p.items():
    print(f"\n== {p}")
    for r in rs[:4]:
        for f in ("image_url", "thumbnail_url"):
            u = r.get(f)
            if not u:
                continue
            print(f"  {f}: {u[:140]}")
            for ref in (None, "https://thecardhuddle.com/"):
                try:
                    rr = requests.get(u, timeout=20, headers={"Referer": ref, "User-Agent": "Mozilla/5.0"} if ref else {"User-Agent": "Mozilla/5.0"})
                    print(f"     {'site referer' if ref else 'no referer'}: HTTP {rr.status_code} {rr.headers.get('content-type')} {len(rr.content)} bytes")
                except requests.RequestException as e:
                    print(f"     failed: {type(e).__name__}")
