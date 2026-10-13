#!/usr/bin/env python3
"""iPhone launch screens for the home-screen app (owner, Oct 2026).

iOS shows a white screen while an installed web app starts unless the page
names a startup image for the exact screen it is on. Android draws its own
from manifest.json (icon on background_color), so only iOS needs these.

Each image is the app icon's tile, centred on the app's background. The
in-page splash (index.html #app-splash) starts in exactly the same place
and adds the name and a loading bar, so the hand-off is seamless.

    python3 scripts/build-splash.py      # writes public/splash/*.png

Prints the <link> tags for index.html.
"""
import os
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.join(os.path.dirname(__file__), '..')
OUT = os.path.join(ROOT, 'public', 'splash')
BG = (12, 14, 20)          # manifest background_color #0c0e14
GLOW = (94, 206, 153)      # --accent #5ece99
TILE = 0.30                # tile width, share of the screen width
CENTRE = 0.42              # tile centre, share of the screen height
# (css width, css height, pixel ratio): the iPhones in use, portrait.
SCREENS = [
    (440, 956, 3),  # 16 Pro Max
    (402, 874, 3),  # 16 Pro
    (430, 932, 3),  # 14 Pro Max, 15 Plus/Pro Max, 16 Plus
    (393, 852, 3),  # 14 Pro, 15, 15 Pro, 16
    (428, 926, 3),  # 12/13 Pro Max, 14 Plus
    (390, 844, 3),  # 12, 13, 14, 12/13 Pro
    (375, 812, 3),  # X, XS, 11 Pro, 12/13 mini
    (414, 896, 3),  # XS Max, 11 Pro Max
    (414, 896, 2),  # XR, 11
    (375, 667, 2),  # SE 2/3, 6/7/8
]


def tile(size):
    icon = Image.open(os.path.join(ROOT, 'public', 'icon-512.png')).convert('RGBA').resize((size, size), Image.LANCZOS)
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=int(size * 0.225), fill=255)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(icon, (0, 0), mask)
    return out


def screen(w, h):
    img = Image.new('RGB', (w, h), BG)
    s = int(round(w * TILE))
    x, y = (w - s) // 2, int(round(h * CENTRE - s / 2))
    # A soft green glow behind the tile.
    glow = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    pad = int(s * 0.18)
    ImageDraw.Draw(glow).rounded_rectangle((x - pad, y - pad, x + s + pad, y + s + pad), radius=int(s * 0.4), fill=GLOW + (70,))
    glow = glow.filter(ImageFilter.GaussianBlur(s * 0.22))
    img.paste(glow, (0, 0), glow)
    t = tile(s)
    img.paste(t, (x, y), t)
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    for cw, ch, r in SCREENS:
        w, h = cw * r, ch * r
        name = f'launch-{w}x{h}.png'
        screen(w, h).save(os.path.join(OUT, name), optimize=True)
        print(f'  <link rel="apple-touch-startup-image" href="/splash/{name}" media="(device-width: {cw}px) and (device-height: {ch}px) and (-webkit-device-pixel-ratio: {r}) and (orientation: portrait)" />')


if __name__ == '__main__':
    main()
