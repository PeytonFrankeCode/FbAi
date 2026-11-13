# The Card Huddle

## Founding principle: free for collectors, with one paid exception

The Card Huddle is free for every collector (owner, Oct 2026). Never propose,
build or bring back a paywall, a "Pro" plan, or lock an existing collector
feature behind payment. The Pro idea was tried and dropped as a mistake.

The one exception is **Huddle AI** (owner, Oct 2026), because every AI answer
costs real money. The optional plans: **Ad-free** ($1.99/month or
$16.99/year, no ads, no AI) and **Huddle+** (no ads plus Huddle AI) in three
sizes: Rookie $4.99, Veteran $9.99, Hall of Fame $19.99 a month, with $3, $7
and $13 of AI credits a month. Credits are metered from the real token cost of
each answer (Haiku for normal answers, Sonnet for Deep answers), so no
subscriber can cost more than their credits, and the plan picker shows what
each plan truly buys. Collectors only ever see AI tokens, never the dollar
credits: showing them would show the margin (owner, Oct 2026). The plan
cards promise "2.5 million+", "6.5 million+" and "12.5 million+ AI tokens each
month"; the real allowance is 3, 7 and 13 million (1 million per $1 of cost),
so the "+" always holds. Subscribers from before the plans keep their price with
Rookie's credits. Huddle+ members can also buy extra tokens (owner, Nov 2026):
any amount from $3 to $100 at $1.50 per million tokens, a one-off payment;
they never expire and are spent only after the month's plan tokens. Not sold
to anyone without a plan. Huddle AI is the only collector feature that needs a plan.
The one free way in is a 7-day free trial of Huddle+ (owner, Nov 2026): once
per account, card taken at checkout, and Rookie's tokens whatever the plan, so
a cancelled trial costs at most the cheapest plan's credits. Otherwise there
are no free AI questions. Nothing else moves behind it: searches,
prices, charts, checklists, alerts and every other collector tool stay free,
and a new feature is free unless the owner says otherwise.

The principle is for independent collectors, not businesses (owner, Oct
2026). The one paid offering is **Card Huddle for Business**: a separate
product for card shops, centred on inventory and AI analysis of it
(launch price $20/month). It is built for shop workflows, never by taking
something collectors have and locking it away. Nothing a collector uses on
the site is ever gated, moved into Business, or degraded to sell it.

The collector site earns from things that never stand between a collector
and a feature:

- eBay Partner Network links on listings and sales.
- Display ads (AdSense today; a premium network such as Raptive or
  Mediavine once traffic qualifies).
- Sponsors.
- The Bounty Board fee (owner, Nov 2026): collectors post a card they want
  and what they'll pay; browsing, posting and claiming are free, and on a
  finished deal the site takes 8%, 4% from the buyer and 4% from the seller.
  Payments run through Stripe Connect: the buyer's money is held until the
  card arrives (or 10 days after it ships), sellers are paid out by Stripe,
  disputes are decided by the owner in admin. Raw cards are allowed (photos
  of front and back before the buyer pays); slabs also need the cert number.
  New sellers are capped at $100 bounties, rising with finished sales.
  Taking payments needs `BOUNTY_PAYMENTS=on` and Connect enabled in Stripe.

The plans stay optional: apart from Huddle AI, everything works the same
without one.

Card Huddle for Business is paused (owner, Oct 2026): `BIZ_PAUSED` in
server.js. The owner keeps full use with the admin key; the code and API stay
for later.

## Working with the owner

- **End every reply that did work with a short summary at the bottom** of what
  was done: what changed, where (PR or branch), and anything the owner needs to
  do (owner, Oct 2026).
- Commit, push and open pull requests without asking first (owner, Oct 2026).
- The owner has no terminal, console or wrangler. Run every command yourself;
  give dashboard click-paths or browser URLs for anything only they can do.
