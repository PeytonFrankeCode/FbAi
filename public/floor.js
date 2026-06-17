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

// Character customization palettes (a "definitive collector" you build part by
// part). Shirt reuses AVATAR_COLORS; the rest get their own sets.
const SKIN_TONES = ['#f7d7b5', '#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#5a3825'];
const SHIRT_COLORS = AVATAR_COLORS;
const PANTS_COLORS = ['#2b3a55', '#1f2937', '#4b5563', '#8b7355', '#3b5bdb', '#5b3a29'];
const HAIR_COLORS = ['#1b1b1b', '#3b2417', '#6b4423', '#b8860b', '#d9b382', '#9aa0a6', '#ececec'];
const HAIR_STYLES = [{ id: 'short', label: 'Short' }, { id: 'buzz', label: 'Buzz' }, { id: 'curly', label: 'Curly' }, { id: 'long', label: 'Long' }, { id: 'bald', label: 'Bald' }];
const HATS = [{ id: 'none', label: 'None' }, { id: 'cap', label: 'Cap' }, { id: 'beanie', label: 'Beanie' }];
const ACCESSORIES = [{ id: 'none', label: 'None' }, { id: 'glasses', label: 'Glasses' }];

// Fill in any missing fields (and migrate the old {color} shape → {shirt}).
function normalizeCharacter(c) {
  c = c || {};
  const shirt = c.shirt || c.color || SHIRT_COLORS[0];
  return {
    name: c.name || 'Collector',
    emoji: c.emoji || AVATAR_EMOJIS[0],
    skin: c.skin || SKIN_TONES[1],
    shirt,
    pants: c.pants || PANTS_COLORS[0],
    hair: c.hair || HAIR_COLORS[0],
    hairStyle: c.hairStyle || 'short',
    hat: c.hat || 'none',
    accessory: c.accessory || 'none',
    color: shirt,                         // keep legacy field = shirt for the booth index
  };
}
function randomCharacter(name) {
  const pick = a => a[Math.floor(Math.random() * a.length)];
  return normalizeCharacter({
    name, emoji: pick(AVATAR_EMOJIS), skin: pick(SKIN_TONES), shirt: pick(SHIRT_COLORS),
    pants: pick(PANTS_COLORS), hair: pick(HAIR_COLORS), hairStyle: pick(['short', 'buzz', 'curly', 'long', 'bald']),
    hat: pick(['none', 'none', 'cap', 'beanie']), accessory: pick(['none', 'none', 'glasses']),
  });
}

const TABLE_W = 6.2, TABLE_D = 2.4, TABLE_H = 1.05;   // 6ft folding table
const PLAYER_R = 0.6, MOVE_SPEED = 0.2, TURN_SPEED = 0.04;
const INTERACT_DIST = 4.6;
const EYE_H = 2.55;                                    // taller collector: eye well above the glass
const PITCH_MIN = -1.2, PITCH_MAX = 1.0;
// Real card-show layout: booths line all four walls (with angled corner
// booths), interior tables form north–south aisle rows, and there's a main
// entrance gap at the front. Each slot can carry a yaw so tables face the aisle.
const FLOOR_MAX_TABLES = 60;                           // capacity for the new layout

// Booth layout: each table has BOOTH_SLOTS placement spots in a single row.
// Owners arrange them in the editor; each spot holds one fixture (or is empty).
const LAYOUT_KEY = 'cardHuddleBoothLayout';
const BOOTH_SLOTS = 5;
const SLOT_W = 1.12;                                   // spot width along the table
const LAYOUT_TYPES = ['showcase', 'stand', 'valuebox', 'empty'];
const DEFAULT_LAYOUT = ['showcase', 'showcase', 'stand', 'stand', 'valuebox'];
const FIXTURES = [
  { id: 'showcase', label: 'Showcase', icon: '🧳', desc: 'Glass case of featured cards' },
  { id: 'stand',    label: 'Card stand', icon: '🃏', desc: 'Cards standing up front' },
  { id: 'valuebox', label: 'Value box', icon: '💲', desc: 'Bulk / dollar box' },
  { id: 'empty',    label: 'Empty',    icon: '▫️', desc: 'Clear this spot' },
];
function slotX(i) { return -((BOOTH_SLOTS - 1) / 2) * SLOT_W + i * SLOT_W; }
function getBoothLayout() {
  try { const a = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); return Array.isArray(a) ? a : null; }
  catch { return null; }
}
function saveBoothLayout(arr) {
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(arr));
  if (typeof schedulePushUserData === 'function') schedulePushUserData();
}
// Resolve a booth's layout to a clean BOOTH_SLOTS-long array (own booth uses
// the live local layout; visitors use the server-mirrored one; fall back to
// the classic default when none is set).
function resolveLayout(b) {
  const raw = (b && b.isYou) ? getBoothLayout() : (b && b.layout);
  const src = (Array.isArray(raw) && raw.length) ? raw : DEFAULT_LAYOUT;
  const out = [];
  for (let i = 0; i < BOOTH_SLOTS; i++) out.push(LAYOUT_TYPES.includes(src[i]) ? src[i] : 'empty');
  return out;
}

let renderer, scene, camera, clock;
let worldGroup = null;
let booths = [];
let lastRemoteBooths = [];            // cached booth feed for live rebuilds (booth editor)
let tableRects = [];                  // all table footprints (occupied + vacant) for collision
let hall = null;
let bounds = { minX: -30, maxX: 30, minZ: -10, maxZ: 44 };
let rafId = null, running = false;
let avatarModel = null;

const player = { x: 0, z: -3 };
let yaw = 0, pitch = -0.12;
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

let ccDraft = normalizeCharacter(null);

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
  // 2x canvas resolution so nameplates stay crisp when scaled up in 3D
  const cw = 512, ch = 192;
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const c = cv.getContext('2d');
  c.fillStyle = 'rgba(12,14,20,0.82)'; roundRectCtx(c, 8, 8, cw - 16, ch - 16, 28); c.fill();
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillStyle = '#edf0f7'; c.font = '700 60px system-ui, sans-serif';
  c.fillText(title.slice(0, 18), cw / 2, sub ? 76 : ch / 2);
  if (sub) { c.fillStyle = '#94a3b8'; c.font = '44px system-ui, sans-serif'; c.fillText(sub.slice(0, 22), cw / 2, 140); }
  const tex = new THREE.CanvasTexture(cv); tex.anisotropy = aniso();
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  spr.scale.set(3.6, 1.35, 1);
  return spr;
}
function roundRectCtx(c, x, y, w, h, r) {
  c.beginPath(); c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}

// a generic card face (white card with a colored header + image box) — drawn
// at 2x so the placeholder slabs stay crisp up close
function makeCardTex(header) {
  const cv = document.createElement('canvas'); cv.width = 240; cv.height = 336;
  const c = cv.getContext('2d');
  c.fillStyle = '#f6f6f1'; c.fillRect(0, 0, 240, 336);
  c.fillStyle = header; c.fillRect(0, 0, 240, 44);
  c.fillStyle = '#cdd2db'; c.fillRect(22, 60, 196, 184);
  c.fillStyle = '#a7afbd'; c.fillRect(22, 260, 196, 16); c.fillRect(22, 288, 140, 16);
  c.strokeStyle = '#e2e2e2'; c.lineWidth = 8; c.strokeRect(4, 4, 232, 328);
  const t = new THREE.CanvasTexture(cv); t.anisotropy = aniso(); return t;
}

// ---- real card photos -------------------------------------------------
// Load each showcased card's actual image and lay it under the glass.
// Textures are cached per-build (cleared on rebuild in buildWorld) and load
// lazily; on any failure (CORS / 404) we keep the generic slab so the case
// never shows a blank black square.
let _cardTexLoader = null;
const _cardTexCache = new Map();
function applyCardImage(mat, url) {
  if (!url) return;
  const cached = _cardTexCache.get(url);
  if (cached) { mat.map = cached; mat.needsUpdate = true; return; }
  if (!_cardTexLoader) { _cardTexLoader = new THREE.TextureLoader(); _cardTexLoader.setCrossOrigin('anonymous'); }
  _cardTexLoader.load(url, t => {
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso();
    _cardTexCache.set(url, t);
    mat.map = t; mat.needsUpdate = true;
  }, undefined, () => { /* keep the generic fallback already on `mat` */ });
}
// Material for one showcased card: the real photo if it has one (with the
// generic slab as the loading/fallback face), otherwise a shared generic slab.
function cardMaterial(card, shared, slot) {
  const fallback = shared.cardMats[slot % shared.cardMats.length];
  const url = card && card.imageUrl;
  if (!url) return fallback;
  const mat = new THREE.MeshBasicMaterial({ map: fallback.map, side: THREE.DoubleSide });
  applyCardImage(mat, url);
  return mat;
}

