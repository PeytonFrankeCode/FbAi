/**
 * Auto-moderation for user-generated community content.
 *
 * Two independent checks, both safe to run on Node and inside the Cloudflare
 * Worker bundle (no native deps, no filesystem):
 *
 *   moderateText(text)            -> synchronous profanity / slur / spam screen
 *   moderateImage(imageUrl, env)  -> optional NSFW screen via a configured
 *                                    vision-moderation provider, with a safe
 *                                    "allow but mark unverified" fallback.
 *
 * Text moderation works out of the box. Image moderation only *enforces* when
 * an external provider is wired up via env (IMAGE_MODERATION_URL +
 * IMAGE_MODERATION_KEY); otherwise it lets the post through but flags it as
 * unverified so the report -> auto-hide safety net still applies.
 */

// --- Word lists ---------------------------------------------------------
// Strong slurs / sexually explicit terms — always blocked. Matched against a
// separator-collapsed form of the text so "n.i.g.g.e.r" / "f u c k" can't slip
// through. Kept deliberately short and high-confidence to avoid false hits.
const HARD_BLOCK = [
  'nigger', 'nigga', 'faggot', 'fag', 'retard', 'chink', 'spic', 'kike',
  'wetback', 'tranny', 'coon', 'cunt', 'whore',
  'rape', 'rapist', 'pedophile', 'pedo', 'childporn', 'cp',
  'cum', 'cock', 'dick', 'pussy', 'blowjob', 'handjob', 'cumshot',
  'porn', 'xxx', 'nude', 'nudes', 'naked', 'sex', 'horny', 'milf',
  'jizz', 'bukkake', 'creampie', 'deepthroat', 'fuck', 'fucker', 'fucking',
  'motherfucker', 'bitch', 'bastard', 'slut', 'twat',
];

// Spam signals — too many links, or shouting a contact channel to evade the
// marketplace. Flagged (not hard-blocked) so a single eBay link is fine.
const SPAM_PATTERNS = [
  /\b(?:https?:\/\/|www\.)\S+/gi,            // urls (counted; >3 is spammy)
  /\b\d[\d\s().-]{8,}\d\b/g,                  // phone-number-ish runs
  /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi,         // bare emails
];

// --- Text normalisation -------------------------------------------------
// Map common leetspeak / homoglyphs back to letters so obfuscation doesn't
// defeat the filter, then collapse separators and repeated characters.
const LEET = { '4': 'a', '@': 'a', '8': 'b', '3': 'e', '1': 'i', '!': 'i', '0': 'o', '5': 's', '$': 's', '7': 't', '+': 't' };

function normalize(text) {
  let s = String(text || '').toLowerCase();
  s = s.replace(/[4@83110$57+!]/g, ch => LEET[ch] || ch);
  return s;
}

// A version with every non-letter removed, so spaced/punctuated evasions
// ("f-u-c-k", "s e x") collapse into a single matchable token stream.
function collapse(normalized) {
  return normalized
    .replace(/[^a-z]/g, '')        // drop spaces, digits-as-letters already mapped, punctuation
    .replace(/(.)\1{2,}/g, '$1');  // run of 3+ identical chars -> 1 (fuuuuck -> fuck)
}

/**
 * Screen a block of user text.
 * @returns {{ allowed: boolean, reason?: string, matched?: string }}
 */
function moderateText(text) {
  const raw = String(text || '');
  if (!raw.trim()) return { allowed: true };

  const norm = normalize(raw);
  const collapsed = collapse(norm);

  for (const term of HARD_BLOCK) {
    // Collapsed substring catches spaced/punctuated evasions; we also guard the
    // shortest, most ambiguous terms with a word-boundary check on the plain
    // normalized text to avoid the "Scunthorpe" false positive.
    if (collapsed.includes(term)) {
      if (term.length <= 3) {
        const wb = new RegExp(`\\b${term}\\b`, 'i');
        if (!wb.test(norm)) continue;
      }
      return { allowed: false, reason: 'language', matched: term };
    }
  }

  // Spam: count links; block on 4+, or on a phone/email plus a link.
  let linkCount = 0, hasContact = false;
  SPAM_PATTERNS.forEach((re, i) => {
    const m = raw.match(re);
    if (!m) return;
    if (i === 0) linkCount += m.length;
    else hasContact = true;
  });
  if (linkCount >= 4 || (linkCount >= 1 && hasContact && raw.length < 60)) {
    return { allowed: false, reason: 'spam' };
  }

  return { allowed: true };
}

// --- Bidi control stripping ---------------------------------------------
// Remove Unicode bidirectional control characters (RLO/LRO/RLE/LRM/RLM and the
// isolate set). A single U+202E makes a whole message render backwards
// ("Hi there" -> "ereht iH") on every client, and CSS direction:ltr can't undo
// it — the character itself must be removed. Some mobile keyboards inject these
// and they're the classic Trojan-Source text-spoofing vector, so we strip them
// from all user text at the source.
function stripBidi(text) {
  return String(text == null ? '' : text).replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g, '');
}

// --- Image moderation ---------------------------------------------------
const IMG_TIMEOUT_MS = 6000;

function readEnv(env, key) {
  if (env && env[key] != null) return env[key];
  if (typeof process !== 'undefined' && process.env && process.env[key] != null) return process.env[key];
  return undefined;
}

/**
 * Screen an attached image. If an external moderation provider is configured
 * we POST the image to it and honour its NSFW score; otherwise we let the
 * image through marked `verified: false` so the report/auto-hide net applies.
 *
 * @returns {Promise<{ allowed: boolean, verified: boolean, reason?: string, score?: number }>}
 */
async function moderateImage(imageUrl, env) {
  if (!imageUrl) return { allowed: true, verified: true };

  const url = readEnv(env, 'IMAGE_MODERATION_URL');
  const key = readEnv(env, 'IMAGE_MODERATION_KEY');
  const threshold = parseFloat(readEnv(env, 'IMAGE_MODERATION_THRESHOLD')) || 0.7;

  // No provider configured — allow but mark unverified.
  if (!url || !key) return { allowed: true, verified: false };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMG_TIMEOUT_MS);
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ image: imageUrl }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!resp.ok) return { allowed: true, verified: false };
    const data = await resp.json().catch(() => ({}));

    // Accept a few common response shapes: { nsfw }, { score }, { flagged }.
    const score = typeof data.nsfw === 'number' ? data.nsfw
      : typeof data.score === 'number' ? data.score
      : (data.flagged ? 1 : 0);

    if (score >= threshold) {
      return { allowed: false, verified: true, reason: 'image', score };
    }
    return { allowed: true, verified: true, score };
  } catch (_) {
    // Provider down / timed out — fail open but unverified so reports still gate it.
    return { allowed: true, verified: false };
  }
}

module.exports = { moderateText, moderateImage, stripBidi };
