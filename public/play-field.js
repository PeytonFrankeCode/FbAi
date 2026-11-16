// One of One: the play on the field (owner, Nov 2026: "it would focus to just
// the field and maybe a more detailed field with the players and everything").
//
// After an answer the screen goes to a football field seen from above. Both
// teams line up at the spot, the ball is snapped, and the pass goes exactly as
// far as the answer earned (play.js `drive`): the player who was named runs
// the route and makes the catch. No answer is a sack. Past the goal line is a
// touchdown. This file only draws. It is handed a play
// ({ from, gain, td, sack, tier }) and decides nothing about the score.
// The look is its own: a top-down field, white and gold against navy.
(function () {
  'use strict';

  // ---- The field, in yards ----
  const FW = 160 / 3;            // across: 53 1/3 yards
  const FL = 120;                // end line to end line, both end zones in
  const PAD = 3;                 // ground drawn beyond each end line
  const APRON = 4;               // sideline shown either side when there is room
  const MIN_S = 10.5;            // pixels to the yard at the least: players read on a phone
  const BX = FW / 2;             // the ball is snapped from the middle
  const HASH = 3.083;            // the inbounds lines sit 18 ft 6 in apart
  const T0 = 550;                // the snap, in ms from the start
  // How long a play lasts as watched, from the answer to the card (owner,
  // Nov 2026: "it should be 5 seconds long total"). Every play, short or deep,
  // a sack or a touchdown, is stretched to this; the timings below are the
  // play's own clock.
  const WATCH_MS = 5000;
  const TAU = Math.PI * 2;

  const lerp = (a, b, k) => a + (b - a) * k;
  const smooth = (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));
  const inField = (y) => Math.max(1.4, Math.min(FL - 1.4, y));

  // A track is a list of [t, x, y, ease]: where someone is at each moment.
  function track(keys) {
    return (t) => {
      if (t <= keys[0][0]) return [keys[0][1], keys[0][2]];
      for (let i = 1; i < keys.length; i++) {
        if (t <= keys[i][0]) {
          const a = keys[i - 1], b = keys[i];
          let k = (t - a[0]) / Math.max(1, b[0] - a[0]);
          k = b[3] === 'in' ? k * k : b[3] === 'out' ? 1 - (1 - k) * (1 - k) : b[3] === 'io' ? smooth(k) : k;
          return [lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
        }
      }
      const z = keys[keys.length - 1];
      return [z[1], z[2]];
    };
  }

  // ---- The play ----
  // Everything that happens, as places in time. Pure: the same play and seed
  // give the same picture, so a test can ask where the ball comes down.
  function build(play, o) {
    o = o || {};
    const L = 10 + play.from;                          // the line of scrimmage, in field yards
    const m = (o.seed | 0) % 2 ? 1 : -1;               // the strong side: +1 right, -1 left
    const vh = o.vh || 54;                             // how many yards tall the picture is
    const men = [];
    const add = (team, at, more) => { const e = Object.assign({ team, at }, more); men.push(e); return e; };
    const UP = -Math.PI / 2, DOWN = Math.PI / 2;       // facing upfield; facing the offence

    // Where the backs and receivers line up.
    const at0 = {
      rb: [BX - m * 2.6, L - 5.5], te: [BX + m * 7.9, L - 1.0],
      x: [BX - m * 13.2, L - 0.8], z: [BX + m * 13.8, L - 1.6], slot: [BX - m * 9.2, L - 1.6],
    };
    // How far downfield the play goes decides who it goes to. A sack still
    // sends everyone out on a route: nobody comes open.
    const toGoal = 100 - play.from;
    const deep = play.sack ? 14 : play.td ? toGoal : play.gain;
    const who = deep <= 7 ? 'slot' : deep <= 14 ? 'te' : deep <= 26 ? 'z' : deep <= 40 ? 'x' : 'z';
    const cx = who === 'slot' ? at0.slot[0] + m * 1.5 : who === 'te' ? at0.te[0] + m * 3
      : who === 'x' ? at0.x[0] + m * 8 : at0.z[0] - m * (deep > 40 ? 3.5 : 7);
    // Where it is caught, and where the play ends: a yard or so of running
    // after the catch, so the ball is dead exactly `gain` yards on. A
    // touchdown is caught in the end zone, or in stride and run in.
    let cat, down;
    if (play.td && toGoal <= 9) { cat = [cx, 113.6]; down = [cx + m * 0.6, 115.6]; }
    else if (play.td) { cat = [cx, 107.4]; down = [cx - m * 0.8, 115.8]; }
    else { cat = [cx, L + deep - 1.2]; down = [cx + m * 0.3, L + deep]; }

    // The clock of the play. A deep ball hangs longer, so it leaves later.
    const F = 400 + 11.5 * Math.hypot(cat[0] - BX, cat[1] - (L - 7.2));       // the ball's time in the air
    const R = Math.max(520 + 21 * (cat[1] - L), F + 320);                     // the route, snap to catch
    const T_THROW = T0 + R - F, T_CATCH = T0 + R;
    const T_DOWN = T_CATCH + (play.td ? 300 + 45 * Math.hypot(down[0] - cat[0], down[1] - cat[1]) : 240);
    const T_SACK = T0 + 1150;
    const T_CALL = play.sack ? T_SACK + 190 : T_DOWN + (play.td ? 80 : 150);
    const T_END = T_CALL + (play.td ? 1450 : 1050);          // the call is held about a second and a half as watched

    // The routes. The one thrown to breaks to the catch; the rest clear out.
    const stem = who === 'slot' ? [at0.slot[0], lerp(L, cat[1], 0.8)] : [lerp(at0[who][0], cat[0], 0.12), lerp(L, cat[1], 0.62)];
    const route = track([[T0, at0[who][0], at0[who][1]], [T0 + R * 0.58, stem[0], stem[1], 'in'], [T_CATCH, cat[0], cat[1]], [T_DOWN, down[0], down[1], 'out']]);
    const D = Math.max(R, 900);
    const ends = {
      x: [at0.x[0] + m, inField(L + Math.min(deep + 6, 24))], z: [at0.z[0] - m, inField(L + Math.min(deep + 4, 22))],
      slot: [BX + m * 4, inField(L + Math.min(deep * 0.6 + 5, 12))], te: [at0.te[0] + m * 3.5, inField(L + Math.min(8, deep + 2))],
      rb: play.sack ? [BX + m * 2.3, L - 4.4] : [BX - m * 8.5, L + 1.5],     // a sack: the back slides the wrong way
    };
    const run = {};
    for (const k of ['x', 'z', 'slot', 'te', 'rb']) {
      run[k] = k === who && !play.sack ? route
        : k === 'rb' ? track([[T0, at0.rb[0], at0.rb[1]], [T0 + 240, at0.rb[0], at0.rb[1] + 0.3], [T0 + (play.sack ? 560 : D), ends.rb[0], ends.rb[1], 'out']])
          : track([[T0, at0[k][0], at0[k][1]], [T0 + D, ends[k][0], ends[k][1], 'out']]);
    }

    // The quarterback: the snap, the drop, the throw. Or the sack.
    const sd = -m;                                       // the rush comes from the side the back left open
    let qb;
    if (play.sack) {
      qb = track([[T0 + 130, BX, L - 5.2], [T0 + 500, BX, L - 7.3, 'out'], [T0 + 820, BX - sd * 0.8, L - 6.9, 'io'],
        [T_SACK, BX - sd * 1.1, L - 6.6, 'io'], [T_SACK + 170, BX - sd * 2.0, L - 7.2, 'out']]);
    } else {
      const set = Math.min(T0 + 500, T_THROW - 150), back = 2.1 * Math.max(0, set - T0 - 130) / 370;
      const lean = Math.sign(cat[0] - BX) * 0.3;
      qb = track([[T0 + 130, BX, L - 5.2], [set, BX, L - 5.2 - back, 'out'], [T_THROW - 120, BX, L - 5.2 - back], [T_THROW + 80, BX + lean, L - 4.8 - back, 'out']]);
    }
    const aim = Math.atan2(-(cat[1] - (L - 7)), cat[0] - BX);     // the way the throw goes, as a screen angle

    // The line. Five blockers set a pocket and four rushers push it back.
    const squeeze = (t) => Math.min(0.9, Math.max(0, t - T0 - 380) / 2600);
    const olAt = [[-5.2, -1.0, -6.0, -3.7], [-2.6, -0.8, -2.8, -2.8], [0, -0.7, 0, -2.5], [2.6, -0.8, 2.8, -2.8], [5.2, -1.0, 6.0, -3.7]];
    const dlAt = [[-6.6, 0], [-1.6, 1], [1.6, 3], [6.6, 4]];         // where he lines up, and the blocker he meets
    const beaten = sd < 0 ? 0 : 4, free = sd < 0 ? 0 : 3, second = sd < 0 ? 1 : 2;
    olAt.forEach((q, i) => {
      const lost = play.sack && i === beaten;
      const keys = [[T0, BX + q[0], L + q[1]], [T0 + 380, BX + q[2], L + q[3], 'out']];
      if (lost) keys.push([T0 + 660, BX + q[2] + sd * 0.8, L + q[3] + 1.7, 'io']);        // he lunges and comes up empty
      const set = track(keys);
      add('o', (t) => {
        const p = set(t), j = t > T0 + 380 && !lost ? 1 : 0;
        return [p[0] + j * Math.sin(t / 95 + i * 1.7) * 0.11, p[1] + j * (Math.cos(t / 120 + i) * 0.09 - squeeze(t))];
      }, { big: true, face: UP, block: true });
    });
    dlAt.forEach((q, i) => {
      const b = olAt[q[1]];
      if (play.sack && i === free) {                     // the one who gets home
        const hit = qb(T_SACK), lie = qb(T_SACK + 170);
        add('d', track([[T0, BX + q[0], L + 0.9], [T0 + 430, BX + sd * 8.3, L - 2.4, 'out'], [T_SACK, hit[0] + sd * 0.55, hit[1] + 0.35, 'in'],
          [T_SACK + 170, lie[0] + sd * 0.6, lie[1] + 0.3, 'out']]), { big: true, downAt: T_SACK });
        return;
      }
      const meet = track([[T0, BX + q[0], L + 0.9], [T0 + 430, BX + b[2] * 0.96, L + b[3] + 1.3, 'out']]);
      const late = play.sack && i === second;            // and the one who piles on
      add('d', (t) => {
        const p = meet(t), j = t > T0 + 430 ? 1 : 0;
        const at = [p[0] + j * Math.sin(t / 88 + i * 2.1) * 0.12, p[1] + j * (Math.cos(t / 105 + i) * 0.09 - squeeze(t))];
        if (!late) return at;
        const k = smooth((t - (T_SACK - 240)) / 460), lie = qb(T_SACK + 170);
        return [lerp(at[0], lie[0] - sd * 0.9, k), lerp(at[1], lie[1] + 1.1, k)];
      }, { big: true, face: DOWN, block: true });
    });

    add('o', (t) => qb(t), {
      downAt: play.sack ? T_SACK : 0,
      face: (t) => (!play.sack && t > T_THROW - 220 ? aim : UP),
      arms: (t) => (play.sack ? 0 : t > T_THROW - 110 && t < T_THROW + 200 ? Math.sin(Math.PI * (t - T_THROW + 110) / 310) : 0),
    });
    let star = null;
    for (const k of ['rb', 'te', 'x', 'z', 'slot']) {
      const mine = k === who && !play.sack;
      const e = add('o', run[k], mine ? {
        star: true, downAt: play.td ? 0 : T_DOWN,
        // He reaches for the ball as it comes in, and throws his arms up in the end zone.
        arms: (t) => (t > T_CATCH - 170 && t <= T_CATCH ? (t - T_CATCH + 170) / 170 : t > T_CATCH && t < T_CATCH + 90 ? 1 - (t - T_CATCH) / 90
          : play.td && t > T_DOWN ? 0.85 + 0.15 * Math.sin((t - T_DOWN) / 90) : 0),
        spread: (t) => (play.td && t > T_DOWN ? 1 : 0),
        face: (t) => (play.td && t > T_DOWN + 60 ? UP : null),
      } : {});
      if (mine) star = e;
    }

    // The coverage: a man on each receiver, two safeties over the top.
    const cover = (recv, from, off, lag) => (t) => {
      if (t <= T0) return from;
      const k = smooth((t - T0) / 620), r = recv(t - lag);
      return [lerp(from[0], r[0] + off[0], k), inField(lerp(from[1], r[1] + off[1], k))];
    };
    const marks = {
      x: [at0.x[0] + m * 0.6, inField(L + 5.5)], z: [at0.z[0] - m * 0.6, inField(L + 6.5)], slot: [at0.slot[0], inField(L + 4.5)],
      te: [BX + m * 3.6, inField(L + 4.8)], rb: [BX - m * 3.4, inField(L + 4.6)],
    };
    for (const k of ['x', 'z', 'slot', 'te', 'rb']) {
      const from = marks[k];
      if (k === who && !play.sack) {
        // A short throw is caught in front of him; a long one has him beaten.
        const under = deep <= 14;
        const off = play.td ? [-m * 0.6, -2.7] : under ? [0.5, 1.7] : [-m * 0.5, -1.9];
        const trail = cover(route, from, off, 90);
        const hit = [down[0] + 0.6, down[1] + (under ? 0.5 : -0.5)];
        add('d', play.td ? trail : (t) => {
          if (t <= T_CATCH) return trail(t);
          const a = trail(T_CATCH), q = smooth((t - T_CATCH) / (T_DOWN - T_CATCH));
          return [lerp(a[0], hit[0], q), lerp(a[1], hit[1], q)];
        }, { downAt: play.td ? 0 : T_DOWN });
      } else if (k === 'rb' && play.sack) {
        add('d', track([[T0, from[0], from[1]], [T0 + 600, from[0], inField(from[1] + 1.5), 'out']]), {});
      } else {
        add('d', cover(run[k], from, k === 'rb' ? [0.3, 1.6] : [(k === 'x' ? 1 : -1) * m * 0.4, play.sack ? 0.9 : 1.2], 110), {});
      }
    }
    const tBack = play.sack ? T0 + 520 : Math.min(T0 + 520, T_THROW);
    [[BX - m * 6, 13, [-m * 2.4, 2.2], [-m * 2.6, -3.6]], [BX + m * 7, 10.5, [m * 2.6, -1.7], [m * 2.4, -5]]].forEach((q) => {
      const from = [q[0], inField(L + q[1])];
      const keys = [[T0, from[0], from[1]], [tBack, from[0], inField(from[1] + 2.2), 'out']];
      if (!play.sack) { const r = play.td ? q[3] : q[2]; keys.push([T_DOWN + 220, down[0] + r[0], inField(down[1] + r[1]), 'io']); }
      add('d', track(keys), {});
    });

    // The ball: on the ground, snapped, held, in the air, carried.
    const hold = (p, side) => [p[0] + 0.42 * side, p[1] + 0.12];
    const rel = hold(qb(T_THROW), Math.sign(cat[0] - BX) || 1);
    const loft = 1 + Math.hypot(cat[0] - rel[0], cat[1] - rel[1]) * 0.15;      // how high it goes, in yards
    const ball = (t) => {
      if (t < T0) return { x: BX, y: L - 0.25, h: 0 };
      if (t < T0 + 130) { const k = (t - T0) / 130, q = qb(T0 + 130); return { x: lerp(BX, q[0], k), y: lerp(L - 0.25, q[1], k), h: 0.3 * Math.sin(Math.PI * k) }; }
      if (play.sack || t < T_THROW) { const q = hold(qb(t), 1); return { x: q[0], y: q[1], h: 0, held: true }; }
      if (t < T_CATCH) { const k = (t - T_THROW) / (T_CATCH - T_THROW); return { x: lerp(rel[0], cat[0], k), y: lerp(rel[1], cat[1], k), h: Math.sin(Math.PI * k) * loft, k, air: true }; }
      const p = route(Math.min(t, T_DOWN));
      return { x: p[0] + 0.35, y: p[1] + 0.1, h: 0, held: true };
    };

    // The camera: the line of scrimmage low in the picture, then up the field
    // with the ball. A sack keeps it on the pocket.
    const lo = vh / 2 - PAD, hi = FL + PAD - vh / 2, keep = (y) => Math.max(lo, Math.min(hi, y));
    const c0 = keep(L + vh * 0.18);
    const c1 = play.sack ? keep(L - 7 + vh * 0.12) : Math.max(c0, keep(down[1] - vh * 0.08));
    const cam = (t) => (play.sack ? lerp(c0, c1, smooth((t - T0 - 250) / 800))
      : lerp(c0, c1, smooth((t - T_THROW + 120) / (T_DOWN - T_THROW + 120))));

    return {
      play, L, m, who, men, star, ball, cam, qb, cat, down, rel, aim, loft,
      T_THROW, T_CATCH, T_DOWN, T_SACK, T_CALL, T_END,
      spot: play.sack ? L : play.td ? 110 : L + play.gain,       // where the ball is dead, in field yards
    };
  }

  // ---- The ground ----
  function rr(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  // The whole field, painted once: the grass mown in bands, the lines, the
  // hash marks, the numbers, both end zones, the mark at midfield, the posts.
  function paintField(W, s, dpr, font) {
    const c = document.createElement('canvas');
    const Hc = (FL + PAD * 2) * s;
    c.width = Math.round(W * dpr); c.height = Math.round(Hc * dpr);
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    const X = (x) => (x - BX) * s + W / 2, Y = (y) => (FL + PAD - y) * s;
    const rect = (x, y, w, h) => g.fillRect(X(x), Y(y + h), w * s, h * s);     // by its lower-left corner, in yards

    g.fillStyle = '#0d3b1e'; g.fillRect(0, 0, W, Hc);                           // beyond the lines
    for (let y = 10, i = 0; y < 110; y += 5, i++) { g.fillStyle = i % 2 ? '#2d8b47' : '#267b3d'; rect(0, y, FW, 5); }
    g.fillStyle = 'rgba(255,255,255,.03)';
    for (let y = 10; y < 110; y += 2) rect(0, y, FW, 1);                        // the mower's finer lines

    // The end zones: the Huddle's own, and the black and gold one to score in.
    g.fillStyle = '#14532d'; rect(0, 0, FW, 10);
    const ez = g.createLinearGradient(0, Y(120), 0, Y(110));
    ez.addColorStop(0, '#050507'); ez.addColorStop(1, '#1d1d2b');
    g.fillStyle = ez; rect(0, 110, FW, 10);
    g.save();
    g.beginPath(); g.rect(X(0), Y(120), FW * s, 10 * s); g.clip();
    g.fillStyle = 'rgba(234,179,8,.16)';
    for (let x = -10; x < FW; x += 3.2) {
      g.beginPath(); g.moveTo(X(x), Y(110)); g.lineTo(X(x + 1.1), Y(110)); g.lineTo(X(x + 11.1), Y(120)); g.lineTo(X(x + 10), Y(120)); g.closePath(); g.fill();
    }
    g.restore();
    const word = (text, yc, color) => {
      const wide = Math.min(FW - 6, W / s - 4) * s;                             // what shows of the end zone
      g.save();
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `900 100px ${font}`;
      try { g.letterSpacing = '8px'; } catch (_) { /* older browsers: no spacing */ }
      const px = Math.min(6.2 * s, 100 * wide / (g.measureText(text).width || 1));
      g.font = `900 ${px.toFixed(1)}px ${font}`;
      try { g.letterSpacing = `${(px * 0.08).toFixed(1)}px`; } catch (_) { /* as above */ }
      g.fillStyle = color;
      g.fillText(text, X(BX), Y(yc) + px * 0.04);
      g.restore();
    };
    word('ONE OF ONE', 115, '#fde68a');
    word('THE CARD HUDDLE', 5, 'rgba(255,255,255,.92)');

    // The lines.
    g.fillStyle = '#fff';
    const b = 0.6;
    rect(-b, -b, FW + 2 * b, b); rect(-b, FL, FW + 2 * b, b); rect(-b, 0, b, FL); rect(FW, 0, b, FL);
    rect(0, 10 - 0.2, FW, 0.4); rect(0, 110 - 0.2, FW, 0.4);
    g.globalAlpha = 0.9;
    for (let y = 15; y <= 105; y += 5) g.fillRect(X(0), Y(y) - 0.75, FW * s, 1.5);
    g.globalAlpha = 0.85;
    for (let y = 11; y < 110; y++) {
      if (y % 5 === 0) continue;
      for (const x of [0.35, BX - HASH - 0.33, BX + HASH - 0.33, FW - 1.02]) g.fillRect(X(x), Y(y) - 0.5, 0.67 * s, 1);
    }
    for (let y = 15; y <= 105; y += 5) for (const x of [BX - HASH, BX + HASH]) g.fillRect(X(x) - 0.5, Y(y + 0.33), 1, 0.66 * s);

    // The numbers, read from the nearer sideline, with an arrow to the nearer goal.
    g.globalAlpha = 0.9;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const fs = 2.2 * s;
    g.font = `800 ${fs.toFixed(1)}px ${font}`;
    const digit = (ch, x, y, turn) => { g.save(); g.translate(X(x), Y(y)); g.rotate(turn); g.fillText(ch, 0, fs * 0.04); g.restore(); };
    for (let y = 20; y <= 100; y += 10) {
      const n = y <= 60 ? y - 10 : 110 - y;
      for (const side of [-1, 1]) {
        const x = side < 0 ? 12 : FW - 12, turn = side < 0 ? Math.PI / 2 : -Math.PI / 2;
        digit(String(n / 10), x, y - side * 1.02, turn);
        digit('0', x, y + side * 1.02, turn);
        if (n !== 50) {
          const dir = y < 60 ? -1 : 1, ay = y + dir * 2.55;
          g.beginPath();
          g.moveTo(X(x), Y(ay + dir * 0.55)); g.lineTo(X(x - 0.34), Y(ay - dir * 0.1)); g.lineTo(X(x + 0.34), Y(ay - dir * 0.1));
          g.closePath(); g.fill();
        }
      }
    }
    g.globalAlpha = 1;

    // Midfield: the 1/1 mark.
    g.save();
    g.globalAlpha = 0.92;
    g.fillStyle = '#0b0b0f'; g.strokeStyle = '#eab308'; g.lineWidth = Math.max(2, s * 0.3);
    g.beginPath(); g.arc(X(BX), Y(60), 4.5 * s, 0, TAU); g.fill(); g.stroke();
    g.fillStyle = '#fde68a'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `900 ${(3.7 * s).toFixed(1)}px ${font}`;
    g.fillText('1/1', X(BX), Y(60) + s * 0.15);
    g.restore();

    // The posts beyond each end line, the pylons at the corners.
    for (const y of [-0.95, FL + 0.95]) {
      g.strokeStyle = '#facc15'; g.fillStyle = '#facc15'; g.lineCap = 'round'; g.lineWidth = Math.max(2, s * 0.3);
      g.beginPath(); g.moveTo(X(BX - HASH), Y(y)); g.lineTo(X(BX + HASH), Y(y)); g.stroke();
      g.beginPath(); g.moveTo(X(BX), Y(y)); g.lineTo(X(BX), Y(y + (y < 0 ? -1.2 : 1.2))); g.stroke();
      for (const x of [BX - HASH, BX + HASH]) { g.beginPath(); g.arc(X(x), Y(y), Math.max(2.4, s * 0.34), 0, TAU); g.fill(); }
    }
    g.fillStyle = '#fb923c';
    for (const y of [0, 10, 110, 120]) for (const x of [0, FW]) g.fillRect(X(x) - s * 0.28, Y(y) - s * 0.28, s * 0.56, s * 0.56);

    // The benches, where the picture is wide enough to show the sideline.
    if (W / s > FW + 5) {
      for (const side of [-1, 1]) {
        const x = side < 0 ? -3.4 : FW + 2.0;
        g.fillStyle = 'rgba(226,232,240,.55)'; rr(g, X(x), Y(80), 1.4 * s, 40 * s, 3); g.fill();
        g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 1; g.setLineDash([4, 4]);
        g.strokeRect(X(side < 0 ? -3.9 : FW + 1.3), Y(85), 2.6 * s, 50 * s); g.setLineDash([]);
      }
    }
    return c;
  }

  // ---- The players ----
  // White, black and gold (the 1/1's colours) against navy and silver: told
  // apart by how light they are, not by red against green.
  const KIT = {
    o: { jersey: '#ffffff', edge: '#0f172a', trim: '#eab308', helmet: '#15151c', stripe: '#facc15', mask: '#cbd5e1', pants: '#e2e8f0', sleeve: '#f1f5f9', shoe: '#111827', skin: '#d9a777' },
    d: { jersey: '#1d3fa3', edge: '#0b1220', trim: '#93c5fd', helmet: '#d5dde8', stripe: '#1d3fa3', mask: '#0f172a', pants: '#94a3b8', sleeve: '#1e40af', shoe: '#0b1220', skin: '#b98a5e' },
  };
  function shadow(g, x, y, r, down) {
    g.fillStyle = 'rgba(0,0,0,.26)';
    g.beginPath(); g.ellipse(x + r * 0.16, y + r * 0.3, r * (1.02 + 0.3 * down), r * (0.7 + 0.3 * down), 0, 0, TAU); g.fill();
  }
  // From above: shoulder pads, a helmet with its stripe and facemask, arms
  // when he blocks, throws or catches, feet when he runs, legs when he is down.
  function man(g, x, y, ang, r, kit, st) {
    g.save();
    g.translate(x, y);
    g.rotate(ang + Math.PI / 2);                       // from here "up" is the way he faces
    g.lineJoin = 'round';
    if (st.down > 0) {
      g.fillStyle = kit.pants;
      rr(g, -r * 0.42, r * 0.1, r * 0.84, r * 1.7 * st.down, r * 0.3); g.fill();
      g.fillStyle = kit.shoe;
      for (const i of [-1, 1]) g.fillRect(i * r * 0.22 - r * 0.17, r * (0.1 + 1.7 * st.down) - r * 0.2, r * 0.34, r * 0.28);
    } else if (st.stride) {
      g.fillStyle = kit.shoe;
      for (const i of [-1, 1]) { g.beginPath(); g.ellipse(i * r * 0.34, i * st.stride * r * 0.62, r * 0.2, r * 0.34, 0, 0, TAU); g.fill(); }
    }
    if (st.arms > 0) {
      g.strokeStyle = kit.sleeve; g.lineWidth = r * 0.34; g.lineCap = 'round';
      for (const i of [-1, 1]) {
        const ex = i * r * (0.7 + st.spread * 0.55), ey = -r * (0.05 + 0.95 * st.arms);
        g.beginPath(); g.moveTo(i * r * 0.7, 0); g.lineTo(ex, ey); g.stroke();
        g.fillStyle = kit.skin; g.beginPath(); g.arc(ex, ey, r * 0.19, 0, TAU); g.fill();
      }
    }
    // the pads
    g.fillStyle = kit.jersey; g.strokeStyle = kit.edge; g.lineWidth = Math.max(1, r * 0.1);
    rr(g, -r, -r * 0.52, r * 2, r * 1.04, r * 0.5); g.fill(); g.stroke();
    // the helmet, its stripe, and the facemask at the front
    g.fillStyle = kit.helmet;
    g.beginPath(); g.arc(0, -r * 0.1, r * 0.47, 0, TAU); g.fill(); g.stroke();
    g.strokeStyle = kit.stripe; g.lineWidth = Math.max(1.5, r * 0.17); g.lineCap = 'butt';
    g.beginPath(); g.moveTo(0, -r * 0.5); g.lineTo(0, r * 0.3); g.stroke();
    g.strokeStyle = kit.mask; g.lineWidth = Math.max(1.2, r * 0.13); g.lineCap = 'round';
    g.beginPath(); g.arc(0, -r * 0.1, r * 0.56, -Math.PI * 0.74, -Math.PI * 0.26); g.stroke();
    g.restore();
  }
  function football(g, x, y, ang, a, laces) {
    const b = a * 0.6;
    g.save();
    g.translate(x, y); g.rotate(ang);
    g.fillStyle = '#93501f'; g.strokeStyle = '#3b1d08'; g.lineWidth = Math.max(1, a * 0.16);
    g.beginPath(); g.moveTo(-a, 0); g.quadraticCurveTo(0, -b * 2, a, 0); g.quadraticCurveTo(0, b * 2, -a, 0); g.closePath(); g.fill(); g.stroke();
    g.strokeStyle = '#fff'; g.lineWidth = Math.max(1, a * 0.14); g.lineCap = 'round';
    g.beginPath(); g.moveTo(-a * 0.4, laces * b * 0.5); g.lineTo(a * 0.4, laces * b * 0.5); g.stroke();
    g.restore();
  }
  // A cheap, repeatable scatter for the confetti.
  function scatter(seed, n) {
    let a = (seed | 0) + 0x9e3779b9;
    const rnd = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const out = [];
    for (let i = 0; i < n; i++) out.push({ a: rnd() * TAU, v: 4 + rnd() * 13, w: 0.35 + rnd() * 0.5, spin: (rnd() - 0.5) * 14, c: ['#facc15', '#fde68a', '#ffffff', '#eab308', '#15151c'][i % 5], late: i % 3 === 0 ? 380 : 0 });
    return out;
  }

  // ---- One frame ----
  function draw(g, M, t, V) {
    const W = V.W, H = V.H, s = V.s, play = M.play;
    // The jolt of a sack.
    let jx = 0, jy = 0;
    if (play.sack && t > M.T_SACK && t < M.T_SACK + 340) { const k = 1 - (t - M.T_SACK) / 340; jx = Math.sin(t / 17) * 5 * k; jy = Math.cos(t / 13) * 4 * k; }
    const camY = M.cam(t);
    const SX = (x) => (x - BX) * s + W / 2 + jx, SY = (y) => H / 2 - (y - camY) * s + jy;

    // The ground: the painted field, cut to what the camera sees.
    g.fillStyle = '#0d3b1e'; g.fillRect(0, 0, W, H);
    const sh = Math.round(H * V.dpr);
    const sy = Math.max(0, Math.min(V.field.height - sh, Math.round(((FL + PAD - (camY + H / s / 2)) * s - jy) * V.dpr)));
    g.drawImage(V.field, 0, sy, V.field.width, sh, jx, 0, W, H);

    // A touchdown lights the end zone.
    if (play.td && t > M.T_DOWN) {
      const k = (t - M.T_DOWN) / 1500, glow = Math.max(0, 1 - k) * (0.5 + 0.5 * Math.sin((t - M.T_DOWN) / 70));
      g.fillStyle = `rgba(250,204,21,${(0.3 * glow).toFixed(3)})`;
      g.fillRect(SX(0), SY(120), FW * s, 10 * s);
    }

    // The line of scrimmage, the way a broadcast paints it. After a catch it
    // moves up to where the ball is dead.
    const moved = !play.sack && !play.td && t > M.T_DOWN ? smooth((t - M.T_DOWN) / 480) : 0;
    const fade = play.td && t > M.T_DOWN ? Math.max(0, 1 - (t - M.T_DOWN) / 400) : 1;
    if (fade > 0) {
      g.save();
      g.globalAlpha = 0.82 * fade; g.shadowColor = 'rgba(59,130,246,.9)'; g.shadowBlur = 8; g.fillStyle = '#3b82f6';
      g.fillRect(SX(0), SY(lerp(M.L, M.spot, moved)) - 1.5, FW * s, 3);
      g.restore();
    }

    // Everyone, where they are now and which way they face.
    const ballNow = M.ball(t);
    const now = M.men.map((e) => {
      const p = e.at(t), q = e.at(t - 50);
      const vx = p[0] - q[0], vy = p[1] - q[1], fast = vx * vx + vy * vy;
      const fixed = typeof e.face === 'function' ? e.face(t) : e.face;
      const ang = fixed != null ? fixed : fast > 0.0012 ? Math.atan2(-vy, vx)
        : e.team === 'o' ? -Math.PI / 2 : Math.atan2(-(ballNow.y - p[1]), ballNow.x - p[0]);
      const down = e.downAt && t >= e.downAt ? Math.min(1, (t - e.downAt) / 170) : 0;
      const arms = e.arms ? e.arms(t) : e.block && t > T0 + 250 ? 0.55 : 0;
      return {
        e, x: SX(p[0]), y: SY(p[1]), ang, r: s * 1.22 * (e.big ? 1.12 : 1),
        st: { down, arms: down ? 0 : arms, spread: e.spread ? e.spread(t) : 0, stride: !down && fast > 0.0012 && !e.block ? Math.sin((p[0] + p[1]) * 2.4) : 0 },
      };
    });
    for (const n of now) shadow(g, n.x, n.y, n.r, n.st.down);
    // The one the ball is going to wears a gold ring on the turf.
    const starNow = M.star ? now.find((n) => n.e === M.star) : null;
    if (starNow && t > T0 && !(starNow.st.down > 0)) {
      g.save();
      g.strokeStyle = 'rgba(250,204,21,.95)'; g.lineWidth = 2;
      g.globalAlpha = 0.65 + 0.35 * Math.sin(t / 110);
      g.beginPath(); g.ellipse(starNow.x, starNow.y, starNow.r * 1.55, starNow.r * 1.3, 0, 0, TAU); g.stroke();
      g.restore();
    }
    for (const n of now) if (n !== starNow) man(g, n.x, n.y, n.ang, n.r, KIT[n.e.team], n.st);
    if (starNow) man(g, starNow.x, starNow.y, starNow.ang, starNow.r, KIT.o, starNow.st);

    // The catch, the tackle, the hit.
    if (!play.sack && t > M.T_CATCH && t < M.T_CATCH + 340) {
      const k = (t - M.T_CATCH) / 340;
      g.save(); g.globalAlpha = 1 - k; g.strokeStyle = '#fff'; g.lineWidth = 2.5;
      g.beginPath(); g.arc(SX(M.cat[0]), SY(M.cat[1]), s * (1.2 + 3.2 * k), 0, TAU); g.stroke(); g.restore();
    }
    if (!play.sack && !play.td && t > M.T_DOWN && t < M.T_DOWN + 460) {
      const k = (t - M.T_DOWN) / 460;
      g.save(); g.globalAlpha = 0.55 * (1 - k); g.fillStyle = '#e7f7ea';
      for (let i = 0; i < 8; i++) { const a = i * 0.785 + 0.3; g.beginPath(); g.arc(SX(M.down[0]) + Math.cos(a) * s * (0.8 + 2.4 * k), SY(M.down[1]) + Math.sin(a) * s * (0.6 + 1.8 * k), s * (0.5 - 0.25 * k), 0, TAU); g.fill(); }
      g.restore();
    }
    if (play.sack && t > M.T_SACK && t < M.T_SACK + 380) {
      const k = (t - M.T_SACK) / 380, q = M.qb(M.T_SACK);
      g.save(); g.globalAlpha = 1 - k; g.strokeStyle = '#fef08a'; g.lineWidth = 3; g.lineCap = 'round';
      for (let i = 0; i < 10; i++) {
        const a = i * 0.628 + 0.2, r0 = s * (1.5 + 2.2 * k), r1 = s * (2.4 + 3.4 * k);
        g.beginPath(); g.moveTo(SX(q[0]) + Math.cos(a) * r0, SY(q[1]) + Math.sin(a) * r0); g.lineTo(SX(q[0]) + Math.cos(a) * r1, SY(q[1]) + Math.sin(a) * r1); g.stroke();
      }
      g.restore();
    }

    // The ball, its shadow on the grass, and the streak behind it in the air.
    const bx = SX(ballNow.x), by = SY(ballNow.y), lift = ballNow.h * s * 0.5;
    const size = Math.max(6, s * 0.72);
    if (ballNow.air) {
      g.fillStyle = 'rgba(0,0,0,.28)';
      g.beginPath(); g.ellipse(bx + 2, by + 2, size * (1 - 0.25 * Math.sin(Math.PI * ballNow.k)), size * 0.5, 0, 0, TAU); g.fill();
      const k0 = Math.max(0, ballNow.k - 0.1);
      const tx = SX(lerp(M.rel[0], M.cat[0], k0)), ty = SY(lerp(M.rel[1], M.cat[1], k0)) - Math.sin(Math.PI * k0) * M.loft * s * 0.5;
      const trail = g.createLinearGradient(tx, ty, bx, by - lift);
      trail.addColorStop(0, 'rgba(255,255,255,0)'); trail.addColorStop(1, 'rgba(255,255,255,.5)');
      g.strokeStyle = trail; g.lineWidth = size * 0.7; g.lineCap = 'round';
      g.beginPath(); g.moveTo(tx, ty); g.lineTo(bx, by - lift); g.stroke();
      football(g, bx, by - lift, M.aim, size * (1 + 0.75 * Math.sin(Math.PI * ballNow.k)), Math.sin(t / 38));
    } else {
      football(g, bx, by - lift, ballNow.held ? -Math.PI / 2 : 0, size * (ballNow.held ? 0.9 : 1), 0);
    }

    // Gold on the field for a touchdown.
    if (play.td && t > M.T_DOWN) {
      if (!M.bits) M.bits = scatter(play.from * 31 + play.gain, 80);
      for (const c of M.bits) {
        const k = (t - M.T_DOWN - c.late) / 1500;
        if (k <= 0 || k >= 1) continue;
        const d = c.v * (1 - (1 - k) * (1 - k)) * s, w = c.w * s;
        g.save();
        g.globalAlpha = Math.min(1, (1 - k) * 2.2);
        g.translate(SX(M.down[0]) + Math.cos(c.a) * d, SY(M.down[1]) + Math.sin(c.a) * d * 0.8 + k * k * s * 3);
        g.rotate(c.spin * k);
        g.fillStyle = c.c; g.fillRect(-w / 2, -w * 0.3, w, w * 0.6);
        g.restore();
      }
    }

    // His name over the man who was named.
    if (starNow && V.tag && t > T0 - 200) {
      g.save();
      g.globalAlpha = Math.min(1, (t - T0 + 200) / 200);
      g.font = `800 ${Math.round(Math.max(10, s * 1.2))}px ${V.font}`;
      const w = g.measureText(V.tag).width + 14, h = Math.max(17, s * 1.95);
      const left = Math.max(5, Math.min(W - w - 5, starNow.x - w / 2));
      let topY = starNow.y - starNow.r * 2.05 - h;
      if (topY < 46) topY = starNow.y + starNow.r * 1.75;       // no room above him (the score bug is there): under him
      g.fillStyle = 'rgba(8,12,22,.88)'; rr(g, left, topY, w, h, h / 2); g.fill();
      g.strokeStyle = 'rgba(250,204,21,.9)'; g.lineWidth = 1; g.stroke();
      g.fillStyle = '#fde68a'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(V.tag, left + w / 2, topY + h / 2 + 0.5);
      g.restore();
    }

    // The edges fall away, as under lights.
    g.fillStyle = V.vig; g.fillRect(0, 0, W, H);
    g.fillStyle = V.shade; g.fillRect(0, 0, W, 64);
  }

  // ---- The scene ----
  const lastName = (name) => {
    const w = String(name || '').trim().split(/\s+/).filter((x) => x && !/^(jr\.?|sr\.?|ii|iii|iv|v)$/i.test(x));
    return (w[w.length - 1] || '').toUpperCase().slice(0, 14);
  };
  let painted = null;      // the field, painted once for a size: { key, canvas }
  // Fills `host` with the field and runs the play on it. `o`: height, seed,
  // name (who was named), bug ("Play 3 of 7"), before / after (where the ball
  // is), onCall(words), onEnd(). `o.at` draws one moment and stops there.
  // Returns { stop() }, or null when there is nothing to draw on.
  function run(host, play, o) {
    o = o || {};
    const W = Math.round(host.clientWidth), H = Math.round(o.height || W * 1.4);
    if (!(W > 60) || !(H > 60)) return null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cv = document.createElement('canvas');
    const g = cv.getContext && cv.getContext('2d');
    if (!g) return null;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.height = `${H}px`;
    cv.setAttribute('aria-hidden', 'true');
    g.scale(dpr, dpr);

    const s = Math.max(MIN_S, W / (FW + APRON * 2));
    let font = '';
    try { font = getComputedStyle(document.body).fontFamily; } catch (_) { /* the fallback below */ }
    font = font || 'system-ui, sans-serif';
    const key = [W, s.toFixed(3), dpr].join('|');
    if (!painted || painted.key !== key) painted = { key, canvas: paintField(W, s, dpr, font) };
    const vig = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.42, W / 2, H / 2, Math.hypot(W, H) * 0.56);
    vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.4)');
    const shade = g.createLinearGradient(0, 0, 0, 64);
    shade.addColorStop(0, 'rgba(0,0,0,.34)'); shade.addColorStop(1, 'rgba(0,0,0,0)');
    const M = build(play, { seed: o.seed, vh: H / s });
    const rate = M.T_END / WATCH_MS;                    // play-clock ms per watched ms
    const V = { W, H, s, dpr, field: painted.canvas, font, tag: play.sack ? '' : lastName(o.name), vig, shade };

    // Over the field: the score bug, the call, and the way past it.
    const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    const bug = el('div', 'oo-bug');
    bug.appendChild(el('b', '', '1/1'));
    if (o.bug) bug.appendChild(el('span', '', o.bug));
    const spot = el('span', 'oo-bug-spot', o.before || '');
    bug.appendChild(spot);
    const call = el('div', 'oo-scene-call'), big = el('b'), sub = el('span');
    call.appendChild(big); call.appendChild(sub);
    // The call stands clear of the play: over it where the field is open, under
    // it for a sack, a touchdown, or a catch close to the end zone's lettering.
    const camEnd = M.cam(M.T_END), sy = (y) => H / 2 - (y - camEnd) * s;
    const focus = sy(play.sack ? M.qb(M.T_SACK + 170)[1] : M.down[1]);
    const tall = Math.min(128, Math.max(96, W * 0.3));
    let top = focus - 56 - tall;
    if (play.sack || top < 52 || sy(110) > top - 8) top = focus + 46;
    call.style.top = `${Math.round(Math.max(52, Math.min(H - tall - 36, top)))}px`;
    host.textContent = '';
    host.appendChild(cv); host.appendChild(bug); host.appendChild(call);
    if (o.at == null) host.appendChild(el('span', 'oo-scene-skip', 'Tap to skip'));

    const said = play.sack ? { big: 'SACKED', sub: 'No gain', cls: 'bad', say: 'Sacked for no gain.' }
      : play.td ? { big: 'TOUCHDOWN', sub: `${play.gain}-yard pass`, cls: 'td', say: `Touchdown, a ${play.gain}-yard pass.` }
        : { big: `+${play.gain} ${play.gain === 1 ? 'YARD' : 'YARDS'}`, sub: o.after || '', cls: play.tier || '', say: `A ${play.gain}-yard pass. ${o.after || ''}`.trim() };
    let called = false, over = false, raf = 0, guard = 0;
    const showCall = () => {
      if (called) return;
      called = true;
      big.textContent = said.big; sub.textContent = said.sub;
      call.className = `oo-scene-call on ${said.cls}`;
      if (!play.sack && o.after) spot.textContent = o.after;
      host.classList.add(play.td ? 'td' : play.sack ? 'sack' : 'gain');
      if (o.onCall) o.onCall(said.say);
    };
    const end = () => { if (over) return; over = true; cancelAnimationFrame(raf); clearTimeout(guard); if (o.onEnd) o.onEnd(); };

    if (o.at != null) {                                  // one moment, held
      draw(g, M, o.at, V);
      if (o.at >= M.T_CALL) showCall();
      return { stop() {}, model: M };
    }
    draw(g, M, 0, V);                                    // the field is there at once, never a blank box
    const t0 = performance.now();
    const frame = (now) => {
      if (over) return;
      if (!cv.isConnected) { over = true; clearTimeout(guard); return; }
      const t = Math.max(0, now - t0) * rate;             // the play's own clock
      draw(g, M, Math.min(t, M.T_END), V);
      if (t >= M.T_CALL) showCall();
      if (t >= M.T_END) { end(); return; }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    // A tab in the background gets no frames: the play still ends.
    guard = setTimeout(() => { showCall(); end(); }, WATCH_MS + 1500);
    return { stop() { over = true; cancelAnimationFrame(raf); clearTimeout(guard); }, model: M };
  }

  const api = { run, build, FW, FL, WATCH_MS };
  if (typeof window !== 'undefined') window.ooField = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
