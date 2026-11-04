// Bounty Board (owner, Nov 2026): post the card you want and what you'll pay;
// a collector who has it claims it with photos, you pay, they ship, they're
// paid when it arrives. Server: server.js "Bounty Board"; rules: bounty-core.js.
// Uses app.js helpers: authFetch, safeJson, escHtml, getSessionToken, showLogin.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const esc = (s) => (typeof escHtml === 'function' ? escHtml(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const daysLeft = (iso) => { const d = Math.ceil((Date.parse(iso) - Date.now()) / 86400000); return d <= 0 ? 'ends today' : d === 1 ? '1 day left' : `${d} days left`; };
  const GRADES = ['Raw', 'PSA 10', 'PSA 9', 'PSA 8', 'BGS 10', 'BGS 9.5', 'BGS 9', 'SGC 10', 'SGC 9.5', 'SGC 9', 'CGC 10', 'CGC 9.5', 'CGC 9', 'TAG 10'];
  const STATUS = {
    open: 'Open', claimed: 'Claimed: waiting on the buyer', paid: 'Paid: waiting to ship', shipped: 'Shipped',
    complete: 'Done', disputed: 'In dispute: payment held', refunded: 'Refunded', cancelled: 'Taken down', expired: 'Ended',
  };
  let state = { open: [], mine: [], payments: false, fees: { buyer: 0.04, seller: 0.04 }, q: '' };
  let loaded = false;

  async function api(url, opts = {}) {
    const r = await authFetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    const d = await safeJson(r);
    if (r.status === 401) { if (typeof showLogin === 'function') showLogin(); throw new Error((d && d.error) || 'Sign in first.'); }
    if (!r.ok) { const e = new Error((d && d.error) || 'Something went wrong.'); e.data = d; throw e; }
    return d;
  }
  const signedIn = () => typeof getSessionToken === 'function' && !!getSessionToken();
  const needLogin = () => { if (signedIn()) return false; if (typeof showLogin === 'function') showLogin(); return true; };

  async function load() {
    const list = $('bty-list');
    try {
      const d = await api('/api/bounties' + (state.q ? '?q=' + encodeURIComponent(state.q) : ''));
      Object.assign(state, d);
      paint();
    } catch (err) {
      if (list) list.innerHTML = `<p class="bty-empty">Could not load bounties: ${esc(err.message)}</p>`;
    }
  }

  function card(b) {
    const own = b.mine ? '<span class="bty-tag">Yours</span>' : '';
    return `<article class="bty-card" data-id="${esc(b.id)}">
      <div class="bty-card-main"><h3>${esc(b.card)}</h3>
        <div class="bty-meta"><span class="bty-grade">${esc(b.grade)}</span><span>${esc(daysLeft(b.expiresAt))}</span>${own}</div></div>
      <div class="bty-card-side"><div class="bty-price">${money(b.price)}</div><div class="bty-sub">shipping included</div>
        ${b.mine ? '' : `<button type="button" class="bty-btn" data-act="claim" data-id="${esc(b.id)}">I have it</button>`}</div>
    </article>`;
  }

  function mineRow(b) {
    const c = b.claim || {};
    let actions = '';
    if (b.mine) {
      if (b.status === 'open') actions = `<button class="bty-btn ghost" data-act="cancel" data-id="${b.id}">Take down</button>`;
      if (b.status === 'claimed') actions = `<button class="bty-btn" data-act="view" data-id="${b.id}">See their card &amp; pay</button>`;
      if (b.status === 'shipped') actions = `<button class="bty-btn" data-act="received" data-id="${b.id}">It arrived</button><button class="bty-btn ghost" data-act="dispute" data-id="${b.id}">Problem</button>`;
      if (b.status === 'paid') actions = `<button class="bty-btn ghost" data-act="dispute" data-id="${b.id}">Problem</button>`;
      if (['expired', 'cancelled'].includes(b.status)) actions = `<button class="bty-btn" data-act="renew" data-id="${b.id}">Post again</button>`;
      if (b.status === 'complete' && !(c.rated && c.rated.byBuyer)) actions = rateBtns(b.id);
    } else if (b.seller) {
      if (b.status === 'paid') actions = `<button class="bty-btn" data-act="view" data-id="${b.id}">Ship it</button>`;
      if (b.status === 'complete' && !(c.rated && c.rated.bySeller)) actions = rateBtns(b.id);
    }
    const role = b.mine ? 'Buying' : 'Selling';
    const amount = b.mine ? `You pay ${money(b.youPay)}` : `You get ${money(b.youGet)}`;
    return `<div class="bty-row"><div><strong>${esc(b.card)}</strong> <span class="bty-grade">${esc(b.grade)}</span>
      <div class="bty-sub">${role} · ${amount} · ${esc(STATUS[b.status] || b.status)}${c.tracking ? ` · ${esc(c.carrier)} ${esc(c.tracking)}` : ''}</div></div>
      <div class="bty-row-acts"><button class="bty-btn ghost" data-act="view" data-id="${b.id}">Details</button>${actions}</div></div>`;
  }
  const rateBtns = (id) => `<span class="bty-rate">Rate: ${[1, 2, 3, 4, 5].map(n => `<button data-act="rate" data-id="${id}" data-stars="${n}" title="${n} star${n > 1 ? 's' : ''}">&#9733;</button>`).join('')}</span>`;

  function paint() {
    const list = $('bty-list'), mine = $('bty-mine');
    if (!list) return;
    $('bty-soon').classList.toggle('hidden', !!state.payments);
    list.innerHTML = state.open.length ? state.open.map(card).join('')
      : `<p class="bty-empty">${state.q ? 'No open bounties match that.' : 'No bounties yet. Post the first one: name the card you want and what you will pay.'}</p>`;
    mine.innerHTML = state.mine.length ? `<h2 class="bty-h2">Your bounties and claims</h2>` + state.mine.map(mineRow).join('') : '';
  }

  // ---- Posting ----
  let priceTimer = null;
  function postForm() {
    if (needLogin()) return;
    modal(`<h2>Post a bounty</h2>
      <p class="bty-sub">Name the exact card you want and what you'll pay for it, shipping included. It stays up for up to 30 days. You only pay when a collector shows you the card and you accept it.</p>
      <label>Card<input id="bty-f-card" maxlength="140" placeholder="2024 Prizm Bo Nix Silver Prizm #301" autocomplete="off"></label>
      <div class="bty-two"><label>Grade<select id="bty-f-grade">${GRADES.map(g => `<option>${g}</option>`).join('')}</select></label>
        <label>Your offer ($, shipping included)<input id="bty-f-price" type="number" min="5" step="1" inputmode="decimal" placeholder="60"></label></div>
      <p class="bty-help" id="bty-f-market"></p>
      <div class="bty-two"><label>Up for<select id="bty-f-days"><option value="30">30 days</option><option value="14">14 days</option><option value="7">7 days</option></select></label>
        <label>Note (optional)<input id="bty-f-note" maxlength="300" placeholder="Centered copies only"></label></div>
      <p class="bty-help" id="bty-f-fee"></p>
      <p class="bty-err" id="bty-f-err"></p>
      <div class="bty-actions"><button class="bty-btn ghost" data-act="close">Cancel</button><button class="bty-btn" id="bty-f-go">Post bounty</button></div>`);
    const upd = () => {
      const p = Number($('bty-f-price').value) || 0;
      $('bty-f-fee').textContent = p ? `When you accept a claim you pay ${money(p * (1 + state.fees.buyer))} (your offer plus a ${Math.round(state.fees.buyer * 100)}% service fee). It's held until the card arrives.` : '';
      clearTimeout(priceTimer);
      priceTimer = setTimeout(async () => {
        const c = $('bty-f-card').value.trim();
        const el = $('bty-f-market');
        if (!el || c.length < 6) { if (el) el.textContent = ''; return; }
        try {
          const d = await (await fetch(`/api/bounties/price?card=${encodeURIComponent(c)}&grade=${encodeURIComponent($('bty-f-grade').value)}`)).json();
          el.innerHTML = d && d.market ? `This card sells for about <strong>${money(d.market)}</strong> (${d.n} recent sales${d.low ? `, ${money(d.low)} to ${money(d.high)}` : ''}). Offers near that get filled.` : '';
        } catch (_) { el.textContent = ''; }
      }, 500);
    };
    ['bty-f-card', 'bty-f-price', 'bty-f-grade'].forEach(id => $(id).addEventListener('input', upd));
    $('bty-f-go').onclick = async () => {
      const btn = $('bty-f-go'); btn.disabled = true;
      try {
        await api('/api/bounties', { method: 'POST', body: JSON.stringify({ card: $('bty-f-card').value, grade: $('bty-f-grade').value,
          price: $('bty-f-price').value, days: $('bty-f-days').value, note: $('bty-f-note').value }) });
        closeModal(); await load();
      } catch (err) { $('bty-f-err').textContent = err.message; btn.disabled = false; }
    };
  }

  // ---- Claiming ----
  async function claim(id) {
    if (needLogin()) return;
    const b = state.open.find(x => x.id === id) || ((await api('/api/bounties/' + id)).bounty);
    if (!state.payments) { modal(`<h2>Claiming opens soon</h2><p>Payments for the Bounty Board are being set up. The bounty is saved; check back shortly.</p><div class="bty-actions"><button class="bty-btn" data-act="close">OK</button></div>`); return; }
    let conn = null;
    try { conn = await api('/api/bounties-connect'); } catch (_) {}
    if (!conn || !conn.ready) {
      modal(`<h2>Set up payouts first</h2><p>To be paid for a card you sell, Stripe (the payment company) checks who you are and where to send the money. It takes a few minutes and you only do it once.</p>
        <p class="bty-sub">You're paid ${money(b.youGet)} for this one: the offer minus a ${Math.round(state.fees.seller * 100)}% service fee.</p>
        <p class="bty-err" id="bty-c-err"></p>
        <div class="bty-actions"><button class="bty-btn ghost" data-act="close">Not now</button><button class="bty-btn" id="bty-c-go">Set up payouts</button></div>`);
      $('bty-c-go').onclick = async () => {
        try { const d = await api('/api/bounties-connect', { method: 'POST' }); location.href = d.url; }
        catch (err) { $('bty-c-err').textContent = err.message; }
      };
      return;
    }
    const graded = b.grade && b.grade !== 'Raw';
    modal(`<h2>Claim: ${esc(b.card)}</h2>
      <p class="bty-sub">${esc(b.grade)} · offer ${money(b.price)} · you get ${money(b.youGet)} when it arrives</p>
      <p>Show the collector the very card you'll ship: clear photos of the <strong>front and back</strong>${graded ? ', with the slab label readable' : ', corners and edges visible'}. They look, then pay. You ship after they pay.</p>
      <label class="bty-photos-btn">Add photos<input type="file" id="bty-c-files" accept="image/*" multiple hidden></label>
      <div class="bty-thumbs" id="bty-c-thumbs"></div>
      ${graded ? `<label>${esc(b.grade.split(' ')[0])} cert number<input id="bty-c-cert" inputmode="numeric" maxlength="14" placeholder="From the slab's label"></label>` : ''}
      <label>Note to the collector (optional)<input id="bty-c-note" maxlength="300" placeholder="Pack fresh, sleeved since"></label>
      <p class="bty-err" id="bty-c-err"></p>
      <div class="bty-actions"><button class="bty-btn ghost" data-act="close">Cancel</button><button class="bty-btn" id="bty-c-go">Claim it</button></div>`);
    const photos = [];
    $('bty-c-files').onchange = async (e) => {
      for (const f of [...e.target.files].slice(0, 6 - photos.length)) {
        try {
          const dataUrl = await shrink(f);
          const d = await api('/api/bounties-photo', { method: 'POST', body: JSON.stringify({ dataUrl }) });
          photos.push(d.url);
          $('bty-c-thumbs').insertAdjacentHTML('beforeend', `<img src="${esc(d.url)}" alt="">`);
        } catch (err) { $('bty-c-err').textContent = err.message; }
      }
      e.target.value = '';
    };
    $('bty-c-go').onclick = async () => {
      const btn = $('bty-c-go'); btn.disabled = true;
      try {
        await api(`/api/bounties/${id}/claim`, { method: 'POST', body: JSON.stringify({ photos, cert: graded ? $('bty-c-cert').value : '', note: $('bty-c-note').value }) });
        closeModal(); await load();
      } catch (err) { $('bty-c-err').textContent = err.message; btn.disabled = false; }
    };
  }
  function shrink(file) {
    return new Promise((ok, bad) => {
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, 1600 / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        ok(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => bad(new Error('That photo could not be read.'));
      img.src = URL.createObjectURL(file);
    });
  }

  // ---- One bounty, for the buyer or the seller ----
  async function view(id) {
    let b;
    try { b = (await api('/api/bounties/' + id)).bounty; } catch (err) { modal(`<p class="bty-err">${esc(err.message)}</p><div class="bty-actions"><button class="bty-btn" data-act="close">OK</button></div>`); return; }
    const c = b.claim;
    let body = `<h2>${esc(b.card)}</h2><p class="bty-sub">${esc(b.grade)} · offer ${money(b.price)} · ${esc(STATUS[b.status] || b.status)}${b.status === 'open' ? ' · ' + esc(daysLeft(b.expiresAt)) : ''}</p>`;
    if (b.note) body += `<p>Note: ${esc(b.note)}</p>`;
    if (b.market) body += `<p class="bty-help">Sells for about ${money(b.market)} right now.</p>`;
    if (c) {
      const sr = c.sellerRating;
      body += `<h3>The card</h3><div class="bty-thumbs big">${(c.photos || []).map(u => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Card photo"></a>`).join('')}</div>`;
      if (c.cert) body += `<p>Cert #${esc(c.cert)}${c.certUrl ? ` · <a href="${esc(c.certUrl)}" target="_blank" rel="noopener">Look it up</a> (check the card, grade and photos match)` : ''}</p>`;
      if (c.note) body += `<p>Seller's note: ${esc(c.note)}</p>`;
      if (b.mine && sr) body += `<p class="bty-sub">Seller: ${sr.sales} finished sale${sr.sales === 1 ? '' : 's'}${sr.stars ? ` · ${sr.stars}&#9733; from ${sr.ratings}` : ' · new seller'}</p>`;
      if (c.ship && b.seller) body += `<h3>Ship to</h3><p class="bty-addr">${esc(c.ship.name || '')}<br>${esc([c.ship.address && c.ship.address.line1, c.ship.address && c.ship.address.line2].filter(Boolean).join(', '))}<br>${esc([c.ship.address && c.ship.address.city, c.ship.address && c.ship.address.state, c.ship.address && c.ship.address.postal_code].filter(Boolean).join(' '))}</p>
        <p class="bty-help">Ship within 5 days in a top loader and team bag, with tracking${b.price >= 250 ? ' and signature required' : ''}. You're paid ${money(b.youGet)} when it arrives.</p>`;
      if (c.tracking) body += `<p>Tracking: ${esc(c.carrier)} ${esc(c.tracking)}</p>`;
      if (c.dispute) body += `<p class="bty-err">Dispute: ${esc(c.dispute.reason)}</p>`;
    }
    let acts = '';
    if (b.mine && b.status === 'claimed') acts = `<button class="bty-btn ghost" data-act="decline" data-id="${b.id}">Not this one</button><button class="bty-btn" data-act="pay" data-id="${b.id}">Pay ${money(b.youPay)}</button>`;
    if (b.seller && b.status === 'paid') {
      body += `<div class="bty-two"><label>Carrier<select id="bty-s-carrier"><option>USPS</option><option>UPS</option><option>FedEx</option><option>Other</option></select></label><label>Tracking number<input id="bty-s-track" maxlength="40"></label></div>`;
      acts = `<button class="bty-btn" data-act="ship" data-id="${b.id}">Mark shipped</button>`;
    }
    if (b.mine && b.status === 'claimed') body += `<p class="bty-help">Paying holds your money with us, not the seller. They're paid when you say the card arrived, or 10 days after it ships unless you report a problem.</p>`;
    modal(body + `<p class="bty-err" id="bty-v-err"></p><div class="bty-actions"><button class="bty-btn ghost" data-act="close">Close</button>${acts}</div>`);
  }

  async function act(name, id, el) {
    const err = (m) => { const e = $('bty-v-err') || $('bty-f-err'); if (e) e.textContent = m; else window.alert(m); };
    try {
      if (name === 'claim') return claim(id);
      if (name === 'view') return view(id);
      if (name === 'close') return closeModal();
      if (name === 'pay') { const d = await api(`/api/bounties/${id}/pay`, { method: 'POST' }); location.href = d.url; return; }
      if (name === 'decline') { if (!confirm('Pass on this card? The bounty opens again for other sellers.')) return; await api(`/api/bounties/${id}/decline`, { method: 'POST' }); }
      if (name === 'cancel') { if (!confirm('Take this bounty down?')) return; await api(`/api/bounties/${id}/cancel`, { method: 'POST' }); }
      if (name === 'renew') await api(`/api/bounties/${id}/renew`, { method: 'POST' });
      if (name === 'received') { if (!confirm('Did the card arrive as shown? The seller is paid now.')) return; await api(`/api/bounties/${id}/received`, { method: 'POST' }); }
      if (name === 'ship') await api(`/api/bounties/${id}/ship`, { method: 'POST', body: JSON.stringify({ carrier: $('bty-s-carrier').value, tracking: $('bty-s-track').value }) });
      if (name === 'rate') await api(`/api/bounties/${id}/rate`, { method: 'POST', body: JSON.stringify({ stars: el.dataset.stars }) });
      if (name === 'dispute') {
        const reason = prompt('What went wrong? (wrong card, damaged, never arrived...) The payment is held while we look into it.');
        if (!reason) return;
        await api(`/api/bounties/${id}/dispute`, { method: 'POST', body: JSON.stringify({ reason }) });
      }
      closeModal(); await load();
    } catch (e) {
      if (e.data && e.data.connect) return claim(id);
      err(e.message);
    }
  }

  // ---- Modal ----
  function modal(html) {
    let m = $('bty-modal');
    if (!m) {
      m = document.createElement('div'); m.id = 'bty-modal'; m.className = 'bty-modal';
      m.innerHTML = '<div class="bty-sheet" role="dialog" aria-modal="true"></div>';
      m.addEventListener('click', (e) => { if (e.target === m) closeModal(); });
      document.body.appendChild(m);
    }
    m.firstChild.innerHTML = html;
    m.classList.remove('hidden');
  }
  function closeModal() { const m = $('bty-modal'); if (m) m.classList.add('hidden'); }

  document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('[data-act]');
    if (!el || !el.closest('#bounties-view, #bty-modal')) return;
    e.preventDefault();
    act(el.dataset.act, el.dataset.id, el);
  });

  window.initBountyView = function () {
    if (!loaded) {
      loaded = true;
      $('bty-post').onclick = postForm;
      let t = null;
      $('bty-search').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value.trim(); load(); }, 300); });
    }
    load();
  };
  window.openBounty = (id) => { if (typeof switchView === 'function') switchView('bounties'); setTimeout(() => view(id), 200); };

  // Links: ?bounty=<id> (from a notification or email), ?bounties=... (back from payout setup).
  try {
    const p = new URLSearchParams(location.search);
    if (p.get('bounty')) setTimeout(() => window.openBounty(p.get('bounty')), 600);
    else if (p.get('bounties')) setTimeout(() => typeof switchView === 'function' && switchView('bounties'), 600);
  } catch (_) {}
})();