// A closed aluminum briefcase display case: brushed-metal tray, dark felt
// liner, a tight grid of slabs laid flat, a clear glass lid, side rails,
// a carry handle and latches on the front edge. Modeled on a real case.
function buildDisplayCase(parent, ox, oz, w, d, y0, boothIdx, shared, cards, cardOffset, cols, rows) {
  const g = new THREE.Group();
  g.position.set(ox, 0, oz);
  const CASE_H = 0.16;
  cols = cols || 6; rows = rows || 3;

  const tray = new THREE.Mesh(new THREE.BoxGeometry(w, CASE_H, d), shared.alu);
  tray.position.y = y0 + CASE_H / 2; tray.castShadow = true; tray.receiveShadow = true;
  tray.userData.boothId = boothIdx; g.add(tray);

  const liner = new THREE.Mesh(new THREE.BoxGeometry(w - 0.14, 0.02, d - 0.14), shared.aluDark);
  liner.position.y = y0 + CASE_H + 0.01; g.add(liner);

  // Slabs laid flat under the glass — each shows the real photo of the booth's
  // showcased card (cards[cardOffset + slot]); empty slots fall back to a
  // generic slab so the case still reads full.
  const cw = (w - 0.18) / cols, cd = (d - 0.18) / rows;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const slot = r * cols + c;
    const entry = cards && cards[(cardOffset || 0) + slot];
    const card = new THREE.Mesh(shared.slabGeo, cardMaterial(entry, shared, slot));
    card.rotation.x = -Math.PI / 2;
    card.rotation.z = Math.PI;          // spin in-plane so the laid-flat photo reads upright to the buyer
    card.position.set(-w / 2 + 0.09 + cw / 2 + c * cw, y0 + CASE_H + 0.03, -d / 2 + 0.09 + cd / 2 + r * cd);
    card.userData.boothId = boothIdx;   // tap a card to open the booth
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
  // Premium cards fill the showcases/stands; value-box-flagged cards fill the
  // value boxes — each pool has its own click menu.
  const allCards = b.cards || [];
  const showCards = allCards.filter(c => !c.valueBox);
  const valueCards = allCards.filter(c => c.valueBox);

  // --- fixtures, placed per the owner's chosen layout (5 spots across the
  //     table). The booth's real cards flow into showcases and stands in order.
  const layout = resolveLayout(b);
  let ci = 0;                                          // card cursor across fixtures
  for (let s = 0; s < BOOTH_SLOTS; s++) {
    const x = slotX(s);
    const type = layout[s];
    if (type === 'showcase') ci = buildShowcaseFixture(grp, x, y0, b._idx, shared, showCards, ci);
    else if (type === 'stand') ci = buildStandFixture(grp, x, y0, b._idx, shared, showCards, ci);
    else if (type === 'valuebox') buildValueBoxFixture(grp, x, y0, b._idx, shared, valueCards);
    // 'empty' → leave the spot open
  }

  // --- loose lay-down area (front center): the booth's first few cards laid
  //     flat on the cloth, showing their real photos up close to the buyer ---
  for (let i = 0; i < 4; i++) {
    const card = new THREE.Mesh(shared.flatGeo, cardMaterial(showCards[i], shared, i));
    card.rotation.x = -Math.PI / 2;
    card.rotation.z = Math.PI + (Math.random() - 0.5) * 0.5;   // upright to the buyer, with a slight scatter
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

// ----------------------------------------------------- booth fixtures
// Each builder drops one fixture centred at table-x `x` and returns the
// advanced card cursor so the next fixture continues the booth's card list.

// A slot-sized aluminium showcase: a closed glass case with a 3×3 grid of
// real card photos laid flat under the glass. Consumes up to 9 cards.
function buildShowcaseFixture(grp, x, y0, boothId, shared, cards, ci) {
  buildDisplayCase(grp, x, 0, 1.0, 1.35, y0, boothId, shared, cards, ci, 3, 3);
  return ci + 9;
}

// One acrylic display stand: a glossy black base with a near-clear acrylic
// back panel holding a single card upright and facing the buyer (-z).
function buildAcrylicStand(grp, sx, sz, y0, boothId, shared, cards, ciRef) {
  const baseH = 0.06, panelH = 0.66, W = 0.36;
  const base = new THREE.Mesh(new THREE.BoxGeometry(W, baseH, 0.2), shared.blackAcrylic);
  base.position.set(sx, y0 + baseH / 2, sz); base.castShadow = true; base.receiveShadow = true;
  base.userData.boothId = boothId; grp.add(base);
  const panel = new THREE.Mesh(new THREE.BoxGeometry(W, panelH, 0.03), shared.clearAcrylic);
  panel.position.set(sx, y0 + baseH + panelH / 2, sz + 0.02); panel.userData.boothId = boothId; grp.add(panel);
  // one tall card, just in front of the panel, facing the buyer
  const entry = cards[ciRef.i];
  const card = new THREE.Mesh(shared.standCardGeo, cardMaterial(entry, shared, ciRef.i + 1));
  card.position.set(sx, y0 + baseH + 0.27, sz - 0.005);
  card.rotation.y = Math.PI;                    // front faces -z (the buyer)
  card.userData.boothId = boothId;
  grp.add(card);
  if (entry) ciRef.i++;
}

// A card-stand fixture: a row of acrylic display stands across the slot, each
// holding one card face-out. The booth's real cards fill them in order.
function buildStandFixture(grp, x, y0, boothId, shared, cards, ci) {
  const STANDS = 3, gap = 0.36;
  const ciRef = { i: ci };
  for (let s = 0; s < STANDS; s++) {
    const sx = x + (s - (STANDS - 1) / 2) * gap;
    buildAcrylicStand(grp, sx, 0.18, y0, boothId, shared, cards, ciRef);  // toward the front edge
  }
  return ciRef.i;
}

// A value box: a white cardboard "dollar box" (open top) packed with rows of
// cards standing upright, with a couple of coloured divider tabs and a hand-
// lettered price tab. Holds the booth's value-box-flagged cards; clicking it
// opens its own Value Box menu (userData.menu = 'value').
function buildValueBoxFixture(grp, x, y0, boothId, shared, cards) {
  const tag2 = (m) => { m.userData.boothId = boothId; m.userData.menu = 'value'; return m; };
  const W = 1.02, D = 1.34, H = 0.32, t = 0.04;
  cards = cards || [];
  // box floor + four low walls (reads as an open-top row box)
  const fl = new THREE.Mesh(new THREE.BoxGeometry(W, 0.03, D), shared.cardboardDark);
  fl.position.set(x, y0 + 0.015, 0); fl.receiveShadow = true; tag2(fl); grp.add(fl);
  const longWall = new THREE.BoxGeometry(W + t, H, t), shortWall = new THREE.BoxGeometry(t, H, D);
  for (const dz of [-D / 2, D / 2]) { const m = new THREE.Mesh(longWall, shared.cardboard); m.position.set(x, y0 + H / 2, dz); m.castShadow = true; tag2(m); grp.add(m); }
  for (const dx of [-W / 2, W / 2]) { const m = new THREE.Mesh(shortWall, shared.cardboard); m.position.set(x + dx, y0 + H / 2, 0); m.castShadow = true; tag2(m); grp.add(m); }
  // packed rows of cards standing up the length of the box (real photos where
  // the booth has value cards, generic filler beyond that so the box reads full)
  const n = 30, z0 = -D / 2 + 0.08, span = D - 0.16;
  for (let i = 0; i < n; i++) {
    const entry = cards[i % Math.max(1, cards.length)];
    const card = new THREE.Mesh(shared.standGeo, cards.length ? cardMaterial(entry, shared, i) : shared.cardMats[i % shared.cardMats.length]);
    card.position.set(x, y0 + 0.18, z0 + (i / (n - 1)) * span);
    card.rotation.y = Math.PI;          // face the buyer (-z) so photos aren't shown reversed
    tag2(card); grp.add(card);
  }
  // a few coloured divider tabs poking up above the cards
  const tabGeo = new THREE.PlaneGeometry(0.26, 0.12);
  const tabCols = [0x4caf50, 0xf4d03f, 0xe74c3c];
  [0.18, 0.5, 0.82].forEach((f, k) => {
    const tab = new THREE.Mesh(tabGeo, new THREE.MeshStandardMaterial({ color: tabCols[k % tabCols.length], roughness: 0.85, side: THREE.DoubleSide }));
    tab.position.set(x, y0 + 0.40, z0 + f * span); tag2(tab); grp.add(tab);
  });
  // hand-lettered "$1 BOX" price tab on the front wall
  const tag = makeLabelSprite('💲 $1 BOX', '');
  tag.scale.set(1.5, 0.56, 1);
  tag.position.set(x, y0 + 0.5, -D / 2 - 0.04);
  grp.add(tag);
}

// ----------------------------------------------------- avatar meshes
// Build a segmented humanoid from a normalized character: legs (pants), torso
// + arms (shirt), head/hands (skin), hair (style + colour), optional hat and
// glasses. Roughly 3.7m tall so the eyes clear the display-case glass.
function buildFigure(char) {
  const g = new THREE.Group();
  const std = (hex, rough) => new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: rough == null ? 0.7 : rough });
  const shirtMat = std(char.shirt, 0.72), pantsMat = std(char.pants, 0.8);
  const skinMat = std(char.skin, 0.55), hairMat = std(char.hair, 0.85), darkMat = std('#15171c', 0.5);

  // legs + shoes
  for (const lx of [-0.24, 0.24]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.34, 1.5, 0.4), pantsMat);
    leg.position.set(lx, 0.78, 0); leg.castShadow = true; g.add(leg);
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.18, 0.6), darkMat);
    shoe.position.set(lx, 0.09, 0.1); shoe.castShadow = true; g.add(shoe);
  }
  // torso
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.92, 1.5, 0.56), shirtMat);
  torso.position.set(0, 2.25, 0); torso.castShadow = true; g.add(torso);
  // arms (shirt) with skin hands
  for (const ax of [-0.62, 0.62]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.26, 1.3, 0.3), shirtMat);
    arm.position.set(ax, 2.3, 0); arm.castShadow = true; g.add(arm);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), skinMat);
    hand.position.set(ax, 1.6, 0); hand.castShadow = true; g.add(hand);
  }
  // neck + head
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.2, 10), skinMat);
  neck.position.set(0, 3.05, 0); g.add(neck);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.44, 20, 16), skinMat);
  head.position.set(0, 3.45, 0); head.castShadow = true; g.add(head);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), skinMat);
  nose.position.set(0, 3.42, 0.44); g.add(nose);

  // hair
  if (char.hairStyle && char.hairStyle !== 'bald') {
    if (char.hairStyle === 'curly') {
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        const curl = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 8), hairMat);
        curl.position.set(Math.cos(a) * 0.3, 3.7 + Math.sin(i) * 0.05, Math.sin(a) * 0.3 - 0.05);
        g.add(curl);
      }
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.46, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), hairMat);
      cap.position.set(0, 3.45, 0); g.add(cap);
    } else {
      const cut = char.hairStyle === 'buzz' ? 0.4 : 0.62;
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.47, 18, 14, 0, Math.PI * 2, 0, Math.PI * cut), hairMat);
      cap.position.set(0, 3.45, -0.02); g.add(cap);
      if (char.hairStyle === 'long') {
        const back = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.2), hairMat);
        back.position.set(0, 3.15, -0.34); g.add(back);
      }
    }
  }
  // hat (matches the shirt colour like team gear)
  if (char.hat === 'cap') {
    const crown = new THREE.Mesh(new THREE.SphereGeometry(0.48, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.5), shirtMat);
    crown.position.set(0, 3.5, 0); g.add(crown);
    const brim = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.08, 0.4), shirtMat);
    brim.position.set(0, 3.52, 0.46); g.add(brim);
  } else if (char.hat === 'beanie') {
    const beanie = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.62), shirtMat);
    beanie.position.set(0, 3.46, 0); g.add(beanie);
    const fold = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.07, 8, 20), shirtMat);
    fold.position.set(0, 3.46, 0); fold.rotation.x = Math.PI / 2; g.add(fold);
  }
  // glasses
  if (char.accessory === 'glasses') {
    for (const gx of [-0.18, 0.18]) {
      const lens = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.025, 8, 16), darkMat);
      lens.position.set(gx, 3.46, 0.42); g.add(lens);
    }
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.03, 0.03), darkMat);
    bridge.position.set(0, 3.46, 0.43); g.add(bridge);
  }
  return g;
}

