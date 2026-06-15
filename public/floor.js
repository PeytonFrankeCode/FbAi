/* =====================================================================
   The Floor — a walkable card-show world.

   You create a collector (name + avatar), then walk around a virtual
   show floor made of booths. Each booth is someone's showcase. Walk up
   to a booth and open it to buy (hands off to eBay) or trade (hands off
   to Veriswap). The Card Huddle is never part of the transaction — every
   deal leaves to the third party.

   Booths are real: each signed-in collector who has made a character and
   put cards in their Showcase appears on the floor (served by
   GET /api/floor/booths). Your own booth is rendered from your local
   showcase so it reflects unsynced edits too. While the floor is still
   small it's topped up with a few demo collectors. Live presence (seeing
   real people move in real time) is the next phase — it would add a
   Cloudflare Durable Object + WebSockets feeding the same world model.

   Relies on globals from app.js: escHtml, epnUrl, getShowcase,
   getShowcaseSettings, getCurrentUser, schedulePushUserData.
   ===================================================================== */
(function () {
  'use strict';

  const CHAR_KEY = 'cardHuddleCharacter';
  const AVATAR_COLORS = ['#5ece99', '#f59e0b', '#ef4444', '#6366f1', '#ec4899', '#06b6d4', '#a855f7', '#84cc16'];
  const AVATAR_EMOJIS = ['🧢', '😎', '🤠', '🦸', '🤖', '👽', '🧑‍🎤', '🐉'];

  const WORLD_W = 960;         // fixed width (4 booth columns)
  const VIEW_H = 600;          // canvas viewport height; world can be taller
  const PLAYER_R = 14, PLAYER_SPEED = 2.7;
  const BOOTH_W = 120, BOOTH_H = 72;
  const INTERACT_PAD = 34;     // how close you must be to a booth to open it
  const COLS = [60, 290, 520, 750];
  const FIRST_ROW_Y = 110, ROW_SPACING = 235;

  let canvas, ctx;
  let rafId = null;
  let running = false;
  let world = null;            // { booths, npcs }
  let worldH = VIEW_H;
  let cameraY = 0;
  let player = { x: WORLD_W / 2, y: VIEW_H - 70 };
  let nearBooth = null;
  let ccDraft = { color: AVATAR_COLORS[0], emoji: AVATAR_EMOJIS[0] };
  const keys = Object.create(null);
  const touchDir = { up: false, down: false, left: false, right: false };

  // ---- live presence (WebSocket → FloorRoom Durable Object) ----
  let ws = null;
  let wsId = null;             // our id assigned by the room
  const remote = new Map();    // id -> { name, emoji, color, x, y, tx, ty }
  let moveTimer = null;
  let lastSent = { x: null, y: null };
  let reconnectTimer = null;

  // ---- character persistence ----
  function getCharacter() {
    try { return JSON.parse(localStorage.getItem(CHAR_KEY) || 'null'); }
    catch { return null; }
  }
  function saveCharacter(c) {
    localStorage.setItem(CHAR_KEY, JSON.stringify(c));
    if (typeof schedulePushUserData === 'function') schedulePushUserData();
  }
  function myUsername() {
    return (typeof getCurrentUser === 'function' ? (getCurrentUser() || '') : '').toLowerCase();
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

  // ---- demo collectors so the floor isn't empty before it fills up ----
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
        { title: '2023 Bowman Chrome Jackson Holliday Auto /499', price: 200, status: 'trade', veriswapUrl: 'chromechloe' },
      ] },
      { owner: 'SlabSam', emoji: '🤖', color: '#ef4444', veriswap: 'slabsam', cards: [
        { title: '2003 Topps Chrome LeBron James RC PSA 9', price: 2400, status: 'both', veriswapUrl: 'slabsam' },
      ] },
    ];
  }

  function makeNpcs() {
    return [
      { name: 'Browser1', emoji: '😀', color: '#38bdf8' },
      { name: 'Browser2', emoji: '🥳', color: '#fbbf24' },
      { name: 'Browser3', emoji: '🤓', color: '#f472b6' },
    ].map(n => Object.assign({
      x: 120 + Math.random() * (WORLD_W - 240),
      y: 230 + Math.random() * 120,
      tx: 0, ty: 0, repick: 0,
    }, n));
  }

  // Build the world from the server's booth list. The layout is shared: it's
  // the same ordered list for everyone (so a remote player's coordinates line
  // up with the same booths on every screen). Your own booth keeps its real
  // position; its cards are overlaid from your LOCAL showcase so unsynced
  // edits still show. If you haven't synced a booth yet, one is appended.
  function buildWorld(remoteBooths) {
    const me = getCharacter() || { name: 'You', color: AVATAR_COLORS[0], emoji: AVATAR_EMOJIS[0] };
    const settings = (typeof getShowcaseSettings === 'function') ? getShowcaseSettings() : {};
    const localCards = (typeof getShowcase === 'function') ? (getShowcase() || []) : [];
    const mine = myUsername();

    let list = (Array.isArray(remoteBooths) ? remoteBooths : [])
      .filter(b => b && b.name)
      .map(b => ({
        owner: b.name, username: b.username, emoji: b.emoji, color: b.color,
        veriswap: b.veriswap, cards: Array.isArray(b.cards) ? b.cards : [],
        isYou: !!mine && b.username === mine,
      }));

    const myBooth = list.find(b => b.isYou);
    if (myBooth) {
      myBooth.owner = me.name || myBooth.owner;
      myBooth.emoji = me.emoji || myBooth.emoji;
      myBooth.color = me.color || myBooth.color;
      myBooth.veriswap = settings.veriswap || myBooth.veriswap;
      myBooth.cards = localCards;
    } else {
      list.push({
        owner: me.name || 'You', username: mine, emoji: me.emoji, color: me.color,
        veriswap: settings.veriswap || '', cards: localCards, isYou: true,
      });
    }

    // Top up with demo collectors while the floor is small (deterministic,
    // so every client still sees the same extra booths in the same spots).
    if (list.length < 6) {
      const have = new Set(list.map(b => (b.owner || '').toLowerCase()));
      for (const d of demoBooths()) { if (!have.has(d.owner.toLowerCase())) list.push(Object.assign({ isYou: false }, d)); }
    }
    list = list.slice(0, 24);

    const booths = list.map((b, i) => {
      const col = i % COLS.length;
      const row = Math.floor(i / COLS.length);
      return Object.assign({ id: i, x: COLS[col], y: FIRST_ROW_Y + row * ROW_SPACING, w: BOOTH_W, h: BOOTH_H }, b);
    });
    const rows = Math.ceil(list.length / COLS.length);
    worldH = Math.max(VIEW_H, FIRST_ROW_Y + rows * ROW_SPACING + 60);

    world = { booths, npcs: makeNpcs() };
    player.x = WORLD_W / 2;
    player.y = Math.min(worldH - 60, FIRST_ROW_Y + 150);
    cameraY = 0;
    nearBooth = null;
    const search = document.getElementById('floor-dir-search');
    renderDirectory(search ? search.value : '');
  }

  function boothBlocks(b, px, py) {
    return px > b.x - PLAYER_R && px < b.x + b.w + PLAYER_R &&
           py > b.y - PLAYER_R && py < b.y + b.h + PLAYER_R;
  }
  function blockedAt(px, py) {
    if (px < PLAYER_R || px > WORLD_W - PLAYER_R || py < PLAYER_R || py > worldH - PLAYER_R) return true;
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
    cameraY = Math.max(0, Math.min(player.y - VIEW_H / 2, Math.max(0, worldH - VIEW_H)));

    for (const n of world.npcs) {
      if (n.repick <= 0 || Math.hypot(n.tx - n.x, n.ty - n.y) < 6) {
        n.tx = 120 + Math.random() * (WORLD_W - 240);
        n.ty = 200 + Math.random() * 160;
        n.repick = 120 + Math.random() * 180;
      }
      n.repick--;
      const a = Math.atan2(n.ty - n.y, n.tx - n.x);
      n.x += Math.cos(a) * 0.8;
      n.y += Math.sin(a) * 0.8;
    }

    // smooth remote avatars toward their last reported position
    for (const r of remote.values()) {
      r.x += (r.tx - r.x) * 0.25;
      r.y += (r.ty - r.y) * 0.25;
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
    ctx.clearRect(0, 0, WORLD_W, VIEW_H);
    ctx.fillStyle = '#10141f';
    ctx.fillRect(0, 0, WORLD_W, VIEW_H);

    ctx.save();
    ctx.translate(0, -cameraY);

    // grid only across the visible band (for tall worlds)
    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.lineWidth = 1;
    const top = Math.floor(cameraY / 48) * 48;
    for (let gx = 0; gx <= WORLD_W; gx += 48) { ctx.beginPath(); ctx.moveTo(gx, top); ctx.lineTo(gx, top + VIEW_H + 48); ctx.stroke(); }
    for (let gy = top; gy <= top + VIEW_H + 48; gy += 48) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(WORLD_W, gy); ctx.stroke(); }

    for (const b of world.booths) {
      const active = nearBooth && nearBooth.id === b.id;
      roundRect(b.x, b.y, b.w, b.h, 10);
      ctx.fillStyle = active ? '#1f2940' : '#1a2133';
      ctx.fill();
      ctx.strokeStyle = active ? '#5ece99' : (b.isYou ? 'rgba(94,206,153,0.6)' : 'rgba(255,255,255,0.12)');
      ctx.lineWidth = active ? 3 : 1.5;
      ctx.stroke();
      roundRect(b.x, b.y, b.w, 22, 10);
      ctx.fillStyle = b.color || '#5ece99';
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.font = '700 11px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText((b.emoji || '🃏') + ' ' + (b.isYou ? 'Your Booth' : b.owner), b.x + 8, b.y + 11);
      const n = (b.cards || []).length;
      const forSale = (b.cards || []).some(c => c.status === 'sale' || c.status === 'both');
      const forTrade = (b.cards || []).some(c => c.status === 'trade' || c.status === 'both');
      ctx.fillStyle = '#94a3b8';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(n ? `${n} card${n !== 1 ? 's' : ''}` : 'empty', b.x + 8, b.y + 38);
      ctx.font = '13px sans-serif';
      ctx.fillText((forSale ? '🛒' : '') + (forTrade ? '🤝' : ''), b.x + 8, b.y + 56);
    }

    // Real collectors when anyone's online; ambient NPCs when you're alone.
    if (remote.size > 0) {
      for (const r of remote.values()) drawAvatar(r.x, r.y, r.color, r.emoji, r.name, false);
    } else {
      for (const n of world.npcs) drawAvatar(n.x, n.y, n.color, n.emoji, n.name, false);
    }
    const me = getCharacter() || {};
    drawAvatar(player.x, player.y, me.color || '#5ece99', me.emoji || '🙂', me.name || 'You', true);

    ctx.restore();

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
    disconnectPresence();
  }

  // ---- presence wiring ----
  function updateOnlineCount() {
    const el = document.getElementById('floor-online');
    if (!el) return;
    const n = remote.size + 1; // others + you
    el.textContent = `🟢 ${n} on the floor`;
  }

  function connectPresence() {
    if (ws || typeof WebSocket === 'undefined') return;
    let sock;
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      sock = new WebSocket(`${proto}//${location.host}/api/floor/ws`);
    } catch (_) { return; }
    ws = sock;

    sock.addEventListener('open', () => {
      const me = getCharacter() || {};
      sendWs({ t: 'join', name: me.name || 'Collector', emoji: me.emoji || '🙂', color: me.color || '#5ece99', username: myUsername(), x: Math.round(player.x), y: Math.round(player.y) });
      // throttle position updates to ~10/sec, only when we've actually moved
      lastSent = { x: null, y: null };
      moveTimer = setInterval(() => {
        const x = Math.round(player.x), y = Math.round(player.y);
        if (x === lastSent.x && y === lastSent.y) return;
        lastSent = { x, y };
        sendWs({ t: 'move', x, y });
      }, 100);
    });

    sock.addEventListener('message', (evt) => {
      let msg; try { msg = JSON.parse(evt.data); } catch (_) { return; }
      if (msg.t === 'welcome') {
        wsId = msg.id;
        remote.clear();
        for (const p of (msg.players || [])) remote.set(p.id, { name: p.name, emoji: p.emoji, color: p.color, x: p.x, y: p.y, tx: p.x, ty: p.y });
      } else if (msg.t === 'join' && msg.player) {
        const p = msg.player;
        remote.set(p.id, { name: p.name, emoji: p.emoji, color: p.color, x: p.x, y: p.y, tx: p.x, ty: p.y });
      } else if (msg.t === 'move') {
        const r = remote.get(msg.id);
        if (r) { r.tx = msg.x; r.ty = msg.y; }
      } else if (msg.t === 'leave') {
        remote.delete(msg.id);
      }
      updateOnlineCount();
    });

    const onClose = () => {
      if (moveTimer) { clearInterval(moveTimer); moveTimer = null; }
      if (ws === sock) ws = null;
      remote.clear();
      updateOnlineCount();
      // auto-reconnect while we're still on the floor
      if (running && !reconnectTimer) {
        reconnectTimer = setTimeout(() => { reconnectTimer = null; if (running) connectPresence(); }, 2500);
      }
    };
    sock.addEventListener('close', onClose);
    sock.addEventListener('error', () => { try { sock.close(); } catch (_) {} });
  }

  function disconnectPresence() {
    if (moveTimer) { clearInterval(moveTimer); moveTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { try { ws.close(); } catch (_) {} ws = null; }
    remote.clear();
    wsId = null;
  }

  function sendWs(obj) {
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (_) {} }
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
      ? 'This is what other collectors see when they visit you. Edit it in the Sell tab.'
      : 'Buy hands off to eBay; trade hands off to Veriswap. The Card Huddle isn\'t part of the deal.';
    body.innerHTML = boothCardsHtml(b);
    modal.classList.remove('hidden');
  }
  function closeBooth() {
    document.getElementById('floor-booth-modal')?.classList.add('hidden');
  }

  // ---- booth directory (find / open / walk to a booth) ----
  function renderDirectory(filter) {
    const listEl = document.getElementById('floor-dir-list');
    if (!listEl) return;
    if (!world) { listEl.innerHTML = '<p class="floor-dir-empty">Loading the floor…</p>'; return; }
    const q = (filter || '').trim().toLowerCase();
    const rows = world.booths
      .filter(b => !q || (b.owner || '').toLowerCase().includes(q))
      .map(b => {
        const n = (b.cards || []).length;
        const forSale = (b.cards || []).some(c => c.status === 'sale' || c.status === 'both');
        const forTrade = (b.cards || []).some(c => c.status === 'trade' || c.status === 'both');
        const tags = (forSale ? '🛒' : '') + (forTrade ? '🤝' : '');
        return `<div class="floor-dir-row">
          <span class="floor-dir-emoji">${escHtml(b.emoji || '🃏')}</span>
          <span class="floor-dir-name">${escHtml(b.isYou ? 'You' : (b.owner || 'Collector'))}${b.isYou ? ' <span class="floor-dir-youbadge">YOUR BOOTH</span>' : ''}</span>
          <span class="floor-dir-meta">${n} card${n !== 1 ? 's' : ''} ${tags}</span>
          <span class="floor-dir-acts">
            <button type="button" class="floor-dir-visit" data-booth="${b.id}">Visit</button>
            <button type="button" class="floor-dir-walk" data-booth="${b.id}">Walk</button>
          </span>
        </div>`;
      }).join('');
    listEl.innerHTML = rows || '<p class="floor-dir-empty">No collectors match that search.</p>';
  }

  function boothById(id) {
    return world && world.booths.find(b => String(b.id) === String(id));
  }
  function walkToBooth(b) {
    if (!b) return;
    player.x = Math.max(PLAYER_R, Math.min(WORLD_W - PLAYER_R, b.x + b.w / 2));
    player.y = Math.min(worldH - PLAYER_R, b.y + b.h + PLAYER_R + 10);
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

  async function enterFloor() {
    document.getElementById('floor-charcreate')?.classList.add('hidden');
    const stage = document.getElementById('floor-stage');
    if (stage) stage.classList.remove('hidden');
    const me = getCharacter();
    const hudName = document.getElementById('floor-hud-name');
    if (hudName && me) hudName.textContent = `${me.emoji || '🙂'} ${me.name || 'You'}`;
    world = null; renderDirectory('');   // show the loading state while we fetch

    // Fetch everyone's booth, then build & run. Falls back to demo-only.
    let remoteBooths = [];
    try {
      const res = await fetch('/api/floor/booths');
      if (res.ok) { const data = await res.json(); remoteBooths = Array.isArray(data.booths) ? data.booths : []; }
    } catch (_) { /* offline / not deployed — demo floor */ }
    buildWorld(remoteBooths);
    start();
    updateOnlineCount();
    connectPresence();
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
      if (document.activeElement && document.activeElement.id === 'floor-cc-name') return;
      e.preventDefault();
      keys[k] = true;
      if (k === 'e' && nearBooth) openBooth(nearBooth);
    }
  });
  document.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

  document.addEventListener('input', e => {
    if (e.target && e.target.id === 'floor-dir-search') renderDirectory(e.target.value);
  });

  document.addEventListener('click', e => {
    const sw = e.target.closest('.floor-swatch');
    if (sw) { ccDraft.color = sw.dataset.color; renderCharCreate(); return; }
    const em = e.target.closest('.floor-emoji');
    if (em) { ccDraft.emoji = em.dataset.emoji; renderCharCreate(); return; }
    const visit = e.target.closest('.floor-dir-visit');
    if (visit) { const b = boothById(visit.dataset.booth); if (b) openBooth(b); return; }
    const walk = e.target.closest('.floor-dir-walk');
    if (walk) { const b = boothById(walk.dataset.booth); if (b) walkToBooth(b); return; }
    if (e.target && e.target.id === 'floor-canvas' && world) {
      const r = canvas.getBoundingClientRect();
      const mx = (e.clientX - r.left) * (WORLD_W / r.width);
      const my = (e.clientY - r.top) * (VIEW_H / r.height) + cameraY;
      const hit = world.booths.find(b => mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h);
      if (hit) openBooth(hit);
    }
  });

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
