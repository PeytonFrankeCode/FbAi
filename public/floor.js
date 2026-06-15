/* =====================================================================
   The Floor — a walkable, first-person 3D card-show world (Three.js).

   Create a collector, then walk a show floor of white-clothed tables.
   Each table is a booth: two glass display cases, three card boxes, and a
   loose lay-down area. Walk up and open a booth to buy (eBay) or trade
   (Veriswap) — The Card Huddle is never part of the transaction.

   Controls:
     - First person: mouse-drag to look, W/S (or up/down) move, A/D strafe,
       arrows turn, E (or tap a booth) to open it.
     - Free look: toggle to orbit the camera around the table in front of
       you and zoom (wheel / pinchless d-pad) to inspect the cards.

   Custom models: window.FLOOR_AVATAR_MODEL = '<url.glb>' loads via
   GLTFLoader; otherwise simple primitives are used.

   Data/presence layers unchanged: booths from /api/floor/booths, live
   avatars over the FloorRoom Durable Object WebSocket.
   ===================================================================== */
import * as THREE from 'three';

const CHAR_KEY = 'cardHuddleCharacter';
const AVATAR_COLORS = ['#5ece99', '#f59e0b', '#ef4444', '#6366f1', '#ec4899', '#06b6d4', '#a855f7', '#84cc16'];
const AVATAR_EMOJIS = ['🧢', '😎', '🤠', '🦸', '🤖', '👽', '🧑‍🎤', '🐉'];

const COLS = 4;
const COL_X = [-20, -7, 7, 20];
const ROW_Z0 = 9, ROW_DZ = 14;
const TABLE_W = 6.2, TABLE_D = 2.4, TABLE_H = 1.05;   // 6ft folding table
const PLAYER_R = 0.6, MOVE_SPEED = 0.15, TURN_SPEED = 0.04;
const INTERACT_DIST = 4.6;
const EYE_H = 1.7;
const PITCH_MIN = -1.2, PITCH_MAX = 1.0;

let renderer, scene, camera, clock;
let worldGroup = null;
let booths = [];
let bounds = { minX: -30, maxX: 30, minZ: -10, maxZ: 44 };
let rafId = null, running = false;
let avatarModel = null;

const player = { x: 0, z: -3 };
let yaw = 0, pitch = -0.05;
let camMode = 'fp';                                   // 'fp' | 'free'
const free = { az: 0, el: 0.55, dist: 6.5, target: new THREE.Vector3() };
let nearBooth = null;
let playerObj = null;

// presence
let ws = null, wsId = null, moveTimer = null, reconnectTimer = null;
let lastSent = { x: null, z: null };
const remote = new Map();
let npcs = [];

// input
const keys = Object.create(null);
const touchDir = { up: false, down: false, left: false, right: false };
let dragging = false, lastX = 0, lastY = 0;

let ccDraft = { color: AVATAR_COLORS[0], emoji: AVATAR_EMOJIS[0] };

// ---------------------------------------------------------------- data
function getCharacter() { try { return JSON.parse(localStorage.getItem(CHAR_KEY) || 'null'); } catch { return null; } }
function saveCharacter(c) { localStorage.setItem(CHAR_KEY, JSON.stringify(c)); if (typeof schedulePushUserData === 'function') schedulePushUserData(); }
function myUsername() { return (typeof getCurrentUser === 'function' ? (getCurrentUser() || '') : '').toLowerCase(); }

// ---------------------------------------------------- third-party links
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

// ----------------------------------------------------- demo collectors
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

// ----------------------------------------------------- label sprite
function makeLabelSprite(title, sub) {
  const cw = 256, ch = 96;
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const c = cv.getContext('2d');
  c.fillStyle = 'rgba(12,14,20,0.82)'; roundRectCtx(c, 4, 4, cw - 8, ch - 8, 14); c.fill();
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillStyle = '#edf0f7'; c.font = '700 30px system-ui, sans-serif';
  c.fillText(title.slice(0, 18), cw / 2, sub ? 38 : ch / 2);
  if (sub) { c.fillStyle = '#94a3b8'; c.font = '22px system-ui, sans-serif'; c.fillText(sub.slice(0, 22), cw / 2, 70); }
  const tex = new THREE.CanvasTexture(cv); tex.anisotropy = 4;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  spr.scale.set(3.6, 1.35, 1);
  return spr;
}
function roundRectCtx(c, x, y, w, h, r) {
  c.beginPath(); c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}

