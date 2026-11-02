// IndexNow: removed pages are reported too (Bing "notify IndexNow of dead links").
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const build = read('scripts/build-landing-pages.js');
const script = read('scripts/indexnow-submit.js');
const deploy = read('.github/workflows/deploy.yml');

// The build records what it chose not to build.
assert(/PLANNED\.add\(urlPath\)/.test(build), 'every candidate page is recorded');
assert(/unbuilt-pages\.json/.test(build), 'the build writes .cache/unbuilt-pages.json');

// The submitter batches within the protocol limit and never reports a live page gone.
assert(/const BATCH = 10000/.test(script), 'batches of at most 10,000');
assert(/filter\(p => !live\.has\(p\)\)/.test(script), '--dead skips pages the live site serves');
assert(/gone: live\.filter\(p => !N\.has\(p\)\)/.test(script), 'a deploy reports pages it removed');

// The live list is saved before the deploy replaces it, and the IndexNow step runs after.
const save = deploy.indexOf('Save the live site\'s page list');
const dep = deploy.indexOf('- name: Deploy to Cloudflare Workers');
const ping = deploy.indexOf('Notify search engines of changed pages');
assert(save > 0 && save < dep && dep < ping, 'live list saved before deploy; IndexNow after');
assert(/indexnow-submit\.js --dead/.test(deploy) && /inputs\.indexnow_dead/.test(deploy), 'the catch-up runs only on request');

console.log('indexnow: ok');
