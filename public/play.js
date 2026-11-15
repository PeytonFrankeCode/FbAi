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
      root.innerHTML = `<div class="oo-card oo-reveal">
        ${slots(v, -1, true)}
        ${card}
        ${typed}
        <p class="oo-p oo-center">${line}</p>
        ${a ? meter(a) : ''}
        <p class="oo-total">Pack total <b id="oo-total">${v.score}</b><span>/ ${v.maxScore}</span></p>
        <button type="button" class="oo-btn oo-big" id="oo-go" data-act="${last ? 'results' : 'next'}">${last ? 'See your results' : `Next prompt &middot; ${Math.min(v.slot + 1, v.count)} of ${v.count}`}</button>
      </div>`;
      if (a) countUp($('oo-total'), v.score, v.score - a.points);
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
      ${standing(false)}
      ${statTiles()}
      <button type="button" class="oo-btn oo-big" data-act="share">Share your pack</button>
      <p id="oo-shared" class="oo-msg oo-center" role="status" aria-live="polite"></p>
      <p class="oo-foot">Next pack in <span id="oo-countdown" class="oo-countdown">${clockWords(nextAt - Date.now())}</span>${signedIn() ? '' : ' &middot; <button type="button" class="oo-link" data-act="login">Sign in</button> to keep your streak'}</p>
      ${unlimitedDoor()}
    </div>
    <h3 class="oo-h2">What everyone said</h3>
    <div class="oo-recap">${recap}</div>`;
    countUp(root.querySelector('.oo-score strong'), v.score);
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

  async function share() {
    const text = (data && data.share) || '';
    const out = $('oo-shared');
    if (!text) return;
    try {
      if (navigator.share && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) { await navigator.share({ text }); return; }
      await navigator.clipboard.writeText(text);
      if (out) out.textContent = 'Copied. Paste it anywhere.';
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (out) out.textContent = text;   // no clipboard: show it to copy by hand
    }
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