function buildAvatar(char) {
  char = normalizeCharacter(char);
  const g = new THREE.Group();
  if (avatarModel) {
    const m = avatarModel.clone(true);
    m.traverse(o => { if (o.isMesh) { o.castShadow = true; o.material = o.material.clone(); } });
    m.scale.setScalar(avatarModel.userData.fitScale || 1);
    g.add(m);
  } else {
    g.add(buildFigure(char));
  }
  const label = makeLabelSprite(`${char.emoji || '🙂'} ${char.name || 'Collector'}`, '');
  label.position.set(0, 4.2, 0);
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

  lastRemoteBooths = Array.isArray(remoteBooths) ? remoteBooths : [];
  let list = lastRemoteBooths.filter(b => b && b.name)
    .map(b => ({ owner: b.name, username: b.username, emoji: b.emoji, color: b.color, veriswap: b.veriswap, cards: Array.isArray(b.cards) ? b.cards : [], layout: Array.isArray(b.layout) ? b.layout : null, isYou: !!mine && b.username === mine }));
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

  clearGroup(worldGroup);
  // the old build's card photos were disposed by clearGroup; drop the cache so
  // the new build reloads fresh textures rather than reusing dead ones
  _cardTexCache.clear();
  worldGroup = new THREE.Group();
  scene.add(worldGroup);
  booths = [];

  // shared card geometry/materials for this build (cheap; disposed on rebuild)
  const shared = {
    flatGeo: new THREE.PlaneGeometry(0.34, 0.48),
    standGeo: new THREE.PlaneGeometry(0.22, 0.32),
    slabGeo: new THREE.PlaneGeometry(0.24, 0.33),
    standCardGeo: new THREE.PlaneGeometry(0.34, 0.48),  // single face-out card in an acrylic stand
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
    // glossy black acrylic base + near-clear acrylic for the upright card stands
    blackAcrylic: new THREE.MeshStandardMaterial({ color: 0x0a0a0c, metalness: 0.3, roughness: 0.12 }),
    clearAcrylic: new THREE.MeshStandardMaterial({ color: 0xeef4ff, metalness: 0.0, roughness: 0.03, transparent: true, opacity: 0.14 }),
    // white cardboard row-box (the "dollar box") and its shaded interior
    cardboard: new THREE.MeshStandardMaterial({ color: 0xe9e4d7, roughness: 0.96 }),
    cardboardDark: new THREE.MeshStandardMaterial({ color: 0xcabfa8, roughness: 0.98 }),
  };

  list = list.slice(0, FLOOR_MAX_TABLES);

  hall = computeHall();
  bounds = { minX: hall.minX + 1.5, maxX: hall.maxX - 1.5, minZ: hall.minZ + 1.5, maxZ: hall.maxZ - 1.5 };
  tableRects = [];

  buildRoom(worldGroup, hall);

  // place tables into the slots — occupied booths first (detailed), the rest
  // are vacant ("available") tables so the hall reads full and has 50+ spots.
  const slots = hall.slots.slice(0, FLOOR_MAX_TABLES);
  const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex(), transparent: true, opacity: 0.5, depthWrite: false });
  const shadowGeo = new THREE.PlaneGeometry(TABLE_W + 1.4, TABLE_D + 1.4);
  slots.forEach((s, i) => {
    const grp = new THREE.Group(); grp.position.set(s.x, 0, s.z); grp.rotation.y = s.rot || 0;
    tableRects.push({ px: s.x, pz: s.z, rot: s.rot || 0 });
    // shadow lives in the table group so it rotates with the (possibly angled) table
    const sh = new THREE.Mesh(shadowGeo, shadowMat); sh.rotation.x = -Math.PI / 2; sh.position.set(0, 0.05, 0); grp.add(sh);
    if (i < list.length) {
      const b = list[i]; b._idx = booths.length;
      buildBoothTable(grp, b, shared);
      booths.push({ id: b._idx, px: s.x, pz: s.z, rot: s.rot || 0, owner: b.owner, username: b.username, emoji: b.emoji, color: b.color, veriswap: b.veriswap, cards: b.cards, isYou: b.isYou });
    } else {
      buildVacantTable(grp);
    }
    worldGroup.add(grp);
  });

  // spawn at the entrance (front-center), facing into the hall
  player.x = 0; player.z = hall.minZ + 3; yaw = 0; pitch = -0.12; camMode = 'fp';
  nearBooth = null;

  const search = document.getElementById('floor-dir-search');
  renderDirectory(search ? search.value : '');
}