// a generic card face (white card with a colored header + image box)
function makeCardTex(header) {
  const cv = document.createElement('canvas'); cv.width = 120; cv.height = 168;
  const c = cv.getContext('2d');
  c.fillStyle = '#f6f6f1'; c.fillRect(0, 0, 120, 168);
  c.fillStyle = header; c.fillRect(0, 0, 120, 22);
  c.fillStyle = '#cdd2db'; c.fillRect(11, 30, 98, 92);
  c.fillStyle = '#a7afbd'; c.fillRect(11, 130, 98, 8); c.fillRect(11, 144, 70, 8);
  c.strokeStyle = '#e2e2e2'; c.lineWidth = 4; c.strokeRect(2, 2, 116, 164);
  const t = new THREE.CanvasTexture(cv); t.anisotropy = 4; return t;
}

// A closed aluminum briefcase display case: brushed-metal tray, dark felt
// liner, a tight grid of slabs laid flat, a clear glass lid, side rails,
// a carry handle and latches on the front edge. Modeled on a real case.
function buildDisplayCase(parent, ox, oz, w, d, y0, boothIdx, shared) {
  const g = new THREE.Group();
  g.position.set(ox, 0, oz);
  const CASE_H = 0.16;

  const tray = new THREE.Mesh(new THREE.BoxGeometry(w, CASE_H, d), shared.alu);
  tray.position.y = y0 + CASE_H / 2; tray.castShadow = true; tray.receiveShadow = true;
  tray.userData.boothId = boothIdx; g.add(tray);

  const liner = new THREE.Mesh(new THREE.BoxGeometry(w - 0.14, 0.02, d - 0.14), shared.aluDark);
  liner.position.y = y0 + CASE_H + 0.01; g.add(liner);

  const cols = 6, rows = 3;
  const cw = (w - 0.24) / cols, cd = (d - 0.24) / rows;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const card = new THREE.Mesh(shared.slabGeo, shared.cardMats[(r * cols + c) % shared.cardMats.length]);
    card.rotation.x = -Math.PI / 2;
    card.position.set(-w / 2 + 0.12 + cw / 2 + c * cw, y0 + CASE_H + 0.03, -d / 2 + 0.12 + cd / 2 + r * cd);
    g.add(card);
  }

  const railFB = new THREE.BoxGeometry(w, 0.13, 0.05);
  const railLR = new THREE.BoxGeometry(0.05, 0.13, d);
  for (const z of [-d / 2, d / 2]) { const m = new THREE.Mesh(railFB, shared.alu); m.position.set(0, y0 + CASE_H + 0.07, z); m.userData.boothId = boothIdx; g.add(m); }
  for (const x of [-w / 2, w / 2]) { const m = new THREE.Mesh(railLR, shared.alu); m.position.set(x, y0 + CASE_H + 0.07, 0); m.userData.boothId = boothIdx; g.add(m); }

  const glass = new THREE.Mesh(new THREE.BoxGeometry(w - 0.03, 0.03, d - 0.03), shared.glass);
  glass.position.y = y0 + CASE_H + 0.13; glass.userData.boothId = boothIdx; g.add(glass);

  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.025, 8, 16, Math.PI), shared.alu);
  handle.position.set(0, y0 + CASE_H, -d / 2 - 0.02); g.add(handle);
  for (const lx of [-w / 2 + 0.4, w / 2 - 0.4]) {
    const latch = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.07, 0.05), shared.alu);
    latch.position.set(lx, y0 + CASE_H + 0.02, -d / 2 - 0.005); g.add(latch);
  }

  parent.add(g);
}

// ----------------------------------------------------- table / booth
function buildBoothTable(grp, b, shared) {
  const cloth = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE_W, TABLE_H, TABLE_D),
    new THREE.MeshStandardMaterial({ color: 0xf3f4f6, roughness: 0.95 })
  );
  cloth.position.y = TABLE_H / 2; cloth.castShadow = true; cloth.receiveShadow = true;
  cloth.userData.boothId = b._idx;
  grp.add(cloth);
  // thin tabletop trim
  const top = new THREE.Mesh(new THREE.BoxGeometry(TABLE_W + 0.05, 0.06, TABLE_D + 0.05),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }));
  top.position.y = TABLE_H; top.userData.boothId = b._idx; grp.add(top);

  const y0 = TABLE_H + 0.03;

  // --- 2 aluminum display cases (left side), closed, slabs under glass ---
  buildDisplayCase(grp, -2.05, 0, 1.95, 1.35, y0, b._idx, shared);
  buildDisplayCase(grp, -0.05, 0, 1.95, 1.35, y0, b._idx, shared);

  // --- 3 card boxes (right side), cards standing up facing the buyer (-z) ---
  [1.45, 2.25, 3.05].forEach((bx) => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.34, 1.4),
      new THREE.MeshStandardMaterial({ color: 0x6b4f33, roughness: 0.95 }));
    box.position.set(bx, y0 + 0.17, 0); box.userData.boothId = b._idx; grp.add(box);
    for (let i = 0; i < 9; i++) {
      const card = new THREE.Mesh(shared.standGeo, shared.cardMats[(i + 1) % shared.cardMats.length]);
      card.position.set(bx, y0 + 0.28, -0.55 + i * 0.12);
      card.userData.boothId = b._idx;
      grp.add(card);
    }
  });

  // --- loose lay-down area (front center): a few cards flat on the cloth ---
  for (let i = 0; i < 4; i++) {
    const card = new THREE.Mesh(shared.flatGeo, shared.cardMats[i % shared.cardMats.length]);
    card.rotation.x = -Math.PI / 2;
    card.rotation.z = (Math.random() - 0.5) * 0.5;
    card.position.set(-2.6 + i * 0.5, y0 + 0.02, TABLE_D / 2 - 0.45);
    card.userData.boothId = b._idx;
    grp.add(card);
  }

  // small printed name/price placard standing on the table
  const sub = (() => {
    const n = (b.cards || []).length;
    const forSale = (b.cards || []).some(c => c.status === 'sale' || c.status === 'both');
    const forTrade = (b.cards || []).some(c => c.status === 'trade' || c.status === 'both');
    return `${n} card${n !== 1 ? 's' : ''} ${forSale ? '🛒' : ''}${forTrade ? '🤝' : ''}`;
  })();
  const label = makeLabelSprite(`${b.emoji || '🃏'} ${b.isYou ? 'Your Booth' : b.owner}`, sub);
  label.position.set(0, TABLE_H + 1.5, 0);
  grp.add(label);
}

