#!/usr/bin/env python3
"""Nightly: collect yesterday's football, baseball and basketball sales from
The Card API (thecardapi.com) and add them to D1.

Why this exists: the home collector has been close to stopped since eBay hid
sold listings behind a sign-in, and OpenWeb Ninja's free tier is 100 calls a
month. The Card API is a licensed feed (eBay, Fanatics Collect, Goldin and the
auction houses). Its plans meter sales rows returned per UTC day (1 row = 1
sale): Starter, $9/mo, is 10,000 a day, allows commercial display, and allows
storing up to 500,000 of its records. Tested 20 Nov 2026 (scripts/probe-card-api.py).

What it does, in order:
  1. Pages through yesterday's sales at CARDAPI_MIN_PRICE and up (the API's
     `price_min`), 100 a page, until the day runs out or the row budget does.
     Most sales are $1-4 singles; $15+ keeps the day near 10,000 rows.
  2. Keeps football, baseball and basketball (the API's sport filter doesn't
     work, so other sports are dropped here and still cost rows), and drops
     $0 / unconfirmed prices, lots, breaks, reprints and sealed product.
  3. Reads every title with NflCardDB's own parser, so rows match PC ones.
  4. Inserts into D1's `sales` with ON CONFLICT DO NOTHING. eBay sales keep
     their eBay item id (so one we already hold is never duplicated); other
     platforms get "<platform>-<id>" (fanatics-123), which the site labels.
  5. Records every sale it added in `vendor_sales`, and keeps that set under
     the plan's storage cap by deleting the oldest. The terms also require
     deleting all stored records within 30 days of cancelling: see
     CARDAPI_PURGE below.

The free key is for evaluation only (its terms: "personal, non-commercial"),
so nothing is uploaded until CARDAPI_PLAN (a repo variable) names a paid plan.

Settings (environment):
  CARD_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID   required
  CARDAPI_PLAN       free (default: collect a sample, upload nothing) | starter | builder | pro
  CARDAPI_MIN_PRICE  lowest sale price in dollars (default 15)
  CARDAPI_ROWS       rows to spend per run (default: the plan's daily allowance less 300)
  CARDAPI_DAY        YYYY-MM-DD to collect (default: yesterday, UTC)
  CARDAPI_PURGE=1    delete every Card API sale from D1 (after cancelling)
  DRY_RUN=1          collect and parse, upload nothing
"""

from __future__ import annotations

import os
import re
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from nflcarddb import db as store
from nflcarddb.api_export import EXPORT_COLUMNS, _iter_rows_to_export, _sql_literal
from nflcarddb.d1_http import push_sql, run_sql
from nflcarddb.models import Sale
from nflcarddb.parse_title import PARSER_VERSION, load_roster, parse_title

KEY = os.environ.get("CARD_API_KEY", "").strip()
CF_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
CF_ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
D1_ID = "a887dd0e-d852-4ebc-98f0-0e01bc82ad0b"  # nflcarddb, as in NflCardDB's daily.bat
BASE = "https://www.thecardapi.com/api/v1/market"  # the bare host 307s here

# Daily rows and stored records per plan (thecardapi.com/pricing and /terms, Nov 2026).
PLANS = {
    "free":    {"rows": 5_000,   "store": 0},
    "starter": {"rows": 10_000,  "store": 500_000},
    "builder": {"rows": 50_000,  "store": 5_000_000},
    "pro":     {"rows": 200_000, "store": 25_000_000},
}
PLAN = (os.environ.get("CARDAPI_PLAN") or "free").strip().lower()
if PLAN not in PLANS:
    PLAN = "free"
