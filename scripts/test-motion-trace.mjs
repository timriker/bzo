#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Drives seeded tanks and fires seeded shots through real maps with the shared
// `drive` and `collision` pairs, and compares every sample with the baseline in
// scripts/fixtures/motion-trace.json, so a change that moves a tank or a shot
// anywhere at all shows up. Code that adds or turns in a different order rounds
// differently, so values get a tolerance far below any change a player could
// see and far above rounding. The worst deviation is printed every run.
//
//   node scripts/test-motion-trace.mjs            compare with the baseline
//   node scripts/test-motion-trace.mjs --update   record a new baseline

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createDriveState, readDriveInput, stepDrive } from '../public/drive.mjs';
import { buildCollisionColliders, traceShotStep, SHOT_COLLISION_RADIUS } from '../public/collision.mjs';

const require = createRequire(import.meta.url);
const { parseBZWMap } = require('../server/bzw-parse.cjs');

const FIXTURE = new URL('./fixtures/motion-trace.json', import.meta.url);
const MAPS = ['maps/hix.bzw', 'maps/collision-test.bzw'];
const TANKS = 6;
const FRAMES = 1200;
const SEGMENT = 30;
const SAMPLE_EVERY = 20;
const SHOTS = 30;
const SHOT_STEPS = 200;
const SHOT_SAMPLE_EVERY = 10;
const SHOT_SPEED = 100;
const DT = 1 / 60;
const ANGLE_TOLERANCE = 1e-9;
const VALUE_TOLERANCE = 1e-9;

const CONFIG = {
  TANK_SPEED: 25,
  TANK_ROTATION_SPEED: Math.PI / 4,
  GRAVITY: 9.8,
  JUMP_VELOCITY: 19,
  ALLOW_JUMPING: true,
  MAX_BUMP_HEIGHT: 0.33,
};

function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// The same rule `getColliderTopY` in server.js answers by.
function topOf(obs) {
  if (obs?.type === 'mesh' && obs.bounds) return obs.bounds.maxZ;
  return (obs?.pos?.[2] || 0) + (Number.isFinite(obs?.size?.[2]) ? obs.size[2] : 0);
}

// Starts and directions are drawn in upstream's frame, so the seed means the
// same place before and after the move.
function sampleTank(state) {
  return [state.x, state.y, state.z, state.azimuth, state.airVelocityX, state.airVelocityY, state.verticalVelocity,
    state.onGround ? 1 : 0, state.onObstacle ? 1 : 0];
}
const ANGLE_FIELDS = new Set([3]);

function runTanks(map, colliders, seed) {
  const rand = makeRandom(seed);
  const world = { config: CONFIG, colliders, topOf };
  const half = map.mapSize / 2;
  const tanks = [];
  for (let t = 0; t < TANKS; t++) {
    const start = { x: (rand() - 0.5) * 1.6 * half, y: (rand() - 0.5) * 1.6 * half, z: 0 };
    const state = createDriveState({ ...start, azimuth: rand() * Math.PI * 2 });
    const clock = { now: 0, random: makeRandom(seed + t + 1) };
    const samples = [];
    let controls = null;
    for (let frame = 0; frame < FRAMES; frame++) {
      if (frame % SEGMENT === 0) {
        controls = {
          forward: [-1, -0.5, 0, 0.5, 1, 1][Math.floor(rand() * 6)],
          turn: (rand() - 0.5) * 2,
          up: rand() < 0.2,
        };
      }
      clock.now += DT;
      const tank = { flag: null, motionFlag: null };
      const intended = readDriveInput(state, controls, tank, world, clock);
      stepDrive(state, intended, tank, world, clock, DT);
      if (frame % SAMPLE_EVERY === 0) samples.push(sampleTank(state));
    }
    tanks.push(samples);
  }
  return tanks;
}

function runShots(map, colliders, seed) {
  const rand = makeRandom(seed);
  const half = map.mapSize / 2;
  const shots = [];
  for (let s = 0; s < SHOTS; s++) {
    const azimuth = rand() * Math.PI * 2;
    const pitch = (rand() - 0.5) * 0.4;
    const from = { x: (rand() - 0.5) * 1.6 * half, y: (rand() - 0.5) * 1.6 * half, z: 1.57 };
    const dir = {
      x: Math.cos(azimuth) * Math.cos(pitch), y: Math.sin(azimuth) * Math.cos(pitch), z: Math.sin(pitch),
    };
    let shot = { x: from.x, y: from.y, z: from.z, dirX: dir.x, dirY: dir.y, dirZ: dir.z };
    const samples = [];
    for (let step = 0; step < SHOT_STEPS; step++) {
      const next = traceShotStep({
        obstacles: colliders,
        ...shot,
        distance: SHOT_SPEED * DT,
        radius: SHOT_COLLISION_RADIUS,
        ricochet: s % 2 === 0,
      });
      shot = { x: next.x, y: next.y, z: next.z, dirX: next.dirX, dirY: next.dirY, dirZ: next.dirZ };
      const p = shot;
      const d = { x: shot.dirX, y: shot.dirY, z: shot.dirZ };
      const stopped = next.ground || (next.obstacle && !next.bounces);
      if (step % SHOT_SAMPLE_EVERY === 0 || stopped) samples.push([p.x, p.y, p.z, d.x, d.y, d.z, next.bounces]);
      if (stopped) break;
    }
    shots.push(samples);
  }
  return shots;
}

function record() {
  const out = {};
  MAPS.forEach((file, i) => {
    const map = parseBZWMap(file, { quiet: true });
    const colliders = buildCollisionColliders(map.obstacles, map.mapSize, map.noWalls, map.wallHeight);
    out[file] = { tanks: runTanks(map, colliders, 1000 + i), shots: runShots(map, colliders, 2000 + i) };
  });
  return out;
}

function angleDelta(a, b) {
  const d = Math.abs(a - b) % (Math.PI * 2);
  return Math.min(d, Math.PI * 2 - d);
}

const current = record();
if (process.argv.includes('--update')) {
  fs.writeFileSync(FIXTURE, `${JSON.stringify(current)}\n`);
  console.log(`motion trace baseline written to ${FIXTURE.pathname}`);
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
let samples = 0;
let worstAngle = 0;
let worstValue = 0;
for (const file of MAPS) {
  for (const kind of ['tanks', 'shots']) {
    const want = baseline[file][kind];
    const got = current[file][kind];
    assert.equal(got.length, want.length, `${file} ${kind}: count`);
    want.forEach((track, i) => {
      assert.equal(got[i].length, track.length, `${file} ${kind}[${i}]: length`);
      track.forEach((sample, j) => {
        samples++;
        sample.forEach((value, k) => {
          const where = `${file} ${kind}[${i}] sample ${j} field ${k}`;
          if (kind === 'tanks' && ANGLE_FIELDS.has(k)) {
            const delta = angleDelta(got[i][j][k], value);
            worstAngle = Math.max(worstAngle, delta);
            assert.ok(delta <= ANGLE_TOLERANCE, `${where}: azimuth ${got[i][j][k]}, baseline ${value}`);
          } else {
            const delta = Math.abs(got[i][j][k] - value);
            worstValue = Math.max(worstValue, delta);
            assert.ok(delta <= VALUE_TOLERANCE, `${where}: got ${got[i][j][k]}, baseline ${value}`);
          }
        });
      });
    });
  }
}
console.log(`motion trace matches the baseline: ${samples} samples, worst value ${worstValue.toExponential(1)},`
  + ` worst azimuth ${worstAngle.toExponential(1)}`);
