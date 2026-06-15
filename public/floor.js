/* =====================================================================
   The Floor — a walkable card-show world.

   You create a collector (name + avatar), then walk around a virtual
   show floor made of booths. Each booth is someone's showcase. Walk up
   to a booth and open it to buy (hands off to eBay) or trade (hands off
   to Veriswap). The Card Huddle is never part of the transaction — every
   deal leaves to the third party.

   This first version is single-player explorable: your own booth is real
   (pulled from your Showcase in the Sell tab) and the other collectors
   are demo booths so the floor feels alive. Live multiplayer (seeing
   real people move in real time) is the next phase and would layer on a
   Cloudflare Durable Object + WebSockets — the world/booth model here is
   built so that can slot in without a rewrite.

   Relies on globals from app.js: escHtml, epnUrl, getShowcase,
   getShowcaseSettings, schedulePushUserData.
   ===================================================================== */
(function () {
  'use strict';

  const CHAR_KEY = 'cardHuddleCharacter';
  const AVATAR_COLORS = ['#5ece99', '#f59e0b', '#ef4444', '#6366f1', '#ec4899', '#06b6d4', '#a855f7', '#84cc16'];
  const AVATAR_EMOJIS = ['🧢', '😎', '🤠', '🦸', '🤖', '👽', '🧑‍🎤', '🐉'];

  const WORLD_W = 960, WORLD_H = 600;
  const PLAYER_R = 14, PLAYER_SPEED = 2.7;
  const BOOTH_W = 120, BOOTH_H = 72;
  const INTERACT_PAD = 34; // how close you must be to a booth to open it

  let canvas, ctx;
  let rafId = null;
  let running = false;
  let world = null;            // { booths, npcs }
  let player = { x: WORLD_W / 2, y: WORLD_H - 70 };
  let nearBooth = null;
  let ccDraft = { color: AVATAR_COLORS[0], emoji: AVATAR_EMOJIS[0] };
  const keys = Object.create(null);
  const touchDir = { up: false, down: false, left: false, right: false };

  // ---- character persistence ----
  function getCharacter() {
    try { return JSON.parse(localStorage.getItem(CHAR_KEY) || 'null'); }
    catch { return null; }
  }
  function saveCharacter(c) {
    localStorage.setItem(CHAR_KEY, JSON.stringify(c));
    if (typeof schedulePushUserData === 'function') schedulePushUserData();
  }

  // ---- handoff links (third-party: eBay for buys, Veriswap for trades) ----
  function floorEbayLink(entry) {
    const url = (entry.ebayUrl || '').trim();
    if (url) return epnUrl(/^https?:\/\//i.test(url) ? url : 'https://' + url);
    return epnUrl('https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(entry.title || ''));
  }
  function floorTradeLink(entry, boothVeriswap) {
    const v = ((entry.veriswapUrl || '').trim() || (boothVeriswap || '')).trim();
    if (!v) return 'https://veriswap.com';
    if (/^https?:\/\//i.test(v)) return v;
    if (v.startsWith('@')) return 'https://veriswap.com/' + encodeURIComponent(v.slice(1));
    if (v.includes('.') || v.includes('/')) return 'https://' + v.replace(/^\/+/, '');
    return 'https://veriswap.com/' + encodeURIComponent(v);
  }

  // ---- demo collectors so the floor isn't empty before real multiplayer ----
  function demoBooths() {
    return [
      { owner: 'PrizmPete', emoji: '😎', color: '#f59e0b', veriswap: 'prizmpete', cards: [
        { title: '2020 Prizm Justin Herbert Silver RC PSA 10', price: 220, status: 'both', note: 'Open to offers', veriswapUrl: 'prizmpete' },
        { title: '2018 Prizm Josh Allen Base RC', price: 45, status: 'sale' },
        { title: '2023 Prizm CJ Stroud Blue /199', price: 90, status: 'trade', veriswapUrl: 'prizmpete' },
      ] },
      { owner: 'RookieRae', emoji: '🤠', color: '#ec4899', veriswap: 'rookierae', cards: [
        { title: '2017 Prizm Patrick Mahomes Base RC', price: 160, status: 'sale' },
        { title: '2021 Mosaic Ja\'Marr Chase Reactive Orange RC', price: 55, status: 'both', veriswapUrl: 'rookierae' },
      ] },
      { owner: 'VintageVic', emoji: '🦸', color: '#6366f1', veriswap: 'vintagevic', cards: [
        { title: '1986 Fleer Michael Jordan #57 PSA 8', price: 3200, status: 'trade', veriswapUrl: 'vintagevic' },
        { title: '1989 Upper Deck Ken Griffey Jr. RC PSA 9', price: 140, status: 'sale' },
        { title: '1955 Topps Roberto Clemente RC', price: 1800, status: 'both', veriswapUrl: 'vintagevic' },
      ] },
      { owner: 'HoopsHana', emoji: '🧢', color: '#06b6d4', veriswap: 'hoopshana', cards: [
        { title: '2018 Prizm Luka Doncic Silver RC PSA 10', price: 900, status: 'both', veriswapUrl: 'hoopshana' },
        { title: '2019 Prizm Zion Williamson Base RC', price: 60, status: 'sale' },
      ] },
      { owner: 'PatchPaul', emoji: '🧑‍🎤', color: '#a855f7', veriswap: 'patchpaul', cards: [
        { title: '2023 National Treasures Bryce Young RPA /99', price: 650, status: 'trade', veriswapUrl: 'patchpaul' },
        { title: '2022 Flawless Patrick Mahomes Patch /25', price: 1200, status: 'both', veriswapUrl: 'patchpaul' },
      ] },
      { owner: 'ChromeChloe', emoji: '🐉', color: '#84cc16', veriswap: 'chromechloe', cards: [
        { title: '2011 Topps Update Mike Trout RC PSA 10', price: 1100, status: 'sale' },
        { title: '2019 Bowman Chrome Wander Franco Auto', price: 130, status: 'both', veriswapUrl: 'chromechloe' },
        { title: '2023 Bowman Chrome Jackson Holliday Auto /499', price: 200, status: 'trade', veriswapUrl: 'chromechloe' },
      ] },
      { owner: 'SlabSam', emoji: '🤖', color: '#ef4444', veriswap: 'slabsam', cards: [
        { title: '2003 Topps Chrome LeBron James RC PSA 9', price: 2400, status: 'both', veriswapUrl: 'slabsam' },
      ] },
    ];
  }

  // Lay booths out in two rows; booth 0 is always YOU.
  function buildWorld() {
    const me = getCharacter() || { name: 'You', color: AVATAR_COLORS[0], emoji: AVATAR_EMOJIS[0] };
    const settings = (typeof getShowcaseSettings === 'function') ? getShowcaseSettings() : {};
    const yours = {
      owner: me.name || 'You', emoji: me.emoji, color: me.color, isYou: true,
      veriswap: settings.veriswap || '',
      cards: (typeof getShowcase === 'function') ? getShowcase() : [],
    };
    const all = [yours, ...demoBooths()];

    const cols = [60, 290, 520, 750];
    const rows = [120, 400];
    const booths = all.slice(0, cols.length * rows.length).map((b, i) => {
      const x = cols[i % cols.length];
      const y = rows[Math.floor(i / cols.length)];
      return Object.assign({ id: i, x, y, w: BOOTH_W, h: BOOTH_H }, b);
    });

    // A few wandering collectors to give the floor some life.
    const npcs = [
      { name: 'Browser1', emoji: '😀', color: '#38bdf8' },
      { name: 'Browser2', emoji: '🥳', color: '#fbbf24' },
      { name: 'Browser3', emoji: '🤓', color: '#f472b6' },
    ].map(n => Object.assign({
      x: 120 + Math.random() * (WORLD_W - 240),
      y: 250 + Math.random() * 100,
      tx: 0, ty: 0, repick: 0,
    }, n));

    world = { booths, npcs };
    player.x = WORLD_W / 2;
    player.y = WORLD_H - 60;
    nearBooth = null;
  }

  function boothBlocks(b, px, py) {
    return px > b.x - PLAYER_R && px < b.x + b.w + PLAYER_R &&
           py > b.y - PLAYER_R && py < b.y + b.h + PLAYER_R;
  }
  function blockedAt(px, py) {
    if (px < PLAYER_R || px > WORLD_W - PLAYER_R || py < PLAYER_R || py > WORLD_H - PLAYER_R) return true;
    return world.booths.some(b => boothBlocks(b, px, py));
  }

  function nearestBooth() {
    let best = null, bestD = Infinity;
    for (const b of world.booths) {
      const cx = Math.max(b.x, Math.min(player.x, b.x + b.w));
      const cy = Math.max(b.y, Math.min(player.y, b.y + b.h));
      const d = Math.hypot(player.x - cx, player.y - cy);
      if (d < bestD) { bestD = d; best = b; }
    }
    return bestD <= INTERACT_PAD ? best : null;
  }

  function update() {
    let dx = 0, dy = 0;
    if (keys['arrowleft'] || keys['a'] || touchDir.left) dx -= 1;
    if (keys['arrowright'] || keys['d'] || touchDir.right) dx += 1;
    if (keys['arrowup'] || keys['w'] || touchDir.up) dy -= 1;
    if (keys['arrowdown'] || keys['s'] || touchDir.down) dy += 1;
    if (dx || dy) {
      const len = Math.hypot(dx, dy) || 1;
      const nx = player.x + (dx / len) * PLAYER_SPEED;
      const ny = player.y + (dy / len) * PLAYER_SPEED;
      if (!blockedAt(nx, player.y)) player.x = nx;   // axis-separated = smooth sliding
      if (!blockedAt(player.x, ny)) player.y = ny;
    }
    nearBooth = nearestBooth();

    // gentle NPC wandering
    for (const n of world.npcs) {
      if (n.repick <= 0 || Math.hypot(n.tx - n.x, n.ty - n.y) < 6) {
        n.tx = 120 + Math.random() * (WORLD_W - 240);
        n.ty = 230 + Math.random() * 140;
        n.repick = 120 + Math.random() * 180;
      }
      n.repick--;
      const a = Math.atan2(n.ty - n.y, n.tx - n.x);
      n.x += Math.cos(a) * 0.8;
      n.y += Math.sin(a) * 0.8;
    }
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawAvatar(x, y, color, emoji, name, isPlayer) {
    if (isPlayer) {
      ctx.beginPath();
      ctx.arc(x, y, PLAYER_R + 4, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(94,206,153,0.9)';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(x, y, PLAYER_R, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji || '🙂', x, y + 1);
    if (name) {
      ctx.font = '600 11px system-ui, sans-serif';
      const w = ctx.measureText(name).width + 10;
      ctx.fillStyle = 'rgba(12,14,20,0.78)';
      roundRect(x - w / 2, y - PLAYER_R - 18, w, 15, 6); ctx.fill();
      ctx.fillStyle = '#edf0f7';
      ctx.fillText(name, x, y - PLAYER_R - 10);
    }
  }

  function draw() {
    // floor
    ctx.fillStyle = '#10141f';
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.lineWidth = 1;
    for (let gx = 0; gx <= WORLD_W; gx += 48) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, WORLD_H); ctx.stroke(); }
    for (let gy = 0; gy <= WORLD_H; gy += 48) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(WORLD_W, gy); ctx.stroke(); }

    // booths
    for (const b of world.booths) {
      const active = nearBooth && nearBooth.id === b.id;
      // table
      roundRect(b.x, b.y, b.w, b.h, 10);
      ctx.fillStyle = active ? '#1f2940' : '#1a2133';
      ctx.fill();
      ctx.strokeStyle = active ? '#5ece99' : (b.isYou ? 'rgba(94,206,153,0.6)' : 'rgba(255,255,255,0.12)');
      ctx.lineWidth = active ? 3 : 1.5;
      ctx.stroke();
      // banner
      roundRect(b.x, b.y, b.w, 22, 10);
      ctx.fillStyle = b.color || '#5ece99';
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.font = '700 11px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText((b.emoji || '🃏') + ' ' + (b.isYou ? 'Your Booth' : b.owner), b.x + 8, b.y + 11);
      // card count / status line
      const n = (b.cards || []).length;
      const forSale = (b.cards || []).some(c => c.status === 'sale' || c.status === 'both');
      const forTrade = (b.cards || []).some(c => c.status === 'trade' || c.status === 'both');
      ctx.fillStyle = '#94a3b8';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(n ? `${n} card${n !== 1 ? 's' : ''}` : 'empty', b.x + 8, b.y + 38);
      ctx.font = '13px sans-serif';
      ctx.fillText((forSale ? '🛒' : '') + (forTrade ? '🤝' : ''), b.x + 8, b.y + 56);
    }

    // npcs + player
    for (const n of world.npcs) drawAvatar(n.x, n.y, n.color, n.emoji, n.name, false);
    const me = getCharacter() || {};
    drawAvatar(player.x, player.y, me.color || '#5ece99', me.emoji || '🙂', me.name || 'You', true);

    // proximity prompt
    const prompt = document.getElementById('floor-prompt');
    if (prompt) {
      if (nearBooth) {
        const who = nearBooth.isYou ? 'your booth' : `${nearBooth.owner}'s booth`;
        prompt.textContent = `Press E to visit ${who}`;
        prompt.classList.remove('hidden');
      } else {
        prompt.classList.add('hidden');
      }
    }
  }

  function loop() {
    if (!running) return;
    const view = document.getElementById('floor-view');
    if (!view || view.classList.contains('hidden')) { running = false; return; }
    update();
    draw();
    rafId = requestAnimationFrame(loop);
  }

  function start() {
    if (running) return;
    running = true;
    rafId = requestAnimationFrame(loop);
  }
  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  // ---- booth modal (the showcase, with third-party handoff) ----
  function boothCardsHtml(b) {
    const cards = b.cards || [];
    if (!cards.length) {
      return b.isYou
        ? '<p class="seller-empty">Your booth is empty. Add cards in the <strong>Sell</strong> tab and they\'ll appear here on the floor.</p>'
        : '<p class="seller-empty">This collector hasn\'t put any cards out yet.</p>';
    }
    return '<div class="showcase-grid">' + cards.map(it => {
      const img = it.imageUrl
        ? `<img class="sc-card-img" src="${escHtml(it.imageUrl)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />`
        : '<div class="sc-card-img sc-card-noimg">No Image</div>';
      const price = (typeof it.price === 'number' && it.price > 0) ? `<span class="sc-card-price">$${it.price.toFixed(2)}</span>` : '';
      const forSale = it.status === 'sale' || it.status === 'both';
      const forTrade = it.status === 'trade' || it.status === 'both';
      const badges = [];
      if (forSale) badges.push('<span class="sc-badge sc-badge-sale">For Sale</span>');
      if (forTrade) badges.push('<span class="sc-badge sc-badge-trade">For Trade</span>');
      if (!forSale && !forTrade) badges.push('<span class="sc-badge sc-badge-show">Showcase</span>');
      const links = [];
      if (forSale) links.push(`<a class="sc-link sc-link-ebay" href="${escHtml(floorEbayLink(it))}" target="_blank" rel="noopener noreferrer">Buy on eBay &#8599;</a>`);
      if (forTrade) links.push(`<a class="sc-link sc-link-trade" href="${escHtml(floorTradeLink(it, b.veriswap))}" target="_blank" rel="noopener noreferrer">Trade on Veriswap &#8599;</a>`);
      return `<div class="sc-card">${img}<div class="sc-card-body">
        <div class="sc-card-badges">${badges.join('')}</div>
        <div class="sc-card-title">${escHtml(it.title || 'Card')}</div>
        ${it.note ? `<div class="sc-card-note">${escHtml(it.note)}</div>` : ''}
        ${price}
        <div class="sc-card-links">${links.join('')}</div>
      </div></div>`;
    }).join('') + '</div>';
  }

  function openBooth(b) {
    const modal = document.getElementById('floor-booth-modal');
    const title = document.getElementById('floor-booth-title');
    const sub = document.getElementById('floor-booth-sub');
    const body = document.getElementById('floor-booth-body');
    if (!modal || !body) return;
    if (title) title.textContent = (b.emoji || '🃏') + ' ' + (b.isYou ? 'Your Booth' : b.owner + "'s Booth");
    if (sub) sub.textContent = b.isYou
      ? 'This is what other collectors see when they visit you.'
      : 'Buy hands off to eBay; trade hands off to Veriswap. The Card Huddle isn\'t part of the deal.';
    body.innerHTML = boothCardsHtml(b);
    modal.classList.remove('hidden');
  }
  function closeBooth() {
    document.getElementById('floor-booth-modal')?.classList.add('hidden');
  }

  // ---- character creation UI ----
  function renderCharCreate() {
    const cc = document.getElementById('floor-charcreate');
    const stage = document.getElementById('floor-stage');
    if (stage) stage.classList.add('hidden');
    if (cc) cc.classList.remove('hidden');
    const existing = getCharacter();
    if (existing) { ccDraft = { color: existing.color, emoji: existing.emoji }; }
    const nameEl = document.getElementById('floor-cc-name');
    if (nameEl) nameEl.value = existing ? (existing.name || '') : '';

    const colorWrap = document.getElementById('floor-cc-colors');
    if (colorWrap) colorWrap.innerHTML = AVATAR_COLORS.map(c =>
      `<button type="button" class="floor-swatch${c === ccDraft.color ? ' sel' : ''}" style="background:${c}" data-color="${c}"></button>`).join('');
    const emojiWrap = document.getElementById('floor-cc-emojis');
    if (emojiWrap) emojiWrap.innerHTML = AVATAR_EMOJIS.map(e =>
      `<button type="button" class="floor-emoji${e === ccDraft.emoji ? ' sel' : ''}" data-emoji="${e}">${e}</button>`).join('');
  }

  function enterFloor() {
    document.getElementById('floor-charcreate')?.classList.add('hidden');
    const stage = document.getElementById('floor-stage');
    if (stage) stage.classList.remove('hidden');
    const me = getCharacter();
    const hudName = document.getElementById('floor-hud-name');
    if (hudName && me) hudName.textContent = `${me.emoji || '🙂'} ${me.name || 'You'}`;
    buildWorld();
    start();
  }

  // ---- public entry points (called from app.js / inline handlers) ----
  window.initFloor = function () {
    canvas = document.getElementById('floor-canvas');
    ctx = canvas ? canvas.getContext('2d') : null;
    if (!ctx) return;
    if (getCharacter()) enterFloor();
    else renderCharCreate();
  };
  window.stopFloor = stop;
  window.editCharacter = function () { stop(); renderCharCreate(); };
  window.saveCharacterAndEnter = function () {
    const name = (document.getElementById('floor-cc-name')?.value || '').trim();
    if (!name) { alert('Pick a display name for your collector.'); return; }
    saveCharacter({ name, color: ccDraft.color, emoji: ccDraft.emoji });
    enterFloor();
  };
  window.closeBoothModal = closeBooth;

  // ---- input wiring ----
  document.addEventListener('keydown', e => {
    const view = document.getElementById('floor-view');
    if (!view || view.classList.contains('hidden')) return;
    const k = e.key.toLowerCase();
    if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'w', 'a', 's', 'd', 'e'].includes(k)) {
      // don't hijack typing in the name field
      if (document.activeElement && document.activeElement.id === 'floor-cc-name') return;
      e.preventDefault();
      keys[k] = true;
      if (k === 'e' && nearBooth) openBooth(nearBooth);
    }
  });
  document.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

  // character-creation pickers + d-pad (event delegation, set up once)
  document.addEventListener('click', e => {
    const sw = e.target.closest('.floor-swatch');
    if (sw) { ccDraft.color = sw.dataset.color; renderCharCreate(); return; }
    const em = e.target.closest('.floor-emoji');
    if (em) { ccDraft.emoji = em.dataset.emoji; renderCharCreate(); return; }
    // tap a booth on the canvas to open it
    if (e.target && e.target.id === 'floor-canvas' && world) {
      const r = canvas.getBoundingClientRect();
      const mx = (e.clientX - r.left) * (WORLD_W / r.width);
      const my = (e.clientY - r.top) * (WORLD_H / r.height);
      const hit = world.booths.find(b => mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h);
      if (hit) openBooth(hit);
    }
  });

  // touch d-pad: press-and-hold to move, tap E to visit
  function bindDpad() {
    document.querySelectorAll('.floor-dbtn').forEach(btn => {
      const dir = btn.dataset.dir;
      const on = ev => {
        ev.preventDefault();
        if (dir === 'action') { if (nearBooth) openBooth(nearBooth); return; }
        touchDir[dir] = true;
      };
      const off = ev => { ev.preventDefault(); if (dir !== 'action') touchDir[dir] = false; };
      btn.addEventListener('touchstart', on, { passive: false });
      btn.addEventListener('touchend', off, { passive: false });
      btn.addEventListener('touchcancel', off, { passive: false });
      btn.addEventListener('mousedown', on);
      btn.addEventListener('mouseup', off);
      btn.addEventListener('mouseleave', off);
    });
  }
  bindDpad();
})();
