/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

import assert from 'node:assert/strict';
import {
  ROAM_VIEW,
  ROAM_VIEW_ORDER,
  advanceRoamSelection,
  nextRoamView,
  roamViewNeedsTarget,
  ROAM_TRANSLATE_SPEED_FACTOR,
  ROAM_ZOOM_DEFAULT,
  ROAM_ZOOM_MAX,
  ROAM_ZOOM_MIN,
  createRoamCamera,
  getRoamForward,
  updateRoamCamera,
} from '../public/roam.mjs';

const TANK_SPEED = 25;
const FLOOR_Y = 1.57;
const limits = { tankSpeed: TANK_SPEED, floorY: FLOOR_Y };
const near = (actual, expected, message) => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
};
const idle = { forward: 0, turn: 0, up: false, down: false };

// The camera rests at tank eye height, as wide as the play view.
const start = createRoamCamera(FLOOR_Y);
assert.equal(start.y, FLOOR_Y);
assert.equal(start.zoom, ROAM_ZOOM_DEFAULT);
assert.equal(start.phi, undefined, 'there is no pitch axis to carry');

// bzo's heading: theta 0 faces -Z, and a positive theta turns left, toward -X.
near(getRoamForward(0).x, 0, 'forward x at theta 0');
near(getRoamForward(0).z, -1, 'forward z at theta 0');
near(getRoamForward(Math.PI / 2).x, -1, 'forward x at theta 90');
near(getRoamForward(Math.PI / 2).z, 0, 'forward z at theta 90');

// Roaming.cxx:6776 -- four times tank speed, so a full second at full stick
// covers 100 units, and it goes where the camera is pointing.
const ahead = updateRoamCamera(start, { ...idle, forward: 1 }, 1, limits);
near(ahead.z, FLOOR_Y * 0 + start.z - ROAM_TRANSLATE_SPEED_FACTOR * TANK_SPEED, 'forward travel');
near(ahead.x, 0, 'forward travel stays on the heading');
assert.equal(ahead.y, FLOOR_Y, 'translating does not change height');

// Reverse is not capped here: upstream inherits the tank's half-speed reverse by
// accident, and a camera that backs up at half speed is only annoying.
const back = updateRoamCamera(start, { ...idle, forward: -1 }, 1, limits);
near(back.z, ROAM_TRANSLATE_SPEED_FACTOR * TANK_SPEED, 'reverse travel is symmetric');

// Roaming.cxx:6779 -- `zoom` degrees per second, so the default turns 60 deg/s.
const turned = updateRoamCamera(start, { ...idle, turn: 1 }, 1, limits);
near(turned.theta, (ROAM_ZOOM_DEFAULT * Math.PI) / 180, 'yaw rate tracks zoom');
const turnedHalf = updateRoamCamera(start, { ...idle, turn: 0.5 }, 1, limits);
near(turnedHalf.theta, (ROAM_ZOOM_DEFAULT * Math.PI) / 360, 'yaw is proportional');

// A narrower view turns more slowly, which is the relation upstream ships.
const zoomed = updateRoamCamera({ ...start, zoom: 30 }, { ...idle, turn: 1 }, 1, limits);
near(zoomed.theta, (30 * Math.PI) / 180, 'yaw slows as the view narrows');

// Altitude climbs at tank speed, not upstream's four times, because it is on a
// button rather than an axis.
const up = updateRoamCamera(start, { ...idle, up: true }, 1, limits);
near(up.y, FLOOR_Y + TANK_SPEED, 'climb rate');

// The floor is upstream's muzzle height: an observer never goes underground.
const down = updateRoamCamera(start, { ...idle, down: true }, 1, limits);
assert.equal(down.y, FLOOR_Y, 'the floor holds');
const highUp = updateRoamCamera({ ...start, y: FLOOR_Y + 10 }, { ...idle, down: true }, 1, limits);
near(highUp.y, FLOOR_Y, 'descending stops at the floor');

// Holding both cancels, as two opposed buttons should.
const both = updateRoamCamera({ ...start, y: FLOOR_Y + 10 }, { ...idle, up: true, down: true }, 1, limits);
near(both.y, FLOOR_Y + 10, 'up and down cancel');

// Climbing changes height and nothing else: the view stays level, as a driving
// tank's does, so the look point rises with the camera rather than tilting down.
assert.equal(up.theta, start.theta, 'climbing does not turn the view');
assert.equal(up.x, start.x, 'climbing does not drift');
assert.equal(up.z, start.z, 'climbing does not drift');

// Zoom is held inside upstream's range even though nothing binds it yet.
assert.equal(updateRoamCamera({ ...start, zoom: 5 }, idle, 1, limits).zoom, ROAM_ZOOM_MIN);
assert.equal(updateRoamCamera({ ...start, zoom: 999 }, idle, 1, limits).zoom, ROAM_ZOOM_MAX);