// ----------------------------------------------------- avatar meshes
function buildAvatar(color, emoji, name) {
  const g = new THREE.Group();
  const col = new THREE.Color(color || '#5ece99');
  if (avatarModel) {
    const m = avatarModel.clone(true);
    m.traverse(o => { if (o.isMesh) { o.castShadow = true; o.material = o.material.clone(); } });
    m.scale.setScalar(avatarModel.userData.fitScale || 1);
    g.add(m);
  } else {
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 1.0, 6, 12), new THREE.MeshStandardMaterial({ color: col, roughness: 0.7 }));
    body.position.y = 1.0; body.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 18, 14), new THREE.MeshStandardMaterial({ color: col.clone().offsetHSL(0, 0, 0.12), roughness: 0.6 }));
    head.position.y = 2.05; head.castShadow = true;
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), new THREE.MeshStandardMaterial({ color: 0x111317 }));
    nose.position.set(0, 2.05, 0.4);
    g.add(body, head, nose);
  }
  const label = makeLabelSprite(`${emoji || '🙂'} ${name || 'Collector'}`, '');
  label.position.set(0, 3.0, 0);
  g.add(label);
  scene.add(g);
  return { group: g, label };
}

// ----------------------------------------------------- world build
function clearGroup(grp) {
  if (!grp) return;
  grp.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { if (m.map) m.map.dispose(); m.dispose && m.dispose(); });
  });
  scene.remove(grp);
}

