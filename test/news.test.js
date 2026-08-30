// The article renderer, and mostly what it refuses to do.
//
// Articles are typed into an admin form and rendered straight into a public
// page, so the renderer is the boundary between "something someone pasted" and
// "markup the browser executes". Escaping has to happen BEFORE any markup is
// introduced, or a pasted tag survives into the page — that ordering is the
// only thing standing between a body field and stored XSS, and it is easy to
// get backwards while making the formatting nicer.
const {
  slugify, readingMinutes, isPublished, renderMarkdown, excerpt, parseArgs,
} = require('../news.js');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// 1. The security property, stated as a test rather than a comment.
{
  const nasty = [
    '<script>alert(1)</script>',
    'before <img src=x onerror="alert(1)"> after',
    '**bold <script>x</script>**',
    '[click](javascript:alert(1))',
    '> quote with <iframe src="evil"></iframe>',
  ];
  // What counts as a leak is a LIVE tag or a live javascript: href — not the
  // string "onerror" sitting harmlessly inside escaped text. The obvious
  // regex (/onerror=|javascript:/) fails both ways round: it flags
  // `&lt;img ... onerror=&quot;` which is already inert, and it would miss a
  // tag spelled differently. So check for what the browser would actually
  // execute: an unescaped element, or javascript: inside an attribute.
  const leaked = [];
  for (const src of nasty) {
    const html = renderMarkdown(src);
    const liveTag = /<(?!\/?(p|h2|h3|strong|em|ul|li|blockquote|code|a)\b)[a-z]/i.test(html);
    const liveJs = /(href|src)\s*=\s*["']?\s*javascript:/i.test(html);
    if (liveTag || liveJs) leaked.push(`${src} -> ${html}`);
  }
  check('pasted HTML and javascript: links never reach the page',
        leaked.length === 0,
        leaked.length ? `LEAKED: ${leaked.join(' ; ')}` : `all ${nasty.length} neutralised`);
}

// 2. ...while the formatting it IS supposed to do still works. A renderer that
//    escapes everything is safe and useless.
{
  const html = renderMarkdown(
    '## Heading\n\nSome **bold** and *italic* text.\n\n- one\n- two\n\n> a quote\n\n[link](/news/x)');
  const want = ['<h2>Heading</h2>', '<strong>bold</strong>', '<em>italic</em>',
                '<li>one</li>', '<blockquote>', '<a href="/news/x">link</a>'];
  const missing = want.filter(w => !html.includes(w));
  check('  ...but real formatting still renders',
        missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `${want.length}/${want.length}`);
}

// 3. Slugs are permanent URLs, so they must never carry anything that would
//    need escaping downstream.
{
  const cases = [
    ["Jaxson Dart's Silver Prizm — cooled 12%!", 'jaxson-darts-silver-prizm-cooled-12'],
    ['  Multiple   Spaces  ', 'multiple-spaces'],
    ['A/B <test> & more', 'a-b-test-more'],
  ];
  const bad = cases.filter(([input, want]) => slugify(input) !== want)
                   .map(([i]) => `"${i}" -> "${slugify(i)}"`);
  check('slugs come out URL-safe', bad.length === 0, bad.length ? bad.join('; ') : `${cases.length} correct`);
  check('  ...and never contain characters needing escaping',
        !/[^a-z0-9-]/.test(slugify('Anything <>&"\' goes 2026!')),
        slugify('Anything <>&"\' goes 2026!'));
}

// 4. Scheduling. A draft or a future-dated post must not be publicly visible —
//    getting this wrong leaks an unfinished article, which is the one failure
//    an author cannot undo once it is crawled.
{
  const now = Date.parse('2026-08-28T12:00:00Z');
  const cases = [
    [{ status: 'published', publishedAt: '2026-08-27T00:00:00Z' }, true,  'published in the past'],
    [{ status: 'published', publishedAt: '2026-08-29T00:00:00Z' }, false, 'scheduled for the future'],
    [{ status: 'draft',     publishedAt: '2026-08-01T00:00:00Z' }, false, 'draft with a past date'],
    [{ status: 'published' },                                      true,  'published, no date'],
  ];
  const wrong = cases.filter(([a, want]) => isPublished(a, now) !== want).map(([, , label]) => label);
  check('drafts and future-dated articles stay hidden',
        wrong.length === 0, wrong.length ? `WRONG: ${wrong.join(', ')}` : `${cases.length} correct`);
}

// 5. The shortcode is the reason to have this section at all — an article that
//    quotes live comps stays true after it is published. It must reach the
//    renderer with its arguments intact.
{
  let seen = null;
  const html = renderMarkdown(
    'Intro.\n\n{{sold-table player="Jaxson Dart" set="2025 Panini Prizm" days=30}}\n\nOutro.',
    (name, args) => { seen = { name, args }; return '<div class="sold-table"></div>'; });
  check('a shortcode reaches the handler with its arguments',
        seen && seen.name === 'sold-table' && seen.args.player === 'Jaxson Dart'
          && seen.args.set === '2025 Panini Prizm' && seen.args.days === '30',
        seen ? JSON.stringify(seen) : 'handler never called');
  check('  ...and its output is placed as a block, not escaped',
        html.includes('<div class="sold-table"></div>') && html.includes('<p>Intro.</p>'),
        html.includes('&lt;div') ? 'ESCAPED — would render as text' : 'placed correctly');
  // An unknown shortcode must not vanish silently; the author needs to see it.
  const unknown = renderMarkdown('{{no-such-thing x=1}}', () => null);
  check('  ...while an unhandled one degrades to visible text',
        unknown.includes('no-such-thing') && !unknown.includes('<div'),
        unknown.slice(0, 60));
}

// 6. Reading time and excerpt drive the index cards. Both are shown to readers
//    deciding whether to click, so neither may include shortcode plumbing.
{
  const a = {
    body: '{{sold-table player="X"}}\n\n## Heading\n\n' + 'word '.repeat(440),
  };
  const ex = excerpt(a);
  check('the excerpt strips shortcodes and headings',
        !ex.includes('{{') && !ex.includes('#') && ex.length <= 165,
        `${ex.length} chars: "${ex.slice(0, 48)}…"`);
  check('  ...and reading time counts the words that are there',
        readingMinutes(a.body) >= 2, `${readingMinutes(a.body)} min`);
  check('  ...with a standfirst preferred when one exists',
        excerpt({ standfirst: 'Short and written on purpose.', body: 'x '.repeat(500) })
          === 'Short and written on purpose.');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall news checks passed');
process.exit(failures ? 1 : 0);