// Compute the show floor: booth slots (each {x,z,rot}), hall bounds, and the
// entrance position. Models a real card show — a perimeter ring of booths with
// angled corners, plus interior back-to-back aisle rows.
function computeHall() {
  const slots = [];
  const add = (x, z, rot) => slots.push({ x, z, rot: rot || 0 });
  const TW = TABLE_W, TD = TABLE_D;

  // ---------- interior aisle rows (back-to-back pairs) ----------
  const pairs = 3, perCol = 4;
  const stepZ = TW + 0.8;                 // tables stacked along z (long side runs N–S)
  const pairW = TD + 0.1;                 // two tables back-to-back
  const pitchX = pairW + 6.4;             // pair pitch (≈6.4 aisle)
  const intW = (pairs - 1) * pitchX;
  const zc = 6;                           // interior vertical centre
  for (let p = 0; p < pairs; p++) {
    const px = -intW / 2 + p * pitchX;
    for (let k = 0; k < perCol; k++) {
      const z = zc + (k - (perCol - 1) / 2) * stepZ;
      add(px - pairW / 2, z, Math.PI / 2);    // left column faces -x
      add(px + pairW / 2, z, -Math.PI / 2);   // right column faces +x
    }
  }
  const intHalfX = intW / 2 + pairW / 2;
  const intTopZ = zc + ((perCol - 1) / 2) * stepZ;
  const intBotZ = zc - ((perCol - 1) / 2) * stepZ;

  // ---------- perimeter ring ----------
  const ring = 7.5;                        // walkway between interior and wall booths
  const sideX = intHalfX + TD / 2 + ring;  // x of left/right wall-booth centres
  const topZ = intTopZ + TW / 2 + ring;    // back row z
  const botZ = intBotZ - TW / 2 - ring;    // front (entrance) row z

  // left & right wall columns (face inward), strictly between the corners
  const colSpanZ = topZ - botZ;
  const colN = Math.max(3, Math.round(colSpanZ / (TW + 1.0)));
  for (let i = 0; i < colN; i++) {
    const z = botZ + (i + 1) * (colSpanZ / (colN + 1));
    add(-sideX, z, -Math.PI / 2);          // left wall faces +x
    add(+sideX, z, Math.PI / 2);           // right wall faces -x
  }

  // back & front rows (face inward); the front row keeps a central entrance gap
  const rowSpanX = 2 * sideX;
  const rowN = Math.max(3, Math.round(rowSpanX / (TW + 1.0)));
  for (let i = 0; i < rowN; i++) {
    const x = -sideX + (i + 1) * (rowSpanX / (rowN + 1));
    add(x, topZ, 0);                       // back row faces -z
    if (Math.abs(x) > TW * 0.8) add(x, botZ, Math.PI);  // front row, gap in the middle
  }

  // angled corner booths, each facing the hall centre
  add(-sideX, topZ, -Math.PI / 4);
  add(+sideX, topZ, Math.PI / 4);
  add(-sideX, botZ, -3 * Math.PI / 4);
  add(+sideX, botZ, 3 * Math.PI / 4);

  const padX = TD / 2 + 4.5, padZ = TD / 2 + 5;
  return {
    slots, pads: [],
    minX: -sideX - padX, maxX: sideX + padX,
    minZ: botZ - padZ, maxZ: topZ + padZ,
    entranceZ: botZ - padZ + 2,
  };
}

// Soft radial glow texture for faked light reflections on the concrete.
let _glowTex = null;
function glowTex() {
  if (_glowTex) return _glowTex;
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,250,235,1)'); g.addColorStop(1, 'rgba(255,250,235,0)');
  c.fillStyle = g; c.fillRect(0, 0, 64, 64);
  _glowTex = new THREE.CanvasTexture(cv);
  return _glowTex;
}

// Soft dark radial texture for grounding contact-shadows under tables.
let _shadowTex = null;
function shadowTex() {
  if (_shadowTex) return _shadowTex;
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(0.7, 'rgba(0,0,0,0.18)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g; c.fillRect(0, 0, 64, 64);
  _shadowTex = new THREE.CanvasTexture(cv);
  return _shadowTex;
}

// Procedural polished-concrete texture (used until/unless a real texture file
// is dropped in). Mottled gray with subtle speckle and saw-cut joint lines.
function makeConcreteTex() {
  const s = 512, cv = document.createElement('canvas'); cv.width = cv.height = s;
  const c = cv.getContext('2d');
  c.fillStyle = '#a9aaad'; c.fillRect(0, 0, s, s);
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * s, y = Math.random() * s, r = Math.random() * 2.6 + 0.4;
    const v = 150 + (Math.random() * 90) | 0;
    c.fillStyle = `rgba(${v},${v},${v + 3},${Math.random() * 0.05})`;
    c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
  }
  for (let i = 0; i < 70; i++) {
    const x = Math.random() * s, y = Math.random() * s, r = 24 + Math.random() * 70;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(120,122,128,0.05)'); g.addColorStop(1, 'rgba(120,122,128,0)');
    c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
  }
  c.strokeStyle = 'rgba(70,72,78,0.45)'; c.lineWidth = 2;
  c.beginPath(); c.moveTo(0, 1); c.lineTo(s, 1); c.moveTo(1, 0); c.lineTo(1, s); c.stroke();
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// Warm wood-plank texture for the wall wainscot: vertical planks with grain
// streaks and dark joint lines. One shared image, cloned per wall so each can
// set its own horizontal repeat.
let _woodTex = null;
function makeWoodTex() {
  if (_woodTex) return _woodTex;
  const s = 512, cv = document.createElement('canvas'); cv.width = cv.height = s;
  const c = cv.getContext('2d');
  const planks = 8, pw = s / planks;
  for (let i = 0; i < planks; i++) {
    const base = 78 + Math.random() * 26;
    c.fillStyle = `rgb(${(base + 34) | 0},${base | 0},${Math.max(0, base - 28) | 0})`;
    c.fillRect(i * pw, 0, pw, s);
    for (let g = 0; g < 36; g++) {
      c.strokeStyle = `rgba(45,28,14,${Math.random() * 0.16})`; c.lineWidth = 1 + Math.random() * 1.4;
      const gx = i * pw + Math.random() * pw;
      c.beginPath(); c.moveTo(gx, 0);
      c.bezierCurveTo(gx + (Math.random() * 8 - 4), s * 0.34, gx + (Math.random() * 8 - 4), s * 0.68, gx, s);
      c.stroke();
    }
    c.fillStyle = 'rgba(18,11,5,0.55)'; c.fillRect(i * pw + pw - 2, 0, 2, s);  // joint shadow
  }
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  _woodTex = t; return t;
}

// Vertical gradient (warm, bright at the base) used to fake the under-light
// washing up the wood paneling.
let _upGlowTex = null;
function upGlowTex() {
  if (_upGlowTex) return _upGlowTex;
  const cv = document.createElement('canvas'); cv.width = 8; cv.height = 64;
  const c = cv.getContext('2d');
  const g = c.createLinearGradient(0, 64, 0, 0);   // bottom -> top
  g.addColorStop(0, 'rgba(255,206,138,0.85)'); g.addColorStop(0.35, 'rgba(255,196,128,0.28)'); g.addColorStop(1, 'rgba(255,196,128,0)');
  c.fillStyle = g; c.fillRect(0, 0, 8, 64);
  _upGlowTex = new THREE.CanvasTexture(cv); return _upGlowTex;
}

// Floor material. Shows the procedural concrete immediately, then upgrades to
// real PBR maps if present. Drop tileable files in /public/textures/ named
// concrete-color.jpg / concrete-normal.jpg / concrete-rough.jpg (or set
// window.FLOOR_CONCRETE = { color, normal, rough, repeat } with URLs).
function makeFloorMaterial(h) {
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const sizeX = h.maxX - h.minX + 8, sizeZ = h.maxZ - h.minZ + 8;
  const repX = Math.max(2, Math.round(sizeX / 6)), repZ = Math.max(2, Math.round(sizeZ / 6));
  // mid-dark grey tint so the concrete reads as a real polished slab, not washed
  // out by the bright hall lighting/reflections (multiplies the texture tone)
  const mat = new THREE.MeshStandardMaterial({ color: 0x6f7276, roughness: 0.32, metalness: 0.0, envMapIntensity: 0.65 });

  const proc = makeConcreteTex();
  proc.repeat.set(repX, repZ); proc.anisotropy = maxAniso; proc.colorSpace = THREE.SRGBColorSpace;
  mat.map = proc;

  const cfg = window.FLOOR_CONCRETE || {};
  if (cfg !== false) {
    const loader = new THREE.TextureLoader();
    const rx = cfg.repeat || repX, rz = cfg.repeat || repZ;
    // mirror-tile dropped-in textures so repeats don't show a visible seam grid
    const setup = (t, srgb) => { t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping; t.repeat.set(rx, rz); t.anisotropy = maxAniso; if (srgb) t.colorSpace = THREE.SRGBColorSpace; };
    loader.load(cfg.color || '/textures/concrete-color.jpg', t => { setup(t, true); mat.map = t; mat.needsUpdate = true; }, undefined, () => {});
    loader.load(cfg.normal || '/textures/concrete-normal.jpg', t => { setup(t, false); mat.normalMap = t; mat.needsUpdate = true; }, undefined, () => {});
    loader.load(cfg.rough || '/textures/concrete-rough.jpg', t => { setup(t, false); mat.roughnessMap = t; mat.needsUpdate = true; }, undefined, () => {});
  }
  return mat;
}

// Wall material. Solid light paint by default; auto-upgrades to a dropped-in
// texture at /public/textures/wall-color.jpg (or window.FLOOR_WALL = {color,repeat}).
function makeWallMaterial() {
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const mat = new THREE.MeshStandardMaterial({ color: 0xeef0f2, roughness: 0.95 });
  const cfg = window.FLOOR_WALL || {};
  if (cfg !== false) {
    const rep = cfg.repeat || 6;
    new THREE.TextureLoader().load(cfg.color || '/textures/wall-color.jpg', t => {
      t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping; t.repeat.set(rep, Math.max(2, Math.round(rep * 0.4)));
      t.anisotropy = maxAniso; t.colorSpace = THREE.SRGBColorSpace;
      mat.map = t; mat.color.set(0xffffff); mat.needsUpdate = true;
    }, undefined, () => {});
  }
  return mat;
}

// Build the convention hall: polished concrete floor, tall light-gray walls
// (front entrance gap), dark industrial ceiling with trusses, and a grid of
// bright ceiling light fixtures — with faint light pools on the floor so the
// concrete reads as polished and reflective like a real expo hall.
function buildRoom(group, h) {
  const cx = (h.minX + h.maxX) / 2, cz = (h.minZ + h.maxZ) / 2;
  const w = h.maxX - h.minX + 8, d = h.maxZ - h.minZ + 8;
  const CEIL = 15;

  // polished concrete floor (procedural now; upgrades to a dropped-in texture)
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), makeFloorMaterial(h));
  floor.rotation.x = -Math.PI / 2; floor.position.set(cx, 0, cz); floor.receiveShadow = true; group.add(floor);

  // painted walls, tall, with a front entrance gap
  const wallMat = makeWallMaterial();
  const t = 0.6, y = CEIL / 2, ww = h.maxX - h.minX, dd = h.maxZ - h.minZ;
  const back = new THREE.Mesh(new THREE.BoxGeometry(ww, CEIL, t), wallMat); back.position.set(cx, y, h.maxZ); group.add(back);
  const left = new THREE.Mesh(new THREE.BoxGeometry(t, CEIL, dd), wallMat); left.position.set(h.minX, y, cz); group.add(left);
  const right = new THREE.Mesh(new THREE.BoxGeometry(t, CEIL, dd), wallMat); right.position.set(h.maxX, y, cz); group.add(right);
  // front wall — solid (the entrance gap is filled in)
  const front = new THREE.Mesh(new THREE.BoxGeometry(ww, CEIL, t), wallMat); front.position.set(cx, y, h.minZ); group.add(front);

  // raised 3D Card Huddle logo, centred on the back wall
  addBackWallLogo(group, h, CEIL);

  // wood wainscot paneling with warm under-lighting + greenery on the walls
  decorateWalls(group, h);

  // dark industrial ceiling + a few truss beams
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ color: 0x101113, roughness: 1 }));
  ceil.rotation.x = Math.PI / 2; ceil.position.set(cx, CEIL, cz); group.add(ceil);
  const beamMat = new THREE.MeshStandardMaterial({ color: 0x191a1e, roughness: 1 });
  for (let i = 0; i < 6; i++) {
    const bz = h.minZ + (i + 0.5) * (dd / 6);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(ww, 0.5, 0.5), beamMat);
    beam.position.set(cx, CEIL - 0.4, bz); group.add(beam);
  }

  // ceiling light fixtures (emissive) + faint floor reflections under each
  const fixGeo = new THREE.PlaneGeometry(2.4, 0.55);
  const fixMat = new THREE.MeshBasicMaterial({ color: 0xfff4dc });
  const glowGeo = new THREE.PlaneGeometry(3.4, 3.4);
  const glowMat = new THREE.MeshBasicMaterial({ map: glowTex(), transparent: true, opacity: 0.035, blending: THREE.AdditiveBlending, depthWrite: false });
  const stepX = 8, stepZ = 7;
  for (let gx = h.minX + 5; gx <= h.maxX - 5; gx += stepX) {
    for (let gz = h.minZ + 5; gz <= h.maxZ - 5; gz += stepZ) {
      const fix = new THREE.Mesh(fixGeo, fixMat); fix.rotation.x = Math.PI / 2; fix.position.set(gx, CEIL - 0.25, gz); group.add(fix);
      const glow = new THREE.Mesh(glowGeo, glowMat); glow.rotation.x = -Math.PI / 2; glow.position.set(gx, 0.04, gz); group.add(glow);
    }
  }

  // a couple of soft fill lights so the hall isn't flat (no shadows — cheap)
  for (const px of [h.minX + ww * 0.3, h.maxX - ww * 0.3]) {
    const pl = new THREE.PointLight(0xfff4e0, 0.5, 80, 1.6);
    pl.position.set(px, CEIL - 2, cz); group.add(pl);
  }
}

