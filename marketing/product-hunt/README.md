# Product Hunt marketing photos

Five gallery images for The Card Huddle's Product Hunt launch. Each frames a
real screenshot of the live app inside a browser mockup, on a branded
background that matches the app's palette (mint `#5ece99` accent, dark navy).

| File | Feature | Headline |
| --- | --- | --- |
| `ph-1-hero.png` | Landing / search | Real eBay sold prices for every football card. |
| `ph-2-values.png` | Card value lookup | Know what any card is actually worth. |
| `ph-3-checklists.png` | Complete checklists | Every parallel. Every print run. One checklist. |
| `ph-4-rainbow.png` | Rainbow / collection | Track every parallel you own. |
| `ph-5-sell.png` | Seller tools | List smarter. Sell faster. |

## Specs

- **Size:** 2540 × 1520 px (2× the recommended 1270 × 760 Product Hunt gallery
  size, 5:3 aspect ratio). Downscale to 1270 × 760 if a smaller file is needed.
- **Format:** PNG.
- Suggested order in the gallery: hero first, then values → checklists →
  rainbow → sell.

## Regenerating

Screenshots were captured from the app running locally with mock data
(`USE_MOCK_DATA=true node server.js`) using Playwright, then composited with
the generator script. Re-run with real data (eBay + scrape.do keys) to capture
live card images instead of placeholders.
