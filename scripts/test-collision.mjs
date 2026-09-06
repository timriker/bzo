#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// public/collision.mjs and server/collision.cjs are a
// hand-maintained pair, so compare them directly. The client resolves moves and
// the server rejects them, but both must agree about which volume is solid --
// a disagreement is either an honest player wrongly rejected or a cheater
// wrongly allowed.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as client from '../public/collision.mjs';

const require = createRequire(import.meta.url);
const server = require('../server/collision.cjs');

assert.deepEqual(
  Object.keys(server).sort(),
  Object.keys(client).filter((key) => key !== 'default').sort(),
  'client and server collision geometry export different names'
);

assert.equal(server.ZERO_TOLERANCE, client.ZERO_TOLERANCE);

// Deterministic PRNG so a failure is reproducible from the printed seed.
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function makePyramid(rand) {
  const height = 1 + rand() * 12;
  return {
    type: 'pyramid',
    name: 'fuzz',
    x: (rand() - 0.5) * 40,
    z: (rand() - 0.5) * 40,
    w: 2 + rand() * 20,
    d: 2 + rand() * 20,
    h: height,
    baseY: rand() < 0.3 ? rand() * 6 : 0,
    rotation: rand() < 0.5 ? 0 : rand() * Math.PI * 2,
    inverted: rand() < 0.5
  };
}

const SEED = Number(process.env.BZO_FUZZ_SEED || 20260830);
const rand = makeRandom(SEED);
const TANK_RADIUS = 2;
const TANK_HEIGHT = 2;

let checked = 0;
let solidSamples = 0;

for (let obstacleIndex = 0; obstacleIndex < 400; obstacleIndex += 1) {
  const obs = makePyramid(rand);
  const reach = Math.max(obs.w, obs.d) / 2 + TANK_RADIUS + 2;

  for (let sample = 0; sample < 250; sample += 1) {
    const x = obs.x + (rand() - 0.5) * 2 * reach;
    const z = obs.z + (rand() - 0.5) * 2 * reach;
    const y = obs.baseY - 2 + rand() * (obs.h + 4);

    const clientSolid = client.pyramidIntersectsCylinder(obs, x, y, z, TANK_RADIUS, TANK_HEIGHT);
    const serverSolid = server.pyramidIntersectsCylinder(obs, x, y, z, TANK_RADIUS, TANK_HEIGHT);

    // The client resolves movement and the server rejects it. The server must
    // never call solid what the client considers open, or it rejects a move an
    // unmodified client legitimately made.
    assert.equal(
      serverSolid,
      clientSolid,
      `solidity diverged (seed ${SEED}) at (${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)}) ` +
      `for ${JSON.stringify(obs)}`
    );

    assert.equal(
      server.pyramidShrinkFactor(obs, y, TANK_HEIGHT),
      client.pyramidShrinkFactor(obs, y, TANK_HEIGHT),
      `shrink factor diverged (seed ${SEED}) at y=${y.toFixed(3)} for ${JSON.stringify(obs)}`
    );

    const clientNormal = client.getPyramidFaceLocalNormal(obs, x, y, z, TANK_HEIGHT);
    const serverNormal = server.getPyramidFaceLocalNormal(obs, x, y, z, TANK_HEIGHT);
    assert.deepEqual(
      serverNormal,
      clientNormal,
      `face normal diverged (seed ${SEED}) at (${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)})`
    );

    // A pyramid must always offer a surface to slide on. When it does not, the
    // slide resolver has nothing to work with and the tank freezes in place --
    // in mid-air, if it was falling. Upstream getNormalRect always yields one.
    const normalLength = Math.hypot(clientNormal.x, clientNormal.y, clientNormal.z);
    assert.ok(
      Number.isFinite(normalLength) && normalLength > 1e-9,
      `face normal undefined (seed ${SEED}) at (${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)}) ` +
      `for ${JSON.stringify(obs)}`
    );

    assert.equal(
      server.isWithinPyramidFootprint(obs, x, z),
      client.isWithinPyramidFootprint(obs, x, z),
      `footprint containment diverged (seed ${SEED}) at (${x.toFixed(3)}, ${z.toFixed(3)})`
    );

    // Anything solid must be over the footprint or within a tank radius of it,
    // which is what keeps support and collision talking about the same object.
    if (clientSolid && !client.isWithinPyramidFootprint(obs, x, z)) {
      const local = client.getColliderLocalPoint(x, z, obs);
      const outside = Math.hypot(
        Math.max(0, Math.abs(local.x) - obs.w / 2),
        Math.max(0, Math.abs(local.z) - obs.d / 2)
      );
      assert.ok(
        outside <= TANK_RADIUS + 1e-9,
        `solid but ${outside.toFixed(3)} outside footprint (seed ${SEED})`
      );
    }

    // The server tests a slightly smaller radius than the client so that wire
    // quantization (positions are sent as toFixed(2)) cannot make it reject a
    // move the client legitimately made. Slack must only ever remove
    // collisions, never add them.
    const slackSolid = client.pyramidIntersectsCylinder(obs, x, y, z, TANK_RADIUS - 0.05, TANK_HEIGHT);
    assert.ok(
      !slackSolid || clientSolid,
      `slack created a collision (seed ${SEED}) at (${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)})`
    );

    checked += 1;
    if (clientSolid) solidSamples += 1;
  }
}