// ----------------------------------------------------- wall decor
// Raised 3D Card Huddle logo sign, centred high on the back wall. A dark backing
// panel gives it physical depth; the logo face is lightly emissive so it reads
// against the dim upper wall. Sized to ~1/10 of the wall (height ~5.5m).
function addBackWallLogo(group, h, CEIL) {
  const cx = (h.minX + h.maxX) / 2;
  const yC = CEIL * 0.7;                 // centred in the upper wall, above the wood
  const wallZ = h.maxZ - 0.3;            // interior face of the back wall
  const depth = 0.35;

  const backing = new THREE.Mesh(new THREE.BoxGeometry(1, 1, depth),
    new THREE.MeshStandardMaterial({ color: 0x10131a, roughness: 0.5, metalness: 0.2 }));
  backing.position.set(cx, yC, wallZ - depth / 2 - 0.02);
  group.add(backing);

  const loader = new THREE.TextureLoader();
  const tex = loader.load('/logo.png', t => {
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso(); t.needsUpdate = true;
    const img = t.image, aspect = (img && img.width && img.height) ? img.width / img.height : 2.4;
    const hLogo = 5.5, wLogo = hLogo * aspect;
    logo.scale.set(wLogo, hLogo, 1);
    backing.scale.set(wLogo + 0.7, hLogo + 0.7, 1);
  }, undefined, () => {});
  const logoMat = new THREE.MeshStandardMaterial({
    map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.4,
    transparent: true, alphaTest: 0.06, roughness: 0.55,
  });
  const logo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), logoMat);
  logo.position.set(cx, yC, wallZ - depth - 0.04);
  logo.rotation.y = Math.PI;             // face into the hall (-z)
  group.add(logo);
}

// Position a wall-hugging mesh given a wall segment, the distance along it,
// the height, and how far it sits inside the wall face.
function setWallPos(mesh, s, alongPos, y, depth) {
  if (s.axis === 'x') mesh.position.set(alongPos, y, s.fixed + s.inward * depth);
  else mesh.position.set(s.fixed + s.inward * depth, y, alongPos);
}
// A low-poly foliage cluster (a few faceted green blobs) for greenery.
function addBush(group, x, y, z, scale, mat) {
  for (let i = 0; i < 4; i++) {
    const r = (0.26 + Math.random() * 0.2) * scale;
    const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), mat);
    blob.position.set(x + (Math.random() - 0.5) * 0.5 * scale, y + (Math.random() - 0.2) * 0.5 * scale, z + (Math.random() - 0.5) * 0.4 * scale);
    blob.castShadow = true; group.add(blob);
  }
}

// Decorate every solid wall with wood wainscot paneling, a warm under-light
// strip + up-glow, and greenery (floor planters and wall-mounted foliage).
function decorateWalls(group, h) {
  const mats = {
    baseWood: makeWoodTex(),
    rail: new THREE.MeshStandardMaterial({ color: 0x3a2616, roughness: 0.6 }),
    glow: new THREE.MeshBasicMaterial({ map: upGlowTex(), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    strip: new THREE.MeshBasicMaterial({ color: 0xffce8a }),
    green: new THREE.MeshStandardMaterial({ color: 0x3f7d3a, roughness: 0.85, flatShading: true }),
    greenDk: new THREE.MeshStandardMaterial({ color: 0x2f6630, roughness: 0.85, flatShading: true }),
    pot: new THREE.MeshStandardMaterial({ color: 0x1b1b20, roughness: 0.8 }),
  };
  const WH = 7.0, off = 0.34, panelT = 0.12;
  const segs = [
    { axis: 'x', fixed: h.maxZ, from: h.minX, to: h.maxX, inward: -1 },          // back wall
    { axis: 'z', fixed: h.minX, from: h.minZ, to: h.maxZ, inward: +1 },          // left wall
    { axis: 'z', fixed: h.maxX, from: h.minZ, to: h.maxZ, inward: -1 },          // right wall
    { axis: 'x', fixed: h.minZ, from: h.minX, to: h.maxX, inward: +1 },          // front wall (entrance filled in)
  ];
  for (const s of segs) addWoodSegment(group, s, WH, off, panelT, mats);
}

function addWoodSegment(group, s, WH, off, panelT, mats) {
  const len = Math.abs(s.to - s.from), center = (s.from + s.to) / 2;
  // wood wainscot panel (own cloned texture so the repeat suits the length)
  const wtex = mats.baseWood.clone(); wtex.needsUpdate = true;
  wtex.wrapS = wtex.wrapT = THREE.RepeatWrapping; wtex.repeat.set(Math.max(1, Math.round(len / 3)), 1);
  wtex.colorSpace = THREE.SRGBColorSpace; wtex.anisotropy = aniso();
  const woodMat = new THREE.MeshStandardMaterial({ map: wtex, roughness: 0.72, metalness: 0.04 });
  const woodGeo = s.axis === 'x' ? new THREE.BoxGeometry(len, WH, panelT) : new THREE.BoxGeometry(panelT, WH, len);
  const panel = new THREE.Mesh(woodGeo, woodMat); panel.receiveShadow = true;
  setWallPos(panel, s, center, WH / 2, off); group.add(panel);

  // dark wood top rail
  const railGeo = s.axis === 'x' ? new THREE.BoxGeometry(len, 0.18, panelT + 0.06) : new THREE.BoxGeometry(panelT + 0.06, 0.18, len);
  const rail = new THREE.Mesh(railGeo, mats.rail); setWallPos(rail, s, center, WH, off); group.add(rail);

  // warm under-light reveal along the TOP of the wood, plus an up-glow that
  // washes the painted wall above it (this is the glowing line in the photo)
  const stripGeo = s.axis === 'x' ? new THREE.BoxGeometry(len, 0.1, 0.09) : new THREE.BoxGeometry(0.09, 0.1, len);
  const strip = new THREE.Mesh(stripGeo, mats.strip); setWallPos(strip, s, center, WH - 0.2, off + 0.08); group.add(strip);
  const glowH = 3.4, gy = WH + glowH / 2 - 0.25;
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(len, glowH), mats.glow);
  if (s.axis === 'x') { glow.position.set(center, gy, s.fixed + s.inward * (off + 0.09)); glow.rotation.y = s.inward > 0 ? 0 : Math.PI; }
  else { glow.position.set(s.fixed + s.inward * (off + 0.09), gy, center); glow.rotation.y = s.inward > 0 ? Math.PI / 2 : -Math.PI / 2; }
  group.add(glow);

  // greenery spaced along the wall: a floor planter with a bush, plus a
  // wall-mounted foliage cluster kept low on the paneling
  const spots = Math.max(2, Math.round(len / 12));
  for (let i = 0; i < spots; i++) {
    const ap = s.from + ((i + 0.5) / spots) * (s.to - s.from);
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.26, 0.5, 12), mats.pot);
    setWallPos(pot, s, ap, 0.25, 0.7); pot.castShadow = true; group.add(pot);
    addBush(group, pot.position.x, 0.62, pot.position.z, 1.05, i % 2 ? mats.green : mats.greenDk);
    // wall greenery, mounted low on the wood
    const wx = s.axis === 'x' ? ap : s.fixed + s.inward * (off + 0.18);
    const wz = s.axis === 'x' ? s.fixed + s.inward * (off + 0.18) : ap;
    addBush(group, wx, 1.7, wz, 0.85, i % 2 ? mats.greenDk : mats.green);
  }
}