// A frame that advances no time moves nothing, and garbage input is inert.
const stalled = updateRoamCamera(start, { forward: 1, turn: 1, up: true }, 0, limits);
assert.deepEqual(stalled, start);
const garbage = updateRoamCamera(start, { forward: NaN, turn: undefined }, 1, limits);
assert.deepEqual(garbage, start);

// Integrating in steps matches one big step along a straight line, so the camera
// does not depend on frame rate while driving forward.
let stepwise = createRoamCamera(FLOOR_Y);
for (let i = 0; i < 100; i++) {
  stepwise = updateRoamCamera(stepwise, { ...idle, forward: 1 }, 0.01, limits);
}
near(stepwise.z, -ROAM_TRANSLATE_SPEED_FACTOR * TANK_SPEED, 'stepwise travel matches one step');

// Roaming.h:36 -- the cycle order, with the flag view dropped where there are no
// team flags to track.
assert.deepEqual(ROAM_VIEW_ORDER, ['free', 'track', 'follow', 'fps', 'flag']);
assert.equal(nextRoamView(ROAM_VIEW.FREE), ROAM_VIEW.TRACK);
assert.equal(nextRoamView(ROAM_VIEW.FPS), ROAM_VIEW.FLAG);
assert.equal(nextRoamView(ROAM_VIEW.FLAG), ROAM_VIEW.FREE, 'the cycle wraps');
assert.equal(nextRoamView(ROAM_VIEW.FPS, { allowFlag: false }), ROAM_VIEW.FREE);
assert.equal(nextRoamView(ROAM_VIEW.FLAG, { allowFlag: false }), ROAM_VIEW.FREE);

assert.equal(roamViewNeedsTarget(ROAM_VIEW.TRACK), true);
assert.equal(roamViewNeedsTarget(ROAM_VIEW.FOLLOW), true);
assert.equal(roamViewNeedsTarget(ROAM_VIEW.FPS), true);
assert.equal(roamViewNeedsTarget(ROAM_VIEW.FREE), false);
assert.equal(roamViewNeedsTarget(ROAM_VIEW.FLAG), false);

// Fire walks one sequence: within a view that takes a subject, the leader first
// (the auto slot, null), then every player, then on to the next view.
const players = ['p1', 'p2', 'p3'];
const walk = (start, steps, opts) => {
  const seen = [];
  let state = start;
  for (let i = 0; i < steps; i++) {
    state = advanceRoamSelection(state, opts);
    seen.push(`${state.view}:${state.targetId === null ? 'leader' : state.targetId}`);
  }
  return seen;
};

assert.deepEqual(
  walk({ view: ROAM_VIEW.FREE, targetId: null, flagIndex: null }, 6, { playerIds: players, allowFlag: false }),
  [
    'track:leader',
    'track:p1',
    'track:p2',
    'track:p3',
    'follow:leader',
    'follow:p1',
  ],
);

// With nobody to watch, a target view has only its leader slot, so fire keeps
// moving through the views rather than sticking.
assert.deepEqual(
  walk({ view: ROAM_VIEW.FREE, targetId: null, flagIndex: null }, 4, { playerIds: [], allowFlag: false }),
  ['track:leader', 'follow:leader', 'fps:leader', 'free:leader'],
);

// A target that has left the list is not found in it, so the next press moves on
// rather than restarting the players.
assert.equal(
  advanceRoamSelection({ view: ROAM_VIEW.TRACK, targetId: 'gone', flagIndex: null }, { playerIds: players }).view,
  ROAM_VIEW.FOLLOW,
);

// The flag view cycles flags the same way, and resets the target on the way out.
let flagState = { view: ROAM_VIEW.FLAG, targetId: 'p2', flagIndex: null };
flagState = advanceRoamSelection(flagState, { flagIndexes: [0, 3] });
assert.equal(flagState.flagIndex, 0);
flagState = advanceRoamSelection(flagState, { flagIndexes: [0, 3] });
assert.equal(flagState.flagIndex, 3);
flagState = advanceRoamSelection(flagState, { flagIndexes: [0, 3] });
assert.equal(flagState.view, ROAM_VIEW.FREE, 'the flag view is the last before the wrap');
assert.equal(flagState.targetId, null, 'a new view starts on its leader');
assert.equal(flagState.flagIndex, null);

// Entering a view always starts at the leader, even coming from a picked target.
assert.deepEqual(
  advanceRoamSelection({ view: ROAM_VIEW.FPS, targetId: 'p3', flagIndex: null }, { playerIds: players, allowFlag: false }),
  { view: ROAM_VIEW.FREE, targetId: null, flagIndex: null },
);

console.log('roaming camera tests passed');
