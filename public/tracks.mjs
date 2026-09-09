/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Tank track marks: where a tread leaves a mark and how long it lasts. Ported
// from BZFlag's `TrackMarks.cxx` and the `Player::updateTrackMarks`
// (`Player.cxx:458`) that feeds it, in bzo's coordinates -- the ground plane is
// (x, z) and up is y, where upstream has (pos[0], pos[1]) and pos[2].
//
// Only the treads are here. Upstream has three track types and bzo can draw one
// of them: `PuddleTrack` needs `_mirror` set to something other than "none"
// (`addMark`, `TrackMarks.cxx:322`) and bzo draws no reflections, and
// `SmokeTrack` has no producer anywhere in the upstream tree -- its texture is a
// FIXME (`TrackMarks.cxx:207`) and nothing ever asks for one.
//
// Upstream offers `userTrackFade` and `trackMarkCulling` in its Effects menu.
// Neither is here, per the project rule of shipping upstream's default variant
// and no setting: the fade runs at the full `_trackFade` and the air culling is
// upstream's default `FullAirCull`.

import { TANK_HALF_LENGTH } from './collision.mjs';

// `TrackMarks::updateTime`. A mark every twentieth of a second, whatever the
// frame rate, so a trail is the same density on every client.
export const TRACK_UPDATE_TIME = 1 / 20;

// `_trackFade` (`global.cxx:171`), a Locked BZDB value, so this is the whole of
// how long a mark lasts.
export const TRACK_FADE_TIME = 3.0;

// The tread geometry, all four from `TrackMarks.cxx:196`. `TreadOutside` is half
// the tank's width, so a mark sits under the outer edge of its tread; the strip
// between it and `TreadInside` is what the tread actually presses into.
export const TREAD_OUTSIDE = 1.4;
export const TREAD_INSIDE = 0.875;
export const TREAD_MIDDLE = 0.5 * (TREAD_OUTSIDE + TREAD_INSIDE);
export const TREAD_MARK_WIDTH = 0.2;

// `TextureHeightOffset`. Every mark floats this far above the surface it was
// left on, which is what keeps it out of a depth fight with that surface.
export const TRACK_HEIGHT_OFFSET = 0.05;

// `Player::updateTrackMarks`'s `minSpeed`, in world units per second: below it
// the tank counts as standing still and leaves nothing.
export const TRACK_MIN_SPEED = 0.1;

// A tank scaled below this leaves no marks at all -- `addMark`'s `scale < 0.01f`
// test, which is how `N` Narrow drives without a trail.
export const TRACK_MIN_SCALE = 0.01;

// How far back along the tank the mark is laid. Upstream's own FIXME says these
// two belong to `TankGeometryMgr`: the model is six units long and its tread
// wraps 1.2 units of that at each end, so the flat of the tread ends at 0.8 of
// the half length.
const TRACK_MODEL_LENGTH = 6.0;
const TRACK_MODEL_TREAD_HEIGHT = 1.2;
export const TRACK_MARK_LENGTH_FRACTION =
  (TRACK_MODEL_LENGTH - TRACK_MODEL_TREAD_HEIGHT) / TRACK_MODEL_LENGTH;

// `TrackSides`. Which of the two treads left a mark this time: on the ground
// always both, on a roof only the ones with roof under them.
export const TRACK_TREAD_LEFT = 1 << 0;
export const TRACK_TREAD_RIGHT = 1 << 1;
export const TRACK_TREAD_BOTH = TRACK_TREAD_LEFT | TRACK_TREAD_RIGHT;

// How close to a surface a mark has to be to count as resting on it. Upstream's
// `onBuilding` compares the mark's height against the obstacle's top with the
// same 0.1 kludge the rest of its geometry uses.
export const TRACK_SURFACE_TOLERANCE = 0.1;

// Where the next mark goes, or null for a tank that leaves none. Upstream splits
// this between `Player::updateTrackMarks`, which picks the spot, and
// `TrackMarks::addMark`, which decides whether there is a mark to put there;
// with the puddles gone the second half is three refusals and they read better
// beside the first.
//
// `speed` is along the tank's own heading in world units per second, upstream's
// `relativeSpeed`, so its sign is what puts the mark behind a tank driving
// forward and in front of one reversing -- the end of the tread that is coming
// down onto fresh ground either way.
//
// The returned `y` is already lifted by `TRACK_HEIGHT_OFFSET`. `onGround` says
// which of upstream's two lists the mark belongs to, and so whether it has to be
// culled: the world floor is under every point of the map and needs no test.
export function getTrackMarkPlacement({
  x, y, z, rotation, speed, scaleLength, scaleWidth,
}) {
  // `N` Narrow, and `BU` Burrow: a tank below the floor is under the ground its
  // treads would mark.
  if (!(scaleWidth >= TRACK_MIN_SCALE)) return null;
  if (y < 0) return null;

  let direction;
  if (speed > TRACK_MIN_SPEED) direction = -1;
  else if (speed < -TRACK_MIN_SPEED) direction = 1;
  else return null;

  const distance = direction * TANK_HALF_LENGTH * scaleLength * TRACK_MARK_LENGTH_FRACTION;
  const onGround = Math.abs(y) <= TRACK_SURFACE_TOLERANCE;
  // A tank settling onto the floor sits a hair above zero for a frame or two,
  // and every mark of a trail on the flat should be coplanar with the rest of
  // it, so the floor's marks are laid at the floor rather than where the tank
  // happened to be.
  const surfaceY = onGround ? 0 : y;

  return {
    x: x + (-Math.sin(rotation) * distance),
    y: surfaceY + TRACK_HEIGHT_OFFSET,
    z: z + (-Math.cos(rotation) * distance),
    surfaceY,
    angle: rotation,
    scale: scaleWidth,
    onGround,
  };
}

// `addMark`'s initial air cull (`InitAirCull`), which is the half of upstream's
// culling that bzo can have: the other half re-tests a mark every frame because
// a physics driver may have carried it off the roof it was left on, and bzo has
// no physics drivers to carry one anywhere.
//
// `isSupported(x, y, z)` is the caller's own `onBuilding` -- it owns the
// obstacle list -- and is asked once per tread, at the middle of that tread.
// Upstream measures the offset at `TreadMiddle` without the tank's width scale,
// where the drawn mark carries it; this asks where upstream asks.
export function getTrackMarkSides(mark, isSupported) {
  if (mark.onGround) return TRACK_TREAD_BOTH;

  const offsetX = -Math.cos(mark.angle) * TREAD_MIDDLE;
  const offsetZ = Math.sin(mark.angle) * TREAD_MIDDLE;

  let sides = 0;
  if (isSupported(mark.x + offsetX, mark.surfaceY, mark.z + offsetZ)) sides |= TRACK_TREAD_LEFT;
  if (isSupported(mark.x - offsetX, mark.surfaceY, mark.z - offsetZ)) sides |= TRACK_TREAD_RIGHT;
  return sides;
}

// `drawTreads`: a mark starts opaque and is gone at `TrackFadeTime`.
export function getTrackMarkAlpha(age) {
  return 1 - (age / TRACK_FADE_TIME);
}
