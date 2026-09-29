// The weekly Market Movers email: what moved in football cards this week,
// each item a link back into the site.
//
// Pure: the boards in (the /api/sold-stats payloads the home page shows), the
// email out. server.js owns the subscribers, the sending and the schedule;
// this owns what is said, so the tests can read it without KV or Resend.
//
// Who gets it: people who asked. Signing up sends a confirmation link, and
// only a confirmed address is mailed, so nobody can sign someone else up;
// every email carries a one-click unsubscribe (a link and the
// List-Unsubscribe header Gmail and Yahoo require of bulk senders).

const SITE = 'https://thecardhuddle.com';
const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]+\.[a-z]{2,}$/i;

// eBay Partner Network tracking, the same parameters as epnUrl() in app.js:
// a click from an email that becomes a sale earns the commission.
const EPN_PARAMS = 'mkcid=1&mkrid=711-53200-19255-0&siteid=0&campid=5339145753&toolid=10001&mkevt=1';
const epnUrl = (url) => (!url || !String(url).includes('ebay.com')) ? (url || '') : url + (String(url).includes('?') ? '&' : '?') + EPN_PARAMS;

const normEmail = (s) => String(s || '').trim().toLowerCase();
const validEmail = (s) => { const e = normEmail(s); return e.length <= 254 && EMAIL_RE.test(e); };

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ISO week id, "2026-W40": one send per week, keyed on this.
function weekId(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y = d.getUTCFullYear();
  const wk = Math.ceil(((d - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(wk).padStart(2, '0')}`;
}

// Mondays from 14:00 UTC (10am Eastern), after the 05:00 board rebuild. The
// send runs over the ticks that follow until everyone has it.
const SEND_DAY = 1, SEND_FROM_HOUR = 14;
const inSendWindow = (date) => date.getUTCDay() === SEND_DAY && date.getUTCHours() >= SEND_FROM_HOUR;

const link = (q, campaign, site = SITE) =>
  `${site}/?q=${encodeURIComponent(q)}&utm_source=digest&utm_medium=email&utm_campaign=${encodeURIComponent(campaign)}`;
const money = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 10000) return `$${Math.round(v / 1000)}K`;
  return `$${Math.round(v).toLocaleString('en-US')}`;
};
const pct = (n) => `${n > 0 ? '+' : ''}${Math.round(n)}%`;

// The week's content from the 7-day boards, with the 30-day player movers
// (a player's basket needs more than a week of repeat sales to read).
// null when there is not enough to be worth an email.
function digestContent(week7, month30) {
  if (!week7 || !week7.available) return null;
  const cards = (week7.cardMovers || []).filter(r => r && r.query && Number.isFinite(r.changePct));
  const risers = cards.filter(r => r.changePct > 0).sort((a, b) => b.changePct - a.changePct).slice(0, 5);
  const fallers = cards.filter(r => r.changePct < 0).sort((a, b) => a.changePct - b.changePct).slice(0, 3);
  const players = ((month30 && month30.available && month30.playerMovers) || [])
    .filter(r => r && r.query && Number.isFinite(r.changePct) && r.changePct > 0)
    .sort((a, b) => b.changePct - a.changePct).slice(0, 5);
  const mostSold = (week7.mostSold || []).filter(r => r && r.query).slice(0, 3);
  const priciest = (week7.priciest || []).filter(r => r && r.title).slice(0, 3);
  const sets = (week7.topSets || []).filter(r => r && r.query).slice(0, 3);
  if (risers.length + players.length + mostSold.length < 3) return null;
  return {
    sales: week7.pricedSales || 0, value: week7.totalValue || 0, avg: week7.avgPrice || 0,
    risers, fallers, players, mostSold, priciest, sets,
  };
}

function subjectFor(c) {
  const top = c.risers[0] || null;
  const p = c.players[0] || null;
  if (top) return `${top.player || top.name} ${pct(top.changePct)} this week: your football card market movers`;
  if (p) return `${p.player} ${pct(p.changePct)}: your football card market movers`;
  return 'This week in football cards: your market movers';
}

// The beta survey rides along in the emails sent before this date, then drops
// out on its own: a few weeks of asking the most engaged readers, not forever.
const SURVEY_ASK_UNTIL = Date.parse('2026-10-21T00:00:00Z');

// { subject, html, text } for one subscriber (the unsubscribe link is theirs).
function renderDigest(c, { week, unsubUrl, site = SITE, now = Date.now() }) {
  const surveyUrl = `${site}/?survey=email&utm_source=digest&utm_medium=email&utm_campaign=beta-survey`;
  const askSurvey = now < SURVEY_ASK_UNTIL;
  const L = (q) => link(q, week, site);
  const section = (title, sub, rows) => rows.length ? `
    <tr><td style="padding:22px 0 6px;">
      <div style="font-size:17px;font-weight:800;color:#111;">${esc(title)}</div>
      <div style="font-size:12px;color:#777;margin-top:2px;">${esc(sub)}</div>
    </td></tr>${rows.join('')}` : '';
  const row = (href, img, name, detail, right, rightColor) => `
    <tr><td style="padding:6px 0;border-bottom:1px solid #f0f0f0;">
      <a href="${esc(href)}" style="text-decoration:none;color:#111;display:block;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
          ${img ? `<td width="52" style="padding-right:10px;"><img src="${esc(img)}" width="44" height="60" alt="" style="display:block;border-radius:4px;object-fit:cover;"></td>` : ''}
          <td style="font-size:14px;line-height:1.35;"><div style="font-weight:700;">${esc(name)}</div>
            <div style="font-size:12px;color:#777;">${esc(detail)}</div></td>
          <td align="right" style="font-size:15px;font-weight:800;color:${rightColor || '#111'};white-space:nowrap;padding-left:8px;">${esc(right)}</td>
        </tr></table>
      </a></td></tr>`;
  const up = '#1b873f', down = '#c62828';

  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f5f7;"><tr><td align="center" style="padding:20px 12px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border-radius:12px;padding:24px;font-family:Inter,Arial,sans-serif;color:#111;">
  <tr><td>
    <div style="font-size:12px;letter-spacing:.08em;font-weight:800;color:#2d6a4f;">THE CARD HUDDLE · MARKET MOVERS</div>
    <div style="font-size:24px;font-weight:800;margin:8px 0 4px;">This week in football cards</div>
    <div style="font-size:14px;color:#555;">${esc(c.sales.toLocaleString('en-US'))} sales tracked · ${esc(money(c.value))} changed hands · ${esc(money(c.avg))} average sale</div>
  </td></tr>
  ${section('Biggest risers', 'Base cards, raw, this week against last', c.risers.map(r =>
    row(L(r.query), r.imageUrl, r.name || r.player, `${r.sales} sales`, pct(r.changePct), up)))}
  ${section('Players on the move', 'Repeat sales of the same cards, last 30 days', c.players.map(r =>
    row(L(r.query), null, r.player, `${r.resales || 0} repeat sales`, pct(r.changePct), up)))}
  ${section('Cooling off', 'Worth a look if you are buying', c.fallers.map(r =>
    row(L(r.query), r.imageUrl, r.name || r.player, `${r.sales} sales`, pct(r.changePct), down)))}
  ${section('Most sold', 'The cards everyone traded this week', c.mostSold.map(r =>
    row(L(r.query), r.imageUrl, r.name, `${r.sales} sales · avg ${money(r.avgPrice)}`, money(r.topPrice) + ' top')))}
  ${section('Biggest sales', 'The week’s priciest cards', c.priciest.map(r =>
    row(r.itemUrl ? epnUrl(r.itemUrl) : site, r.imageUrl, r.title, r.grade && r.grade !== 'Raw' ? r.grade : 'Sold on eBay', money(r.price))))}
  ${section('Hottest sets', 'By sales this week', c.sets.map(r =>
    row(L(r.query), null, r.name, `${(r.sales || 0).toLocaleString('en-US')} sales · avg ${money(r.avgPrice)}`, money(r.totalValue))))}
  ${askSurvey ? `<tr><td style="padding:22px 0 0;">
    <div style="background:#eef6f1;border:1px solid #cfe6d8;border-radius:10px;padding:14px 16px;">
      <div style="font-size:15px;font-weight:800;color:#2d6a4f;">Help shape The Card Huddle</div>
      <div style="font-size:13px;color:#444;margin:4px 0 10px;line-height:1.45;">We're in beta. Tell us what works, what's broken and what to build next. It takes 2 minutes.</div>
      <a href="${esc(surveyUrl)}" style="display:inline-block;background:#fff;color:#2d6a4f;border:1px solid #2d6a4f;text-decoration:none;font-weight:800;font-size:13px;padding:8px 16px;border-radius:8px;">Take the survey</a>
    </div>
  </td></tr>` : ''}
  <tr><td align="center" style="padding:26px 0 6px;">
    <a href="${esc(`${site}/?utm_source=digest&utm_medium=email&utm_campaign=${encodeURIComponent(week)}`)}" style="display:inline-block;background:#2d6a4f;color:#fff;text-decoration:none;font-weight:800;padding:12px 24px;border-radius:8px;">See the full market</a>
  </td></tr>
  <tr><td style="font-size:11px;color:#999;padding-top:18px;border-top:1px solid #eee;line-height:1.5;">
    You're getting this because you signed up for the weekly Market Movers email at thecardhuddle.com. Prices are from eBay sold listings.
    <br><a href="${esc(unsubUrl)}" style="color:#999;">Unsubscribe</a>
  </td></tr>
</table></td></tr></table></body></html>`;

  const t = (title, rows) => rows.length ? `\n${title}\n${rows.join('\n')}\n` : '';
  const text = `THE CARD HUDDLE - MARKET MOVERS
This week in football cards: ${c.sales.toLocaleString('en-US')} sales, ${money(c.value)} changed hands.
${t('BIGGEST RISERS', c.risers.map(r => `- ${r.name || r.player} ${pct(r.changePct)}: ${L(r.query)}`))}${t('PLAYERS ON THE MOVE', c.players.map(r => `- ${r.player} ${pct(r.changePct)}: ${L(r.query)}`))}${t('COOLING OFF', c.fallers.map(r => `- ${r.name || r.player} ${pct(r.changePct)}: ${L(r.query)}`))}${t('MOST SOLD', c.mostSold.map(r => `- ${r.name} (${r.sales} sales): ${L(r.query)}`))}
See the full market: ${site}/
${askSurvey ? `\nHelp shape The Card Huddle (2-minute beta survey): ${surveyUrl}\n` : ''}
Unsubscribe: ${unsubUrl}
`;
  return { subject: subjectFor(c), html, text };
}

function confirmEmail({ confirmUrl }) {
  return {
    subject: 'Confirm your weekly Market Movers email',
    html: `<div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111;">
      <div style="font-size:12px;letter-spacing:.08em;font-weight:800;color:#2d6a4f;">THE CARD HUDDLE</div>
      <h2 style="margin:10px 0;">One click and you're in</h2>
      <p style="line-height:1.6;color:#333;">Every Monday: the football cards and players moving most, the most-traded cards and the week's biggest sales, from real eBay sold prices.</p>
      <p style="margin:22px 0;"><a href="${esc(confirmUrl)}" style="display:inline-block;background:#2d6a4f;color:#fff;text-decoration:none;font-weight:800;padding:12px 24px;border-radius:8px;">Yes, send me Market Movers</a></p>
      <p style="font-size:12px;color:#999;">Didn't ask for this? Ignore this email and you won't hear from us.</p>
    </div>`,
    text: `Confirm your weekly Market Movers email from The Card Huddle:\n${confirmUrl}\n\nDidn't ask for this? Ignore this email and you won't hear from us.`,
  };
}

module.exports = { SURVEY_ASK_UNTIL, epnUrl, SITE, normEmail, validEmail, weekId, inSendWindow, SEND_FROM_HOUR, digestContent, renderDigest, subjectFor, confirmEmail, link };
