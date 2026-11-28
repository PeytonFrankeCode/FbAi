#!/usr/bin/env python3
"""Nightly: collect football, baseball and basketball sales from two days ago from
The Card API (thecardapi.com) and add them to D1.

Why this exists: the home collector has been close to stopped since eBay hid
sold listings behind a sign-in, and OpenWeb Ninja's free tier is 100 calls a
month. The Card API is a licensed feed (eBay, Fanatics Collect, Goldin and the
auction houses). Its plans meter sales rows returned per UTC day (1 row = 1
sale): Starter, $9/mo, is 10,000 a day, allows commercial display, and allows
storing up to 500,000 of its records. Tested 20 Nov 2026 (scripts/probe-card-api.py).

What it does, in order:
  1. Pages through the day before yesterday's sales (yesterday is still being indexed) at CARDAPI_MIN_PRICE and up (the API's
     `price_min`), 100 a page, until the day runs out or the row budget does.
     Only titles naming a sports card maker (Panini, Topps, Bowman...), which
     keeps out the trading card games that were two-thirds of a day's rows,
     at the lowest price floor whose day fits the plan's rows.
  2. Keeps football, baseball and basketball (the API's sport filter doesn't
     work, so trading card games and other sports are dropped here and still
     cost rows; the sport field is often blank, so the title and the NFL
     roster fill in), and drops
     $0 / unconfirmed prices, lots, breaks, reprints and sealed product.
  3. Reads every title with NflCardDB's own parser, so rows match PC ones.
  4. Inserts into D1's `sales` with ON CONFLICT DO NOTHING. eBay sales keep
     their eBay item id (so one we already hold is never duplicated). Only
     eBay sales are kept (owner, Nov 2026; CARDAPI_EBAY_ONLY=0 to change that);
     other platforms would get "<platform>-<id>" (fanatics-123).
  5. Records every sale it added in `vendor_sales`, and keeps that set under
     the plan's storage cap by deleting the oldest. The terms also require
     deleting all stored records within 30 days of cancelling: see
     CARDAPI_PURGE below.

The free key is for evaluation only (its terms: "personal, non-commercial"),
so nothing is uploaded until CARDAPI_PLAN (a repo variable) names a paid plan.

Settings (environment):
  CARD_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID   required
  CARDAPI_PLAN       free (default: collect a sample, upload nothing) | starter | builder | pro
  CARDAPI_MIN_PRICE  lowest sale price in dollars (default: the lowest that fits the rows)
  CARDAPI_QUERY      the title query (default: sports card makers, so TCG is skipped)
  CARDAPI_ROWS       rows to spend per run (default: the plan's daily allowance less 300)
  CARDAPI_DAY        YYYY-MM-DD to collect (default: two days ago, UTC)
  CARDAPI_EBAY_ONLY  1 (default): keep eBay sales only; 0 also keeps Fanatics, Goldin...
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
from nflcarddb.sport import sport_from_title

KEY = os.environ.get("CARD_API_KEY", "").strip()
CF_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
CF_ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
D1_ID = "a887dd0e-d852-4ebc-98f0-0e01bc82ad0b"  # nflcarddb, as in NflCardDB's daily.bat
BASE = "https://www.thecardapi.com/api/v1/market"  # the bare host 307s here

# Daily rows and stored records per plan (thecardapi.com/pricing and /terms, Nov 2026).
PLANS = {
    "free":    {"rows": 5_000,   "store": 0,          "window": 30},
    "starter": {"rows": 10_000,  "store": 500_000,    "window": 60},
    "builder": {"rows": 50_000,  "store": 5_000_000,  "window": 90},
    "pro":     {"rows": 200_000, "store": 25_000_000, "window": 180},
}
PLAN = (os.environ.get("CARDAPI_PLAN") or "free").strip().lower()
if PLAN not in PLANS:
    PLAN = "free"
PAID = PLAN != "free"
# Stay a little under each limit: the probe and the site share the key.
ROWS = int(os.environ.get("CARDAPI_ROWS") or (300 if not PAID else PLANS[PLAN]["rows"] - 300))
# Complete pass: the rows the fresh day leaves go to the day this many days
# back, nearly complete by then (26 Nov 2026 counts: ~4,600 sports sales at 2
# days back, ~10,000 at 3, ~22,000 at 7, ~30,000 at 10-14), from $1 up (the
# sort puts the most expensive first anyway).
MATURE_DAYS = int(os.environ.get("CARDAPI_MATURE_DAYS") or 14)
BACKFILL_MIN_ROWS = 300
BACKFILL_FLOOR = 1.0
# Every page fetched is also written to CARDAPI_RAW_DIR (the workflow keeps it
# as a 30-day artifact), so a run's sales are never lost: a test run's, or one
# that failed after fetching. CARDAPI_REPLAY_DIR uploads a saved run's sales
# without spending any rows (owner, Nov 2026: "why didn't it save the results").
RAW_DIR = os.environ.get("CARDAPI_RAW_DIR") or ""
REPLAY_DIR = os.environ.get("CARDAPI_REPLAY_DIR") or ""
# A dry run (a push to a branch) is a check, not a collection: never spend a
# day's rows on one, whatever the plan.
if os.environ.get("DRY_RUN") == "1":
    ROWS = min(ROWS, 300)
STORE_CAP = int(PLANS[PLAN]["store"] * 0.96)
# The floor is chosen for the plan's whole day; on the free key (evaluation
# only) it's chosen as Starter would, so a dry run shows what Starter gets.
FLOOR_ROWS = (PLANS[PLAN]["rows"] if PAID else PLANS["starter"]["rows"]) - 300
# The API's `q` takes an any-of group, "(a,b,c)", over the title. Sports card
# makers' names keep trading card games out of the rows we pay for: on 23 Nov
# 2026 a 100-sale sample of this query was 95 sports cards, against about a
# third of the unfiltered day. (A Topps Pokemon card still slips in; the TCG
# filter below drops it.)
BRAND_QUERY = os.environ.get("CARDAPI_QUERY") or (
    "(panini,topps,bowman,upper deck,donruss,prizm,select,optic,mosaic,leaf,fleer,score,"
    "hoops,contenders,skybox,stadium club,sage,wild card,onit,playoff,pacific,pinnacle,finest)")
# Lowest price floor whose day still fits the row budget (cheapest sales are
# the most numerous, so the floor decides how many we can afford). A fixed
# CARDAPI_MIN_PRICE overrides the search.
FLOORS = (1, 2, 3, 5, 7, 10, 15, 25, 50)
# Most expensive first (owner, Nov 2026), so if the rows ever run short it's
# the cheapest sales that miss out.
SORT = os.environ.get("CARDAPI_SORT") or "price_desc"
# At most this many sales of one card (same card, same grade) per day (owner,
# Nov 2026: "we don't want more than 6 of a single card in a day"). A seller
# listing 50 copies of a $1 base card shouldn't drown the day. When a card
# sold more, six are kept spread across its prices (highest, lowest, and
# between), so the cap doesn't push the card's price up or down.
PER_CARD_DAY = int(os.environ.get("CARDAPI_PER_CARD_DAY") or 6)
MIN_PRICE = float(os.environ.get("CARDAPI_MIN_PRICE") or 0)
# Two days back, not one: the vendor is still indexing yesterday (25 Nov 2026:
# 1,515 brand sales for the 24th at $1+, while the 23rd had 6,253 at $5+).
DAY = os.environ.get("CARDAPI_DAY") or (datetime.now(timezone.utc).date() - timedelta(days=2)).isoformat()
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
# About two-thirds of a day's $15+ rows are trading card games (20 Nov 2026
# sample: category "tcg", mostly Pokemon on TCGplayer and Fanatics).
TCG_RE = re.compile(r"pok[eé]mon|\bmtg\b|magic the gathering|yu-?gi-?oh|one piece|lorcana|digimon"
                    r"|dragon ball|flesh and blood|weiss schwarz|star wars unlimited", re.I)
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


def save_raw(rows: list[dict]) -> None:
    """Keep what we paid for: one JSON line per sale, a file per day."""
    if not RAW_DIR or not rows:
        return
    import json
    Path(RAW_DIR).mkdir(parents=True, exist_ok=True)
    with open(Path(RAW_DIR) / f"{DAY}.jsonl", "a", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, separators=(",", ":")) + "\n")


def load_raw(path: Path) -> list[dict]:
    import json
    out, seen = [], set()
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        k = r.get("id") or line
        if k not in seen:
            seen.add(k)
            out.append(r)
    return out


# eBay sales only (owner, Nov 2026: "only use eBay sales"). Fanatics Collect,
# Goldin and the auction houses come with no photo and no page to link to.
# The vendor is asked for eBay only; whether it listens is untested, so other
# platforms are also dropped here (they still cost rows if it doesn't), and a
# filter it refuses or that empties the day is dropped for the rest of the run.
EBAY_ONLY = os.environ.get("CARDAPI_EBAY_ONLY", "1") != "0"
PLATFORM_PARAM: dict[str, str] = {"platform": "ebay"} if EBAY_ONLY else {}


def is_ebay(s: dict) -> bool:
    return str(s.get("platform") or "").strip().lower() == "ebay"


def fetch(page: int) -> tuple[list[dict], int | None, int | None]:
    """One page of the day's sales. Returns (rows, total, rows remaining today)."""
    params = {"date_from": DAY, "date_to": DAY, "limit": PAGE, "page": page, "sort": SORT, "q": BRAND_QUERY,
              **PLATFORM_PARAM}
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
        if r.status_code in (400, 422) and PLATFORM_PARAM:
            log(f"  the vendor refused the platform filter (HTTP {r.status_code}); filtering here instead")
            PLATFORM_PARAM.clear()
            return fetch(page)
        if r.status_code != 200:
            log(f"  page {page}: HTTP {r.status_code} {r.text[:150]}")
            return [], None, None
        j = r.json()
        if page == 1 and PLATFORM_PARAM and not (j.get("data") or []):
            # A whole day of sports sales with none on eBay means the filter
            # misread "ebay", not that the day was empty: ask again without it.
            log("  the platform filter returned nothing; filtering here instead")
            PLATFORM_PARAM.clear()
            return fetch(page)
        save_raw(j.get("data") or [])
        left = r.headers.get("x-ratelimit-remaining")
        return (j.get("data") or [], (j.get("pagination") or {}).get("total"),
                int(left) if left and left.lstrip("-").isdigit() else None)
    return [], None, None


