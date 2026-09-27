// Who is visiting: counted at the very front of the Worker, for EVERY request.
//
// The old tally lived in the Express layer, which two things kept blind:
//   1. Pages and assets are served by the ASSETS binding before Express runs,
//      so page views — where bot traffic lands — were never counted at all.
//   2. It kept its counts in each isolate's memory and was flushed only by the
//      cron, which runs in an isolate that serves no visitors: every flush
//      wrote ~0, and the report read "1 request today".
//
// Here each isolate keeps a running tally for the day and writes it to its OWN
// KV key at most once a minute (no shared key, so isolates never overwrite each
// other); the report sums the keys. Pure apart from the tally object, so the
// tests drive it directly.
//
// What is recorded is what tells a bot from a person: the network it came from
// (ASN and its owner — people arrive from home and mobile ISPs, most bots from
// cloud datacentres), the country, whether it says it is a bot, and whether
// Cloudflare knows it as a verified crawler (Googlebot, Bingbot...).

// Cloud and hosting networks. A visitor from one of these is almost always a
// program: people browse from ISPs, not from AWS. Search-engine crawlers also
// live here (Google 15169, Microsoft 8075), which is why a verified bot is
// never counted as a datacentre visitor.
const DATACENTER_ASNS = new Map([
  [16509, 'Amazon AWS'], [14618, 'Amazon AWS'], [8987, 'Amazon AWS'],
  [15169, 'Google'], [396982, 'Google Cloud'], [19527, 'Google'],
  [8075, 'Microsoft Azure'], [8068, 'Microsoft'],
  [14061, 'DigitalOcean'], [16276, 'OVH'], [24940, 'Hetzner'], [213230, 'Hetzner'],
  [63949, 'Akamai/Linode'], [20473, 'Vultr'], [51167, 'Contabo'], [12876, 'Scaleway'],
  [60781, 'Leaseweb'], [28753, 'Leaseweb'], [9009, 'M247'], [31898, 'Oracle Cloud'],
  [45102, 'Alibaba Cloud'], [37963, 'Alibaba Cloud'], [132203, 'Tencent Cloud'], [45090, 'Tencent Cloud'],
  [136907, 'Huawei Cloud'], [55990, 'Huawei Cloud'], [138915, 'Kaopu Cloud'], [135377, 'UCloud'],
  [36352, 'ColoCrossing'], [53667, 'FranTech/BuyVM'], [46844, 'Sharktech'], [62567, 'DigitalOcean'],
  [396356, 'Latitude.sh'], [212238, 'Datacamp/CDN77'], [60068, 'Datacamp/CDN77'], [40021, 'Contabo US'],
  [174, 'Cogent'], [3223, 'Voxility'], [49981, 'WorldStream'], [202425, 'IP Volume'],
]);

const BOT_UA = /bot|crawl|spider|slurp|bingpreview|headless|phantom|puppeteer|playwright|selenium|curl|wget|python-requests|python-urllib|aiohttp|httpclient|scrapy|axios|go-http|java\/|okhttp|libwww|node-fetch|undici|feedfetcher|facebookexternalhit|embedly|semrush|ahrefs|mj12|dotbot|petalbot|dataforseo|bytespider|gptbot|claudebot|ccbot|perplexity|amazonbot|applebot|yandex|baiduspider|sogou/i;

const LIMIT = 80;          // keys kept per breakdown, so a botnet cannot grow memory
// At most one KV write per isolate a minute (on the first request, then when a
// minute has passed): tail loss per isolate is under a minute, and the write
// volume stays well inside Workers Paid's KV allowance.
const FLUSH_MS = 60000;

function newTally(day) {
  return { day, total: 0, pages: 0, api: 0, assets: 0,
           verifiedBot: 0, declaredBot: 0, datacenter: 0, human: 0, noUa: 0,
           byAsn: {}, byCountry: {}, byUa: {}, byPath: {}, byKindCountry: {} };
}

// What kind of visitor this is, in order of how sure we are.
function classify({ ua = '', asn = null, verifiedBot = false }) {
  if (verifiedBot) return 'verifiedBot';
  if (!ua) return 'noUa';
  if (BOT_UA.test(ua)) return 'declaredBot';
  if (asn != null && DATACENTER_ASNS.has(Number(asn))) return 'datacenter';
  return 'human';
}

function pathKind(p) {
  if (p.startsWith('/api/')) return 'api';
  if (/\.[a-z0-9]{2,5}$/i.test(p) && !/\.html$/i.test(p)) return 'assets';
  return 'pages';
}

const bump = (obj, k, n = 1) => {
  if (obj[k] !== undefined || Object.keys(obj).length < LIMIT) obj[k] = (obj[k] || 0) + n;
};

// info: { day, path, ua, asn, asOrg, country, verifiedBot }
function noteRequest(t, info) {
  if (t.day !== info.day) Object.assign(t, newTally(info.day));
  const kind = classify(info);
  const pk = pathKind(info.path || '/');
  t.total++;
  t[pk]++;
  t[kind]++;
  // Pages are what bots inflate and what ads are paid on, so the breakdowns
  // are of page views; the totals above still count everything.
  if (pk !== 'pages') return kind;
  const asnKey = info.asn != null ? `${info.asn} ${String(info.asOrg || DATACENTER_ASNS.get(Number(info.asn)) || '').slice(0, 40)}`.trim() : '(unknown)';
  bump(t.byAsn, asnKey);
  bump(t.byCountry, info.country || '??');
  bump(t.byUa, info.ua ? info.ua.slice(0, 70) : '(none)');
  bump(t.byPath, String(info.path || '/').slice(0, 80));
  bump(t.byKindCountry, `${kind} ${info.country || '??'}`);
  return kind;
}

// Sum the isolates' tallies for a day into one report.
function mergeTallies(tallies) {
  const out = newTally(tallies[0] ? tallies[0].day : '');
  for (const t of tallies) {
    for (const k of ['total', 'pages', 'api', 'assets', 'verifiedBot', 'declaredBot', 'datacenter', 'human', 'noUa']) out[k] += t[k] || 0;
    for (const b of ['byAsn', 'byCountry', 'byUa', 'byPath', 'byKindCountry']) {
      for (const [k, n] of Object.entries(t[b] || {})) out[b][k] = (out[b][k] || 0) + n;
    }
  }
  const top = (o, n = 25) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, hits]) => ({ name, hits }));
  return {
    day: out.day, isolates: tallies.length,
    requests: out.total, pages: out.pages, api: out.api, assets: out.assets,
    visitors: { human: out.human, datacenter: out.datacenter, declaredBot: out.declaredBot, noUa: out.noUa, verifiedBot: out.verifiedBot },
    botShare: out.total ? Math.round((1 - out.human / out.total) * 1000) / 10 : null,
    topNetworks: top(out.byAsn), topCountries: top(out.byCountry), topUserAgents: top(out.byUa),
    topPaths: top(out.byPath), byKindAndCountry: top(out.byKindCountry, 40),
  };
}

module.exports = { DATACENTER_ASNS, BOT_UA, FLUSH_MS, newTally, classify, noteRequest, mergeTallies, pathKind };
