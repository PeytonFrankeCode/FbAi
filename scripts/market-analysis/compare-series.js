#!/usr/bin/env node
// Which cards should the whole-market index follow? Runs the site's own index
// and accuracy scorer against a local copy of the sales table, once per
// basket (server.js MARKET_SERIES), and prints what each one gets:
//
//   base       raw base cards only (the live index)
//   graded     + graded copies, each grade its own card
//   graded,parallels   + parallels too, each parallel its own card
//
// Read-only: the copy is opened read-only, and nothing here writes anywhere.
// Each basket runs in its own process because MARKET_SERIES is read when
// server.js loads.
//
//   python3 scripts/d1-export.py --out /tmp/sales.sqlite     # the copy
//   node scripts/market-analysis/compare-series.js /tmp/sales.sqlite
//   VARIANTS='graded;' node ...   (a chosen few, ';'-separated; '' is base)
'use strict';
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const VARIANTS = (process.env.VARIANTS ? process.env.VARIANTS.split(';') : ['', 'graded', 'graded,parallels']);
const DAYS = [30, 90];

async function child(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const d1 = {
    prepare(sql) {
      let bound = [];
      const api = {
        bind(...a) { bound = a; return api; },
        all() { return { results: db.prepare(sql).all(...bound) }; },
        first() { return db.prepare(sql).get(...bound) || null; },
        run() { throw new Error('read-only experiment: refused a write'); },
      };
      return api;
    },
    batch() { throw new Error('read-only experiment: refused a write'); },
  };
  require(path.join(ROOT, 'db.js')).getNflDb = () => d1;
  process.env.CF_WORKER = '1';
  const { app } = require(path.join(ROOT, 'server.js'));
  const server = app.listen(0);
  const port = server.address().port;
  const get = async (url) => {
    const t0 = Date.now();
    const body = await (await fetch(`http://127.0.0.1:${port}${url}`)).json();
    return { ms: Date.now() - t0, body };
  };
  const out = { variant: process.env.MARKET_SERIES || 'base', periods: {} };
  for (const days of DAYS) {
    const idx = await get(`/api/market-index?days=${days}`);
    const acc = await get(`/api/debug/market-accuracy?days=${days}`);
    const b = idx.body, a = acc.body;
    out.periods[days] = {
      indexMs: idx.ms,
      available: !!b.available,
      reason: b.available ? undefined : b.reason,
      changePct: b.changePct,
      matchedCards: b.matchedCards,
      weakestStep: b.minMatchedInAnyStep,
      observations: b.totalObservations,
      // How jumpy the line is: the typical day-to-day move of the series.
      stepMovePct: (() => {
        const s = (b.series || []).map(p => Number(p.score)).filter(x => x > 0);
        if (s.length < 3) return null;
        const moves = s.slice(1).map((x, i) => Math.abs(Math.log(x / s[i]))).sort((x, y) => x - y);
        return Math.round((Math.exp(moves[moves.length >> 1]) - 1) * 1000) / 10;
      })(),
      points: (b.series || []).length,
      accuracy: a.available ? { pairs: a.pairs, lastComp: a.lastComp, withMarket: a.withMarket, byGap: a.byGap } : { reason: a.reason, error: a.error },
    };
  }
  server.close();
  process.stdout.write('@@RESULT ' + JSON.stringify(out) + '\n');
  process.exit(0);
}

async function main(dbPath) {
  const results = [];
  for (const v of VARIANTS) {
    const r = await new Promise((resolve) => {
      const p = spawn(process.execPath, [__filename, '--child', dbPath], {
        cwd: ROOT, env: { ...process.env, MARKET_SERIES: v }, stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '', err = '';
      p.stdout.on('data', d => { buf += d; });
      p.stderr.on('data', d => { err += d; });
      p.on('close', (code) => {
        const line = buf.split('\n').find(l => l.startsWith('@@RESULT '));
        resolve(line ? JSON.parse(line.slice(9)) : { variant: v || 'base', failed: code, log: (err || buf).slice(-1500) });
      });
    });
    console.error(`done: ${r.variant}`);
    results.push(r);
  }
  console.log(JSON.stringify(results, null, 2));
}

const args = process.argv.slice(2);
if (args[0] === '--child') child(args[1]).catch(e => { console.error(e); process.exit(1); });
else if (!args[0]) { console.error('usage: compare-series.js <sales.sqlite>'); process.exit(2); }
else main(args[0]);