def day_total(floor: float) -> int | None:
    """How many sales the day holds at this floor (costs one row)."""
    try:
        r = requests.get(f"{BASE}/sales", params={"date_from": DAY, "date_to": DAY, "limit": 1, "q": BRAND_QUERY,
                                                 "price_min": f"{floor:g}", **PLATFORM_PARAM},
                         headers={"x-market-api-key": KEY}, timeout=60)
        return int((r.json().get("pagination") or {}).get("total")) if r.ok else None
    except (requests.RequestException, ValueError, TypeError):
        return None


def pick_floor() -> float:
    """The lowest floor whose whole day fits the row budget."""
    for f in FLOORS:
        t = day_total(f)
        log(f"  floor ${f:g}: {t if t is not None else '?'} sales that day")
        if t is not None and t <= FLOOR_ROWS:
            return float(f)
    return float(FLOORS[-1])


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


_ROSTER: set[str] | None = None
NOT_FOOTBALL_NAMES = {"michael jordan", "chris paul", "anthony davis"}


# Player names by sport: the NFL roster NflCardDB uses, and the site's own
# basketball and baseball lists (public/data/sport-players.json, built for the
# checklists). Names lowercased with punctuation as spaces ("a ja wilson").
SPORT_PLAYERS = Path(__file__).resolve().parent.parent / "public" / "data" / "sport-players.json"
# Football players from the site's football checklists (the player pages'
# index). Cleaner than the roster learned from sale titles, which has picked
# up LeBron James, Kobe Bryant and Paul Skenes.
FOOTBALL_PLAYERS = Path(__file__).resolve().parent.parent / "public" / "data" / "players" / "index.json"
_NAMES: dict[str, set[str]] | None = None


