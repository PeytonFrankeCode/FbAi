#!/usr/bin/env python3
"""Copy the D1 `sales` table to a local SQLite file, reading each row once.

For audits that read every sale several times over (scripts/vetting-audit.js).
D1 bills by rows read, so the analysis runs on a local copy instead of
against D1. Read-only: SELECTs only, and a D1 read-only token is enough.

Pages one day at a time by rowid, which the (sold_date) index serves directly,
so the whole copy costs about one row read per sale. Avoid MIN()/MAX() or
OFFSET paging here: either one makes D1 scan the table.

    export CLOUDFLARE_ACCOUNT_ID=...  CLOUDFLARE_API_TOKEN=...   # D1 read
    python3 scripts/d1-export.py --out /tmp/sales.sqlite --since 2026-07-19

Re-running resumes: days already copied are skipped, except the newest one,
which may still have been filling. Standard library only.
"""

import argparse
import datetime
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request

API_BASE = "https://api.cloudflare.com/client/v4"
DATABASE_ID = "a887dd0e-d852-4ebc-98f0-0e01bc82ad0b"   # nflcarddb, wrangler.toml
COLUMNS = ("item_id,sold_date,title,price_cents,shipping_cents,best_offer,listing_format,bids,"
           "player,team,year,brand,set_name,parallel,card_number,grader,grade,is_rookie,is_auto,"
           "is_relic,confidence,card_key,card_name,subset,print_run,sport").split(",")
PAGE = 8000


def query(account, token, database, sql, params):
    url = f"{API_BASE}/accounts/{account}/d1/database/{database}/query"
    body = json.dumps({"sql": sql, "params": params}).encode()
    for attempt in range(5):
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                payload = json.loads(resp.read().decode())
            if not payload.get("success"):
                raise RuntimeError(json.dumps(payload.get("errors"))[:300])
            res = payload["result"][0]
            return res["results"], res["meta"].get("rows_read", 0)
        except (urllib.error.URLError, RuntimeError, TimeoutError) as err:
            print(f"  retry {attempt + 1}: {err}", file=sys.stderr)
            time.sleep(2 ** attempt)
    raise SystemExit("D1 query kept failing")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="local SQLite file to write")
    ap.add_argument("--since", required=True, help="first sold_date to copy, YYYY-MM-DD")
    ap.add_argument("--until", default=datetime.date.today().isoformat(), help="last sold_date (default today)")
    ap.add_argument("--account-id", default=os.environ.get("CLOUDFLARE_ACCOUNT_ID"))
    ap.add_argument("--database-id", default=DATABASE_ID)
    args = ap.parse_args()
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not (token and args.account_id):
        raise SystemExit("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID")

    db = sqlite3.connect(args.out)
    db.execute(f"CREATE TABLE IF NOT EXISTS sales (rid INTEGER, {', '.join(COLUMNS)}, PRIMARY KEY (item_id))")
    db.execute("CREATE INDEX IF NOT EXISTS idx_sales_date ON sales (sold_date)")
    done = sorted(r[0] for r in db.execute("SELECT DISTINCT sold_date FROM sales"))
    skip = set(done[:-1])   # the newest day copied may have been partial

    day = datetime.date.fromisoformat(args.since)
    end = datetime.date.fromisoformat(args.until)
    read = 0
    while day <= end:
        iso = day.isoformat()
        day += datetime.timedelta(days=1)
        if iso in skip:
            continue
        last = 0
        while True:
            rows, rr = query(args.account_id, token, args.database_id,
                             f"SELECT rowid AS rid, {', '.join(COLUMNS)} FROM sales "
                             f"WHERE sold_date = ? AND rowid > ? ORDER BY rowid LIMIT {PAGE}", [iso, last])
            read += rr
            if not rows:
                break
            db.executemany(f"INSERT OR REPLACE INTO sales VALUES ({','.join('?' * (len(COLUMNS) + 1))})",
                           [[r["rid"]] + [r[c] for c in COLUMNS] for r in rows])
            last = rows[-1]["rid"]
            if len(rows) < PAGE:
                break
        db.commit()
        n = db.execute("SELECT COUNT(*) FROM sales WHERE sold_date = ?", [iso]).fetchone()[0]
        print(f"{iso}  {n:>7,} sales   D1 rows read so far {read:,}", flush=True)


if __name__ == "__main__":
    main()
