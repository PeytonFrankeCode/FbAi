#!/usr/bin/env python3
"""Nightly: collect eBay sold sales through OpenWeb Ninja and add them to D1.

Why this exists: eBay hid sold listings behind a sign-in on 22 July 2026, and
the home collector (NflCardDB on the owner's PC) has uploaded nothing since
30 Oct. OpenWeb Ninja still returns sold listings signed out. A reliability
test on 9-10 Nov got 11 of 20 pages, with about 1 call in 7 succeeding, and
only successful calls are billed -- so this retries freely and stops at a
budget of *successful* pages.

What it does, in order:
  1. Asks for sold "football card" listings, $100 and up by default -- the
     sales collectors look up most -- one page (60) at a time, retrying each.
  2. Drops lots and sealed product, which the keyword search lets in.
  3. Reads every title with NflCardDB's own parser, so player, set, parallel,
     grade and card_key mean exactly what they mean for PC-collected rows.
  4. Inserts into D1's `sales` table with ON CONFLICT DO NOTHING. Sales only:
     NflCardDB's d1-push also rebuilds the per-card and per-day summaries from
     its local database, and from one night's rows those would overwrite good
     medians with tiny samples. And a sale already collected is never touched.

Settings (environment):
  OPENWEBNINJA_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID   required
  NINJA_PAGES     successful pages to collect per run (default 10)
  NINJA_MIN_PRICE lowest sale price in dollars (default 100; 0 for all)
  NINJA_QUERY     search words (default "football card")
  NINJA_SPORT     sport stamped when a title doesn't say (default football)
  DRY_RUN=1       collect and parse, upload nothing
"""

from __future__ import annotations

import os
import re
import sys
import tempfile
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

from nflcarddb import db as store
from nflcarddb.api_export import EXPORT_COLUMNS, _iter_rows_to_export, _sql_literal
from nflcarddb.d1_http import push_sql, run_sql
from nflcarddb.models import Sale
from nflcarddb.parse_listing import _money_to_cents
from nflcarddb.parse_title import PARSER_VERSION, load_roster, parse_title

KEY = os.environ.get("OPENWEBNINJA_KEY", "").strip()
CF_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
CF_ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
D1_ID = "a887dd0e-d852-4ebc-98f0-0e01bc82ad0b"  # nflcarddb, as in NflCardDB's daily.bat

PAGES = int(os.environ.get("NINJA_PAGES") or 10)
MIN_PRICE = float(os.environ.get("NINJA_MIN_PRICE") or 100)
QUERY = os.environ.get("NINJA_QUERY") or "football card"
SPORT = os.environ.get("NINJA_SPORT") or "football"
DRY_RUN = os.environ.get("DRY_RUN") == "1"
ROSTER = os.environ.get("NFLCARDDB_ROSTER", "nflcarddb/config/nfl_players.txt")

URL = "https://api.openwebninja.com/real-time-ebay-data/search"
TRIES_PER_PAGE = 8          # ~1 in 7 calls got through in testing; failures are free
RETRY_WAIT = 15             # seconds between tries
MAX_MINUTES = 100           # the workflow's own timeout is 120
EMPTY_PAGES_STOP = 3        # pages in a row with nothing new: the search is spent
KEEP_DAYS = 14              # best-match pages carry the odd months-old sale

# A keyword search is not category 261328 (Singles), which the vendor ignores,
# so lots and sealed product come back too. Their price is not a card's price.
NOT_A_SINGLE = re.compile(
    r"\blots?\b|\bsealed\b|\bunopened\b|\bwax\b|\bhobby box\b|\bblaster\b|\bmega box\b"
    r"|\bpacks?\b|\bteam set\b|\bcomplete set\b|\bcase\b|\bbreak\b|\bbundle\b",
    re.I,
)
SOLD_RE = re.compile(r"sold\s+([A-Z][a-z]{2}\s+\d{1,2},?\s+\d{4})", re.I)
ITEM_RE = re.compile(r"/itm/(?:[^/?#]+/)?(\d{9,15})")

log_lines: list[str] = []


def log(line: str = "") -> None:
    print(line, flush=True)
    log_lines.append(line)


def scrub(text: str) -> str:
    for k in (KEY, CF_TOKEN):
        if k:
            text = text.replace(k, "***")
    return text


class OutOfRequests(RuntimeError):
    """The vendor says the plan's allowance is used up: stop, don't retry."""