// A vacant ("available") table — just the white-clothed table, cheap.
function buildVacantTable(grp) {
  const cloth = new THREE.Mesh(new THREE.BoxGeometry(TABLE_W, TABLE_H, TABLE_D),
    new THREE.MeshStandardMaterial({ color: 0xe7e9ee, roughness: 0.95 }));
  cloth.position.y = TABLE_H / 2; cloth.castShadow = true; cloth.receiveShadow = true; grp.add(cloth);
}

function makeNpcs() {
  npcs.forEach(a => scene.remove(a.group)); npcs = [];
  for (const nm of ['Browser', 'Collector', 'Trader']) {
    const a = buildAvatar(randomCharacter(nm));
    a.x = bounds.minX + 3 + Math.random() * (bounds.maxX - bounds.minX - 6);
    a.z = bounds.minZ + 3 + Math.random() * (bounds.maxZ - bounds.minZ - 6);
    a.tx = a.x; a.tz = a.z; a.repick = 0; a.group.position.set(a.x, 0, a.z); npcs.push(a);
  }
}

// ----------------------------------------------------- movement / collide
function blocked(nx, nz) {
  if (nx < bounds.minX || nx > bounds.maxX || nz < bounds.minZ || nz > bounds.maxZ) return true;
  const halfW = TABLE_W / 2 + PLAYER_R, halfD = TABLE_D / 2 + PLAYER_R;
  for (const t of tableRects) {
    const dx = nx - t.px, dz = nz - t.pz;
    if (t.rot) {
      const c = Math.cos(t.rot), s = Math.sin(t.rot);
      const lx = dx * c - dz * s, lz = dx * s + dz * c;   // into the table's local frame
      if (Math.abs(lx) < halfW && Math.abs(lz) < halfD) return true;
    } else if (Math.abs(dx) < halfW && Math.abs(dz) < halfD) return true;
  }
  return false;
}
// The point a buyer stands at to face a booth: just in front of the table,
// along the table's "front" direction (which depends on its rotation).
function boothFront(b, dist) {
  const rot = b.rot || 0;
  return { x: b.px - Math.sin(rot) * dist, z: b.pz - Math.cos(rot) * dist };
}
function nearestBooth() {
  let best = null, bestD = Infinity;
  for (const b of booths) {
    const f = boothFront(b, TABLE_D / 2 + 1);
    const d = Math.hypot(player.x - f.x, player.z - f.z);
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
    fwd = -fwd; strafe = -strafe; turn = -turn;   // controls were reversed — invert all of them
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
    if (n.repick <= 0 || Math.hypot(n.tx - n.x, n.tz - n.z) < 0.5) { n.tx = bounds.minX + 3 + Math.random() * (bounds.maxX - bounds.minX - 6); n.tz = bounds.minZ + 3 + Math.random() * (bounds.maxZ - bounds.minZ - 6); n.repick = 120 + Math.random() * 180; }
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
// Render at a slightly super-sampled ratio so the floor stays crisp even on
// non-retina desktops, capped at 2x for performance. Override via
// window.FLOOR_PIXEL_RATIO.
function qualityPixelRatio() {
  if (typeof window.FLOOR_PIXEL_RATIO === 'number') return window.FLOOR_PIXEL_RATIO;
  const dpr = window.devicePixelRatio || 1;
  return Math.min(Math.max(dpr, 1.5), 2);
}
let _maxAniso = 8;
function aniso() { return _maxAniso; }
function isLowPower() { return (navigator.maxTouchPoints || 0) > 0 && Math.min(window.innerWidth, window.innerHeight) < 900; }

function resize() {
  const wrap = document.getElementById('floor-canvas-wrap');
  if (!wrap || !renderer) return;
  const w = wrap.clientWidth || 960;
  const h = Math.max(420, Math.min(760, Math.round(w * 0.62)));
  renderer.setPixelRatio(qualityPixelRatio());   // re-apply (DPR can change between monitors)
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}

async function ensureThree() {
  if (renderer) return true;
  const canvas = document.getElementById('floor-canvas');
  if (!canvas) return false;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }); }
  catch (err) {
    console.error('[floor] WebGL unavailable:', err && err.message);
    const list = document.getElementById('floor-dir-list');
    if (list) list.innerHTML = '<p class="floor-dir-empty">3D isn\'t available on this device/browser (WebGL is off).</p>';
    return false;
  }
  renderer.setPixelRatio(qualityPixelRatio());
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  _maxAniso = renderer.capabilities.getMaxAnisotropy();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x17191e);
  // light fog tinted to the background hides far-distance aliasing/shimmer and
  // adds depth without dimming the booths you're standing near
  scene.fog = new THREE.Fog(0x17191e, 70, 200);
  camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 240);

  // bright, even hall lighting (the fixtures themselves are emissive props)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6b6e75, 0.7));
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 0.55);
  sun.position.set(16, 30, 10); sun.castShadow = true;
  const shadowRes = isLowPower() ? 2048 : 4096;       // sharper contact shadows on capable devices
  sun.shadow.mapSize.set(shadowRes, shadowRes);
  sun.shadow.camera.left = -60; sun.shadow.camera.right = 60; sun.shadow.camera.top = 60; sun.shadow.camera.bottom = -60;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 110;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;   // crisper edges, less acne/peter-panning
  scene.add(sun);

  // image-based lighting so brushed aluminum + glass read correctly
  try {
    const { RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js');
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  } catch (err) { console.warn('[floor] env map unavailable:', err && err.message); }

  clock = new THREE.Clock(); playerObj = null;

  if (window.FLOOR_AVATAR_MODEL) {
    try {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const gltf = await new GLTFLoader().loadAsync(window.FLOOR_AVATAR_MODEL);
      const size = new THREE.Vector3(); new THREE.Box3().setFromObject(gltf.scene).getSize(size);
      gltf.scene.userData.fitScale = size.y ? (3.3 / size.y) : 1;
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
      for (const h of hits) { const ud = h.object.userData; if (ud.boothId != null) { const b = booths[ud.boothId]; if (b) { openBooth(b, ud.menu); break; } } }
    }
    dragging = false;
  });
  window.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 5) moved = true;
    if (camMode === 'fp') { yaw -= dx * 0.005; pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch - dy * 0.005)); }
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
function boothCardsHtml(cards, b, mode) {
  if (!cards.length) {
    if (mode === 'value') return b.isYou
      ? '<p class="seller-empty">Your value box is empty. In the <strong>Sell</strong> tab, toggle a card into the value box and it\'ll land here.</p>'
      : '<p class="seller-empty">This collector hasn\'t put any cards in their value box yet.</p>';
    return b.isYou
      ? '<p class="seller-empty">Your showcase is empty. Add cards in the <strong>Sell</strong> tab and they\'ll appear here on the floor.</p>'
      : '<p class="seller-empty">This collector hasn\'t put any cards out yet.</p>';
  }
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
    // DM the booth owner to negotiate this card (real booths only, not your own)
    if (!b.isYou && b.username) links.push(`<button type="button" class="sc-link sc-link-dm" data-dm-user="${escHtml(b.username)}" data-dm-title="${escHtml(it.title || 'Card')}" data-dm-img="${escHtml(it.imageUrl || '')}" data-dm-price="${typeof it.price === 'number' ? it.price : ''}">💬 Negotiate</button>`);
    return `<div class="sc-card">${img}<div class="sc-card-body"><div class="sc-card-badges">${badges.join('')}</div><div class="sc-card-title">${escHtml(it.title || 'Card')}</div>${it.note ? `<div class="sc-card-note">${escHtml(it.note)}</div>` : ''}${price}<div class="sc-card-links">${links.join('')}</div></div></div>`;
  }).join('') + '</div>';
}
let _boothModalB = null;
function openBooth(b, menu) {
  _boothModalB = b;
  const mode = menu === 'value' ? 'value' : 'showcase';
  const modal = document.getElementById('floor-booth-modal');
  const title = document.getElementById('floor-booth-title');
  const sub = document.getElementById('floor-booth-sub');
  const body = document.getElementById('floor-booth-body');
  if (!modal || !body) return;
  const all = b.cards || [];
  const cards = all.filter(c => mode === 'value' ? c.valueBox : !c.valueBox);
  const who = b.isYou ? 'Your' : b.owner + "'s";
  if (title) title.textContent = (b.emoji || '🃏') + ' ' + who + (mode === 'value' ? ' Value Box' : ' Booth');
  if (sub) sub.textContent = mode === 'value'
    ? (b.isYou ? 'Your dollar-box / bulk cards. Toggle cards into the value box in the Sell tab.' : 'Dollar-box finds — browse and grab a deal. Buy hands off to eBay; trade to Veriswap.')
    : (b.isYou ? 'This is what other collectors see when they visit you. Arrange your fixtures here; edit the cards in the Sell tab.' : 'Buy hands off to eBay; trade hands off to Veriswap. The Card Huddle isn\'t part of the deal.');
  // cross-link to the other menu when that pool has cards, so both are reachable
  const otherMode = mode === 'value' ? 'showcase' : 'value';
  const otherCount = all.filter(c => otherMode === 'value' ? c.valueBox : !c.valueBox).length;
  const switchBtn = otherCount
    ? `<button type="button" class="floor-menu-switch" onclick="floorSwitchMenu('${otherMode}')">${otherMode === 'value' ? '💲 View Value Box' : '🧳 View Showcase'} (${otherCount}) &rarr;</button>`
    : '';
  const ownerActs = b.isYou ? '<div class="floor-booth-owneracts"><button type="button" class="floor-arrange-btn" onclick="arrangeBooth()">🧩 Arrange booth</button></div>' : '';
  body.innerHTML = ownerActs + switchBtn + boothCardsHtml(cards, b, mode);
  modal.classList.remove('hidden');
}
function closeBooth() { document.getElementById('floor-booth-modal')?.classList.add('hidden'); }

