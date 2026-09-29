// An account's giveaway entry: whether they want in, and where to ship a prize.
//
// Pure, so the tests read it without KV. server.js stores one record per
// account (profile:user:<username>) and gates every read on the session, or
// on the admin key for the entrants list.

const COUNTRIES = { US: 'United States', CA: 'Canada' };
const US_STATES = new Set(('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR GU VI AS MP').split(' '));
const CA_PROVINCES = new Set('AB BC MB NB NL NS NT NU ON PE QC SK YT'.split(' '));

const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// { ok: true, shipping } or { ok: false, error, field }.
function validateShipping(body) {
  const b = body || {};
  const country = clip(b.country, 2).toUpperCase() || 'US';
  if (!COUNTRIES[country]) return { ok: false, error: 'Giveaways ship to the US and Canada for now.', field: 'country' };
  const s = {
    name: clip(b.name, 80),
    line1: clip(b.line1, 100),
    line2: clip(b.line2, 100),
    city: clip(b.city, 60),
    state: clip(b.state, 40).toUpperCase(),
    zip: clip(b.zip, 12).toUpperCase(),
    country,
    phone: clip(b.phone, 25),
  };
  if (s.name.length < 2) return { ok: false, error: 'Please add the name to ship to.', field: 'name' };
  if (s.line1.length < 3) return { ok: false, error: 'Please add a street address.', field: 'line1' };
  if (s.city.length < 2) return { ok: false, error: 'Please add a city.', field: 'city' };
  if (country === 'US') {
    if (!US_STATES.has(s.state)) return { ok: false, error: 'Please pick a state.', field: 'state' };
    if (!/^\d{5}(-\d{4})?$/.test(s.zip)) return { ok: false, error: 'A US ZIP code is 5 digits.', field: 'zip' };
  } else {
    if (!CA_PROVINCES.has(s.state)) return { ok: false, error: 'Please pick a province.', field: 'state' };
    if (!/^[A-Z]\d[A-Z] ?\d[A-Z]\d$/.test(s.zip)) return { ok: false, error: 'A postal code looks like K1A 0B1.', field: 'zip' };
  }
  if (s.phone && !/^[+()\d .-]{7,25}$/.test(s.phone)) return { ok: false, error: 'That phone number does not look right.', field: 'phone' };
  return { ok: true, shipping: s };
}

// One line, the way it goes on a label.
function formatAddress(s) {
  if (!s) return '';
  return [s.name, s.line1, s.line2, `${s.city}, ${s.state} ${s.zip}`, COUNTRIES[s.country] || s.country].filter(Boolean).join(', ');
}

module.exports = { validateShipping, formatAddress, COUNTRIES, US_STATES, CA_PROVINCES };
