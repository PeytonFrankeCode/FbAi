// The beta survey: a visitor answers, the admin page reads it.
//
// Drives the real app: bad answers are refused, a bot's are dropped, a
// person's are saved, only the admin key reads them back, and the summary
// the admin page shows adds up. Then checks the page carries the form.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const { validateSurvey, summarizeSurveys } = require(path.join(ROOT, 'beta-survey.js'));

// ---- the rules, pure ------------------------------------------------------
check('a rating is required, 1 to 5',
  !validateSurvey({}).ok && !validateSurvey({ rating: 6 }).ok && !validateSurvey({ rating: '0' }).ok && validateSurvey({ rating: '4' }).ok);
check('  ...the recommend score is optional, 0 to 10',
  validateSurvey({ rating: 3 }).response.nps === null && validateSurvey({ rating: 3, nps: '0' }).response.nps === 0
  && !validateSurvey({ rating: 3, nps: 11 }).ok);
{
  const v = validateSurvey({ rating: 5, uses: ['checklists', 'hack', 'checklists'], found: 'maybe', improve: 'x'.repeat(5000), email: ' Fan@Example.com ' });
  check('  ...unknown choices are dropped and repeats collapse', v.response.uses.join() === 'checklists' && v.response.found === null);
  check('  ...a long answer is kept, capped at 1,000 characters', v.response.improve.length === 1000);
  check('  ...where it was opened from is kept, an unknown one reads as a shared link',
    validateSurvey({ rating: 5, source: 'email' }).response.source === 'email' && validateSurvey({ rating: 5, source: '<x>' }).response.source === 'link');
  check('  ...an email is optional and stored lower-case', v.response.email === 'fan@example.com' && !validateSurvey({ rating: 5, email: 'nope' }).ok);
}
{
  const s = summarizeSurveys([
    { at: '2026-09-01T00:00:00Z', rating: 5, nps: 10, found: 'yes', uses: ['checklists', 'alerts'] },
    { at: '2026-09-03T00:00:00Z', rating: 4, nps: 9, found: 'mostly', uses: ['checklists'] },
    { at: '2026-09-02T00:00:00Z', rating: 2, nps: 3, found: 'no', uses: [], email: 'a@b.co' },
    { at: '2026-09-04T00:00:00Z', rating: 3, nps: null, found: null, uses: [] },
  ]);
  check('the summary: count, average, and NPS as promoters minus detractors',
    s.count === 4 && s.avgRating === 3.5 && s.nps === 33 && s.npsResponses === 3, JSON.stringify({ n: s.count, avg: s.avgRating, nps: s.nps }));
  check('  ...what people use it for, most first', s.uses[0].id === 'checklists' && s.uses[0].count === 2 && s.uses[1].id === 'alerts');
  check('  ...and the answers newest first', s.responses.map(r => r.rating).join() === '3,4,2,5');
}

// ---- the flow, against the real app --------------------------------------
process.env.CF_WORKER = '1';
process.env.ADMIN_PASSWORD = 'survey-admin';
const { app } = require(path.join(ROOT, 'server.js'));
const PORT = 3247;
const server = app.listen(PORT);
const base = `http://127.0.0.1:${PORT}`;
// Each request its own address, so the rate limit is tested only where meant.
let ip = 10;
const post = (body, addr) => fetch(base + '/api/survey', {
  method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': addr || `198.51.100.${ip++}` }, body: JSON.stringify(body),
});

