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
// The most Business will ever suggest raising a card to: 3x its asking price
// (owner, Oct 2026). A median past that is far likelier a numbered or parallel
// version in the sales than a card listed at a third of its worth.
const MAX_X = 3;
const capRaise = (price, to) => (price > 0 && to > price * MAX_X ? round2(price * MAX_X) : to);
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
    // A two-week move past 3x either way is a mix of different versions in the
    // sales, not a market, so it is no trend at all (owner, Oct 2026).
    trend: recent.length >= 2 && older.length >= 2 && mr / mo <= MAX_X && mo / mr <= MAX_X
      ? Math.round(((mr - mo) / mo) * 1000) / 10 : null,
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
      const to = capRaise(r.price, r.market);
      actions.push({ kind: 'underpriced', id: r.id, title: r.title, dollars: (to - r.price) * r.qty,
        text: to < r.market
          ? `Listed at $${r.price}; sales run about $${r.market}, over 3x. Check they are the same version before going past $${to}.`
          : `Listed at $${r.price}; recent copies sold for about $${r.market}.`,
        why: `${r.n} sales, $${r.low}–$${r.high}`, suggest: to });
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
function mergeEbay(items, listings, now = Date.now(), pastEnded = [], soldIds = new Set()) {
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
  // A card that left and came back under the same title was relisted, not
  // sold (owner, Oct 2026): it keeps its cost, notes and listed date under
  // the new item number instead of waiting as "sold or ended?".
  const key = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const gone = new Map();
  // Also the cards still waiting from an earlier sync.
  // One found in eBay's sold data did sell, whatever came up after it.
  for (const it of ended.concat(pastEnded || [])) {
    if (!soldIds.has(String(it.ebayItemId)) && !gone.has(key(it.title))) gone.set(key(it.title), it);
  }
  const added = [], back = [];
  for (const l of byId.values()) {
    const was = gone.get(key(l.title));
    if (was) {
      gone.delete(key(l.title));
      const { endedAt, ...rest } = was;
      back.push({ ...rest, ebayItemId: String(l.ebayItemId), price: l.price != null ? l.price : was.price,
        imageUrl: l.imageUrl || was.imageUrl || null, itemUrl: l.itemUrl || was.itemUrl || null, relistedAt: new Date(now).toISOString() });
      continue;
    }
    const it = normalizeItem({ title: l.title, price: l.price, platform: 'eBay', listed: l.listedAt }, now);
    if (!it) continue;
    added.push({ ...it, ebayItemId: String(l.ebayItemId), imageUrl: l.imageUrl || null, itemUrl: l.itemUrl || null });
  }
  const relisted = new Set(back.map(b => b.id));
  return { items: kept.concat(back, added), ended: ended.filter(it => !relisted.has(it.id)),
    pastEnded: (pastEnded || []).filter(it => !relisted.has(it.id)), added: added.length, updated, relisted: back.length };
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
    let to = capRaise(it.price, v.market * (1 - cut));
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

// New eBay listings from cards read off photos (owner, Oct 2026): a file the
// seller uploads at Seller Hub > Reports > Uploads, eBay's bulk "Add" format.
// Category 261328 (Sports Trading Card Singles). A card in a slab is
// condition 2750 (Graded) with eBay's grader and grade codes; a raw card is
// 4000 (Ungraded) with a card condition, near mint unless the seller picks
// otherwise. The codes are eBay's own (condition descriptors 27501 grader,
// 27502 grade, 27503 cert number, 40001 card condition).
const EBAY_CARD_CATEGORY = 261328;
const EBAY_GRADERS = { PSA: 275010, BCCG: 275011, BVG: 275012, BGS: 275013, CSG: 275014, CGC: 275015, SGC: 275016,
  KSA: 275017, GMA: 275018, HGA: 275019, ISA: 2750110, PCA: 2750111, GSG: 2750112, PGS: 2750113, MNT: 2750114,
  TAG: 2750115 };
// 10 is 275020, 9.5 is 275021 ... 5 is 2750210 ... 1 is 2750218.
const EBAY_GRADE_STEPS = ['10', '9.5', '9', '8.5', '8', '7.5', '7', '6.5', '6', '5.5', '5', '4.5', '4', '3.5', '3', '2.5', '2', '1.5', '1'];
const ebayGradeId = (g) => { const i = EBAY_GRADE_STEPS.indexOf(String(Number(g))); return i < 0 ? null : Number('27502' + i); };
const EBAY_RAW_CONDITION = { 'near mint': 400010, excellent: 400011, 'very good': 400012, poor: 400013 };
// The maker a collector searches by, from the product name.
const MAKERS = [[/\bupper deck\b/i, 'Upper Deck'], [/\b(topps|bowman|finest|stadium club|heritage|allen & ginter|gypsy queen)\b/i, 'Topps'],
  [/\b(panini|prizm|donruss|optic|select|mosaic|contenders|national treasures|immaculate|flawless|score|phoenix|absolute|certified|spectra|obsidian|origins|chronicles|zenith|playoff|elite|revolution|hoops|impeccable)\b/i, 'Panini'],
  [/\bleaf\b/i, 'Leaf'], [/\bfleer\b/i, 'Fleer'], [/\bsage\b/i, 'Sage']];
const makerOf = (set) => { for (const [re, name] of MAKERS) if (re.test(String(set || ''))) return name; return ''; };
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
// A title of at most 80 characters (eBay's limit), cut at a word.
function ebayTitle(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  if (s.length <= 80) return s;
  const cut = s.slice(0, 81); const at = cut.lastIndexOf(' ');
  return (at > 40 ? cut.slice(0, at) : s.slice(0, 80)).trim();
}
const EBAY_ADD_COLUMNS = ['*Action(SiteID=US|Country=US|Currency=USD|Version=1193)', 'CustomLabel', '*Category', '*Title',
  '*ConditionID', 'CD:Professional Grader - (ID: 27501)', 'CD:Grade - (ID: 27502)', 'CDA:Certification Number - (ID: 27503)',
  'CD:Card Condition - (ID: 40001)', 'C:Sport', 'C:Player/Athlete', 'C:Season', 'C:Manufacturer', 'C:Set', 'C:Card Number',
  'C:Parallel/Variety', 'C:Features', 'C:Autographed', 'C:Graded', 'C:Print Run', 'PicURL', '*Description', '*Format',
  '*Duration', '*StartPrice', '*Quantity', 'PostalCode', 'ShippingProfileName', 'ReturnProfileName', 'PaymentProfileName'];
// cards: [{ title, price, grade ("PSA 10" or ""), player, year, set, cardNumber, parallel, printRun,
// auto, rookie, sport, cert, photoUrl, id }]. defaults: { zip, shipping, returns, payment, condition }.
// Returns { csv, listed, skipped: [{ title, why }] }.
function ebayAddCsv(cards, defaults = {}) {
  const rows = [EBAY_ADD_COLUMNS.join(',')], skipped = [];
  const rawCond = EBAY_RAW_CONDITION[String(defaults.condition || 'near mint').toLowerCase()] || 400010;
  for (const c of cards || []) {
    const title = ebayTitle(c.title);
    const price = Number(String(c.price == null ? '' : c.price).replace(/[$,]/g, ''));
    if (!title) { skipped.push({ title: '', why: 'no title' }); continue; }
    if (!(price > 0)) { skipped.push({ title, why: 'no price' }); continue; }
    const g = readGrade(c.grade || '');
    // A grade written but not read is a slab of some kind: never listed as raw.
    if (!g && c.grade && !/^\s*(raw|ungraded|none)?\s*$/i.test(c.grade)) { skipped.push({ title, why: `could not read the grade "${c.grade}"` }); continue; }
    let graderId = null, gradeId = null;
    if (g) {
      graderId = EBAY_GRADERS[String(g.grader).toUpperCase()] || null;
      gradeId = ebayGradeId(g.grade);
      if (!graderId || !gradeId) { skipped.push({ title, why: `eBay has no code for ${c.grade}` }); continue; }
    }
    const parallel = c.parallel && !/^base$/i.test(c.parallel) ? c.parallel : '';
    const features = [c.rookie ? 'Rookie' : '', c.printRun ? 'Serial Numbered' : '', parallel ? 'Parallel/Variety' : ''].filter(Boolean).join('|');
    const desc = `<p>${[c.year, c.set, c.player, parallel, c.cardNumber ? '#' + String(c.cardNumber).replace(/^#/, '') : ''].filter(Boolean).join(' ')}</p>`
      + `<p>${g ? `Graded ${c.grade}${c.cert ? `, cert ${c.cert}` : ''}.` : 'Ungraded.'} The photo is of the card you will receive.</p>`;
    const row = {
      '*Action(SiteID=US|Country=US|Currency=USD|Version=1193)': 'Add', CustomLabel: c.id || '', '*Category': EBAY_CARD_CATEGORY,
      '*Title': title, '*ConditionID': g ? 2750 : 4000,
      'CD:Professional Grader - (ID: 27501)': graderId || '', 'CD:Grade - (ID: 27502)': gradeId || '',
      'CDA:Certification Number - (ID: 27503)': g && c.cert ? c.cert : '', 'CD:Card Condition - (ID: 40001)': g ? '' : rawCond,
      'C:Sport': c.sport || '', 'C:Player/Athlete': c.player || '', 'C:Season': c.year || '', 'C:Manufacturer': makerOf(c.set),
      'C:Set': c.set || '', 'C:Card Number': c.cardNumber ? String(c.cardNumber).replace(/^#/, '') : '', 'C:Parallel/Variety': parallel,
      'C:Features': features, 'C:Autographed': c.auto ? 'Yes' : 'No', 'C:Graded': g ? 'Yes' : 'No', 'C:Print Run': c.printRun || '',
      PicURL: c.photoUrl || '', '*Description': desc, '*Format': 'FixedPrice', '*Duration': 'GTC', '*StartPrice': price.toFixed(2),
      '*Quantity': 1, PostalCode: defaults.zip || '', ShippingProfileName: defaults.shipping || '', ReturnProfileName: defaults.returns || '',
      PaymentProfileName: defaults.payment || '',
    };
    rows.push(EBAY_ADD_COLUMNS.map(k => csvCell(row[k])).join(','));
  }
  return { csv: rows.join('\n') + '\n', listed: rows.length - 1, skipped };
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
  const has = (r) => r.value && r.value.market != null;
  const agreedOf = (r) => (Number.isFinite(r.agreed) && r.agreed >= 0 ? round2(r.agreed) : null);
  const priced = rows.filter(has);
  const market = round2(priced.reduce((a, r) => a + r.value.market * (r.qty || 1), 0));
  // A price both sides agreed on for a card (owner, Oct 2026) is what is paid
  // for it, in place of the percentage, and it counts a card no sales could
  // price. `agreed` on a row is the whole line's price, not each.
  const cards = rows.filter(r => has(r) || agreedOf(r) != null).map(r => {
    const qty = r.qty || 1, m = has(r) ? r.value.market : null, agreed = agreedOf(r);
    const offer = m != null ? round2(m * p * qty) : null;
    return { title: r.title, grade: r.grade, qty, market: m, n: (r.value && r.value.n) || 0, offer, agreed,
      pay: agreed != null ? agreed : offer, line: r.line };
  }).sort((a, b) => (b.market ?? -1) - (a.market ?? -1));
  return {
    pct: Math.round(p * 100), market, offer: round2(market * p),
    pay: round2(cards.reduce((a, c) => a + (c.pay || 0), 0)), agreedCount: cards.filter(c => c.agreed != null).length,
    cards,
    unpriced: rows.filter(r => !has(r) && agreedOf(r) == null).map(r => ({ title: r.title, grade: r.grade, n: (r.value && r.value.n) || 0, line: r.line })),
  };
}

// One line of the buy-offer box: the card, and the price agreed for it when
// the line ends "= 45" or "= $45.50". "#309" and "PSA 10" are part of the
// card, so a bare number at the end is not read as a price.
function parseOfferLine(line) {
  const s = String(line || '').trim();
  const m = s.match(/\s*=\s*\$?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*$/);
  if (!m) return { title: s, agreed: null };
  return { title: s.slice(0, m.index).trim(), agreed: Number(m[1].replace(/,/g, '')) };
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

// What a lot cost, spread over its cards: by market value where every card
// has one (so a $150 card carries more of a $200 lot than a $2 one), else
// evenly. Per card, in cents, adding back to the total exactly.
function splitLotCost(items, total) {
  const list = (items || []).filter(Boolean);
  const cents = Math.round((Number(total) || 0) * 100);
  if (!list.length || cents <= 0) return [];
  const qty = (it) => Math.max(1, it.qty || 1);
  const byValue = list.every(it => it.value && it.value.market > 0);
  const weight = (it) => (byValue ? it.value.market : 1) * qty(it);
  const sum = list.reduce((a, it) => a + weight(it), 0);
  const raw = list.map(it => (cents * weight(it)) / sum);
  const floor = raw.map(Math.floor);
  let left = cents - floor.reduce((a, b) => a + b, 0);
  raw.map((r, i) => [r - floor[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { floor[i]++; left--; } });
  // Each card's own cost is per copy.
  return list.map((it, i) => ({ id: it.id, cost: Math.round(floor[i] / qty(it)) / 100, by: byValue ? 'value' : 'even' }));
}

// A price alert when a card's market moves 15% or more between two pricings,
// both on at least MIN_COMPS sales, so one odd sale never sets one off.
const ALERT_MOVE = 0.15;
function priceAlert(item, prev, next, now = Date.now()) {
  if (!prev || !next || !(prev.market > 0) || !(next.market > 0)) return null;
  if ((prev.n || 0) < MIN_COMPS || (next.n || 0) < MIN_COMPS) return null;
  const pct = (next.market - prev.market) / prev.market;
  if (Math.abs(pct) < ALERT_MOVE) return null;
  return { id: item.id, title: item.title, from: prev.market, to: next.market,
    pct: Math.round(pct * 100), price: item.price != null ? item.price : null, at: new Date(now).toISOString() };
}
function alertText(a) {
  const dir = a.pct > 0 ? 'up' : 'down';
  return `${a.title}: market ${dir} ${Math.abs(a.pct)}% to $${a.to.toFixed(2)} (was $${a.from.toFixed(2)})`;
}
module.exports = { ebayAddCsv, ebayTitle, EBAY_ADD_COLUMNS, priceAlert, alertText, ALERT_MOVE, splitLotCost, health, showList, buyOffer, parseOfferLine, repricePlan, ebayReviseCsv, feeFor, salesReport, mergeEbay, median, readGrade, normalizeItem, valueFromSales, analyze, aiContext, VALUE_DAYS, MIN_COMPS, MAX_X };