// A fuzz run that never lands inside an obstacle proves nothing.
assert.ok(solidSamples > checked * 0.05, `fuzz coverage too low: ${solidSamples}/${checked} solid`);

// Anchored cases pinning the BZFlag semantics the fuzz run cannot express.
const upright = { type: 'pyramid', x: 0, z: 0, w: 10, d: 10, h: 8, baseY: 0, rotation: 0, inverted: false };
const inverted = { ...upright, inverted: true };

// shrinkFactor: upright is widest at the base, inverted at the top.
assert.equal(client.pyramidShrinkFactor(upright, 0, 0), 1);
assert.equal(client.pyramidShrinkFactor(upright, 8, 0), 0);
assert.equal(client.pyramidShrinkFactor(inverted, 8, 0), 1);
assert.equal(client.pyramidShrinkFactor(inverted, 0, 0), 0);

// An occupant's own height reaches the wider cross-section of an inverted pyramid.
assert.equal(client.pyramidShrinkFactor(inverted, 0, 2), 0.25);

// Upright: solid near the base at the center, open high up near the apex edge.
assert.equal(client.pyramidIntersectsCylinder(upright, 0, 0, 0, 2, 2), true);
assert.equal(client.pyramidIntersectsCylinder(upright, 4.5, 7, 4.5, 2, 2), false);

// Inverted: open low at the edge, solid high where it is full width.
assert.equal(client.pyramidIntersectsCylinder(inverted, 4.9, 0, 4.9, 2, 2), false);
assert.equal(client.pyramidIntersectsCylinder(inverted, 4.5, 6, 4.5, 2, 2), true);

// Entirely above or below never collides.
assert.equal(client.pyramidIntersectsCylinder(upright, 0, 9, 0, 2, 2), false);
assert.equal(client.pyramidIntersectsCylinder(upright, 0, -5, 0, 2, 2), false);

// Inverted pyramids present a flat, drivable top; upright ones do not.
assert.equal(client.isPyramidFlatTop(inverted), true);
assert.equal(client.isPyramidFlatTop(upright), false);

// getPyramidSurfaceLocalHeight is the inverse of pyramidShrinkFactor.
for (const obs of [upright, inverted]) {
  for (const edge of [0, 0.25, 0.5, 0.75, 1]) {
    const localX = edge * (obs.w / 2);
    const surfaceY = client.getPyramidSurfaceLocalHeight(obs, localX, 0);
    const shrink = client.pyramidShrinkFactor(obs, obs.baseY + surfaceY, 0);
    // Both orientations reduce to the same identity: the shrink factor at the
    // surface height equals the normalized distance from the pyramid's axis.
    assert.ok(
      Math.abs(shrink - edge) < 1e-9,
      `surface height and shrink factor disagree at edge ${edge} (inverted=${obs.inverted})`
    );
  }
}

// Regression: a tank whose centre sits outside the base footprint still needs a
// normal, because its radius can reach the slope. Returning none here froze
// tanks against steep pyramids, including in mid-air while falling.
const e_pyr1 = { type: 'pyramid', x: 340, z: 45, baseY: 0, rotation: Math.PI, w: 15, d: 15, h: 26, inverted: false };
const outsideFootprint = client.getPyramidFaceLocalNormal(e_pyr1, 341.95, 6.94, 52.54, 2);
assert.ok(Math.hypot(outsideFootprint.x, outsideFootprint.y, outsideFootprint.z) > 1e-9);

