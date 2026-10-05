# Sales vetting audit, October 2026

The read-only audit from [vetting-plan.md](vetting-plan.md). Nothing visible
changed and no sale was edited. The audit read every sale in D1 once, about
1.05M rows, into a local copy and ran there.

- **Data:** all 1,048,704 priced sales, 2026-07-19 to 2026-10-01. That is the
  whole table, so "the last 90 days" is everything.
- **Gap:** nothing was sold-dated after **Oct 1**. Ingestion has been quiet
  for 4 days, and Sep 28 has no sales at all.
- **Tools:** `vetting-core.js` decides where each sale belongs.
  `scripts/d1-export.py` makes the local copy. `scripts/vetting-audit.js`
  writes the report. `test/vetting.test.js` pins 40 real titles, both the
  moves and the look-alikes that must stay put.

## 1. What the re-sort would move

"High" moves are safe to apply automatically. "Low" ones go to purgatory for
a person.

| Destination | Confidence | Sales | % of sales | Per day | % of $ |
|---|---|---:|---:|---:|---:|
| stays where it is | | 901,292 | 85.9% | 16,095 | 88.3% |
| **unplaced**: no player/year, an import failure | low | 49,579 | 4.7% | 885 | 4.1% |
| → **auto** (title says auto, row says not) | high | 30,203 | 2.9% | 539 | 2.5% |
| → **parallel**: title and row disagree | low | 23,003 | 2.2% | 411 | 2.3% |
| → **lot** | high | 17,151 | 1.6% | 306 | 0.4% |
| → **parallel**: row says base, title names a parallel or print run | high | 9,152 | 0.9% | 163 | 0.5% |
| → **relic** | high | 8,865 | 0.8% | 158 | 0.6% |
| → **Authentic** (PSA/BGS/SGC Authentic, DNA, altered) | high | 2,331 | 0.2% | 42 | 0.7% |
| → **redemption** | high | 2,162 | 0.2% | 39 | 0.4% |
| → **you pick** | high | 1,830 | 0.2% | 33 | 0.0% |
| → **custom** | high / low | 1,363 / 888 | 0.2% | 40 | 0.1% |
| → **reprint** (always for a person) | low | 625 | 0.1% | 11 | 0.0% |
| → break, repack, not-auto (facsimile), year | high | 260 | 0.0% | 4 | 0.0% |

Some examples:

- **Authentic** is the plan's Griffey case, and it's common at the top end.
  A 2000 Contenders Rookie Ticket Brady sold for $19,012 as "PSA Authentic" and
  was filed as a graded copy. Two 2000 SPx Brady "PSA Authentic Auto 10" sales,
  at $10,999 and $4,527, look like PSA 10s.
- **Auto** misses are big-money cards: a $14,000 2017 Optic Mahomes Rated
  Rookie Auto /25, a $15,000 2021 National Treasures Lawrence RPA, and a
  $30,000 XR Mahomes swatch auto filed as patch-only. The biggest single
  cause is Topps' **"(AU, RC)"** checklist suffix, which the importer doesn't
  read.
- **Parallel**: the import reads a surname as a colour. Reggie White,
  Darrell Green, A.J. Green and Jaydon Blue were all filed as White, Green or
  Blue parallels, and a $12,050 PSA 10 Reggie White rookie is among them. The
  reverse also happens. `card_key` drops the parallel whenever the `parallel`
  column is empty, even when `card_name` has it. "2022 Chronicles Diamond James
  Cook /99" is keyed as the base card.
- **Year**: a card number misread as a year. "Topps Chrome #1975-25 2025" was
  filed as 1975. There are only 6 of these.

By sport, unplaced is 3.8% of football, 11.6% of basketball and 10.3% of
baseball. Auto misses are 3.1% of football and 1.2–1.8% of the others.

## 2. Purgatory per day

