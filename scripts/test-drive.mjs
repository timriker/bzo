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
import { createRequire } from 'node:module';
import { buildCollisionColliders, getObstacleBase } from '../public/collision.mjs';
import { createDriveState, readDriveInput, stepDrive } from '../public/drive.mjs';

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

// A flat mesh face the tank's centre hangs over the edge of is still the
// flat top it stands on: hix's diagonal bar, where a jump went straight up.
{
  const { parseBZWMap } = createRequire(import.meta.url)('../server/bzw-parse.cjs');
  const hix = parseBZWMap(new URL('../maps/hix.bzw', import.meta.url).pathname, { quiet: true });
  const bar = hix.obstacles.find((obs) => obs.name === 'ne:xbar');
  const state = createDriveState({ x: 41.2, y: 35.3, z: 30, azimuth: 2.36 });
  Object.assign(state, { onObstacle: true, onGround: false, inAir: false, lastObstacle: bar });
  stepDrive(state, { forward: 1, rotation: 0, jumpTriggered: true }, { flag: null, motionFlag: null },
    { config: CONFIG, colliders: [], topOf: () => 30 }, { now: 0, random: () => 0.5 }, 0.05);
  assert.ok(state.jumpForwardSpeed > 0.9, `off the bar's edge at speed (${state.jumpForwardSpeed})`);
}

// Wedged against the map's edge while falling straight down, as a tank backed
// into hix's north-east corner was: nothing moves across, so the shove out is
// upstream's fixed creep (LocalPlayer.cxx:467), not the tank's own speed --
// which is none, and left it falling in place for good.
{
  const { parseBZWMap } = createRequire(import.meta.url)('../server/bzw-parse.cjs');
  const hix = parseBZWMap(new URL('../maps/hix.bzw', import.meta.url).pathname, { quiet: true });
  const colliders = buildCollisionColliders(hix.obstacles, hix.mapSize ?? 800, false, undefined);
  const state = createDriveState({ x: 396.85, y: 386.95, z: 30, azimuth: 2.67 });
  Object.assign(state, {
    inAir: true, onGround: false, onObstacle: false, jumpDirection: 2.67, verticalVelocity: -0.16,
  });
  const world = {
    config: { ...CONFIG, WINGS_JUMP_COUNT: 1 },
    colliders,
    topOf: (obs) => ((obs.type === 'mesh' && obs.bounds) ? obs.bounds.maxZ : getObstacleBase(obs) + (obs.size?.[2] || 0)),
  };
  for (let i = 0; i < 600 && state.inAir; i++) {
    stepDrive(state, { forward: 0, rotation: 0, jumpTriggered: false }, { flag: null, motionFlag: null },
      world, { now: i / 60, random: () => 0.5 }, 1 / 60);
  }
  assert.equal(state.inAir, false, `out of the wall and down, at ${state.x},${state.y},${state.z}`);
}

// "can't jump while burrowed" (LocalPlayer.cxx:1406): below z 0, whatever the
// flag, a Wings flap included.
for (const flag of ['BU', 'WG']) {
  const jumps = (z) => {
    const state = createDriveState({ x: 0, y: 0, z });
    state.wingsFlapsLeft = 2;
    const world = { config: CONFIG };
    const tank = { flag: { type: flag }, motionFlag: flag };
    return readDriveInput(state, { forward: 0, turn: 0, up: true }, tank, world, { now: 0 }).jumpTriggered;
  };
  assert.equal(jumps(-0.5), false, `${flag} below ground does not jump`);
  assert.equal(jumps(0), true, `${flag} on the ground does`);
}

console.log('drive tests passed');