// Steep faces are not climbable, so the tank slides off rather than driving up.
const steepNormalY = outsideFootprint.y / Math.hypot(outsideFootprint.x, outsideFootprint.y, outsideFootprint.z);
assert.ok(steepNormalY < 0.7, `expected e_pyr1 face to be unclimbable, got normal.y=${steepNormalY}`);

// A shallow rib is climbable, matching the drive-up-a-pyramid behaviour.
const rib = { type: 'pyramid', x: 140, z: 140, baseY: 0, rotation: Math.PI, w: 16, d: 2, h: 5, inverted: false };
const ribNormal = client.getPyramidFaceLocalNormal(rib, 130.3, 0, 140.54, 2);
assert.ok(ribNormal.y / Math.hypot(ribNormal.x, ribNormal.y, ribNormal.z) >= 0.7);

// Regression: a normal exists everywhere, but support must be contained.
// hix.bzw's inverted "cap" pyramids sit at baseY=12 h=2, so their flat top is at
// exactly y=14. When support stopped checking containment, one of them held a
// tank at y=14 from 224 units away, and the tank could not fall anywhere on the
// map.
const cap = { type: 'pyramid', x: 140, z: -140, baseY: 12, rotation: Math.PI, w: 16, d: 1, h: 2, inverted: true };
assert.equal(client.isWithinPyramidFootprint(cap, 237.41, 61.57), false, 'distant point must not be over the cap');
assert.equal(client.isWithinPyramidFootprint(cap, 140, -140), true, 'centre must be over the cap');
// Still yields a normal there, which is what the slide resolver needs.
const distantNormal = client.getPyramidFaceLocalNormal(cap, 237.41, 14, 61.57, 2);
assert.ok(Math.hypot(distantNormal.x, distantNormal.y, distantNormal.z) > 1e-9);

// Footprint containment respects rotation.
const rotated = { type: 'pyramid', x: 0, z: 0, baseY: 0, rotation: Math.PI / 2, w: 16, d: 2, h: 5, inverted: false };
assert.equal(client.isWithinPyramidFootprint(rotated, 0, 7), true, 'long axis runs along z when rotated 90 degrees');
assert.equal(client.isWithinPyramidFootprint(rotated, 7, 0), false, 'short axis runs along x when rotated 90 degrees');

// Rectangle normals: sides, corners, and interior all resolve.
assert.deepEqual(client.getOrigRectNormal(5, 5, 9, 0), { x: 1, z: 0 });
assert.deepEqual(client.getOrigRectNormal(5, 5, -9, 0), { x: -1, z: 0 });
assert.deepEqual(client.getOrigRectNormal(5, 5, 0, 9), { x: 0, z: 1 });
assert.deepEqual(client.getOrigRectNormal(5, 5, 0, -9), { x: 0, z: -1 });
const corner = client.getOrigRectNormal(5, 5, 8, 9);
assert.ok(corner.x > 0 && corner.z > 0 && Math.abs(Math.hypot(corner.x, corner.z) - 1) < 1e-9);
// Inside a long thin rib, resolve to the long face rather than the end cap.
assert.deepEqual(client.getOrigRectNormal(8, 1, 1, 0.5), { x: 0, z: 1 });

// --- Swept motion -----------------------------------------------------------
//
// BoxBuilding::inMovingBox and the roof half of Obstacle::getHitNormal. One
// frame is one step, so a slow frame is a long step; both of these exist so a
// long step is judged by the span it covered rather than by where it ended.

const EPSILON = 0.15;
// A roof at 4.5, the height of a standard box.
const ROOF = 4.5;
const spans = (fromY, toY) =>
  client.movingTankOverlapsHeight(0, ROOF, fromY, toY, TANK_HEIGHT, EPSILON);

// Where the step has no vertical extent, this is the point test it replaces:
// resting on the roof is on it, not in it, and standing clear of it is clear.
assert.equal(spans(ROOF, ROOF), false, 'a tank parked on the roof is not inside the box');
assert.equal(spans(6, 6), false, 'a tank well above the roof misses it');
assert.equal(spans(3, 3), true, 'a tank level with the wall hits it');