- **About 620 a day**: 438 low-confidence moves plus 179 price outliers (sales
  at more than 4× or under ¼ of their card-and-grade median, in groups of 5 or
  more). It rose to about 1,500–2,100 a day on Sep 29–Oct 1, when volume
  tripled to 59–76k sales a day.
- **Unplaced is reported separately**, at about 885 a day. It is not a doubtful
  sale. The importer found no player, and it spiked to 5–6k a day once
  basketball and baseball arrived on Sep 29, when 8–9% of those rows had no
  player. That's an importer fix, not a queue.
- **Most low-confidence parallel disagreements come from the reader**, not
  from the sale: "Neon Pulse Refractor" against "Refractor", or "Jumbo
  Downtown" against "Downtown". One rule from the owner clears each phrase
  everywhere. The existing parallel-alias machinery already supports this.

## 3. Huddle Verified coverage

Players are ranked by rookie sales. Each player's most-traded rookie cards
are counted (base and parallels alike, using `card_key`) in Raw, PSA 9 and
PSA 10, after the re-sort.

| Players | Cards each | Cards | Sales/day avg | Busiest day | % of all $ |
|---:|---:|---:|---:|---:|---:|
| 100 | 3 | 293 | 380 | 802 | 2.7% |
| 100 | 5 | 485 | 490 | 1,024 | 4.3% |
| 100 | 10 | 969 | 677 | 1,390 | 5.5% |
| 200 | 3 | 576 | 508 | 1,024 | 3.4% |
| 200 | 5 | 957 | 647 | 1,297 | 5.1% |
| 200 | 10 | 1,924 | 886 | 1,735 | 6.5% |

**Top 100 × 3 cards is about 380 sales a day to verify.** That's a feasible
daily queue, but it covers only 2.7% of dollars, because most money is in
autos, numbered parallels and veterans. The tier is a clean index, not a
cleaner for everything else, as with Card Ladder. The leaders are Dart,
C. Williams, Shough, Maye, Ward, Daniels, Nix, Jeanty, Skattebo and Mendoza.

## 4. Swings caused by mis-filed sales

151 card-and-grade weeks moved ±50% week over week as filed but under ±25%,
or not at all, once re-sorted. The largest:

- **2025 Topps Resurgence #149, Raw, +16,566%**: two $200 High Voltage SSP
  Jeanty sales on the base card.
- **2026 Topps #72, #311, #359 and #367, +1,900% to +4,300%**: Independence Day
  /76 and Canvas /50 parallels on base keys. This repeats across 2026 Flagship.
- **2023 Optic RPS Autographs #236, +5,076%**: Flex /149 and Stars Prizm
  non-auto Gibbs parallels filed under the auto's key.
- **2025 Donruss Downtown #17 and #19, and 2024 #21, +1,000% to +1,550%**:
  Jumbo Downtowns mixed with the standard-size card.
- **2005 Topps #6 and 2008 Topps DYN, +1,000%**: lots of 8–25 Brady cards.

Caveat: the swings are measured on raw `card_key` groups. The market index
already applies some of these title tests at query time (junk words,
base-only, raw-only), so the index itself moved less than this. Card pages
and sold boards that group by key show the swings.

## Recommendation for the next step

1. **Owner review of the examples.** There are 30 per category in the audit
   report, the 10 dearest plus 20 spread across the rest. Each "wrong" answer
   becomes a test case in `test/vetting.test.js`.
2. **Importer fixes**, NflCardDB side. These remove most of the volume at the
   source:
   - read "(AU" as an auto;
   - never take a parallel from a word of the player's name;
   - put the parallel and print run into `card_key` whenever `card_name` has
     them;
   - fix player extraction for basketball and baseball.
3. **Then the corrections table and the admin vetting page**, as planned:
   - auto-apply the high moves;
   - queue about 620 a day of purgatory, impact-ranked;
   - turn every decision into a phrase rule.

   Per-sale overrides already exist (`saleoverrides:v1` in KV, used by the
   sale desk). The corrections table should take those over rather than run
   beside them.
