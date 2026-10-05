# Sales vetting plan

Why: mis-filed and junk sales make the market numbers jumpy. An auto filed as a
plain card, a lot, a reprint, a wrong parallel or year. The goal is accuracy
close to Card Ladder's without throwing sales away.

## Decisions so far

- **Re-sort, never delete.** A bad sale is usually a good sale filed under the
  wrong card (a "PSA Authentic 10 Auto" Griffey is a real $990 sale of the auto,
  not of the plain PSA 10). Every sale ends up in one of three places:
  1. **Moved to the right card**: auto, parallel, year, insert, or a separate
     "Authentic" bucket for PSA Authentic.
  2. **Its own category**: lot, reprint, custom, "you pick". Searchable, but
     never counted in a single card's price.
  3. **Unsorted / purgatory**: can't be placed with confidence. Kept but not
     counted until someone sorts it.
- **Corrections live in their own table**, keyed by item_id. The `sales` row
  is never edited, so every fix can be reversed and a re-import can't wipe it
  (`scripts/d1-import.py` does `INSERT OR REPLACE` of whole rows). Every
  feature reads "sale + correction".
- **A price outlier is a hint to re-read the title**, not grounds to reject
  the sale. If the title confirms the card, the price counts.
- **Human vetting, Card Ladder style** (their help centre, Oct 2026):
  - Their research team verifies "thousands of sales a day", only for
    "Ladder" cards: each popular player's iconic base rookie in key grades,
    then the iconic parallel, then the rookie patch auto.
  - Every other sale goes in "Sales History", unverified.
  - Doubtful sales wait in a daily "purgatory" list.
  - Our version:
    - **Huddle Verified tier**: top players' key rookies and parallels in
      raw, PSA 9 and PSA 10. The owner reviews these, they get a ✓, and the
      market index uses only them.
    - Purgatory for outliers and anything that can't be placed.
    - Everything else re-sorted automatically and labelled unverified.
    - **Every human decision becomes a rule** that re-sorts all matching
      sales, past and future. This extends the existing alias machinery
      (`resolveParallelAliased`, `insertAliases`).
    - Later: user ✔/✏️ votes. Two trusted users agree = settled; the owner
      overrides.
- **Volume**: about 205,000 sales in 7 days, roughly 29,000 a day across the
  three sports. That's too many to vet all of them by hand, hence the tiers.

## The audit (nothing visible changes) — done Oct 5, 2026

Results: [vetting-audit-2026-10.md](vetting-audit-2026-10.md). The re-sort
reader is `vetting-core.js`; re-run with `scripts/d1-export.py` then
`scripts/vetting-audit.js`.

Read-only, over the last 90 days of D1 `sales`. Needs
`CLOUDFLARE_ACCOUNT_ID` and a **D1 read-only** `CLOUDFLARE_API_TOKEN` in
the Claude environment settings. The database id is in `wrangler.toml`
(`nflcarddb`). Report:

1. How many sales the re-sort would move, and where (base→auto,
   →parallel, →year, →lot/reprint, →Authentic), with 20–30 real examples
   from each category for the owner to check.
2. Purgatory size per day.
3. Daily sales volume a Huddle Verified tier would cover (top 100 / 200
   players' key rookies and parallels).
4. Which recent big market or card swings came from mis-filed sales.

Only after the owner has reviewed the audit: the corrections table, the
admin vetting page (an impact-ranked queue; one tap to confirm, re-file or
mark as lot; each decision saved as a rule), then wiring every market
feature to read corrected sales.