def fetch_page(page: int) -> tuple[list[dict] | None, int]:
    """One page of sold results, retried. Returns (products or None, calls made)."""
    params = {"query": QUERY, "show_only": "sold_items", "domain": "com", "page": page}
    if MIN_PRICE > 0:
        params["min_price"] = f"{MIN_PRICE:g}"
    for attempt in range(1, TRIES_PER_PAGE + 1):
        try:
            r = requests.get(URL, headers={"x-api-key": KEY}, params=params, timeout=90)
        except requests.RequestException as e:
            log(f"  page {page} try {attempt}: {scrub(str(e))[:150]}")
            time.sleep(RETRY_WAIT)
            continue
        if r.status_code == 200:
            products = (r.json().get("data") or {}).get("products") or []
            return products, attempt
        body = scrub(r.text)[:200]
        if r.status_code == 429 or re.search(r"quota|exceeded|limit reached|upgrade", body, re.I):
            raise OutOfRequests(f"HTTP {r.status_code}: {body}")
        if r.status_code in (401, 403) and "subscribed" in body.lower():
            raise OutOfRequests(f"HTTP {r.status_code}: {body}")
        if attempt == TRIES_PER_PAGE:
            log(f"  page {page}: gave up after {attempt} tries ({body[:90]})")
        time.sleep(RETRY_WAIT)
    return None, TRIES_PER_PAGE


def sold_date(item: dict) -> str | None:
    m = SOLD_RE.search(str(item.get("caption") or ""))
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1).replace(",", ""), "%b %d %Y").date().isoformat()
    except ValueError:
        return None


def to_sale(item: dict) -> Sale | None:
    item_id = str(item.get("item_id") or "")
    if not item_id.isdigit():
        m = ITEM_RE.search(str(item.get("url") or ""))
        item_id = m.group(1) if m else ""
    title = str(item.get("title") or "").strip()
    day = sold_date(item)
    if not item_id or not title or not day:
        return None

    price_cents, currency = _money_to_cents(str(item.get("price_raw") or ""))
    if price_cents is None and isinstance(item.get("price"), (int, float)):
        price_cents, currency = round(item["price"] * 100), item.get("currency") or "USD"

    ship = str(item.get("shipping") or "")
    shipping_cents = 0 if re.search(r"free", ship, re.I) else (_money_to_cents(ship)[0] if ship else None)

    bids = item.get("bid_count") if isinstance(item.get("bid_count"), int) else None
    # Signed out, eBay shows the asking price on a sale that took an offer, so
    # flag it the way the collector does: counted, but marked as an ask.
    best_offer = "offer" in str(item.get("buying_format") or "").lower()
    return Sale(
        item_id=item_id,
        title=title,
        price_cents=price_cents,
        currency=currency or "USD",
        shipping_cents=shipping_cents,
        sold_date=day,
        listing_format="auction" if bids else "fixed",
        bids=bids,
        best_offer=best_offer,
        condition=item.get("condition"),
        url=f"https://www.ebay.com/itm/{item_id}",
        image_url=item.get("image_high_res") or item.get("image"),
        query_id="openwebninja",
        sport=SPORT,
    )


def collect() -> tuple[dict[str, Sale], dict]:
    sales: dict[str, Sale] = {}
    stats = {"calls": 0, "pages_ok": 0, "pages_failed": 0, "results": 0,
             "dropped_not_single": 0, "dropped_old_or_undated": 0, "stopped": ""}
    oldest = (date.today() - timedelta(days=KEEP_DAYS)).isoformat()
    started = time.time()
    page = 0
    empty_in_a_row = 0
    while stats["pages_ok"] < PAGES:
        if (time.time() - started) / 60 > MAX_MINUTES:
            stats["stopped"] = f"time limit ({MAX_MINUTES} min)"
            break
        page += 1
        try:
            products, calls = fetch_page(page)
        except OutOfRequests as e:
            stats["stopped"] = f"vendor allowance used up: {e}"
            break
        stats["calls"] += calls
        if products is None:
            stats["pages_failed"] += 1
            if stats["pages_failed"] >= 5 and stats["pages_ok"] == 0:
                stats["stopped"] = "eBay blocked every try on 5 pages"
                break
            continue
        stats["pages_ok"] += 1
        stats["results"] += len(products)
        new = 0
        for item in products:
            if NOT_A_SINGLE.search(str(item.get("title") or "")):
                stats["dropped_not_single"] += 1
                continue
            sale = to_sale(item)
            if not sale or sale.sold_date < oldest:
                stats["dropped_old_or_undated"] += 1
                continue
            if sale.item_id not in sales:
                new += 1
            sales[sale.item_id] = sale
        log(f"  page {page}: {len(products)} results, {new} new sales (after {calls} tries)")
        empty_in_a_row = 0 if new else empty_in_a_row + 1
        if not products or empty_in_a_row >= EMPTY_PAGES_STOP:
            stats["stopped"] = "search ran out of new sales"
            break
    if not stats["stopped"]:
        stats["stopped"] = f"page budget reached ({PAGES})"
    stats["minutes"] = round((time.time() - started) / 60)
    return sales, stats


