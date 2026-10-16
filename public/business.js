// Card Huddle for Business, the page (owner, Oct 2026). In build, behind the
// admin key; the API is /api/biz/* in server.js, the analysis business-core.js.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => {
    if (n == null || n === '' || !Number.isFinite(Number(n))) return '—';
    const v = Number(n), small = Math.abs(v) < 100 && v % 1 !== 0;
    return (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: small ? 2 : 0, maximumFractionDigits: small ? 2 : 0 });
  };
  // Two ways in: a signed-in Card Huddle account with Business (its session
  // token, shared with the main site on this origin), or the owner's admin key.
  let key = '', token = '';
  try { key = sessionStorage.getItem('chBizKey') || ''; } catch (_) {}
  try { token = localStorage.getItem('cardHuddleToken') || ''; } catch (_) {}

  async function api(path, opts = {}) {
    const r = await fetch(path, { ...opts, cache: 'no-store',
      headers: { ...(key ? { 'x-admin-key': key } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(opts.body ? { 'content-type': 'application/json' } : {}) } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
    return data;
  }

  // ---- sign in, or subscribe ----
  async function gate() {
    let me = {};
    try { me = await api('/api/biz/me'); } catch (_) { me = {}; }
    if (me.active) return start(me);
    $('app').hidden = true; $('gate').hidden = false;
    $('subscribe').hidden = !(me.user && me.checkoutOpen);
    $('logintosite').hidden = !!me.user;
    $('gatemsg').textContent = !me.user ? 'Log in to your Card Huddle account first, then come back here.'
      : me.checkoutOpen ? `Signed in as ${me.user}.` : `Signed in as ${me.user}. Business opens to founding sellers soon.`;
  }
  function showLogin(msg) { gate(); if (msg) $('loginerr').textContent = msg; }
  $('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    key = $('key').value.trim();
    try { const me = await api('/api/biz/me'); if (!me.admin) throw Object.assign(new Error('bad'), { status: 401 });
      try { sessionStorage.setItem('chBizKey', key); } catch (_) {} start(me); }
    catch (err) { key = ''; $('loginerr').textContent = err.status === 401 ? 'That key did not work.' : 'Could not reach the server.'; }
  });
  $('subscribe').addEventListener('click', async () => {
    $('subscribe').disabled = true; $('gateerr').textContent = '';
    try { const r = await api('/api/biz/checkout', { method: 'POST', body: '{}' }); location.href = r.url; }
    catch (err) { $('gateerr').textContent = err.message; $('subscribe').disabled = false; }
  });
  $('billing').addEventListener('click', async () => {
    try { const r = await api('/api/biz/billing', { method: 'POST', body: '{}' }); location.href = r.url; }
    catch (err) { alert(err.message); }
  });

  // ---- tabs ----
  const tabs = document.querySelectorAll('nav button');
  function show(name) {
    tabs.forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    ['brief', 'inv', 'sales', 'ask'].forEach(n => { $('p-' + n).hidden = n !== name; });
    if (name === 'sales') loadSales();
    if (name === 'brief') loadBrief();
    if (name === 'inv') loadInventory();
  }
  tabs.forEach(b => b.addEventListener('click', () => show(b.dataset.tab)));

  // ---- today ----
  const KIND = { reprice: ['down', 'Reprice'], underpriced: ['', 'Underpriced'], unpriced: ['warn', 'Needs a price'], hot: ['', 'Feature it'], dead: ['warn', 'Dead stock'] };
  async function loadSummary(fresh) {
    try {
      if (fresh) { $('summarytext').textContent = 'Writing…'; }
      const r = await api('/api/biz/summary' + (fresh ? '?fresh=1' : ''));
      if (!r.summary) { $('summary').hidden = true; return; }
      $('summary').hidden = false;
      $('summarytext').textContent = r.summary;
      $('summaryat').textContent = r.at ? `Written ${new Date(r.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} from your cards and sales` : '';
    } catch (_) { $('summary').hidden = true; }
  }
  $('summaryfresh').addEventListener('click', () => loadSummary(true));
  async function loadBrief() {
    loadSummary(false);
    try {
      const b = await api('/api/biz/brief');
      const k = b.kpis;
      const gain = k.unrealized;
      const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
      $('kpis').innerHTML = [
        ['Market value', money(k.marketValue), `${k.pricedShare}% of cards priced`],
        ['Listed at', money(k.listedValue), plural(k.cards, 'card')],
        ['Cost basis', money(k.costBasis), k.pricedWithCost ? `<span class="${gain >= 0 ? 'up' : 'down'}">${gain >= 0 ? '+' : ''}${money(gain)} unrealized</span>` : (k.costBasis ? 'Gain shows once cards are priced' : 'Add costs to see profit')],
        ['Dead stock (90d+)', k.deadStock.toLocaleString(), `${money(k.deadValue)} tied up`],
      ].map(([l, v, s]) => `<div class="kpi"><small>${l}</small><b>${v}</b><em>${s}</em></div>`).join('');
      const total = b.actions.reduce((a, x) => a + (x.dollars || 0), 0);
      $('headline').textContent = !k.cards ? 'Add your inventory to get your first brief.'
        : b.actions.length ? `${b.actions.length} moves today worth about ${money(total)}.` : 'Nothing needs you today.';
      $('sub').textContent = k.cards ? `From ${plural(k.cards, 'card')} against real sold prices from the last 60 days.` : 'Go to Inventory to add cards or import a spreadsheet.';
      $('brief').innerHTML = b.actions.length ? b.actions.map((a, i) => {
        const [cls, tag] = KIND[a.kind] || ['', a.kind];
        const btn = a.suggest != null && a.id ? `<div class="acts"><button class="act go" data-id="${esc(a.id)}" data-price="${a.suggest}">Set price to ${money(a.suggest)}</button></div>` : '';
        return `<div class="item ${cls}" id="act-${i}"><span class="tag">${tag}</span><strong>${esc(a.title)}</strong><p>${esc(a.text)}</p><span class="why">${esc(a.why || '')}</span>${btn}</div>`;
      }).join('') : `<div class="empty">${!k.cards ? 'No cards yet.' : k.pricedShare ? 'Every priced card is within range of the market. Check back tomorrow.' : 'None of your cards has 3 recent sales of the same grade yet, so none can be priced. Open Inventory to refresh prices.'}</div>`;
    } catch (err) { if (err.status === 401 || err.status === 402) showLogin(); else $('brief').innerHTML = `<div class="empty">Could not load the brief: ${esc(err.message)}</div>`; }
  }
  $('brief').addEventListener('click', async (e) => {
    const b = e.target.closest('.act.go[data-id]'); if (!b) return;
    b.disabled = true;
    try { await api('/api/biz/inventory/' + encodeURIComponent(b.dataset.id), { method: 'PATCH', body: JSON.stringify({ price: Number(b.dataset.price) }) });
      const item = b.closest('.item'); item.classList.add('done');
      const n = document.createElement('span'); n.className = 'why'; n.textContent = `✓ Price set to ${money(b.dataset.price)}. Update the listing on its platform too.`; item.appendChild(n);
    } catch (err) { b.disabled = false; alertIn(b.closest('.item'), err.message); }
  });
  function alertIn(el, msg) { const n = document.createElement('span'); n.className = 'err'; n.textContent = msg; el.appendChild(n); }

  // ---- inventory ----
  async function loadInventory() {
    try {
      const inv = await api('/api/biz/inventory');
      const { items } = inv;
      if (inv.ebaySeller && !$('ebayseller').value) $('ebayseller').value = inv.ebaySeller;
      if (inv.ebaySyncedAt) $('ebaystatus').textContent = `Last synced ${new Date(inv.ebaySyncedAt).toLocaleString()} from ${inv.ebaySeller}.`;
      if (inv.ebaySeller && Date.now() - Date.parse(inv.ebaySyncedAt || 0) > 6 * 3600 * 1000 && !syncing) { ebaySync(); return; }
      if (!items.length) { $('invtable').innerHTML = '<div class="empty">No cards yet. Add one above or import a spreadsheet.</div>'; return; }
      const now = Date.now();
      const rows = items.map(it => {
        const v = it.value || {};
        const days = Math.floor((now - Date.parse(it.listedAt)) / 86400000);
        let pill = '<span class="pill warn">Not priced yet</span>';
        if (v.market != null && it.price != null) {
          pill = it.price > v.market * 1.2 ? '<span class="pill bad">Over market</span>' : it.price < v.market * 0.85 ? '<span class="pill warn">Underpriced</span>' : '<span class="pill ok">On market</span>';
        } else if (v.asOf && v.market == null) pill = `<span class="pill">${v.n || 0} comps</span>`;
        if (days >= 90) pill += ' <span class="pill bad">90d+</span>';
        return `<tr><td>${esc(it.title)}${it.qty > 1 ? ` &times;${it.qty}` : ''}</td><td>${esc(it.grade || 'Raw')}</td><td>${esc(it.platform || '')}</td>
          <td class="r">${money(it.cost)}</td><td class="r">${money(it.price)}</td><td class="r">${money(v.market)}</td><td class="r">${v.n || 0}</td><td class="r">${days}</td><td>${pill}</td>
          <td style="white-space:nowrap"><button class="act" data-sold="${esc(it.id)}" data-price="${it.price ?? ''}">Sold</button> <button class="act" data-del="${esc(it.id)}" aria-label="Remove ${esc(it.title)}">Remove</button></td></tr>`;
      }).join('');
      $('invtable').innerHTML = `<div class="tablewrap"><table><thead><tr><th>Card</th><th>Grade</th><th>Where</th><th class="r">Cost</th><th class="r">Your price</th><th class="r">Market</th><th class="r">Comps</th><th class="r">Days</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
      if (items.some(it => !it.value)) valueAll();
    } catch (err) { if (err.status === 401 || err.status === 402) showLogin(); else $('invtable').innerHTML = `<div class="empty">Could not load: ${esc(err.message)}</div>`; }
  }
  $('invtable').addEventListener('click', async (e) => {
    const sb = e.target.closest('[data-sold]');
    if (sb) {
      const v = window.prompt('Sold for how much?', sb.dataset.price || '');
      if (v == null) return;
      try { await api('/api/biz/inventory/' + encodeURIComponent(sb.dataset.sold), { method: 'PATCH', body: JSON.stringify({ sold: true, soldFor: Number(String(v).replace(/[$,]/g, '')) }) });
        $('invstatus').textContent = 'Recorded as sold. See it in Sales.'; }
      catch (err) { $('invstatus').textContent = err.message; }
      return loadInventory();
    }
    const b = e.target.closest('[data-del]'); if (!b) return;
    await api('/api/biz/inventory/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' }).catch(() => {});
    loadInventory();
  });
  let valuing = false;
  async function valueAll() {
    if (valuing) return; valuing = true;
    try {
      for (let i = 0; i < 300; i++) {
        const r = await api('/api/biz/value', { method: 'POST', body: '{}' });
        $('invstatus').textContent = r.remaining ? `Pricing… ${r.total - r.remaining} of ${r.total}` : 'All cards priced against the last 60 days of sales.';
        if (!r.remaining) break;
      }
    } catch (err) { $('invstatus').textContent = `Pricing stopped: ${err.message}`; }
    valuing = false;
    loadInventory();
  }
  $('reprice').addEventListener('click', valueAll);
  let syncing = false;
  async function ebaySync() {
    const seller = $('ebayseller').value.trim();
    if (!seller) { $('ebaystatus').textContent = 'Enter your eBay username first.'; return; }
    syncing = true; $('ebaysync').disabled = true; $('ebaystatus').textContent = 'Reading your eBay listings…';
    try {
      const r = await api('/api/biz/ebay-sync', { method: 'POST', body: JSON.stringify({ seller }) });
      $('ebaystatus').textContent = `Synced ${r.listings} listings from ${r.seller}: ${r.added} new, ${r.updated} updated${r.ended ? `, ${r.ended} sold or ended` : ''}.`;
    } catch (err) { $('ebaystatus').textContent = err.message; }
    $('ebaysync').disabled = false;
    await loadInventory();
    syncing = false;
  }
  $('ebaysync').addEventListener('click', ebaySync);
  $('a-add').addEventListener('click', async () => {
    const row = { title: $('a-title').value, grade: $('a-grade').value, cost: $('a-cost').value, price: $('a-price').value, platform: $('a-platform').value };
    if (!row.title.trim()) { $('invstatus').textContent = 'Type the card first.'; return; }
    try { await api('/api/biz/inventory', { method: 'POST', body: JSON.stringify({ items: [row] }) });
      ['a-title', 'a-grade', 'a-cost', 'a-price'].forEach(id => { $(id).value = ''; });
      $('invstatus').textContent = 'Added.'; loadInventory(); }
    catch (err) { $('invstatus').textContent = err.message; }
  });

  // CSV: quoted fields, commas inside quotes, a header row.
  function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const clean = rows.filter(r => r.some(x => x.trim()));
    if (clean.length < 2) return [];
    const head = clean[0].map(h => h.trim());
    return clean.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
  }
  $('csvfile').addEventListener('change', () => {
    const f = $('csvfile').files[0]; if (!f) return;
    const rd = new FileReader(); rd.onload = () => { $('csvtext').value = String(rd.result || ''); }; rd.readAsText(f);
  });
  $('csvgo').addEventListener('click', async () => {
    const items = parseCsv($('csvtext').value);
    if (!items.length) { $('invstatus').textContent = 'No rows found. The first line must be the column names.'; return; }
    try { const r = await api('/api/biz/inventory', { method: 'POST', body: JSON.stringify({ items, mode: $('csvreplace').checked ? 'replace' : 'append' }) });
      $('invstatus').textContent = `Imported ${r.added} cards. Pricing them now…`; $('csvtext').value = ''; loadInventory(); }
    catch (err) { $('invstatus').textContent = err.message; }
  });

  // ---- sales ----
  const tbl = (title, rows) => `<div class="panel"><h2>${title}</h2>${rows.length ? `<div class="tablewrap" style="border:0"><table style="min-width:0"><thead><tr><th></th><th class="r">Sales</th><th class="r">Revenue</th><th class="r">Profit</th></tr></thead><tbody>${
    rows.map(r => `<tr><td>${esc(r.name)}</td><td class="r">${r.sales}</td><td class="r">${money(r.revenue)}</td><td class="r ${r.profit >= 0 ? 'up' : 'down'}">${r.missingCost === r.sales ? '—' : money(r.profit)}</td></tr>`).join('')}</tbody></table></div>` : '<p style="color:var(--fg3);margin:0">No sales yet.</p>'}</div>`;
  async function loadSales() {
    try {
      const { report: r, ended, sold } = await api('/api/biz/sales');
      const m = r.last30, a = r.allTime;
      $('salekpis').innerHTML = [
        ['Sold, 30 days', money(m.revenue), `${m.sales} sale${m.sales === 1 ? '' : 's'}`],
        ['Profit, 30 days', money(m.profit), m.margin != null ? `${m.margin}% margin` : 'Add costs to see margin'],
        ['Fees, 30 days', money(m.fees), 'Estimated'],
        ['All-time profit', money(a.profit), a.missingCost ? `${a.missingCost} sale${a.missingCost === 1 ? ' has' : 's have'} no cost` : `${a.sales} sale${a.sales === 1 ? '' : 's'}`],
      ].map(([l, v, x]) => `<div class="kpi"><small>${l}</small><b>${v}</b><em>${x}</em></div>`).join('');
      $('endedbox').innerHTML = ended.length ? `<div class="panel" style="margin-bottom:18px"><h2>Gone from eBay: sold or ended?</h2><p style="margin:0 0 10px;color:var(--fg2);font-size:13.5px">These left your eBay store since the last sync. Confirm the ones that sold.</p>${
        ended.slice(-50).reverse().map(it => `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 0;border-top:1px solid var(--line)">
          <span style="flex:1 1 16rem;min-width:0">${esc(it.title)}</span><input class="mini" data-for="${esc(it.id)}" value="${it.price ?? ''}" inputmode="decimal" aria-label="Sold for">
          <button class="act go" data-endsold="${esc(it.id)}">Sold</button><button class="act" data-endnot="${esc(it.id)}">Didn't sell</button></div>`).join('')}</div>` : '';
      $('salegroups').innerHTML = tbl('By month', r.byMonth) + tbl('By player', r.byPlayer) + tbl('By set', r.bySet) + tbl('By platform', r.byPlatform);
      $('salelist').innerHTML = sold.length ? `<div class="tablewrap"><table><thead><tr><th>Card</th><th>Sold</th><th>Where</th><th class="r">For</th><th class="r">Cost</th><th></th></tr></thead><tbody>${
        sold.map(x => `<tr><td>${esc(x.title)}</td><td>${esc(String(x.soldAt).slice(0, 10))}</td><td>${esc(x.platform || '')}</td><td class="r">${money(x.soldFor)}</td><td class="r">${money(x.cost)}</td>
          <td><button class="act" data-undo="${esc(x.id)}">Delete</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No sales recorded yet. Tap Sold on a card in Inventory, or sync eBay to catch sales automatically.</div>';
    } catch (err) { if (err.status === 401 || err.status === 402) showLogin(); else $('salelist').innerHTML = `<div class="empty">Could not load sales: ${esc(err.message)}</div>`; }
  }
  $('p-sales').addEventListener('click', async (e) => {
    const s = e.target.closest('[data-endsold]'), n = e.target.closest('[data-endnot]'), u = e.target.closest('[data-undo]');
    try {
      if (s) { const v = document.querySelector(`input[data-for="${CSS.escape(s.dataset.endsold)}"]`).value;
        await api('/api/biz/ended/' + encodeURIComponent(s.dataset.endsold), { method: 'POST', body: JSON.stringify({ sold: true, soldFor: Number(String(v).replace(/[$,]/g, '')) }) }); }
      else if (n) await api('/api/biz/ended/' + encodeURIComponent(n.dataset.endnot), { method: 'POST', body: JSON.stringify({ sold: false }) });
      else if (u) await api('/api/biz/sales/' + encodeURIComponent(u.dataset.undo), { method: 'DELETE' });
      else return;
    } catch (_) { /* reloads below show the true state */ }
    loadSales();
  });

  // ---- ask ----
  async function ask(q) {
    if (!q) return;
    $('answer').hidden = false; $('answertext').innerHTML = '<p style="color:var(--fg3)">Reading your inventory…</p>';
    try { const r = await api('/api/biz/ask', { method: 'POST', body: JSON.stringify({ q }) });
      $('answertext').innerHTML = esc(r.answer).split(/\n+/).map(l => /^\s*[-•*]\s+/.test(l) ? `<p>• ${l.replace(/^\s*[-•*]\s+/, '')}</p>` : `<p>${l}</p>`).join(''); }
    catch (err) { $('answertext').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
  }
  document.querySelectorAll('.q').forEach(b => b.addEventListener('click', () => { $('askq').value = b.textContent; ask(b.textContent); }));
  $('askform').addEventListener('submit', (e) => { e.preventDefault(); ask($('askq').value.trim()); });

  function start(me) {
    $('gate').hidden = true; $('app').hidden = false;
    $('billing').hidden = !(me && me.user && !me.admin);
    show('brief');
  }
  gate();
})();
