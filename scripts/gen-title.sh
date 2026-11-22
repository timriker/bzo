#!/bin/sh
# Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
# Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
# Source: https://github.com/timriker/bzo
# See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
#
# Makes bzo's `title` texture, public/textures/title.png, from
# src/empty-title.png, a night field with tanks and no lettering: a 4:1 band
# of it down to the foot of the grass, framed as upstream's title is, and
# lettered Battlezone Online. The client stamps the address it was reached at
# on the lower left and its version on the lower right when it loads the image
# (`stampTitle`, public/js/texture.js); upstream bakes in bzflag.org, and edits
# a "Version Number" layer in misc/art/title.psd and exports its picture again
# every release.
#
#   sh scripts/gen-title.sh
#
# Needs ImageMagick 6 (`convert`) and the DejaVu Serif Condensed Bold font.

set -e
cd "$(dirname "$0")/.."
src=src/empty-title.png
out=public/textures/title.png
font=DejaVu-Serif-Condensed-Bold
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# The band from the sky to the foot of the grass (y 686 of 725), at 4:1.
convert "$src" -crop x542+0+144 +repage -filter Lanczos -resize 512x128! "$tmp/scene.png"

# Upstream's panel: transparent rounded corners, a dark rim, a faint light edge.
convert -size 512x128 xc:black -fill white -draw "roundrectangle 3,3 508,124 10,10" \
  -blur 0x0.6 "$tmp/panel.png"
convert "$tmp/scene.png" "$tmp/panel.png" -alpha off -compose CopyOpacity -composite \
  -fill none -stroke '#000' -strokewidth 3 -draw "roundrectangle 4,4 507,123 9,9" \
  -stroke '#9a9a9a' -strokewidth 1 -draw "roundrectangle 3,3 508,124 10,10" \
  "$tmp/framed.png"

# Brushed metal lettering with a dark rim and a drop shadow.
convert -size 512x128 xc:gray70 -seed 7 +noise Gaussian -colorspace gray \
  -motion-blur 0x24+0 -motion-blur 0x24+180 \
  \( -size 512x128 gradient:white-gray45 \) -compose multiply -composite -level 0%,80% \
  "$tmp/metal.png"
convert -size 512x128 xc:black -fill white -font "$font" \
  -pointsize 46 -gravity north -annotate +0+8 "Battlezone Online" "$tmp/text.png"
convert "$tmp/metal.png" "$tmp/text.png" -alpha off -compose CopyOpacity -composite \
  "$tmp/letters.png"
convert "$tmp/text.png" -morphology EdgeOut Disk:1.5 -blur 0x0.5 "$tmp/rim.png"
convert "$tmp/text.png" -blur 0x3 "$tmp/shadow.png"

convert "$tmp/framed.png" \
  \( -size 512x128 xc:black "$tmp/shadow.png" -alpha off -compose CopyOpacity -composite \
     -channel A -evaluate multiply 0.85 +channel \) -geometry +3+3 -compose over -composite \
  \( -size 512x128 xc:'#0c0c0c' "$tmp/rim.png" -alpha off -compose CopyOpacity -composite \) \
  -compose over -composite \
  "$tmp/letters.png" -compose over -composite \
  -strip "$out"
echo "wrote $out"
