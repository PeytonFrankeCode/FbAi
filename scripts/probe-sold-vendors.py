#!/usr/bin/env python3
"""Probe two paid sources of eBay sold football sales before paying for either.

eBay put sold listings behind a sign-in wall on 22 July 2026, which is what
has been draining the home collector. Two vendors might get past it without an
eBay account. This asks each a handful of questions and prints the answers:

  scrape.do      a page fetcher. Does eBay show it the sold search signed out?
                 If so, NflCardDB's own parser reads 240 sales a page.
  OpenWeb Ninja  an eBay data API that says it returns sold listings without a
                 login, 60 a page. Does it, how deep does it page, and do its
                 sales match ones we already hold?

Budget: about 6 OpenWeb Ninja requests (of 100 free a month) and at most 4
scrape.do requests (10-25 credits each, of 1,000 free). Keys are read from the
environment and never printed.

Needs NflCardDB importable (the workflow pip-installs the public repo) for the
scrape.do half, and the Cloudflare token for the comparison against D1.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.parse
from collections import Counter
from datetime import datetime, timezone

import requests

OWN_KEY = os.environ.get("OPENWEBNINJA_KEY", "").strip()
SDO_KEY = os.environ.get("SCRAPEDO_KEY", "").strip()
CF_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
CF_ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
D1_ID = "a887dd0e-d852-4ebc-98f0-0e01bc82ad0b"  # nflcarddb, as in NflCardDB's daily.bat

OWN_URL = "https://api.openwebninja.com/real-time-ebay-data/search"
SDO_URL = "https://api.scrape.do/"

# The collector's proven query: keyword "football" in Sports Trading Card
# Singles, newest-ended first, 240 a page.
EBAY_SOLD = ("https://www.ebay.com/sch/261328/i.html?_nkw=football"
             "&LH_Sold=1&LH_Complete=1&_sop=13&_ipg=240&_pgn={page}")

report: list[str] = []


def out(line: str = "") -> None:
    print(line, flush=True)
    report.append(line)


def scrub(text: str) -> str:
    """Never let a key reach the log, even inside an error message."""
    for k in (OWN_KEY, SDO_KEY, CF_TOKEN):
        if k:
            text = text.replace(k, "***")
    return text


# --------------------------------------------------------------------------
# D1: what we already hold, to compare against
# --------------------------------------------------------------------------
def d1(sql: str, params: list | None = None) -> list[dict]:
    if not (CF_TOKEN and CF_ACCOUNT):
        return []
    r = requests.post(
        f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT}/d1/database/{D1_ID}/query",
        headers={"Authorization": f"Bearer {CF_TOKEN}"},
        json={"sql": sql, "params": params or []},
        timeout=60,
    )
    j = r.json()
    if not j.get("success"):
        out(f"  D1 query failed: {scrub(json.dumps(j.get('errors'))[:300])}")
        return []
    return j["result"][0]["results"]


def known_sales(ids: list[str]) -> dict[str, dict]:
    found: dict[str, dict] = {}
    for i in range(0, len(ids), 90):  # D1 caps bound parameters at 100
        chunk = ids[i:i + 90]
        q = ",".join("?" * len(chunk))
        for row in d1(f"SELECT item_id, sold_date, price_cents, ask_cents FROM sales WHERE item_id IN ({q})", chunk):
            found[str(row["item_id"])] = row
    return found


def compare(label: str, sales: list[dict]) -> None:
    """sales: [{item_id, price_cents, sold_date}] from a vendor."""
    ids = [s["item_id"] for s in sales if s.get("item_id")]
    if not ids:
        out(f"  {label}: no item ids to compare")
        return
    have = known_sales(ids)
    same = diff = 0
    for s in sales:
        row = have.get(s["item_id"])
        if not row or s.get("price_cents") is None:
            continue
        ours = row["price_cents"] if row["price_cents"] is not None else row["ask_cents"]
        if ours is not None and abs(ours - s["price_cents"]) <= 1:
            same += 1
        else:
            diff += 1
    out(f"  {label}: {len(have)} of {len(ids)} already in our database; "
        f"price matches {same}, differs {diff}")


# --------------------------------------------------------------------------
# OpenWeb Ninja
# --------------------------------------------------------------------------
SOLD_RE = re.compile(r"sold\s+([A-Z][a-z]{2}\s+\d{1,2},?\s+\d{4})", re.I)


def own_date(item: dict) -> str | None:
    for field in ("caption", "sold_date", "subtitle"):
        m = SOLD_RE.search(str(item.get(field) or ""))
        if m:
            try:
                return datetime.strptime(m.group(1).replace(",", ""), "%b %d %Y").date().isoformat()
            except ValueError:
                pass
    return None


def own_id(item: dict) -> str | None:
    if item.get("item_id"):
        return str(item["item_id"])
    m = re.search(r"/itm/(?:[^/?#]+/)?(\d{9,15})", str(item.get("url") or item.get("link") or ""))
    return m.group(1) if m else None


def own_call(label: str, **params) -> list[dict] | None:
    base = {"query": "football card", "show_only": "sold_items", "domain": "com"}
    base.update(params)
    t0 = time.time()
    try:
        r = requests.get(OWN_URL, headers={"x-api-key": OWN_KEY}, params=base, timeout=90)
    except requests.RequestException as e:
        out(f"  [{label}] request failed: {scrub(str(e))[:200]}")
        return None
    secs = time.time() - t0
    if r.status_code != 200:
        out(f"  [{label}] HTTP {r.status_code} in {secs:.1f}s: {scrub(r.text)[:300]}")
        return None
    j = r.json()
    data = j.get("data") or {}
    products = data.get("products") or []
    dates = Counter(own_date(p) for p in products)
    meta = {k: v for k, v in data.items() if k != "products" and not isinstance(v, (list, dict))}
    out(f"  [{label}] HTTP 200 in {secs:.1f}s, {len(products)} results; other fields: {json.dumps(meta)[:300]}")
    out(f"      sale dates: {dict(sorted(((k or 'none'), v) for k, v in dates.items()))}")
    for p in products[:3]:
        out(f"      e.g. {p.get('price')} | {p.get('caption')} | {str(p.get('title'))[:70]}")
    if products and label.startswith("page 1"):
        out(f"      fields on a result: {sorted(products[0].keys())}")
    return products


def probe_openwebninja() -> None:
    out("## OpenWeb Ninja")
    if not OWN_KEY:
        out("  OPENWEBNINJA_KEY is not set -- skipped")
        return
    own_call("active listings (not sold), control", show_only="")
    p1 = None
    for attempt in range(1, 4):
        p1 = own_call(f"page 1, try {attempt}")
        if p1:
            break
        time.sleep(30)
    if not p1:
        p1 = own_call("page 1, sold + completed", show_only="sold_items,completed_items")
    if not p1:
        out("  VERDICT: no sold results came back")
        return
    own_call("page 1, category 261328", category_id="261328")
    own_call("page 1, newest ended first", sort="ended_recently")
    own_call("page 1, $100 and up", min_price="100")
    deep = own_call("page 40", page=40)
    deeper = own_call("page 150", page=150)
    sales = []
    for p in p1 + (deep or []):
        price = p.get("price")
        sales.append({
            "item_id": own_id(p),
            "price_cents": round(float(price) * 100) if isinstance(price, (int, float)) else None,
            "sold_date": own_date(p),
        })
    compare("page 1 + page 40", sales)
    out(f"  VERDICT: sold results yes; page 40 {'yes' if deep else 'no'}; page 150 {'yes' if deeper else 'no'}")


# --------------------------------------------------------------------------
# scrape.do
# --------------------------------------------------------------------------
WALL = ("signin.ebay.com", "Sign in or create an account", "Sign in to your account",
        "pardon our interruption")


def sdo_call(label: str, page: int, **opts) -> list | None:
    from nflcarddb.parse_listing import parse_search_page

    params = {"token": SDO_KEY, "url": EBAY_SOLD.format(page=page), "geoCode": "us"}
    params.update(opts)
    t0 = time.time()
    try:
        r = requests.get(SDO_URL, params=params, timeout=150)
    except requests.RequestException as e:
        out(f"  [{label}] request failed: {scrub(str(e))[:200]}")
        return None
    secs = time.time() - t0
    cost = r.headers.get("Scrape.do-Request-Cost") or r.headers.get("scrape.do-request-cost")
    left = r.headers.get("Scrape.do-Remaining-Credits") or r.headers.get("scrape.do-remaining-credits")
    final = r.headers.get("Scrape.do-Resolved-Url") or ""
    html = r.text
    wall = next((w for w in WALL if w.lower() in (final + html[:200000]).lower()), None)
    out(f"  [{label}] HTTP {r.status_code} in {secs:.1f}s, {len(html):,} bytes, "
        f"cost {cost or '?'} credits, {left or '?'} left")
    if r.status_code != 200:
        out(f"      {scrub(html)[:300]}")
        return None
    res = parse_search_page(html, "football_singles")
    dates = Counter(s.sold_date for s in res.sales)
    out(f"      parsed {len(res.sales)} sales (total shown: {res.total_results}); "
        f"sign-in/bot page: {wall or 'no'}")
    out(f"      sale dates: {dict(sorted(((k or 'none'), v) for k, v in dates.items()))}")
    for s in res.sales[:3]:
        out(f"      e.g. {s.price_cents} | {s.sold_date} | {s.title[:70]}")
    return res.sales if res.sales and not wall else None


def probe_scrapedo() -> None:
    out("## scrape.do")
    if not SDO_KEY:
        out("  SCRAPEDO_KEY is not set -- skipped")
        return
    mode = "home connection"
    p1 = sdo_call("page 1, home connection", 1, super="true")
    if not p1:
        mode = "home connection + real browser"
        p1 = sdo_call("page 1, home connection + real browser", 1, super="true", render="true")
    if not p1:
        out("  VERDICT: eBay did not show sold listings to scrape.do")
        return
    opts = {"super": "true"} if mode == "home connection" else {"super": "true", "render": "true"}
    deep = sdo_call(f"page 30, {mode}", 30, **opts)
    sales = [{"item_id": s.item_id, "price_cents": s.price_cents, "sold_date": s.sold_date}
             for s in p1 + (deep or [])]
    compare("page 1 + page 30", sales)
    out(f"  VERDICT: sold results yes via {mode}; page 30 {'yes' if deep else 'no'}")


def our_recent_days() -> None:
    out("## Our own collection, last 21 days")
    rows = d1("SELECT sold_date, COUNT(*) AS n FROM sales "
              "WHERE sold_date >= date('now','-21 day') GROUP BY sold_date ORDER BY sold_date")
    if not rows:
        out("  (could not read D1)")
    for row in rows:
        out(f"  {row['sold_date']}  {row['n']:>6,}")
    out("  by sport and graded, last 21 days:")
    for row in d1("SELECT COALESCE(sport,'?') AS sport, (grader IS NOT NULL) AS graded, COUNT(*) AS n, "
                  "SUM(price_cents >= 10000) AS over100 FROM sales "
                  "WHERE sold_date >= date('now','-21 day') GROUP BY 1,2 ORDER BY n DESC LIMIT 15"):
        out(f"    {row['sport']:<12} graded={row['graded']}  {row['n']:>8,}  ($100+: {row['over100'] or 0:,})")
    for row in d1("SELECT MAX(sold_date) AS last_day, COUNT(*) AS n FROM sales"):
        out(f"  newest sale day in D1: {row['last_day']}; rows in total: {row['n']:,}")


def main() -> int:
    out(f"# Sold-data vendor probe, {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC")
    out()
    # scrape.do answered for good on 2026-11-09: it refuses sold searches outright.
    for step in (probe_openwebninja,):
        try:
            step()
        except Exception as e:  # one vendor failing must not hide the other's answer
            out(f"  crashed: {type(e).__name__}: {scrub(str(e))[:300]}")
        out()
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write("```\n" + "\n".join(report) + "\n```\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
