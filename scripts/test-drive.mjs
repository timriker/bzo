#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The `drive` pair's jump rules that depend on what the tank stands on. In
// upstream's frame: +Z up, a heading an azimuth counter-clockwise from +X.

import assert from 'node:assert/strict';
import { createDriveState, stepDrive } from '../public/drive.mjs';

const CONFIG = {
  TANK_SPEED: 25,
  TANK_ROTATION_SPEED: Math.PI / 4,
  GRAVITY: 9.8,
  JUMP_VELOCITY: 19,
  ALLOW_JUMPING: true,
  MAX_BUMP_HEIGHT: 0.33,
};
const pyramid = { type: 'pyramid', pos: [0, 0, 0], size: [10, 10, 10], angle: 0 };
const box = { type: 'box', pos: [0, 0, 0], size: [10, 10, 4], angle: 0 };

// One frame of a jump at full speed ahead -- north, +Y -- standing on `support`.
function jumpFrom(support, config) {
  const state = createDriveState({ x: 0, y: 0, z: 4, azimuth: Math.PI / 2 });
  state.onObstacle = true;
  state.onGround = false;
  state.inAir = false;
  state.lastObstacle = support;
  const world = { config, colliders: [], topOf: () => 4 };
  stepDrive(state, { forward: 1, rotation: 0, jumpTriggered: true }, { flag: null, motionFlag: null },
    world, { now: 0, random: () => 0.5 }, 0.05);
  return state;
}

// `_noClimb`, upstream's default: a jump from a pyramid's side goes straight up.
{
  const state = jumpFrom(pyramid, CONFIG);
  assert.equal(state.jumpForwardSpeed, 0, 'no forward speed off a slope');
  assert.ok(Math.abs(state.y) < 1e-9 && Math.abs(state.x) < 1e-9, `stayed put, at ${state.x},${state.y}`);
  assert.ok(state.z > 4, 'but still rose');
}

// A world that turns it off lets the tank jump up the slope.
{
  const state = jumpFrom(pyramid, { ...CONFIG, NO_CLIMB: false });
  assert.ok(state.jumpForwardSpeed > 0.9);
  assert.ok(state.y > 1, `moved forward, to y=${state.y}`);
}

// A flat top is not a slope: a box's, or an inverted pyramid's.
for (const support of [box, { ...pyramid, inverted: true }]) {
  const state = jumpFrom(support, CONFIG);
  assert.ok(state.jumpForwardSpeed > 0.9, `${support.type}${support.inverted ? ' (inverted)' : ''} keeps its speed`);
}

console.log('drive tests passed');
