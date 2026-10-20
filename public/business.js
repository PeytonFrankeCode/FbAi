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
    $('app').hidden = true; $('landing').hidden = false;
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
  $('waitlist').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('w-go').disabled = true; $('w-msg').textContent = '';
    try {
      const r = await api('/api/biz/waitlist', { method: 'POST', body: JSON.stringify({ email: $('w-email').value, store: $('w-store').value,
        where: $('w-where').value, size: $('w-size').value, website: $('w-hp').value }) });
      $('w-msg').textContent = r.already ? "You're already on the list. We'll be in touch." : "You're on the list. We'll email you when your spot opens.";
      $('waitlist').querySelectorAll('input,select').forEach(x => { x.disabled = true; });
    } catch (err) { $('w-msg').textContent = err.message; $('w-go').disabled = false; }
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
    ['brief', 'inv', 'sales', 'shows', 'ask'].forEach(n => { $('p-' + n).hidden = n !== name; });
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
      $('summarytext').innerHTML = summaryHtml(r.summary);
      $('summaryat').textContent = r.at ? `Written ${new Date(r.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} from your cards and sales` : '';
    } catch (_) { $('summary').hidden = true; }
  }
  $('summaryfresh').addEventListener('click', () => loadSummary(true));
  // "- Label: sentence" lines become a list with the label in bold; anything
  // else (an older paragraph summary) stays a paragraph.
  function summaryHtml(text) {
    const lines = String(text).split(/\n+/).map(l => l.trim()).filter(Boolean);
    const bullet = /^[-•*]\s+/;
    if (!lines.some(l => bullet.test(l))) return `<p>${esc(text)}</p>`;
    return '<ul>' + lines.map(l => {
      const t = l.replace(bullet, '').replace(/\*\*/g, '');
      const m = /^([^:]{1,28}):\s+(.+)$/.exec(t);
      return `<li>${m && m[1].split(/\s+/).length <= 4 ? `<b>${esc(m[1])}:</b> ${esc(m[2])}` : esc(t)}</li>`;
    }).join('') + '</ul>';
  }
  // The health score: a ring for the number, a bar per part, and what would
  // raise it most.
  const HPART = { priced: 'Priced right', fresh: 'Fresh stock', known: 'Value known', costs: 'Costs recorded' };
  function renderHealth(h) {
    if (!h) { $('health').hidden = true; return; }
    const r = 46, c = 2 * Math.PI * r, frac = h.score / 100;
    const tone = h.score >= 70 ? 'var(--up)' : h.score >= 50 ? 'var(--warn)' : 'var(--down)';
    $('health').innerHTML = `<svg class="ring" viewBox="0 0 112 112" role="img" aria-label="Inventory health ${h.score} out of 100, ${h.label}">
        <circle cx="56" cy="56" r="${r}" fill="none" stroke="var(--sunk)" stroke-width="10"/>
        <circle cx="56" cy="56" r="${r}" fill="none" stroke="${tone}" stroke-width="10" stroke-linecap="round"
          stroke-dasharray="${(c * frac).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 56 56)"/>
        <text x="56" y="56" text-anchor="middle" font-size="30" font-weight="800" fill="var(--fg)">${h.score}</text>
        <text x="56" y="74" text-anchor="middle" font-size="11" fill="var(--fg2)">${esc(h.label)}</text>
      </svg>
      <div class="hparts"><h2>Inventory health${h.change7 != null ? ` <span class="pill ${h.change7 >= 0 ? 'ok' : 'bad'}">${h.change7 >= 0 ? '+' : ''}${h.change7} this week</span>` : ''}</h2>${
        Object.keys(HPART).map(k => `<div class="hpart"><span>${HPART[k]}</span><span class="bar"><i style="width:${Math.round(100 * h.parts[k] / h.max[k])}%"></i></span><span class="num">${h.parts[k]}/${h.max[k]}</span></div>`).join('')}</div>
      ${h.tips.length ? `<ul class="htips">${h.tips.slice(0, 3).map(t => `<li><b>+${t.gain}</b><span>${esc(t.text)}</span></li>`).join('')}</ul>` : ''}`;
    $('health').hidden = false;
  }
  function renderAlerts(list) {
    $('alertsbox').hidden = !list.length;
    $('alerts').innerHTML = list.map(a => {
      const up = a.pct > 0;
      const hint = a.price == null ? '' : up && a.price < a.to ? ` You list it at ${money(a.price)}.` : !up && a.price > a.to ? ` You list it at ${money(a.price)}, above the market now.` : '';
      return `<div class="item ${up ? '' : 'down'}"><div class="item-main"><span class="tag">${up ? 'Up' : 'Down'} ${Math.abs(a.pct)}%</span><strong>${esc(a.title)}</strong>`
        + `<p>Market ${money(a.from)} → ${money(a.to)}.${esc(hint)}</p><span class="why">${esc(new Date(a.at).toLocaleDateString([], { month: 'short', day: 'numeric' }))}</span></div>`
        + `<div class="acts"><button class="act go" data-id="${esc(a.id)}" data-price="${a.to}">Set to ${money(a.to)}</button><button class="act ghost" data-dismiss="${esc(a.id)}">Dismiss</button></div></div>`;
    }).join('');
  }
  async function loadAlerts() {
    try { renderAlerts((await api('/api/biz/alerts')).alerts); } catch (_) { /* brief shows the error */ }
  }
  $('alerts').addEventListener('click', async (e) => {
    const d = e.target.closest('[data-dismiss]');
    if (d) { renderAlerts((await api('/api/biz/alerts/' + encodeURIComponent(d.dataset.dismiss), { method: 'DELETE' })).alerts); return; }
    const b = e.target.closest('.act.go[data-id]'); if (!b) return;
    b.disabled = true;
    try { await api('/api/biz/inventory/' + encodeURIComponent(b.dataset.id), { method: 'PATCH', body: JSON.stringify({ price: Number(b.dataset.price) }) });
      renderAlerts((await api('/api/biz/alerts/' + encodeURIComponent(b.dataset.id), { method: 'DELETE' })).alerts);
    } catch (err) { b.disabled = false; alertIn(b.closest('.item'), err.message); }
  });
  $('alertsclear').addEventListener('click', async () => renderAlerts((await api('/api/biz/alerts/all', { method: 'DELETE' })).alerts));
  async function loadBrief() {
    loadSummary(false);
    loadAlerts();
    try {
      const b = await api('/api/biz/brief');
      renderHealth(b.health);
      const k = b.kpis;
      const gain = k.unrealized;
      const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
      $('kpis').innerHTML = [
        ['Market value', money(k.marketValue), `${k.pricedShare}% of cards priced`],
        ['Listed at', money(k.listedValue), plural(k.cards, 'card')],
        ['Cost basis', money(k.costBasis), k.pricedWithCost ? `<span class="${gain >= 0 ? 'up' : 'down'}">${gain >= 0 ? '+' : ''}${money(gain)} unrealized</span>` : (k.costBasis ? 'Gain shows once cards are priced' : 'Add costs to see profit')],
        ['Dead stock', k.deadStock.toLocaleString(), `90+ days, ${money(k.deadValue)} tied up`],
      ].map(([l, v, s]) => `<div class="kpi"><small>${l}</small><b>${v}</b><em>${s}</em></div>`).join('');
      const total = b.actions.reduce((a, x) => a + (x.dollars || 0), 0);
      $('headline').textContent = !k.cards ? 'Add your inventory to get your first brief.'
        : b.actions.length ? `${b.actions.length} moves today worth about ${money(total)}.` : !k.pricedShare ? 'Your cards are not priced yet.' : 'Nothing needs you today.';
      $('sub').textContent = k.cards ? `${plural(k.cards, 'card')}, priced against the last 60 days of sales.` : 'Go to Inventory to add cards or import a spreadsheet.';
      $('brief').innerHTML = b.actions.length ? b.actions.map((a, i) => {
        const [cls, tag] = KIND[a.kind] || ['', a.kind];
        const btn = a.suggest != null && a.id ? `<div class="acts"><button class="act go" data-id="${esc(a.id)}" data-price="${a.suggest}">Set to ${money(a.suggest)}</button></div>` : '';
        return `<div class="item ${cls}" id="act-${i}"><div class="item-main"><span class="tag">${tag}</span><strong>${esc(a.title)}</strong><p>${esc(a.text)}</p>${a.why ? `<span class="why">${esc(a.why)}</span>` : ''}</div>${btn}</div>`;
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
      if (inv.ebaySyncedAt) $('ebaystatus').textContent = `Last synced ${new Date(inv.ebaySyncedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} from ${inv.ebaySeller}.`;
      if (inv.ebaySeller && Date.now() - Date.parse(inv.ebaySyncedAt || 0) > 6 * 3600 * 1000 && !syncing) { ebaySync(); return; }
      if (!items.length) { $('addbox').open = true; $('invtable').innerHTML = '<div class="empty">No cards yet. Add one above, import a spreadsheet or sync your eBay store.</div>'; return; }
      const now = Date.now();
      const rows = items.map(it => {
        const v = it.value || {};
        const days = Math.floor((now - Date.parse(it.listedAt)) / 86400000);
        let pill = '<span class="pill warn">Not priced yet</span>';
        if (v.market != null && it.price != null) {
          pill = it.price > v.market * 1.2 ? '<span class="pill bad">Over market</span>' : it.price < v.market * 0.85 ? '<span class="pill warn">Underpriced</span>' : '<span class="pill ok">On market</span>';
        } else if (v.asOf && v.market == null) pill = '<span class="pill">Too few sales</span>';
        if (days >= 90) pill += ' <span class="pill bad">90d+</span>';
        const meta = [it.grade || 'Raw', it.platform, `${days} day${days === 1 ? '' : 's'} listed`].filter(Boolean).map(esc).join(' · ');
        return `<tr><td class="pick"><input type="checkbox" class="c-pick" value="${esc(it.id)}" aria-label="Select ${esc(it.title)}"></td>
          <td class="w"><b>${esc(it.title)}${it.qty > 1 ? ` <span class="why">&times;${it.qty}</span>` : ''}</b><span class="why">${meta}</span></td>
          <td class="r c1" data-label="Cost"><button class="act costbtn" data-cost="${esc(it.id)}" data-val="${it.cost ?? ''}" title="Set what you paid">${it.cost == null ? 'Add' : money(it.cost)}</button></td>
          <td class="r" data-label="Your price">${money(it.price)}</td>
          <td class="r" data-label="Market">${money(v.market)}<span class="why" style="display:block">${v.n || 0} comp${v.n === 1 ? '' : 's'}</span></td>
          <td class="st">${pill}</td>
          <td class="end"><button class="act" data-sold="${esc(it.id)}" data-price="${it.price ?? ''}">Sold</button><button class="act ghost" data-del="${esc(it.id)}" aria-label="Remove ${esc(it.title)}">Remove</button></td></tr>`;
      }).join('');
      $('costbar').hidden = true;
      $('invtable').innerHTML = `<div class="tablewrap rt pickable"><table><thead><tr><th class="pick"><input type="checkbox" id="c-all" aria-label="Select all"></th><th>Card <span style="font-weight:400">(${items.length.toLocaleString()})</span></th><th class="r">Cost</th><th class="r">Your price</th><th class="r">Market</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
      if (items.some(it => !it.value)) valueAll();
    } catch (err) { if (err.status === 401 || err.status === 402) showLogin(); else $('invtable').innerHTML = `<div class="empty">Could not load: ${esc(err.message)}</div>`; }
  }
  // Costs: tap one to edit it, or tick several and set one cost each or what
  // the whole lot cost (spread by market value, or evenly).
  const picked = () => [...document.querySelectorAll('.c-pick:checked')].map(c => c.value);
  function syncCostBar() { const n = picked().length; $('costbar').hidden = !n; $('c-count').textContent = `${n} selected`; }
  $('invtable').addEventListener('change', (e) => {
    if (e.target.id === 'c-all') document.querySelectorAll('.c-pick').forEach(c => { c.checked = e.target.checked; });
    if (e.target.id === 'c-all' || e.target.classList.contains('c-pick')) syncCostBar();
  });
  $('c-apply').addEventListener('click', async () => {
    const ids = picked(), amt = Number(String($('c-amount').value).replace(/[$,]/g, ''));
    if (!ids.length || !(amt >= 0) || $('c-amount').value === '') { $('invstatus').textContent = 'Enter an amount first.'; return; }
    const lot = $('c-mode').value === 'lot';
    try {
      const r = await api('/api/biz/costs', { method: 'POST', body: JSON.stringify(lot ? { ids, lot: amt } : { ids, each: amt }) });
      $('invstatus').textContent = lot ? `Spread ${money(amt)} across ${r.updated} card${r.updated === 1 ? '' : 's'} ${r.by === 'value' ? 'by market value' : 'evenly (not all had a market price)'}.` : `Set the cost on ${r.updated} card${r.updated === 1 ? '' : 's'}.`;
      $('c-amount').value = ''; loadInventory();
    } catch (err) { $('invstatus').textContent = err.message; }
  });
  $('invtable').addEventListener('click', async (e) => {
    const cb = e.target.closest('[data-cost]');
    if (cb) {
      const v = window.prompt('What did you pay for this card? (leave empty to clear)', cb.dataset.val);
      if (v == null) return;
      try { await api('/api/biz/inventory/' + encodeURIComponent(cb.dataset.cost), { method: 'PATCH', body: JSON.stringify({ cost: v.trim() === '' ? null : Number(v.replace(/[$,]/g, '')) }) }); }
      catch (err) { $('invstatus').textContent = err.message; }
      return loadInventory();
    }
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

  // ---- bulk reprice ----
  const rOpts = () => ({ mode: $('r-mode').value, undercut: Number($('r-cut').value), end99: $('r-99').checked, floor: $('r-floor').checked });
  $('r-preview').addEventListener('click', async () => {
    $('r-plan').innerHTML = '<p class="status">Working out new prices…</p>';
    try {
      const { plan } = await api('/api/biz/reprice', { method: 'POST', body: JSON.stringify(rOpts()) });
      if (!plan.length) { $('r-plan').innerHTML = '<p class="status">Every priced card is already within range of the market. Nothing to change.</p>'; return; }
      const down = plan.filter(p => p.change != null && p.change < 0).length;
      $('r-plan').innerHTML = `<p class="status">${plan.length} card${plan.length === 1 ? '' : 's'} to reprice: ${down} lower, ${plan.length - down} higher. Untick any to leave alone.</p>
        <div class="tablewrap rt pickable"><table><thead><tr><th class="pick"><input type="checkbox" id="r-all" checked aria-label="Select all"></th><th>Card</th><th class="r">Now</th><th class="r">New</th><th class="r">Market</th></tr></thead><tbody>${
        plan.map(p => `<tr><td class="pick"><input type="checkbox" class="r-pick" value="${esc(p.id)}" checked aria-label="Reprice ${esc(p.title)}"></td><td class="w"><b>${esc(p.title)}</b><span class="why">${p.n} comp${p.n === 1 ? '' : 's'}${p.ebayItemId ? ' · eBay' : ''}</span></td>
          <td class="r c1" data-label="Now">${money(p.from)}</td><td class="r ${p.change != null && p.change < 0 ? 'down' : 'up'}" data-label="New">${money(p.to)}</td><td class="r" data-label="Market">${money(p.market)}</td></tr>`).join('')}</tbody></table></div>
        <div class="acts" style="margin-top:12px"><button class="act go" type="button" id="r-apply">Apply to selected</button></div>`;
      $('r-all').addEventListener('change', (e) => document.querySelectorAll('.r-pick').forEach(c => { c.checked = e.target.checked; }));
      $('r-apply').addEventListener('click', applyReprice);
    } catch (err) { $('r-plan').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
  });
  async function applyReprice() {
    const only = [...document.querySelectorAll('.r-pick:checked')].map(c => c.value);
    if (!only.length) return;
    $('r-apply').disabled = true;
    try {
      const r = await api('/api/biz/reprice', { method: 'POST', body: JSON.stringify({ ...rOpts(), apply: true, only }) });
      let html = `<p class="status">Repriced ${r.applied} card${r.applied === 1 ? '' : 's'} here.</p>`;
      if (r.ebayCsv) {
        const url = URL.createObjectURL(new Blob([r.ebayCsv], { type: 'text/csv' }));
        const n = r.plan.filter(p => p.ebayItemId).length;
        html += `<div class="brief"><div class="item warn"><div class="item-main"><span class="tag">One more step for eBay</span><strong>Upload the new prices to eBay</strong>
          <p>${n} of these are eBay listings. Download the file, then in eBay go to Seller Hub &rsaquo; Reports &rsaquo; Uploads &rsaquo; Upload template and choose it. eBay changes all ${n} prices at once; your next sync here picks them up.</p></div>
          <div class="acts"><a class="act go" href="${url}" download="card-huddle-reprice.csv">Download eBay file</a></div></div></div>`;
      }
      $('r-plan').innerHTML = html;
      loadInventory();
    } catch (err) { $('r-apply').disabled = false; alert(err.message); }
  }
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
  const tbl = (title, rows) => `<div class="panel"><h2>${title}</h2>${rows.length ? `<div class="tablewrap flat"><table><thead><tr><th></th><th class="r">Sales</th><th class="r">Revenue</th><th class="r">Profit</th></tr></thead><tbody>${
    rows.map(r => `<tr><td>${esc(r.name)}</td><td class="r">${r.sales}</td><td class="r">${money(r.revenue)}</td><td class="r ${r.profit >= 0 ? 'up' : 'down'}">${r.missingCost === r.sales ? '—' : money(r.profit)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">No sales yet.</p>'}</div>`;
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
      $('endedbox').innerHTML = ended.length ? `<div class="panel" style="margin-bottom:20px"><h2>Gone from eBay: sold or ended?</h2><p class="hint">These left your eBay store since the last sync. Confirm the ones that sold.</p>${
        ended.slice(-50).reverse().map(it => `<div class="endrow">
          <span>${esc(it.title)}</span><input class="mini" data-for="${esc(it.id)}" value="${it.price ?? ''}" inputmode="decimal" aria-label="Sold for">
          <button class="act go" data-endsold="${esc(it.id)}">Sold</button><button class="act ghost" data-endnot="${esc(it.id)}">Didn't sell</button></div>`).join('')}</div>` : '';
      $('salegroups').innerHTML = tbl('By month', r.byMonth) + tbl('By player', r.byPlayer) + tbl('By set', r.bySet) + tbl('By platform', r.byPlatform);
      const day = (d) => { const t = Date.parse(d); return Number.isFinite(t) ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }) : esc(String(d).slice(0, 10)); };
      $('salelist').innerHTML = sold.length ? `<div class="tablewrap rt"><table><thead><tr><th>Card</th><th class="r">Sold for</th><th class="r">Cost</th><th></th></tr></thead><tbody>${
        sold.map(x => `<tr><td class="w"><b>${esc(x.title)}</b><span class="why">${[day(x.soldAt), esc(x.platform || '')].filter(Boolean).join(' · ')}</span></td><td class="r" data-label="Sold for">${money(x.soldFor)}</td><td class="r" data-label="Cost">${money(x.cost)}</td>
          <td class="end"><button class="act ghost" data-undo="${esc(x.id)}">Delete</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No sales recorded yet. Tap Sold on a card in Inventory, or sync eBay to catch sales automatically.</div>';
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

  // ---- shows ----
  $('o-go').addEventListener('click', async () => {
    const cards = $('o-cards').value.split(/\n+/).map(l => l.trim()).filter(Boolean);
    if (!cards.length) { $('o-out').innerHTML = '<p class="status">Type at least one card.</p>'; return; }
    $('o-go').disabled = true; $('o-out').innerHTML = `<p class="status">Pricing ${cards.length} card${cards.length === 1 ? '' : 's'}…</p>`;
    try {
      const r = await api('/api/biz/offer', { method: 'POST', body: JSON.stringify({ cards, pct: Number($('o-pct').value) }) });
      $('o-out').innerHTML = `<div class="kpis" style="grid-template-columns:repeat(2,minmax(0,1fr));margin:0 0 12px">
          <div class="kpi"><small>Market value</small><b>${money(r.market)}</b><em>${r.cards.length} priced</em></div>
          <div class="kpi"><small>Offer at ${r.pct}%</small><b class="up">${money(r.offer)}</b><em>Room to resell</em></div></div>
        ${r.cards.length ? `<div class="tablewrap flat"><table><thead><tr><th>Card</th><th class="r">Market</th><th class="r">Offer</th></tr></thead><tbody>${
          r.cards.map(c => `<tr><td>${esc(c.title)}<div class="why">${esc(c.grade || 'Raw')} · ${c.n} sales</div></td><td class="r">${money(c.market)}</td><td class="r">${money(c.offer)}</td></tr>`).join('')}</tbody></table></div>` : ''}
        ${r.unpriced.length ? `<p class="status">Not enough recent sales to price: ${r.unpriced.map(u => esc(u.title)).join('; ')}. Check these by hand.</p>` : ''}`;
    } catch (err) { $('o-out').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
    $('o-go').disabled = false;
  });
  let showText = '';
  $('s-go').addEventListener('click', async () => {
    try {
      const { cards } = await api(`/api/biz/show?n=${$('s-n').value}&min=${$('s-min').value}`);
      if (!cards.length) { $('s-out').innerHTML = '<p class="status">No priced cards yet. Refresh market prices in Inventory first.</p>'; $('s-copy').hidden = $('s-print').hidden = true; return; }
      showText = cards.map((c, i) => `${i + 1}. ${c.title}${c.grade ? ' ' + c.grade : ''} - ${money(c.price ?? c.market)}${c.trend >= 10 ? ` (up ${c.trend}%)` : ''}`).join('\n');
      $('s-out').innerHTML = `<div class="tablewrap flat"><table><thead><tr><th>#</th><th>Card</th><th class="r">Price</th><th class="r">Market</th></tr></thead><tbody>${
        cards.map((c, i) => `<tr><td class="why">${i + 1}</td><td>${esc(c.title)}${c.grade ? ` <span class="pill">${esc(c.grade)}</span>` : ''}${c.trend >= 10 ? ` <span class="pill ok">up ${c.trend}%</span>` : ''}</td><td class="r">${money(c.price)}</td><td class="r">${money(c.market)}</td></tr>`).join('')}</tbody></table></div>`;
      $('s-copy').hidden = $('s-print').hidden = false;
    } catch (err) { $('s-out').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
  });
  $('s-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(showText); $('s-copy').textContent = 'Copied'; setTimeout(() => { $('s-copy').textContent = 'Copy'; }, 1500); }
    catch (_) { window.prompt('Copy your list:', showText); }
  });
  $('s-print').addEventListener('click', () => window.print());

  // ---- ask ----
  const fmt = (text) => esc(text).split(/\n+/).map(l => /^\s*[-•*]\s+/.test(l) ? `<p>• ${l.replace(/^\s*[-•*]\s+/, '')}</p>` : `<p>${l}</p>`).join('');
  async function compare(q) {
    $('answer').hidden = true; $('comparebox').hidden = false;
    $('comparebox').innerHTML = '<div class="answer"><p style="color:var(--fg3)">Asking both…</p></div>';
    try {
      const r = await api('/api/biz/compare', { method: 'POST', body: JSON.stringify({ q }) });
      const col = (name, x) => `<div class="answer" style="max-width:none"><span class="who">${name}</span>
        <span class="why">${esc(x.model)} · ${(x.ms / 1000).toFixed(1)}s</span>${x.error ? `<p class="err">${esc(x.error)}</p>` : fmt(x.answer || '(no answer)')}</div>`;
      $('comparebox').innerHTML = col('Claude Haiku 5.5', r.anthropic) + col('Cloudflare Workers AI', r.workers);
    } catch (err) { $('comparebox').innerHTML = `<div class="answer"><p class="err">${esc(err.message)}</p></div>`; }
  }
  async function ask(q) {
    if (!q) return;
    if ($('compare').checked) return compare(q);
    $('comparebox').hidden = true;
    $('answer').hidden = false; $('answertext').innerHTML = '<p style="color:var(--fg3)">Reading your inventory…</p>';
    try { const r = await api('/api/biz/ask', { method: 'POST', body: JSON.stringify({ q }) });
      $('answertext').innerHTML = fmt(r.answer); }
    catch (err) { $('answertext').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
  }
  document.querySelectorAll('.q').forEach(b => b.addEventListener('click', () => { $('askq').value = b.textContent; ask(b.textContent); }));
  $('askform').addEventListener('submit', (e) => { e.preventDefault(); ask($('askq').value.trim()); });

  function start(me) {
    $('landing').hidden = true; $('app').hidden = false;
    $('billing').hidden = !(me && me.user && !me.admin);
    $('comparewrap').hidden = !(me && me.admin);
    show('brief');
  }
  gate();
})();
