// The beta survey: what a response may contain, and what the admin page shows.
//
// Pure, so the tests read it without KV. server.js owns the routes and the
// storage (one KV record per response, `survey:<time>:<id>`, so answers
// arriving at once from many isolates never overwrite each other).

const USES = ['price-my-cards', 'sold-before-buying', 'checklists', 'alerts', 'market-movers', 'card-shows', 'other'];
const USE_LABELS = {
  'price-my-cards': 'Pricing my cards',
  'sold-before-buying': 'Sold prices before I buy',
  checklists: 'Browsing checklists',
  alerts: 'Price alerts',
  'market-movers': 'Market movers',
  'card-shows': 'Pricing at card shows',
  other: 'Other',
};
const FOUND = ['yes', 'mostly', 'no'];
const TEXT_MAX = 1000;
const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]+\.[a-z]{2,}$/i;

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const int = (v) => (v === '' || v == null ? NaN : Number(v));

// { ok: true, response } or { ok: false, error }. Unknown fields are dropped;
// free text is trimmed and capped rather than refused, since a long answer is
// a good answer.
function validateSurvey(body) {
  const b = body || {};
  const rating = int(b.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { ok: false, error: 'Please pick a rating from 1 to 5.' };
  const nps = b.nps === '' || b.nps == null ? null : int(b.nps);
  if (nps != null && (!Number.isInteger(nps) || nps < 0 || nps > 10)) return { ok: false, error: 'The recommend score is 0 to 10.' };
  const found = FOUND.includes(b.found) ? b.found : null;
  const uses = [...new Set((Array.isArray(b.uses) ? b.uses : []).filter(u => USES.includes(u)))];
  const email = clip(b.email, 254).toLowerCase();
  if (email && !EMAIL_RE.test(email)) return { ok: false, error: 'That email address does not look right.' };
  return {
    ok: true,
    response: {
      rating, nps, found, uses,
      improve: clip(b.improve, TEXT_MAX),
      broken: clip(b.broken, TEXT_MAX),
      email,
      // Context, so an answer can be read against what the person did.
      page: clip(b.page, 120),
      searches: Math.max(0, Math.min(10000, Number.isFinite(int(b.searches)) ? Math.round(int(b.searches)) : 0)),
      device: /Mobi|Android|iPhone|iPad/i.test(String(b.userAgent || '')) ? 'mobile' : 'desktop',
    },
  };
}

// The admin view: counts, averages, NPS, and every response newest first.
function summarizeSurveys(responses) {
  const list = (responses || []).filter(Boolean).slice().sort((a, b) => (a.at < b.at ? 1 : -1));
  const n = list.length;
  const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, x) => a + x, 0) / xs.length) * 10) / 10 : null);
  const npsList = list.map(r => r.nps).filter(v => v != null);
  // Net Promoter Score: % of 9-10 minus % of 0-6.
  const nps = npsList.length
    ? Math.round((100 * (npsList.filter(v => v >= 9).length - npsList.filter(v => v <= 6).length)) / npsList.length)
    : null;
  const found = Object.fromEntries(FOUND.map(f => [f, list.filter(r => r.found === f).length]));
  const uses = USES.map(u => ({ id: u, label: USE_LABELS[u], count: list.filter(r => (r.uses || []).includes(u)).length }))
    .sort((a, b) => b.count - a.count);
  const ratings = [1, 2, 3, 4, 5].map(s => list.filter(r => r.rating === s).length);
  return {
    count: n,
    avgRating: avg(list.map(r => r.rating)),
    ratings,
    nps, npsResponses: npsList.length,
    found,
    uses,
    withEmail: list.filter(r => r.email).length,
    responses: list,
  };
}

module.exports = { validateSurvey, summarizeSurveys, USES, USE_LABELS, FOUND, TEXT_MAX };
