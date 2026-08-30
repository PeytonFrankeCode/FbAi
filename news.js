// Articles: storage, rendering, and the shortcode that keeps them current.
//
// Split out of server.js because that file is already 8,000 lines, and because
// everything here is self-contained — it touches the sales database only
// through a callback the caller supplies, so it can be tested without one.
//
// The pages are rendered on the SERVER, not by the SPA. That is the whole
// reason the section exists: an article that ships as an empty <div id="app">
// ranks for nothing, and ranking is the point. Every route below returns
// complete markup with the real text in it.

const CATEGORIES = ['Market Moves', 'Rookies', 'Set Guides', 'Grading', 'Collecting'];

// Punctuation out, spaces to hyphens, runs collapsed. Deliberately strict:
// a slug is a permanent URL, so it must never contain anything that needs
// escaping later.
function slugify(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Roughly 220 words a minute, floored at one. Shown on the card and the
// article; readers use it to decide whether to start, so a wrong number is
// worse than none — this only ever counts the words that are actually there.
function readingMinutes(body) {
  const words = String(body || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

function isPublished(a, now = Date.now()) {
  if (!a || a.status !== 'published') return false;
  const at = Date.parse(a.publishedAt || '');
  return !Number.isFinite(at) || at <= now;
}

/**
 * A deliberately small Markdown subset: headings, bold, italic, links, lists,
 * blockquotes, paragraphs.
 *
 * Small on purpose. A full Markdown library is another dependency compiled
 * into a Worker that already went down once for being too large, and articles
 * written in-house do not need footnotes and tables. Everything is escaped
 * BEFORE any markup is introduced, so a pasted `<script>` renders as text.
 */
function renderMarkdown(src, shortcode) {
  const blocks = String(src || '').replace(/\r\n/g, '\n').split(/\n{2,}/);
  const out = [];

  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;

    // Shortcodes resolve to whole blocks of their own and skip the inline
    // pass, since what they return is already markup.
    const sc = block.match(/^\{\{\s*([a-z-]+)([^}]*)\}\}$/i);
    if (sc && typeof shortcode === 'function') {
      const html = shortcode(sc[1].toLowerCase(), parseArgs(sc[2]));
      if (html) { out.push(html); continue; }
    }

    const heading = block.match(/^(#{2,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^>\s/.test(block)) {
      out.push(`<blockquote>${inline(block.replace(/^>\s?/gm, ''))}</blockquote>`);
      continue;
    }

    if (/^[-*]\s/.test(block)) {
      const items = block.split('\n').filter(l => /^[-*]\s/.test(l))
        .map(l => `<li>${inline(l.replace(/^[-*]\s+/, ''))}</li>`).join('');
      out.push(`<ul>${items}</ul>`);
      continue;
    }

    out.push(`<p>${inline(block)}</p>`);
  }
  return out.join('\n');
}

function parseArgs(s) {
  const args = {};
  for (const m of String(s || '').matchAll(/([a-z_]+)\s*=\s*"([^"]*)"|([a-z_]+)\s*=\s*(\S+)/gi)) {
    args[(m[1] || m[3]).toLowerCase()] = m[2] !== undefined ? m[2] : m[4];
  }
  return args;
}

// Escape first, then introduce markup. The order is the security property:
// doing it the other way round would let a pasted tag survive into the page.
function inline(text) {
  let t = esc(text);
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g,
                (_, label, href) => `<a href="${href}">${label}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  return t;
}

/** Strip markup and shortcodes for the meta description and the index card. */
function excerpt(a, max = 165) {
  const src = a.standfirst || String(a.body || '')
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/^#{1,6}\s+.*$/gm, ' ')
    .replace(/[*_`>#\[\]]/g, ' ');
  const flat = String(src).replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : flat;
}

module.exports = {
  CATEGORIES, slugify, esc, readingMinutes, isPublished,
  renderMarkdown, excerpt, parseArgs,
};
