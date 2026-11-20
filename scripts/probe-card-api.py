#!/usr/bin/env python3
"""Probe The Card API (thecardapi.com) before paying for it.

The owner wants about 40,000 football sales a month from a licensed source.
This asks the free key a handful of questions and prints the answers:

  coverage   do specific football cards (parallels, graded) come back?
  freshness  how new is the newest sale, how far back does it reach?
  cleanness  how many lots, reprints, boxes and breaks get through?
  structure  are grader, grade, print run and listing type filled in?
  accuracy   do eBay sales it returns match the ones already in our D1?
  volume     how many football sales a day, and what the key allows.

Budget: about 12 calls of at most 100 rows, inside the free tier's daily
rows. The key is read from CARD_API_KEY (a repo secret) and never printed.
"""

from __future__ import annotations

import json
import os
import re
import statistics
import sys
from collections import Counter
from datetime import datetime, timezone

import requests

KEY = os.environ.get("CARD_API_KEY", "").strip()
CF_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
CF_ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
D1_ID = "a887dd0e-d852-4ebc-98f0-0e01bc82ad0b"
# The bare host 307-redirects here, so call it directly.
BASE = "https://www.thecardapi.com/api/v1/market"

JUNK_RE = re.compile(r"\b(lot|lots|reprint|digital|box|hobby|blaster|pack|break|case|you pick|choose)\b", re.I)
ITEM_RE = re.compile(r"/itm/(?:[^/]+/)?(\d{9,14})")
calls = 0
last_headers: dict = {}


def out(line: str = "") -> None:
    print(line.replace(KEY, "***") if KEY else line, flush=True)


AUTH = {"x-market-api-key": KEY}


def find_auth() -> bool:
    """The key came back 401 with x-market-api-key. Read the docs the API
    publishes and try the usual ways of sending a key, to learn which it takes."""
    raw = os.environ.get("CARD_API_KEY", "")
    out(f"  key: {len(KEY)} chars after trimming ({len(raw)} raw); "
        f"inner spaces {' ' in KEY}; quotes {any(c in KEY for c in chr(34) + chr(39))}; "
        f"shape {re.sub(r'[A-Za-z]', 'a', re.sub(r'[0-9]', '9', KEY))[:6]}...")
    for path in ("openapi.json", "api/openapi.json", "api/v1/openapi.json", "docs"):
        try:
            r = requests.get(f"https://www.thecardapi.com/{path}", timeout=20)
        except requests.RequestException as e:
            out(f"  /{path}: {type(e).__name__}"); continue
        out(f"  /{path}: HTTP {r.status_code}, {len(r.text)} bytes")
        if r.ok and path.endswith("json"):
            try:
                spec = r.json()
                out(f"    security schemes: {json.dumps((spec.get('components') or {}).get('securitySchemes'))[:500]}")
                out(f"    paths: {sorted((spec.get('paths') or {}).keys())[:40]}")
            except ValueError:
                pass
        elif r.ok:
            for m in sorted(set(re.findall(r"(?i)(x-[a-z-]*key|authorization: ?bearer|api[_-]?key)", r.text)))[:10]:
                out(f"    docs mention: {m}")
    tries = [
        ("x-market-api-key", {"x-market-api-key": KEY}, {}),
        ("X-API-Key", {"X-API-Key": KEY}, {}),
        ("Authorization: Bearer", {"Authorization": f"Bearer {KEY}"}, {}),
        ("x-api-key + market", {"x-api-key": KEY}, {}),
        ("?api_key=", {}, {"api_key": KEY}),
    ]
    global AUTH
    for label, h, qp in tries:
        try:
            r = requests.get(f"{BASE}/sales", params={"q": "football", "limit": 1, **qp}, headers=h, timeout=30)
        except requests.RequestException as e:
            out(f"  {label}: {type(e).__name__}"); continue
        out(f"  {label}: HTTP {r.status_code} {r.text[:120] if r.status_code != 200 else ''}")
        if r.status_code == 200:
            AUTH = h
            if qp:
                AUTH = {"__q": KEY}
            return True
    return False


def get(path: str, **params) -> dict | None:
    global calls, last_headers
    calls += 1
    h = dict(AUTH)
    if "__q" in h:
        params["api_key"] = h.pop("__q")
    try:
        r = requests.get(f"{BASE}/{path}", params=params, headers=h, timeout=30)
    except requests.RequestException as e:
        out(f"  request failed: {type(e).__name__}")
        return None
    last_headers = {k.lower(): v for k, v in r.headers.items() if "limit" in k.lower() or "quota" in k.lower()}
    if r.status_code != 200:
        out(f"  HTTP {r.status_code}: {r.text[:300]}")
        return None
    try:
        return r.json()
    except ValueError:
        out(f"  not JSON: {r.text[:200]}")
        return None


def d1(sql: str, params: list | None = None) -> list[dict]:
    if not (CF_TOKEN and CF_ACCOUNT):
        return []
    r = requests.post(
        f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT}/d1/database/{D1_ID}/query",
        headers={"Authorization": f"Bearer {CF_TOKEN}"},
        json={"sql": sql, "params": params or []}, timeout=60)
    j = r.json()
    return j["result"][0]["results"] if j.get("success") else []


