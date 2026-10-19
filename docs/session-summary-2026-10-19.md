# Session summary: October 15–19, 2026

What was built, fixed and decided in one long working session on The Card Huddle. PR numbers are in `peytonfrankecode/fbai`; all of them are merged unless they're marked open.

## Standing decisions

- **Free forever for collectors.** No paid tier, paywall or "Pro" plan, ever, for collector features. This is written into `CLAUDE.md` (#843).
- **Card Huddle for Business is the one paid product,** at $20 a month. It is for card shops and online sellers and centres on inventory plus AI analysis. Nothing collectors use is moved into it, locked or degraded to sell it.
- **The collector site earns from:** eBay Partner Network links, display ads (AdSense now; Raptive or Mediavine once traffic qualifies), sponsors, and the optional ad-free purchase.
- **Ad intents (AdSense):** if tested at all, only on static pages, with the app excluded.
- **AI provider for Business:** left to the last step. Anthropic is the likely pick, using the small model with caching for cost; a Workers AI provider and an owner compare view are already built.

## Collector site

- **Market Movers report** (#837):
  - Linked from the email, a home card and the Market tab.
  - Movers use per-end medians.
- **Card modal layout** (#838): chart beside the photo, sold and recommended price under it, BCW below, the list underneath.
- **Articles:**
  - Posting tool on /admin with photo upload to R2, preview and publish (#839). It replaced the Sales Vetting UI.
  - News tab in the app (#840).
  - Article pages use the player-page header and footer (#841).
  - The first article was reviewed, and `https://thecardhuddle.com/sitemap-news.xml` was submitted to Search Console.
- **Search Console pruning** (#842):
  - Subset set pages, basketball, baseball and mystery-rookie pages are noindexed and taken out of the sitemap.
  - College-suffixed and misspelled player URLs redirect to the right page.
- **Market Movers integrity** (#856):
  - Untagged baseball sales are kept out of football boards: titles naming baseball or MLB, Topps from before 1955, and Bowman products from 2010 on. That removed the 1953 Topps Paige and "2026 Bowman Chrome".
  - Movers need 5 sales at each end (it was 3) and exclude raw cards from before 1990, which sell on condition.
  - Issues filed before medians (the Oct 15 launch issue) have their risers and fallers withdrawn, with a note saying why.
- **Checklists** (#857, #858):
  - 20 Jaguars entries filed as "Josh Allen" are now Josh Hines-Allen.
  - 2026 sets carry the team on the card, not the player's current team (Kyler #4 Cardinals, DJ Moore #36 Bears, Waddle #125 and Tua #126 Dolphins, Sauce #161 Jets, and more). 2024–25 were deliberately left alone, because the same rule hit mid-season trades.
  - Player pages lead with the rookie year and list every year with its count. Set pages list every subset; 2026 Topps shows all 72.
  - Alternate spellings in checklists ("CJ Stroud", curly apostrophes) link to the player's page.
- **#859:**
  - Panini set names are consistent from year to year (for example "2020 Panini Absolute", "2021 Panini Select").
  - The Grading Advisor lets you pick PSA, SGC or CGC and set your own fee. The SGC ($15) and CGC ($18) defaults are estimates and need confirming.
  - Homepage asks (sports picker, install banner, survey, Monday email) wait until after the first search, one at a time.
  - "Guides & News" is renamed "News".
- **Market freshness** (#860): the hourly cron now rebuilds Market cache entries more than 6 hours old. Before this, the 7-day view sat on Oct 14 while sales through Oct 17 were already in the database.

## Card Huddle for Business (/business)

- v1 (#844).
- eBay sync by seller username (#845).
- Sales and profit (#846).
- Daily AI summary (#847).
- Seller accounts and Stripe checkout behind `BUSINESS_CHECKOUT=on` (#848).
- AI providers: Anthropic and Workers AI, plus the owner compare view (#849).
- Public landing page and waitlist (#850).
- Bulk reprice and an eBay revise CSV (#851).
- Show tools: buy-offer calculator, feature list, print sheet (#852).
- Health score (#853).
- Cost tracking (#854).
- **Price alerts** (#855):
  - An alert fires when a card's market moves 15% or more, with at least 3 sales on both sides.
  - Alerts show on Today with "Set price" and "Dismiss" buttons, and sellers get a phone push.
  - The daily re-price runs 12:00–15:00 UTC.

## Investigations and findings

- **Sales collection (NflCardDB, outside this repo):**
  - These days have no sales stored: Sep 16, 18, 19, 23, 28, Oct 3, 9, 10 and 13. Oct 8 and Oct 12 were thin.
  - eBay keeps about 90 days of sales, so these can be recollected until mid-December or later.
  - `ALERT_EMAIL` is not set, so stall alerts never reach anyone.
- **Slabs-only Market** (branch `market-slabs`, **not merged**):
  - Tested on a copy of real sales from Jul 19 to Oct 17.
  - Slabs-only read +22.5% over 90 days and +7% over 30 days. A card-by-card check of the same graded cards says +0.9% and −2.9%, so slabs-only overstates the move badly.
  - The current index read +1.7% and −0.5%.
  - Recommendation: keep slabs and raw cards from 1990 on, drop raw vintage, and run the same check before shipping.

## Open items

1. Decide the Market basket: build and test "slabs + raw from 1990 on", or close `market-slabs`.
2. Restart and backfill the sales collector, and set `ALERT_EMAIL` on the Worker.
3. 2008–2011 checklists are nearly empty. This needs real checklist source files (the Matt Ryan, Stafford, Cam Newton and Watt rookie years).
4. Hines-Allen sales titled just "Josh Allen Jaguars" can still land on the QB's price guide (the sales side isn't fixed).
5. Confirm the SGC and CGC default grading fees.
6. Business launch steps:
   - Choose the AI provider and set `ANTHROPIC_API_KEY` / `BIZ_AI_PROVIDER`.
   - Set `BUSINESS_CHECKOUT=on`.
   - Add the Stripe webhook events (subscription updated and deleted).
7. Earlier offers still open: player page titles with prices, and polishing the Harrison article.