// The step that started this: a tank falling at the speed a jump lands at
// (19 units/second, from _jumpVelocity 19) covers 1.9 units in a frame at the
// 0.1s cap, and used to arrive below the roof having never been told about it.
assert.equal(spans(5.4, 3.5), true, 'a 1.9 unit fall through the roof reports the roof');
assert.equal(
  client.crossedFlatTop(ROOF, 5.4, 3.5), true,
  'and the step is a landing, however far below the top it ended'
);

// A thin deck is the case the endpoint test cannot see at all: fall far enough
// in one step and the tank is past it, body and all, by the time anything is
// asked.
const DECK_BASE = 10;
const DECK_TOP = 10.5;
const deckSpans = (fromY, toY) =>
  client.movingTankOverlapsHeight(DECK_BASE, DECK_TOP, fromY, toY, TANK_HEIGHT, EPSILON);
// Nothing slows a falling tank in BZFlag, so a drop from any height arrives
// faster than a jump does and 2.5 units in one step is an ordinary hitch.
assert.equal(deckSpans(8.1, 8.1), false, 'the endpoint alone is clean under the deck');
assert.equal(deckSpans(10.6, 8.1), true, 'the step that crossed it is not');
assert.equal(client.crossedFlatTop(DECK_TOP, 10.3, 8.1), false, 'started below the deck top');
assert.equal(client.crossedFlatTop(DECK_TOP, 10.6, 8.1), true, 'started above it, so it landed');

// Climbing is swept the same way, because a tank rising fast clears a thin deck
// in one step exactly as it falls through one. Upstream's inMovingBox is
// symmetric; only the landing is not.
assert.equal(deckSpans(8.1, 10.3), true, 'a climb through the deck reports it');
assert.equal(client.crossedFlatTop(DECK_TOP, 8.1, 10.3), false, 'a climb is never a landing');

// Nothing about a landing depends on how near the top the step began. The band
// this replaced gave up after one unit, which is what put tanks through roofs
// on a headset whenever a frame ran long.
assert.equal(client.crossedFlatTop(ROOF, ROOF, ROOF - 0.001), true, 'the shortest crossing counts');
assert.equal(client.crossedFlatTop(ROOF, 24, 0), true, 'so does a fall from the top of the map');
assert.equal(client.crossedFlatTop(ROOF, 4.4, 0), false, 'a step from under the roof is not a landing');
assert.equal(client.crossedFlatTop(ROOF, 6, 5), false, 'nor is one that stayed above it');

// Both sides of the pair answer alike, since a landing the client takes and the
// server does not is a correction the player feels.
for (const [fromY, toY] of [[5.4, 3.5], [10.6, 8.1], [8.1, 10.3], [ROOF, ROOF], [24, 0]]) {
  assert.equal(
    server.movingTankOverlapsHeight(0, ROOF, fromY, toY, TANK_HEIGHT, EPSILON),
    client.movingTankOverlapsHeight(0, ROOF, fromY, toY, TANK_HEIGHT, EPSILON),
    `swept overlap disagrees for ${fromY} -> ${toY}`
  );
  assert.equal(
    server.crossedFlatTop(ROOF, fromY, toY),
    client.crossedFlatTop(ROOF, fromY, toY),
    `roof crossing disagrees for ${fromY} -> ${toY}`
  );
}

// --- Shots ------------------------------------------------------------------

// ShotStrategy::reflect. A head-on bounce reverses; a 45 degree one turns the
// shot through a right angle; both keep the speed they came in with.
const wallNormal = { x: -1, y: 0, z: 0 };
const headOn = client.reflectShotDirection(1, 0, 0, wallNormal);
assert.ok(Math.abs(headOn.x + 1) < 1e-12 && Math.abs(headOn.z) < 1e-12, 'head-on bounce reverses');
const glancing = client.reflectShotDirection(
  Math.SQRT1_2, 0, Math.SQRT1_2, wallNormal
);
assert.ok(Math.abs(glancing.x + Math.SQRT1_2) < 1e-12, 'the component along the normal flips');
assert.ok(Math.abs(glancing.z - Math.SQRT1_2) < 1e-12, 'the component along the surface is kept');
assert.ok(Math.abs(Math.hypot(glancing.x, glancing.y, glancing.z) - 1) < 1e-12, 'speed is unchanged');

