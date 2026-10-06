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
//
// Every case is in upstream's frame: +X east, +Y north, +Z up, a heading an
// azimuth counter-clockwise from +X, and an obstacle placed by `pos` (its base
// centre), `size` (half width, half breadth, height) and `angle`.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as client from '../public/collision.mjs';
import { resolveTankMotion } from '../public/motion.mjs';

const require = createRequire(import.meta.url);
const server = require('../server/collision.cjs');
const serverMotion = require('../server/motion.cjs');

const HALF_PI = Math.PI / 2;
// The azimuth of a tank facing north, along +Y.
const NORTH = HALF_PI;

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
  const x = (rand() - 0.5) * 40;
  const y = (rand() - 0.5) * 40;
  const width = 2 + rand() * 20;
  const breadth = 2 + rand() * 20;
  const base = rand() < 0.3 ? rand() * 6 : 0;
  const angle = rand() < 0.5 ? 0 : rand() * Math.PI * 2;
  return {
    type: 'pyramid',
    name: 'fuzz',
    pos: [x, y, base],
    size: [width / 2, breadth / 2, height],
    angle,
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
  const reach = Math.max(obs.size[0], obs.size[1]) + TANK_RADIUS + 2;

  for (let sample = 0; sample < 250; sample += 1) {
    const x = obs.pos[0] + (rand() - 0.5) * 2 * reach;
    const y = obs.pos[1] + (rand() - 0.5) * 2 * reach;
    const z = obs.pos[2] - 2 + rand() * (obs.size[2] + 4);

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
      server.pyramidShrinkFactor(obs, z, TANK_HEIGHT),
      client.pyramidShrinkFactor(obs, z, TANK_HEIGHT),
      `shrink factor diverged (seed ${SEED}) at z=${z.toFixed(3)} for ${JSON.stringify(obs)}`
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
      server.isWithinPyramidFootprint(obs, x, y),
      client.isWithinPyramidFootprint(obs, x, y),
      `footprint containment diverged (seed ${SEED}) at (${x.toFixed(3)}, ${y.toFixed(3)})`
    );

    // Anything solid must be over the footprint or within a tank radius of it,
    // which is what keeps support and collision talking about the same object.
    if (clientSolid && !client.isWithinPyramidFootprint(obs, x, y)) {
      const local = client.getColliderLocalPoint(x, y, obs);
      const outside = Math.hypot(
        Math.max(0, Math.abs(local.x) - obs.size[0]),
        Math.max(0, Math.abs(local.y) - obs.size[1])
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
const upright = { type: 'pyramid', pos: [0, 0, 0], size: [5, 5, 8], angle: 0, inverted: false };
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
assert.equal(client.pyramidIntersectsCylinder(upright, 4.5, -4.5, 7, 2, 2), false);

// Inverted: open low at the edge, solid high where it is full width.
assert.equal(client.pyramidIntersectsCylinder(inverted, 4.9, -4.9, 0, 2, 2), false);
assert.equal(client.pyramidIntersectsCylinder(inverted, 4.5, -4.5, 6, 2, 2), true);

// Entirely above or below never collides.
assert.equal(client.pyramidIntersectsCylinder(upright, 0, 0, 9, 2, 2), false);
assert.equal(client.pyramidIntersectsCylinder(upright, 0, 0, -5, 2, 2), false);

// Inverted pyramids present a flat, drivable top; upright ones do not.
assert.equal(client.isPyramidFlatTop(inverted), true);
assert.equal(client.isPyramidFlatTop(upright), false);

// getPyramidSurfaceLocalHeight is the inverse of pyramidShrinkFactor.
for (const obs of [upright, inverted]) {
  for (const edge of [0, 0.25, 0.5, 0.75, 1]) {
    const localX = edge * obs.size[0];
    const surfaceZ = client.getPyramidSurfaceLocalHeight(obs, localX, 0);
    const shrink = client.pyramidShrinkFactor(obs, obs.pos[2] + surfaceZ, 0);
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
const e_pyr1 = { type: 'pyramid', pos: [340, -45, 0], angle: 0, size: [7.5, 7.5, 26], inverted: false };
const outsideFootprint = client.getPyramidFaceLocalNormal(e_pyr1, 341.95, -52.54, 6.94, 2);
assert.ok(Math.hypot(outsideFootprint.x, outsideFootprint.y, outsideFootprint.z) > 1e-9);

// Every pyramid face angles upward, however steep, which is what makes upstream
// read a landing off it: `normal[2] = width / hypot(height, width)` is above the
// 0.001 doUpdateMotion tests, so no slope sheds a tank and none is driven up.
const steepNormalZ = outsideFootprint.z / Math.hypot(outsideFootprint.x, outsideFootprint.y, outsideFootprint.z);
assert.ok(steepNormalZ > 0.001, `expected e_pyr1 face to angle upward, got normal.z=${steepNormalZ}`);

// Upstream's own hit normal for a tank, which is what the one motion pass reads
// a landing off. Every pyramid face angles upward, so a slope is a surface at
// any steepness -- and the roof of a box is only a surface for a step that
// crossed it going down.
const slope = { type: 'pyramid', name: 'slope', pos: [-80, 80, 0], angle: 0, size: [20, 20, 30], inverted: false };
const faceNormal = client.getTankHitNormal(slope, -70, 80, 15, NORTH, 14.9, TANK_HEIGHT);
assert.ok(faceNormal.z > 0.001, `a pyramid face angles upward, got ${faceNormal.z}`);
assert.ok(faceNormal.x > 0, 'and outward, away from the axis');
assert.ok(Math.abs(Math.hypot(faceNormal.x, faceNormal.y, faceNormal.z) - 1) < 1e-9, 'unit length');

// A needle-thin pyramid still reads as a surface, which is why there is no
// steepness threshold anywhere: upstream tests the normal against 0.001.
const needle = { ...slope, size: [1, 1, 60] };
assert.ok(client.getTankHitNormal(needle, -79.5, 80, 30, NORTH, 29.9, TANK_HEIGHT).z > 0.001);

const roof = { type: 'box', name: 'roof', pos: [0, 0, 0], angle: 0, size: [10, 10, 10] };
const landed = client.getTankHitNormal(roof, 0, 0, 10.5, NORTH, 9.5, TANK_HEIGHT);
assert.deepEqual(landed, { x: 0, y: 0, z: 1 }, 'a step down through a roof lands on it');
const wall = client.getTankHitNormal(roof, 12, 0, 5, NORTH, 5, TANK_HEIGHT);
assert.equal(wall.z, 0, 'a step into a side meets a vertical wall');
assert.ok(wall.x > 0.99, 'facing out along +x');

// Regression: a teleporter's header, hit by a tank jumping up through the
// doorway rather than falling onto the frame's own roof. Treated as a plain
// box, the side normal below came off the outer footprint's edge -- often
// nowhere near where the tank actually was -- which cancelled the wrong
// velocity component and left the tank pinned rising into the header forever
// instead of being turned back down. `activeH` = h - border = 18.88, so 18.5
// is inside the doorway and 19.0 is into the header.
const portal = { type: 'box', kind: 'teleporter', name: 'portal', pos: [0, 0, 0], angle: 0, size: [1, 4.5, 20], border: 1.12 };
const header = client.getTankHitNormal(portal, 0, 0, 18.5, NORTH, 19.0, TANK_HEIGHT);
assert.deepEqual(header, { x: 0, y: 0, z: -1 }, 'jumping into a teleporter header meets a ceiling, not a side wall');

// And a jamb -- outside the doorway's own active depth but still within the
// active height -- reads off the jamb's own pillar (a border-square column,
// findTankObstacle's own solidity test), not the frame's outer footprint or
// its inner doorway edge. y=-4.4 sits near the pillar's own outward face
// (pillarOffset 3.94 + pillarR 0.56 = 4.5), not its centre, so the nearest
// wall is unambiguous.
const jamb = client.getTankHitNormal(portal, 0, -4.4, 10, NORTH, 10, TANK_HEIGHT);
assert.equal(jamb.z, 0, 'a jamb hit is a side wall, not a floor or ceiling');
assert.ok(jamb.y < -0.99, 'facing out along -y, the pillar\'s own outward face');

for (const args of [[slope, -70, 80, 15, NORTH, 14.9, TANK_HEIGHT], [roof, 0, 0, 10.5, NORTH, 9.5, TANK_HEIGHT],
  [roof, 12, 0, 5, NORTH, 5, TANK_HEIGHT], [needle, -79.5, 80, 30, 1 + NORTH, 29.9, TANK_HEIGHT],
  [portal, 0, 0, 18.5, NORTH, 19.0, TANK_HEIGHT], [portal, 0, -4.4, 10, NORTH, 10, TANK_HEIGHT]]) {
  assert.deepEqual(
    server.getTankHitNormal(...args),
    client.getTankHitNormal(...args),
    'client/server tank hit normals diverged'
  );
}

// Regression: a tank jumping into a teleporter's jamb, rather than the door
// -- a corner graze during the fall, not a tank already deep inside the
// pillar. `spanFromY` (testing the candidate height alone rather than
// sweeping from a stale, already-embedded `fromZ`) is what stops the tank
// getting pinned at a fixed height forever; `getSweptSideNormal` (the actual
// ray-swept corner normal, not a static end-of-step read) is what stops the
// grazing hit's tangential slide from pointing back into the same solid
// jamb rather than away from it. This is the exact trajectory a live report
// of the bug produced (SW corner teleporter, default size): jump position,
// heading, and speed at launch, air velocity carried forward frame to frame
// exactly as client.js's setAirVelocity does.
const swPortal = {
  type: 'box', kind: 'teleporter', name: 'swPortal', pos: [-120, -95, 0],
  angle: 4.71238898038469 - Math.PI, size: [0.56, 6.72, 21.28], border: 1.12,
};
function simulateJumpIntoJamb(resolve, findObstacle, hitNormal) {
  let x = -108.85, y = -112.89, z = 0.01, az = 0.23 + HALF_PI;
  let vx = Math.cos(az) * 15, vy = Math.sin(az) * 15;
  let vz = 19.0;
  const dt = 1 / 60;
  for (let frame = 0; frame < 400; frame++) {
    vz -= 9.8 * dt;
    const intendedX = vx * dt;
    const intendedY = vy * dt;
    const result = resolve({
      x, y, z, azimuth: az,
      velocityX: vx, velocityY: vy, velocityZ: vz,
      timeStep: dt,
      groundLimit: 0,
      onGround: false,
      hitTest: (fromX, fromY, fromZ, fromAz, toX, toY, toZ, toAz) =>
        findObstacle([swPortal], toX, toY, toZ, { azimuth: toAz, fromZ, radius: 2, tankScale: null }),
      getNormal: (obs, px, py, pz, paz, hitX, hitY, hitZ, hitAz, fromX, fromY, fromAz, toX, toY, toAz) =>
        hitNormal(obs, px, py, pz, paz, hitZ, TANK_HEIGHT, {
          fromX, fromY, fromAz, toX, toY, toAz, halfWidth: 1.4, halfLength: 3.0,
        }),
      getObstacleTop: () => swPortal.pos[2] + swPortal.size[2],
    });
    // Carries forward the resolver's own velocity when altered, same as
    // client.js's setAirVelocity(myTank, result.velocityX, result.velocityY).
    const altered = Math.abs((result.x - x) - intendedX) > 1e-6 || Math.abs((result.y - y) - intendedY) > 1e-6;
    x = result.x; y = result.y; z = result.z; az = result.azimuth;
    vz = result.velocityZ;
    if (altered) { vx = result.velocityX; vy = result.velocityY; }
    if (z <= 0 && frame > 5) return z;
  }
  return z;
}

const clientJambZ = simulateJumpIntoJamb(resolveTankMotion, client.findTankObstacle, client.getTankHitNormal);
assert.ok(clientJambZ <= 0, `a tank jumping into a teleporter's jamb must fall clear and land, client stuck at z=${clientJambZ}`);
const serverJambZ = simulateJumpIntoJamb(serverMotion.resolveTankMotion, server.findTankObstacle, server.getTankHitNormal);
assert.ok(serverJambZ <= 0, `a tank jumping into a teleporter's jamb must fall clear and land, server stuck at z=${serverJambZ}`);

// Regression: a normal exists everywhere, but support must be contained.
// hix.bzw's inverted "cap" pyramids stand at z=12 with h=2, so their flat top
// is at exactly z=14. When support stopped checking containment, one of them
// held a tank at z=14 from 224 units away, and the tank could not fall
// anywhere on the map.
const cap = { type: 'pyramid', pos: [140, 140, 12], angle: 0, size: [8, 0.5, 2], inverted: true };
assert.equal(client.isWithinPyramidFootprint(cap, 237.41, -61.57), false, 'distant point must not be over the cap');
assert.equal(client.isWithinPyramidFootprint(cap, 140, 140), true, 'centre must be over the cap');
// Still yields a normal there, which is what the slide resolver needs.
const distantNormal = client.getPyramidFaceLocalNormal(cap, 237.41, -61.57, 14, 2);
assert.ok(Math.hypot(distantNormal.x, distantNormal.y, distantNormal.z) > 1e-9);

// Footprint containment respects the angle.
const rotated = { type: 'pyramid', pos: [0, 0, 0], angle: -HALF_PI, size: [8, 1, 5], inverted: false };
assert.equal(client.isWithinPyramidFootprint(rotated, 0, -7), true, 'long axis runs along y when turned 90 degrees');
assert.equal(client.isWithinPyramidFootprint(rotated, 7, 0), false, 'short axis runs along x when turned 90 degrees');

// Rectangle normals: sides, corners, and interior all resolve.
assert.deepEqual(client.getOrigRectNormal(5, 5, 9, 0), { x: 1, y: 0 });
assert.deepEqual(client.getOrigRectNormal(5, 5, -9, 0), { x: -1, y: 0 });
assert.deepEqual(client.getOrigRectNormal(5, 5, 0, 9), { x: 0, y: 1 });
assert.deepEqual(client.getOrigRectNormal(5, 5, 0, -9), { x: 0, y: -1 });
const corner = client.getOrigRectNormal(5, 5, 8, 9);
assert.ok(corner.x > 0 && corner.y > 0 && Math.abs(Math.hypot(corner.x, corner.y) - 1) < 1e-9);
// Inside a long thin rib, resolve to the long face rather than the end cap.
assert.deepEqual(client.getOrigRectNormal(8, 1, 1, 0.5), { x: 0, y: 1 });

// --- Swept motion -----------------------------------------------------------
//
// BoxBuilding::inMovingBox and the roof half of Obstacle::getHitNormal. One
// frame is one step, so a slow frame is a long step; both of these exist so a
// long step is judged by the span it covered rather than by where it ended.

const EPSILON = 0.15;
// A roof at 4.5, the height of a standard box.
const ROOF = 4.5;
const spans = (fromZ, toZ) =>
  client.movingTankOverlapsHeight(0, ROOF, fromZ, toZ, TANK_HEIGHT, EPSILON);

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
const deckSpans = (fromZ, toZ) =>
  client.movingTankOverlapsHeight(DECK_BASE, DECK_TOP, fromZ, toZ, TANK_HEIGHT, EPSILON);
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
for (const [fromZ, toZ] of [[5.4, 3.5], [10.6, 8.1], [8.1, 10.3], [ROOF, ROOF], [24, 0]]) {
  assert.equal(
    server.movingTankOverlapsHeight(0, ROOF, fromZ, toZ, TANK_HEIGHT, EPSILON),
    client.movingTankOverlapsHeight(0, ROOF, fromZ, toZ, TANK_HEIGHT, EPSILON),
    `swept overlap disagrees for ${fromZ} -> ${toZ}`
  );
  assert.equal(
    server.crossedFlatTop(ROOF, fromZ, toZ),
    client.crossedFlatTop(ROOF, fromZ, toZ),
    `roof crossing disagrees for ${fromZ} -> ${toZ}`
  );
}

// --- Shots ------------------------------------------------------------------

// ShotStrategy::reflect. A head-on bounce reverses; a 45 degree one turns the
// shot through a right angle; both keep the speed they came in with.
const wallNormal = { x: -1, y: 0, z: 0 };
const headOn = client.reflectShotDirection(1, 0, 0, wallNormal);
assert.ok(Math.abs(headOn.x + 1) < 1e-12 && Math.abs(headOn.y) < 1e-12, 'head-on bounce reverses');
const glancing = client.reflectShotDirection(
  Math.SQRT1_2, -Math.SQRT1_2, 0, wallNormal
);
assert.ok(Math.abs(glancing.x + Math.SQRT1_2) < 1e-12, 'the component along the normal flips');
assert.ok(Math.abs(glancing.y + Math.SQRT1_2) < 1e-12, 'the component along the surface is kept');
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
  [0.6, 0.77, 0.2, 0, 0, 1],
  [-0.3, -0.95, 0, 0.7071067811865476, 0.7071067811865476, 0],
  [1, 0, 0, 1, 0, 0],
]) {
  assert.deepEqual(
    client.reflectShotDirection(dx, dy, dz, { x: nx, y: ny, z: nz }),
    server.reflectShotDirection(dx, dy, dz, { x: nx, y: ny, z: nz }),
    'client and server reflect a shot differently'
  );
}

// Regression (issue #110): ShotStrategy::getFirstBuilding treats a
// teleporter's frame as an ordinary building, and Teleporter::getNormal
// answers off the nearest border column -- a ricocheting shot bounces off a
// teleporter frame the same as any wall, not just off the border-square jamb
// bzo's tank code already knew about (see the `jamb` case above).
const shotPortal = { type: 'box', kind: 'teleporter', name: 'portal', pos: [0, 0, 0], angle: 0, size: [0.56, 4.48, 20.16], border: 1.12 };
// Half width 0.56 (the frame's own +x face); half breadth 4.48, so y = -4.0
// sits in the pillar band rather than the doorway (activeHalfD = 3.36).
const frameNormal = client.getShotObstacleNormal(shotPortal, 0.56, -4.0, 2, 0.5);
assert.equal(frameNormal.z, 0, 'a frame hit below the header is a side hit, not a floor or ceiling');
assert.ok(frameNormal.x > 0.99, 'facing out along +x, the pillar\'s own outward face');
assert.deepEqual(
  server.getShotObstacleNormal(shotPortal, 0.56, -4.0, 2, 0.5),
  frameNormal,
  'client and server disagree on a teleporter frame\'s ricochet normal'
);
const frameBounce = client.reflectShotDirection(-1, 0, 0, frameNormal);
assert.ok(frameBounce.x > 0.99, 'a shot flying straight at the frame bounces straight back');

// A shot fired down the x axis into a box turns around and comes back, and it
// stops at the wall instead when the shot does not ricochet.
const shotBox = [{ type: 'box', name: 'wall', pos: [20, 0, 0], size: [2, 20, 10], angle: 0 }];
const shotArgs = {
  obstacles: shotBox,
  x: 0,
  y: 0,
  z: 2.2,
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
  y: 0,
  z: 2,
  dirX: 0.6,
  dirY: 0,
  dirZ: -0.8,
  distance: 5,
  radius: client.SHOT_COLLISION_RADIUS,
};
const offGround = client.traceShotStep({ ...falling, ricochet: true });
assert.equal(offGround.bounces, 1, 'the shot bounces off the ground');
assert.ok(offGround.dirZ > 0 && offGround.z > 0, 'and is climbing again');
const onGround = client.traceShotStep({ ...falling, ricochet: false });
assert.equal(onGround.ground, true, 'a shot that does not ricochet stops at the floor');
assert.equal(onGround.z, 0);

// A shot cannot spend a step bouncing forever. A corridor two units wide, with
// a step long enough to cross it several times over, is nothing but bounces.
const corridor = [
  { type: 'box', name: 'east', pos: [51, 0, 0], size: [50, 200, 10], angle: 0 },
  { type: 'box', name: 'west', pos: [-51, 0, 0], size: [50, 200, 10], angle: 0 },
];
const trapped = client.traceShotStep({ ...shotArgs, obstacles: corridor, ricochet: true });
assert.equal(trapped.bounces, client.MAX_SHOT_BOUNCES_PER_STEP, 'the bounce loop runs to its cap');
assert.ok(Math.abs(trapped.x) < 1, 'and leaves the shot inside the corridor');

// A wall built from thin stacked slices (bzo.bzw's `stack1`..`stack10`, 0.25
// units each) must still bounce a level shot off its side, the same as one
// solid wall would -- SHOT_VERTICAL_EPSILON eating a whole slice's height from
// both ends at once let a side hit misread as already past the top, and
// reflecting a level shot (no vertical component to flip) off that all-up
// normal was a silent no-op indistinguishable from passing straight through.
{
  const slice = {
    type: 'box', name: 'stack7', pos: [80, -65, 1.5], size: [8, 8, 0.25], angle: 0,
  };
  const level = client.traceShotStep({
    obstacles: [slice],
    x: 80, y: -40, z: 1.6,
    dirX: 0, dirY: -1, dirZ: 0,
    distance: 30,
    radius: client.SHOT_COLLISION_RADIUS,
    ricochet: true,
    groundLimit: -1000,
  });
  assert.equal(level.bounces, 1, 'a level shot bounces off a thin stacked slice');
  assert.ok(level.dirY > 0, 'and actually reverses course rather than passing through');
}

// findShotSegmentImpact answers over a segment of any length, which is what a
// beam needs: bisecting from the far end only finds an obstacle the far end is
// inside, so a 35000-unit laser through a wall four units thick needs the ray
// test rather than findShotImpact's own occupant-cylinder bisection to avoid
// sailing through it and leaving the world. A box is exempt from that
// limitation either way -- findShotImpact resolves it with the same exact
// bare-ray test findShotSegmentImpact does, over the same 35000-unit reach,
// since a box has no volume for a bisection to need to already be inside of
// (#94) -- so this exercises a pyramid instead, which still relies on it.
{
  const wall = { type: 'box', name: 'wall', pos: [100, 0, 0], size: [2, 200, 20], angle: 0 };
  const from = { x: 0, y: 0, z: 1.5 };
  const far = { x: 35000, y: 0, z: 1.5 };
  const radius = client.SHOT_COLLISION_RADIUS;

  const farBoxImpact = client.findShotImpact(
    [wall], from.x, from.y, from.z, far.x, far.y, far.z, radius
  );
  assert.ok(farBoxImpact, 'a box is found however far past it the segment reaches');
  assert.equal(farBoxImpact.obstacle, wall);

  const slope = {
    type: 'pyramid', name: 'slope', pos: [100, 0, 0], size: [2, 200, 20], angle: 0,
  };
  assert.equal(
    client.findShotImpact(
      [slope], from.x, from.y, from.z, far.x, far.y, far.z, radius
    ),
    null,
    'the bisection still cannot see a pyramid the far end is past'
  );

  const impact = client.findShotSegmentImpact([wall], from, far, radius);
  assert.ok(impact, 'the ray test finds it however far the segment reaches');
  assert.equal(impact.obstacle, wall);
  const hitX = from.x + ((far.x - from.x) * impact.fraction);
  assert.ok(hitX > 97 && hitX <= 98, `stops just short of the wall face, got ${hitX}`);

  // The nearest wall wins, whatever order the obstacles are in.
  const nearer = { ...wall, name: 'nearer', pos: [40, 0, 0] };
  for (const obstacles of [[wall, nearer], [nearer, wall]]) {
    const first = client.findShotSegmentImpact(obstacles, from, far, radius);
    assert.equal(first.obstacle.name, 'nearer', 'the nearest obstacle is the one that is hit');
  }

  // A segment that stops short of the wall reaches nothing.
  assert.equal(
    client.findShotSegmentImpact([wall], from, { x: 50, y: 0, z: 1.5 }, radius),
    null,
    'a segment that ends before the wall does not hit it'
  );

  // A wall the beam passes over, and one it passes under.
  assert.equal(
    client.findShotSegmentImpact([wall], { x: 0, y: 0, z: 30 }, { x: 35000, y: 0, z: 30 }, radius),
    null,
    'a beam above a wall clears it'
  );
  assert.equal(
    client.findShotSegmentImpact(
      [{ ...wall, pos: [100, 0, 10] }], from, far, radius
    ),
    null,
    'and one under a raised wall goes beneath it'
  );

  // A rotated wall is tested in its own frame, and a pyramid is refined inside
  // its bounding box rather than taken as the box.
  const turned = { ...wall, name: 'turned', angle: Math.PI / 4 - Math.PI };
  assert.ok(client.findShotSegmentImpact([turned], from, far, radius), 'a rotated wall still stops it');
  const pyramid = {
    type: 'pyramid', name: 'pyr', pos: [100, 0, 0], size: [10, 10, 20], angle: 0,
  };
  assert.ok(
    client.findShotSegmentImpact([pyramid], from, far, radius),
    'a beam at the foot of a pyramid meets its slope'
  );
  // Near the tip the cross-section has shrunk to a column a unit across, so a
  // beam eight units off the axis crosses the pyramid's bounding box and misses
  // the solid inside it -- which is the case the interval walk exists for.
  assert.equal(
    client.findShotSegmentImpact(
      [pyramid], { x: 0, y: -8, z: 19 }, { x: 35000, y: -8, z: 19 }, radius
    ),
    null,
    'and one level with its tip passes beside it'
  );
  assert.ok(
    client.getShotObstacleInterval(pyramid, { x: 0, y: -8, z: 19 }, { x: 35000, y: -8, z: 19 }, radius),
    'even though it crossed the bounding box'
  );

  // The two copies agree, as ever.
  assert.deepEqual(
    server.findShotSegmentImpact([nearer, wall, turned, pyramid], from, far, radius),
    client.findShotSegmentImpact([nearer, wall, turned, pyramid], from, far, radius),
    'client and server ray impact diverged'
  );
  assert.deepEqual(
    server.getShotObstacleInterval(wall, from, far, radius),
    client.getShotObstacleInterval(wall, from, far, radius),
    'client and server obstacle interval diverged'
  );
}

// _wallHeight and the two flags the world border is expressed with. Upstream's
// border is one WallObstacle: an infinite plane to a tank, only _wallHeight tall
// to a bouncing shot, which flies over it rather than back into the arena.
{
  assert.equal(client.TANK_HEIGHT, 2.05, '_tankHeight');
  assert.ok(
    Math.abs(client.WORLD_WALL_HEIGHT - (3 * 2.05)) < 1e-9,
    '_wallHeight is 3.0 * _tankHeight'
  );
  assert.equal(server.WORLD_WALL_HEIGHT, client.WORLD_WALL_HEIGHT);

  // The border as bzo builds it: a barrier taller than any map that stops tanks
  // and is `shootThrough`, and in front of it the visible wall, `_wallHeight`
  // tall, that stops shots and is `driveThrough`.
  const barrier = {
    type: 'box', name: 'barrier', collisionKind: 'boundary', shootThrough: true,
    pos: [100, 0, 0], size: [2, 200, 1000], angle: 0,
  };
  const solid = {
    ...barrier, name: 'wall', shootThrough: false, driveThrough: true,
    size: [2, 200, client.WORLD_WALL_HEIGHT],
  };
  const border = [barrier, solid];
  const radius = client.SHOT_COLLISION_RADIUS;

  // Low down the wall is there for a shot; high up only the barrier is, and a
  // shoot-through obstacle is not an obstacle a shot can meet at all.
  const low = { from: { x: 0, y: 0, z: 2 }, to: { x: 35000, y: 0, z: 2 } };
  const high = { from: { x: 0, y: 0, z: 40 }, to: { x: 35000, y: 0, z: 40 } };
  assert.equal(
    client.findShotSegmentImpact(border, low.from, low.to, radius).obstacle.name,
    'wall',
    'a shot at tank height meets the wall'
  );
  assert.equal(
    client.findShotSegmentImpact(border, high.from, high.to, radius),
    null,
    'and one above the wall passes through the barrier over it'
  );
  assert.equal(
    client.findShotObstacle(border, 101, 0, 40, radius),
    null,
    'a shoot-through obstacle never counts as one a shot is inside'
  );
  // Which is what stops a bouncing shot being thrown back into the arena from
  // an altitude no wall reaches: makeSegments ignores that hit outright. The
  // step ends inside the wall's own span, which is the only kind of step
  // traceShotStep can answer for.
  const atBorder = {
    obstacles: border, x: 90, y: 0, dirX: 1, dirY: 0, dirZ: 0,
    distance: 10, radius, ricochet: true,
  };
  const overTheTop = client.traceShotStep({ ...atBorder, z: 40 });
  assert.equal(overTheTop.bounces, 0, 'a bouncing shot above the wall does not bounce');
  assert.ok(overTheTop.x >= 100, 'it carries on past the border');
  const intoTheWall = client.traceShotStep({ ...atBorder, z: 2 });
  assert.equal(intoTheWall.bounces, 1, 'and one at tank height bounces off the wall');
  assert.ok(intoTheWall.dirX < 0, 'back into the arena');

  // Each collider does one job and stands aside from the other, so no collision
  // code has to reason about the visible wall's roof -- which upstream's
  // WallObstacle does not have at all, getHitNormal only ever answering with the
  // plane. Tanks are held by the barrier at the same inner edge either way.
  assert.equal(solid.driveThrough, true, 'the visible wall is the shot collider only');
  assert.equal(barrier.shootThrough, true, 'and the barrier is the tank collider only');
  assert.equal(barrier.pos[2] + barrier.size[2], 1000, 'taller than any map bzo has to hold');
  assert.deepEqual(solid.pos, barrier.pos, 'both stand on the same ground');
  assert.equal(solid.size[0], barrier.size[0]);
  // The geometry is solid either way; the flags decide who meets it.
  assert.ok(client.shotInsideObstacle(barrier, 101, 0, 40, radius), 'the barrier is solid geometry');
}

// Obstacle::canRicochet -- `ricochet` in a `.bzw`. An obstacle that declares
// itself bouncy reflects an ordinary shot, which is separate from the world
// switch and from the flag.
{
  const plain = { type: 'box', name: 'plain', pos: [20, 0, 0], size: [2, 20, 10], angle: 0 };
  const bouncy = { ...plain, name: 'bouncy', ricochet: true };
  // The step has to end inside the wall for traceShotStep to see it at all.
  const shot = { x: 0, y: 0, z: 2, dirX: 1, dirY: 0, dirZ: 0, distance: 20, radius: client.SHOT_COLLISION_RADIUS };

  const stopped = client.traceShotStep({ ...shot, obstacles: [plain], ricochet: false });
  assert.equal(stopped.bounces, 0, 'an ordinary shot stops at an ordinary wall');
  assert.equal(stopped.obstacle.name, 'plain');

  const bounced = client.traceShotStep({ ...shot, obstacles: [bouncy], ricochet: false });
  assert.equal(bounced.bounces, 1, 'and bounces off one that declares itself bouncy');
  assert.equal(bounced.obstacle, null);
  assert.ok(bounced.dirX < 0, 'heading back the way it came');

  assert.deepEqual(
    server.traceShotStep({ ...shot, obstacles: [bouncy], ricochet: false }),
    bounced,
    'client and server per-obstacle ricochet diverged'
  );
}

// The dimension flags. testOrigRectTank takes the tank's scale, and a scale of 1 has to be
// exactly what the unscaled call already answered or every existing collision
// moves.
{
  const box = { pos: [0, 0, 0], size: [5, 5, 10], angle: 0 };
  const cases = [
    [0, 0], [6, 0], [0, 6], [5.8, 5.8], [8, 0], [0, 12], [4.5, 4.5],
  ];
  for (const [px, py] of cases) {
    for (const angle of [0, 0.4, Math.PI / 2, 2.2]) {
      const plain = client.testOrigRectTank(box.size[0], box.size[1], px, py, angle);
      assert.equal(
        client.testOrigRectTank(box.size[0], box.size[1], px, py, angle, 0, { length: 1, width: 1 }),
        plain,
        `a unit scale changed the answer at ${px},${py} angle ${angle}`
      );
      assert.equal(
        server.testOrigRectTank(box.size[0], box.size[1], px, py, angle, 0, { length: 1, width: 1 }),
        plain,
        `client/server scaled tank box diverged at ${px},${py}`
      );
    }
  }

  // A tiny tank fits where a full one does not; an obese one does not fit where
  // a full one does. Tested end-on, the tank facing along local +y, so the
  // length axis is the one that decides.
  const tiny = { length: 0.4, width: 0.4 };
  const obese = { length: 2.5, width: 2.5 };
  const justOutside = (client.TANK_HALF_LENGTH + 5) - 0.2;
  assert.equal(
    client.testOrigRectTank(5, 5, 0, justOutside, NORTH),
    true,
    'a full-size tank overlaps just inside its own length'
  );
  assert.equal(
    client.testOrigRectTank(5, 5, 0, justOutside, NORTH, 0, tiny),
    false,
    'a tiny tank no longer reaches'
  );
  assert.equal(
    client.testOrigRectTank(5, 5, 0, (client.TANK_HALF_LENGTH + 5) + 2, NORTH, 0, obese),
    true,
    'an obese tank reaches further than a full one'
  );
}

// getSegmentBoxHitFraction: the Narrow hit shape. Held against the geometry
// rather than against upstream's timeRayHitsBlock, which works in time over a
// ray; the shape and the answer are the same question. The box's azimuth runs
// along its length, so facing north it is narrow across x and long along y.
{
  const half = 1;
  const long = 3;
  // Straight through the middle, across the narrow axis: enters at the near face.
  const across = client.getSegmentBoxHitFraction(-10, 0, 10, 0, 0, 0, NORTH, half, long);
  assert.ok(Math.abs(across - ((10 - half) / 20)) < 1e-9, `across gave ${across}`);
  // Along the long axis: enters at the near end.
  const along = client.getSegmentBoxHitFraction(0, 10, 0, -10, 0, 0, NORTH, half, long);
  assert.ok(Math.abs(along - ((10 - long) / 20)) < 1e-9, `along gave ${along}`);
  // Starting inside strikes where it started, as the cylinder path does.
  assert.equal(client.getSegmentBoxHitFraction(0, 0, 10, 0, 0, 0, NORTH, half, long), 0);
  // Missing entirely, on each axis.
  assert.equal(client.getSegmentBoxHitFraction(-10, -5, 10, -5, 0, 0, NORTH, half, long), null);
  assert.equal(client.getSegmentBoxHitFraction(-10, 0, -5, 0, 0, 0, NORTH, half, long), null);
  // A quarter turn swaps which extent the segment meets.
  const turned = client.getSegmentBoxHitFraction(-10, 0, 10, 0, 0, 0, NORTH - Math.PI / 2, half, long);
  assert.ok(Math.abs(turned - ((10 - long) / 20)) < 1e-9, `turned gave ${turned}`);

  for (const args of [
    [-10, 0, 10, 0, 0, 0, NORTH, half, long],
    [0, 10, 0, -10, 0, 0, NORTH - 0.7, half, long],
    [-10, -5, 10, -5, 0, 0, NORTH, half, long],
  ]) {
    assert.deepEqual(
      server.getSegmentBoxHitFraction(...args),
      client.getSegmentBoxHitFraction(...args),
      'client/server segment box test diverged'
    );
  }
}

// A height of zero is a real height, not a missing one. This is the whole reason
// getObstacleHeight exists: `obs.h || 4` read a flat `base` -- upstream's own
// CustomBase default, a pad painted on the ground -- as a four-unit block that
// stopped shots and hid the ground under it.
{
  const flatBase = { kind: 'base', type: 'box', pos: [0, 0, 0], size: [20, 20, 0], angle: 0 };
  assert.equal(client.getObstacleHeight(flatBase), 0, 'a flat base is flat');
  assert.equal(client.getBaseTop(flatBase), 0, 'and its top surface is the ground');
  assert.equal(client.isOnBaseTop(flatBase, 0, 0, 0), true, 'a tank on the ground is on it');
  // The shot test is the one `obs.h || 4` got wrong: a shot at muzzle height
  // crossing a flat base has nothing to hit.
  assert.equal(
    client.shotInsideObstacle(flatBase, 0, 0, 1.57, client.SHOT_COLLISION_RADIUS),
    false,
    'a shot flies across a flat base'
  );
  assert.equal(client.getShotObstacleInterval(
    flatBase, { x: -60, y: 0, z: 1.57 }, { x: 60, y: 0, z: 1.57 }, client.SHOT_COLLISION_RADIUS
  ), null, 'and never enters it');

  // An obstacle whose map gave no size at all is the case the fallback is for,
  // and it keeps the answer it always had.
  assert.equal(client.getObstacleHeight({ type: 'box' }), client.DEFAULT_OBSTACLE_HEIGHT);
  assert.equal(client.getObstacleHeight({ type: 'box', size: [1, 1, undefined] }), 4);
  assert.equal(client.getObstacleHeight({ type: 'box', size: [1, 1, NaN] }), 4);
  // A real height still answers for itself.
  assert.equal(client.getObstacleHeight({ type: 'box', size: [1, 1, 10] }), 10);
  assert.equal(server.getObstacleHeight(flatBase), client.getObstacleHeight(flatBase),
    'client/server obstacle height diverged');
}

// Phasing. `OO` is not expelled by a building, which is the whole of
// driving through one, and is still expelled by the three things upstream names.
{
  const box = { type: 'box', name: 'box', pos: [0, 0, 0], size: [5, 5, 10], angle: 0 };
  const pyramid = { type: 'pyramid', name: 'pyr', pos: [0, 0, 0], size: [5, 5, 10], angle: 0 };
  const boundary = { type: 'box', name: 'boundary_north', collisionKind: 'boundary', pos: [0, 0, 0], size: [5, 2, 1000], angle: 0 };
  const teleporter = { type: 'box', kind: 'teleporter', name: 'portal', pos: [0, 0, 0], size: [1, 4.5, 20], border: 1.12, angle: 0 };

  assert.equal(client.phasedObstacleExpels(box), false, 'a phased tank drives through a box');
  assert.equal(client.phasedObstacleExpels(pyramid), false, 'and through a pyramid');
  assert.equal(client.phasedObstacleExpels(boundary), true, 'the world border is still a wall');
  assert.equal(client.phasedObstacleExpels(teleporter), true, 'and a teleporter is still crossed');
  // The third term: reversing at ground level is what stops a tank backing into
  // a building it is not yet inside, and it applies to every obstacle.
  assert.equal(client.phasedObstacleExpels(box, true), true, 'reversing on the ground expels');
  assert.equal(client.phasedObstacleExpels(pyramid, true), true, 'whatever the obstacle is');
  assert.equal(client.phasedObstacleExpels(null), false, 'nothing expels nobody');

  for (const obs of [box, pyramid, boundary, teleporter, null]) {
    for (const reversing of [false, true]) {
      assert.equal(
        server.phasedObstacleExpels(obs, reversing),
        client.phasedObstacleExpels(obs, reversing),
        'client/server phasing diverged'
      );
    }
  }
}

// The crossing plane, which feeds the tank clip plane and the interdimensional
// lights. What matters is the sign convention -- positive outside -- because a
// clip plane with it backwards cuts away the half that should be visible.
{
  const box = { pos: [0, 0, 0], size: [5, 5, 5], angle: 0 };
  const signedDistance = (plane, x, y, z) =>
    plane.x * x + plane.y * y + plane.z * z + plane.d;

  // Straddling the +x wall: the tank is 2.8 across facing north, so at x = 5
  // it has 1.4 outside and 1.4 in.
  const plane = client.getBoxCrossingPlane(box, 5, 0, 0, NORTH);
  assert.ok(plane, 'a tank half in the wall is crossing it');
  assert.equal(Math.hypot(plane.x, plane.y, plane.z).toFixed(6), '1.000000', 'unit normal');
  assert.ok(signedDistance(plane, 6.4, 0, 0) > 0, 'the outside half is positive');
  assert.ok(signedDistance(plane, 3.6, 0, 0) < 0, 'the buried half is negative');
  assert.equal(signedDistance(plane, 5, 0, 0).toFixed(6), '0.000000', 'zero on the wall');

  // Swallowed whole: no wall to hang lights off, so no plane. This is the case
  // that makes the effect blink out in the middle of a thick building.
  assert.equal(client.getBoxCrossingPlane(box, 0, 0, 0, NORTH), null, 'fully inside is not crossing');
  assert.equal(client.getBoxCrossingPlane(box, 20, 0, 0, NORTH), null, 'clear of it is not crossing');
  // inBox's height term: driving over a low wall is not driving through it.
  assert.equal(client.getBoxCrossingPlane(box, 5, 0, 6, NORTH), null, 'above it is not crossing');
  assert.equal(client.getBoxCrossingPlane(box, 5, 0, -3, NORTH), null, 'below it is not crossing');

  // The nearer wall wins. At the -y face the normal turns to -y, which is the
  // guess upstream admits to making and the only thing distinguishing the two.
  const yPlane = client.getBoxCrossingPlane(box, 0, -5, 0, Math.PI);
  assert.ok(yPlane, 'crossing the -y wall');
  assert.ok(yPlane.y < -0.99, 'and the normal points out along -y');

  // A rotated box turns its walls with it. A square box cannot show this --
  // rotating one by a quarter turn leaves the same box -- so this is a long thin
  // one, straddled on its narrow face, with the whole arrangement turned a
  // quarter turn clockwise. The same local wall then faces along world -y
  // instead of +x.
  const slab = { pos: [0, 0, 0], size: [2, 10, 5], angle: 0 };
  const flat = client.getBoxCrossingPlane(slab, 2, 0, 0, NORTH);
  assert.ok(flat && flat.x > 0.99, 'the narrow wall faces +x unrotated');
  const turned = { ...slab, angle: -HALF_PI };
  const turnedPlane = client.getBoxCrossingPlane(turned, 0, -2, 0, Math.PI);
  assert.ok(turnedPlane, 'a rotated box still has walls');
  assert.ok(turnedPlane.y < -0.99, 'and the same wall now faces -y');
  assert.ok(Math.abs(turnedPlane.x) < 0.01, 'with nothing left on the old axis');

  // A pyramid tilts the plane to its slope, which is what makes the lights lie
  // along the face rather than standing vertically in it.
  const pyramid = { type: 'pyramid', pos: [0, 0, 0], size: [5, 5, 5], angle: 0 };
  const slope = client.getBoxCrossingPlane(pyramid, 4, 0, 0, NORTH);
  assert.ok(slope, 'a tank in a pyramid face is crossing it');
  assert.ok(slope.z > 0, 'the pyramid plane leans back over the slope');
  assert.equal(Math.hypot(slope.x, slope.y, slope.z).toFixed(6), '1.000000', 'still unit length');
  // The box case never leans, whatever the tank is doing.
  assert.equal(plane.z, 0, 'a box wall is vertical');

  // Containment on its own, since it is the half of the test that is easy to
  // get backwards: a tank inside is contained, one hanging over an edge is not.
  assert.equal(client.tankRectInsideOrigRect(10, 10, 0, 0, NORTH), true, 'well inside');
  assert.equal(client.tankRectInsideOrigRect(1, 1, 0, 0, NORTH), false, 'bigger than the box');

  for (const args of [[box, 5, 0, 0, NORTH], [box, 0, 0, 0, NORTH], [pyramid, 4, 0, 0, NORTH]]) {
    assert.deepEqual(
      server.getBoxCrossingPlane(...args),
      client.getBoxCrossingPlane(...args),
      'client/server crossing planes diverged'
    );
  }
}

// getMeshCrossingPlane owes the box version's "entirely inside is not
// crossing" answer (#98). A phasing tank standing on a solid's own floor face
// is the case that made this matter: the face is a real hit, its outward
// normal points straight down through the ground, and clipping the tank to
// the outward half of that plane cuts away all of it -- the tank vanishes and
// its flag hangs in the air alone.
{
  // A closed hollow cube as a mesh: x/y in [-10, 10], z in [0, 20]. Face
  // planes are [nx, ny, nz, d] with the outward normal and d = -(n . vertex),
  // the same convention server.js's computeMeshFacePlane writes.
  const vertices = [];
  for (const z of [0, 20]) for (const y of [-10, 10]) for (const x of [-10, 10]) vertices.push({ x, y, z });
  const at = (x, y, z) => vertices.findIndex((p) => p.x === x && p.y === y && p.z === z);
  const quad = (corners, plane) => ({ vertexIndices: corners.map((c) => at(...c)), plane });
  const cube = {
    type: 'mesh',
    phydrv: null,
    vertices,
    faces: [
      quad([[-10, 10, 0], [10, 10, 0], [10, -10, 0], [-10, -10, 0]], [0, 0, -1, 0]),
      quad([[-10, 10, 20], [10, 10, 20], [10, -10, 20], [-10, -10, 20]], [0, 0, 1, -20]),
      quad([[-10, 10, 0], [-10, 10, 20], [-10, -10, 20], [-10, -10, 0]], [-1, 0, 0, -10]),
      quad([[10, 10, 0], [10, 10, 20], [10, -10, 20], [10, -10, 0]], [1, 0, 0, -10]),
      quad([[-10, 10, 0], [10, 10, 0], [10, 10, 20], [-10, 10, 20]], [0, 1, 0, -10]),
      quad([[-10, -10, 0], [10, -10, 0], [10, -10, 20], [-10, -10, 20]], [0, -1, 0, -10]),
    ],
    bounds: { minX: -10, maxX: 10, minY: -10, maxY: 10, minZ: 0, maxZ: 20 },
  };

  // Standing on the floor inside: every corner of the tank is on the inward
  // side of the floor's own plane, so there is nothing to straddle.
  assert.equal(
    client.getMeshCrossingPlane(cube, 0, 0, 0, NORTH), null,
    'a tank resting on a mesh floor is inside it, not crossing it'
  );
  assert.equal(client.getMeshCrossingPlane(cube, 3, 2, 0, 1 + NORTH), null, 'and off-centre and turned');

  // Half in the +x wall still is, which is the effect this feeds.
  const crossing = client.getMeshCrossingPlane(cube, 9.5, 0, 0, NORTH);
  assert.ok(crossing, 'straddling a mesh wall is still crossing it');
  assert.ok(crossing.x > 0.99, 'and the normal still points out through that wall');

  for (const args of [[cube, 0, 0, 0, NORTH], [cube, 3, 2, 0, 1 + NORTH], [cube, 9.5, 0, 0, NORTH]]) {
    assert.deepEqual(
      server.getMeshCrossingPlane(...args),
      client.getMeshCrossingPlane(...args),
      'client/server mesh crossing planes diverged'
    );
  }
}

// resolvePhysicsDriverAt: the one lookup both the client's motion step and
// the server's anti-cheat call use, so they must agree exactly. A plain
// obstacle answers with its own `.phydrv`; a mesh needs its specific face
// resolved first, since `phydrv` is a per-face property there.
{
  const driver = { name: 'conveyor', linear: [1, 0, 2], death: null };
  const box = { type: 'box', phydrv: driver };
  assert.equal(client.resolvePhysicsDriverAt(box, 0, 0, 0), driver);
  assert.equal(server.resolvePhysicsDriverAt(box, 0, 0, 0), driver);
  assert.equal(client.resolvePhysicsDriverAt(null, 0, 0, 0), null);
  assert.equal(client.resolvePhysicsDriverAt({ type: 'box' }, 0, 0, 0), null);

  // A single horizontal square face at z=5, spanning x/y in [-10, 10] --
  // plane = [nx, ny, nz, d] with d = -(n . vertex), the same formula
  // server.js's own `computeMeshFacePlane` uses.
  const meshVertices = [
    { x: -10, y: 10, z: 5 }, { x: 10, y: 10, z: 5 },
    { x: 10, y: -10, z: 5 }, { x: -10, y: -10, z: 5 },
  ];
  const driverFace = { vertexIndices: [0, 1, 2, 3], plane: [0, 0, 1, -5], phydrv: driver };
  const plainFace = { vertexIndices: [0, 1, 2, 3], plane: [0, 0, 1, -5], phydrv: null };
  const mesh = {
    type: 'mesh',
    phydrv: null,
    vertices: meshVertices,
    faces: [driverFace],
    bounds: { minX: -10, maxX: 10, minY: -10, maxY: 10, minZ: 5, maxZ: 5 },
  };
  assert.equal(client.resolvePhysicsDriverAt(mesh, 0, 0, 5), driver, 'standing over the driver face');
  assert.equal(server.resolvePhysicsDriverAt(mesh, 0, 0, 5), driver, 'server agrees');
  assert.equal(client.resolvePhysicsDriverAt(mesh, 100, -100, 5), null, 'off the mesh entirely');

  // A face's own `phydrv` falls back to the mesh's top-level default when
  // it has none of its own -- the same default every mesh face already
  // inherits at parse time (server.js's `currentMeshFace` construction).
  const meshWithDefault = { ...mesh, faces: [plainFace], phydrv: driver };
  assert.equal(client.resolvePhysicsDriverAt(meshWithDefault, 0, 0, 5), driver);

  // `findMeshFaceAt` finds a face regardless of its passability flags --
  // the opposite of `findMeshHitFace`, which is asked "what stopped this
  // tank" and so must skip a `driveThrough` face. A river's push comes from
  // exactly such a face.
  const driveThroughFace = { ...driverFace, driveThrough: true };
  const driveThroughMesh = { ...mesh, faces: [driveThroughFace] };
  // A face is named by its index in the mesh now rather than by its object,
  // and -1 is "no face" -- index zero being a real face and a falsy number
  // (issue #153).
  assert.equal(client.findMeshFaceAt(driveThroughMesh, 0, 0, 5, 2, 2), 0);
  assert.equal(client.findMeshHitFace(driveThroughMesh, 0, 0, 5, 2, 2), -1, 'a hit-normal query still skips it');
  assert.equal(server.findMeshFaceAt(driveThroughMesh, 0, 0, 5, 2, 2), 0, 'server agrees');
  assert.equal(client.findMeshFaceAt(driveThroughMesh, 100, -100, 5, 2, 2), -1, 'and off the mesh is no face');

  // An exact ray crossing names its face by index too. It used to hand back
  // the face object, which `getMeshHitNormal` could not read as a face at all
  // -- so a ricochet quietly fell back to the static touching test, which is
  // the ambiguity passing the exact face exists to avoid. Nothing caught it,
  // hence this.
  const solidMesh = { ...mesh, faces: [{ ...driverFace, driveThrough: false }] };
  const crossed = client.findMeshFaceCrossing(solidMesh, 0, 0, 20, 0, 0, -20, 0.5);
  assert.ok(crossed, 'a ray straight down crosses the floor');
  assert.equal(typeof crossed.face, 'number', 'and names that face by index');
  assert.deepEqual(
    server.findMeshFaceCrossing(solidMesh, 0, 0, 20, 0, 0, -20, 0.5),
    crossed,
    'server agrees',
  );
  // And the normal that comes back is the face's own, not the straight-up
  // last resort the fallback gives.
  const ricochet = client.getShotObstacleNormal(solidMesh, 0, 0, 5, 0.5, crossed.face);
  assert.ok(Math.abs(ricochet.z) > 0.99, 'reflecting off the floor uses the floor\'s own normal');
}

// A bare point -- a radius of 0 -- inside a rectangle is inside it
// (Intersect.cxx:125), so a pilot's sight line meets a pyramid rather than
// passing straight through it.
for (const side of [client, server]) {
  assert.equal(side.testOrigRectCircle(1, 1, -0.2, -0.3, 0), true);
  assert.equal(side.testOrigRectCircle(1, 1, -1.5, 0, 0), false);
}
{
  const pyramid = { type: 'pyramid', name: 'p', pos: [0, 0, 0], size: [2, 2, 18], angle: 0 };
  assert.ok(client.findShotSegmentImpact([pyramid], { x: 0, y: -10, z: 1 }, { x: 0, y: 10, z: 1 }, 0),
    'a radius-0 ray through a pyramid hits it');
}

// The world's border: a shoot-through barrier and a drive-through wall a side,
// none on a map with no walls, after the map's own obstacles.
{
  const border = client.buildWorldBorderColliders(400);
  assert.equal(border.length, 8);
  assert.equal(border.filter((c) => c.shootThrough && c.size[2] === 1000).length, 4, 'four tank barriers');
  assert.equal(border.filter((c) => c.driveThrough && c.size[2] === client.WORLD_WALL_HEIGHT).length, 4, 'four shot walls');
  assert.ok(border.every((c) => Math.max(Math.abs(c.pos[0]), Math.abs(c.pos[1])) === 202), 'just outside the map');
  assert.deepEqual(client.buildWorldBorderColliders(400, true), []);
  const low = client.buildWorldBorderColliders(400, false, 0);
  assert.equal(low.length, 4, 'a 0-high wall leaves only the tank barrier');
  assert.ok(low.every((c) => c.shootThrough));
  assert.ok(client.buildWorldBorderColliders(400, false, 20).filter((c) => c.driveThrough).every((c) => c.size[2] === 20));
  const box = { type: 'box', pos: [0, 0, 0], size: [0.5, 0.5, 1], angle: 0 };
  assert.equal(client.buildCollisionColliders([box], 400)[0], box);
}
console.log(`collision geometry tests passed (${checked} fuzz samples, ${solidSamples} solid, seed ${SEED})`);
