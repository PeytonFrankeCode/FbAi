// An attached photo is screened, or it is not published.
//
// WHY THIS EXISTS. moderation.js reports honestly and declines to set policy:
// with no provider configured, moderateImage returns
// { allowed: true, verified: false }, which means "nobody looked at this".
// Both community endpoints used to publish on that and rely on the
// report/auto-hide net, which needs three distinct people to report a post.
//
// The photo lands on the same URL as the ad tag, because the feed is a panel
// inside the app shell. An unscreened image beside ads risks the AdSense
// ACCOUNT, not just an application, and the trade is lopsided: refusing a
// photo annoys one person for a minute, publishing the wrong one is not
// undone by noticing later.
//
// What must stay true: text posts keep working with photos off (a safety
// measure that kills the feature gets reverted), and a configured provider
// turns photos straight back on.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const fs = require('fs');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

process.env.CF_WORKER = '1';
process.env.ADMIN_PASSWORD = 'test-key-for-images';
delete process.env.COMMUNITY_ALLOW_UNVERIFIED_IMAGES;
delete process.env.IMAGE_MODERATION_URL;
delete process.env.IMAGE_MODERATION_KEY;

const { screenCommunityImage } = require(path.join(ROOT, 'server.js'));
const IMG = 'https://example.test/card.jpg';

(async () => {
  // ---- No provider: the default state, and the one that was publishing ----
  {
    const r = await screenCommunityImage(IMG);
    check('an image nobody screened is refused',
      !!r && r.status === 503 && r.body.reason === 'image-screening-unavailable',
      r ? `${r.status} ${r.body.reason}` : 'PUBLISHED — this is the bug');
    check('  ...and the refusal says photos are off rather than blaming the photo',
      !!r && /can’t screen|cannot screen|paused/i.test(r.body.error)
        // and does not promise something that is not going to happen: the
        // post is refused here, not published without the photo.
        && !/will go up|posted without/i.test(r.body.error),
      r && r.body.error);
  }

  // ---- The feature must survive the safety measure ----
  {
    const r = await screenCommunityImage('');
    check('a text-only post is unaffected', r === null,
      'photos off must not mean the community is off');
    const r2 = await screenCommunityImage(null);
    check('  ...and so is a post with no image field at all', r2 === null);
  }

  // ---- A configured provider turns photos back on ----
  {
    const realFetch = global.fetch;
    process.env.IMAGE_MODERATION_URL = 'https://moderator.test/check';
    process.env.IMAGE_MODERATION_KEY = 'k';

    global.fetch = async () => ({ ok: true, json: async () => ({ nsfw: 0.01 }) });
    check('a clean image from a configured provider publishes',
      (await screenCommunityImage(IMG)) === null,
      'wiring a provider is what turns photos back on');

    global.fetch = async () => ({ ok: true, json: async () => ({ nsfw: 0.99 }) });
    const bad = await screenCommunityImage(IMG);
    check('an image the provider scores NSFW is refused',
      !!bad && bad.status === 422 && bad.body.reason === 'image',
      bad ? `${bad.status} ${bad.body.reason}` : 'published');

    // The case that matters most: the screen itself breaks.
    global.fetch = async () => { throw new Error('provider down'); };
    const down = await screenCommunityImage(IMG);
    check('a provider that is DOWN refuses rather than publishes',
      !!down && down.status === 503,
      down ? `${down.status}` : 'published — an outage must not open the gate');

    global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const err = await screenCommunityImage(IMG);
    check('  ...and so does one returning an error',
      !!err && err.status === 503, err ? `${err.status}` : 'published');

    global.fetch = realFetch;
    delete process.env.IMAGE_MODERATION_URL;
    delete process.env.IMAGE_MODERATION_KEY;
  }

  // ---- Both endpoints have to use it, not just one ----
  {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const uses = (src.match(/await screenCommunityImage\(imageUrl\)/g) || []).length;
    check('posts AND comments both go through the shared screen', uses === 2,
      `${uses} call sites — comments accept photos too, and a rule applied to one is not a rule`);
    check('  ...and neither calls moderateImage directly any more',
      (src.match(/moderateImage\(imageUrl\)/g) || []).length === 1,
      'the only remaining call should be inside screenCommunityImage itself');
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall community-image checks passed');
  process.exit(failures ? 1 : 0);
})();
