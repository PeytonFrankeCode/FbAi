/**
 * Minimal iconv-lite stub for the Cloudflare Workers bundle.
 *
 * Why this exists:
 *   The real iconv-lite package ships a streams.js file that calls
 *   `require("stream").Transform` at module-load time. When wrangler/esbuild
 *   bundles it for Workers, the result is `require_streams(...) is not a
 *   function` at runtime — even though we never call iconv-lite directly.
 *
 *   iconv-lite gets pulled in transitively by `body-parser` (used by
 *   `express.json()`) for charset detection. Our app only ever reads/writes
 *   UTF-8 JSON, so we don't actually need character-set conversion. This
 *   stub satisfies the API surface body-parser uses and bypasses the
 *   streams problem entirely.
 *
 * Wired up via the `alias` field in wrangler.toml.
 */

const utf8Decoder = new TextDecoder('utf-8');
const utf8Encoder = new TextEncoder();

function decode(buf, encoding) {
  if (buf == null) return '';
  // body-parser passes Buffers; treat everything as UTF-8.
  if (typeof buf === 'string') return buf;
  if (buf instanceof Uint8Array) return utf8Decoder.decode(buf);
  if (buf && typeof buf.toString === 'function') return buf.toString('utf8');
  return String(buf);
}

function encode(str, encoding) {
  if (str == null) return new Uint8Array(0);
  return utf8Encoder.encode(String(str));
}

function encodingExists(encoding) {
  if (!encoding) return false;
  const e = String(encoding).toLowerCase();
  return e === 'utf8' || e === 'utf-8' || e === 'ascii' || e === 'us-ascii';
}

module.exports = {
  encode,
  decode,
  encodingExists,
  // Stream helpers — never invoked because supportsStreams is false.
  supportsStreams: false,
  encodeStream() { throw new Error('iconv-lite stub: streams not supported in Workers'); },
  decodeStream() { throw new Error('iconv-lite stub: streams not supported in Workers'); },
  getEncoder() { return { write: encode, end() { return new Uint8Array(0); } }; },
  getDecoder() { return { write: decode, end() { return ''; } }; },
};