// ----------------------------------------------------- booth editor
let editorLayout = [];               // working copy while the editor is open
let editorTool = 'showcase';         // currently selected fixture from the palette
function openBoothEditor() {
  if (!getCharacter()) { renderCharCreate(); return; }
  closeBooth();
  editorLayout = resolveLayout({ isYou: true });
  editorTool = 'showcase';
  renderBoothEditor();
  document.getElementById('floor-booth-editor')?.classList.remove('hidden');
}
function closeBoothEditor() { document.getElementById('floor-booth-editor')?.classList.add('hidden'); }
function fixtureMeta(id) { return FIXTURES.find(f => f.id === id) || FIXTURES[FIXTURES.length - 1]; }
function renderBoothEditor() {
  const pal = document.getElementById('floor-editor-palette');
  if (pal) pal.innerHTML = FIXTURES.map(f =>
    `<button type="button" class="floor-tool${f.id === editorTool ? ' sel' : ''}" data-tool="${f.id}" title="${escHtml(f.desc)}">
       <span class="floor-tool-icon">${f.icon}</span><span class="floor-tool-label">${escHtml(f.label)}</span>
     </button>`).join('');
  const table = document.getElementById('floor-editor-table');
  if (table) table.innerHTML = editorLayout.map((t, i) => {
    const m = fixtureMeta(t);
    return `<button type="button" class="floor-spot${t === 'empty' ? ' empty' : ''}" data-spot="${i}" title="${escHtml(m.label)}">
        <span class="floor-spot-icon">${t === 'empty' ? '＋' : m.icon}</span>
        <span class="floor-spot-label">${t === 'empty' ? 'Empty' : escHtml(m.label)}</span>
      </button>`;
  }).join('');
}
function boothEditorClear() { editorLayout = new Array(BOOTH_SLOTS).fill('empty'); renderBoothEditor(); }
function saveBoothEditor() {
  saveBoothLayout(editorLayout.slice());
  closeBoothEditor();
  buildWorld(lastRemoteBooths);              // re-render with the new layout
  const mine = booths.find(b => b.isYou);
  if (mine) walkToBooth(mine);               // step up to admire it
}

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
  const f = boothFront(b, TABLE_D / 2 + 2.4);
  player.x = f.x; player.z = f.z; yaw = b.rot || 0; camMode = 'fp';
  setFreeLook(false);
}
function updateOnlineCount() { const el = document.getElementById('floor-online'); if (el) el.textContent = `🟢 ${remote.size + 1} on the floor`; }

// ----------------------------------------------------- floor chat (broadcast)
// A live, ephemeral room for everyone currently on the floor, relayed over the
// same FloorRoom presence socket. Sits in the "Floor" tab of the chat panel.
let floorChatLog = [];
function onFloorChat(msg) {
  floorChatLog.push({ id: msg.id, name: msg.name || 'Collector', emoji: msg.emoji || '🙂', text: String(msg.text || ''), at: msg.at || Date.now(), mine: msg.id === wsId });
  if (floorChatLog.length > 120) floorChatLog = floorChatLog.slice(-120);
  if (isFloorChatVisible()) renderFloorChat();
}
function isFloorChatVisible() {
  const ov = document.getElementById('chat-overlay');
  const pane = document.getElementById('chat-floor');
  return ov && !ov.classList.contains('hidden') && pane && !pane.classList.contains('hidden');
}
function renderFloorChat() {
  const log = document.getElementById('floor-chat-log');
  if (!log) return;
  if (!floorChatLog.length) {
    log.innerHTML = '<p class="dm-empty">No messages yet — say hi to the floor. Everyone here will see it.</p>';
    return;
  }
  log.innerHTML = floorChatLog.map(m =>
    `<div class="fc-line${m.mine ? ' mine' : ''}"><span class="fc-who">${escHtml(m.emoji)} ${escHtml(m.name)}</span><span class="fc-text">${escHtml(m.text)}</span></div>`
  ).join('');
  log.scrollTop = log.scrollHeight;
}
function floorChatNotice(text) {
  const log = document.getElementById('floor-chat-log');
  if (!log) return;
  const p = document.createElement('div');
  p.className = 'fc-notice'; p.textContent = text; log.appendChild(p); log.scrollTop = log.scrollHeight;
}
function floorChatActivate() {
  renderFloorChat();
  const input = document.getElementById('floor-chat-input');
  if (input) setTimeout(() => input.focus(), 50);
}
window.floorChatActivate = floorChatActivate;
window.floorChatSend = function (ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  const input = document.getElementById('floor-chat-input');
  const text = (input && input.value || '').trim();
  if (!text) return false;
  if (!ws || ws.readyState !== 1) { floorChatNotice('Not connected to the floor yet — try again in a moment.'); return false; }
  sendWs({ t: 'chat', text });
  if (input) input.value = '';
  return false;
};