function buildWorld(remoteBooths) {
  const me = getCharacter() || { name: 'You', color: AVATAR_COLORS[0], emoji: AVATAR_EMOJIS[0] };
  const settings = (typeof getShowcaseSettings === 'function') ? getShowcaseSettings() : {};
  const localCards = (typeof getShowcase === 'function') ? (getShowcase() || []) : [];
  const mine = myUsername();

  let list = (Array.isArray(remoteBooths) ? remoteBooths : []).filter(b => b && b.name)
    .map(b => ({ owner: b.name, username: b.username, emoji: b.emoji, color: b.color, veriswap: b.veriswap, cards: Array.isArray(b.cards) ? b.cards : [], isYou: !!mine && b.username === mine }));
  const myBooth = list.find(b => b.isYou);
  if (myBooth) {
    myBooth.owner = me.name || myBooth.owner; myBooth.emoji = me.emoji || myBooth.emoji;
    myBooth.color = me.color || myBooth.color; myBooth.veriswap = settings.veriswap || myBooth.veriswap; myBooth.cards = localCards;
  } else {
    list.push({ owner: me.name || 'You', username: mine, emoji: me.emoji, color: me.color, veriswap: settings.veriswap || '', cards: localCards, isYou: true });
  }
  if (list.length < 6) {
    const have = new Set(list.map(b => (b.owner || '').toLowerCase()));
    for (const d of demoBooths()) { if (!have.has(d.owner.toLowerCase())) list.push(Object.assign({ isYou: false }, d)); }
  }
  list = list.slice(0, 24);

  clearGroup(worldGroup);
  worldGroup = new THREE.Group();
  scene.add(worldGroup);
  booths = [];

  // shared card geometry/materials for this build (cheap; disposed on rebuild)
  const shared = {
    flatGeo: new THREE.PlaneGeometry(0.34, 0.48),
    standGeo: new THREE.PlaneGeometry(0.22, 0.32),
    slabGeo: new THREE.PlaneGeometry(0.2, 0.28),
    cardMats: [
      new THREE.MeshBasicMaterial({ map: makeCardTex('#1f6f4a'), side: THREE.DoubleSide }),
      new THREE.MeshBasicMaterial({ map: makeCardTex('#b45309'), side: THREE.DoubleSide }),
      new THREE.MeshBasicMaterial({ map: makeCardTex('#3b5bdb'), side: THREE.DoubleSide }),
    ],
    // brushed aluminum, dark felt liner, and clear glass (use the scene
    // environment map for realistic reflections)
    alu: new THREE.MeshStandardMaterial({ color: 0xd7dade, metalness: 0.9, roughness: 0.34 }),
    aluDark: new THREE.MeshStandardMaterial({ color: 0x111319, metalness: 0.25, roughness: 0.85 }),
    glass: new THREE.MeshStandardMaterial({ color: 0xeaf2ff, metalness: 0.0, roughness: 0.04, transparent: true, opacity: 0.16 }),
  };

  const rows = Math.ceil(list.length / COLS);
  const floorDepth = ROW_Z0 + rows * ROW_DZ + 10;
  bounds = { minX: -30, maxX: 30, minZ: -10, maxZ: floorDepth };

  const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(66, floorDepth + 18),
    new THREE.MeshStandardMaterial({ color: 0x161b26, roughness: 0.96 }));
  floorMesh.rotation.x = -Math.PI / 2; floorMesh.position.set(0, 0, (floorDepth - 10) / 2); floorMesh.receiveShadow = true;
  worldGroup.add(floorMesh);
  const grid = new THREE.GridHelper(70, 35, 0x2a3550, 0x1b232f);
  grid.position.set(0, 0.02, (floorDepth - 10) / 2); worldGroup.add(grid);

  list.forEach((b, i) => {
    const col = i % COLS, row = Math.floor(i / COLS);
    const px = COL_X[col], pz = ROW_Z0 + row * ROW_DZ;
    const grp = new THREE.Group(); grp.position.set(px, 0, pz);
    b._idx = i;
    buildBoothTable(grp, b, shared);
    worldGroup.add(grp);
    booths.push({ id: i, px, pz, owner: b.owner, emoji: b.emoji, color: b.color, veriswap: b.veriswap, cards: b.cards, isYou: b.isYou });
  });

  player.x = 0; player.z = -3; yaw = 0; pitch = -0.05; camMode = 'fp';
  nearBooth = null;

  const search = document.getElementById('floor-dir-search');
  renderDirectory(search ? search.value : '');
}

function makeNpcs() {
  npcs.forEach(a => scene.remove(a.group)); npcs = [];
  for (const d of [{ name: 'Browser1', emoji: '😀', color: '#38bdf8' }, { name: 'Browser2', emoji: '🥳', color: '#fbbf24' }]) {
    const a = buildAvatar(d.color, d.emoji, d.name);
    a.x = (Math.random() - 0.5) * 26; a.z = ROW_Z0 + Math.random() * (bounds.maxZ - ROW_Z0 - 8);
    a.tx = a.x; a.tz = a.z; a.repick = 0; a.group.position.set(a.x, 0, a.z); npcs.push(a);
  }
}

// ----------------------------------------------------- movement / collide
function blocked(nx, nz) {
  if (nx < bounds.minX || nx > bounds.maxX || nz < bounds.minZ || nz > bounds.maxZ) return true;
  for (const b of booths) {
    if (nx > b.px - TABLE_W / 2 - PLAYER_R && nx < b.px + TABLE_W / 2 + PLAYER_R &&
        nz > b.pz - TABLE_D / 2 - PLAYER_R && nz < b.pz + TABLE_D / 2 + PLAYER_R) return true;
  }
  return false;
}
function nearestBooth() {
  let best = null, bestD = Infinity;
  for (const b of booths) {
    const d = Math.hypot(player.x - b.px, player.z - (b.pz - TABLE_D / 2 - 1));
    if (d < bestD) { bestD = d; best = b; }
  }
  return bestD <= INTERACT_DIST ? best : null;
}

