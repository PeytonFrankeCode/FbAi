// Every eBay link has to carry the affiliate tag.
//
// This is the quietest failure on the site. An untagged link works perfectly:
// the user clicks, eBay loads, the card is there, nothing looks wrong. The
// only symptom is that the EPN dashboard reports fewer clicks than the site
// actually sent, and there is no way to notice that except by going looking.
//
// Three of them shipped that way. app.js wraps outbound links in epnUrl() in
// fifteen places and, in three others, interpolated the raw itemUrl straight
// into an href — the estimate comps, the grading comps, and the card-alert
// rows. Every click through those earned nothing.
//
// The footer of all 2,173 landing pages tells readers we earn commission on
// these links, which makes an untagged one a claim the site does not keep.
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

// ---- the tag itself ----
{
  const m = app.match(/const EPN_PARAMS = '([^']+)'/);
  check('the EPN parameters are present', !!m);
  if (m) {
    const params = new URLSearchParams(m[1]);
    // campid is the only one that decides who gets paid. The rest describe the
    // placement; without campid eBay records the click against nobody.
    check('  ...including a campaign id', /^\d{6,}$/.test(params.get('campid') || ''),
      `campid=${params.get('campid')}`);
    // mkevt=1 is what marks the request as a tracked click. eBay drops the
    // attribution without it even when campid is present.
    check('  ...and mkevt=1, without which the click is not recorded',
      params.get('mkevt') === '1');
  }
}

// ---- every outbound link ----
//
// The check is deliberately structural rather than a list of known-good line
// numbers: a new render function with a raw href is exactly how the last three
// got in, and a hard-coded list would not have caught them.
{
  // Any href interpolating something that looks like a listing URL.
  const hrefs = [...app.matchAll(/href="\$\{([^}]*(?:itemUrl|ebayUrl|listingUrl|itemWebUrl)[^}]*)\}"/g)]
    .map(m => ({ expr: m[1], at: app.slice(0, m.index).split('\n').length }));

  check('outbound listing links were found to check',
    hrefs.length > 0, `${hrefs.length} href interpolations`);

  const untagged = hrefs.filter(h => !/epnUrl\s*\(/.test(h.expr));
  check('every listing link goes through epnUrl()',
    untagged.length === 0,
    untagged.length
      ? untagged.map(h => `app.js:${h.at} → ${h.expr}`).join('  |  ')
      : `all ${hrefs.length} tagged`);
}

// ---- the guard inside epnUrl ----
//
// It must not staple eBay parameters onto a link that is not eBay's, and must
// not turn an empty url into a broken one.
{
  const start = app.indexOf('function epnUrl(');
  const body = start === -1 ? '' : app.slice(start, start + 400);
  check('epnUrl only tags eBay URLs',
    /includes\('ebay\.com'\)/.test(body),
    'otherwise it appends eBay tracking to unrelated hosts');
  check('  ...and appends with & when the url already has a query',
    /includes\('\?'\)\s*\?\s*'&'\s*:\s*'\?'/.test(body),
    'a second ? silently breaks the whole query string');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall affiliate-link checks passed');
process.exit(failures ? 1 : 0);
