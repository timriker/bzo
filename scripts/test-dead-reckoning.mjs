#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// `deadReckon` predicts where a tank is from the move it last sent, and the
// driving it predicts is `stepDrive`'s: a tank driven a second, frame by frame,
// ends where the prediction from its first move says, physics drivers
// included. The move names the driver it stands on (`pd`).

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  createDriveState, movePacketFields, packetVelocity, sentMoveStrayed, stepDrive, stepDriveFor,
} from '../public/js/drive.mjs';
import { deadReckon } from '../public/js/dead-reckoning.mjs';

const CONFIG = {
  TANK_SPEED: 25,
  TANK_ROTATION_SPEED: Math.PI / 4,
  GRAVITY: -9.8,
  WINGS_GRAVITY: -9.8,
  JUMP_VELOCITY: 19,
  MAX_BUMP_HEIGHT: 0.33,
};
const FRAME = 0.01;

// Drives `seconds` on `support`, holding `forward` and `rotation`, from the
// first move's state; answers where the drive went and where the prediction
// from that first move put it.
function driveAndPredict(support, { forward = 0, rotation = 0, seconds = 1 } = {}) {
  // At ground level, so a step with nothing to collide with leaves it there.
  const state = createDriveState({ x: 10, y: 0, z: 0, azimuth: Math.PI / 2 });
  Object.assign(state, { onObstacle: true, onGround: false, inAir: false, lastObstacle: support });
  const world = { config: CONFIG, colliders: [], topOf: () => 0 };
  const tank = { flag: null, motionFlag: null };
  const clock = { now: 0, random: () => 0.5 };
  // One frame to settle the stick into the state a move reports.
  stepDrive(state, { forward, rotation, jumpTriggered: false }, tank, world, clock, FRAME);
  // The support is what the tank stands on each frame, as the world would
  // report it.
  const seat = () => Object.assign(state, {
    onObstacle: true, onGround: false, inAir: false, lastObstacle: support, z: 0, verticalVelocity: 0,
  });
  seat();
  const move = movePacketFields(state);
  const from = { x: state.x, y: state.y, z: state.z, azimuth: state.azimuth };
  for (let t = 0; t < seconds - 1e-9; t += FRAME) {
    seat();
    stepDrive(state, { forward, rotation, jumpTriggered: false }, tank, world, clock, FRAME);
  }
  const predicted = deadReckon({
    ...from, forwardSpeed: move.fs, rotationSpeed: move.rs, verticalVelocity: 0, jumpAzimuth: null,
  }, seconds, CONFIG, support.phydrv && move.pd === support.phydrv.index ? support.phydrv : null);
  return { move, driven: state, predicted };
}

const box = (phydrv) => ({ type: 'box', pos: [0, 0, -4], size: [200, 200, 4], angle: 0, phydrv });
const near = (a, b, tolerance, what) => {
  const off = Math.hypot(a.x - b.x, a.y - b.y);
  assert.ok(off < tolerance, `${what}: driven ${a.x.toFixed(2)},${a.y.toFixed(2)},`
    + ` predicted ${b.x.toFixed(2)},${b.y.toFixed(2)} (${off.toFixed(3)} apart)`);
};

// No driver: a straight line and an arc.
{
  const straight = driveAndPredict(box(null), { forward: 1 });
  assert.equal(straight.move.pd, undefined, 'no driver, none named');
  near(straight.driven, straight.predicted, 0.05, 'driving straight');
  const arc = driveAndPredict(box(null), { forward: 1, rotation: 1 });
  // Frame by frame each step leaves on the heading it started with, which
  // trails the exact arc by about half a frame's turn of travel.
  near(arc.driven, arc.predicted, 0.2, 'driving an arc');
}

// A conveyor carries the tank along with its own speed.
{
  const conveyor = { index: 3, linear: [0, -50, 0], angular: null };
  const still = driveAndPredict(box(conveyor));
  assert.equal(still.move.pd, 3, 'the move names the driver it stands on');
  near(still.driven, still.predicted, 0.05, 'carried by a conveyor');
  const driving = driveAndPredict(box(conveyor), { forward: 1 });
  near(driving.driven, driving.predicted, 0.05, 'driving on a conveyor');
}

// A turntable turns the tank and carries it round its centre, its own motion
// on top. The drive integrates the carry frame by frame and the prediction
// exactly, so they part by a little over a second.
{
  const turntable = { index: 5, linear: null, angular: [Math.PI / 2, 0, 0] };
  const still = driveAndPredict(box(turntable));
  near(still.driven, still.predicted, 0.3, 'carried round a turntable');
  const turned = Math.atan2(Math.sin(still.driven.azimuth - still.predicted.azimuth),
    Math.cos(still.driven.azimuth - still.predicted.azimuth));
  assert.ok(Math.abs(turned) < 0.01, 'and turned with it');
  assert.ok(Math.abs(still.move.rs) < 1e-9, 'its own turn is none: the spin is the driver\'s');
  const driving = driveAndPredict(box(turntable), { forward: 1 });
  // Farther out, so a frame's straight-line carry spirals out a little more.
  near(driving.driven, driving.predicted, 1, 'driving on a turntable');
}