PAID = PLAN != "free"
# Stay a little under each limit: the probe and the site share the key.
ROWS = int(os.environ.get("CARDAPI_ROWS") or (300 if not PAID else PLANS[PLAN]["rows"] - 300))
STORE_CAP = int(PLANS[PLAN]["store"] * 0.96)
MIN_PRICE = float(os.environ.get("CARDAPI_MIN_PRICE") or 15)
DAY = os.environ.get("CARDAPI_DAY") or (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()
DRY_RUN = os.environ.get("DRY_RUN") == "1" or not PAID
PURGE = os.environ.get("CARDAPI_PURGE") == "1"
ROSTER = os.environ.get("NFLCARDDB_ROSTER", "nflcarddb/config/nfl_players.txt")
PAGE = 100
VENDOR = "thecardapi"

SPORTS = {"football", "baseball", "basketball"}
NOT_A_SINGLE = re.compile(
    r"\blots?\b|\bsealed\b|\bunopened\b|\bwax\b|\bhobby box\b|\bblaster\b|\bmega box\b"
    r"|\bpacks?\b|\bteam set\b|\bcomplete set\b|\bcase\b|\bbreak\b|\bbundle\b|\byou pick\b"
    r"|\bpick your\b|\breprint\b|\bfacsimile\b|\bdigital\b|\bmagnet\b|\bcustom\b"
    r"|\bgroup of\b|\bin total\b|\b\d{2,}\s*(?:graded\s+)?cards\b",
    re.I,
)
ITEM_RE = re.compile(r"/itm/(?:[^/?#]+/)?(\d{9,15})")
SLUG_RE = re.compile(r"[^a-z0-9]+")
# Must match SALE_PLATFORMS in server.js, which labels and links these.
KNOWN_SLUGS = {"fanatics", "goldin", "lelands", "scpauctions", "hakes", "rea", "pwcc",
               "heritage", "tcgplayer", "yahooauctionsjapan"}

log_lines: list[str] = []


def log(line: str = "") -> None:
    for k in (KEY, CF_TOKEN):
        if k:
            line = line.replace(k, "***")
    print(line, flush=True)
    log_lines.append(line)


class OutOfRows(RuntimeError):
    """The plan's daily allowance is used up: stop, don't retry."""


def fetch(page: int) -> tuple[list[dict], int | None, int | None]:
    """One page of the day's sales. Returns (rows, total, rows remaining today)."""
    params = {"date_from": DAY, "date_to": DAY, "limit": PAGE, "page": page, "sort": "date_desc"}
    if MIN_PRICE > 0:
        params["price_min"] = f"{MIN_PRICE:g}"
    for attempt in range(1, 5):
        try:
            r = requests.get(f"{BASE}/sales", params=params,
                             headers={"x-market-api-key": KEY}, timeout=60)
        except requests.RequestException as e:
            log(f"  page {page} try {attempt}: {type(e).__name__}")
            time.sleep(10 * attempt)
            continue
        if r.status_code == 429:
            raise OutOfRows(f"HTTP 429: {r.text[:150]}")
        if r.status_code in (401, 403):
            raise OutOfRows(f"HTTP {r.status_code}: {r.text[:150]}")
        if r.status_code >= 500:
            time.sleep(10 * attempt)
            continue
        if r.status_code != 200:
            log(f"  page {page}: HTTP {r.status_code} {r.text[:150]}")
            return [], None, None
        j = r.json()
        left = r.headers.get("x-ratelimit-remaining")
        return (j.get("data") or [], (j.get("pagination") or {}).get("total"),
                int(left) if left and left.lstrip("-").isdigit() else None)
    return [], None, None


def cents(v) -> int | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return round(f * 100) if f > 0 else None


def item_id_of(s: dict) -> str | None:
    """eBay sales keep their eBay id; others get '<platform>-<id>'."""
    platform = str(s.get("platform") or "").strip()
    if platform.lower() == "ebay":
        m = ITEM_RE.search(str(s.get("listing_url") or ""))
        return m.group(1) if m else None
    sid = str(s.get("id") or "").strip()
    slug = SLUG_RE.sub("", platform.lower().replace("collect", ""))
    return f"{slug}-{sid}" if sid and slug in KNOWN_SLUGS else None


def to_sale(s: dict) -> tuple[Sale | None, str]:
    """(sale, '') or (None, why it was dropped)."""
    sport = str(s.get("sport") or "").strip().lower()
    if sport not in SPORTS:
        return None, "other sport"
    title = str(s.get("title") or "").strip()
    if not title or NOT_A_SINGLE.search(title):
        return None, "lot, sealed or reprint"
    price = cents(s.get("price_usd") if s.get("price_usd") is not None else s.get("price"))
    if price is None or s.get("price_confirmed") is False:
        return None, "no confirmed price"
    day = str(s.get("sold_at") or s.get("sale_date") or "")[:10]
    iid = item_id_of(s)
    if not iid or not day:
        return None, "no id or date, or unknown platform"
    ltype = str(s.get("listing_type") or "").lower()
    bids = s.get("bids") if isinstance(s.get("bids"), int) and s.get("bids") > 0 else None
    return Sale(
        item_id=iid,
        title=title,
        price_cents=price,
        currency="USD",
        shipping_cents=cents(s.get("shipping_price")),
        sold_date=day,
        listing_format="auction" if ltype == "auction" or bids else "fixed",
        bids=bids,
        best_offer=ltype == "best_offer",
        condition=s.get("condition"),
        url=s.get("listing_url"),
        image_url=s.get("image_url") or s.get("thumbnail_url"),
        query_id=VENDOR,
        sport=sport,
    ), ""


def collect() -> tuple[dict[str, Sale], dict]:
    sales: dict[str, Sale] = {}
    stats = {"pages": 0, "rows": 0, "total": None, "left": None, "dropped": {}, "stopped": ""}
    page = 0
    while stats["rows"] + PAGE <= ROWS:
        page += 1
        try:
            rows, total, left = fetch(page)
        except OutOfRows as e:
            stats["stopped"] = f"vendor stopped us: {e}"
            break
        stats["pages"] += 1
        stats["rows"] += len(rows)
        if total is not None:
            stats["total"] = total
        if left is not None:
            stats["left"] = left
        for s in rows:
            sale, why = to_sale(s)
            if sale:
                sales[sale.item_id] = sale
            else:
                stats["dropped"][why] = stats["dropped"].get(why, 0) + 1
        if len(rows) < PAGE:
            stats["stopped"] = "the day ran out of sales"
            break
        if left is not None and left < PAGE + 50:
            stats["stopped"] = f"daily allowance nearly used ({left} left)"
            break
    if not stats["stopped"]:
        stats["stopped"] = f"row budget reached ({ROWS:,})"
    return sales, stats


def parse_into_rows(sales: list[Sale], confirmed_offers: set[str]) -> list[dict]:
    """NflCardDB's own storage and parser, read back in its uploader's shape."""
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
            rows = [dict(r) for r in _iter_rows_to_export(conn, None)]
        finally:
            conn.close()
    # The Card API reports the accepted price on a best offer (price_confirmed),
    # which eBay hides signed out: say so, so the site trusts it.
    for r in rows:
        if r["item_id"] in confirmed_offers:
            r["offer_known"] = 1
    return rows


def d1(sql: str) -> list[dict]:
    res = run_sql(CF_ACCOUNT, D1_ID, CF_TOKEN, sql)
    out: list[dict] = []
    for block in res.get("result") or []:
        out.extend(block.get("results") or [])
    return out


def ensure_tracking() -> None:
    d1("CREATE TABLE IF NOT EXISTS vendor_sales (item_id TEXT PRIMARY KEY, vendor TEXT NOT NULL, "
       "sold_date TEXT, added_at TEXT NOT NULL DEFAULT (datetime('now')))")
    d1("CREATE INDEX IF NOT EXISTS vendor_sales_by_date ON vendor_sales (vendor, sold_date)")


def already_in_d1(ids: list[str]) -> set[str]:
    have: set[str] = set()
    for i in range(0, len(ids), 90):
        chunk = ids[i:i + 90]
        for row in d1("SELECT item_id FROM sales WHERE item_id IN (%s)" % ",".join(_sql_literal(x) for x in chunk)):
            have.add(str(row["item_id"]))
    return have


def insert_sql(rows: list[dict]) -> str:
    cols = ", ".join(EXPORT_COLUMNS)
    out = []
    for i in range(0, len(rows), 50):
        chunk = rows[i:i + 50]
        values = ",\n  ".join("(" + ", ".join(_sql_literal(r.get(c)) for c in EXPORT_COLUMNS) + ")" for r in chunk)
        out.append(f"INSERT INTO sales ({cols}) VALUES\n  {values}\nON CONFLICT(item_id) DO NOTHING;")
        track = ",\n  ".join(f"({_sql_literal(r['item_id'])}, '{VENDOR}', {_sql_literal(r.get('sold_date'))})" for r in chunk)
        out.append(f"INSERT INTO vendor_sales (item_id, vendor, sold_date) VALUES\n  {track}\nON CONFLICT(item_id) DO NOTHING;")
    return "\n".join(out) + "\n"


def prune_to_cap() -> int:
    """Delete the oldest Card API sales beyond the plan's storage cap."""
    n = int((d1(f"SELECT COUNT(*) AS n FROM vendor_sales WHERE vendor = '{VENDOR}'") or [{"n": 0}])[0]["n"])
    extra = n - STORE_CAP
    if extra <= 0:
        return 0
    old = (f"SELECT item_id FROM vendor_sales WHERE vendor = '{VENDOR}' "
           f"ORDER BY sold_date, added_at LIMIT {extra}")
    push_sql(CF_ACCOUNT, D1_ID, CF_TOKEN,
             f"DELETE FROM sales WHERE item_id IN ({old});\n"
             f"DELETE FROM vendor_sales WHERE item_id IN ({old});\n")
    return extra


def purge() -> int:
    """After cancelling: the terms require deleting every stored record."""
    n = int((d1(f"SELECT COUNT(*) AS n FROM vendor_sales WHERE vendor = '{VENDOR}'") or [{"n": 0}])[0]["n"])
    push_sql(CF_ACCOUNT, D1_ID, CF_TOKEN,
             f"DELETE FROM sales WHERE item_id IN (SELECT item_id FROM vendor_sales WHERE vendor = '{VENDOR}');\n"
             f"DELETE FROM vendor_sales WHERE vendor = '{VENDOR}';\n")
    return n


def main() -> int:
    log(f"# Nightly sold collection (The Card API), {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC")
    missing = [n for n, v in (("CARD_API_KEY", KEY), ("CLOUDFLARE_API_TOKEN", CF_TOKEN),
                              ("CLOUDFLARE_ACCOUNT_ID", CF_ACCOUNT)) if not v]
    if missing:
        log(f"FAILED: missing secret(s): {', '.join(missing)}")
        return 2
    if PURGE:
        ensure_tracking()
        log(f"PURGE: deleted {purge():,} Card API sales from D1")
        return 0

    log(f"plan {PLAN}: sales on {DAY}, ${MIN_PRICE:g}+, up to {ROWS:,} rows"
        + ("" if PAID else " (free key: evaluation only, nothing will be uploaded)"))
    sales, stats = collect()
    total = f"{stats['total']:,}" if isinstance(stats["total"], int) else "?"
    log(f"pages {stats['pages']}, rows spent {stats['rows']:,} of {total} that day at "
        f"${MIN_PRICE:g}+; allowance left {stats['left']}")
    log(f"stopped because: {stats['stopped']}")
    log(f"kept {len(sales):,}; dropped {dict(sorted(stats['dropped'].items()))}")

    added = 0
    if sales:
        confirmed = {iid for iid, s in sales.items() if s.best_offer}
        rows = parse_into_rows(list(sales.values()), confirmed)
        by_sport: dict[str, int] = {}
        by_platform: dict[str, int] = {}
        for r in rows:
            by_sport[r.get("sport") or "?"] = by_sport.get(r.get("sport") or "?", 0) + 1
            p = "ebay" if r["item_id"].isdigit() else r["item_id"].split("-", 1)[0]
            by_platform[p] = by_platform.get(p, 0) + 1
        keyed = sum(1 for r in rows if r.get("card_key"))
        log(f"parsed {len(rows):,}: {keyed:,} matched to a card; by sport {by_sport}; by platform {by_platform}")
        if DRY_RUN:
            log("DRY_RUN: nothing uploaded")
        else:
            ensure_tracking()
            before = already_in_d1([r["item_id"] for r in rows])
            # A sale our own collector already holds stays ours: never tracked,
            # so a purge after cancelling can't take it.
            mine = [r for r in rows if r["item_id"] not in before]
            if mine:
                result = push_sql(CF_ACCOUNT, D1_ID, CF_TOKEN, insert_sql(mine))
                log(f"push: {result.as_dict()}")
            added = len(mine)
            log(f"uploaded: {added:,} new sales ({len(before):,} already there, left untouched)")
            pruned = prune_to_cap()
            if pruned:
                log(f"storage cap {STORE_CAP:,}: removed the {pruned:,} oldest Card API sales")

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write("```\n" + "\n".join(log_lines) + "\n```\n")
    if not sales and "vendor stopped" not in stats["stopped"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
