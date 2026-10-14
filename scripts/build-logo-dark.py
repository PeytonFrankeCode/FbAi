#!/usr/bin/env python3
"""The logo for dark backgrounds (owner, Oct 2026).

logo.png is drawn for a light background: a charcoal calculator, football
and "HUDDLE", with white inside. On the site's dark theme the charcoal all
but disappeared. This keeps the brand green as it is and turns the neutrals
round: charcoal becomes a soft white, and white becomes see-through, so the
page's own dark shows where the white was (the football's laces, the
calculator's screen). Grey edges in between keep their share of each.

    python3 scripts/build-logo-dark.py   # writes public/logo-dark.png and
                                         # public/logo-on-green.png

logo-on-green.png is for the light theme's header, a deep green band: there
the brand green itself disappears, so it is lifted to a pale mint.
"""
import colorsys, os
from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), '..')
LIGHT = (236, 240, 244)    # the soft white the charcoal becomes
DARKEST = 0.20             # the logo's charcoal, as lightness


def build(name, green_lightness=None):
    src = Image.open(os.path.join(ROOT, 'public', 'logo.png')).convert('RGBA')
    out = Image.new('RGBA', src.size)
    px, po = src.load(), out.load()
    for y in range(src.size[1]):
        for x in range(src.size[0]):
            r, g, b, a = px[x, y]
            if a == 0:
                po[x, y] = (0, 0, 0, 0)
                continue
            h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
            if s > 0.25 and l < 0.9:
                # Brand green: kept, a touch brighter for the dark page.
                ll = green_lightness if green_lightness is not None else min(1, l * 1.12)
                rr, gg, bb = colorsys.hls_to_rgb(h, ll, s)
                po[x, y] = (int(rr * 255), int(gg * 255), int(bb * 255), a)
            else:
                # Neutral: the darker it was, the more of the soft white it is.
                k = max(0.0, min(1.0, (1 - l) / (1 - DARKEST)))
                po[x, y] = LIGHT + (int(a * k),)
    out.save(os.path.join(ROOT, 'public', name), optimize=True)


def main():
    build('logo-dark.png')
    build('logo-on-green.png', green_lightness=0.80)


if __name__ == '__main__':
    main()
