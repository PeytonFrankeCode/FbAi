# Sales data: the worklist

What the site now does on its own, and what needs a person. Numbers are from the live
debug endpoints on 2026-09-26.

## Where the data stands

| | Now | Why it matters |
|---|---|---|
| Sales stored | 782,318 since 2026-07-19 (68 days), ~11,500/day, 2 days behind | History depth: 90-day views start working about 2026-10-26 |
| Parallel recorded | 50% of sales | Half of all sales don't say which parallel they are |
| Card number | missing on 21.7% | Those sales can't be tied to a card |
| Set name matches a checklist | 67% | A third of sales get no card matching, Rainbow Mode or estimates |
| Player matches a player page | 82% | The rest is truncated, stuffed or ambiguous names |
| Grade read | 99.4% | Fine |

Live reports: `/api/debug/collection-health`, `/api/debug/price-coverage`,
`/api/debug/index-health`, `/api/debug/identity-gap`, `/api/debug/alias-status`.

## Done automatically (this repo)

- **Collection alarm.** Every day at 07:xx UTC the cron checks for:
  - a stalled collector (newest sale more than 4 days old);
  - a missing day;
  - a settled day with under half its usual volume;
  - a column the parser stopped filling (15+ points down on its norm).

  It emails `ALERT_EMAIL` when the list of problems changes, including when they clear.
  The report is always at `/api/debug/collection-health`.
- **Player pages get sales they were missing.** Two kinds of names now reach their page:
  - names cut short, like "amonra st" (2,578 sales), when exactly one page could complete them;
  - stuffed player fields, like "Jerry Rice / Set Break / Vg-Vgex Gmcards".

  Two people sharing a name are never guessed between.
- **Checklists drafted from sales.** `scripts/draft-checklist.js` asks the site which player
  each card number's sales name, and writes a draft for you to check.

## For you

### 1. Set the alarm's address (2 minutes)
Cloudflare → Workers → the-card-huddle → Settings → Variables → add a secret
`ALERT_EMAIL` = your email. Email sending uses the existing Resend setup.

### 2. Checklists for the biggest unmatched products
These are by sales in the window, from `/api/debug/price-coverage`:

| Product (as sellers write it) | Sales | Notes |
|---|---|---|
| 2025 Topps Chrome Black | 8,083 | No checklist |
| 2026 Wild Card | 5,362 (+1,938 as 2025) | No checklist |
| 2025 Topps | 5,153 | Mostly 2026 Topps Flagship cards (Mendoza #301) sold as "2025". This is an alias decision, see 3 |
| 2026 Topps Resurgence | 3,875 | We have 2024 and 2025 Resurgence, not 2026 |
| 1986 Topps | 2,302 | Vintage base set |
| 1984 Topps | 2,239 | Vintage base set |
| 2026 Topps Chrome | 2,079 | No checklist |
| 1972 Topps | 1,898 | Vintage base set |
| 1989 Score | 1,892 | Vintage base set |

For each one:

```
ADMIN_KEY=<your ADMIN_PASSWORD> node scripts/draft-checklist.js --year 1986 --set "topps" --name "1986 Topps Football" --brand "Topps"
```

Then:
1. Open `checklist-drafts/<id>.json` and check `sets[0].cards` against the real checklist. Anything under `review.uncertain` needs a look.
2. Add the inserts and the parallel list. `review.parallelsSeen` lists the parallel names sales used, as hints.
3. Move the file to `public/data/checklists/`, add it to `index.json`, and run `npm run build:card-index`.
4. Run `node scripts/audit-parallels.js` and `npm test`.

### 3. Naming decisions only a person can make
- **Year mislabels.** Should "2025 Topps" count as 2026 Topps Flagship? It only should if nearly all of those sales really are. Add a row to `public/data/set-aliases.json` once you're sure.
- **Duplicate or shared player pages.** 30 names match two pages and are left unmatched, for example:
  - the same person with two pages: Joe Milton / Joe Milton III, Aaron Jones / Aaron Jones Sr., John Ross / John Ross III, DJ Chark / DJ Chark Jr., Travis Etienne / Travis Etienne Jr., Marvin Mims / Marvin Mims Jr.;
  - two different people: Marvin Harrison / Marvin Harrison Jr., Frank Gore / Frank Gore Jr.

  Merging a duplicate page lets its sales through. Two genuinely different people need the sale's card year to tell them apart, which is catalog work.

### 4. In the collector (NflCardDB), where the data is made
- **Player names cut at a period:** "Amon-Ra St. Brown" is stored as "Amonra St". Matching now works around it, but it should be fixed where it's made.
- **Junk in the player field:** it's stored as-is ("… / Set Break / Vg-Vgex Gmcards"). 13,010 of 59,544 distinct player values contain " / ". Strip it when storing.
- **Suffixes dropped:** "Marvin Harrison Jr." is stored as "marvin harrison", which merges him with his father.
- **Parallel blank on 50% of sales.** Identifying the parallel for cards that sell 2+ times would fix 71.5% of the blank sales, at about 3,700 identifications a day (photo match or AI read). Price it before building it.
- **Card number missing on 21.7%.** 28% of those name a subset in the title ("Stars in the Night", "Downtown!").

### 5. History you can't collect yet
- Anything before 2026-07-19, and real prices for accepted best offers (eBay hides them), only come from a data vendor (130point, SportsCardsPro/PriceCharting).
- The free alternative is time. That makes item 1 the most important thing on this list: a missed day can't be recollected after about 90 days.
