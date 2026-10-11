/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// How a tank body's camo is generated from a player's colour. The pixel and
// canvas work lives in render.js; everything here is arithmetic, so the rule
// can be checked against the real texture without a browser -- see
// scripts/test-camo.mjs.

// BZFlag paints one finished camo texture per team and draws it unmodulated --
// TankSceneNode.cxx:1278, "do not use color modulation with tank textures" --
// so the four patches on a tank differ in hue and saturation, not only in
// brightness. purple_tank.png runs from a saturated violet to a near-colourless
// (129,120,138); blue_tank.png sets a deep blue against a cyan highlight and a
// grey-blue shadow. That works upstream because eight teams need eight files.
//
// bzo gives every player a distinct shade of their team's colour. A shade of a
// team wears that team's file, moved by its distance from the team colour
// (teamShadeColor, at the end of this file). A colour off every team's shades --
// a free-for-all's whole wheel -- has no file to paint it, so its body texture
// is generated from the colour instead. Tinting one grey ramp can only ever
// produce a single hue, and the camo reads as one flat colour dimmed and
// brightened.
//
// So a source texture is retargeted in HSV rather than tinted: its hue is
// rotated until its own average lands on the player's, and each texel keeps the
// offset it had from that average. A patch painted above the source hue stays
// above the player's, one painted below stays below, and the two show up as
// different shades on every tank. Saturation rides along unchanged, which makes
// the source's own saturation the mask for how much a texel follows the player
// at all: a strongly coloured patch becomes the player's colour, and one the
// artist left near grey stays near grey on every tank in the game. Value is
// kept as painted, so the camo's light and dark read the same whoever wears it.
export const CAMO_SOURCE_TEXTURE = '/textures/blue_tank.png';
// Of upstream's seven, blue_tank.png is the one whose saturation spans the
// widest range -- a (64,64,80) shadow at 0.20 against a 0.89 body -- so it has
// both the near-grey the rule needs to leave alone and the strong hue the rule
// needs to move. green_tank.png and hunter_tank.png are saturated almost
// everywhere and would leave nothing fixed; purple_tank.png is so grey that
// little would move. Nothing outside this block knows which file it is: any
// painted camo works, and a hand-drawn one can replace it by changing the path.

// Saturation is stretched rather than scaled, along two axes.
//
// Without any of this the average tank is paler than the colour it was
// assigned: blue_tank.png averages a saturation of 0.63, so a player given pure
// red gets a tank averaging (172,68,73) where the flat tint this replaced gave
// (170,0,0). It reads as washed out rather than as that player's red.
//
// It cannot be corrected by a plain multiply. A fully saturated colour sits on
// the edge of the gamut, and the only picture whose average is exactly
// (255,0,0) is one painted (255,0,0) everywhere -- so lifting the average with
// one gain also lifts the areas that were meant to stay colourless, and the
// tank gets more saturated and *less* varied at the same time. Over the source,
// by gain alone:
//
//   gain   mean saturation   greyest texel   span
//   1.0    0.63              0.20            0.72
//   2.2    0.81              0.31            0.69
//   3.2    0.92              0.45            0.55
//
// So the gain is paired with an exponent that pulls the bottom of the range
// down as the gain pushes the top up. Saturation becomes `s ** CONTRAST * GAIN`:
// the exponent costs the near-grey texels far more than the strong ones, and
// the gain then puts the strong ones back at full. The average lands where a
// plain gain of 2.2 put it, with the quiet areas much quieter:
//
//   contrast  gain   mean   greyest texel   span
//   1.0       2.2    0.81   0.31            0.69
//   1.4       2.8    0.80   0.19            0.81
//   1.6       3.2    0.80   0.15            0.85
//   2.0       4.5    0.81   0.11            0.89
//
// 1.6 is where the quiet areas are plainly colourless without the rest of the
// tank being driven so hard that the patches stop differing from each other.
export const CAMO_SATURATION_CONTRAST = 1.6;
export const CAMO_SATURATION_GAIN = 3.2;

// How much of that colour the brightest areas give back up.
//
// Saturation is scaled by `1 - CAMO_HIGHLIGHT_WASH * value`, so a texel keeps
// its colour where the camo is dark and loses it where the camo is lit. That is
// how a lit surface behaves -- the brighter a highlight, the closer it runs to
// white -- and it is the second axis the patches vary along, so two of them at
// the same saturation in the source still come out visibly different. On the
// source it separates the cyan highlight from the body beside it, 0.67 against
// a fully saturated 1.00.
//
// It works against the gain, since the highlight is a fifth of the tank and a
// washed one pulls the average down with it. All three are set together, and
// the average a player is recognised by is what limits how far this can go.
export const CAMO_HIGHLIGHT_WASH = 0.45;

