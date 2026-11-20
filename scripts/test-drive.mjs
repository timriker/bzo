#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The `drive` module's jump rules that depend on what the tank stands on. In
// upstream's frame: +Z up, a heading an azimuth counter-clockwise from +X.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildCollisionColliders, getObstacleBase } from '../public/js/collision.mjs';
import { createDriveState, readDriveInput, stepDrive } from '../public/js/drive.mjs';
import { worldConfig } from '../public/js/bzdb.mjs';

const CONFIG = {
  TANK_SPEED: 25,
  TANK_ROTATION_SPEED: Math.PI / 4,
  GRAVITY: -9.8,
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

// A tank with no input on the outer lane of a TimeTrial curve, where the
// `angular` driver carries it into the guardrail: it slides along the rail and
// rides on, as upstream's does, because the normal is the rail face the step
// struck (`hitFace`) -- a second search for that face found none there, and the
// made-up roof it fell back to held the tank in place for good.
{
  const { parseBZWMap } = createRequire(import.meta.url)('../server/bzw-parse.cjs');
  const map = parseBZWMap(new URL('../maps/TimeTrial.bzw', import.meta.url).pathname, { quiet: true });
  const colliders = buildCollisionColliders(map.obstacles, map.mapSize ?? 800, false, undefined);
  const world = {
    config: CONFIG,
    colliders,
    topOf: (obs) => ((obs.type === 'mesh' && obs.bounds) ? obs.bounds.maxZ : getObstacleBase(obs) + (obs.size?.[2] || 0)),
  };
  const state = createDriveState({ x: 374.1, y: -445.85, z: 2, azimuth: -2.95 });
  let halfway = null;
  for (let i = 0; i < 300; i++) {
    if (i === 150) halfway = { x: state.x, y: state.y };
    stepDrive(state, { forward: 0, rotation: 0, jumpTriggered: false }, { flag: null, motionFlag: null },
      world, { now: i / 30, random: () => 0.5 }, 1 / 30);
  }
  const moved = Math.hypot(state.x - halfway.x, state.y - halfway.y);
  assert.ok(moved > 100, `still riding after 5s, not held against the rail (moved ${moved.toFixed(1)} in the last 5s)`);
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

// `_jumpVelocity 0` is a jump with no lift, and Wings, whose default is the
// expression "_jumpVelocity", follows it there and back.
{
  const base = { ...CONFIG, WINGS_JUMP_VELOCITY: null, WINGS_GRAVITY: null,
    SHOT_RANGE: 350, SHOT_SPEED: 100, SHOT_MAX_ACTIVE: 1 };
  const wings = (vars) => worldConfig(base, new Map(vars));
  assert.equal(wings([['_jumpVelocity', '0']]).JUMP_VELOCITY, 0, '_jumpVelocity 0');
  assert.equal(wings([['_jumpVelocity', '0']]).WINGS_JUMP_VELOCITY, 0, 'Wings follows 0');
  assert.equal(wings([['_jumpVelocity', '25']]).WINGS_JUMP_VELOCITY, 25, 'Wings follows it back');
  assert.equal(wings([['_wingsJumpVelocity', '0']]).WINGS_JUMP_VELOCITY, 0, '_wingsJumpVelocity 0');
  assert.equal(wings([['_wingsJumpVelocity', '0']]).JUMP_VELOCITY, 19, 'and the jump stays');
}

// An `angular` driver (LocalPlayer.cxx:416-425), parsed in rotations a second
// and kept in radians: a tank standing still on it turns with it, and is
// carried round its centre at the speed a point that far out has.
{
  const { parseBZWMap } = createRequire(import.meta.url)('../server/bzw-parse.cjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzo-angular-'));
  const file = path.join(dir, 'turntable.bzw');
  fs.writeFileSync(file, 'physics\n  name turn\n  angular 0.25 0 0\nend\n'
    + 'box\n  position 0 0 0\n  size 20 20 4\n  phydrv turn\nend\n');
  const world = parseBZWMap(file, { quiet: true });
  fs.rmSync(dir, { recursive: true, force: true });
  const table = world.obstacles.find((obs) => obs.type === 'box');
  assert.deepEqual(table.phydrv.angular, [Math.PI / 2, 0, 0], 'a quarter turn a second, in radians');

  const state = createDriveState({ x: 10, y: 0, z: 4, azimuth: 0 });
  Object.assign(state, { onObstacle: true, onGround: false, inAir: false, lastObstacle: table });
  const dt = 0.01;
  stepDrive(state, { forward: 0, rotation: 0, jumpTriggered: false }, { flag: null, motionFlag: null },
    { config: CONFIG, colliders: [], topOf: () => 4 }, { now: 0, random: () => 0.5 }, dt);
  assert.ok(Math.abs(state.azimuth - (Math.PI / 2) * dt) < 1e-9, `turned with it, to ${state.azimuth}`);
  assert.ok(Math.abs(state.y - 10 * (Math.PI / 2) * dt) < 1e-9 && Math.abs(state.x - 10) < 1e-9,
    `carried round its centre, to ${state.x},${state.y}`);
}

// A `linear` driver's carry goes up with a jump (LocalPlayer.cxx:409-425, added
// before the jump), and the tank keeps it through the air.
{
  const { parseBZWMap } = createRequire(import.meta.url)('../server/bzw-parse.cjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzo-linear-'));
  const file = path.join(dir, 'belt.bzw');
  fs.writeFileSync(file, 'physics\n  name belt\n  linear 30 0 0\nend\n'
    + 'box\n  position 0 0 0\n  size 200 20 4\n  phydrv belt\nend\n');
  const world = parseBZWMap(file, { quiet: true });
  fs.rmSync(dir, { recursive: true, force: true });
  const belt = world.obstacles.find((obs) => obs.type === 'box');

  const state = createDriveState({ x: 0, y: 0, z: 4, azimuth: Math.PI / 2 });
  Object.assign(state, { onObstacle: true, onGround: false, inAir: false, lastObstacle: belt });
  const driveWorld = { config: CONFIG, colliders: [], topOf: () => 4 };
  const tank = { flag: null, motionFlag: null };
  const dt = 0.01;
  stepDrive(state, { forward: 0, rotation: 0, jumpTriggered: true }, tank, driveWorld, { now: 0, random: () => 0.5 }, dt);
  assert.ok(state.inAir, 'jumped');
  assert.ok(Math.abs(state.airVelocityX - 30) < 1e-9, `carried the belt up, at ${state.airVelocityX}`);
  const x = state.x;
  stepDrive(state, { forward: 0, rotation: 0, jumpTriggered: false }, tank, driveWorld, { now: dt, random: () => 0.5 }, dt);
  assert.ok(Math.abs(state.x - x - 30 * dt) < 1e-9, `and kept it in the air, by ${state.x - x}`);
}

console.log('drive tests passed');