// A normal facing the same way the shot travels is upstream's refraction case:
// it must not leave the shot passing through the surface, and it keeps the
// incoming speed.
const refracted = client.reflectShotDirection(1, 0, 0, { x: 1, y: 0, z: 0 });
assert.ok(refracted.x > 0, 'refraction pushes the shot along the inverted normal');
assert.ok(Math.abs(Math.hypot(refracted.x, refracted.y, refracted.z) - 1) < 1e-12);

// Both copies reflect identically. Same table, same numbers.
for (const [dx, dy, dz, nx, ny, nz] of [
  [1, 0, 0, -1, 0, 0],
  [0.6, 0.2, -0.77, 0, 1, 0],
  [-0.3, 0, 0.95, 0.7071067811865476, 0, -0.7071067811865476],
  [1, 0, 0, 1, 0, 0],
]) {
  assert.deepEqual(
    client.reflectShotDirection(dx, dy, dz, { x: nx, y: ny, z: nz }),
    server.reflectShotDirection(dx, dy, dz, { x: nx, y: ny, z: nz }),
    'client and server reflect a shot differently'
  );
}

// A shot fired down the x axis into a box turns around and comes back, and it
// stops at the wall instead when the shot does not ricochet.
const shotBox = [{ type: 'box', name: 'wall', x: 20, z: 0, w: 4, d: 40, h: 10, baseY: 0, rotation: 0 }];
const shotArgs = {
  obstacles: shotBox,
  x: 0,
  y: 2.2,
  z: 0,
  dirX: 1,
  dirY: 0,
  dirZ: 0,
  distance: 20,
  radius: client.SHOT_COLLISION_RADIUS,
};
const bounced = client.traceShotStep({ ...shotArgs, ricochet: true });
assert.equal(bounced.bounces, 1, 'the shot bounces off the box');
assert.ok(bounced.dirX < 0, 'and comes back the way it came');
assert.equal(bounced.obstacle, null, 'a ricocheting shot is never stopped');
assert.ok(bounced.x < 18, 'the bounce turns the shot around before the wall');
const stopped = client.traceShotStep({ ...shotArgs, ricochet: false });
assert.equal(stopped.bounces, 0);
assert.ok(stopped.obstacle, 'a shot that does not ricochet stops at the box');
assert.ok(Math.abs(stopped.x - 17.9) < 0.2, `expected to stop at the near face, got ${stopped.x}`);
assert.deepEqual(
  server.traceShotStep({ ...shotArgs, obstacles: shotBox, ricochet: true }),
  bounced,
  'client and server trace a bouncing shot differently'
);

// A shot with somewhere to go passes straight through an empty step.
const clear = client.traceShotStep({ ...shotArgs, obstacles: [], ricochet: true });
assert.equal(clear.bounces, 0);
assert.ok(Math.abs(clear.x - 20) < 1e-9);

// The floor is a surface of its own. A shot on its way down bounces off it and
// rises again, and it lands on it when it does not ricochet.
const falling = {
  obstacles: [],
  x: 0,
  y: 2,
  z: 0,
  dirX: 0.6,
  dirY: -0.8,
  dirZ: 0,
  distance: 5,
  radius: client.SHOT_COLLISION_RADIUS,
};
const offGround = client.traceShotStep({ ...falling, ricochet: true });
assert.equal(offGround.bounces, 1, 'the shot bounces off the ground');
assert.ok(offGround.dirY > 0 && offGround.y > 0, 'and is climbing again');
const onGround = client.traceShotStep({ ...falling, ricochet: false });
assert.equal(onGround.ground, true, 'a shot that does not ricochet stops at the floor');
assert.equal(onGround.y, 0);

// A shot cannot spend a step bouncing forever. A corridor two units wide, with
// a step long enough to cross it several times over, is nothing but bounces.
const corridor = [
  { type: 'box', name: 'east', x: 51, z: 0, w: 100, d: 400, h: 10, baseY: 0, rotation: 0 },
  { type: 'box', name: 'west', x: -51, z: 0, w: 100, d: 400, h: 10, baseY: 0, rotation: 0 },
];
const trapped = client.traceShotStep({ ...shotArgs, obstacles: corridor, ricochet: true });
assert.equal(trapped.bounces, client.MAX_SHOT_BOUNCES_PER_STEP, 'the bounce loop runs to its cap');
assert.ok(Math.abs(trapped.x) < 1, 'and leaves the shot inside the corridor');

console.log(`collision geometry tests passed (${checked} fuzz samples, ${solidSamples} solid, seed ${SEED})`);