def _norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(name or "").lower()).strip()


def _names() -> dict[str, set[str]]:
    global _NAMES, _ROSTER
    if _NAMES is None:
        if _ROSTER is None:
            _ROSTER = load_roster(ROSTER) if Path(ROSTER).exists() else set()
        import json
        try:
            other = json.loads(SPORT_PLAYERS.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            other = {}
        _NAMES = {}
        for sp in ("basketball", "baseball"):
            # Two words at least, and none of the list's stray non-names ("a card").
            _NAMES[sp] = {n for n in (_norm(x) for x in other.get(sp) or [])
                          if len(n.split()) >= 2 and "card" not in n.split()}
        try:
            idx = json.loads(FOOTBALL_PLAYERS.read_text(encoding="utf-8"))
            football = {_norm(p.get("name")) for p in idx.get("players") or []}
        except (OSError, ValueError, AttributeError):
            football = set()
        # The learned roster adds this season's rookies the checklists may not
        # have yet, but only names no other sport's list claims.
        taken = _NAMES["basketball"] | _NAMES["baseball"]
        football |= {n for n in (_norm(x) for x in _ROSTER) if n not in taken}
        _NAMES["football"] = {n for n in football if len(n.split()) >= 2}
    return _NAMES


def _player_sport(title: str) -> str | None:
    """The one sport whose player list names someone in the title, or None
    when no list does or two sports claim the same name."""
    names = _names()
    player = _norm(parse_title(title, _ROSTER).player or "")
    words = _norm(title).split()
    # The parsed player first; then any two or three words in a row, which
    # finds dual cards and names the parser missed.
    candidates = [player] if player else []
    candidates += [" ".join(words[i:i + n]) for n in (3, 2) for i in range(len(words) - n + 1)]
    for cand in candidates:
        hits = {sp for sp, ns in names.items() if cand in ns}
        if cand in NOT_FOOTBALL_NAMES:
            hits.discard("football")
        if len(hits) == 1:
            return hits.pop()
        if len(hits) > 1:
            return None
    return None


SOCCER_RE = re.compile(r"\b(mls|fifa|uefa|premier league|bundesliga|la liga|serie a|ligue 1|world cup|champions league"
                       r"|soccer|futbol|f[uú]tbol|topps merlin(?! olsen)|merlin (?:chrome|heritage)|match attax|euro 20\d\d|copa|messi|ronaldo|mbapp[eé]|haaland)\b", re.I)
# The same words in SQL, for the one-time sweep of soccer sales any collector
# stored as football (the OpenWeb Ninja search for "football card" finds them).
SOCCER_SQL_WORDS = ("% MLS %", "%FIFA%", "%UEFA%", "%Premier League%", "%Bundesliga%", "%Champions League%",
                    "%Soccer%", "%Topps Merlin%", "%Merlin Chrome%", "%Merlin Heritage%", "%Match Attax%", "%Messi%", "%Ronaldo%", "%Mbapp%", "%Haaland%")


def sport_of(s: dict, title: str) -> tuple[str | None, str]:
    """The sale's sport, or (None, why not). The vendor's own sport field
    first; it is blank on most recent sales, so then the players the title
    names (the site's checklist lists), and only then the title's own words.
    Set names alone are not trusted early: Prizm, Contenders and Topps Chrome
    are printed for every sport (26 Nov 2026: a Shai Gilgeous-Alexander
    Contenders card was filed as football)."""
    if SOCCER_RE.search(title):
        return None, "other sport"
    if str(s.get("category") or "").lower() == "tcg" or TCG_RE.search(title):
        return None, "trading card game"
    sport = str(s.get("sport") or "").strip().lower()
    if sport:
        return (sport, "") if sport in SPORTS else (None, "other sport")
    by_player = _player_sport(title)
    if by_player:
        return by_player, ""
    guess = sport_from_title(title)
    if guess:
        return (guess, "") if guess in SPORTS else (None, "other sport")
    return None, "sport not stated (no known player)"


def to_sale(s: dict) -> tuple[Sale | None, str]:
    """(sale, '') or (None, why it was dropped)."""
    if EBAY_ONLY and not is_ebay(s):
        return None, "not eBay"
    title = str(s.get("title") or "").strip()
    sport, why = sport_of(s, title)
    if not sport:
        return None, why
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
    if REPLAY_DIR:
        rows = [r for f in sorted(Path(REPLAY_DIR).rglob(f"{DAY}.jsonl")) for r in load_raw(f)]
        stats.update(pages=0, rows=0, total=len(rows), stopped="replayed from a saved run (no rows spent)")
        for s in rows:
            sale, why = to_sale(s)
            if sale:
                sales[sale.item_id] = sale
            else:
                stats["dropped"][why] = stats["dropped"].get(why, 0) + 1
        return sales, stats
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
        if page == 1 and rows:
            ps = [p for p in (cents(r.get("price_usd") if r.get("price_usd") is not None else r.get("price")) for r in rows) if p]
            ordered = all(a >= b for a, b in zip(ps, ps[1:]))
            if EBAY_ONLY:
                n_ebay = sum(1 for r in rows if is_ebay(r))
                log(f"  platform filter {'on' if PLATFORM_PARAM else 'off'}: {n_ebay} of the first {len(rows)} "
                    "sales are eBay" + ("" if n_ebay == len(rows) else " (the rest still cost rows)"))
            log(f"  sort {SORT}: first page runs ${ps[0] / 100:,.2f} down to ${ps[-1] / 100:,.2f}"
                + ("" if ordered or not SORT.startswith("price") else " (NOT in price order: the vendor ignored the sort)") if ps else "")
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


def cap_per_card(rows: list[dict]) -> tuple[list[dict], int]:
    """At most PER_CARD_DAY sales of one card in one grade on one day, spread
    across its prices. Returns (rows kept, how many were dropped)."""
    groups: dict[tuple, list[dict]] = {}
    for r in rows:
        ident = r.get("card_key") or re.sub(r"[^a-z0-9]+", " ", str(r.get("title") or "").lower()).strip()
        key = (ident, r.get("grader") or "", str(r.get("grade") or ""), r.get("sold_date") or "")
        groups.setdefault(key, []).append(r)
    kept: list[dict] = []
    for g in groups.values():
        if len(g) <= PER_CARD_DAY:
            kept.extend(g)
            continue
        g.sort(key=lambda r: r.get("price_cents") or 0, reverse=True)
        n = len(g)
        picks = sorted({round(i * (n - 1) / (PER_CARD_DAY - 1)) for i in range(PER_CARD_DAY)})
        kept.extend(g[i] for i in picks)
    return kept, len(rows) - len(kept)


def parse_into_rows(sales: list[Sale], confirmed_offers: set[str]) -> list[dict]:
    """NflCardDB's own storage and parser, read back in its uploader's shape."""
    roster = load_roster(ROSTER) if Path(ROSTER).exists() else None
    with tempfile.TemporaryDirectory() as tmp:
        conn = store.connect(Path(tmp) / "night.sqlite")
        try:
            run_id = store.start_run(conn, None)
            store.upsert_sales(conn, sales, run_id)
            # The sport sport_of() chose is final: NflCardDB's parser lets a
            # set name in the title override it (Contenders reads as football),
            # which the player lists have already ruled on. Set before the
            # card is stored, so its card_key is built for that sport.
            parsed = []
            for s in sales:
                attrs = parse_title(s.title, roster, collected_as=s.sport)
                if s.sport:
                    attrs.sport = s.sport
                parsed.append((s.item_id, attrs))
            store.upsert_cards(conn, parsed, PARSER_VERSION)
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


# A sale with no photo (Fanatics Collect and Yahoo sales come without one)
# borrows the newest eBay photo of the same card, in the same grade when one
# has a photo and in any grade otherwise, marked
# with "#same-card" so the site labels it "Photo of the same card".
SAME_CARD_TAG = "#same-card"


def _grade_key(r: dict) -> tuple:
    return (r.get("card_key") or "", str(r.get("grader") or ""), str(r.get("grade") or ""))


def fill_photos(rows: list[dict]) -> int:
    """Give photo-less rows a photo of the same card and grade, from this
    batch or from D1. Returns how many got one."""
    need = [r for r in rows if not r.get("image_url") and r.get("card_key")]
    if not need:
        return 0
    have: dict[tuple, str] = {}
    for r in rows:
        u = str(r.get("image_url") or "")
        if u.startswith("https://i.ebayimg.com/") and r.get("card_key"):
            have.setdefault(_grade_key(r), u.split("#")[0])
    keys = sorted({r["card_key"] for r in need if _grade_key(r) not in have})
    for i in range(0, len(keys), 80):
        chunk = keys[i:i + 80]
        sql = ("SELECT card_key, grader, grade, image_url FROM sales WHERE card_key IN (%s) "
               "AND image_url LIKE 'https://i.ebayimg.com/%%' ORDER BY sold_date DESC LIMIT 4000"
               % ",".join(_sql_literal(k) for k in chunk))
        for row in d1(sql):
            have.setdefault(_grade_key(row), str(row["image_url"]).split("#")[0])
    # Same card in any grade, when no copy in the same grade has a photo
    # (26 Nov 2026: same grade only found photos for 512 of 2,471). A slab's
    # photo for a raw sale still shows the right card.
    any_grade: dict[str, str] = {}
    for (key, _g, _n), u in have.items():
        any_grade.setdefault(key, u)
    n = 0
    for r in need:
        u = have.get(_grade_key(r)) or any_grade.get(r["card_key"])
        if u:
            r["image_url"] = u + SAME_CARD_TAG
            n += 1
    return n


def fix_stored() -> None:
    """One pass over the Card API sales already stored: re-file any whose
    sport the current rules read differently (drop soccer), and give photo-
    less ones a photo of the same card. Runs when this script changes."""
    rows = d1("SELECT s.item_id, s.title, s.sport, s.price_cents, s.shipping_cents, s.currency, s.sold_date, "
              "s.listing_format, s.bids, s.best_offer, s.image_url, s.offer_known FROM sales s "
              f"JOIN vendor_sales v ON v.item_id = s.item_id WHERE v.vendor = '{VENDOR}'")
    log(f"fix: {len(rows):,} stored Card API sales")
    if EBAY_ONLY:
        # eBay only (owner, Nov 2026): the Fanatics, Goldin and auction-house
        # sales already stored go. eBay ids are all digits; the others are
        # "<platform>-<id>".
        gone = [r["item_id"] for r in rows if not str(r["item_id"]).isdigit()]
        for i in range(0, len(gone), 500):
            lit = ",".join(_sql_literal(x) for x in gone[i:i + 500])
            push_sql(CF_ACCOUNT, D1_ID, CF_TOKEN, f"DELETE FROM sales WHERE item_id IN ({lit});\n"
                                                  f"DELETE FROM vendor_sales WHERE item_id IN ({lit});\n")
        log(f"fix: {len(gone):,} non-eBay sales removed (eBay only)")
        rows = [r for r in rows if str(r["item_id"]).isdigit()]
    drop, refile = [], []
    for r in rows:
        title = str(r.get("title") or "")
        new, why = sport_of({}, title)
        if why == "other sport" and SOCCER_RE.search(title):
            drop.append(r["item_id"])
        elif new and new != (r.get("sport") or ""):
            refile.append((r, new))
    if drop:
        ids = ",".join(_sql_literal(x) for x in drop)
        push_sql(CF_ACCOUNT, D1_ID, CF_TOKEN, f"DELETE FROM sales WHERE item_id IN ({ids});\n"
                                              f"DELETE FROM vendor_sales WHERE item_id IN ({ids});\n")
    log(f"fix: {len(drop):,} soccer sales removed; {len(refile):,} to re-file under another sport")
    if refile:
        sales = [Sale(item_id=r["item_id"], title=r["title"], price_cents=r.get("price_cents"),
                      currency=r.get("currency") or "USD", shipping_cents=r.get("shipping_cents"),
                      sold_date=r.get("sold_date"), listing_format=r.get("listing_format") or "fixed",
                      bids=r.get("bids"), best_offer=bool(r.get("best_offer")), url=None,
                      image_url=(r.get("image_url") or "").split("#")[0] or None,
                      query_id=VENDOR, sport=new) for r, new in refile]
        known = {r["item_id"] for r, _ in refile if r.get("offer_known")}
        fixed = parse_into_rows(sales, known)
        ids = ",".join(_sql_literal(r["item_id"]) for r, _ in refile)
        push_sql(CF_ACCOUNT, D1_ID, CF_TOKEN, f"DELETE FROM sales WHERE item_id IN ({ids});\n")
        push_sql(CF_ACCOUNT, D1_ID, CF_TOKEN, insert_sql(fixed))
        moves: dict[str, int] = {}
        for (r, new) in refile:
            k = f"{r.get('sport') or '?'}->{new}"
            moves[k] = moves.get(k, 0) + 1
        log(f"fix: re-filed {moves}")
    # Soccer stored as football by any collector, recent first, in batches so
    # one statement never scans the whole table (D1 overloads, Nov 2026).
    like = " OR ".join(f"title LIKE {_sql_literal(w)}" for w in SOCCER_SQL_WORDS)
    since = (datetime.now(timezone.utc).date() - timedelta(days=400)).isoformat()
    swept = 0
    # A few batches a run: each scan is heavy, and D1 answered "overloaded"
    # during the first sweep (27 Nov). What's left goes on the next run.
    for _ in range(4):
        # Merlin Olsen is an NFL Hall of Famer, not a Topps Merlin soccer card.
        ids = [r["item_id"] for r in d1(f"SELECT item_id FROM sales WHERE sold_date >= '{since}' "
                                        f"AND (sport IS NULL OR sport = 'football') AND ({like}) "
                                        f"AND title NOT LIKE '%Merlin Olsen%' LIMIT 500")]
        if not ids:
            break
        lit = ",".join(_sql_literal(x) for x in ids)
        push_sql(CF_ACCOUNT, D1_ID, CF_TOKEN, f"DELETE FROM sales WHERE item_id IN ({lit});\n"
                                              f"DELETE FROM vendor_sales WHERE item_id IN ({lit});\n")
        swept += len(ids)
        if len(ids) < 500:
            break   # that scan found them all; don't scan the table again
    log(f"fix: {swept:,} soccer sales (any collector) removed from football")
    # Photos for the stored sales that have none.
    bare = d1("SELECT s.item_id, s.card_key, s.grader, s.grade, s.image_url FROM sales s "
              f"JOIN vendor_sales v ON v.item_id = s.item_id WHERE v.vendor = '{VENDOR}' AND s.image_url IS NULL")
    got = fill_photos(bare)
    sets = [f"UPDATE sales SET image_url = {_sql_literal(r['image_url'])} WHERE item_id = {_sql_literal(r['item_id'])};"
            for r in bare if r.get("image_url")]
    for i in range(0, len(sets), 200):
        push_sql(CF_ACCOUNT, D1_ID, CF_TOKEN, "\n".join(sets[i:i + 200]) + "\n")
    log(f"fix: {got:,} of {len(bare):,} photo-less sales got a photo of the same card")


def process_day() -> tuple[int, int, str]:
    """Collect DAY within ROWS and upload it. Returns (rows spent, sales
    added, why it stopped)."""
    global MIN_PRICE
    log(f"sales on {DAY}, up to {ROWS:,} rows")
    if MIN_PRICE <= 0:
        MIN_PRICE = pick_floor()
    log(f"query {BRAND_QUERY}; price floor ${MIN_PRICE:g}")
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
        rows, capped = cap_per_card(rows)
        if not DRY_RUN:
            borrowed = fill_photos(rows)
            if borrowed:
                log(f"photos: {borrowed:,} photo-less sales got a photo of the same card and grade")
        if capped:
            log(f"capped: {capped:,} sales dropped as more than {PER_CARD_DAY} of one card that day")
        top = sorted(rows, key=lambda r: r.get("price_cents") or 0, reverse=True)[:5]
        for r in top:
            log(f"  top: ${(r.get('price_cents') or 0) / 100:,.2f}  {str(r.get('title') or '')[:80]}")
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
    return stats["rows"], added, stats["stopped"]


def main() -> int:
    global DAY, ROWS, MIN_PRICE
    log(f"# Nightly sold collection (The Card API), {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC")
    missing = [n for n, v in (("CARD_API_KEY", KEY), ("CLOUDFLARE_API_TOKEN", CF_TOKEN),
                              ("CLOUDFLARE_ACCOUNT_ID", CF_ACCOUNT)) if not v]
    if missing:
        log(f"FAILED: missing secret(s): {', '.join(missing)}")
        return 2
    # A backup start (another workflow finishing, see the workflow file) waits
    # for the morning, so the day two back has filled in as usual.
    if os.environ.get("GITHUB_EVENT_NAME") == "workflow_run" and datetime.now(timezone.utc).hour < 11:
        log("backup start before 11:00 UTC: nothing to do yet")
        return 0
    if PURGE:
        ensure_tracking()
        log(f"PURGE: deleted {purge():,} Card API sales from D1")
        return 0

    if REPLAY_DIR:
        days = sorted({f.stem for f in Path(REPLAY_DIR).rglob("*.jsonl")})
        log(f"REPLAY: uploading saved sales for {days or 'nothing (no saved files found)'}")
        added_total = 0
        for day in days:
            DAY, MIN_PRICE = day, 1.0
            log("")
            _, a_, _ = process_day()
            added_total += a_
        log(f"TOTAL: {added_total:,} new sales added from the saved run")
        return 0
    if os.environ.get("CARDAPI_FIX") == "1" and PAID and not DRY_RUN:
        ensure_tracking()
        fix_stored()
        log("")
    log(f"plan {PLAN}: up to {ROWS:,} rows"
        + ("" if PAID else " (free key: evaluation only, nothing will be uploaded)"))
    budget = ROWS
    spent, added_total, stopped = process_day()

    # Complete pass (owner, Nov 2026: fresh data matters most, but a day keeps
    # filling in for about two weeks). The fresh pass above takes the day from
    # two days ago, all of it so far (~4,600 on 26 Nov). The rows left go to
    # the day MATURE_DAYS back, which by then holds ~30,000 sports sales: its
    # most expensive first. Every day passes through both, once each.
    left = budget - spent
    if PAID and not DRY_RUN and "vendor stopped" not in stopped and left >= BACKFILL_MIN_ROWS:
        day = (datetime.now(timezone.utc).date() - timedelta(days=MATURE_DAYS)).isoformat()
        log("")
        log(f"## complete pass: {day} ({MATURE_DAYS} days back), {left:,} rows left")
        DAY, ROWS, MIN_PRICE = day, left, BACKFILL_FLOOR
        s_, a_, stopped = process_day()
        added_total += a_
    log("")
    log(f"TOTAL: {added_total:,} new sales added this run")

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write("```\n" + "\n".join(log_lines) + "\n```\n")
    # A run that added nothing fails, so GitHub emails the owner, unless the
    # vendor's daily limit was why (expected after a busy day) or it was a test.
    if not added_total and not DRY_RUN and "vendor stopped" not in stopped:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
