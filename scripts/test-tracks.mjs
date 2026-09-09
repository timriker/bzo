/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

import assert from 'node:assert/strict';
import {
  TRACK_FADE_TIME,
  TRACK_HEIGHT_OFFSET,
  TRACK_MARK_LENGTH_FRACTION,
  TRACK_MIN_SPEED,
  TRACK_SURFACE_TOLERANCE,
  TRACK_TREAD_BOTH,
  TRACK_TREAD_LEFT,
  TRACK_TREAD_RIGHT,
  TRACK_UPDATE_TIME,
  TREAD_MIDDLE,
  getTrackMarkAlpha,
  getTrackMarkPlacement,
  getTrackMarkSides,
} from '../public/tracks.mjs';
import { TANK_HALF_LENGTH } from '../public/collision.mjs';

const near = (actual, expected, message) => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
};

const tank = (over = {}) => ({
  x: 0, y: 0, z: 0, rotation: 0, speed: 10, scaleLength: 1, scaleWidth: 1, ...over,
});

// The constants are upstream's, and the trail's density and length come out of
// them: 20 marks a second for 3 seconds.
assert.equal(TRACK_UPDATE_TIME, 1 / 20);
assert.equal(TRACK_FADE_TIME, 3.0);
near(TRACK_MARK_LENGTH_FRACTION, 0.8, 'flat of the tread ends at 0.8 of the half length');

// A tank at rest leaves nothing, and the threshold is a slop rather than a real
// speed: it is in world units, not in the fraction of tank speed the client
// carries.
assert.equal(getTrackMarkPlacement(tank({ speed: 0 })), null);
assert.equal(getTrackMarkPlacement(tank({ speed: TRACK_MIN_SPEED })), null);
assert.equal(getTrackMarkPlacement(tank({ speed: -TRACK_MIN_SPEED })), null);
assert.ok(getTrackMarkPlacement(tank({ speed: TRACK_MIN_SPEED + 1e-6 })));

// Driving forward lays the mark at the back of the treads and reversing lays it
// at the front, which is the end of the tread coming down on fresh ground.
// bzo's heading 0 faces -Z, so forward is -Z and behind is +Z.
const forward = getTrackMarkPlacement(tank({ speed: 10 }));
const reverse = getTrackMarkPlacement(tank({ speed: -10 }));
near(forward.x, 0, 'a mark laid dead ahead does not wander sideways');
near(forward.z, TANK_HALF_LENGTH * 0.8, 'forward leaves the mark behind the tank');
near(reverse.z, -TANK_HALF_LENGTH * 0.8, 'reverse leaves the mark in front of it');

// A quarter turn left points the tank at -X, so the mark goes to +X.
const turned = getTrackMarkPlacement(tank({ rotation: Math.PI / 2, speed: 10 }));
near(turned.x, TANK_HALF_LENGTH * 0.8, 'the mark follows the heading');
near(turned.z, 0, 'and nothing is left on the old axis');

// The tank's own scale reaches both the offset back to the treads and the width
// the drawn mark is placed at, as `dimensions[0]` and `glScalef` do upstream.
const tiny = getTrackMarkPlacement(tank({ speed: 10, scaleLength: 0.4, scaleWidth: 0.4 }));
near(tiny.z, TANK_HALF_LENGTH * 0.8 * 0.4, 'a short tank lays its mark closer in');
near(tiny.scale, 0.4, 'the width scale rides along for the renderer');

// `N` Narrow has no width to press into the ground, and `BU` Burrow is under it.
assert.equal(getTrackMarkPlacement(tank({ speed: 10, scaleWidth: 0 })), null);
assert.equal(getTrackMarkPlacement(tank({ speed: 10, y: -1.32 })), null);

// Every mark floats clear of the surface it was left on, and a tank settling the
// last hair onto the floor still lays a mark coplanar with the rest of its trail.
near(forward.y, TRACK_HEIGHT_OFFSET, 'a ground mark sits at the offset');
assert.equal(forward.onGround, true);
const settling = getTrackMarkPlacement(tank({ speed: 10, y: TRACK_SURFACE_TOLERANCE / 2 }));
near(settling.y, TRACK_HEIGHT_OFFSET, 'and so does one from a tank not quite down');
assert.equal(settling.onGround, true);
const roof = getTrackMarkPlacement(tank({ speed: 10, y: 4 }));
near(roof.y, 4 + TRACK_HEIGHT_OFFSET, 'a roof mark sits the same distance over the roof');
assert.equal(roof.onGround, false, 'and has to be culled against that roof');

// The ground is under every point of the map, so a ground mark is never culled
// and the caller is never asked about one.
assert.equal(getTrackMarkSides(forward, () => {
  throw new Error('a ground mark must not be culled');
}), TRACK_TREAD_BOTH);

// On a roof each tread is asked for separately, at the middle of that tread.
// Heading 0 faces -Z, so the left tread is at -X.
const asked = [];
const sides = getTrackMarkSides(roof, (x, y, z) => {
  asked.push({ x, y, z });
  return x < 0;
});
assert.equal(sides, TRACK_TREAD_LEFT, 'only the tread with roof under it leaves a mark');
assert.equal(asked.length, 2);
near(asked[0].x, -TREAD_MIDDLE, 'the left tread is asked about first');
near(asked[0].y, 4, 'and asked at the roof, not at the lifted mark');
near(asked[1].x, +TREAD_MIDDLE, 'the right tread is the other side of the tank');
assert.equal(getTrackMarkSides(roof, (x) => x > 0), TRACK_TREAD_RIGHT);
assert.equal(getTrackMarkSides(roof, () => false), 0, 'a mark over nothing is not laid');
assert.equal(getTrackMarkSides(roof, () => true), TRACK_TREAD_BOTH);

// A mark laid on a roof turned a quarter left has its treads on the Z axis.
const turnedRoof = getTrackMarkPlacement(tank({ rotation: Math.PI / 2, speed: 10, y: 4 }));
const turnedAsked = [];
getTrackMarkSides(turnedRoof, (x, y, z) => {
  turnedAsked.push({ x, y, z });
  return true;
});
near(turnedAsked[0].z - turnedRoof.z, TREAD_MIDDLE, 'the treads turn with the tank');
near(turnedAsked[0].x - turnedRoof.x, 0, 'and leave the axis they were on');

// The fade is linear from opaque to gone over the whole of `_trackFade`.
near(getTrackMarkAlpha(0), 1, 'a fresh mark is opaque');
near(getTrackMarkAlpha(TRACK_FADE_TIME / 2), 0.5, 'half way through it is half gone');
assert.ok(getTrackMarkAlpha(TRACK_FADE_TIME) <= 0, 'and at the end there is nothing left');

console.log('tracks: ok');