// ----------------------------------------------------- presence
function connectPresence() {
  if (ws || typeof WebSocket === 'undefined') return;
  let sock;
  try { const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'; sock = new WebSocket(`${proto}//${location.host}/api/floor/ws`); }
  catch (_) { return; }
  ws = sock;
  sock.addEventListener('open', () => {
    const me = normalizeCharacter(getCharacter());
    sendWs({
      t: 'join', name: me.name, emoji: me.emoji, color: me.shirt, username: myUsername(),
      x: round1(player.x), y: round1(player.z),
      appearance: { skin: me.skin, shirt: me.shirt, pants: me.pants, hair: me.hair, hairStyle: me.hairStyle, hat: me.hat, accessory: me.accessory },
    });
    lastSent = { x: null, z: null };
    moveTimer = setInterval(() => { const x = round1(player.x), z = round1(player.z); if (x === lastSent.x && z === lastSent.z) return; lastSent = { x, z }; sendWs({ t: 'move', x, y: z }); }, 100);
  });
  sock.addEventListener('message', evt => {
    let msg; try { msg = JSON.parse(evt.data); } catch (_) { return; }
    if (msg.t === 'welcome') { wsId = msg.id; for (const r of remote.values()) scene.remove(r.group); remote.clear(); for (const p of (msg.players || [])) addRemote(p); }
    else if (msg.t === 'join' && msg.player) addRemote(msg.player);
    else if (msg.t === 'move') { const r = remote.get(msg.id); if (r) { r.tx = msg.x; r.tz = msg.y; } }
    else if (msg.t === 'leave') { const r = remote.get(msg.id); if (r) { scene.remove(r.group); remote.delete(msg.id); } }
    else if (msg.t === 'chat') { onFloorChat(msg); return; }
    else if (msg.t === 'chatblocked') { floorChatNotice('Message blocked: ' + (msg.reason === 'spam' ? 'looks like spam.' : 'language not allowed.')); return; }
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
  const a = buildAvatar(normalizeCharacter({ name: p.name, emoji: p.emoji, color: p.color, ...(p.appearance || {}) }));
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
  document.getElementById('floor-intro')?.classList.add('hidden');
  if (stage) stage.classList.add('hidden');
  if (cc) cc.classList.remove('hidden');
  const existing = getCharacter();
  ccDraft = normalizeCharacter(existing);
  const nameEl = document.getElementById('floor-cc-name');
  if (nameEl) nameEl.value = existing ? (existing.name || '') : '';

  const swatchRow = (id, field, colors) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = colors.map(c => `<button type="button" class="floor-swatch${c === ccDraft[field] ? ' sel' : ''}" style="background:${c}" data-cc="${field}" data-val="${c}"></button>`).join('');
  };
  const optRow = (id, field, opts) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = opts.map(o => `<button type="button" class="floor-cc-opt${o.id === ccDraft[field] ? ' sel' : ''}" data-cc="${field}" data-val="${o.id}">${escHtml(o.label)}</button>`).join('');
  };
  swatchRow('floor-cc-skin', 'skin', SKIN_TONES);
  swatchRow('floor-cc-colors', 'shirt', SHIRT_COLORS);
  swatchRow('floor-cc-pants', 'pants', PANTS_COLORS);
  swatchRow('floor-cc-haircolor', 'hair', HAIR_COLORS);
  optRow('floor-cc-hairstyle', 'hairStyle', HAIR_STYLES);
  optRow('floor-cc-hat', 'hat', HATS);
  optRow('floor-cc-accessory', 'accessory', ACCESSORIES);
  const emojiWrap = document.getElementById('floor-cc-emojis');
  if (emojiWrap) emojiWrap.innerHTML = AVATAR_EMOJIS.map(e => `<button type="button" class="floor-emoji${e === ccDraft.emoji ? ' sel' : ''}" data-cc="emoji" data-val="${e}">${e}</button>`).join('');
  drawCharPreview();
}

// 2D front-facing preview of the collector being built (no WebGL needed).
function drawCharPreview() {
  const cv = document.getElementById('floor-cc-preview');
  if (!cv || !cv.getContext) return;
  const c = cv.getContext('2d'), W = cv.width, H = cv.height, cx = W / 2;
  const ch = ccDraft;
  c.clearRect(0, 0, W, H);
  const rr = (x, y, w, h, r) => { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); };
  // soft ground shadow
  c.fillStyle = 'rgba(0,0,0,0.18)'; c.beginPath(); c.ellipse(cx, H - 14, 46, 10, 0, 0, 7); c.fill();
  // legs + shoes
  c.fillStyle = ch.pants; rr(cx - 26, H - 120, 22, 96, 6); c.fill(); rr(cx + 4, H - 120, 22, 96, 6); c.fill();
  c.fillStyle = '#15171c'; rr(cx - 30, H - 30, 28, 14, 5); c.fill(); rr(cx + 2, H - 30, 28, 14, 5); c.fill();
  // arms (behind torso)
  c.fillStyle = ch.shirt; rr(cx - 50, H - 210, 18, 96, 8); c.fill(); rr(cx + 32, H - 210, 18, 96, 8); c.fill();
  c.fillStyle = ch.skin; c.beginPath(); c.arc(cx - 41, H - 116, 11, 0, 7); c.fill(); c.beginPath(); c.arc(cx + 41, H - 116, 11, 0, 7); c.fill();
  // torso
  c.fillStyle = ch.shirt; rr(cx - 36, H - 214, 72, 104, 14); c.fill();
  // head + nose
  const hy = H - 250;
  c.fillStyle = ch.skin; c.beginPath(); c.arc(cx, hy, 30, 0, 7); c.fill();
  c.fillStyle = 'rgba(0,0,0,0.12)'; c.beginPath(); c.arc(cx, hy + 6, 3.5, 0, 7); c.fill();
  // hair
  if (ch.hairStyle && ch.hairStyle !== 'bald') {
    c.fillStyle = ch.hair;
    if (ch.hairStyle === 'curly') { for (let i = 0; i < 8; i++) { const a = Math.PI + (i / 7) * Math.PI; c.beginPath(); c.arc(cx + Math.cos(a) * 28, hy + Math.sin(a) * 28, 11, 0, 7); c.fill(); } }
    else {
      const sweep = ch.hairStyle === 'buzz' ? 0.62 : 0.95;
      c.beginPath(); c.arc(cx, hy, 32, Math.PI * (1 + (1 - sweep)), Math.PI * (2 - (1 - sweep))); c.fill();
      if (ch.hairStyle === 'long') { rr(cx - 30, hy, 60, 46, 10); c.fill(); }
    }
  }
  // hat
  if (ch.hat === 'cap') { c.fillStyle = ch.shirt; c.beginPath(); c.arc(cx, hy - 4, 31, Math.PI, 2 * Math.PI); c.fill(); rr(cx - 6, hy - 8, 44, 9, 4); c.fill(); }
  else if (ch.hat === 'beanie') { c.fillStyle = ch.shirt; c.beginPath(); c.arc(cx, hy - 2, 33, Math.PI * 1.05, Math.PI * 1.95); c.fill(); rr(cx - 33, hy - 6, 66, 10, 5); c.fill(); }
  // glasses
  if (ch.accessory === 'glasses') { c.strokeStyle = '#15171c'; c.lineWidth = 3; c.beginPath(); c.arc(cx - 12, hy + 2, 9, 0, 7); c.stroke(); c.beginPath(); c.arc(cx + 12, hy + 2, 9, 0, 7); c.stroke(); c.beginPath(); c.moveTo(cx - 3, hy + 2); c.lineTo(cx + 3, hy + 2); c.stroke(); }
}

async function enterFloor() {
  document.getElementById('floor-charcreate')?.classList.add('hidden');
  document.getElementById('floor-intro')?.classList.add('hidden');
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
  playerObj = buildAvatar(me);
  makeNpcs();
  setFreeLook(false);
  start();
  updateOnlineCount();
  connectPresence();
}

// ----------------------------------------------------- public entry
// Show the "under construction" gate first; Enter demo proceeds into the floor.
function showFloorIntro() {
  document.getElementById('floor-charcreate')?.classList.add('hidden');
  document.getElementById('floor-stage')?.classList.add('hidden');
  document.getElementById('floor-intro')?.classList.remove('hidden');
}
window.initFloor = function () { showFloorIntro(); };
window.enterFloorDemo = function () {
  document.getElementById('floor-intro')?.classList.add('hidden');
  if (getCharacter()) enterFloor(); else renderCharCreate();
};
window.stopFloor = stop;
window.editCharacter = function () { stop(); renderCharCreate(); };
window.saveCharacterAndEnter = function () {
  const name = (document.getElementById('floor-cc-name')?.value || '').trim();
  if (!name) { alert('Pick a display name for your collector.'); return; }
  saveCharacter(normalizeCharacter({ ...ccDraft, name }));
  enterFloor();
};
window.closeBoothModal = closeBooth;
window.floorSwitchMenu = function (m) { if (_boothModalB) openBooth(_boothModalB, m); };
window.toggleFreeLook = function () { setFreeLook(camMode !== 'free'); };
window.arrangeBooth = openBoothEditor;
window.closeBoothEditor = closeBoothEditor;
window.boothEditorClear = boothEditorClear;
window.saveBoothEditor = saveBoothEditor;

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
  const ccOpt = e.target.closest('[data-cc]');
  if (ccOpt) { ccDraft[ccOpt.dataset.cc] = ccOpt.dataset.val; renderCharCreate(); return; }
  const visit = e.target.closest('.floor-dir-visit');
  if (visit) { const b = boothById(visit.dataset.booth); if (b) openBooth(b); return; }
  const walk = e.target.closest('.floor-dir-walk');
  if (walk) { const b = boothById(walk.dataset.booth); if (b) walkToBooth(b); return; }
  const tool = e.target.closest('.floor-tool');
  if (tool) { editorTool = tool.dataset.tool; renderBoothEditor(); return; }
  const spot = e.target.closest('.floor-spot');
  if (spot) { editorLayout[+spot.dataset.spot] = editorTool; renderBoothEditor(); return; }
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