def parse_into_rows(sales: list[Sale]) -> list[dict]:
    """Run NflCardDB's own storage and title parser, then read rows back in the
    exact shape its uploader sends -- so these rows match PC-collected ones."""
    roster = load_roster(ROSTER) if Path(ROSTER).exists() else None
    with tempfile.TemporaryDirectory() as tmp:
        conn = store.connect(Path(tmp) / "night.sqlite")
        try:
            run_id = store.start_run(conn, None)
            store.upsert_sales(conn, sales, run_id)
            store.upsert_cards(
                conn, [(s.item_id, parse_title(s.title, roster, collected_as=s.sport)) for s in sales],
                PARSER_VERSION)
            store.finish_run(conn, run_id, "ok", 0, len(sales), len(sales), None)
            conn.row_factory = __import__("sqlite3").Row
            return [dict(r) for r in _iter_rows_to_export(conn, None)]
        finally:
            conn.close()


def already_in_d1(ids: list[str]) -> set[str]:
    have: set[str] = set()
    for i in range(0, len(ids), 90):
        chunk = ids[i:i + 90]
        sql = "SELECT item_id FROM sales WHERE item_id IN (%s)" % ",".join(_sql_literal(x) for x in chunk)
        res = run_sql(CF_ACCOUNT, D1_ID, CF_TOKEN, sql)
        for block in res.get("result") or []:
            for row in block.get("results") or []:
                have.add(str(row["item_id"]))
    return have


def insert_sql(rows: list[dict]) -> str:
    cols = ", ".join(EXPORT_COLUMNS)
    out = []
    for i in range(0, len(rows), 50):
        values = ",\n  ".join(
            "(" + ", ".join(_sql_literal(r.get(c)) for c in EXPORT_COLUMNS) + ")"
            for r in rows[i:i + 50])
        out.append(f"INSERT INTO sales ({cols}) VALUES\n  {values}\nON CONFLICT(item_id) DO NOTHING;")
    return "\n".join(out) + "\n"


def main() -> int:
    log(f"# Nightly sold collection (OpenWeb Ninja), {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC")
    log(f"search: {QUERY!r}, ${MIN_PRICE:g}+, up to {PAGES} pages")
    missing = [n for n, v in (("OPENWEBNINJA_KEY", KEY), ("CLOUDFLARE_API_TOKEN", CF_TOKEN),
                              ("CLOUDFLARE_ACCOUNT_ID", CF_ACCOUNT)) if not v]
    if missing:
        log(f"FAILED: missing secret(s): {', '.join(missing)}")
        return 2

    sales, stats = collect()
    log("")
    log(f"pages: {stats['pages_ok']} came back, {stats['pages_failed']} gave up; "
        f"calls {stats['calls']}, billed {stats['pages_ok']}; {stats['minutes']} min")
    log(f"stopped because: {stats['stopped']}")
    log(f"results {stats['results']}: kept {len(sales)}, lots/sealed dropped "
        f"{stats['dropped_not_single']}, undated or older than {KEEP_DAYS} days {stats['dropped_old_or_undated']}")

    added = 0
    if sales:
        rows = parse_into_rows(list(sales.values()))
        by_day: dict[str, int] = {}
        for r in rows:
            by_day[r["sold_date"]] = by_day.get(r["sold_date"], 0) + 1
        keyed = sum(1 for r in rows if r.get("card_key"))
        log(f"parsed {len(rows)}: {keyed} matched to a card; by day {dict(sorted(by_day.items()))}")
        if DRY_RUN:
            log("DRY_RUN: nothing uploaded")
        else:
            before = already_in_d1([r["item_id"] for r in rows])
            result = push_sql(CF_ACCOUNT, D1_ID, CF_TOKEN, insert_sql(rows))
            added = len(rows) - len(before)
            log(f"uploaded: {added} new sales added to the database "
                f"({len(before)} were already there and left untouched); {result.as_dict()}")

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write("```\n" + "\n".join(log_lines) + "\n```\n")

    # A run that collected nothing fails, so GitHub emails the owner instead of
    # a quiet zero hiding in a green tick. Running out of the free allowance is
    # expected, not a failure.
    if not sales and "allowance" not in stats["stopped"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
