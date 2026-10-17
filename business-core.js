// Card Huddle for Business: the analysis behind a seller's daily brief
// (owner, Oct 2026). The one paid product, for card shops and online sellers;
// see CLAUDE.md. Pure functions, no database: server.js feeds in the
// inventory and the sold comps, and an AI answer is built on what this
// returns, so every number in it can be traced to sales.
'use strict';

const DAY = 86400000;
const round2 = (n) => Math.round(n * 100) / 100;
const num = (v) => {
  const t = String(v == null ? '' : v).replace(/[$,\s]/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
function median(xs) {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// "PSA 10", "BGS 9.5", "SGC 9" from a grade field or a title; null is raw.
const GRADE_RE = /\b(PSA|BGS|SGC|CGC|CSG|HGA|TAG)\s*(10|[1-9](?:\.5)?)\b/i;
function readGrade(s) {
  const m = GRADE_RE.exec(String(s || ''));
  return m ? { grader: m[1].toUpperCase(), grade: m[2] } : null;
}

// One inventory row from whatever a seller imports: our own fields, a CSV
// with loose headers, or an eBay active-listings export.
const FIELD = {
  title: ['title', 'card', 'name', 'item', 'item title', 'description'],
  grade: ['grade', 'condition', 'graded'],
  cost: ['cost', 'paid', 'cost basis', 'purchase price', 'buy price'],
  price: ['price', 'ask', 'asking', 'list price', 'current price', 'start price', 'buy it now price'],
  platform: ['platform', 'where', 'channel', 'marketplace'],
  qty: ['qty', 'quantity', 'quantity available', 'count'],
  listedAt: ['listed', 'date listed', 'start date', 'listed at', 'date added', 'added'],
};
function pick(row, names) {
  const keys = Object.keys(row || {});
  for (const n of names) {
    const k = keys.find(x => x.trim().toLowerCase() === n);
    if (k != null && String(row[k]).trim() !== '') return row[k];
  }
  return null;
}
function normalizeItem(row, now = Date.now()) {
  const title = String(pick(row, FIELD.title) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!title) return null;
  const gradeRaw = pick(row, FIELD.grade);
  const g = readGrade(gradeRaw) || readGrade(title);
  const listed = Date.parse(pick(row, FIELD.listedAt) || '');
  const qty = Math.max(1, Math.min(999, Math.round(num(pick(row, FIELD.qty)) || 1)));
  return {
    id: row.id && /^[a-z0-9]{6,24}$/.test(row.id) ? row.id : Math.random().toString(36).slice(2, 12),
    title,
    grade: g ? `${g.grader} ${g.grade}` : null,
    cost: num(pick(row, FIELD.cost)),
    price: num(pick(row, FIELD.price)),
    platform: String(pick(row, FIELD.platform) || '').trim().slice(0, 30) || null,
    qty,
    listedAt: Number.isFinite(listed) ? new Date(listed).toISOString() : new Date(now).toISOString(),
  };
}

// The market price of one item from its sold comps (newest first, each
// { price, soldDate, grade, grader }): same grade only, last 60 days, median.
// Too few sales is no price, never a guess.
const VALUE_DAYS = 60;
const MIN_COMPS = 3;
function valueFromSales(item, sales, now = Date.now()) {
  const want = readGrade(item.grade);
  const same = (sales || []).filter(s => {
    const p = Number(s.price);
    if (!(p > 0)) return false;
    const sg = s.grade != null ? { grader: String(s.grader || '').toUpperCase(), grade: String(s.grade) } : null;
    if (!want) return !sg && !/^graded$/i.test(String(s.condition || '').trim());
    return sg && sg.grader === want.grader && sg.grade === want.grade;
  }).map(s => ({ price: Number(s.price), t: Date.parse(s.soldDate) }))
    .filter(s => Number.isFinite(s.t) && now - s.t <= VALUE_DAYS * DAY)
    .sort((a, b) => b.t - a.t);
  if (same.length < MIN_COMPS) return { market: null, n: same.length, asOf: new Date(now).toISOString() };
  const recent = same.filter(s => now - s.t <= 14 * DAY).map(s => s.price);
  const older = same.filter(s => now - s.t > 14 * DAY).map(s => s.price);
  const mr = median(recent), mo = median(older);
  return {
    market: round2(median(same.map(s => s.price))),
    n: same.length,
    low: round2(Math.min(...same.map(s => s.price))),
    high: round2(Math.max(...same.map(s => s.price))),
    lastSold: new Date(same[0].t).toISOString().slice(0, 10),
    trend: recent.length >= 2 && older.length >= 2 ? Math.round(((mr - mo) / mo) * 1000) / 10 : null,
    asOf: new Date(now).toISOString(),
  };
}

// The brief: the totals, then what to do today, biggest dollars first.
const OVER = 1.2, UNDER = 0.85, STALE_DAYS = 21, DEAD_DAYS = 90, HOT_TREND = 10;
function analyze(items, now = Date.now()) {
  const rows = (items || []).map(it => {
    const v = it.value || {};
    const days = Math.max(0, Math.floor((now - Date.parse(it.listedAt || now)) / DAY));
    return { ...it, days, market: v.market != null ? v.market : null, n: v.n || 0, trend: v.trend != null ? v.trend : null };
  });
  const sum = (f) => round2(rows.reduce((a, r) => a + (f(r) || 0) * r.qty, 0));
  const priced = rows.filter(r => r.market != null);
  const kpis = {
    cards: rows.reduce((a, r) => a + r.qty, 0),
    listedValue: sum(r => r.price),
    marketValue: sum(r => r.market),
    costBasis: sum(r => r.cost),
    // Unrealized gain only where both a cost and a market price are known.
    unrealized: round2(priced.filter(r => r.cost != null).reduce((a, r) => a + (r.market - r.cost) * r.qty, 0)),
    pricedWithCost: priced.filter(r => r.cost != null).length,
    pricedShare: rows.length ? Math.round((priced.length / rows.length) * 100) : 0,
    deadStock: rows.filter(r => r.days >= DEAD_DAYS).reduce((a, r) => a + r.qty, 0),
    deadValue: sum(r => (r.days >= DEAD_DAYS ? (r.price || r.market) : 0)),
  };
  const actions = [];
  for (const r of priced) {
    if (r.price == null) {
      actions.push({ kind: 'unpriced', id: r.id, title: r.title, dollars: r.market * r.qty,
        text: `Has no price. It sells for about $${r.market}.`, why: `${r.n} sales, median $${r.market}`, suggest: r.market });
      continue;
    }
    if (r.price > r.market * OVER && r.days >= STALE_DAYS) {
      actions.push({ kind: 'reprice', id: r.id, title: r.title, dollars: (r.price - r.market) * r.qty,
        text: `Listed $${r.price} for ${r.days} days. It sells for about $${r.market}.`,
        why: `${r.n} sales, $${r.low}–$${r.high}, last ${r.lastSold || ''}`.trim(), suggest: r.market });
    } else if (r.price < r.market * UNDER && r.n >= MIN_COMPS) {
      actions.push({ kind: 'underpriced', id: r.id, title: r.title, dollars: (r.market - r.price) * r.qty,
        text: `Listed at $${r.price}; recent copies sold for about $${r.market}.`,
        why: `${r.n} sales, $${r.low}–$${r.high}`, suggest: r.market });
    }
    if (r.trend != null && r.trend >= HOT_TREND) {
      actions.push({ kind: 'hot', id: r.id, title: r.title, dollars: r.market * r.qty * (r.trend / 100),
        text: `Up ${r.trend}% in the last two weeks. A good time to feature it.`, why: `${r.n} sales in 60 days` });
    }
  }
  const dead = rows.filter(r => r.days >= DEAD_DAYS);
  if (dead.length) {
    actions.push({ kind: 'dead', id: null, title: `${kpis.deadStock} cards listed 90+ days`, dollars: kpis.deadValue * 0.25,
      text: `$${kpis.deadValue} tied up. Bundle the cheap ones into lots, or move them to auctions.`, why: `${dead.length} listings` });
  }
  actions.forEach(a => { a.dollars = round2(a.dollars); });
  actions.sort((a, b) => b.dollars - a.dollars);
  return { kpis, actions: actions.slice(0, 25), asOf: new Date(now).toISOString() };
}

// What the AI is given: the totals, the actions and a compact table of the
// inventory. Facts only; the model is told to answer from these.
function aiContext(items, brief, maxRows = 300, sales = null) {
  const lines = (items || []).slice(0, maxRows).map(it => {
    const v = it.value || {};
    return [it.title, it.grade || 'raw', it.qty, it.cost ?? '', it.price ?? '', v.market ?? '', v.n || 0, v.trend ?? '', it.platform || '',
      String(it.listedAt || '').slice(0, 10)].join(' | ');
  });
  return [
    `Totals: ${JSON.stringify(brief.kpis)}`,
    `Actions: ${JSON.stringify(brief.actions.map(a => ({ kind: a.kind, title: a.title, text: a.text, why: a.why })))}`,
    sales ? `Sales (profit after estimated fees): ${JSON.stringify({ last30: sales.last30, allTime: sales.allTime, byMonth: sales.byMonth.slice(0, 6), byPlayer: sales.byPlayer.slice(0, 10), bySet: sales.bySet.slice(0, 10), byPlatform: sales.byPlatform, best: sales.best, worst: sales.worst })}` : 'Sales: none recorded yet.',
    'Inventory (title | grade | qty | cost | asking | market median 60d | comps | 2-week trend % | platform | listed):',
    ...lines,
    (items || []).length > maxRows ? `(${items.length - maxRows} more rows not shown)` : '',
  ].join('\n');
}

// An eBay store sync: the seller's active listings (Browse API, public) folded
// into the inventory. A listing already held keeps its id, cost and comps and
// takes eBay's current price; a new one is added; an eBay card no longer
// listed has sold or ended, and is moved out to `ended` for the seller to
// confirm (sales tracking). Cards from other platforms are left alone.
function mergeEbay(items, listings, now = Date.now()) {
  const byId = new Map(listings.filter(l => l.ebayItemId).map(l => [String(l.ebayItemId), l]));
  const kept = [], ended = [];
  let updated = 0;
  for (const it of items || []) {
    if (!it.ebayItemId) { kept.push(it); continue; }
    const l = byId.get(String(it.ebayItemId));
    if (!l) { ended.push({ ...it, endedAt: new Date(now).toISOString() }); continue; }
    byId.delete(String(it.ebayItemId));
    const next = { ...it, title: l.title, price: l.price != null ? l.price : it.price,
      imageUrl: l.imageUrl || it.imageUrl, itemUrl: l.itemUrl || it.itemUrl };
    if (l.title !== it.title) {                // a retitled listing is priced again
      const g = readGrade(l.title);
      if (g) next.grade = `${g.grader} ${g.grade}`;
      delete next.value;
    }
    kept.push(next);
    updated++;
  }
  const added = [];
  for (const l of byId.values()) {
    const it = normalizeItem({ title: l.title, price: l.price, platform: 'eBay', listed: l.listedAt }, now);
    if (!it) continue;
    added.push({ ...it, ebayItemId: String(l.ebayItemId), imageUrl: l.imageUrl || null, itemUrl: l.itemUrl || null });
  }
  return { items: kept.concat(added), ended, added: added.length, updated };
}

// Selling fees, estimated: the platform's standard rate for trading cards
// (eBay final value fee 13.25% + $0.40; Whatnot 8% commission + 2.9% + $0.30
// processing). Shown as estimates; a seller's real fees vary by store level.
const FEES = { ebay: [0.1325, 0.40], whatnot: [0.109, 0.30] };
function feeFor(platform, amount) {
  const f = FEES[String(platform || '').toLowerCase()];
  return f && amount > 0 ? round2(amount * f[0] + f[1]) : 0;
}

// Profit from recorded sales: totals for the last 30 days and all time, and
// by month, player, set and platform. A sale with no cost counts toward
// revenue but not profit, and says so.
function salesReport(sold, now = Date.now()) {
  const rows = (sold || []).map(s => {
    const qty = s.qty || 1;
    const revenue = round2((Number(s.soldFor) || 0) * qty);
    const fees = s.fees != null ? Number(s.fees) : feeFor(s.platform, revenue);
    const cost = s.cost != null ? round2(Number(s.cost) * qty) : null;
    return { ...s, revenue, fees, costTotal: cost, profit: cost != null ? round2(revenue - fees - cost) : null,
      month: String(s.soldAt || '').slice(0, 7), t: Date.parse(s.soldAt) };
  });
  const tally = (list) => {
    const withCost = list.filter(r => r.profit != null);
    const revenue = round2(list.reduce((a, r) => a + r.revenue, 0));
    const profit = round2(withCost.reduce((a, r) => a + r.profit, 0));
    const costed = withCost.reduce((a, r) => a + r.revenue, 0);
    return { sales: list.length, revenue, fees: round2(list.reduce((a, r) => a + r.fees, 0)), profit,
      margin: costed ? Math.round((profit / costed) * 100) : null, missingCost: list.length - withCost.length };
  };
  const group = (key) => {
    const m = new Map();
    for (const r of rows) { const k = r[key] || 'Unknown'; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return [...m.entries()].map(([name, list]) => ({ name, ...tally(list) })).sort((a, b) => b.profit - a.profit || b.revenue - a.revenue);
  };
  const ranked = rows.filter(r => r.profit != null).sort((a, b) => b.profit - a.profit);
  const brief = (r) => ({ title: r.title, soldFor: r.soldFor, profit: r.profit, soldAt: String(r.soldAt).slice(0, 10) });
  return {
    last30: tally(rows.filter(r => now - r.t <= 30 * DAY)),
    allTime: tally(rows),
    byMonth: group('month').sort((a, b) => b.name.localeCompare(a.name)),
    byPlayer: group('player').slice(0, 15),
    bySet: group('set').slice(0, 15),
    byPlatform: group('platform'),
    best: ranked.slice(0, 5).map(brief),
    worst: ranked.slice(-5).reverse().filter(r => r.profit < 0).map(brief),
  };
}

// Bulk repricing: every card with a market price whose asking price is off
// by more than the analysis allows, moved to the market. Options:
//   mode     'over' (only lower), 'under' (only raise) or 'both'
//   undercut percent below market to list at (0-20), to sell faster
//   end99    end prices in .99 (on cards $5 and up)
//   floor    never below what the card cost
// Returns the plan; nothing changes until it is applied.
function repricePlan(items, { mode = 'both', undercut = 0, end99 = false, floor = true } = {}) {
  const cut = Math.max(0, Math.min(20, Number(undercut) || 0)) / 100;
  const out = [];
  for (const it of items || []) {
    const v = it.value || {};
    if (v.market == null || !(v.n >= MIN_COMPS)) continue;
    let to = v.market * (1 - cut);
    if (end99 && to >= 5) to = Math.max(0.99, Math.floor(to) - 0.01 + (to % 1 >= 0.5 ? 1 : 0));
    to = round2(to);
    if (floor && it.cost != null && to < it.cost) to = round2(it.cost);
    const from = it.price;
    const over = from != null && from > v.market * OVER;
    const under = from == null || from < v.market * UNDER;
    if (!((mode !== 'under' && over) || (mode !== 'over' && under))) continue;
    if (from != null && Math.abs(to - from) < 0.01) continue;
    out.push({ id: it.id, title: it.title, from, to, market: v.market, n: v.n, ebayItemId: it.ebayItemId || null,
      change: from != null ? round2(to - from) : null });
  }
  return out.sort((a, b) => Math.abs(b.change || b.to) - Math.abs(a.change || a.to));
}
// The plan as an eBay bulk-edit file (Seller Hub > Reports > Upload): one
// Revise row per eBay listing, setting its price.
function ebayReviseCsv(plan) {
  const rows = plan.filter(p => p.ebayItemId);
  return ['Action(SiteID=US|Country=US|Currency=USD|Version=1193),ItemID,StartPrice']
    .concat(rows.map(p => `Revise,${p.ebayItemId},${p.to.toFixed(2)}`)).join('\n') + '\n';
}

// A show list: the cards worth featuring tonight. Priced cards only, ranked
// by what they bring and whether they are heating up (a card up 20% counts
// as 20% more), most valuable first.
function showList(items, n = 20, minValue = 0) {
  return (items || []).filter(it => it.value && it.value.market != null && it.value.market >= minValue)
    .map(it => ({ id: it.id, title: it.title, grade: it.grade, price: it.price, market: it.value.market,
      trend: it.value.trend, score: it.value.market * (1 + Math.max(0, it.value.trend || 0) / 100) }))
    .sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(200, n)));
}

// A buy offer for a walk-in collection: each card's market value, the total,
// and the offer at `pct` of market. Cards with no price are listed apart and
// left out of the offer rather than guessed.
function buyOffer(rows, pct = 60) {
  const p = Math.max(10, Math.min(100, Number(pct) || 60)) / 100;
  const priced = rows.filter(r => r.value && r.value.market != null);
  const market = round2(priced.reduce((a, r) => a + r.value.market * (r.qty || 1), 0));
  return {
    pct: Math.round(p * 100), market, offer: round2(market * p),
    cards: priced.map(r => ({ title: r.title, grade: r.grade, qty: r.qty || 1, market: r.value.market, n: r.value.n,
      offer: round2(r.value.market * p * (r.qty || 1)) })).sort((a, b) => b.market - a.market),
    unpriced: rows.filter(r => !(r.value && r.value.market != null)).map(r => ({ title: r.title, grade: r.grade, n: (r.value && r.value.n) || 0 })),
  };
}

// Inventory health, 0 to 100, from four parts weighted by money (a $500 card
// counts for more than a $2 one): priced within range of the market (40),
// fresh, not sitting 90+ days (30), value known from comps (15) and cost
// recorded (15). Each part says what would raise it.
const HEALTH_PARTS = { priced: 40, fresh: 30, known: 15, costs: 15 };
function health(items, now = Date.now()) {
  const rows = (items || []).map(it => {
    const v = it.value || {};
    const w = Math.max(1, (v.market != null ? v.market : (it.price || 1)) * (it.qty || 1));
    const days = Math.max(0, (now - Date.parse(it.listedAt || now)) / DAY);
    const known = v.market != null;
    const inRange = known && it.price != null && it.price <= v.market * OVER && it.price >= v.market * UNDER;
    const fresh = days < 30 ? 1 : days >= DEAD_DAYS ? 0 : 1 - 0.5 * (days - 30) / (DEAD_DAYS - 30);
    return { w, known, inRange, fresh, hasCost: it.cost != null, off: known && !inRange, dead: days >= DEAD_DAYS };
  });
  if (!rows.length) return null;
  const total = rows.reduce((a, r) => a + r.w, 0);
  const share = (f) => rows.reduce((a, r) => a + r.w * f(r), 0) / total;
  const knownW = rows.filter(r => r.known).reduce((a, r) => a + r.w, 0);
  const parts = {
    // Priced right is judged on the cards whose market is known.
    priced: knownW ? rows.filter(r => r.known).reduce((a, r) => a + r.w * (r.inRange ? 1 : 0), 0) / knownW : 0,
    fresh: share(r => r.fresh),
    known: share(r => (r.known ? 1 : 0)),
    costs: share(r => (r.hasCost ? 1 : 0)),
  };
  const pts = Object.fromEntries(Object.entries(parts).map(([k, f]) => [k, Math.round(f * HEALTH_PARTS[k])]));
  const score = Object.values(pts).reduce((a, b) => a + b, 0);
  const nOff = rows.filter(r => r.off).length, nDead = rows.filter(r => r.dead).length;
  const nUnknown = rows.filter(r => !r.known).length, nNoCost = rows.filter(r => !r.hasCost).length;
  const cards = (n) => `${n} card${n === 1 ? '' : 's'}`;
  const tips = [
    nOff && { part: 'priced', text: `Reprice ${cards(nOff)} off the market (Inventory › Bulk reprice).` },
    nDead && { part: 'fresh', text: `Move ${cards(nDead)} listed 90+ days: lots, auctions or a show.` },
    nUnknown && { part: 'known', text: `${cards(nUnknown)} ${nUnknown === 1 ? 'has' : 'have'} no price yet. Make sure each title names the card fully: year, set, player, number.` },
    nNoCost && { part: 'costs', text: `Add what you paid for ${cards(nNoCost)} so profit is real.` },
  ].filter(Boolean).map(t => ({ ...t, gain: HEALTH_PARTS[t.part] - pts[t.part] })).filter(t => t.gain > 0)
    .sort((x, y) => y.gain - x.gain);
  const label = score >= 85 ? 'Excellent' : score >= 70 ? 'Good' : score >= 50 ? 'Needs work' : 'Poor';
  return { score, label, parts: pts, max: HEALTH_PARTS, tips };
}

module.exports = { health, showList, buyOffer, repricePlan, ebayReviseCsv, feeFor, salesReport, mergeEbay, median, readGrade, normalizeItem, valueFromSales, analyze, aiContext, VALUE_DAYS, MIN_COMPS };
