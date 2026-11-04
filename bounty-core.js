// Bounty Board rules (owner, Nov 2026). A collector posts the card they want
// and what they will pay for it, shipping included; a collector who has it
// claims the bounty, shows it, gets paid when it arrives. The money side runs
// on Stripe Connect: the buyer pays the platform, which holds it and pays the
// seller when the card arrives (or refunds the buyer on a dispute it upholds).
//
// Pure functions, so the rules can be tested without a server.
'use strict';

const DAY = 86400000;
const MAX_DAYS = 30;                  // a bounty lasts at most 30 days, then is posted again
const FEE_BUYER = 0.04;               // 8% in all, split: 4% on top of the price for the buyer
const FEE_SELLER = 0.04;              // ...and 4% off the price for the seller
const MIN_PRICE = 5, MAX_PRICE = 25000;
const PAY_HOURS = 24;                 // a claim the buyer has not paid for in 24h reopens the bounty
const LOCK_HOURS = 48;                // and an accepted-but-unpaid claim holds the bounty at most 48h
const SHIP_DAYS = 5;                  // a paid card not shipped in 5 days is refunded
const RELEASE_DAYS = 10;              // paid to the seller 10 days after shipping, unless the buyer
                                      // confirms sooner or opens a dispute
const DISPUTE_DAYS = RELEASE_DAYS;    // a dispute can be opened until the money is released

const STATUSES = ['open', 'claimed', 'paid', 'shipped', 'complete', 'disputed', 'refunded', 'cancelled', 'expired'];
const GRADERS = ['PSA', 'BGS', 'SGC', 'CGC', 'TAG', 'HGA', 'CSG', 'BVG', 'ISA'];

const cents = (usd) => Math.round(Number(usd) * 100);
// What the buyer is charged and what the seller is paid, in cents.
function fees(price) {
  const p = cents(price);
  const buyerFee = Math.round(p * FEE_BUYER), sellerFee = Math.round(p * FEE_SELLER);
  return { price: p, buyerFee, sellerFee, buyerPays: p + buyerFee, sellerGets: p - sellerFee, platform: buyerFee + sellerFee };
}

// A new seller starts small and earns room with finished sales, which caps
// what a bad actor can take before the first dispute catches them.
function sellerCap(completedSales) {
  const n = Number(completedSales) || 0;
  if (n < 3) return 100;
  if (n < 10) return 500;
  if (n < 25) return 2500;
  return MAX_PRICE;
}

// "PSA 10", "BGS 9.5", "Raw" (or anything else) -> { graded, grader, grade, label }.
function readGrade(s) {
  const m = /\b(PSA|BGS|SGC|CGC|TAG|HGA|CSG|BVG|ISA)\s*(10|[1-9](?:\.5)?)\b/i.exec(String(s || ''));
  if (!m) return { graded: false, grader: null, grade: null, label: 'Raw' };
  return { graded: true, grader: m[1].toUpperCase(), grade: m[2], label: `${m[1].toUpperCase()} ${m[2]}` };
}