function update(dt) {
  const k = dt * 60;
  if (camMode === 'fp') {
    let fwd = 0, strafe = 0, turn = 0;
    if (keys['w'] || touchDir.up) fwd += 1;
    if (keys['s'] || touchDir.down) fwd -= 1;
    if (keys['arrowup']) fwd += 1;
    if (keys['arrowdown']) fwd -= 1;
    if (keys['a']) strafe -= 1;
    if (keys['d']) strafe += 1;
    if (keys['arrowleft'] || touchDir.left) turn -= 1;
    if (keys['arrowright'] || touchDir.right) turn += 1;
    yaw += turn * TURN_SPEED * k;
    if (fwd || strafe) {
      const sin = Math.sin(yaw), cos = Math.cos(yaw), step = MOVE_SPEED * k;
      const nx = player.x + (sin * fwd + cos * strafe) * step;
      const nz = player.z + (cos * fwd - sin * strafe) * step;
      if (!blocked(nx, player.z)) player.x = nx;
      if (!blocked(player.x, nz)) player.z = nz;
    }
    nearBooth = nearestBooth();
    camera.position.set(player.x, EYE_H, player.z);
    const dx = Math.sin(yaw) * Math.cos(pitch), dy = Math.sin(pitch), dz = Math.cos(yaw) * Math.cos(pitch);
    camera.lookAt(player.x + dx, EYE_H + dy, player.z + dz);
    if (playerObj) playerObj.group.visible = false;   // you are the camera
  } else {
    // free-look orbit around the inspection target
    if (keys['arrowleft'] || touchDir.left) free.az -= 0.03 * k;
    if (keys['arrowright'] || touchDir.right) free.az += 0.03 * k;
    if (keys['w'] || keys['arrowup'] || touchDir.up) free.dist = Math.max(2.2, free.dist - 0.12 * k);
    if (keys['s'] || keys['arrowdown'] || touchDir.down) free.dist = Math.min(16, free.dist + 0.12 * k);
    const t = free.target;
    const cx = t.x + Math.sin(free.az) * Math.cos(free.el) * free.dist;
    const cy = t.y + Math.sin(free.el) * free.dist;
    const cz = t.z + Math.cos(free.az) * Math.cos(free.el) * free.dist;
    camera.position.lerp(new THREE.Vector3(cx, cy, cz), 0.25);
    camera.lookAt(t);
    if (playerObj) { playerObj.group.visible = true; playerObj.group.position.set(player.x, 0, player.z); playerObj.group.rotation.y = yaw; }
    nearBooth = nearestBooth();
  }

  for (const n of npcs) {
    if (n.repick <= 0 || Math.hypot(n.tx - n.x, n.tz - n.z) < 0.5) { n.tx = (Math.random() - 0.5) * 26; n.tz = ROW_Z0 + Math.random() * (bounds.maxZ - ROW_Z0 - 8); n.repick = 120 + Math.random() * 180; }
    n.repick--;
    const a = Math.atan2(n.tx - n.x, n.tz - n.z);
    n.x += Math.sin(a) * 0.04; n.z += Math.cos(a) * 0.04;
    n.group.position.set(n.x, 0, n.z); n.group.rotation.y = a; n.group.visible = remote.size === 0;
  }
  for (const r of remote.values()) { r.x += (r.tx - r.x) * 0.2; r.z += (r.tz - r.z) * 0.2; r.group.position.set(r.x, 0, r.z); }

  updatePrompt();
}

function updatePrompt() {
  const p = document.getElementById('floor-prompt');
  if (!p) return;
  if (nearBooth) { p.textContent = `Press E to visit ${nearBooth.isYou ? 'your booth' : nearBooth.owner + "'s booth"}`; p.classList.remove('hidden'); }
  else p.classList.add('hidden');
}

function loop() {
  if (!running) return;
  const view = document.getElementById('floor-view');
  if (!view || view.classList.contains('hidden')) { running = false; return; }
  const dt = Math.min(clock.getDelta(), 0.05);
  update(dt);
  renderer.render(scene, camera);
  rafId = requestAnimationFrame(loop);
}
function start() { if (!running) { running = true; clock.getDelta(); rafId = requestAnimationFrame(loop); } }
function stop() { running = false; if (rafId) cancelAnimationFrame(rafId); rafId = null; disconnectPresence(); }

// ----------------------------------------------------- three setup
function resize() {
  const wrap = document.getElementById('floor-canvas-wrap');
  if (!wrap || !renderer) return;
  const w = wrap.clientWidth || 960;
  const h = Math.max(380, Math.min(640, Math.round(w * 0.62)));
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}

