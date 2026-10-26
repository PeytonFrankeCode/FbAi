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
    // Paused (server.js BIZ_PAUSED): the page says so and still takes
    // waitlist emails; owner sign-in works as before.
    $('pausedbar').hidden = !me.paused;
    $('subscribe').hidden = !(me.user && me.checkoutOpen);
    $('logintosite').hidden = !!me.user || !!me.paused;
    $('gatemsg').textContent = me.paused ? 'Paused for now. Join the list and we will email you when it is back.'
      : !me.user ? 'Log in to your Card Huddle account first, then come back here.'
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
    ['brief', 'inv', 'sales', 'shows'].forEach(n => { $('p-' + n).hidden = n !== name; });
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
    loadUsage();
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
      const extra = [r.sold ? `${r.sold} sold (found in eBay's sold data)` : '', r.relisted ? `${r.relisted} relisted` : '',
        r.ended ? `${r.ended} gone, checking whether they sold` : ''].filter(Boolean).join(', ');
      $('ebaystatus').textContent = `Synced ${r.listings} listings from ${r.seller}: ${r.added} new, ${r.updated} updated${extra ? ', ' + extra : ''}.`;
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

  // ---- Add cards from photos (owner, Oct 2026): up to 40 at once ----
  // Each photo is shrunk here first (1280px, JPEG), which is quicker to send and
  // costs the AI less, then read four at a time (/api/biz/identify) so the rows
  // fill in as they finish. Nothing is added until the seller has looked: every
  // row is editable, and only the ticked ones go in.
  const PH_MAX = 40, PH_AT_ONCE = 4;
  let phRows = [];
  // 1568px: the most detail the AI takes in (larger is scaled down there),
  // which a photo of a binder page or a table of cards needs.
  async function shrinkPhoto(file, max = 1568) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.82);
    } finally { URL.revokeObjectURL(url); }
  }
  const CONF = { high: ['ok', 'Sure'], medium: ['warn', 'Check it'], low: ['bad', 'Unsure'] };
  function phPaint(r) {
    const el = r.el;
    el.className = 'ph-row' + (r.state === 'reading' || r.state === 'wait' ? ' reading' : '') + (r.state === 'failed' ? ' failed' : '');
    const meta = el.querySelector('.ph-meta');
    if (r.state === 'wait') meta.innerHTML = 'Waiting…';
    else if (r.state === 'reading') meta.innerHTML = '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span> Reading the card…';
    else if (r.state === 'failed') meta.innerHTML = `<span class="err">${esc(r.error)}</span>`;
    else {
      const [cls, word] = CONF[r.confidence] || CONF.medium;
      const v = r.value || {};
      meta.innerHTML = `<span class="pill ${cls}">${word}</span>`
        + (v.market != null ? `<span>Sells for about <b>${money(v.market)}</b> (${v.n} sales)</span>` : '<span>No recent sales to price it</span>')
        + (r.note ? `<span>${esc(r.note)}</span>` : '');
    }
  }
  function phCount() {
    const n = phRows.filter(r => r.state === 'done' && r.el.querySelector('.ph-pick').checked).length;
    const busy = phRows.filter(r => r.state === 'wait' || r.state === 'reading').length;
    $('ph-acts').hidden = !phRows.length;
    $('ph-add').textContent = `Add ${n} card${n === 1 ? '' : 's'}`;
    $('ph-add').disabled = !n;
    $('ph-ebay').disabled = !n;
    const photos = new Set(phRows.map(r => r.photo)).size;
    const cards = phRows.filter(r => r.state === 'done').length;
    $('ph-status').textContent = !phRows.length ? '' : busy
      ? `Reading ${photos - busy} of ${photos} photo${photos === 1 ? '' : 's'}… ${cards} card${cards === 1 ? '' : 's'} found so far.`
      : `${cards} card${cards === 1 ? '' : 's'} found in ${photos} photo${photos === 1 ? '' : 's'}. Check each one, then add.`;
  }
  // One card cut out of a photo of several, by the outline the AI gave
  // (fractions of the photo), with a little margin: the row's thumbnail and,
  // when listed, its eBay picture.
  async function cropCard(file, box, max = 900) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
      const W = img.naturalWidth, H = img.naturalHeight, pad = 0.03;
      const x = Math.max(0, (box.x - pad) * W), y = Math.max(0, (box.y - pad) * H);
      const w = Math.min(W - x, (box.w + 2 * pad) * W), h = Math.min(H - y, (box.h + 2 * pad) * H);
      if (!(w > 8 && h > 8)) return null;
      const k = Math.min(1, max / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.86);
    } catch (_) { return null; } finally { URL.revokeObjectURL(url); }
  }
  function phRowEl(thumb) {
    const el = document.createElement('div');
    el.innerHTML = `<input type="checkbox" class="ph-pick" aria-label="Add this card"><img src="${thumb}" alt="">
      <div class="ph-fields"><input class="ph-title" aria-label="Card" placeholder="Card title">
        <input class="ph-grade" aria-label="Grade" placeholder="Raw or PSA 10"><input class="ph-price" inputmode="decimal" aria-label="Your price" placeholder="$ price">
        <div class="ph-meta"></div></div>`;
    el.querySelector('.ph-pick').addEventListener('change', phCount);
    return el;
  }
  function phFill(r, c, value) {
    r.state = 'done'; r.confidence = c.confidence; r.note = c.note; r.value = value; r.card = c;
    const f = (k) => r.el.querySelector('.ph-' + k);
    f('title').value = c.title || '';
    f('grade').value = c.grade || '';
    if (value && value.market != null) f('price').value = value.market;
    f('pick').checked = !!c.title && c.confidence !== 'low';
  }
  async function phWork() {
    for (;;) {
      const r = phRows.find(x => x.state === 'wait');
      if (!r) return;
      r.state = 'reading'; phPaint(r); phCount();
      try {
        const out = await api('/api/biz/identify', { method: 'POST', body: JSON.stringify({ image: await shrinkPhoto(r.file) }) });
        const found = Array.isArray(out.cards) && out.cards.length ? out.cards : [{ card: out.card || {}, value: out.value }];
        if (found.length === 1) { phFill(r, found[0].card || {}, found[0].value); r.photoUrl = out.photoUrl || null; }
        else {
          // Several cards: this row becomes the first, the rest go in after it,
          // each with its own picture cut from the photo.
          let after = r.el;
          for (let i = 0; i < found.length; i++) {
            const c = found[i].card || {};
            const crop = c.box ? await cropCard(r.file, c.box) : null;
            let row = r;
            if (i === 0) { if (crop) r.el.querySelector('img').src = crop; r.crop = crop; }
            else {
              row = { file: r.file, el: phRowEl(crop || r.thumb), thumb: null, crop, state: 'done', photo: r.photo };
              after.after(row.el); after = row.el;
              phRows.splice(phRows.indexOf(r) + i, 0, row);
            }
            phFill(row, c, found[i].value); phPaint(row);
          }
        }
      } catch (err) { r.state = 'failed'; r.error = err.message; }
      phPaint(r); phCount(); loadUsage();
    }
  }
  $('ph-files').addEventListener('change', () => {
    const files = [...$('ph-files').files].filter(f => /^image\//.test(f.type));
    $('ph-files').value = '';
    const photos = new Set(phRows.map(r => r.photo)).size;
    const room = PH_MAX - photos;
    if (!room) { $('ph-status').textContent = `That's ${PH_MAX} photos. Add these first, then choose more.`; return; }
    for (const file of files.slice(0, room)) {
      const thumb = URL.createObjectURL(file);
      const el = phRowEl(thumb);
      $('ph-list').appendChild(el);
      const r = { file, el, thumb, state: 'wait', photo: file.name + ':' + file.size + ':' + Math.random() };
      phRows.push(r); phPaint(r);
    }
    if (files.length > room) $('ph-status').textContent = `Only the first ${room} were taken: ${PH_MAX} photos at a time.`;
    phCount();
    for (let i = 0; i < PH_AT_ONCE; i++) phWork();
  });
  function phClear() {
    phRows.forEach(r => { if (r.thumb) URL.revokeObjectURL(r.thumb); });
    phRows = []; $('ph-list').innerHTML = ''; $('ph-ebay-out').hidden = true; phCount();
  }
  $('ph-clear').addEventListener('click', phClear);
  $('ph-add').addEventListener('click', async () => {
    const take = phRows.filter(r => r.state === 'done' && r.el.querySelector('.ph-pick').checked);
    const items = take.map(r => ({ title: r.el.querySelector('.ph-title').value.trim(), grade: r.el.querySelector('.ph-grade').value.trim(),
      price: r.el.querySelector('.ph-price').value, platform: $('ph-platform').value })).filter(x => x.title);
    if (!items.length) return;
    $('ph-add').disabled = true;
    try {
      await api('/api/biz/inventory', { method: 'POST', body: JSON.stringify({ items }) });
      phRows = phRows.filter(r => !take.includes(r));
      take.forEach(r => { if (r.thumb && !phRows.some(x => x.thumb === r.thumb)) URL.revokeObjectURL(r.thumb); r.el.remove(); });
      phCount();
      $('invstatus').textContent = `Added ${items.length} card${items.length === 1 ? '' : 's'} from photos.`;
      loadInventory();
    } catch (err) { $('ph-status').textContent = err.message; phCount(); }
  });

  // AI usage today (owner, Oct 2026): cards read from photos and questions
  // asked, against the daily limits, as bars on Today and a line where each
  // is used. The owner's account has no limit and is shown as such.
  function usageWhen(iso) { const h = Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 36e5)); return `resets in ${h} hour${h === 1 ? '' : 's'}`; }
  function usageBar(label, x, unlimited) {
    const pct = unlimited ? 0 : Math.min(100, Math.round(100 * x.used / Math.max(1, x.limit)));
    return `<div class="ubar"><div class="ubar-top"><span>${label}</span><b>${unlimited ? `${x.used} today` : `${x.used} of ${x.limit}`}</b></div>
      <div class="ubar-track" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="${x.limit}" aria-valuenow="${x.used}"><i class="${pct >= 90 ? 'full' : pct >= 70 ? 'warn' : ''}" style="width:${unlimited ? Math.min(100, x.used) : pct}%"></i></div></div>`;
  }
  async function loadUsage() {
    let u; try { u = await api('/api/biz/usage'); } catch (_) { return; }
    const when = usageWhen(u.resetsAt);
    $('usagebox').hidden = false;
    $('usagebox').innerHTML = `<h2>AI usage today</h2>${usageBar('Cards read from photos', u.cards, u.unlimited)}${usageBar('Questions asked', u.asks, u.unlimited)}
      <p class="hint" style="margin:0">${u.unlimited ? 'Owner account: no daily limit.' : `Limits ${when.replace('resets', 'reset')} (midnight UTC).`}</p>`;
    $('ph-usage').textContent = u.unlimited ? `${u.cards.used} cards read today (no limit on the owner account).`
      : `${u.cards.used} of ${u.cards.limit} cards read today, ${when}.`;
    $('ai-usage').textContent = u.unlimited ? `${u.asks.used} questions today` : `${u.asks.used} of ${u.asks.limit} questions today, ${when}`;
  }

  // The eBay listing file (owner, Oct 2026): the ticked cards, as read and as
  // edited here, in eBay's bulk upload format (/api/biz/ebay-listings). The
  // seller's ZIP and eBay policy names are kept on this device.
  const EBAY_DEFAULTS_KEY = 'bizEbayListing';
  const ebayDefaults = () => { try { return JSON.parse(localStorage.getItem(EBAY_DEFAULTS_KEY) || '{}'); } catch (_) { return {}; } };
  (() => {
    const d = ebayDefaults();
    for (const k of ['zip', 'shipping', 'returns', 'payment', 'condition']) {
      const el = $('pe-' + k); if (!el) continue;
      if (d[k]) el.value = d[k];
      el.addEventListener('change', () => {
        const next = ebayDefaults(); next[k] = el.value.trim();
        try { localStorage.setItem(EBAY_DEFAULTS_KEY, JSON.stringify(next)); } catch (_) { /* private mode: asked again next time */ }
      });
    }
  })();
  $('ph-ebay').addEventListener('click', async () => {
    const take = phRows.filter(r => r.state === 'done' && r.el.querySelector('.ph-pick').checked);
    const cards = take.map(r => {
      const c = r.card || {};
      return { title: r.el.querySelector('.ph-title').value.trim(), grade: r.el.querySelector('.ph-grade').value.trim(),
        price: r.el.querySelector('.ph-price').value, player: c.player, year: c.year, set: c.set, cardNumber: c.cardNumber,
        parallel: c.parallel, printRun: c.printRun, auto: c.auto, rookie: c.rookie, sport: c.sport, cert: c.cert, photoUrl: r.photoUrl };
    });
    const out = $('ph-ebay-out');
    if (!cards.length) { out.hidden = false; out.textContent = 'Tick at least one card that has been read.'; return; }
    $('ph-ebay').disabled = true;
    $('ph-ebay').textContent = 'Making the file…';
    out.hidden = false; out.textContent = 'Making the eBay file…';
    let msg, file = null;
    try {
      // A card cut from a photo of several gets its own picture stored now,
      // four at a time, so its listing shows that card alone.
      const need = take.map((r, i) => [r, i]).filter(([r]) => !r.photoUrl && r.crop);
      if (need.length) $('ph-status').textContent = `Saving ${need.length} card picture${need.length === 1 ? '' : 's'} for eBay…`;
      let at = 0;
      await Promise.all(Array.from({ length: Math.min(4, need.length) }, async () => {
        for (let j = at++; j < need.length; j = at++) {
          const [r, i] = need[j];
          try { r.photoUrl = (await api('/api/biz/photo', { method: 'POST', body: JSON.stringify({ image: r.crop }) })).photoUrl; cards[i].photoUrl = r.photoUrl; }
          catch (_) { /* listed without a picture */ }
        }
      }));
      const d = ebayDefaults();
      const res = await api('/api/biz/ebay-listings', { method: 'POST', body: JSON.stringify({ cards, defaults: d }) });
      if (res.listed) {
        file = new File([res.csv], `ebay-listings-${new Date().toISOString().slice(0, 10)}.csv`, { type: 'text/csv' });
        // Elsewhere the file saves at once. An iPhone ignores a download that
        // does not come straight from a tap, and the pictures and the file
        // took a while, so there it waits for the Save button below.
        if (!IS_IOS) saveFile(file);
      }
      const why = res.skipped.length ? ` Left out ${res.skipped.length}: ${res.skipped.slice(0, 3).map(x => `${x.title || 'a card'} (${x.why})`).join('; ')}.` : '';
      const missing = !d.zip ? ' Add your ZIP and eBay policies under eBay listing settings so the upload goes through.' : '';
      msg = res.listed
        ? `${IS_IOS ? 'Ready' : 'Downloaded'}: ${res.listed} listing${res.listed === 1 ? '' : 's'}. Upload the file in eBay: Seller Hub, Reports, Uploads (steps below, under "How to list these on eBay").${why}${missing}`
        : `Nothing to list.${why}`;
    } catch (err) { msg = `Could not make the file: ${err.message}`; }
    phCount();
    $('ph-ebay').textContent = 'Download eBay listing file';
    // Shown by the button, where it was tapped: the status line sits above
    // the list and is off screen after scrolling down a long one.
    out.textContent = msg;
    if (file) {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'act go', textContent: IS_IOS ? `Save ${file.name}` : 'Download again' });
      b.addEventListener('click', () => saveFile(file));
      out.appendChild(b);
    }
  });
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // On a phone the share sheet saves to Files (or AirDrops to a computer),
  // which works in Safari and from the home-screen app alike; a blob link,
  // the usual way, does nothing in the home-screen app.
  async function saveFile(file) {
    if (IS_IOS && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: file.name }); return; }
      catch (err) { if (err && err.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(file);
    const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

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
      // A sale reaches eBay's sold data within a day or two and is recorded
      // by itself; one still missing after 3 days most likely ended unsold.
      const waitDays = (it) => (Date.now() - Date.parse(it.endedAt || 0)) / 864e5;
      $('endedbox').innerHTML = ended.length ? `<div class="panel" style="margin-bottom:20px"><h2>Gone from eBay: sold or ended?</h2><p class="hint">These left your eBay store. Ones that sold are found in eBay's sold data and move to your sales by themselves, usually within a day or two. Relisted cards go back to inventory.</p>${
        ended.slice(-50).reverse().map(it => `<div class="endrow">
          <span>${esc(it.title)}<span class="why" style="display:block">${waitDays(it) < 3
            ? '<span class="pill">Checking</span> No sale found yet. Sales show up within a day or two.'
            : '<span class="pill warn">Likely unsold</span> No sale found in 3 days, so it most likely ended without selling.'}</span></span><input class="mini" data-for="${esc(it.id)}" value="${it.price ?? ''}" inputmode="decimal" aria-label="Sold for">
          <button class="act go" data-endsold="${esc(it.id)}">Sold</button><button class="act ghost" data-endnot="${esc(it.id)}">Didn't sell</button></div>`).join('')}</div>` : '';
      $('salegroups').innerHTML = tbl('By month', r.byMonth) + tbl('By player', r.byPlayer) + tbl('By set', r.bySet) + tbl('By platform', r.byPlatform);
      const day = (d) => { const t = Date.parse(d); return Number.isFinite(t) ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }) : esc(String(d).slice(0, 10)); };
      $('salelist').innerHTML = sold.length ? `<div class="tablewrap rt"><table><thead><tr><th>Card</th><th class="r">Sold for</th><th class="r">Cost</th><th></th></tr></thead><tbody>${
        sold.map(x => `<tr><td class="w"><b>${esc(x.title)}</b><span class="why">${[day(x.soldAt), esc(x.platform || ''), x.foundSold ? 'Found in eBay sold data' : '', x.bestOffer ? 'Best offer' : ''].filter(Boolean).join(' · ')}</span></td><td class="r" data-label="Sold for">${money(x.soldFor)}</td><td class="r" data-label="Cost">${money(x.cost)}</td>
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
  // The buy offer (owner, Oct 2026): each card at the chosen share of its
  // market, unless both sides agreed a price for it, which is then what is
  // paid. An agreed price typed in the table is written onto the card's line
  // ("= 45"), so pricing again keeps it.
  let offer = null;
  const offerLines = () => $('o-cards').value.split('\n');
  function offerPaint() {
    const r = offer; if (!r) return;
    const rows = r.rows;
    const pay = Math.round(100 * rows.reduce((a, c) => a + (c.agreed != null ? c.agreed : (c.offer || 0)), 0)) / 100;
    const nAgreed = rows.filter(c => c.agreed != null).length;
    $('o-out').innerHTML = `<div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr));margin:0 0 12px">
        <div class="kpi"><small>Market value</small><b>${money(r.market)}</b><em>${r.cards.filter(c => c.market != null).length} priced</em></div>
        <div class="kpi"><small>Offer at ${r.pct}%</small><b>${money(r.offer)}</b><em>Room to resell</em></div>
        <div class="kpi"><small>You pay</small><b class="up" id="o-pay">${money(pay)}</b><em>${nAgreed ? `${nAgreed} at an agreed price` : `At ${r.pct}%`}</em></div></div>
      <div class="tablewrap flat"><table><thead><tr><th>Card</th><th class="r">Market</th><th class="r">Offer</th><th class="r">Agreed</th></tr></thead><tbody>${
        rows.map((c, i) => `<tr><td>${esc(c.title)}<div class="why">${esc(c.grade || 'Raw')} · ${c.market != null ? `${c.n} sales` : 'not enough sales to price'}</div></td>
          <td class="r" data-label="Market">${c.market != null ? money(c.market) : '-'}</td>
          <td class="r${c.agreed != null ? ' o-paid' : ''}" data-label="Offer">${c.offer != null ? money(c.offer) : '-'}</td>
          <td class="r" data-label="Agreed"><input class="o-agreed" type="number" inputmode="decimal" min="0" step="0.01" data-i="${i}" aria-label="Agreed price for ${esc(c.title)}" placeholder="${c.offer != null ? c.offer : '$'}" value="${c.agreed != null ? c.agreed : ''}"></td></tr>`).join('')}</tbody></table></div>
      ${rows.some(c => c.market == null) ? `<p class="status">Not enough recent sales to price ${rows.filter(c => c.market == null).length === 1 ? 'one card' : rows.filter(c => c.market == null).length + ' cards'}. Check by hand, and type what you agree in its Agreed box.</p>` : ''}`;
  }
  $('o-out').addEventListener('change', (e) => {
    const el = e.target.closest('.o-agreed'); if (!el || !offer) return;
    const c = offer.rows[Number(el.dataset.i)]; if (!c) return;
    const v = el.value.trim() === '' ? null : Math.max(0, Math.round(100 * Number(el.value)) / 100);
    c.agreed = Number.isFinite(v) ? v : null;
    // Back onto its line in the box, by its place among the non-blank lines.
    const lines = offerLines(), at = lines.map((l, i) => (l.trim() ? i : -1)).filter(i => i >= 0)[c.line];
    if (at != null) {
      const base = lines[at].replace(/\s*=\s*\$?\s*\d[\d,]*(?:\.\d{1,2})?\s*$/, '');
      lines[at] = c.agreed != null ? `${base} = ${c.agreed}` : base;
      $('o-cards').value = lines.join('\n');
    }
    offerPaint();
  });
  async function priceOffer() {
    const cards = offerLines().map(l => l.trim()).filter(Boolean);
    if (!cards.length) { $('o-out').innerHTML = '<p class="status">Type at least one card, or add them from photos.</p>'; return; }
    $('o-go').disabled = true; $('o-out').innerHTML = `<p class="status">Pricing ${cards.length} card${cards.length === 1 ? '' : 's'}…</p>`;
    try {
      offer = await api('/api/biz/offer', { method: 'POST', body: JSON.stringify({ cards, pct: Number($('o-pct').value) }) });
      offer.rows = offer.cards.concat(offer.unpriced.map(u => ({ ...u, market: null, offer: null, agreed: null })));
      offerPaint();
    } catch (err) { $('o-out').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
    $('o-go').disabled = false;
  }
  $('o-go').addEventListener('click', priceOffer);
  // Photos into the box: each card the AI reads goes in as a line (title and
  // grade), then the whole box is priced as if typed.
  $('o-files').addEventListener('change', async () => {
    const files = [...$('o-files').files].slice(0, PH_MAX); $('o-files').value = '';
    if (!files.length) return;
    let added = 0, unsure = 0, failed = '';
    for (let i = 0; i < files.length; i++) {
      $('o-status').textContent = `Reading photo ${i + 1} of ${files.length}… ${added} card${added === 1 ? '' : 's'} so far.`;
      try {
        const out = await api('/api/biz/identify', { method: 'POST', body: JSON.stringify({ image: await shrinkPhoto(files[i]) }) });
        const found = Array.isArray(out.cards) && out.cards.length ? out.cards : [{ card: out.card || {} }];
        const lines = offerLines().filter(l => l.trim());
        for (const f of found) {
          const c = f.card || {};
          if (!c.title) continue;
          const g = c.grade && !c.title.toLowerCase().includes(String(c.grade).toLowerCase()) ? ' ' + c.grade : '';
          lines.push(c.title + g); added++;
          if (c.confidence === 'low') unsure++;
        }
        $('o-cards').value = lines.join('\n');
      } catch (err) { failed = err.message; }
    }
    loadUsage();
    $('o-status').textContent = (added ? `Added ${added} card${added === 1 ? '' : 's'} from ${files.length} photo${files.length === 1 ? '' : 's'}.` : 'No cards read from the photos.')
      + (unsure ? ` ${unsure} the AI was unsure of: check those lines.` : '') + (failed ? ` ${failed}` : '');
    if (added) priceOffer();
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

  // ---- ask: a chat bubble in the corner ----
  // Opens from any tab. While the AI works, a thinking bubble waves its dots
  // and says what it is doing, so a slow answer never looks frozen.
  // An answer, made easy to read: a lead sentence, then a list whose labels
  // are bold, with dollar figures picked out. Takes the light markdown the AI
  // writes (**bold**, "- " or "1." lists, "#" headings) and nothing else; all
  // text is escaped first.
  function fmt(text) {
    const inline = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1$2')
      .replace(/`([^`]+)`/g, '$1').replace(/(−?\$(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)/g, '<span class="amt">$1</span>');
    const label = (s) => /^<b>/.test(s) ? s : s.replace(/^([^:<]{1,28}):\s+/, (m, l) => l.trim().split(/\s+/).length <= 4 ? `<b>${l}:</b> ` : m);
    let html = '', list = null;
    const close = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const raw of String(text || '').split(/\n+/)) {
      const l = raw.trim(); if (!l) continue;
      const ul = /^[-•*]\s+(.*)$/.exec(l), ol = /^\d+[.)]\s+(.*)$/.exec(l), h = /^#{1,6}\s+(.*)$/.exec(l);
      if (ul || ol) {
        const tag = ul ? 'ul' : 'ol';
        if (list !== tag) { close(); html += `<${tag}>`; list = tag; }
        html += `<li>${label(inline((ul || ol)[1]))}</li>`;
      } else { close(); html += h ? `<p class="aih">${inline(h[1].replace(/\*\*/g, ''))}</p>` : `<p>${inline(l)}</p>`; }
    }
    close();
    return html || '<p>(no answer)</p>';
  }
  // The type-out: the answer takes its full size at once (so nothing jumps),
  // then its words fade in, in order, over a second or two. A tap shows it all.
  function typeOut(el) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const words = [];
    const walk = (n) => {
      for (const c of [...n.childNodes]) {
        if (c.nodeType === 3) {
          const frag = document.createDocumentFragment();
          for (const part of c.textContent.split(/(\s+)/)) {
            if (!part) continue;
            if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); continue; }
            const w = document.createElement('span'); w.className = 'tw'; w.textContent = part; words.push(w); frag.appendChild(w);
          }
          c.replaceWith(frag);
        } else if (c.nodeType === 1) walk(c);
      }
    };
    walk(el);
    if (!words.length) return;
    const per = Math.max(12, Math.min(38, 2200 / words.length));
    const t0 = performance.now();
    let shown = 0;
    el.classList.add('typing');
    const finish = () => { el.querySelectorAll('.tw, li').forEach(w => w.classList.add('on')); shown = words.length; };
    el.addEventListener('click', finish, { once: true });
    (function step(now) {
      const want = Math.min(words.length, Math.floor((now - t0) / per) + 1);
      while (shown < want) { const w = words[shown++]; w.classList.add('on'); const li = w.closest('li'); if (li) li.classList.add('on'); }
      if (shown < words.length) requestAnimationFrame(step);
    })(t0);
  }
  const THINKING = ['Reading your inventory…', 'Checking real sold prices…', 'Looking at your sales…', 'Writing it up…'];
  let busy = false;
  function openAsk() {
    const p = $('aipanel');
    p.classList.remove('closing'); p.hidden = false; p.classList.add('open');
    $('aifab').setAttribute('aria-expanded', 'true');
    setTimeout(() => $('askq').focus(), 60);
  }
  function closeAsk() {
    const p = $('aipanel'); if (p.hidden) return;
    p.classList.remove('open'); p.classList.add('closing');
    $('aifab').setAttribute('aria-expanded', 'false');
    setTimeout(() => { if (p.classList.contains('closing')) { p.hidden = true; p.classList.remove('closing'); } }, 160);
  }
  $('aifab').addEventListener('click', openAsk);
  $('aiclose').addEventListener('click', () => { closeAsk(); $('aifab').focus(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('aipanel').hidden) { closeAsk(); $('aifab').focus(); } });
  function bubble(who, html) {
    const m = document.createElement('div');
    m.className = 'aimsg ' + who;
    m.innerHTML = `<div class="aibubble">${html}</div>`;
    const th = $('aithread');
    th.appendChild(m);
    // Show the new message from its top: a long answer starts where it starts.
    th.scrollTop = Math.min(th.scrollHeight - th.clientHeight, m.offsetTop - 12);
    return m;
  }
  const answer = (html) => { const m = bubble('ai answer', html); typeOut(m.querySelector('.aibubble')); return m; };
  function thinking() {
    const m = bubble('ai thinking', `<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="thinkline">${THINKING[0]}</span>`);
    m.setAttribute('aria-label', 'Thinking');
    const line = m.querySelector('.thinkline');
    let n = 0;
    const t = setInterval(() => {
      if (n >= THINKING.length - 1) return clearInterval(t);
      line.classList.add('swap');
      setTimeout(() => { line.textContent = THINKING[++n]; line.classList.remove('swap'); }, 250);
    }, 1800);
    return () => { clearInterval(t); m.remove(); };
  }
  async function ask(q) {
    if (!q || busy) return;
    busy = true; $('asksend').disabled = true; $('aifab').classList.add('busy');
    $('askq').value = '';
    const qs = $('aiqs'); if (qs) qs.remove();
    bubble('me', `<p>${esc(q)}</p>`);
    const done = thinking();
    try {
      const r = await api('/api/biz/ask', { method: 'POST', body: JSON.stringify({ q }) });
      done(); answer(fmt(r.answer));
    } catch (err) { done(); bubble('ai', `<p class="err">${esc(err.message)}</p>`); }
    busy = false; $('asksend').disabled = false; $('aifab').classList.remove('busy');
    loadUsage();
    if (!$('aipanel').hidden) $('askq').focus();
  }
  document.querySelectorAll('.q').forEach(b => b.addEventListener('click', () => ask(b.textContent)));
  $('askform').addEventListener('submit', (e) => { e.preventDefault(); ask($('askq').value.trim()); });

  function start(me) {
    $('landing').hidden = true; $('app').hidden = false;
    $('billing').hidden = !(me && me.user && !me.admin);
    show('brief');
  }
  gate();
})();
