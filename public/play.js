// One of One, the daily game (owner, Nov 2026): seven prompts a day, twenty
// seconds each; name a player who fits, and the rarer the answer among the
// day's players, the more it scores. Server: server.js "One of One"; rules:
// game-core.js. This file is the screens: start, prompt, reveal, results.
// Uses app.js helpers where they exist: authFetch, safeJson, escHtml,
// showLogin, getSessionToken, switchView, performSearch.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => (typeof escHtml === 'function' ? escHtml(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const TIER = { base: 'Base', green: 'Green', blue: 'Blue', gold: 'Gold', one: 'One of One' };
  const WHY = {
    none: 'No match. Check the spelling or try someone else.',
    ambiguous: 'More than one player fits that. Add a first name.',
    empty: 'Type a player’s name.',
  };

  let data = null;        // the server's last reply: { view, tiers, msToNext, results, share, stats }
  let phase = 'loading';  // loading | start | prompt | reveal | results | error
  let shown = null;       // what the reveal screen is showing: { answer } or { miss: reason }
  let deadline = 0, total = 20000, raf = 0, busy = false, loaded = false, nextAt = 0, tick = 0, errorText = '';

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

  // ---- Pieces of a screen ----
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  function slots(view, current) {
    let h = '<div class="oo-slots" aria-label="Your pack so far">';
    for (let i = 0; i < view.count; i++) {
      const a = view.answers[i];
      if (i < view.answers.length) h += a ? `<span class="oo-slot oo-t-${a.tier}" title="${esc(TIER[a.tier])}"></span>` : '<span class="oo-slot oo-t-miss" title="No answer"></span>';
      else h += `<span class="oo-slot${i === current ? ' now' : ''}"></span>`;
    }
    return h + '</div>';
  }
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
    if (phase === 'loading') { root.innerHTML = '<p class="oo-loading">Loading today’s pack&hellip;</p>'; return; }
    if (phase === 'error' || !v) {
      root.innerHTML = `<div class="oo-card"><p class="oo-p">${esc(errorText || 'The game could not be loaded.')}</p><button type="button" class="oo-btn" data-act="reload">Try again</button></div>`;
      return;
    }
    const kicker = `Daily pack #${v.number} &middot; ${esc(dateWords(v.date))}`;

    if (phase === 'start') {
      const going = v.started && !v.done;
      root.innerHTML = `<div class="oo-card oo-start">
        <div class="oo-kicker">${kicker}</div>
        <h3 class="oo-h">${v.count} prompts. ${v.seconds} seconds each.</h3>
        <p class="oo-p">Each prompt asks for a player. Any right answer scores, and the rarer it is among today&rsquo;s players, the more it&rsquo;s worth.</p>
        ${tierChips()}
        <p class="oo-p oo-small">A One of One is a right answer nobody else has given today.</p>
        ${going ? slots(v, v.slot) : ''}
        <button type="button" class="oo-btn oo-big" data-act="next">${going ? `Keep going: prompt ${Math.min(v.slot + 1, v.count)} of ${v.count}` : 'Play today’s pack'}</button>
        ${statsLine()}
        ${signedIn() ? '' : '<p class="oo-small oo-muted">No account needed. <button type="button" class="oo-link" data-act="login">Sign in</button> to keep your streak on every device.</p>'}
      </div>`;
      return;
    }

    if (phase === 'prompt' && v.active) {
      root.innerHTML = `<div class="oo-card oo-play">
        ${slots(v, v.active.slot)}
        <div class="oo-kicker">Prompt ${v.active.slot + 1} of ${v.count}</div>
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
        card = `<div class="oo-flip oo-t-${a.tier}"><span class="oo-flip-tier">${esc(TIER[a.tier])}</span><span class="oo-flip-name">${esc(a.name)}</span><span class="oo-flip-pts">+${a.points}</span></div>`;
        line = a.tier === 'one' ? 'Nobody else has said that today. It&rsquo;s a One of One.'
          : a.said <= 1 ? 'You&rsquo;re the first to say that today.'
            : `${a.said} of ${plural(a.of, 'player')} said that.`;
      } else {
        const why = shown.miss === 'tries' ? 'Out of tries' : 'Out of time';
        card = `<div class="oo-flip oo-t-miss"><span class="oo-flip-tier">${why}</span><span class="oo-flip-name">No answer</span><span class="oo-flip-pts">+0</span></div>`;
        line = 'That slot stays empty. The answers show once you finish.';
      }
      root.innerHTML = `<div class="oo-card oo-reveal">
        ${slots(v, -1)}
        ${card}
        <p class="oo-p oo-center">${line}</p>
        <button type="button" class="oo-btn oo-big" id="oo-go" data-act="${last ? 'results' : 'next'}">${last ? 'See your results' : 'Next prompt'}</button>
      </div>`;
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
      return `<div class="oo-recap-item">
        <div class="oo-recap-q">${i + 1}. ${esc(p.text)}</div>
        <div class="oo-recap-chip">${chip}</div>
        ${y ? `<div class="oo-recap-line">You said ${playerLink(y)}</div>` : ''}
        ${top ? `<div class="oo-recap-line">Most said: ${top}</div>` : ''}
      </div>`;
    }).join('');
    root.innerHTML = `<div class="oo-card oo-results">
      <div class="oo-kicker oo-center">${kicker}</div>
      <div class="oo-score"><strong>${v.score}</strong><span>/ ${v.maxScore}</span></div>
      ${slots(v, -1)}
      ${statTiles()}
      <button type="button" class="oo-btn oo-big" data-act="share">Share your pack</button>
      <p id="oo-shared" class="oo-msg oo-center" role="status" aria-live="polite"></p>
      <p class="oo-foot">Next pack in <span id="oo-countdown" class="oo-countdown">${clockWords(nextAt - Date.now())}</span>${signedIn() ? '' : ' &middot; <button type="button" class="oo-link" data-act="login">Sign in</button> to keep your streak'}</p>
    </div>
    <h3 class="oo-h2">What everyone said</h3>
    <div class="oo-recap">${recap}</div>`;
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
      if (secs) secs.textContent = String(Math.max(0, Math.ceil(left / 1000)));
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
    if (v && v.done) noteFinished(v);
    if (v && v.active) { deadline = performance.now() + v.active.msLeft; total = v.seconds * 1000; }
  }

  async function load() {
    phase = 'loading'; paint();
    try {
      take(await api('/api/game/today'));
      const v = data.view;
      shown = null;
      phase = v.done ? 'results' : v.active ? 'prompt' : 'start';
    } catch (err) { phase = 'error'; errorText = err.message; }
    paint();
  }

  async function next() {
    if (busy) return;
    busy = true;
    try {
      take(await api('/api/game/next', { date: data && data.view && data.view.date }));
      const v = data.view;
      shown = null;
      phase = v.done ? 'results' : v.active ? 'prompt' : 'start';
    } catch (err) { phase = 'error'; errorText = err.message; }
    busy = false;
    paint();
  }

  // Send what is typed. `final` is the last word on this prompt: the clock
  // reached zero. There is no Skip button: a prompt is answered or runs out.
  async function send(final) {
    if (busy || phase !== 'prompt') return;
    const input = $('oo-input'), msg = $('oo-msg'), btn = $('oo-send');
    const text = ((input && input.value) || '').trim();
    if (!final && !text) { if (msg) msg.textContent = WHY.empty; return; }
    busy = true;
    cancelAnimationFrame(raf);
    if (input) input.disabled = true;
    if (btn) btn.disabled = true;
    try {
      const d = await api('/api/game/answer', { text, final: !!final, date: data.view.date });
      take(d);
      if (d.ok) { shown = { answer: d.answer }; phase = 'reveal'; }
      else if (d.timeout) { shown = { miss: d.reason }; phase = 'reveal'; }
      else if (d.error || !d.view.active) { busy = false; return load(); }   // the round moved on without this page
      else {
        // Not a match: same prompt, same clock, try again.
        busy = false;
        if (input) { input.disabled = false; input.select(); try { input.focus({ preventScroll: true }); } catch (_) { input.focus(); } }
        if (btn) btn.disabled = false;
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
      if (act === 'next') next();
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
  // The page can open straight on /play, where app.js shows the view before
  // this file has loaded.
  const view = $('play-view');
  if (view && !view.classList.contains('hidden')) window.initPlayView();
})();
