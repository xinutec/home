#!/usr/bin/env nix-shell
#!nix-shell -i bash -p librsvg imagemagick python3 python3Packages.pillow
# Render public/'s PNG and ICO icons from public/icon.svg and
# public/icon-maskable.svg. The outputs are tracked: commit them too.
set -euo pipefail
cd "$(dirname "$0")/public"

render() { rsvg-convert -w "$2" -h "$2" "$1" -o "$3"; }

# Browser tab favicon: multi-size .ico from the rounded source.
render icon.svg 16  /tmp/fav-16.png
render icon.svg 32  /tmp/fav-32.png
render icon.svg 48  /tmp/fav-48.png
magick /tmp/fav-16.png /tmp/fav-32.png /tmp/fav-48.png favicon.ico
rm -f /tmp/fav-16.png /tmp/fav-32.png /tmp/fav-48.png

# iOS home-screen + PWA manifest icons.
render icon.svg          180 apple-touch-icon.png
render icon.svg          192 icon-192.png
render icon.svg          512 icon-512.png
render icon-maskable.svg 512 icon-512-maskable.png

# A launcher may crop a maskable icon to the centred circle of 80% diameter,
# which the square PNG does not show. Check the rendered pixels, since the
# stroke's outer edge is what gets cut.
python3 - <<'PY'
import math, sys
from PIL import Image

SAFE = 512 * 0.8 / 2  # 204.8
im = Image.open("icon-512-maskable.png").convert("RGB")
c = (im.size[0] - 1) / 2
bg = im.getpixel((2, 2))  # full-bleed field colour
worst, at = 0.0, None
for y in range(im.size[1]):
    for x in range(im.size[0]):
        if sum(abs(a - b) for a, b in zip(im.getpixel((x, y)), bg)) > 90:
            d = math.hypot(x - c, y - c)
            if d > worst:
                worst, at = d, (x, y)
if worst > SAFE:
    sys.exit(
        f"icon-512-maskable.png: artwork reaches r={worst:.1f} at {at}, past the "
        f"{SAFE:.1f} safe zone — a round launcher mask would clip it. "
        f"Shrink the artwork in public/icon-maskable.svg."
    )
print(f"maskable safe zone ok: artwork reaches r={worst:.1f} of {SAFE:.1f}")
PY

echo "generated: favicon.ico apple-touch-icon.png icon-192.png icon-512.png icon-512-maskable.png"
