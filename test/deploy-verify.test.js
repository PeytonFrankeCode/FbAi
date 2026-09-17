// The post-deploy check, actually executed.
//
// WHY THIS EXISTS. Twice in one day a fix was merged, deployed green, and
// reported as shipped while the site still served the old answer — once because
// a KV cache key had not been bumped, once because the change was wired into
// one of two endpoints. Both times the deploy genuinely succeeded and the
// report was genuinely wrong, and the only way anyone found out was a person
// refreshing a page and saying "it hasn't changed".
//
// The verify step in deploy.yml exists to catch that. But shell inside a
// workflow is never run until a real deploy runs it, which makes it the least
// tested code in the repo and the worst place for a silent mistake: a check
// that always passes is indistinguishable from a working one.
//
// So the step's own script is lifted out of the YAML and executed here under
// `bash -e` — the shell GitHub uses — with the network call stubbed. The point
// is the control flow, not the fetch.
const { execFileSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WF = path.join(ROOT, '.github', 'workflows', 'deploy.yml');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const yaml = fs.readFileSync(WF, 'utf8');

// No YAML parser is installed, and adding a dependency to read one file is a
// poor trade. The step is found by its name and its script by the indentation
// of the `run: |` block, which is exactly what YAML means by it.
function runScriptOf(stepName) {
  const lines = yaml.split('\n');
  const at = lines.findIndex(l => l.includes(`- name: ${stepName}`));
  if (at < 0) return null;
  const runAt = lines.findIndex((l, i) => i > at && /^\s*run: \|/.test(l));
  if (runAt < 0 || runAt > at + 12) return null;
  const indent = lines[runAt].match(/^(\s*)/)[1].length + 2;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { body.push(''); continue; }
    if (l.match(/^(\s*)/)[1].length < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

const script = runScriptOf('Verify the deploy is serving, and report what it says');
check('the verify step is in deploy.yml and its script can be read',
  !!script && script.includes('build.json'), script ? `${script.split('\n').length} lines` : 'not found');

if (!script) {
  console.log('\n1 check(s) failed');
  process.exit(1);
}

// Does the whole step even parse as shell?
//
// Asserted by name because the author of this file has already typed `//` where
// `#` was meant, inside the step, and shipped it. That is a hard syntax error
// that would have failed every deploy at the last step — after the deploy had
// already gone out. It surfaced here only as a confusing side effect in another
// check, so it gets its own.
{
  const file = path.join(os.tmpdir(), `verify-syntax-${Date.now()}.sh`);
  fs.writeFileSync(file, script);
  let ok = true, why = '';
  try { execFileSync('bash', ['-n', file], { stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { ok = false; why = String(e.stderr || '').trim().split('\n')[0]; }
  fs.unlinkSync(file);
  check('the verify step is valid bash', ok, why || 'parses');
}

// Only the polling half is exercised. What follows it writes a run summary and
// is reporting, not logic.
const body = script.split('# Now the numbers')[0];

function simulate(edgeResponds) {
  const stub = [
    // Stand in for the network. Everything else is the real script.
    //
    // The stub honours -o, because the script uses it: writing to a file rather
    // than piping into jq is what stopped the log filling with "curl: (23)"
    // while the old build was still serving. A stub that ignored -o would
    // silently test a script nobody runs.
    `curl() {`,
    `  local out=""; local prev=""`,
    `  for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done`,
    `  if [ -n "$out" ]; then printf '%s' ${JSON.stringify(edgeResponds)} > "$out"`,
    `  else printf '%s' ${JSON.stringify(edgeResponds)}; fi`,
    `}`,
    'sleep() { :; }',
    'seq() { command seq 1 2; }',   // two attempts, not twenty
    '',
  ].join('\n');
  const file = path.join(os.tmpdir(), `verify-${Date.now()}-${Math.random()}.sh`);
  fs.writeFileSync(file, stub + body);
  try {
    const out = execFileSync('bash', ['-e', file],
      { encoding: 'utf8', env: { ...process.env, GITHUB_SHA: 'SHA123' }, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  } finally {
    fs.unlinkSync(file);
  }
}

// The deploy propagated. The step must pass and say so.
{
  const r = simulate('{"sha":"SHA123","ref":"main"}');
  check('a matching build marker passes',
    r.code === 0 && /serving SHA123/.test(r.out), `exit ${r.code}: ${r.out.trim().slice(0, 80)}`);
}

// THE CASE THIS IS FOR. The deploy succeeded, the edge still serves the old
// build, and everything looks fine. It must fail loudly.
{
  const r = simulate('{"sha":"OLDSHA","ref":"main"}');
  check('a stale build marker FAILS the run',
    r.code !== 0, `exit ${r.code}`);
  check('  ...and says the deploy worked but the site did not change',
    /::error::/.test(r.out) && /still serving OLDSHA/.test(r.out)
    && /not report this as shipped/i.test(r.out),
    r.out.split('\n').filter(l => l.includes('::error::')).join(' ').slice(0, 130));
}

// A missing asset returns index.html with HTTP 200 under SPA fallback — the
// silent failure this codebase keeps meeting. A 200 proves nothing; only the
// SHA inside the JSON does.
{
  const r = simulate('<!doctype html><html><body>hello</body></html>');
  check('an HTML SPA fallback is not mistaken for a successful check',
    r.code !== 0 && /<no marker>|unknown build/.test(r.out), `exit ${r.code}`);
}

// A check that cannot fail is worse than none, because it is trusted.
{
  const r = simulate('');
  check('an empty response fails rather than passing by default',
    r.code !== 0, `exit ${r.code}`);
}

// ---- and the numbers it prints, which are not always this build's ---------
//
// The half below "# Now the numbers" used to be reporting rather than logic,
// and was left unexercised on that basis. It stopped being true.
//
// /api/sold-stats is cached for 48 hours and warmed by cron, so the board this
// step prints under a "Serving <sha>" heading can predate the deploy by two
// days. That is not hypothetical: a basis reading truncated:true against a
// 25,000-row cap was read here as the current build's output when the current
// build's ceiling is 60,000 and the board was simply old. The step now has to
// say which it is, and these run the three branches to prove it does.
const report = '# Now the numbers' + (script.split('# Now the numbers')[1] || '');

function simulateReport(statsJson) {
  const stub = [
    `curl() {`,
    `  local out=""; local prev=""`,
    `  for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done`,
    `  if [ -n "$out" ]; then printf '%s' ${JSON.stringify(statsJson)} > "$out"; fi`,
    `}`,
    '',
  ].join('\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-report-'));
  const file = path.join(dir, 'run.sh');
  const summary = path.join(dir, 'summary.md');
  fs.writeFileSync(file, stub + report);
  try {
    execFileSync('bash', ['-e', file], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GITHUB_SHA: 'SHA123', GITHUB_STEP_SUMMARY: summary },
    });
    return { code: 0, summary: fs.readFileSync(summary, 'utf8') };
  } catch (e) {
    return { code: e.status, summary: String(e.stdout || '') + String(e.stderr || '') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const BOARD = '"mostSold":[{"sales":9,"avgPrice":5,"topPrice":9,"name":"A Card"}],'
            + '"mostSoldBasis":{"salesRead":25000,"truncated":true}';
{
  const fresh = simulateReport(`{${BOARD}}`);
  check('a board this build computed is reported as this build\'s',
    fresh.code === 0 && /Computed fresh by this build/.test(fresh.summary)
    && !/warning/.test(fresh.summary),
    fresh.summary.trim().split('\n').pop());

  const stale = simulateReport(`{${BOARD},"servedFromCache":true,"ageMinutes":2400}`);
  check('a two-day-old cached board is not passed off as this build\'s',
    stale.code === 0 && /warning/.test(stale.summary)
    && /not this deploy's output/.test(stale.summary) && /2400 minutes ago/.test(stale.summary),
    stale.summary.split('\n').filter(l => l.startsWith('>')).join(' ').slice(0, 120));

  const recent = simulateReport(`{${BOARD},"servedFromCache":true,"ageMinutes":5}`);
  check('  ...while a cache hit from minutes ago is reported without alarm',
    recent.code === 0 && /built 5 minutes ago/.test(recent.summary)
    && !/warning/.test(recent.summary),
    recent.summary.split('\n').filter(l => l.startsWith('>')).join(' ').slice(0, 120));

  // Payloads cached before the stamp existed have no age at all. Treating a
  // missing number as 0 is how "unknown" becomes "brand new" — and `[ "" -gt
  // 60 ]` is a bash error that would fail the step outright under -e.
  const unknown = simulateReport(`{${BOARD},"servedFromCache":true}`);
  check('  ...and an unstamped cached board says so rather than erroring',
    unknown.code === 0 && /age unknown/.test(unknown.summary),
    `exit ${unknown.code}: ` + unknown.summary.split('\n').filter(l => l.startsWith('>')).join(' ').slice(0, 120));
}

// The marker has to be written before the deploy, or it ships the previous
// commit's SHA and the check passes against the wrong build — which would make
// it worse than useless.
{
  const stamp = yaml.indexOf('- name: Stamp the build marker');
  const deploy = yaml.indexOf('- name: Deploy to Cloudflare Workers');
  const verify = yaml.indexOf('- name: Verify the deploy is serving');
  check('the marker is stamped before the deploy, and verified after it',
    stamp > 0 && deploy > stamp && verify > deploy,
    `stamp@${stamp} deploy@${deploy} verify@${verify}`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall deploy-verify checks passed');
process.exit(failures ? 1 : 0);