// Brightness, against the flat tint this replaced. The source averages a value
// of 0.77 where the old ramp averaged 0.67, so without this a tank would arrive
// noticeably lighter than the one players are used to.
export const CAMO_VALUE_SCALE = 0.88;

// Rogue. Upstream draws rogues from rogue_tank.png, and that file is painted in
// plain greys -- mean (55,55,55), no saturation anywhere in it, a mean luminance
// of 0.217. A rogue tank upstream has no hue at all, and the team's yellow lives
// only on the radar and the scoreboard (Team.cxx:20), which is where a rogue is
// picked out of a list rather than off the field.
//
// bzo keeps rogue yellow in both of those places for the same reason, and
// brings the tank itself back in line here. Zero, not a trace: a rogue carrying
// any fraction of its assigned colour reads as a yellow tank, because every
// rogue shade bzo hands out is a yellow one. The value scale is what puts the
// result on upstream's own brightness -- a rogue comes out averaging (47,47,47)
// to (66,66,66) against upstream's (55,55,55), depending on how light the shade
// behind it was.
//
// The cost is that rogues stop differing from each other, since a colour with
// no saturation left has only its lightness to differ by. Upstream has that too
// and for the same reason, one grey texture for all of them.
export const ROGUE_CAMO_SATURATION = 0;
export const ROGUE_CAMO_VALUE = 0.38;

// HSV rather than the HSL that THREE.Color offers. The camo rule is "keep the
// value the artist painted and scale the saturation", and in HSL those two are
// not separable: lightness already folds saturation in, so draining a patch
// towards grey drags its lightness with it and the camo's light and dark stop
// matching the source.
export function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const span = max - min;
  let h = 0;
  if (span > 0) {
    if (max === r) h = ((g - b) / span) / 6;
    else if (max === g) h = (2 + ((b - r) / span)) / 6;
    else h = (4 + ((r - g) / span)) / 6;
    if (h < 0) h += 1;
  }
  return { h, s: max > 0 ? span / max : 0, v: max };
}

export function hsvToRgb(h, s, v) {
  const hue = ((h % 1) + 1) % 1;
  const sector = hue * 6;
  const index = Math.floor(sector);
  const fraction = sector - index;
  const p = v * (1 - s);
  const q = v * (1 - (s * fraction));
  const t = v * (1 - (s * (1 - fraction)));
  switch (index % 6) {
    case 0: return { r: v, g: t, b: p };
    case 1: return { r: q, g: v, b: p };
    case 2: return { r: p, g: v, b: t };
    case 3: return { r: p, g: q, b: v };
    case 4: return { r: t, g: p, b: v };
    default: return { r: v, g: p, b: q };
  }
}

// A hue difference as the shorter way round the wheel, in turns: -0.5 to 0.5.
// Without this a patch 20 degrees below the reference would read as 340 above
// and swing right across the wheel instead of sitting just under the player.
export function wrapSignedTurns(turns) {
  return (((turns + 0.5) % 1) + 1) % 1 - 0.5;
}

// The hue a source texture's offsets are measured from: the average of its own
// hues, weighted by saturation. A grey texel has no hue worth averaging in, and
// letting it vote would drag the reference towards whatever rounding left
// behind in it. Averaged as vectors on the colour wheel rather than as numbers,
// since hues wrap and a plain mean of 350 and 10 degrees is 180 -- the opposite
// colour.
export function referenceHue(hues, saturations, weights) {
  let x = 0;
  let y = 0;
  for (let i = 0; i < hues.length; i += 1) {
    const weight = (weights ? weights[i] : 1) * saturations[i];
    const angle = hues[i] * Math.PI * 2;
    x += Math.cos(angle) * weight;
    y += Math.sin(angle) * weight;
  }
  // A source with no colour in it at all has no reference to find, and every
  // offset from it is zero anyway.
  if (x === 0 && y === 0) return 0;
  return Math.atan2(y, x) / (Math.PI * 2);
}