async function ensureThree() {
  if (renderer) return true;
  const canvas = document.getElementById('floor-canvas');
  if (!canvas) return false;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true }); }
  catch (err) {
    console.error('[floor] WebGL unavailable:', err && err.message);
    const list = document.getElementById('floor-dir-list');
    if (list) list.innerHTML = '<p class="floor-dir-empty">3D isn\'t available on this device/browser (WebGL is off).</p>';
    return false;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c0e14);
  scene.fog = new THREE.Fog(0x0c0e14, 40, 80);
  camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 200);

  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x202838, 1.0));
  const sun = new THREE.DirectionalLight(0xffffff, 1.05);
  sun.position.set(16, 28, 10); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -45; sun.shadow.camera.right = 45; sun.shadow.camera.top = 45; sun.shadow.camera.bottom = -45;
  scene.add(sun);

  // image-based lighting so brushed aluminum + glass read correctly
  try {
    const { RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js');
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  } catch (err) { console.warn('[floor] env map unavailable:', err && err.message); }

  clock = new THREE.Clock(); playerObj = null;

  if (window.FLOOR_AVATAR_MODEL) {
    try {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const gltf = await new GLTFLoader().loadAsync(window.FLOOR_AVATAR_MODEL);
      const size = new THREE.Vector3(); new THREE.Box3().setFromObject(gltf.scene).getSize(size);
      gltf.scene.userData.fitScale = size.y ? (2.2 / size.y) : 1;
      avatarModel = gltf.scene;
    } catch (err) { console.warn('[floor] avatar model load failed:', err && err.message); }
  }

  window.addEventListener('resize', () => { if (!document.getElementById('floor-view')?.classList.contains('hidden')) resize(); });
  bindPointer(canvas);
  return true;
}

// ----------------------------------------------------- pointer / raycast
function bindPointer(canvas) {
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downX = 0, downY = 0, moved = false;
  canvas.addEventListener('pointerdown', e => { dragging = true; moved = false; lastX = downX = e.clientX; lastY = downY = e.clientY; });
  window.addEventListener('pointerup', e => {
    if (dragging && !moved) {
      const r = canvas.getBoundingClientRect();
      ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      ray.setFromCamera(ndc, camera);
      const hits = ray.intersectObjects(worldGroup ? worldGroup.children : [], true);
      for (const h of hits) { const id = h.object.userData.boothId; if (id != null) { const b = booths[id]; if (b) { openBooth(b); break; } } }
    }
    dragging = false;
  });
  window.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 5) moved = true;
    if (camMode === 'fp') { yaw += dx * 0.005; pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch - dy * 0.005)); }
    else { free.az += dx * 0.01; free.el = Math.max(0.05, Math.min(1.4, free.el - dy * 0.01)); }
  });
  canvas.addEventListener('wheel', e => {
    if (camMode !== 'free') return;
    e.preventDefault();
    free.dist = Math.max(2.2, Math.min(16, free.dist + e.deltaY * 0.01));
  }, { passive: false });
}

// ----------------------------------------------------- free-look toggle
function setFreeLook(on) {
  camMode = on ? 'free' : 'fp';
  const btn = document.getElementById('floor-freelook');
  if (btn) { btn.textContent = on ? 'Exit free look' : 'Free look'; btn.classList.toggle('active', on); }
  if (on) {
    const b = nearBooth || nearestBooth();
    if (b) free.target.set(b.px, TABLE_H + 0.5, b.pz);
    else free.target.set(player.x + Math.sin(yaw) * 3, TABLE_H + 0.4, player.z + Math.cos(yaw) * 3);
    free.az = yaw; free.el = 0.5; free.dist = 6;
  }
}

// ----------------------------------------------------- booth modal
function boothCardsHtml(b) {
  const cards = b.cards || [];
  if (!cards.length) return b.isYou
    ? '<p class="seller-empty">Your booth is empty. Add cards in the <strong>Sell</strong> tab and they\'ll appear here on the floor.</p>'
    : '<p class="seller-empty">This collector hasn\'t put any cards out yet.</p>';
  return '<div class="showcase-grid">' + cards.map(it => {
    const img = it.imageUrl ? `<img class="sc-card-img" src="${escHtml(it.imageUrl)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />` : '<div class="sc-card-img sc-card-noimg">No Image</div>';
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
    return `<div class="sc-card">${img}<div class="sc-card-body"><div class="sc-card-badges">${badges.join('')}</div><div class="sc-card-title">${escHtml(it.title || 'Card')}</div>${it.note ? `<div class="sc-card-note">${escHtml(it.note)}</div>` : ''}${price}<div class="sc-card-links">${links.join('')}</div></div></div>`;
  }).join('') + '</div>';
}
function openBooth(b) {
  const modal = document.getElementById('floor-booth-modal');
  const title = document.getElementById('floor-booth-title');
  const sub = document.getElementById('floor-booth-sub');
  const body = document.getElementById('floor-booth-body');
  if (!modal || !body) return;
  if (title) title.textContent = (b.emoji || '🃏') + ' ' + (b.isYou ? 'Your Booth' : b.owner + "'s Booth");
  if (sub) sub.textContent = b.isYou ? 'This is what other collectors see when they visit you. Edit it in the Sell tab.' : 'Buy hands off to eBay; trade hands off to Veriswap. The Card Huddle isn\'t part of the deal.';
  body.innerHTML = boothCardsHtml(b);
  modal.classList.remove('hidden');
}
function closeBooth() { document.getElementById('floor-booth-modal')?.classList.add('hidden'); }

