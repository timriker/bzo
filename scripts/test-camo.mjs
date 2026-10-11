#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Checks the camo rule in public/camo.mjs against the texture it actually runs
// on. The properties below are the reasons the rule exists, so they are worth
// more than the numbers they currently produce: a tank has to come out in its
// player's colour, the areas an artist left grey have to stay grey on every
// tank, and a rogue has to come out nearly black.

import { readFileSync } from 'fs';
import { inflateSync } from 'zlib';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  CAMO_SOURCE_TEXTURE, camoColor, camoPaintColor, isTeamShade, referenceHue, rgbToHsv, teamShadeColor,
  wrapSignedTurns,
} from '../public/camo.mjs';
import { TANK_SKINS, TANK_SKIN_TEAMS, getTankSkinTexture } from '../public/tank-skins.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = false;
const fail = (message) => { console.error(`FAIL ${message}`); failed = true; };
const ok = (message) => console.log(`ok   ${message}`);
const check = (condition, message) => (condition ? ok(message) : fail(message));

// Enough of the PNG spec for the textures in this repo: 8-bit, non-interlaced,
// RGB or RGBA. The browser does this decode for real; here it only has to be
// right for one file.
function decodePng(buffer) {
  const chunks = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    chunks.push({
      type: buffer.toString('ascii', offset + 4, offset + 8),
      data: buffer.subarray(offset + 8, offset + 8 + length),
    });
    offset += length + 12;
  }
  const header = chunks.find((chunk) => chunk.type === 'IHDR').data;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  if (header[8] !== 8 || header[12] !== 0 || (header[9] !== 2 && header[9] !== 6)) {
    throw new Error(`unsupported PNG: depth ${header[8]} colorType ${header[9]} interlace ${header[12]}`);
  }
  const channels = header[9] === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(
    chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data)));
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray((y * (stride + 1)) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? out[i - channels] : 0;
      const b = prior ? prior[i] : 0;
      const c = (prior && i >= channels) ? prior[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
        value += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (filter !== 0) throw new Error(`unknown row filter ${filter}`);
      out[i] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

// The same palette the renderer builds, by the same steps.
function loadSource(path) {
  const { width, height, channels, pixels } = decodePng(
    readFileSync(resolve(__dirname, '..', 'public', path.replace(/^\//, ''))));
  const byColor = new Map();
  const hue = [];
  const saturation = [];
  const value = [];
  const coverage = [];
  for (let i = 0, texel = 0; texel < width * height; i += channels, texel += 1) {
    const key = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
    let index = byColor.get(key);
    if (index === undefined) {
      index = hue.length;
      byColor.set(key, index);
      const hsv = rgbToHsv(pixels[i] / 255, pixels[i + 1] / 255, pixels[i + 2] / 255);
      hue.push(hsv.h);
      saturation.push(hsv.s);
      value.push(hsv.v);
      coverage.push(0);
    }
    coverage[index] += 1;
  }
  const reference = referenceHue(hue, saturation, coverage);
  return {
    texels: width * height,
    hueOffset: hue.map((h) => wrapSignedTurns(h - reference)),
    saturation,
    value,
    coverage,
  };
}

const source = loadSource(CAMO_SOURCE_TEXTURE);

// What a whole tank averages to, weighted by how much of it each colour covers.
function paint(source_, color, rogue = false) {
  const player = rgbToHsv(color[0] / 255, color[1] / 255, color[2] / 255);
  const entries = source_.hueOffset.map((offset, i) => ({
    rgb: camoColor(offset, source_.saturation[i], source_.value[i], player, rogue),
    coverage: source_.coverage[i] / source_.texels,
  }));
  const mean = [0, 1, 2].map((k) => entries.reduce(
    (sum, entry) => sum + (Object.values(entry.rgb)[k] * entry.coverage), 0));
  return { player, entries, mean, meanHsv: rgbToHsv(...mean) };
}

const PLAYERS = [
  ['red', [255, 0, 0]],
  ['green', [0, 255, 0]],
  ['blue', [26, 51, 255]],
  ['purple', [255, 0, 255]],
  ['yellow', [255, 255, 0]],
  ['teal shade', [0, 180, 180]],
  ['pale red', [255, 150, 150]],
];

const degrees = (turns) => wrapSignedTurns(turns) * 360;

// 1. The tank comes out in the player's colour. This is the whole point of
//    measuring each texel's hue as an offset from the source's average: the
//    offsets cancel, so the average lands back on the hue it was aimed at.
//    Saturation and value cannot land on the player's exactly -- a fully
//    saturated colour is on the edge of the gamut, so only a flat slab averages
//    to it -- but the average has to stay close enough that the tank reads as
//    the colour it was assigned. See CAMO_SATURATION_GAIN.
for (const [name, color] of PLAYERS) {
  const { player, mean, meanHsv } = paint(source, color);
  const drift = Math.abs(degrees(meanHsv.h - player.h));
  const rgb = mean.map((c) => Math.round(c * 255)).join(',');
  check(drift < 8, `${name}: averages to the player's hue (${rgb}, off by ${drift.toFixed(1)} deg)`);
  check(meanHsv.s > player.s * 0.75,
    `${name}: average keeps the colour's strength (saturation ${meanHsv.s.toFixed(2)} of ${player.s.toFixed(2)})`);
  check(meanHsv.v > player.v * 0.6 && meanHsv.v < player.v * 1.05,
    `${name}: average keeps the colour's brightness (value ${meanHsv.v.toFixed(2)} of ${player.v.toFixed(2)})`);
}

// 2. Grey stays grey, and colour moves. The source's own saturation is the mask
//    for how far a texel follows the player, so this is the property that lets
//    one tank hold both a fixed near-neutral patch and a saturated one.
{
  const { entries } = paint(source, [255, 0, 0]);
  const saturations = entries.map((entry) => rgbToHsv(...Object.values(entry.rgb)).s);
  const greyest = Math.min(...saturations);
  const boldest = Math.max(...saturations);
  check(greyest < 0.25, `a near-grey patch stays near grey (saturation ${greyest.toFixed(2)})`);
  check(boldest > 0.7, `a painted patch takes the player's colour (saturation ${boldest.toFixed(2)})`);
  check(boldest - greyest > 0.75, `one tank spans grey to saturated (${(boldest - greyest).toFixed(2)})`);

  // The lit areas give colour back up, so the patches differ along brightness
  // as well as along the artist's own saturation. See CAMO_HIGHLIGHT_WASH.
  const lit = entries.filter((entry) => rgbToHsv(...Object.values(entry.rgb)).v > 0.75);
  const litSaturation = lit.reduce(
    (sum, entry) => sum + (rgbToHsv(...Object.values(entry.rgb)).s * entry.coverage), 0)
    / lit.reduce((sum, entry) => sum + entry.coverage, 0);
  check(litSaturation < boldest * 0.8,
    `the lit areas are less colourised (saturation ${litSaturation.toFixed(2)} against ${boldest.toFixed(2)})`);
}

// 3. Patches sit either side of the player's hue rather than all drifting one
//    way, which is what makes them read as different shades of one colour.
{
  const above = source.hueOffset.filter((offset) => offset > 0.005).length;
  const below = source.hueOffset.filter((offset) => offset < -0.005).length;
  const spread = degrees(Math.max(...source.hueOffset)) - degrees(Math.min(...source.hueOffset));
  check(above > 0 && below > 0, `patches sit above and below the player's hue (${above} up, ${below} down)`);
  check(spread > 25 && spread < 120, `hue spread is visible but still one colour (${spread.toFixed(0)} deg)`);
}

// 4. Brightness is the artist's, not the player's colour's, so the camo's light
//    and dark read the same whoever wears it.
{
  const dark = paint(source, [255, 0, 0]).entries;
  const values = dark.map((entry) => rgbToHsv(...Object.values(entry.rgb)).v);
  check(Math.max(...values) - Math.min(...values) > 0.4,
    `light and dark survive the recolour (value ${Math.min(...values).toFixed(2)}..${Math.max(...values).toFixed(2)})`);
}

// 5. A muted player gets a muted tank: their saturation scales the source's
//    rather than replacing it, so two shades of one team still differ.
{
  const bold = paint(source, [255, 0, 0]).meanHsv.s;
  const pale = paint(source, [255, 150, 150]).meanHsv.s;
  check(pale < bold * 0.75, `a pale player reads pale (${pale.toFixed(2)} against ${bold.toFixed(2)})`);
}

// 6. Rogue. Upstream's rogue_tank.png is painted in plain greys and averages
//    (55,55,55), a luminance of 0.22. That hueless near-black is what a rogue
//    looks like on the field; the team's yellow belongs to the radar and the
//    scoreboard.
{
  const plain = paint(source, [255, 255, 0]);
  const rogue = paint(source, [255, 255, 0], true);
  // `mean` is already 0..1, as camoColor returns.
  const luminance = (mean) => (0.2126 * mean[0]) + (0.7152 * mean[1]) + (0.0722 * mean[2]);
  const rogueLuminance = luminance(rogue.mean);
  check(rogueLuminance < 0.3, `a rogue reads dark (luminance ${rogueLuminance.toFixed(2)}, upstream 0.22)`);
  check(rogueLuminance < luminance(plain.mean) * 0.6, 'a rogue is far darker than the same colour untouched');
  // No hue at all, not a trace of one. Every rogue shade bzo assigns is a
  // yellow, so a rogue carrying any fraction of its colour reads as a yellow
  // tank -- which is the one thing rogue_tank.png is not.
  check(rogue.meanHsv.s < 0.01,
    `a rogue has no hue left, as rogue_tank.png has none (saturation ${rogue.meanHsv.s.toFixed(3)})`);
  const grey = rogue.mean.map((c) => Math.round(c * 255));
  check(Math.max(...grey) - Math.min(...grey) <= 1,
    `a rogue is a plain grey (${grey.join(',')}, upstream 55,55,55)`);
}

// 7. Two players on one team have to look different, which is the whole reason
//    bzo gives each of them a shade of their own instead of painting the team.
//    Their shades differ mostly in saturation and lightness rather than in hue
//    -- the band is deliberately narrow, so that no shade of one team reads as
//    another -- and an earlier version of this lost the saturation half of that
//    by folding the player's own into the stretch, where the gain clamped it
//    away. The colours below are what the server actually handed three players
//    on a team.
{
  const TEAMMATES = {
    red: [0xad0b0b, 0xf45260, 0xff002b],
    blue: [0x7481ec, 0x0c00d2, 0x284ff1],
    purple: [0xff00d4, 0xd400ff, 0xb800a8],
  };
  for (const [team, colors] of Object.entries(TEAMMATES)) {
    const means = colors.map((color) => paint(
      source, [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff]).mean);
    let closest = Infinity;
    for (let i = 0; i < means.length; i += 1) {
      for (let j = i + 1; j < means.length; j += 1) {
        // Plain RGB distance over 0..1, which is crude but is not fooled the
        // way a saturation-only compare was.
        const distance = Math.hypot(...means[i].map((c, k) => c - means[j][k]));
        closest = Math.min(closest, distance);
      }
    }
    check(closest > 0.1,
      `${team} team mates stay apart (closest pair ${closest.toFixed(2)})`);
  }

  // Rogues are the exception, and knowingly. Draining a tank to nearly no
  // colour and a quarter of the brightness takes away the two axes their
  // shades differ along, so three rogues come out looking alike -- upstream
  // has the same property for the same reason, one grey texture for all of
  // them. The scoreboard and the radar still tell them apart in yellow, which
  // is where a rogue is identified. Asserted rather than left implicit so that
  // a change which quietly un-darkens them has to come past this line.
  const rogues = [0xe9d25d, 0xad920b, 0xffea00].map((color) => paint(
    source, [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff], true).mean);
  let closestRogues = Infinity;
  for (let i = 0; i < rogues.length; i += 1) {
    for (let j = i + 1; j < rogues.length; j += 1) {
      closestRogues = Math.min(closestRogues, Math.hypot(...rogues[i].map((c, k) => c - rogues[j][k])));
    }
  }
  check(closestRogues < 0.1,
    `rogues run together the way upstream's do (closest pair ${closestRogues.toFixed(2)})`);
}

// 8. The parts that carry no camo still have to belong to the same tank. The
//    tread caps are painted from the colour directly, which is how a rogue kept
//    yellow treads under a grey body until camoPaintColor put them through the
//    same rule. Anyone else has to come out untouched, to the byte.
{
  let worst = 0;
  for (let r = 0; r < 256; r += 17) {
    for (let g = 0; g < 256; g += 17) {
      for (let b = 0; b < 256; b += 17) {
        const paint = camoPaintColor(rgbToHsv(r / 255, g / 255, b / 255), false);
        worst = Math.max(worst,
          Math.abs((paint.r * 255) - r), Math.abs((paint.g * 255) - g), Math.abs((paint.b * 255) - b));
      }
    }
  }
  check(worst < 0.5, `a flat part keeps its player's colour exactly (worst ${worst.toFixed(3)} of 255)`);

  const cap = camoPaintColor(rgbToHsv(1, 1, 0), true);
  const bytes = [cap.r, cap.g, cap.b].map((c) => Math.round(c * 255));
  check(Math.max(...bytes) - Math.min(...bytes) <= 1 && Math.max(...bytes) < 140,
    `a rogue's flat parts go grey with its body (${bytes.join(',')})`);
}

// 9. A colour with no hue to rotate must not pick one up. Observers are white
//    and the rabbit is grey, and either would look wrong tinted.
{
  const { entries } = paint(source, [204, 204, 204]);
  const boldest = Math.max(...entries.map((entry) => rgbToHsv(...Object.values(entry.rgb)).s));
  check(boldest < 0.02, `a colourless player stays colourless (saturation ${boldest.toFixed(3)})`);
}

// 10. Every skin's file, for every team, is the size its entry says, since the
//     tank's canvas is made that size and filled texel for texel from it.
for (const skin of TANK_SKINS) {
  const sizes = TANK_SKIN_TEAMS.map((team) => {
    const header = readFileSync(resolve(__dirname, '..', 'public', getTankSkinTexture(skin, team).slice(1)));
    return `${header.readUInt32BE(16)}x${header.readUInt32BE(20)}`;
  });
  const wanted = `${skin.size}x${skin.size}`;
  check(sizes.every((size) => size === wanted), `${skin.id} is ${wanted} for every team (${[...new Set(sizes)].join(', ')})`);
}

// 11. A tank at its team's own colour wears the team's file unchanged, and a
//     shade of it is moved by no more than its distance from that colour.
{
  const hsv = (rgb) => rgbToHsv(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
  const red = hsv([255, 0, 0]);
  const texel = { h: 0.02, s: 0.6, v: 0.7 };
  const same = teamShadeColor(texel.h, texel.s, texel.v, red, red);
  const back = rgbToHsv(same.r, same.g, same.b);
  check(Math.abs(back.h - texel.h) < 1e-6 && Math.abs(back.s - texel.s) < 1e-6 && Math.abs(back.v - texel.v) < 1e-6,
    'the team colour leaves its own file as painted');
  const shade = hsv([230, 20, 30]);
  check(isTeamShade(shade, red), 'a shade of red is one of red\'s shades');
  check(!isTeamShade(hsv([0, 200, 255]), red), 'a sky blue is not one of red\'s shades');
  const same3 = (rgb, h, s_, v) => {
    const got = rgbToHsv(rgb.r, rgb.g, rgb.b);
    return Math.abs(got.s - s_) < 1e-6 && Math.abs(got.v - v) < 1e-6 && (s_ === 0 || Math.abs(got.h - h) < 1e-6);
  };
  check(same3(teamShadeColor(0, 0.04, 0.4, shade, red), 0, 0.04, 0.4), 'a grey patch stays as painted on a shade');
  const green = hsv([0, 255, 0]);
  const yellow = { h: 48 / 360, s: 1, v: 0.95 };
  check(same3(teamShadeColor(yellow.h, yellow.s, yellow.v, hsv([20, 200, 40]), green), yellow.h, yellow.s, yellow.v),
    'green\'s yellow patch stays yellow on a shade of green');
  const darker = hsv([200, 0, 0]);
  const bright = teamShadeColor(0, 1, 1, darker, red);
  const dark = teamShadeColor(0, 1, 0.4, darker, red);
  check(Math.abs(rgbToHsv(bright.r, bright.g, bright.b).v - darker.v) < 1e-6
    && Math.abs(rgbToHsv(dark.r, dark.g, dark.b).v - 0.4 * darker.v) < 1e-6,
  'bright red becomes the shade, and dark red the shade darkened as much');
  const rabbit = hsv([204, 204, 204]);
  check(isTeamShade(rabbit, rabbit), 'the rabbit wears its own file');
}

console.log(failed ? '\ncamo: FAILED' : '\ncamo: all checks passed');
process.exit(failed ? 1 : 0);
