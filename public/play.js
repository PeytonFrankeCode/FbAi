// One of One, the daily game (owner, Nov 2026): seven prompts a day, twenty
// seconds each; name a player who fits, and the rarer the answer among the
// day's players, the more it scores. Server: server.js "One of One"; rules:
// game-core.js. This file is the screens: start, prompt, reveal, results.
// Unlimited mode is the same screens over practice rounds of seven, as many
// as a player likes, apart from the daily pack and its streak.
// Uses app.js helpers where they exist: authFetch, safeJson, escHtml,
// showLogin, getSessionToken, switchView, performSearch.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => (typeof escHtml === 'function' ? escHtml(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const TIER = { base: 'Base', green: 'Green', blue: 'Blue', gold: 'Gold', one: 'One of One' };
  const WHY = {
    none: 'No match. Check the spelling or try someone else.',
    ambiguous: 'More than one player fits that. Add more of the name.',
    other: 'That player doesn\u2019t fit this one. Try someone else.',
    empty: 'Type a player’s name.',
  };

  // What kind of prompt it is, as a tag beside it: [label, the mark's path].
  // The marks are drawn here, 16 by 16, in the colour of the text around them.
  const MARK = {
    shield: '<path d="M8 1.6l5.4 2v4.1c0 3.1-2.2 5.5-5.4 6.7-3.2-1.2-5.4-3.6-5.4-6.7V3.6z"/>',
    stack: '<rect x="2.5" y="4.5" width="8.5" height="10" rx="1.5"/><path d="M5.5 2h6.5a1.5 1.5 0 0 1 1.5 1.5v8.5"/>',
    star: '<path d="M8 1.9l1.9 3.8 4.2.6-3 3 .7 4.2L8 11.5l-3.8 2 .7-4.2-3-3 4.2-.6z"/>',
    year: '<rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5 1.5v3M11 1.5v3"/>',
    pen: '<path d="M2.5 13.5l.8-3.2 7.4-7.4a1.4 1.4 0 0 1 2 0l.4.4a1.4 1.4 0 0 1 0 2l-7.4 7.4zM9.7 3.9l2.4 2.4"/>',
    hash: '<path d="M6.2 2L4.8 14M11.2 2L9.8 14M2.5 5.7h11.3M2.2 10.3h11.3"/>',
    rookie: '<circle cx="8" cy="8" r="6.3"/><path d="M5.4 8.3l1.8 1.8 3.5-3.9"/>',
  };
  const KIND = {
    team: ['Team', 'shield'], product: ['Set', 'stack'], insert: ['Insert', 'star'], year: ['Year', 'year'], rookie: ['Rookies', 'rookie'],
    auto: ['Autographs', 'pen'], autoyear: ['Autographs', 'pen'], low: ['Numbered', 'hash'], count: ['Card count', 'stack'],
  };
  const mark = (name) => `<svg class="oo-mark" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${MARK[name] || MARK.stack}</svg>`;
  const ORDER = ['base', 'green', 'blue', 'gold', 'one'];

  let data = null;        // the server's last reply: { view, tiers, msToNext, results, rank, share, stats }
  let phase = 'loading';  // loading | start | prompt | reveal | results | error
  let shown = null;       // what the reveal screen is showing: { answer, read, typed, was } or { miss: reason }
  let deadline = 0, total = 20000, raf = 0, busy = false, loaded = false, nextAt = 0, tick = 0, errorText = '';
  let mode = 'daily';     // daily | unlimited

  // ---- Who is playing ----
  // A browser without an account plays under an id it makes once and keeps.
  let _device = null;
  function device() {
    if (_device) return _device;
    try { _device = localStorage.getItem('ooDevice'); } catch (_) { /* private mode */ }
    if (!_device || !/^[a-z0-9-]{16,64}$/.test(_device)) {
      _device = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
        : 'd' + Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join('');
      try { localStorage.setItem('ooDevice', _device); } catch (_) { /* stays for this visit */ }
    }
    return _device;
  }
  const signedIn = () => typeof getSessionToken === 'function' && !!getSessionToken();

  async function api(path, body) {
    const headers = { 'Content-Type': 'application/json', 'x-game-device': device() };
    const opts = body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) };
    const r = await (typeof authFetch === 'function' ? authFetch(path, opts) : fetch(path, opts));
    const d = typeof safeJson === 'function' ? await safeJson(r) : await r.json().catch(() => null);
    if (!r.ok) throw new Error((d && d.error) || 'Something went wrong. Try again.');
    return d;
  }

  // ---- Streaks ----
  // An account's streak comes from the server. A browser without one keeps
  // its own here, by the same rule (game-core.js nextStats): days played in a
  // row, and a missed day starts it again.
  const dayIndex = (date) => { const p = String(date).split('-').map(Number); return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / 86400000); };
  function localStats() { try { return JSON.parse(localStorage.getItem('ooStats') || 'null'); } catch (_) { return null; } }
  function noteFinished(view) {
    const s = localStats() || {};
    if (s.last === view.date) return;
    const streak = (s.last && dayIndex(view.date) - dayIndex(s.last) === 1) ? (Number(s.streak) || 0) + 1 : 1;
    const next = { last: view.date, streak, bestStreak: Math.max(Number(s.bestStreak) || 0, streak), best: Math.max(Number(s.best) || 0, view.score),
      plays: (Number(s.plays) || 0) + 1, total: (Number(s.total) || 0) + view.score };
    try { localStorage.setItem('ooStats', JSON.stringify(next)); } catch (_) { /* no storage, no streak */ }
  }
  function stats() {
    if (data && data.stats) return data.stats;
    const s = localStats();
    if (!s || !s.last || !data || !data.view) return s;
    return { ...s, streak: dayIndex(data.view.date) - dayIndex(s.last) <= 1 ? s.streak : 0 };
  }

  // ---- Unlimited mode ----
  // Practice rounds of seven, dealt on the server and numbered 0 to
  // data.unlimited - 1. This browser keeps its place: where it started (a
  // random round, so players are spread over all of them), how many it has
  // played, and its best and total score. Going past the last round comes
  // back to the first, which the server lets be played again.
  //   { start, played, scored, rounds, best, total }
  // `played` is the round being played (counted from this browser's start);
  // `scored` is the last one whose score was added, so a finished round is
  // counted once however often its results are looked at.
  const unlimitedOn = () => !!(data && data.unlimited > 0);
  function unl() {
    let u = null;
    try { u = JSON.parse(localStorage.getItem('ooUnlimited') || 'null'); } catch (_) { u = null; }
    if (!u || !Number.isInteger(u.start) || !Number.isInteger(u.played)) u = { start: Math.floor(Math.random() * 100000), played: 0, scored: -1, rounds: 0, best: 0, total: 0 };
    return u;
  }
  function saveUnl(u) { try { localStorage.setItem('ooUnlimited', JSON.stringify(u)); } catch (_) { /* no storage: the place is kept for this visit only */ } _unl = u; }
  let _unl = null;
  const place = () => (_unl || (_unl = unl()));
  const roundNow = () => (place().start + place().played) % Math.max(1, (data && data.unlimited) || 1);
  function noteRound(view) {
    const u = place();
    if (u.scored === u.played) return;
    saveUnl({ ...u, scored: u.played, rounds: (u.rounds || 0) + 1, best: Math.max(u.best || 0, view.score), total: (u.total || 0) + view.score });
  }
  function roundTiles() {
    const u = place();
    if (!u.rounds) return '';
    const tile = (n, label) => `<div class="oo-tile"><b>${n}</b><span>${label}</span></div>`;
    return `<div class="oo-tiles">${tile(u.rounds, u.rounds === 1 ? 'Round played' : 'Rounds played')}${tile(u.best || 0, 'Best round')}${tile(Math.round((u.total || 0) / u.rounds), 'Average')}</div>`;
  }
  // The way into unlimited, on the start and results screens.
  function unlimitedDoor() {
    if (!unlimitedOn()) return '';
    const u = place();
    return `<button type="button" class="oo-btn oo-ghost oo-big" data-act="unlimited">${u.rounds || u.played ? 'Keep playing unlimited' : 'Play unlimited'}</button>
      <p class="oo-small oo-muted oo-center">Practice rounds of seven, as many as you like. They don&rsquo;t count toward your streak.</p>`;
  }

  // ---- Pieces of a screen ----
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  // How open a prompt is: "214 players fit".
  const fits = (n) => `${Number(n).toLocaleString('en-US')} ${n === 1 ? 'player fits' : 'players fit'}`;
  // `fresh`: the slot just filled lands with a pop (the reveal screen).
  // `points`: each card shows what it scored (the results screen).
  function slots(view, current, fresh, points) {
    let h = '<div class="oo-slots" aria-label="Your pack so far">';
    for (let i = 0; i < view.count; i++) {
      const a = view.answers[i], pop = fresh && i === view.answers.length - 1 ? ' new' : '';
      if (i < view.answers.length) h += a ? `<span class="oo-slot oo-t-${a.tier}${pop}" style="--i:${i}" title="${esc(TIER[a.tier])}${a.name ? ': ' + esc(a.name) : ''}">${points ? (a.tier === 'one' ? '1/1' : a.points) : ''}</span>` : `<span class="oo-slot oo-t-miss${pop}" style="--i:${i}" title="No answer">${points ? '0' : ''}</span>`;
      else h += `<span class="oo-slot${i === current ? ' now' : ''}" style="--i:${i}"></span>`;
    }
    return h + '</div>';
  }

  // ---- Show ----
  const calm = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  // The five tiers as a fan of cards, the 1/1 in front (the start screen).
  // Each carries what it scores.
  const fan = () => `<div class="oo-fan" aria-hidden="true"><i class="oo-fan-card oo-t-base">10</i><i class="oo-fan-card oo-t-green">25</i><i class="oo-fan-card oo-t-blue">50</i><i class="oo-fan-card oo-t-gold">75</i><i class="oo-fan-card oo-t-one oo-shine">1/1</i></div>`;
  // A One of One throws sparks; a Gold, a few.
  function sparks(tier) {
    const n = tier === 'one' ? 22 : tier === 'gold' ? 9 : 0;
    if (!n || calm()) return '';
    const colors = tier === 'one' ? ['#fde68a', '#facc15', '#ffffff', '#eab308'] : ['#facc15', '#fde68a'];
    let h = '<span class="oo-sparks" aria-hidden="true">';
    for (let i = 0; i < n; i++) {
      const angle = Math.round((360 / n) * i + Math.random() * 16 - 8), reach = 120 + Math.round(Math.random() * 80);
      h += `<i style="--a:${angle}deg;--r:${reach}px;--k:${colors[i % colors.length]};--u:${(0.8 + Math.random() * 0.5).toFixed(2)}s;--w:${(0.8 + Math.random() * 0.15).toFixed(2)}s"></i>`;
    }
    return h + '</span>';
  }
  // ---- The drive (owner, Nov 2026) ----
  // The pack is a drive down a football field. Each right answer is a pass,
  // and the rarer the answer the deeper it goes; a miss is a sack for no
  // gain. Crossing the goal line is a touchdown, and the next drive starts at
  // the 25. Worked out from the pack's answers, so a reload shows the same
  // drive; the points are untouched, the field is the show.
  const GAIN = { base: 5, green: 12, blue: 20, gold: 35, one: 50 };
  function drive(answers) {
    let pos = 25, tds = 0, yards = 0, sacks = 0;
    const plays = [];
    for (const a of answers || []) {
      if (!a) { plays.push({ from: pos, to: pos, gain: 0, sack: true }); sacks++; continue; }
      const want = GAIN[a.tier] || 0, td = pos + want >= 100, gain = td ? 100 - pos : want;
      plays.push({ from: pos, to: pos + gain, gain, td, tier: a.tier });
      yards += gain;
      if (td) { tds++; pos = 25; } else pos += gain;
    }
    return { plays, tds, yards, sacks, pos };
  }
  // Across the turf: 10 yards of end zone, the 100-yard field, 10 more.
  const fx = (y) => ((10 + y) / 120) * 100;
  const pct = (n) => `${n.toFixed(2)}%`;
  const yardWords = (y) => y === 50 ? 'midfield' : y < 50 ? `your ${y}` : `their ${100 - y}`;
  function driveLine(d) {
    const bits = [];
    if (d.tds) bits.push(plural(d.tds, 'touchdown'));
    bits.push(`${d.yards} ${d.yards === 1 ? 'yard' : 'yards'}`);
    if (d.sacks) bits.push(plural(d.sacks, 'sack'));
    return bits.join(' &middot; ');
  }
  // `live`: the last play is run on the field (the reveal screen); otherwise
  // the ball sits where the drive ended (the results screen).
  function field(d, live) {
    const p = d.plays[d.plays.length - 1];
    const spot = !p ? 25 : live ? p.from : p.td ? 100 : p.to;
    let lines = '';
    for (let y = 5; y <= 95; y += 5) lines += `<i class="oo-yl${y % 10 ? ' half' : ''}" style="left:${pct(fx(y))}"></i>`;
    for (let y = 10; y <= 90; y += 10) lines += `<b class="oo-yn" style="left:${pct(fx(y))}">${y <= 50 ? y : 100 - y}</b>`;
    const say = !p ? 'Your drive starts at your 25.' : p.sack ? 'Sacked for no gain.' : p.td ? `Touchdown, a ${p.gain}-yard pass.` : `A ${p.gain}-yard pass to ${yardWords(p.to)}.`;
    return `<div class="oo-field${p && p.td && !live ? ' td' : ''}" id="oo-field" role="img" aria-label="${esc(say)}">
        <div class="oo-turf">
          <i class="oo-ez oo-ez-l"><span>HUDDLE</span></i><i class="oo-ez oo-ez-r"><span>1/1</span></i>
          ${lines}
          <i class="oo-los" id="oo-los" style="left:${pct(fx(spot))}"></i>
          <i class="oo-man oo-wr" id="oo-wr" style="left:${pct(fx(spot))};top:30%"></i>
          <i class="oo-man oo-de" id="oo-de" style="left:${pct(fx(Math.min(spot + 6, 100)))};top:72%"></i>
          <i class="oo-man oo-qb" id="oo-qb" style="left:${pct(fx(spot))};top:52%"></i>
          <i class="oo-ball" id="oo-ball" style="left:${pct(fx(spot))};top:52%"></i>
          <b class="oo-call" id="oo-call"></b>
        </div>
      </div>
      <p class="oo-drive" id="oo-drive">${p ? driveLine(d) : ''}</p>`;
  }
  // Runs the last play: the QB drops back and throws, the ball spirals to the
  // receiver as far as the answer earned, the marker moves up. A miss: the
  // rush gets home and the QB goes down.
  function runPlay(d) {
    const p = d.plays[d.plays.length - 1], el = $('oo-field');
    if (!p || !el) return;
    const qb = $('oo-qb'), wr = $('oo-wr'), de = $('oo-de'), ball = $('oo-ball'), los = $('oo-los'), call = $('oo-call');
    const say = (text, cls) => { call.textContent = text; call.className = `oo-call on ${cls || ''}`; };
    const at = (node, y, top) => { node.style.left = pct(fx(y)); if (top != null) node.style.top = `${top}%`; };
    const done = () => {
      at(los, p.td ? 100 : p.to);
      if (p.sack) { el.classList.add('sack'); say('SACKED', 'bad'); }
      else if (p.td) { el.classList.add('td'); say('TOUCHDOWN', 'gold'); at(ball, Math.min(p.to + 4, 108), 46); at(wr, Math.min(p.to + 4, 108), 46); }
      else { say(`+${p.gain} YDS`, p.tier); at(ball, p.to, 34); at(wr, p.to, 34); }
    };
    if (calm()) { qb.style.opacity = '.0'; de.style.opacity = '0'; done(); return; }
    const ease = (k) => 1 - Math.pow(1 - k, 3), lerp = (a, b, k) => a + (b - a) * k;
    const drop = p.from - 2.5, t0 = performance.now();
    const T = p.sack ? 900 : 1250;
    const endY = p.td ? Math.min(p.to + 4, 108) : p.to;
    const arc = 10 + Math.min(p.gain, 50) * 0.9;   // pixels of loft
    const frame = (now) => {
      if (!el.isConnected) return;
      const t = now - t0;
      const k1 = Math.min(1, t / 300);              // the drop
      at(qb, lerp(p.from, drop, ease(k1)), 52);
      if (p.sack) {
        const kr = Math.min(1, Math.max(0, (t - 120) / 520));
        at(de, lerp(Math.min(p.from + 6, 100), drop + 0.8, ease(kr)), lerp(72, 54, ease(kr)));
        at(ball, lerp(p.from, drop, ease(k1)), 52);
        at(wr, lerp(p.from, p.from + 6, Math.min(1, t / 800)), 30);
      } else {
        const kw = Math.min(1, t / (T - 100));
        at(wr, lerp(p.from, endY, kw * kw * (3 - 2 * kw)), lerp(30, p.td ? 46 : 34, kw));
        de.style.left = pct(fx(lerp(Math.min(p.from + 6, 100), Math.min(p.from + 9, 104), kw)));
        if (t < 300) { at(ball, lerp(p.from, drop, ease(k1)), 52); ball.style.transform = ''; }
        else {
          const kb = Math.min(1, (t - 300) / (T - 300));
          at(ball, lerp(drop, endY, kb), lerp(52, p.td ? 46 : 34, kb));
          ball.style.transform = `translate(-50%,-50%) translateY(${(-Math.sin(Math.PI * kb) * arc).toFixed(1)}px) rotate(${(kb * 720).toFixed(0)}deg) scale(${(1 + Math.sin(Math.PI * kb) * 0.45).toFixed(2)})`;
        }
      }
      if (t < T) requestAnimationFrame(frame);
      else { ball.style.transform = ''; done(); }
    };
    requestAnimationFrame(frame);
  }
  // The score counts up to where it ends.
  function countUp(el, to, from = 0) {
    if (!el || !(to > from) || calm()) return;
    const t0 = performance.now(), ms = 850;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      el.textContent = String(Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))));
      if (k < 1 && el.isConnected) requestAnimationFrame(step);
    };
    el.textContent = String(from);
    requestAnimationFrame(step);
  }
  // A phone that can buzz gives a tap on an answer, and more for a rare one.
  function buzz(pattern) {
    if (calm() || typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
    try { navigator.vibrate(pattern); } catch (_) { /* not allowed here: no buzz */ }
  }

  // ---- The card an answer comes back as ----
  // A trading card, front and back: it lands face down and turns over. The
  // front has the tier, a serial (how many said it, out of everyone who
  // answered; a One of One is 1/1), the player's initials where the photo
  // would be, the name plate, and the points.
  const initials = (name) => {
    const w = String(name || '').replace(/[^A-Za-z' -]/g, '').split(/[\s-]+/).filter(x => x && !/^(jr|sr|ii|iii|iv|v)$/i.test(x));
    return ((w[0] || '?')[0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase();
  };
  function cardFace(a, why, kind) {
    const tier = a ? a.tier : 'miss';
    const serial = !a ? '' : a.tier === 'one' ? '1/1' : `${a.said}/${a.of}`;
    const tag = KIND[kind] ? KIND[kind][0] : '';
    return `<div class="oo-flip-wrap" id="oo-tilt"><div class="oo-tilt"><div class="oo-flip oo-t-${tier}">
        <div class="oo-face oo-back" aria-hidden="true"><span class="oo-back-mark">1/1</span></div>
        <div class="oo-face oo-front">
          <div class="oo-cf-top"><span class="oo-flip-tier">${esc(a ? TIER[a.tier] : why)}</span>${a ? `<span class="oo-cf-serial" title="${a.tier === 'one' ? 'The only one' : `Said by ${a.said} of ${a.of}`}">${serial}</span>` : ''}</div>
          <div class="oo-cf-art"><span class="oo-cf-mono">${a ? esc(initials(a.name)) : '&ndash;'}</span></div>
          <div class="oo-cf-plate"><span class="oo-flip-name">${a ? esc(a.name) : 'No answer'}</span></div>
          <div class="oo-cf-foot"><span class="oo-cf-kind">${esc(tag)}</span><span class="oo-flip-pts">+${a ? a.points : 0}</span></div>
        </div>
      </div></div>${a ? sparks(a.tier) : ''}</div>`;
  }
  // The card leans toward the pointer, and its foil moves with it.
  function tilt() {
    const wrap = $('oo-tilt'), card = wrap && wrap.querySelector('.oo-tilt');
    if (!card || calm()) return;
    const set = (x, y) => {
      card.style.setProperty('--ry', `${(x * 18).toFixed(1)}deg`);
      card.style.setProperty('--rx', `${(-y * 14).toFixed(1)}deg`);
      card.style.setProperty('--fx', `${Math.round(50 + x * 90)}%`);
    };
    wrap.addEventListener('pointermove', (e) => {
      const r = wrap.getBoundingClientRect();
      if (r.width && r.height) set((e.clientX - r.left) / r.width - 0.5, (e.clientY - r.top) / r.height - 0.5);
    });
    wrap.addEventListener('pointerleave', () => set(0, 0));
  }
  // Where an answer sits between common and rare: the five tiers in a row,
  // its own lit, and a pin at its place on the line (data.tiers `from`).
  function meter(a) {
    const tiers = (data && data.tiers) || [], i = ORDER.indexOf(a.tier);
    if (i < 0 || tiers.length !== ORDER.length) return '';
    const lo = tiers[i].from || 0, hi = i + 1 < tiers.length ? tiers[i + 1].from : 100;
    const k = a.tier === 'one' || a.rarer == null ? 0.5 : Math.max(0, Math.min(1, (a.rarer - lo) / Math.max(1, hi - lo)));
    const at = Math.max(3, Math.min(97, ((i + k) / ORDER.length) * 100));
    const words = a.rarer == null ? TIER[a.tier] : a.rarer >= 10 ? `Rarer than ${Math.floor(a.rarer)}% of answers` : 'One of the most common answers';
    return `<div class="oo-meter" role="img" aria-label="${esc(words)}">
        <div class="oo-meter-track">${ORDER.map(t => `<i class="oo-t-${t}${t === a.tier ? ' on' : ''}"></i>`).join('')}<b class="oo-meter-pin oo-t-${a.tier}" style="--at:${at.toFixed(1)}%"></b></div>
        <div class="oo-meter-ends"><span>Common</span><strong>${esc(words)}</strong><span>Rare</span></div>
      </div>`;
  }
  // A finished pack gets a name, the way a box of cards does.
  function rating(score, max) {
    const k = max ? score / max : 0;
    return k >= 0.85 ? 'Case hit' : k >= 0.65 ? 'Monster pack' : k >= 0.45 ? 'Hot pack' : k >= 0.25 ? 'Solid pack' : score > 0 ? 'Base pack' : 'Empty wrapper';
  }
  // Where the score stands among the others who finished (the server's rank).
  function standing(unlimited) {
    const r = data && data.rank;
    if (!r || r.beat == null) return '';
    const where = unlimited ? 'on this round' : 'today';
    if (r.of < 5) return `<p class="oo-rank">Among the first to finish ${unlimited ? 'this round' : 'today&rsquo;s pack'}.</p>`;
    return `<div class="oo-rank"><p>Better than <b>${r.beat}%</b> of ${plural(r.of, 'other player')} ${where}${r.average != null ? ` &middot; average ${r.average}` : ''}</p>
      <div class="oo-rank-bar" aria-hidden="true"><i style="--k:${(r.beat / 100).toFixed(2)}"></i></div></div>`;
  }
  // How the scoring works, folded away on the start screen.
  function howItWorks() {
    const t = (data && data.tiers) || [];
    if (t.length !== ORDER.length) return '';
    const says = [`the most common answers`, `rarer than ${t[1].from}% of answers`, `rarer than ${t[2].from}%`, `rarer than ${t[3].from}%`, `the rarest ${100 - t[4].from}%, and only if nobody else has said it`];
    return `<details class="oo-how"><summary>How scoring works</summary>
      <div class="oo-ladder">${t.map((x, i) => `<div class="oo-rung"><span class="oo-chip oo-t-${x.id}">${esc(x.name)} <b>${x.points}</b></span><span>${says[i]}</span></div>`).join('')}</div>
      <ul class="oo-rules">
        <li>Every right answer is lined up from most to least common. Famous players start out common, and each answer real players give moves the line.</li>
        <li>Close spellings count, and a last name is enough when only one player fits.</li>
        <li>You get up to 8 tries on a prompt. The clock keeps running.</li>
        <li>A new pack lands every midnight, Eastern time.</li>
      </ul></details>`;
  }
  const skeleton = () => `<div class="oo-card oo-skel" aria-busy="true" aria-label="Loading the pack"><i class="oo-sk oo-sk-fan"></i><i class="oo-sk oo-sk-line w40"></i><i class="oo-sk oo-sk-line w80"></i><i class="oo-sk oo-sk-line w60"></i><i class="oo-sk oo-sk-btn"></i></div>`;
  function tierChips() {
    return '<div class="oo-tiers">' + ((data && data.tiers) || []).map(t =>
      `<span class="oo-chip oo-t-${t.id}">${esc(t.name)} <b>${t.points}</b></span>`).join('') + '</div>';
  }
  function statsLine() {
    const s = stats();
    if (!s || !s.plays) return '';
    return `<p class="oo-stats">${s.streak ? `${plural(s.streak, 'day')} in a row` : 'Streak: start a new one today'} &middot; Best ${s.best} &middot; Played ${s.plays}</p>`;
  }
  // The same three numbers on the results screen, as tiles.
  function statTiles() {
    const s = stats();
    if (!s || !s.plays) return '';
    const tile = (n, label) => `<div class="oo-tile"><b>${n}</b><span>${label}</span></div>`;
    return `<div class="oo-tiles">${tile(s.streak || 0, 'Day streak')}${tile(s.best || 0, 'Best score')}${tile(s.plays, s.plays === 1 ? 'Pack played' : 'Packs played')}</div>`;
  }
  const dateWords = (date) => { try { return new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' }); } catch (_) { return date; } };
  const playerLink = (a) => `<a class="oo-name" href="/?q=${encodeURIComponent(a.name)}" data-act="cards" data-name="${esc(a.name)}">${esc(a.name)}</a>`;
  function clockWords(ms) {
    const s = Math.max(0, Math.floor(ms / 1000)), p = (n) => String(n).padStart(2, '0');
    return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
  }

  // ---- Screens ----
  function paint() {
    const root = $('oo-root');
    if (!root) return;
    cancelAnimationFrame(raf); clearInterval(tick);
    const v = data && data.view;
    // A round on the clock gets the screen to itself (style.css, .oo-live).
    const view = $('play-view');
    if (view) view.classList.toggle('oo-live', phase === 'prompt' || phase === 'reveal');
    if (phase === 'loading') { root.innerHTML = skeleton(); return; }
    const unlimited = mode === 'unlimited';
    if (phase === 'error' || !v) {
      root.innerHTML = `<div class="oo-card"><p class="oo-p">${esc(errorText || 'The game could not be loaded.')}</p><button type="button" class="oo-btn" data-act="reload">Try again</button>
        ${unlimited ? '<button type="button" class="oo-link" data-act="daily">Back to today&rsquo;s pack</button>' : ''}</div>`;
      return;
    }
    const kicker = unlimited ? `Unlimited &middot; Round ${place().played + 1}` : `Daily pack #${v.number} &middot; ${esc(dateWords(v.date))}`;

    if (phase === 'start') {
      const going = v.started && !v.done;
      root.innerHTML = `<div class="oo-card oo-start">
        ${fan()}
        <div class="oo-kicker">${kicker}</div>
        <h3 class="oo-h">${v.count} prompts. ${v.seconds} seconds each.</h3>
        <p class="oo-p">Each prompt asks for a player. Any right answer scores, and the rarer it is among today&rsquo;s players, the more it&rsquo;s worth.</p>
        ${tierChips()}
        <p class="oo-p oo-small">A One of One is a right answer nobody else has given today.</p>
        ${howItWorks()}
        ${going ? slots(v, v.slot) : ''}
        <button type="button" class="oo-btn oo-big" data-act="next">${going ? `Keep going: prompt ${Math.min(v.slot + 1, v.count)} of ${v.count}` : 'Play today’s pack'}</button>
        ${v.players > 0 ? `<p class="oo-count"><i class="oo-dot" aria-hidden="true"></i>${v.players === 1 ? '1 collector has' : `${v.players.toLocaleString('en-US')} collectors have`} opened ${unlimited ? 'this round' : 'today&rsquo;s pack'}</p>` : ''}
        ${statsLine()}
        ${signedIn() ? '' : '<p class="oo-small oo-muted">No account needed. <button type="button" class="oo-link" data-act="login">Sign in</button> to keep your streak on every device.</p>'}
        ${unlimitedDoor()}
      </div>`;
      return;
    }

    if (phase === 'prompt' && v.active) {
      root.innerHTML = `<div class="oo-card oo-play">
        ${slots(v, v.active.slot)}
        <div class="oo-kicker-row">
          <div class="oo-kicker">${unlimited ? `${kicker} &middot; ` : ''}Prompt ${v.active.slot + 1} of ${v.count}</div>
          ${KIND[v.active.kind] ? `<span class="oo-kind">${mark(KIND[v.active.kind][1])}${KIND[v.active.kind][0]}${v.active.pool ? ` &middot; ${fits(v.active.pool)}` : ''}</span>` : ''}
        </div>
        <h3 class="oo-prompt">${esc(v.active.text)}</h3>
        <div class="oo-clock" aria-hidden="true"><div class="oo-clock-bar" id="oo-bar"></div></div>
        <form id="oo-form" class="oo-form" autocomplete="off">
          <input id="oo-input" type="text" autocomplete="off" autocorrect="off" autocapitalize="words" spellcheck="false" enterkeyhint="send" maxlength="60" placeholder="Type a player&rsquo;s name" aria-label="Your answer">
          <button type="submit" class="oo-btn" id="oo-send">Answer</button>
        </form>
        <div class="oo-under"><span id="oo-msg" class="oo-msg" role="status" aria-live="polite"></span><span id="oo-secs" class="oo-secs" aria-label="Seconds left"></span></div>
      </div>`;
      // On a phone, bring the prompt to the top so it and the answer box stay
      // in view above the keyboard.
      if (window.innerWidth <= 640) { try { root.scrollIntoView({ block: 'start' }); } catch (_) { /* older browsers */ } }
      const input = $('oo-input');
      if (input) { try { input.focus({ preventScroll: true }); } catch (_) { input.focus(); } }
      runClock();
      return;
    }

    if (phase === 'reveal' && shown) {
      const a = shown.answer, last = v.done;
      let card, line;
      if (a) {
        card = cardFace(a, '', shown.kind);
        const when = unlimited ? 'in this round' : 'today';
        line = a.tier === 'one' ? `Nobody else has said that ${when}. It&rsquo;s a One of One.`
          : a.said <= 1 ? `You&rsquo;re the first to say that ${when}.`
            : `${a.said} of ${plural(a.of, 'player')} said that.`;
      } else {
        const why = shown.miss === 'tries' ? 'Out of tries' : 'Out of time';
        card = cardFace(null, why, shown.kind);
        line = 'That slot stays empty. The answers show once you finish.';
      }
      // What was typed, when it was read as a name spelt another way.
      const typed = a && shown.read && shown.typed && shown.typed.toLowerCase() !== a.name.toLowerCase()
        ? `<p class="oo-read">Read &ldquo;${esc(shown.typed)}&rdquo; as <b>${esc(a.name)}</b></p>` : '';
      const dr = drive(v.answers);
      root.innerHTML = `<div class="oo-card oo-reveal">
        ${slots(v, -1, true)}
        ${field(dr, true)}
        ${card}
        ${typed}
        <p class="oo-p oo-center">${line}</p>
        ${a ? meter(a) : ''}
        <p class="oo-total">Pack total <b id="oo-total">${v.score}</b><span>/ ${v.maxScore}</span></p>
        <button type="button" class="oo-btn oo-big" id="oo-go" data-act="${last ? 'results' : 'next'}">${last ? 'See your results' : `Next prompt &middot; ${Math.min(v.slot + 1, v.count)} of ${v.count}`}</button>
      </div>`;
      if (a) countUp($('oo-total'), v.score, v.score - a.points);
      runPlay(dr);
      tilt();
      const go = $('oo-go');
      if (go) { try { go.focus({ preventScroll: true }); } catch (_) { go.focus(); } }
      return;
    }

    // Results: the round is done. One card for the score, one list for what
    // was said: the prompt with its tier on the right, then two short lines.
    const recap = (data.results || []).map((p, i) => {
      const y = p.yours;
      const chip = y ? `<span class="oo-chip oo-t-${y.tier}">${esc(TIER[y.tier])} <b>${y.points}</b></span>` : '<span class="oo-chip oo-t-miss">No answer</span>';
      // With one answer in, "most said" would only repeat the player's own.
      const top = p.n >= 2 ? (p.top || []).map(t => `${playerLink(t)} (${t.n})`).join(', ') : '';
      // How open the prompt was, and how much of it has been found.
      const pool = p.pool ? `${fits(p.pool)}${p.named ? ` &middot; ${p.named.toLocaleString('en-US')} named so far` : ''}` : '';
      const set = p.link && /^\/[a-z0-9/_-]+$/i.test(p.link.href || '') ? ` &middot; <a class="oo-name" href="${esc(p.link.href)}">See the checklist</a>` : '';
      return `<div class="oo-recap-item">
        <div class="oo-recap-q">${i + 1}. ${esc(p.text)}</div>
        <div class="oo-recap-chip">${chip}</div>
        ${y ? `<div class="oo-recap-line">You said ${playerLink(y)}${y.rarer >= 10 ? `, rarer than ${Math.floor(y.rarer)}% of answers` : ''}</div>` : ''}
        ${top ? `<div class="oo-recap-line">Most said: ${top}</div>` : ''}
        ${pool ? `<div class="oo-recap-line oo-recap-meta">${KIND[p.type] ? `${mark(KIND[p.type][1])}${KIND[p.type][0]} &middot; ` : ''}${pool}${set}</div>` : ''}
      </div>`;
    }).join('');
    if (unlimited) {
      root.innerHTML = `<div class="oo-card oo-results">
        <div class="oo-kicker oo-center">${kicker}</div>
        <div class="oo-rating">${rating(v.score, v.maxScore)}</div>
        <div class="oo-score"><strong>${v.score}</strong><span>/ ${v.maxScore}</span></div>
        ${slots(v, -1, false, true)}
        ${field(drive(v.answers), false)}
        ${standing(true)}
        ${roundTiles()}
        <button type="button" class="oo-btn oo-big" id="oo-go" data-act="another">Next round</button>
        <p class="oo-foot"><button type="button" class="oo-link" data-act="daily">Back to today&rsquo;s pack</button></p>
      </div>
      <h3 class="oo-h2">What everyone said</h3>
      <div class="oo-recap">${recap}</div>`;
      countUp(root.querySelector('.oo-score strong'), v.score);
      return;
    }
    root.innerHTML = `<div class="oo-card oo-results">
      <div class="oo-kicker oo-center">${kicker}</div>
      <div class="oo-rating">${rating(v.score, v.maxScore)}</div>
      <div class="oo-score"><strong>${v.score}</strong><span>/ ${v.maxScore}</span></div>
      ${slots(v, -1, false, true)}
      ${field(drive(v.answers), false)}
      ${standing(false)}
      ${statTiles()}
      <button type="button" class="oo-btn oo-big oo-share-btn" data-act="share"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v13"/><path d="M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>Share your pack</button>
      <p id="oo-shared" class="oo-msg oo-center" role="status" aria-live="polite"></p>
      <p class="oo-foot">Next pack in <span id="oo-countdown" class="oo-countdown">${clockWords(nextAt - Date.now())}</span>${signedIn() ? '' : ' &middot; <button type="button" class="oo-link" data-act="login">Sign in</button> to keep your streak'}</p>
      ${unlimitedDoor()}
    </div>
    <h3 class="oo-h2">What everyone said</h3>
    <div class="oo-recap">${recap}</div>`;
    countUp(root.querySelector('.oo-score strong'), v.score);
    prepareShare(v);
    tick = setInterval(() => {
      const el = $('oo-countdown'), left = nextAt - Date.now();
      if (!el) { clearInterval(tick); return; }
      if (left <= 0) { clearInterval(tick); load(); return; }   // midnight: the next pack is here
      el.textContent = clockWords(left);
    }, 1000);
  }

  // The bar and the seconds follow the server's clock: it sends how long is
  // left, and the page counts that down from the moment the reply arrived.
  function runClock() {
    const step = () => {
      const bar = $('oo-bar'), secs = $('oo-secs');
      if (!bar || phase !== 'prompt') return;
      const left = deadline - performance.now();
      bar.style.transform = `scaleX(${Math.max(0, Math.min(1, left / total))})`;
      bar.classList.toggle('low', left < 6000);
      const card = bar.closest('.oo-play');
      if (card) card.classList.toggle('low', left < 6000);
      if (secs) { secs.textContent = String(Math.max(0, Math.ceil(left / 1000))); secs.classList.toggle('low', left < 6000); }
      if (left <= 0) { send(true); return; }
      raf = requestAnimationFrame(step);
    };
    step();
  }

  // Put a reply on screen.
  function take(d) {
    data = d;
    nextAt = Date.now() + (d.msToNext || 0);
    const v = d.view;
    // The streak is the daily pack's; an unlimited round has its own count.
    if (v && v.done) { if (v.mode === 'unlimited') noteRound(v); else noteFinished(v); }
    if (v && v.active) { deadline = performance.now() + v.active.msLeft; total = v.seconds * 1000; }
  }

  async function load() {
    phase = 'loading'; paint();
    try {
      take(await api(mode === 'unlimited' ? `/api/game/today?round=${roundNow()}` : '/api/game/today'));
      const v = data.view;
      shown = null;
      phase = v.done ? 'results' : v.active ? 'prompt' : 'start';
    } catch (err) { phase = 'error'; errorText = err.message; }
    paint();
  }

  // What every call says about which pack it is for: the unlimited round, or
  // the day (so a round begun before midnight is finished on that day's pack).
  const which = () => (mode === 'unlimited' ? { round: roundNow() } : { date: data && data.view && data.view.date });

  // `again` (unlimited only): begin this round, even if this player has
  // finished it before. A round under way is carried on, not restarted.
  async function next(again) {
    if (busy) return;
    busy = true;
    try {
      take(await api('/api/game/next', { ...which(), again: !!again }));
      const v = data.view;
      shown = null;
      phase = v.done ? 'results' : v.active ? 'prompt' : 'start';
    } catch (err) { phase = 'error'; errorText = err.message; }
    busy = false;
    paint();
  }

  // Into unlimited from the daily screens: carry on where this browser was,
  // or move to the next round if the last one is finished and counted.
  function playUnlimited(advance) {
    if (busy || !unlimitedOn()) return;
    const u = place();
    if (advance || u.scored === u.played) saveUnl({ ...u, played: u.played + 1 });
    mode = 'unlimited';
    next(true);
  }
  function backToDaily() { if (busy) return; mode = 'daily'; load(); }

  // Send what is typed. `final` is the last word on this prompt: the clock
  // reached zero. There is no Skip button: a prompt is answered or runs out.
  async function send(final) {
    if (busy || phase !== 'prompt') return;
    const input = $('oo-input'), msg = $('oo-msg'), btn = $('oo-send');
    const text = ((input && input.value) || '').trim();
    if (!final && !text) { if (msg) msg.textContent = WHY.empty; return; }
    busy = true;
    cancelAnimationFrame(raf);
    const kind = (data && data.view && data.view.active && data.view.active.kind) || '';
    if (input) input.disabled = true;
    if (btn) btn.disabled = true;
    try {
      const d = await api('/api/game/answer', { ...which(), text, final: !!final });
      take(d);
      if (d.ok) {
        shown = { answer: d.answer, read: d.read || null, typed: text, kind }; phase = 'reveal';
        buzz(d.answer.tier === 'one' ? [20, 50, 20, 50, 45] : d.answer.tier === 'gold' ? [15, 40, 20] : 12);
      }
      else if (d.timeout) { shown = { miss: d.reason, kind }; phase = 'reveal'; }
      else if (d.error || !d.view.active) { busy = false; return load(); }   // the round moved on without this page
      else {
        // Not a match: same prompt, same clock, try again.
        busy = false;
        if (input) { input.disabled = false; input.select(); try { input.focus({ preventScroll: true }); } catch (_) { input.focus(); } }
        if (btn) btn.disabled = false;
        const form = $('oo-form');
        if (form) { form.classList.remove('oo-shake'); void form.offsetWidth; form.classList.add('oo-shake'); }
        buzz(30);
        const left = d.view.active.triesLeft;
        if (msg) msg.textContent = (WHY[d.reason] || WHY.none) + (left <= 3 ? ` ${left} ${left === 1 ? 'try' : 'tries'} left.` : '');
        runClock();
        return;
      }
    } catch (err) { phase = 'error'; errorText = err.message; }
    busy = false;
    paint();
  }

  // ---- Sharing ----
  // Sharing sends a picture of the pack (the score, the seven cards in their
  // tiers, the site) with the text, so it looks like something in a group
  // chat, not a row of squares. Tiers only, never an answer.
  const TIER_ART = {
    base: { fill: '#cbd5e1', ink: '#0f172a', label: 'BASE' },
    green: { fill: '#22c55e', ink: '#052e16', label: 'GREEN' },
    blue: { fill: '#3b82f6', ink: '#ffffff', label: 'BLUE' },
    gold: { fill: '#facc15', ink: '#231a00', label: 'GOLD' },
    one: { fill: '#0b0b0f', ink: '#fde68a', label: '1/1' },
  };
  let shareFile = null, shareFor = null;
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  const loadImg = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; });
  async function shareImage(v) {
    const W = 1080, H = 1350;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (_) { /* draw with what there is */ }
    const font = (getComputedStyle(document.body).fontFamily || '') + ', Inter, system-ui, sans-serif';
    const F = (w, px) => `${w} ${px}px ${font}`;
    const spaced = (px) => { try { ctx.letterSpacing = px + 'px'; } catch (_) { /* older browsers */ } };

    // Backdrop: the game's night sky, soft lights, a few cards drifting.
    ctx.fillStyle = '#0a0f1c'; ctx.fillRect(0, 0, W, H);
    const glow = (x, y, r, col) => { const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, col); g.addColorStop(1, 'rgba(10,15,28,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); };
    glow(140, 120, 760, 'rgba(34,197,94,.30)');
    glow(1000, 300, 560, 'rgba(59,130,246,.18)');
    glow(940, 1300, 760, 'rgba(234,179,8,.22)');
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 3;
    for (const [x, y, a] of [[90, 470, -0.3], [960, 560, 0.25], [140, 1150, 0.2], [930, 1060, -0.15], [820, 90, 0.35]]) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(a); roundRect(ctx, -45, -63, 90, 126, 12); ctx.stroke(); ctx.restore();
    }
    ctx.restore();
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';

    // The site's logo, or its name.
    const logo = await loadImg('logo-dark-h160.webp');
    if (logo) { const h = 112, w = h * logo.width / logo.height; ctx.drawImage(logo, (W - w) / 2, 44, w, h); }
    else { ctx.fillStyle = '#e2e8f0'; ctx.font = F(800, 34); spaced(4); ctx.fillText('THE CARD HUDDLE', W / 2, 118); spaced(0); }

    // Title in foil.
    ctx.font = F(900, 128); spaced(-2);
    const foil = ctx.createLinearGradient(220, 0, 860, 0);
    foil.addColorStop(0, '#fde68a'); foil.addColorStop(0.35, '#facc15'); foil.addColorStop(0.55, '#fff7d6'); foil.addColorStop(0.8, '#eab308'); foil.addColorStop(1, '#fde68a');
    ctx.fillStyle = foil; ctx.shadowColor = 'rgba(234,179,8,.35)'; ctx.shadowBlur = 30;
    ctx.fillText('One of One', W / 2, 300);
    ctx.shadowBlur = 0; spaced(0);
    ctx.fillStyle = '#94a3b8'; ctx.font = F(700, 32); spaced(3);
    ctx.fillText(`DAILY PACK #${v.number} · ${dateWords(v.date).toUpperCase()}`, W / 2, 368);
    spaced(0);

    // The score.
    ctx.font = F(900, 240); const sw = ctx.measureText(String(v.score)).width;
    ctx.font = F(800, 70); const mw = ctx.measureText(`/ ${v.maxScore}`).width;
    const sx = (W - sw - 24 - mw) / 2;
    ctx.textAlign = 'left';
    ctx.font = F(900, 240); ctx.fillStyle = '#ffffff'; spaced(-6); ctx.fillText(String(v.score), sx, 640); spaced(0);
    ctx.font = F(800, 70); ctx.fillStyle = '#64748b'; ctx.fillText(`/ ${v.maxScore}`, sx + sw + 24, 640);
    ctx.textAlign = 'center';

    // The seven cards.
    const ans = v.answers || [];
    const cw = 118, ch = 166, gap = 16, n = Math.max(ans.length, v.count || 7);
    const x0 = (W - (n * cw + (n - 1) * gap)) / 2, y0 = 720;
    for (let i = 0; i < n; i++) {
      const a = ans[i], x = x0 + i * (cw + gap), art = a ? TIER_ART[a.tier] : null;
      ctx.save();
      if (!art) {
        roundRect(ctx, x, y0, cw, ch, 16); ctx.setLineDash([10, 8]); ctx.strokeStyle = '#334155'; ctx.lineWidth = 3; ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#475569'; ctx.font = F(800, 40); ctx.fillText('–', x + cw / 2, y0 + ch / 2 + 14);
        ctx.restore(); continue;
      }
      if (a.tier === 'one') {
        ctx.shadowColor = 'rgba(234,179,8,.7)'; ctx.shadowBlur = 34;
        const g = ctx.createLinearGradient(x, y0, x + cw, y0 + ch); g.addColorStop(0, '#26263a'); g.addColorStop(1, '#000'); ctx.fillStyle = g;
      } else {
        ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 8; ctx.fillStyle = art.fill;
      }
      roundRect(ctx, x, y0, cw, ch, 16); ctx.fill();
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      if (a.tier === 'one') { ctx.strokeStyle = '#eab308'; ctx.lineWidth = 4; ctx.stroke(); }
      else { const sh = ctx.createLinearGradient(x, y0, x + cw, y0 + ch); sh.addColorStop(0, 'rgba(255,255,255,.35)'); sh.addColorStop(0.45, 'rgba(255,255,255,0)'); ctx.fillStyle = sh; roundRect(ctx, x, y0, cw, ch, 16); ctx.fill(); }
      ctx.fillStyle = art.ink;
      if (a.tier === 'one') { ctx.font = F(900, 46); ctx.fillText('1/1', x + cw / 2, y0 + ch / 2 + 16); }
      else {
        ctx.font = F(800, 17); spaced(2); ctx.fillText(art.label, x + cw / 2, y0 + 34); spaced(0);
        ctx.font = F(900, 36); ctx.fillText(`+${a.points}`, x + cw / 2, y0 + ch - 30);
      }
      ctx.restore();
    }

    // The rare ones, and the streak.
    const count = (t) => ans.filter(a => a && a.tier === t).length;
    const bits = [];
    if (count('one')) bits.push(count('one') === 1 ? '1 One of One' : `${count('one')} One of Ones`);
    if (count('gold')) bits.push(`${count('gold')} Gold`);
    const st = stats();
    const dv = drive(ans);
    if (dv.tds) bits.push(dv.tds === 1 ? '1 TD' : `${dv.tds} TDs`);
    if (st && st.streak > 1) bits.push(`${st.streak}-day streak`);
    if (bits.length) { ctx.fillStyle = '#e2e8f0'; ctx.font = F(700, 40); ctx.fillText(bits.join('  ·  '), W / 2, 1000); }

    // The challenge and where to play.
    ctx.fillStyle = '#ffffff'; ctx.font = F(900, 56); ctx.fillText('Can you beat it?', W / 2, 1138);
    ctx.font = F(800, 38); const url = 'thecardhuddle.com/play', uw = ctx.measureText(url).width + 72;
    roundRect(ctx, (W - uw) / 2, 1180, uw, 76, 38); ctx.fillStyle = 'rgba(34,197,94,.14)'; ctx.fill();
    ctx.strokeStyle = 'rgba(74,222,128,.6)'; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.fillStyle = '#4ade80'; ctx.fillText(url, W / 2, 1231);

    return new Promise((ok) => c.toBlob(ok, 'image/png'));
  }
  // Made when the results show, so the tap on Share opens the sheet at once.
  async function prepareShare(v) {
    const key = `${v.date}|${v.score}`;
    if (shareFor === key && shareFile) return;
    shareFor = key; shareFile = null;
    try {
      const blob = await shareImage(v);
      if (blob && shareFor === key) shareFile = new File([blob], `one-of-one-${v.number}.png`, { type: 'image/png' });
    } catch (_) { /* text still shares */ }
  }

  async function share() {
    const text = (data && data.share) || '';
    if (!text) return;
    const file = shareFile;
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    try {
      if (mobile && file && navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text }); return; }
      if (mobile && navigator.share && !file) { await navigator.share({ text }); return; }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
    openShareSheet(file, text);
  }

  // On a computer (or a phone that cannot share a picture): the picture, with
  // Copy image, Save image and Copy text.
  function openShareSheet(file, text) {
    closeShareSheet();
    const url = file ? URL.createObjectURL(file) : '';
    const canCopyImg = !!(file && window.ClipboardItem && navigator.clipboard && navigator.clipboard.write);
    const el = document.createElement('div');
    el.className = 'oo-sheet'; el.id = 'oo-sheet';
    el.innerHTML = `<div class="oo-sheet-card" role="dialog" aria-modal="true" aria-label="Share your pack">
      <button type="button" class="oo-sheet-x" data-sh="close" aria-label="Close">&times;</button>
      ${url ? `<img class="oo-sheet-img" src="${url}" alt="Your One of One pack: ${esc(String(data.view.score))} of ${esc(String(data.view.maxScore))}">` : `<pre class="oo-sheet-text">${esc(text)}</pre>`}
      <div class="oo-sheet-row">
        ${canCopyImg ? '<button type="button" class="oo-btn" data-sh="copyimg">Copy image</button>' : ''}
        ${file ? `<a class="oo-btn oo-ghost" data-sh="save" href="${url}" download="${esc(file.name)}">Save image</a>` : ''}
        <button type="button" class="oo-btn oo-ghost" data-sh="copytext">Copy text</button>
      </div>
      <p class="oo-msg oo-center" id="oo-sheet-msg" role="status" aria-live="polite"></p>
    </div>`;
    const say = (m) => { const o = document.getElementById('oo-sheet-msg'); if (o) o.textContent = m; };
    el.addEventListener('click', async (e) => {
      if (e.target === el) { closeShareSheet(); return; }
      const b = e.target.closest('[data-sh]');
      if (!b) return;
      const act = b.dataset.sh;
      if (act === 'close') closeShareSheet();
      else if (act === 'copyimg') {
        try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': file })]); say('Image copied. Paste it anywhere.'); }
        catch (_) { say('Your browser would not copy the image. Save it instead.'); }
      } else if (act === 'copytext') {
        try { await navigator.clipboard.writeText(text); say('Copied. Paste it anywhere.'); }
        catch (_) { say(text); }
      } else if (act === 'save') say('Saved.');
    });
    el._url = url;
    document.body.appendChild(el);
    document.addEventListener('keydown', sheetKey);
    const first = el.querySelector('.oo-sheet-row .oo-btn'); if (first) first.focus();
  }
  function sheetKey(e) { if (e.key === 'Escape') closeShareSheet(); }
  function closeShareSheet() {
    const el = document.getElementById('oo-sheet');
    document.removeEventListener('keydown', sheetKey);
    if (!el) return;
    if (el._url) setTimeout(() => URL.revokeObjectURL(el._url), 1000);
    el.remove();
  }

  // A player's name opens their sold prices in Search.
  function seeCards(name) {
    if (typeof switchView !== 'function' || typeof performSearch !== 'function') return false;
    switchView('search');
    const box = $('search-input');
    if (box) box.value = name;
    performSearch(name);
    return true;
  }

  function bind() {
    const root = $('oo-root');
    if (!root || root.dataset.bound) return;
    root.dataset.bound = '1';
    root.addEventListener('click', (e) => {
      const t = e.target.closest('[data-act]');
      if (!t) return;
      const act = t.dataset.act;
      if (act === 'cards') { if (seeCards(t.dataset.name)) e.preventDefault(); return; }
      e.preventDefault();
      if (act === 'next') next(false);
      else if (act === 'unlimited') playUnlimited(false);
      else if (act === 'another') playUnlimited(true);
      else if (act === 'daily') backToDaily();
      else if (act === 'results') { phase = 'results'; paint(); }
      else if (act === 'share') share();
      else if (act === 'reload') load();
      else if (act === 'login' && typeof showLogin === 'function') showLogin();
    });
    root.addEventListener('submit', (e) => { e.preventDefault(); send(false); });
  }

  // switchView('play') calls this each time the tab is opened.
  window.initPlayView = function () {
    bind();
    if (!loaded) { loaded = true; load(); return; }
    // Coming back to the tab: a round on the clock is left alone; anything
    // else is read again, so a new day or a sign-in shows.
    if (phase !== 'prompt' && phase !== 'reveal' && !busy) load();
  };
  // The backdrop (index.html, .oo-bg) shows while the game's view does:
  // switchView hides and shows views by their `hidden` class.
  (function backdrop() {
    const v = $('play-view');
    if (!v) return;
    const sync = () => document.body.classList.toggle('oo-on', !v.classList.contains('hidden'));
    sync();
    if (window.MutationObserver) new MutationObserver(sync).observe(v, { attributes: true, attributeFilter: ['class'] });
  })();
  // The page can open straight on /play, where app.js shows the view before
  // this file has loaded.
  const view = $('play-view');
  if (view && !view.classList.contains('hidden')) window.initPlayView();
})();
