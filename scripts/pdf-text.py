#!/usr/bin/env python3
"""Extract text from PDFs whose fonts are subsetted with no ToUnicode map.

Standard-library only: the environment's pypdf pulls in `cryptography`, whose
Rust bindings panic on import here.

These PDFs show text as hex glyph IDs (`<0001000200...> TJ`) against subset
TrueType fonts that carry neither a `cmap` nor a `/ToUnicode` CMap, so a glyph
id cannot be turned into a character the usual way. What they do carry is a
`post` v2.0 table, whose per-glyph index into the standard Macintosh glyph
order names each glyph ("A", "space", "seven"). That is enough to rebuild
glyph id -> character, which is what this does.
"""
import re, sys, zlib, struct

MAC_GLYPHS = (
    ".notdef .null nonmarkingreturn space exclam quotedbl numbersign dollar percent "
    "ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash "
    "zero one two three four five six seven eight nine colon semicolon less equal greater "
    "question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash "
    "bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v w "
    "x y z braceleft bar braceright asciitilde Adieresis Aring Ccedilla Eacute Ntilde "
    "Odieresis Udieresis aacute agrave acircumflex adieresis atilde aring ccedilla eacute "
    "egrave ecircumflex edieresis iacute igrave icircumflex idieresis ntilde oacute ograve "
    "ocircumflex odieresis otilde uacute ugrave ucircumflex udieresis dagger degree cent "
    "sterling section bullet paragraph germandbls registered copyright trademark acute "
    "dieresis notequal AE Oslash infinity plusminus lessequal greaterequal yen mu "
    "partialdiff summation product pi integral ordfeminine ordmasculine Omega ae oslash "
    "questiondown exclamdown logicalnot radical florin approxequal Delta guillemotleft "
    "guillemotright ellipsis nonbreakingspace Agrave Atilde Otilde OE oe endash emdash "
    "quotedblleft quotedblright quoteleft quoteright divide lozenge ydieresis Ydieresis "
    "fraction currency guilsinglleft guilsinglright fi fl daggerdbl periodcentered "
    "quotesinglbase quotedblbase perthousand Acircumflex Ecircumflex Aacute Edieresis "
    "Egrave Iacute Icircumflex Idieresis Igrave Oacute Ocircumflex apple Ograve Uacute "
    "Ucircumflex Ugrave dotlessi circumflex tilde macron breve dotaccent ring cedilla "
    "hungarumlaut ogonek caron"
).split()

NAME_CHAR = {
    'space': ' ', 'exclam': '!', 'quotedbl': '"', 'numbersign': '#', 'dollar': '$',
    'percent': '%', 'ampersand': '&', 'quotesingle': "'", 'parenleft': '(', 'parenright': ')',
    'asterisk': '*', 'plus': '+', 'comma': ',', 'hyphen': '-', 'period': '.', 'slash': '/',
    'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5', 'six': '6',
    'seven': '7', 'eight': '8', 'nine': '9', 'colon': ':', 'semicolon': ';', 'less': '<',
    'equal': '=', 'greater': '>', 'question': '?', 'at': '@', 'bracketleft': '[',
    'backslash': '\\', 'bracketright': ']', 'asciicircum': '^', 'underscore': '_',
    'grave': '`', 'braceleft': '{', 'bar': '|', 'braceright': '}', 'asciitilde': '~',
    'quoteright': '’', 'quoteleft': '‘', 'quotedblleft': '“',
    'quotedblright': '”', 'endash': '–', 'emdash': '—', 'bullet': '•',
    'ellipsis': '…', 'nonbreakingspace': ' ', 'fi': 'fi', 'fl': 'fl',
    'periodcentered': '·', 'degree': '°', 'registered': '®',
    'copyright': '©', 'trademark': '™', 'eacute': 'é', 'egrave': 'è',
    'ccedilla': 'ç', 'ntilde': 'ñ', 'odieresis': 'ö', 'udieresis': 'ü',
    'adieresis': 'ä', 'aacute': 'á', 'iacute': 'í', 'oacute': 'ó',
    'uacute': 'ú', 'agrave': 'à',
}