// A client drawing one frame a second drives the whole second of it, as
// upstream's does, rather than the tenth a single step allows: on a turntable
// it is carried as far as the prediction says.
{
  const turntable = { type: 'box', pos: [0, 0, 0], size: [200, 200, 4], angle: 0,
    phydrv: { index: 5, linear: null, angular: [Math.PI / 2, 0, 0] } };
  const world = { config: CONFIG, colliders: [turntable], topOf: () => 4 };
  const drive = (frame) => {
    const state = createDriveState({ x: 10, y: 0, z: 4, azimuth: Math.PI / 2 });
    Object.assign(state, { onObstacle: true, onGround: false, inAir: false, lastObstacle: turntable });
    for (let t = 0; t < 1 - 1e-9; t += frame) {
      stepDriveFor(state, { forward: 0, rotation: 0, jumpTriggered: false },
        { flag: null, motionFlag: null }, world, { now: 0, random: () => 0.5 }, frame);
    }
    return state;
  };
  const predicted = deadReckon({ x: 10, y: 0, z: 4, azimuth: Math.PI / 2, forwardSpeed: 0, rotationSpeed: 0,
    verticalVelocity: 0, jumpAzimuth: null }, 1, CONFIG, turntable.phydrv);
  near(drive(FRAME), predicted, 0.3, 'carried round a turntable frame by frame');
  near(drive(1), predicted, 1.5, 'and at one frame a second');
}

// A tank where its last move predicts has not strayed; one a wall holds back
// on a conveyor has, and sends again (Player::isDeadReckoningWrong).
{
  const conveyor = { index: 3, linear: [0, -50, 0], angular: null };
  const carried = driveAndPredict(box(conveyor));
  const ground = { ...carried.driven, jumpDirection: null };
  assert.ok(!sentMoveStrayed(carried.move, { ...ground, ...carried.predicted }, 1, CONFIG, conveyor),
    'carried as predicted');
  assert.ok(sentMoveStrayed(carried.move, { ...ground, x: carried.move.x, y: carried.move.y }, 1, CONFIG, conveyor),
    'held back by a wall');
  assert.ok(!sentMoveStrayed({ ...carried.move, air: 1 }, { ...ground, x: 10, y: 0, z: 0 }, 1, CONFIG, conveyor),
    'not judged in the air');
}

// A shot takes the tank's whole velocity, the belt's push and a turntable's
// carry with its own (LocalPlayer::fireShot), though the move names only the
// tank's own and the driver.
{
  const move = { x: 10, y: 0, a: Math.PI / 2, fs: 1, air: 0 };
  const own = packetVelocity(move, CONFIG);
  assert.ok(Math.abs(own.y - 25) < 1e-9 && Math.abs(own.x) < 1e-9, 'its own speed, with no driver');
  const belt = packetVelocity(move, CONFIG, { linear: [0, 100, 0], angular: null });
  assert.ok(Math.abs(belt.y - 125) < 1e-9, `a belt's push added: ${belt.y}`);
  const spun = packetVelocity(move, CONFIG, { linear: null, angular: [Math.PI / 2, 0, 0] });
  assert.ok(Math.abs(spun.y - (25 + (Math.PI / 2) * 10)) < 1e-9, "and a turntable's carry at the tank");
}

// A driver whose push only lifts is not named: it makes a tank fall, and a
// tank in the air is predicted on its air velocity.
{
  const lift = { index: 7, linear: [0, 0, 20], angular: null };
  const state = createDriveState({ x: 0, y: 0, z: 0, azimuth: 0 });
  Object.assign(state, { onObstacle: true, onGround: false, inAir: false, lastObstacle: box(lift) });
  assert.equal(movePacketFields(state).pd, 7, 'a driver that moves the tank at all is named');
}

// A proxied bzfs: its update, the driver in the velocity and turn, becomes
// the browser's move with the driver taken out and named; the browser's move
// goes back to bzfs with it put back and named, written where upstream reads
// it (`PlayerState::pack`).
{
  const require = createRequire(import.meta.url);
  const { proxyMove, proxyOutboundMotion } = require('../server/bzfs-proxy.cjs');
  const { BzfsSession, PLAYER_STATUS, decodePlayerUpdate } = require('../server/bzfs-session.cjs');
  const drivers = [{ index: 2, linear: [0, -50, 0], angular: [Math.PI / 2, 100, 0] }];
  const driverAt = (index) => drivers.find((driver) => driver.index === index) ?? null;
  const physics = { tankSpeed: 25, tankAngVel: Math.PI / 4 };
  const browserMove = { x: 110, y: 0, z: 0, a: Math.PI / 2, fs: 0.5, rs: 0.5, vv: 0, pd: 2 };
  const outbound = proxyOutboundMotion(browserMove, physics, PLAYER_STATUS.ALIVE, driverAt);
  assert.ok(outbound.status & PLAYER_STATUS.ON_DRIVER, 'bzfs is told the tank is on a driver');
  assert.equal(outbound.phydrv, 2);
  const frames = [];
  BzfsSession.prototype.sendPlayerUpdate.call(
    { order: 0, startedAt: Date.now(), playerId: 4, send: (code, payload) => frames.push(payload) }, outbound);
  const update = decodePlayerUpdate(frames[0], false);
  assert.equal(update.phydrv, 2, 'and the driver is where upstream reads it');
  const back = proxyMove(4, {
    pos: update.pos, velocity: update.velocity, azimuth: update.azimuth, angVel: update.angVel,
    falling: false, phydrv: update.phydrv,
  }, physics, driverAt);
  assert.ok(Math.abs(back.fs - 0.5) < 1e-3 && Math.abs(back.rs - 0.5) < 1e-3,
    `the tank's own motion comes back: fs ${back.fs}, rs ${back.rs}`);
  assert.equal(back.pd, 2);
}

console.log('dead reckoning tests passed');