// ----------------------------------------------------- directory
function renderDirectory(filter) {
  const listEl = document.getElementById('floor-dir-list');
  if (!listEl) return;
  if (!booths.length) { listEl.innerHTML = '<p class="floor-dir-empty">Loading the floor…</p>'; return; }
  const q = (filter || '').trim().toLowerCase();
  const rows = booths.filter(b => !q || (b.owner || '').toLowerCase().includes(q)).map(b => {
    const n = (b.cards || []).length;
    const forSale = (b.cards || []).some(c => c.status === 'sale' || c.status === 'both');
    const forTrade = (b.cards || []).some(c => c.status === 'trade' || c.status === 'both');
    const tags = (forSale ? '🛒' : '') + (forTrade ? '🤝' : '');
    return `<div class="floor-dir-row"><span class="floor-dir-emoji">${escHtml(b.emoji || '🃏')}</span><span class="floor-dir-name">${escHtml(b.isYou ? 'You' : (b.owner || 'Collector'))}${b.isYou ? ' <span class="floor-dir-youbadge">YOUR BOOTH</span>' : ''}</span><span class="floor-dir-meta">${n} card${n !== 1 ? 's' : ''} ${tags}</span><span class="floor-dir-acts"><button type="button" class="floor-dir-visit" data-booth="${b.id}">Visit</button><button type="button" class="floor-dir-walk" data-booth="${b.id}">Walk</button></span></div>`;
  }).join('');
  listEl.innerHTML = rows || '<p class="floor-dir-empty">No collectors match that search.</p>';
}
function boothById(id) { return booths.find(b => String(b.id) === String(id)); }
function walkToBooth(b) {
  if (!b) return;
  player.x = b.px; player.z = b.pz - TABLE_D / 2 - 2.4; yaw = 0; camMode = 'fp';
  setFreeLook(false);
}
function updateOnlineCount() { const el = document.getElementById('floor-online'); if (el) el.textContent = `🟢 ${remote.size + 1} on the floor`; }

// ----------------------------------------------------- presence
function connectPresence() {
  if (ws || typeof WebSocket === 'undefined') return;
  let sock;
  try { const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'; sock = new WebSocket(`${proto}//${location.host}/api/floor/ws`); }
  catch (_) { return; }
  ws = sock;
  sock.addEventListener('open', () => {
    const me = getCharacter() || {};
    sendWs({ t: 'join', name: me.name || 'Collector', emoji: me.emoji || '🙂', color: me.color || '#5ece99', username: myUsername(), x: round1(player.x), y: round1(player.z) });
    lastSent = { x: null, z: null };
    moveTimer = setInterval(() => { const x = round1(player.x), z = round1(player.z); if (x === lastSent.x && z === lastSent.z) return; lastSent = { x, z }; sendWs({ t: 'move', x, y: z }); }, 100);
  });
  sock.addEventListener('message', evt => {
    let msg; try { msg = JSON.parse(evt.data); } catch (_) { return; }
    if (msg.t === 'welcome') { wsId = msg.id; for (const r of remote.values()) scene.remove(r.group); remote.clear(); for (const p of (msg.players || [])) addRemote(p); }
    else if (msg.t === 'join' && msg.player) addRemote(msg.player);
    else if (msg.t === 'move') { const r = remote.get(msg.id); if (r) { r.tx = msg.x; r.tz = msg.y; } }
    else if (msg.t === 'leave') { const r = remote.get(msg.id); if (r) { scene.remove(r.group); remote.delete(msg.id); } }
    updateOnlineCount();
  });
  const onClose = () => {
    if (moveTimer) { clearInterval(moveTimer); moveTimer = null; }
    if (ws === sock) ws = null;
    for (const r of remote.values()) scene.remove(r.group); remote.clear(); updateOnlineCount();
    if (running && !reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; if (running) connectPresence(); }, 2500);
  };
  sock.addEventListener('close', onClose);
  sock.addEventListener('error', () => { try { sock.close(); } catch (_) {} });
}
function addRemote(p) {
  if (!p || !p.id || p.id === wsId) return;
  const a = buildAvatar(p.color, p.emoji, p.name);
  a.x = p.x || 0; a.z = p.y || 0; a.tx = a.x; a.tz = a.z; a.group.position.set(a.x, 0, a.z);
  remote.set(p.id, a);
}
function disconnectPresence() {
  if (moveTimer) { clearInterval(moveTimer); moveTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
  for (const r of remote.values()) scene && scene.remove(r.group); remote.clear(); wsId = null;
}
function sendWs(o) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(o)); } catch (_) {} } }
function round1(n) { return Math.round(n * 10) / 10; }