(async () => {
  check('an answer with no rating is refused', (await post({ improve: 'more players' })).status === 400);
  const ok = await post({ rating: 4, nps: 9, found: 'mostly', uses: ['price-my-cards', 'card-shows'], improve: 'Faster search at shows', broken: '', page: '/?q=Josh%20Allen', searches: 5, source: 'banner' });
  check('a person\'s answer is saved', ok.status === 200 && (await ok.json()).ok === true);
  const bot = await post({ rating: 1, improve: 'buy cheap watches', website: 'http://spam.example' });
  check('  ...a bot filling the hidden field is told "ok" and saved nowhere', bot.status === 200);

  check('the answers are for the admin only', (await fetch(base + '/api/admin/surveys')).status === 401
    && (await fetch(base + '/api/admin/surveys?key=wrong')).status === 401);
  const got = await (await fetch(base + '/api/admin/surveys', { headers: { 'x-admin-key': 'survey-admin' } })).json();
  const r = got.responses && got.responses[0];
  check('  ...and the admin reads back exactly the person\'s answer, not the bot\'s',
    got.count === 1 && r.rating === 4 && r.nps === 9 && r.improve === 'Faster search at shows' && r.searches === 5 && r.at && r.id,
    JSON.stringify(got.count));
  check('  ...with the summary the admin page shows', got.avgRating === 4 && got.nps === 100 && got.found.mostly === 1);
  check('  ...including where it was opened from', r.source === 'banner' && got.sources[0].id === 'banner' && got.sources[0].count === 1,
    JSON.stringify(got.sources));

  const same = '203.0.113.9';
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await post({ rating: 3 }, same)).status);
  check('one address sending answers in a burst is held to a few a minute', codes.slice(0, 3).every(c => c === 200) && codes[3] === 429, codes.join(','));

  server.close();

  // ---- the page ------------------------------------------------------------
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const admin = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
  const questions = (html.match(/id="survey-form"[\s\S]*?<\/form>/) || [''])[0];
  const qCount = (questions.match(/<legend>|<label for="survey-/g) || []).length;
  check('the survey is short: seven questions', qCount === 7, `${qCount} questions`);
  check('  ...opened from the footer, and offered after the third search counted across visits',
    /onclick="openSurvey\('footer'\)"/.test(html) && /_surveyNoteSearch\(\);/.test(js) && /SURVEY_AFTER_SEARCHES = 3/.test(js)
    && /m\.searches = \(m\.searches \|\| 0\) \+ 1;\s*_saveSurveyMeta\(m\);\s*if \(m\.searches >= SURVEY_AFTER_SEARCHES\) _surveyOffer\('banner'\)/.test(js));
  check('  ...and 30 seconds into a return visit', /SURVEY_RETURN_DELAY_MS = 30 \* 1000/.test(js)
    && /if \(m\.visits >= 2\)[\s\S]{0,120}_surveyOffer\('return'\)/.test(js) && /initSiteBanner\(\); initSurvey\(\);/.test(js));
  check('  ...a ?survey= link opens it, and the banner says where it was offered',
    /searchParams\.get\('survey'\)/.test(js) && /openSurvey\(this\.closest\('\.survey-banner'\)\.dataset\.source/.test(html));

  // The ask rule itself, pure.
  const src = js.slice(js.indexOf('function _surveyMayAsk('));
  const mayAsk = new Function('SURVEY_REASK_MS', `${src.slice(0, src.indexOf('\n}\n') + 2)}; return _surveyMayAsk;`)(30 * 864e5);
  const DAY = 864e5, now = Date.parse('2026-10-01T00:00:00Z');
  check('someone never asked may be asked', mayAsk('', {}, now));
  check('  ...a "no" waits 30 days, then asks once more', !mayAsk('dismissed', { dismissedAt: now - 29 * DAY }, now)
    && mayAsk('dismissed', { dismissedAt: now - 30 * DAY }, now));
  check('  ...an old undated "no" is not asked straight away', !mayAsk('dismissed', {}, now));
  check('  ...a second "no" or an answer is final', !mayAsk('dismissed2', {}, now + 999 * DAY) && !mayAsk('done', {}, now + 999 * DAY));
  check('  ...closing the footer survey is not a "no"', /if \(_surveySource !== 'footer' && _surveyState\(\) !== 'done'\) _surveyDeclined\(\);/.test(js));

  check('the announcement asks too, and hides once answered', /survey: true/.test(js) && /openSurvey\('announce'\)/.test(js)
    && /if \(BANNER\.survey && _surveyState\(\) === 'done'\) return;/.test(js));
  {
    const d = require(path.join(ROOT, 'market-digest.js'));
    const c = { sales: 10, value: 100, avg: 10, risers: [], players: [], fallers: [], mostSold: [], priciest: [], sets: [] };
    const during = d.renderDigest(c, { week: '2026-W40', unsubUrl: 'u', now: d.SURVEY_ASK_UNTIL - DAY });
    const after = d.renderDigest(c, { week: '2026-W44', unsubUrl: 'u', now: d.SURVEY_ASK_UNTIL });
    check('the weekly email links the survey for a few weeks, then stops', /\?survey=email/.test(during.html) && /\?survey=email/.test(during.text)
      && !/survey=/.test(after.html) && !/survey=/.test(after.text));
  }
  check('the admin page lists the answers', /Beta Survey/.test(admin) && /\/api\/admin\/surveys/.test(admin) && /loadSurveys\(\);/.test(admin));
  check('  ...and where they came from', /Where answers came from/.test(admin) && /d\.sources/.test(admin));

  console.log(failures ? `\n${failures} check(s) failed` : '\nall beta-survey checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); server.close(); process.exit(1); });