const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9#/]+/g, ' ').split(' ')
  .map(w => w.replace(/^#/, '')).filter(w => w.length >= 2 || /^\d$/.test(w));
const GRADE_WORDS = new Set(['psa', 'bgs', 'sgc', 'cgc', 'tag', 'hga', 'csg', 'bvg', 'isa', 'raw', 'gem', 'mint', 'mt']);
// Does a card a collector owns (its name as they typed it) match a bounty?
// Every word of the bounty's card, and the same grade: a raw bounty is not
// a slab, and a PSA 10 bounty is not a PSA 9.
function cardMatches(bounty, ownedName) {
  const want = words(bounty.card).filter(w => !GRADE_WORDS.has(w));
  if (!want.length) return false;
  const have = new Set(words(ownedName));
  if (!want.every(w => have.has(w))) return false;
  const g = readGrade(bounty.grade), og = readGrade(ownedName);
  if (!g.graded) return !og.graded;
  return og.graded && og.grader === g.grader && og.grade === g.grade;
}

function validatePost(b, { now = Date.now() } = {}) {
  const card = String(b.card || '').replace(/\s+/g, ' ').trim();
  if (card.length < 6 || card.length > 140) return { error: 'Name the card: year, set, player and parallel (6 to 140 characters).' };
  const price = Math.round(Number(b.price) * 100) / 100;
  if (!(price >= MIN_PRICE) || price > MAX_PRICE) return { error: `Offer between $${MIN_PRICE} and $${MAX_PRICE.toLocaleString('en-US')}, shipping included.` };
  const g = readGrade(b.grade);
  const days = Math.max(1, Math.min(MAX_DAYS, parseInt(b.days, 10) || MAX_DAYS));
  const note = String(b.note || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return { card, price, grade: g.label, note, expiresAt: new Date(now + days * DAY).toISOString() };
}

// A claim: what the seller shows before the buyer pays. Every claim carries
// photos of the very card (front and back). A slab also carries its cert
// number, which the buyer can look up with the grader.
function validateClaim(bounty, c) {
  const g = readGrade(bounty.grade);
  const photos = (Array.isArray(c.photos) ? c.photos : []).filter(u => typeof u === 'string' && /^\/bounty\/img\/[a-f0-9]{24}\.jpg$/.test(u)).slice(0, 6);
  if (photos.length < 2) return { error: 'Add photos of the front and the back of the card.' };
  const cert = String(c.cert || '').replace(/\D/g, '').slice(0, 14);
  if (g.graded && cert.length < 6) return { error: `Enter the ${g.grader} cert number from the slab's label.` };
  const note = String(c.note || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return { photos, cert: g.graded ? cert : '', note };
}

function certUrl(grader, cert) {
  const c = encodeURIComponent(cert);
  return { PSA: `https://www.psacard.com/cert/${c}`, BGS: `https://www.beckett.com/grading/card-lookup?item_type=BGS&item_id=${c}`,
    SGC: `https://gosgc.com/card-lookup?cert=${c}`, CGC: `https://www.cgccards.com/certlookup/${c}/`, TAG: `https://my.taggrading.com/card/${c}` }[grader] || null;
}

// What the clock does to a bounty: an unpaid claim reopens it, an unshipped
// paid card is refunded, a shipped card is paid out, an open bounty expires.
// Returns the action to take (the server performs it), or null.
function due(b, now = Date.now()) {
  const t = (iso) => Date.parse(iso || 0) || 0;
  if (b.status === 'open' && now >= t(b.expiresAt)) return 'expire';
  if (b.status === 'claimed' && b.claim) {
    if (b.claim.acceptedAt && now >= t(b.claim.acceptedAt) + PAY_HOURS * 3600e3) return 'reopen';
    if (!b.claim.acceptedAt && now >= t(b.claim.at) + LOCK_HOURS * 3600e3) return 'reopen';
  }
  if (b.status === 'paid' && b.claim && now >= t(b.claim.paidAt) + SHIP_DAYS * DAY) return 'refund';
  if (b.status === 'shipped' && b.claim && now >= t(b.claim.shippedAt) + RELEASE_DAYS * DAY) return 'release';
  return null;
}

// The view of a bounty for one person: the buyer sees the claim and its
// photos; the seller sees the shipping address once paid; anyone else sees
// the card, the offer and whether it is still open.
function viewFor(b, who, extra = {}) {
  const mine = who && b.user === who, seller = who && b.claim && b.claim.seller === who;
  const f = fees(b.price);
  const out = { id: b.id, card: b.card, grade: b.grade, price: b.price, note: b.note, status: b.status,
    createdAt: b.createdAt, expiresAt: b.expiresAt, mine: !!mine, seller: !!seller, buyerRating: extra.buyerRating || null,
    youGet: f.sellerGets / 100, market: b.market || null };
  if (mine) out.youPay = f.buyerPays / 100;
  if (b.claim && (mine || seller)) {
    const c = b.claim;
    out.claim = { seller: c.seller, at: c.at, photos: c.photos, cert: c.cert, certUrl: c.cert ? certUrl(readGrade(b.grade).grader, c.cert) : null,
      note: c.note, acceptedAt: c.acceptedAt || null, paidAt: c.paidAt || null, shippedAt: c.shippedAt || null,
      carrier: c.carrier || null, tracking: c.tracking || null, releasedAt: c.releasedAt || null,
      dispute: c.dispute || null, sellerRating: extra.sellerRating || null,
      rated: { byBuyer: !!c.buyerRated, bySeller: !!c.sellerRated } };
    if (seller && c.ship) out.claim.ship = c.ship;
  }
  return out;
}

module.exports = { DAY, MAX_DAYS, FEE_BUYER, FEE_SELLER, MIN_PRICE, MAX_PRICE, PAY_HOURS, LOCK_HOURS, SHIP_DAYS, RELEASE_DAYS, DISPUTE_DAYS,
  STATUSES, GRADERS, fees, sellerCap, readGrade, cardMatches, validatePost, validateClaim, certUrl, due, viewFor };