def glyph_names_from_font(raw):
    """glyph id -> character, read out of a TrueType `post` v2.0 table."""
    try:
        num = struct.unpack('>H', raw[4:6])[0]
        tables = {}
        for i in range(num):
            off = 12 + i * 16
            tag = raw[off:off + 4].decode('latin-1')
            o, l = struct.unpack('>II', raw[off + 8:off + 16])
            tables[tag] = (o, l)
        if 'post' not in tables:
            return None
        o, l = tables['post']
        if struct.unpack('>I', raw[o:o + 4])[0] != 0x00020000:
            return None
        n = struct.unpack('>H', raw[o + 32:o + 34])[0]
        idx = struct.unpack('>%dH' % n, raw[o + 34:o + 34 + 2 * n])
        # Names beyond the standard 258 live in a pascal-string table.
        extra, p = [], o + 34 + 2 * n
        while p < o + l:
            ln = raw[p]
            extra.append(raw[p + 1:p + 1 + ln].decode('latin-1', 'replace'))
            p += 1 + ln
        out = {}
        for gid, ix in enumerate(idx):
            name = MAC_GLYPHS[ix] if ix < len(MAC_GLYPHS) else (
                extra[ix - 258] if 0 <= ix - 258 < len(extra) else '')
            if not name:
                continue
            if name in NAME_CHAR:
                out[gid] = NAME_CHAR[name]
            elif len(name) == 1:
                out[gid] = name
            elif re.fullmatch(r'uni([0-9A-Fa-f]{4})', name):
                out[gid] = chr(int(name[3:], 16))
        return out
    except Exception:
        return None

TEXT_OP = re.compile(rb'\[((?:[^\[\]\\]|\\.)*)\]\s*TJ|<([0-9A-Fa-f\s]*)>\s*Tj')
HEXSTR = re.compile(rb'<([0-9A-Fa-f\s]*)>')
KERN = re.compile(rb'(-?\d+(?:\.\d+)?)')

def decode_hex(h, gmap):
    h = re.sub(rb'\s', b'', h)
    if len(h) % 4:
        h = h[:len(h) // 4 * 4]
    out = []
    for i in range(0, len(h), 4):
        gid = int(h[i:i + 4], 16)
        out.append(gmap.get(gid, ''))
    return ''.join(out)

def content_text(raw, gmap):
    parts = []
    for m in TEXT_OP.finditer(raw):
        if m.group(1) is not None:
            arr = m.group(1)
            pos = 0
            for hm in HEXSTR.finditer(arr):
                # A large negative kern between runs is a word space.
                gap = KERN.findall(arr[pos:hm.start()])
                if gap and abs(float(gap[-1])) > 120:
                    parts.append(' ')
                parts.append(decode_hex(hm.group(1), gmap))
                pos = hm.end()
            parts.append('\n')
        else:
            parts.append(decode_hex(m.group(2), gmap))
    return ''.join(parts)

def extract(path):
    data = open(path, 'rb').read()
    streams = []
    for m in re.finditer(rb'stream\r?\n', data):
        s = m.end()
        e = data.find(b'endstream', s)
        if e < 0:
            continue
        try:
            streams.append(zlib.decompress(data[s:e]))
        except Exception:
            continue
    # One glyph map, merged across every embedded font. The documents use a
    # handful of subsets; ids collide rarely and always on the same letter.
    gmap = {}
    for raw in streams:
        if raw[:4] in (b'\x00\x01\x00\x00', b'true', b'ttcf'):
            g = glyph_names_from_font(raw)
            if g:
                for k, v in g.items():
                    gmap.setdefault(k, v)
    out = []
    for raw in streams:
        if b'TJ' not in raw and b'Tj' not in raw:
            continue
        if raw[:4] in (b'\x00\x01\x00\x00', b'true', b'ttcf'):
            continue
        t = content_text(raw, gmap)
        if t.strip():
            out.append(t)
    return '\n'.join(out)

if __name__ == '__main__':
    sys.stdout.write(extract(sys.argv[1]))