// ----------------------------------------------------- char create
function renderCharCreate() {
  const cc = document.getElementById('floor-charcreate');
  const stage = document.getElementById('floor-stage');
  if (stage) stage.classList.add('hidden');
  if (cc) cc.classList.remove('hidden');
  const existing = getCharacter();
  if (existing) ccDraft = { color: existing.color, emoji: existing.emoji };
  const nameEl = document.getElementById('floor-cc-name');
  if (nameEl) nameEl.value = existing ? (existing.name || '') : '';
  const colorWrap = document.getElementById('floor-cc-colors');
  if (colorWrap) colorWrap.innerHTML = AVATAR_COLORS.map(c => `<button type="button" class="floor-swatch${c === ccDraft.color ? ' sel' : ''}" style="background:${c}" data-color="${c}"></button>`).join('');
  const emojiWrap = document.getElementById('floor-cc-emojis');
  if (emojiWrap) emojiWrap.innerHTML = AVATAR_EMOJIS.map(e => `<button type="button" class="floor-emoji${e === ccDraft.emoji ? ' sel' : ''}" data-emoji="${e}">${e}</button>`).join('');
}

async function enterFloor() {
  document.getElementById('floor-charcreate')?.classList.add('hidden');
  const stage = document.getElementById('floor-stage');
  if (stage) stage.classList.remove('hidden');
  const me = getCharacter();
  const hud = document.getElementById('floor-hud-name');
  if (hud && me) hud.textContent = `${me.emoji || '🙂'} ${me.name || 'You'}`;

  const ok = await ensureThree();
  if (!ok) return;
  resize();
  booths = []; renderDirectory('');

  let remoteBooths = [];
  try { const res = await fetch('/api/floor/booths'); if (res.ok) { const data = await res.json(); remoteBooths = Array.isArray(data.booths) ? data.booths : []; } } catch (_) {}

  buildWorld(remoteBooths);
  if (playerObj) scene.remove(playerObj.group);
  playerObj = buildAvatar(me?.color, me?.emoji, me?.name || 'You');
  makeNpcs();
  setFreeLook(false);
  start();
  updateOnlineCount();
  connectPresence();
}

// ----------------------------------------------------- public entry
window.initFloor = function () { if (getCharacter()) enterFloor(); else renderCharCreate(); };
window.stopFloor = stop;
window.editCharacter = function () { stop(); renderCharCreate(); };
window.saveCharacterAndEnter = function () {
  const name = (document.getElementById('floor-cc-name')?.value || '').trim();
  if (!name) { alert('Pick a display name for your collector.'); return; }
  saveCharacter({ name, color: ccDraft.color, emoji: ccDraft.emoji });
  enterFloor();
};
window.closeBoothModal = closeBooth;
window.toggleFreeLook = function () { setFreeLook(camMode !== 'free'); };

// ----------------------------------------------------- input wiring
document.addEventListener('keydown', e => {
  const view = document.getElementById('floor-view');
  if (!view || view.classList.contains('hidden')) return;
  if (document.activeElement && document.activeElement.id === 'floor-cc-name') return;
  const k = e.key.toLowerCase();
  if (k === 'f') { e.preventDefault(); setFreeLook(camMode !== 'free'); return; }
  if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'w', 'a', 's', 'd'].includes(k)) { e.preventDefault(); keys[k] = true; }
  if (k === 'e') { e.preventDefault(); if (nearBooth) openBooth(nearBooth); }
});
document.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
document.addEventListener('input', e => { if (e.target && e.target.id === 'floor-dir-search') renderDirectory(e.target.value); });
document.addEventListener('click', e => {
  const sw = e.target.closest('.floor-swatch');
  if (sw) { ccDraft.color = sw.dataset.color; renderCharCreate(); return; }
  const em = e.target.closest('.floor-emoji');
  if (em) { ccDraft.emoji = em.dataset.emoji; renderCharCreate(); return; }
  const visit = e.target.closest('.floor-dir-visit');
  if (visit) { const b = boothById(visit.dataset.booth); if (b) openBooth(b); return; }
  const walk = e.target.closest('.floor-dir-walk');
  if (walk) { const b = boothById(walk.dataset.booth); if (b) walkToBooth(b); return; }
});
function bindDpad() {
  document.querySelectorAll('.floor-dbtn').forEach(btn => {
    const dir = btn.dataset.dir;
    const on = ev => { ev.preventDefault(); if (dir === 'action') { if (nearBooth) openBooth(nearBooth); return; } touchDir[dir] = true; };
    const off = ev => { ev.preventDefault(); if (dir !== 'action') touchDir[dir] = false; };
    btn.addEventListener('touchstart', on, { passive: false });
    btn.addEventListener('touchend', off, { passive: false });
    btn.addEventListener('touchcancel', off, { passive: false });
    btn.addEventListener('mousedown', on); btn.addEventListener('mouseup', off); btn.addEventListener('mouseleave', off);
  });
}
bindDpad();
