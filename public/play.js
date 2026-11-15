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

  let data = null;        // the server's last reply: { view, tiers, msToNext, results, share, stats }
  let phase = 'loading';  // loading | start | prompt | reveal | results | error
  let shown = null;       // what the reveal screen is showing: { answer } or { miss: reason }
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
  // `fresh`: the slot just filled lands with a pop (the reveal screen).
  function slots(view, current, fresh) {
    let h = '<div class="oo-slots" aria-label="Your pack so far">';
    for (let i = 0; i < view.count; i++) {
      const a = view.answers[i], pop = fresh && i === view.answers.length - 1 ? ' new' : '';
      if (i < view.answers.length) h += a ? `<span class="oo-slot oo-t-${a.tier}${pop}" style="--i:${i}" title="${esc(TIER[a.tier])}"></span>` : `<span class="oo-slot oo-t-miss${pop}" style="--i:${i}" title="No answer"></span>`;
      else h += `<span class="oo-slot${i === current ? ' now' : ''}" style="--i:${i}"></span>`;
    }
    return h + '</div>';
  }

  // ---- Show ----
  const calm = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  // The five tiers as a fan of cards, the 1/1 in front (the start screen).
  const fan = () => `<div class="oo-fan" aria-hidden="true"><i class="oo-fan-card oo-t-base"></i><i class="oo-fan-card oo-t-green"></i><i class="oo-fan-card oo-t-blue"></i><i class="oo-fan-card oo-t-gold"></i><i class="oo-fan-card oo-t-one oo-shine">1/1</i></div>`;
  // A One of One throws sparks; a Gold, a few.
  function sparks(tier) {
    const n = tier === 'one' ? 22 : tier === 'gold' ? 9 : 0;
    if (!n || calm()) return '';
    const colors = tier === 'one' ? ['#fde68a', '#facc15', '#ffffff', '#eab308'] : ['#facc15', '#fde68a'];
    let h = '<span class="oo-sparks" aria-hidden="true">';
    for (let i = 0; i < n; i++) {
      const angle = Math.round((360 / n) * i + Math.random() * 16 - 8), reach = 120 + Math.round(Math.random() * 80);
      h += `<i style="--a:${angle}deg;--r:${reach}px;--k:${colors[i % colors.length]};--u:${(0.8 + Math.random() * 0.5).toFixed(2)}s;--w:${(0.45 + Math.random() * 0.15).toFixed(2)}s"></i>`;
    }
    return h + '</span>';
  }
  // The score counts up to where it ends.
  function countUp(el, to) {
    if (!el || !(to > 0) || calm()) return;
    const t0 = performance.now(), ms = 850;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      el.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 3))));
      if (k < 1 && el.isConnected) requestAnimationFrame(step);
    };
    el.textContent = '0';
    requestAnimationFrame(step);
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
        ${going ? slots(v, v.slot) : ''}
        <button type="button" class="oo-btn oo-big" data-act="next">${going ? `Keep going: prompt ${Math.min(v.slot + 1, v.count)} of ${v.count}` : 'Play today’s pack'}</button>
        ${statsLine()}
        ${signedIn() ? '' : '<p class="oo-small oo-muted">No account needed. <button type="button" class="oo-link" data-act="login">Sign in</button> to keep your streak on every device.</p>'}
        ${unlimitedDoor()}
      </div>`;
      return;
    }

    if (phase === 'prompt' && v.active) {
      root.innerHTML = `<div class="oo-card oo-play">
        ${slots(v, v.active.slot)}
        <div class="oo-kicker">${unlimited ? `${kicker} &middot; ` : ''}Prompt ${v.active.slot + 1} of ${v.count}</div>
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
        card = `<div class="oo-flip-wrap"><div class="oo-flip oo-t-${a.tier}"><span class="oo-flip-tier">${esc(TIER[a.tier])}</span><span class="oo-flip-name">${esc(a.name)}</span><span class="oo-flip-pts">+${a.points}</span></div>${sparks(a.tier)}</div>`;
        const when = unlimited ? 'in this round' : 'today';
        line = a.tier === 'one' ? `Nobody else has said that ${when}. It&rsquo;s a One of One.`
          : a.said <= 1 ? `You&rsquo;re the first to say that ${when}.`
            : `${a.said} of ${plural(a.of, 'player')} said that.`;
      } else {
        const why = shown.miss === 'tries' ? 'Out of tries' : 'Out of time';
        card = `<div class="oo-flip-wrap"><div class="oo-flip oo-t-miss"><span class="oo-flip-tier">${why}</span><span class="oo-flip-name">No answer</span><span class="oo-flip-pts">+0</span></div></div>`;
        line = 'That slot stays empty. The answers show once you finish.';
      }
      root.innerHTML = `<div class="oo-card oo-reveal">
        ${slots(v, -1, true)}
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
    if (unlimited) {
      root.innerHTML = `<div class="oo-card oo-results">
        <div class="oo-kicker oo-center">${kicker}</div>
        <div class="oo-score"><strong>${v.score}</strong><span>/ ${v.maxScore}</span></div>
        ${slots(v, -1)}
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
      <div class="oo-score"><strong>${v.score}</strong><span>/ ${v.maxScore}</span></div>
      ${slots(v, -1)}
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
    if (input) input.disabled = true;
    if (btn) btn.disabled = true;
    try {
      const d = await api('/api/game/answer', { ...which(), text, final: !!final });
      take(d);
      if (d.ok) { shown = { answer: d.answer }; phase = 'reveal'; }
      else if (d.timeout) { shown = { miss: d.reason }; phase = 'reveal'; }
      else if (d.error || !d.view.active) { busy = false; return load(); }   // the round moved on without this page
      else {
        // Not a match: same prompt, same clock, try again.
        busy = false;
        if (input) { input.disabled = false; input.select(); try { input.focus({ preventScroll: true }); } catch (_) { input.focus(); } }
        if (btn) btn.disabled = false;
        const form = $('oo-form');
        if (form) { form.classList.remove('oo-shake'); void form.offsetWidth; form.classList.add('oo-shake'); }
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
