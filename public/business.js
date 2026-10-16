// Card Huddle for Business, the page (owner, Oct 2026). In build, behind the
// admin key; the API is /api/biz/* in server.js, the analysis business-core.js.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => (n == null || !Number.isFinite(Number(n))) ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: Number(n) < 100 ? 2 : 0 });
  let key = '';
  try { key = sessionStorage.getItem('chBizKey') || ''; } catch (_) {}

  async function api(path, opts = {}) {
    const r = await fetch(path, { ...opts, cache: 'no-store',
      headers: { 'x-admin-key': key, ...(opts.body ? { 'content-type': 'application/json' } : {}) } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
    return data;
  }

  // ---- sign in ----
  function showLogin(msg) { $('app').hidden = true; $('login').hidden = false; $('loginerr').textContent = msg || ''; }
  $('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    key = $('key').value.trim();
    try { await api('/api/biz/inventory'); try { sessionStorage.setItem('chBizKey', key); } catch (_) {} start(); }
    catch (err) { showLogin(err.status === 401 ? 'That key did not work.' : 'Could not reach the server.'); }
  });

  // ---- tabs ----
  const tabs = document.querySelectorAll('nav button');
  function show(name) {
    tabs.forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    ['brief', 'inv', 'ask'].forEach(n => { $('p-' + n).hidden = n !== name; });
    if (name === 'brief') loadBrief();
    if (name === 'inv') loadInventory();
  }
  tabs.forEach(b => b.addEventListener('click', () => show(b.dataset.tab)));

  // ---- today ----
  const KIND = { reprice: ['down', 'Reprice'], underpriced: ['', 'Underpriced'], unpriced: ['warn', 'Needs a price'], hot: ['', 'Feature it'], dead: ['warn', 'Dead stock'] };
  async function loadBrief() {
    try {
      const b = await api('/api/biz/brief');
      const k = b.kpis;
      const gain = k.marketValue - k.costBasis;
      $('kpis').innerHTML = [
        ['Market value', money(k.marketValue), `${k.pricedShare}% of cards priced`],
        ['Listed at', money(k.listedValue), `${k.cards.toLocaleString()} cards`],
        ['Cost basis', money(k.costBasis), k.costBasis ? `<span class="${gain >= 0 ? 'up' : 'down'}">${gain >= 0 ? '+' : ''}${money(gain)} unrealized</span>` : 'Add costs to see profit'],
        ['Dead stock (90d+)', k.deadStock.toLocaleString(), `${money(k.deadValue)} tied up`],
      ].map(([l, v, s]) => `<div class="kpi"><small>${l}</small><b>${v}</b><em>${s}</em></div>`).join('');
      const total = b.actions.reduce((a, x) => a + (x.dollars || 0), 0);
      $('headline').textContent = !k.cards ? 'Add your inventory to get your first brief.'
        : b.actions.length ? `${b.actions.length} moves today worth about ${money(total)}.` : 'Nothing needs you today.';
      $('sub').textContent = k.cards ? `From ${k.cards.toLocaleString()} cards against real sold prices from the last 60 days.` : 'Go to Inventory to add cards or import a spreadsheet.';
      $('brief').innerHTML = b.actions.length ? b.actions.map((a, i) => {
        const [cls, tag] = KIND[a.kind] || ['', a.kind];
        const btn = a.suggest != null && a.id ? `<div class="acts"><button class="act go" data-id="${esc(a.id)}" data-price="${a.suggest}">Set price to ${money(a.suggest)}</button></div>` : '';
        return `<div class="item ${cls}" id="act-${i}"><span class="tag">${tag}</span><strong>${esc(a.title)}</strong><p>${esc(a.text)}</p><span class="why">${esc(a.why || '')}</span>${btn}</div>`;
      }).join('') : `<div class="empty">${k.cards ? 'Every priced card is within range of the market. Check back tomorrow.' : 'No cards yet.'}</div>`;
    } catch (err) { if (err.status === 401) showLogin(); else $('brief').innerHTML = `<div class="empty">Could not load the brief: ${esc(err.message)}</div>`; }
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
          <td><button class="act" data-del="${esc(it.id)}" aria-label="Remove ${esc(it.title)}">Remove</button></td></tr>`;
      }).join('');
      $('invtable').innerHTML = `<div class="tablewrap"><table><thead><tr><th>Card</th><th>Grade</th><th>Where</th><th class="r">Cost</th><th class="r">Your price</th><th class="r">Market</th><th class="r">Comps</th><th class="r">Days</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
      if (items.some(it => !it.value)) valueAll();
    } catch (err) { if (err.status === 401) showLogin(); else $('invtable').innerHTML = `<div class="empty">Could not load: ${esc(err.message)}</div>`; }
  }
  $('invtable').addEventListener('click', async (e) => {
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

  function start() { $('login').hidden = true; $('app').hidden = false; show('brief'); }
  if (key) api('/api/biz/inventory').then(start).catch(() => showLogin()); else showLogin();
})();
