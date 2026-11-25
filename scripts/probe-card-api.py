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

    out("T. Can brand keywords skip the trading card games? Nov 23 totals")
    day = "2026-11-23"
    def tot(**kw):
        j = get("sales", limit=1, date_from=day, date_to=day, **kw)
        return (j or {}).get("pagination", {}).get("total")
    for floor in (1, 5, 10):
        out(f"  ${floor}+ everything: {tot(price_min=floor)}")
    brands = ["panini", "topps", "bowman", "upper deck", "donruss", "prizm", "fleer", "leaf", "score", "select", "optic", "mosaic", "chrome"]
    for b in brands:
        out(f"  $5+ q={b!r}: {tot(price_min=5, q=b)}")
    for q in ("(panini,topps,bowman,upper deck,leaf,fleer,score)", "panini OR topps", "panini topps", "panini|topps"):
        out(f"  $5+ q={q!r}: {tot(price_min=5, q=q)}")
    j = get("sales", limit=100, date_from=day, date_to=day, price_min=5, q="(panini,topps,bowman,upper deck,leaf,fleer,score)")
    rows = (j or {}).get("data") or []
    out(f"  sample of 100 from the OR query: categories {dict(Counter((r.get('category') or '-') for r in rows))}")
    for r in rows[:12]:
        out(f"    - ${r.get('price')}  {(r.get('title') or '')[:90]}")
    out(f"  allowance left: {last_headers}")
    return 0

    out("S. Nov 19 at $15+: what are the sales, by sport, category and league?")
    seen = 0
    sport_c, cat_c, league_c, plat_c = Counter(), Counter(), Counter(), Counter()
    blank_titles = []
    for page in (1, 15, 30, 45, 60):
        j = get("sales", limit=100, page=page, sort="date_desc", date_from="2026-11-19", date_to="2026-11-19", price_min=15)
        rows = (j or {}).get("data") or []
        if page == 1:
            out(f"  total that day at $15+: {(j or {}).get('pagination', {}).get('total')}")
        for r in rows:
            seen += 1
            sport_c[r.get("sport") or "(blank)"] += 1
            cat_c[r.get("category") or "(blank)"] += 1
            league_c[r.get("league") or "(blank)"] += 1
            plat_c[r.get("platform") or "(blank)"] += 1
            if not r.get("sport") and len(blank_titles) < 25:
                blank_titles.append(f"{r.get('category')}/{r.get('platform')}: {(r.get('title') or '')[:80]}")
    out(f"  sampled {seen} sales from pages 1, 15, 30, 45, 60")
    out(f"  sport: {dict(sport_c.most_common())}")
    out(f"  category: {dict(cat_c.most_common())}")
    out(f"  league: {dict(league_c.most_common(12))}")
    out(f"  platform: {dict(plat_c.most_common())}")
    out("  titles with a blank sport:")
    for t in blank_titles:
        out(f"    - {t}")
    for kw in ({"category": "sports"}, {"category": "tcg"}, {"q": "football"}, {"q": "rookie"}):
        j = get("sales", limit=1, date_from="2026-11-19", date_to="2026-11-19", price_min=15, **kw)
        out(f"  Nov 19 $15+ with {kw}: total {(j or {}).get('pagination', {}).get('total')}")
    out(f"  allowance left: {last_headers}")
    return 0

    out("R. What does one 'row' cost? Fresh queries, remaining before and after")
    import random
    for n in (1, 7, 60):
        tag = f"rookie {random.randint(1000, 9999)}"  # unseen query, so nothing is cached
        get("sales", limit=1, q="zzqx nothing matches this")
        before = int(last_headers.get("x-ratelimit-remaining", -1))
        j = get("sales", limit=n, q="rookie", sort="date_desc", date_from="2026-11-1" + str(n % 9), date_to="2026-11-1" + str(n % 9))
        after = int(last_headers.get("x-ratelimit-remaining", -1))
        got = len((j or {}).get("data") or [])
        out(f"  limit={n}: {got} sales came back; allowance went {before} -> {after} (used {before - after})")
    out("  cheap-card filter: Nov 18 totals")
    for kw in ({}, {"min_price": 10}, {"price_min": 10}, {"min": 10}, {"price_gte": 10}, {"min_price": 25}):
        j = get("sales", limit=1, date_from="2026-11-18", date_to="2026-11-18", **kw)
        out(f"    {kw or 'no filter'}: total {(j or {}).get('pagination', {}).get('total')}")

    out("A. Volume per sport: total held, oldest and newest sale, per day")
    for sport in ("football", "baseball", "basketball"):
        for label, kw in ((f"q={sport}", {"q": sport}), (f"sport={sport}", {"sport": sport})):
            new = get("sales", limit=1, sort="date_desc", **kw)
            old = get("sales", limit=1, sort="date_asc", **kw)
            if not new or not old:
                continue
            tot = (new.get("pagination") or {}).get("total")
            d1_, d0 = day((new.get("data") or [{}])[0]), day((old.get("data") or [{}])[0])
            span = None
            try:
                span = (datetime.fromisoformat(d1_) - datetime.fromisoformat(d0)).days + 1
            except ValueError:
                pass
            out(f"  {label}: total {tot}; {d0} .. {d1_}" + (f"; ~{tot // span:,} a day over {span} days" if span and tot else ""))
    for kw in ({"date_from": "2026-11-18", "date_to": "2026-11-18"}, {"start_date": "2026-11-18", "end_date": "2026-11-18"}, {"sold_after": "2026-11-18"}):
        j = get("sales", limit=1, **kw)
        out(f"  one-day filter {list(kw)}: total {(j or {}).get('pagination', {}).get('total')}")
    for kw in ({"category": "football"}, {"league": "NFL"}, {"category": "Football"}, {"sport": "Football"}, {"sports": "football"}):
        j = get("sales", limit=1, date_from="2026-11-18", date_to="2026-11-18", **kw)
        out(f"  Nov 18 with {kw}: total {(j or {}).get('pagination', {}).get('total')}")
    j = get("sales", limit=100, date_from="2026-11-18", date_to="2026-11-18")
    out(f"  Nov 18 sample of 100 by sport/category: {dict(Counter((s.get('sport') or '?') + '/' + (s.get('category') or '?') for s in (j or {}).get('data') or []))}")
    j = get("sales", limit=1, sort="date_desc")
    out(f"  everything, no query: total {(j or {}).get('pagination', {}).get('total')}; meta {json.dumps((j or {}).get('meta'))[:400]}")

    out("\nB. Pricing and terms pages")
    for path in ("pricing", "terms", "tos", "terms-of-service", "license"):
        try:
            r = requests.get(f"https://www.thecardapi.com/{path}", timeout=20)
        except requests.RequestException as e:
            out(f"  /{path}: {type(e).__name__}"); continue
        out(f"  /{path}: HTTP {r.status_code}")
        if not r.ok:
            continue
        text = re.sub(r"<script.*?</script>|<style.*?</style>", " ", r.text, flags=re.S)
        text = re.sub(r"<[^>]+>", " ", text)
        text = re.sub(r"\\u[0-9a-f]{4}|\\n", " ", text)
        text = re.sub(r"\s+", " ", text)
        pat = (r"[^.]{0,160}(\$\s?\d[\d,.]*(?:\s*/\s*mo(?:nth)?)?|rows? (?:per|a|/) ?day|per month|commercial|redistribut|resell|display|store|cache|attribution|enterprise|unlimited)[^.]{0,200}\.")
        if path == "pricing":
            for name in ("Free", "Starter", "Builder", "Pro", "Enterprise"):
                i = text.find(f" {name} $")
                if i < 0:
                    i = text.find(f" {name} ")
                out(f"    [{name}] {text[i:i+420] if i >= 0 else '(not found)'}")
        seen = set()
        for m in re.finditer(pat, text, re.I):
            t = m.group(0).strip()
            if t[:60] in seen:
                continue
            seen.add(t[:60])
            out(f"    > {t[:360]}")
            if len(seen) >= 25:
                break

    out("\n1. Newest football sales (structure and freshness)")
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