def item_id(s: dict) -> str | None:
    m = ITEM_RE.search(str(s.get("listing_url") or ""))
    return m.group(1) if m else None


def price(s: dict) -> float | None:
    try:
        return float(s.get("price"))
    except (TypeError, ValueError):
        return None


def day(s: dict) -> str:
    return str(s.get("sold_at") or s.get("sale_date") or "")[:10]


def summarize(label: str, rows: list[dict], total) -> None:
    if not rows:
        out(f"  {label}: 0 sales (total {total})")
        return
    ps = [p for p in (price(s) for s in rows) if p is not None]
    days = sorted(d for d in (day(s) for s in rows) if d)
    junk = sum(1 for s in rows if JUNK_RE.search(s.get("title") or ""))
    graded = sum(1 for s in rows if s.get("grader"))
    plat = Counter(s.get("platform") or "?" for s in rows)
    ltype = Counter(s.get("listing_type") or "?" for s in rows)
    out(f"  {label}: {len(rows)} back, total {total}; median ${statistics.median(ps):,.2f}" if ps else f"  {label}: {len(rows)} back")
    out(f"    dates {days[0] if days else '?'} .. {days[-1] if days else '?'}; graded {graded}; junk-looking {junk}; "
        f"platforms {dict(plat)}; types {dict(ltype)}")
    for s in rows[:4]:
        g = f"{s.get('grader') or ''} {s.get('grade') or ''}".strip() or "raw"
        out(f"    - {day(s)}  ${price(s) or 0:,.2f}  [{g}]  {(s.get('title') or '')[:90]}")


def search(label: str, q: str, limit: int = 50, **f) -> list[dict]:
    j = get("sales", q=q, limit=limit, sort="date_desc", **f)
    if j is None:
        return []
    rows = j.get("data") or []
    summarize(label, rows, (j.get("pagination") or {}).get("total"))
    return rows


def main() -> int:
    if not KEY:
        out("CARD_API_KEY is not set as a GitHub secret yet. Add it under the repo's")
        out("Settings > Secrets and variables > Actions, then re-run this workflow.")
        return 0
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    out(f"The Card API probe, {now}\n")
    out("0. How does the API want the key?")
    if not find_auth():
        out("  No way of sending the key was accepted. The key may be wrong, not yet")
        out("  activated, or for another product. Stopping before spending calls.")
        return 0

    out("1. Newest football sales (structure and freshness)")
    j = get("sales", q="football", limit=100, sort="date_desc")
    first = (j or {}).get("data") or []
    if j is not None:
        out(f"  response keys: {sorted(j.keys())}; pagination: {json.dumps(j.get('pagination'))[:300]}")
        if first:
            out(f"  fields on a sale: {sorted(first[0].keys())}")
        summarize("football, newest 100", first, (j.get("pagination") or {}).get("total"))
    out(f"  rate-limit headers: {last_headers}")

    out("\n2. Paging: does page 2 return different sales?")
    j2 = get("sales", q="football", limit=100, sort="date_desc", page=2)
    j3 = get("sales", q="football", limit=100, sort="date_desc", offset=100)
    ids1 = {s.get("id") for s in first}
    for lbl, jj in (("page=2", j2), ("offset=100", j3)):
        rows = (jj or {}).get("data") or []
        out(f"  {lbl}: {len(rows)} rows, {sum(1 for s in rows if s.get('id') not in ids1)} new")

    out("\n3. Specific cards (coverage)")
    search("Bo Nix 2024 Prizm Silver", "Bo Nix 2024 Prizm Silver")
    search("Jayden Daniels Downtown", "Jayden Daniels Downtown")
    search("Caleb Williams Prizm PSA 10", "Caleb Williams Prizm", grader="PSA", grade="10")
    search("Patrick Mahomes 2017 Optic", "Patrick Mahomes 2017 Optic")
    search("Tom Brady 2000 Contenders", "Tom Brady 2000 Contenders")
    search("Malik Nabers Prizm numbered", "Malik Nabers Prizm /99")

    out("\n4. Accuracy: eBay sales we already hold")
    ids = [i for i in (item_id(s) for s in first) if i]
    out(f"  {len(ids)} of {len(first)} newest sales carry an eBay item id")
    if ids:
        q = ",".join("?" * len(ids[:90]))
        have = {str(r["item_id"]): r for r in d1(f"SELECT item_id, sold_date, price_cents FROM sales WHERE item_id IN ({q})", ids[:90])}
        same = diff = 0
        for s in first:
            r = have.get(item_id(s) or "")
            if r and r["price_cents"] is not None and price(s) is not None:
                if abs(r["price_cents"] - round(price(s) * 100)) <= 1:
                    same += 1
                else:
                    diff += 1
                    out(f"    differs: {item_id(s)} ours ${r['price_cents']/100:,.2f} theirs ${price(s):,.2f}")
        out(f"  {len(have)} already in our D1; price matches {same}, differs {diff}")

    out("\n5. Our own recent football volume, for scale")
    for r in d1("SELECT sold_date, COUNT(*) AS n FROM sales WHERE sport='football' AND sold_date >= date('now','-7 day') GROUP BY sold_date ORDER BY sold_date"):
        out(f"  {r['sold_date']}: {r['n']}")

    out(f"\n{calls} API calls made. Last rate-limit headers: {last_headers}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
