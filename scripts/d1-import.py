#!/usr/bin/env python3
"""Push NflCardDB sales into Cloudflare D1 without Node, npm or wrangler.

Reads the local SQLite database directly and writes rows to D1 over the REST
API using bound parameters. Nothing is parsed out of a generated .sql file, so
card titles containing quotes or semicolons cannot corrupt a statement.

Standard library only — no pip install required.

    export CLOUDFLARE_API_TOKEN=...        # token with D1:Edit on the account
    python3 scripts/d1-import.py \
        --db /path/to/nflcarddb.sqlite \
        --account-id <account id> \
        --database-id <d1 database id>

Incremental after the first load (much faster, same result — item_id is the
primary key end to end, so every write is an upsert and re-running is safe):

    python3 scripts/d1-import.py ... --since 2026-07-01

Create the database and apply api/schema.sql in the Cloudflare dashboard
first: Storage & Databases -> D1 -> Create, then the console tab.
"""

import argparse
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request

API_BASE = "https://api.cloudflare.com/client/v4"

# Column order is fixed here so the INSERT and the flattened parameter list can
# never drift apart.
COLUMNS = [
    "item_id", "sold_date", "title", "price_cents", "shipping_cents",
    "currency", "best_offer", "listing_format", "bids", "player", "team",
    "year", "brand", "set_name", "parallel", "card_number", "grader",
    "grade", "is_rookie", "is_auto", "confidence",
]

# SQLite caps bound parameters per statement (999 on older builds). 21 columns
# x 40 rows = 840, which stays under that without needing to probe the server.
DEFAULT_BATCH = 40


def d1_query(account_id, database_id, token, sql, params=None):
    """Run one statement against D1. Raises RuntimeError on an API-level error."""
    url = f"{API_BASE}/accounts/{account_id}/d1/database/{database_id}/query"
    body = json.dumps({"sql": sql, "params": params or []}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")[:500]
        raise RuntimeError(f"HTTP {err.code}: {detail}") from None
    except urllib.error.URLError as err:
        raise RuntimeError(f"network error: {err.reason}") from None

    if not payload.get("success"):
        errors = payload.get("errors") or payload.get("messages") or payload
        raise RuntimeError(f"D1 rejected the request: {json.dumps(errors)[:500]}")
    return payload.get("result")


def split_schema(sql_text):
    """Split a schema file into individual statements.

    Strips `--` comments first: the D1 dashboard console rejects input it reads
    as comment-only ("Requests without any query are not supported"), and
    sending statements one at a time avoids that entirely.

    Naive `;` splitting is safe here because a schema file contains only DDL —
    no free-text string literals that could hold a semicolon. Do NOT reuse this
    for data; that is exactly why the row import binds parameters instead.
    """
    lines = []
    for line in sql_text.splitlines():
        stripped = line.strip()
        if stripped.startswith("--") or not stripped:
            continue
        lines.append(line)
    joined = "\n".join(lines)
    return [s.strip() for s in joined.split(";") if s.strip()]


def apply_schema(account_id, database_id, token, path, dry_run=False):
    """Run each statement in a .sql schema file against D1."""
    with open(path, "r", encoding="utf-8") as fh:
        statements = split_schema(fh.read())

    if not statements:
        sys.exit(f"{path} contains no SQL statements (only comments?).")

    print(f"Applying {len(statements)} statement(s) from {path}")
    for i, stmt in enumerate(statements, 1):
        first = " ".join(stmt.split()[:4])
        if dry_run:
            print(f"  [{i}/{len(statements)}] would run: {first} ...")
            continue
        d1_query(account_id, database_id, token, stmt)
        print(f"  [{i}/{len(statements)}] {first} ... ok")
    print("Schema applied.")


def batched(cursor, size):
    """Yield lists of rows so the whole table never has to sit in memory."""
    while True:
        rows = cursor.fetchmany(size)
        if not rows:
            return
        yield rows


def main():
    ap = argparse.ArgumentParser(description="Import NflCardDB sales into Cloudflare D1.")
    ap.add_argument("--db", help="path to the local SQLite file (omit with --schema to only create tables)")
    ap.add_argument("--schema", help="apply this .sql schema file first (e.g. api/schema.sql)")
    ap.add_argument("--account-id", required=True, help="Cloudflare account id")
    ap.add_argument("--database-id", required=True, help="D1 database id")
    ap.add_argument("--since", help="only rows with sold_date >= this (YYYY-MM-DD)")
    ap.add_argument("--batch", type=int, default=DEFAULT_BATCH,
                    help=f"rows per request (default {DEFAULT_BATCH})")
    ap.add_argument("--table", default="sales", help="source table (default: sales)")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would be sent without calling the API")
    args = ap.parse_args()

    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if not token and not args.dry_run:
        sys.exit("CLOUDFLARE_API_TOKEN is not set. Create a token with D1:Edit "
                 "at https://dash.cloudflare.com/profile/api-tokens")

    if not args.db and not args.schema:
        sys.exit("Nothing to do — pass --schema to create tables, --db to load rows, or both.")

    if args.schema:
        if not os.path.exists(args.schema):
            sys.exit(f"No such schema file: {args.schema}")
        apply_schema(args.account_id, args.database_id, token, args.schema, args.dry_run)
        if not args.db:
            return

    if not os.path.exists(args.db):
        sys.exit(f"No such database file: {args.db}")

    conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    where, params = "", []
    if args.since:
        where = " WHERE sold_date >= ?"
        params = [args.since]

    total = cur.execute(
        f"SELECT COUNT(*) FROM {args.table}{where}", params
    ).fetchone()[0]
    if total == 0:
        print("Nothing to import.")
        return

    print(f"{total:,} rows to upload"
          + (f" (sold_date >= {args.since})" if args.since else "")
          + f", {args.batch} per request")

    cur.execute(
        f"SELECT {', '.join(COLUMNS)} FROM {args.table}{where} ORDER BY sold_date",
        params,
    )

    placeholder = "(" + ",".join("?" * len(COLUMNS)) + ")"
    sent = 0
    started = time.time()

    for rows in batched(cur, args.batch):
        # One statement, many rows. INSERT OR REPLACE upserts on the item_id
        # primary key, so re-running is always safe.
        sql = (f"INSERT OR REPLACE INTO {args.table} ({', '.join(COLUMNS)}) "
               f"VALUES {', '.join([placeholder] * len(rows))}")
        flat = []
        for r in rows:
            flat.extend(r[c] for c in COLUMNS)

        if args.dry_run:
            sent += len(rows)
            continue

        # Transient failures are common on long uploads; retry before giving up
        # so a single blip doesn't cost the whole run.
        for attempt in range(4):
            try:
                d1_query(args.account_id, args.database_id, token, sql, flat)
                break
            except RuntimeError as err:
                if attempt == 3:
                    sys.exit(f"\nFailed after {sent:,} rows: {err}")
                wait = 2 ** attempt
                print(f"\n  retrying in {wait}s ({err})", file=sys.stderr)
                time.sleep(wait)

        sent += len(rows)
        pct = sent * 100 // total
        print(f"\r  {sent:,}/{total:,} ({pct}%)", end="", flush=True)

    elapsed = time.time() - started
    if args.dry_run:
        print(f"\nDry run: would have sent {sent:,} rows "
              f"in {(sent + args.batch - 1) // args.batch:,} requests.")
    else:
        print(f"\nDone. {sent:,} rows in {elapsed:.0f}s.")

    conn.close()


if __name__ == "__main__":
    main()