// The colour a tank's flat-painted parts take -- the tread caps, which carry no
// camo but still have to belong to the same tank. The body reaches the rogue
// treatment through camoColor, once per texel; a flat part has no texel to vary
// and takes the player's colour with the same treatment and nothing else. For
// anyone but a rogue this is the player's colour unchanged.
//
// This is why a rogue's treads were still yellow when its body had gone grey:
// the caps are painted from the colour directly and never went through the camo
// at all.
export function camoPaintColor(player, rogue = false) {
  return hsvToRgb(
    player.h,
    player.s * (rogue ? ROGUE_CAMO_SATURATION : 1),
    player.v * (rogue ? ROGUE_CAMO_VALUE : 1),
  );
}

// The player's colour applied to one source entry: their hue plus the offset
// this entry was painted at, the source's own saturation scaled by theirs, and
// the source's own value. `rogue` drains and darkens the result -- see
// ROGUE_CAMO_SATURATION above.
export function camoColor(hueOffset, saturation, value, player, rogue = false) {
  return hsvToRgb(
    player.h + hueOffset,
    // The player's own saturation scales the finished pattern rather than
    // joining the stretch inside it. Inside, the gain swallows it: it drives
    // most of the tank into the clamp, and a player given a muted shade of
    // their team comes out pinned at full alongside a team mate given a vivid
    // one -- the scoreboard tells the two apart and the tanks do not, which
    // loses the distinction bzo gives every player a colour of their own to
    // make. Outside, the shade is a ceiling the whole tank sits under, so it
    // survives whole. It changes nothing for a fully saturated colour, where
    // the two are the same arithmetic.
    player.s * (rogue ? ROGUE_CAMO_SATURATION : 1)
      * Math.min(1, (saturation ** CAMO_SATURATION_CONTRAST) * CAMO_SATURATION_GAIN
        * (1 - (CAMO_HIGHLIGHT_WASH * value))),
    Math.min(1, value * player.v * CAMO_VALUE_SCALE * (rogue ? ROGUE_CAMO_VALUE : 1)),
  );
}

// A team's own skin file is upstream's painting for that team (`<team>_tank*.png`)
// and wants moving only as far as a player's shade is from the team colour:
// at the team colour itself it is upstream's file texel for texel. How far a
// shade may sit from its team's hue and still count as one of its shades is
// the server's band (`TEAM_SHADE_HUE_SPREAD`, server/teams.cjs) with room for
// the trip through RGB.
export const TEAM_FILE_HUE_REACH = 20 / 360;
// Below this the team colour has no hue to measure a shade from: the rabbit's
// grey, which every rabbit wears exactly.
const TEAM_FILE_MIN_SATURATION = 0.15;

export function isTeamShade(player, team) {
  if (team.s < TEAM_FILE_MIN_SATURATION) return true;
  return Math.abs(wrapSignedTurns(player.h - team.h)) <= TEAM_FILE_HUE_REACH;
}

// How much of an entry is the team's colour, from 0 to 1: its hue within
// TEAM_HUE_FULL of the team's counts whole and fades out by TEAM_HUE_NONE, and
// its saturation fades in between TEAM_SATURATION_NONE and TEAM_SATURATION_FULL.
// A grey patch, or one painted in another colour -- the yellow in green's camo,
// the beige in red's -- is not the team's, and stays as painted.
const TEAM_HUE_FULL = 25 / 360;
const TEAM_HUE_NONE = 50 / 360;
const TEAM_SATURATION_NONE = 0.1;
const TEAM_SATURATION_FULL = 0.35;

const ramp = (x, from, to) => Math.max(0, Math.min(1, (x - from) / (to - from)));

export function teamColorWeight(hue, saturation, team) {
  const away = Math.abs(wrapSignedTurns(hue - team.h));
  return (1 - ramp(away, TEAM_HUE_FULL, TEAM_HUE_NONE))
    * ramp(saturation, TEAM_SATURATION_NONE, TEAM_SATURATION_FULL);
}

// One entry of a team's file moved by the player's distance from the team
// colour, as far as the entry is the team's colour: the hue turned by the
// difference, saturation and value scaled by the ratio, so the team's bright
// and dark become the player's bright and dark and everything else is left.
export function teamShadeColor(hue, saturation, value, player, team) {
  const weight = team.s < TEAM_FILE_MIN_SATURATION ? 0 : teamColorWeight(hue, saturation, team);
  const toward = (ratio) => 1 + ((ratio - 1) * weight);
  return hsvToRgb(
    hue + (wrapSignedTurns(player.h - team.h) * weight),
    Math.min(1, saturation * toward(player.s / team.s)),
    team.v > 0 ? Math.min(1, value * toward(player.v / team.v)) : value,
  );
}
