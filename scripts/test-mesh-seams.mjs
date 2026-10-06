#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Driving from one mesh's flat top onto another's. Two meshes that meet at the
// same height are the case no single obstacle can show: a box answers from
// `findTankObstacle`'s own early return, before any face is ranked, so a box
// beside anything hides every ordering bug this file is about. It takes two
// meshes to reach `pickPriorityMeshCandidate` at all.
//
// The fixtures are built here rather than read from a map, so a failure names a
// shape and not a map that may since have moved. They are the two real ones:
//
//   - abutting: two decks sharing a whole edge, `bzo.bzw`'s own hexagon
//     honeycomb reduced to the part that matters. A tank crossing the seam sinks
//     a few thousandths of a unit below the shared top every frame (gravity),
//     which touches the far deck's perimeter wall -- a wall facing back the way
//     the tank came.
//   - gapped: two decks with a two-metre gap between them, which is how every
//     `Catwalk` joint on `import-xs.bzexcess.com_5155.bzw` is built (the group
//     shifts by 100, the geometry is 98 long). The tank bridges the gap, so it
//     is held up by both decks while its centre is over neither.
//
// Both used to stop a tank dead. The gapped one drove it *backwards*.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { meshArrays } from '../public/mesh-arrays.mjs';

const require = createRequire(import.meta.url);
const C = require('../server/collision.cjs');
const { resolveTankMotion } = require('../server/motion.cjs');
const clientCollision = await import('../public/collision.mjs');

const TANK_HEIGHT = 2;
const STEP = 1 / 60;
const SPEED = 25;

// A rectangular slab as a real mesh: six faces, outward normals, the shape a
// `.bzw` mesh arrives in, in upstream's frame (+Z up) as the parser lays it
// out.
function slab(name, minX, maxX, minY, maxY, top) {
  const v = (x, y, z) => ({ x, y, z });
  const vertices = [
    v(minX, maxY, 0), v(maxX, maxY, 0), v(maxX, minY, 0), v(minX, minY, 0),
    v(minX, maxY, top), v(maxX, maxY, top), v(maxX, minY, top), v(minX, minY, top),
  ];
  // `edgePlanes` the way MeshFace.cxx:205-213 builds them -- one inward plane
  // per edge, `cross(edge, faceNormal)` normalised -- because a parsed mesh
  // carries them and `pointInMeshFacePolygon` reads them.
  const face = (vertexIndices, plane) => {
    const edgePlanes = vertexIndices.map((vi, i) => {
      const a = vertices[vi];
      const b = vertices[vertexIndices[(i + 1) % vertexIndices.length]];
      const e = [b.x - a.x, b.y - a.y, b.z - a.z];
      const c = [
        (e[1] * plane[2]) - (e[2] * plane[1]),
        (e[2] * plane[0]) - (e[0] * plane[2]),
        (e[0] * plane[1]) - (e[1] * plane[0]),
      ];
      const len = Math.hypot(c[0], c[1], c[2]) || 1;
      const n = [c[0] / len, c[1] / len, c[2] / len];
      return [n[0], n[1], n[2], -((n[0] * a.x) + (n[1] * a.y) + (n[2] * a.z))];
    });
    return {
      vertexIndices, plane, edgePlanes, driveThrough: false, shootThrough: false, phydrv: null,
    };
  };
  return {
    type: 'mesh',
    name,
    vertices,
    faces: [
      face([0, 1, 5, 4], [0, 1, 0, -maxY]),
      face([1, 2, 6, 5], [1, 0, 0, -maxX]),
      face([2, 3, 7, 6], [0, -1, 0, minY]),
      face([3, 0, 4, 7], [-1, 0, 0, minX]),
      face([3, 2, 1, 0], [0, 0, -1, 0]),
      face([4, 5, 6, 7], [0, 0, 1, -top]),
    ],
    driveThrough: false,
    shootThrough: false,
    bounds: { minX, maxX, minY, maxY, minZ: 0, maxZ: top },
  };
}

// One tank, one heading, held forward. Returns how far it got along that
// heading and the longest run of frames that went nowhere.
function drive(obstacles, startX, startY, startZ, azimuth, seconds) {
  const ux = Math.cos(azimuth);
  const uy = Math.sin(azimuth);
  let state = { x: startX, y: startY, z: startZ, onSupport: true, stuckFrameCount: 0 };
  let progress = 0;
  let stall = 0;
  let longestStall = 0;

  for (let frame = 0; frame < Math.ceil(seconds / STEP); frame += 1) {
    const result = resolveTankMotion({
      x: state.x,
      y: state.y,
      z: state.z,
      azimuth,
      velocityX: ux * SPEED,
      velocityY: uy * SPEED,
      // The sink that makes the far deck's wall reachable at all. A tank on a
      // surface always carries a little downward velocity; without it this
      // drives along at exactly the top and never touches anything.
      velocityZ: -0.5,
      angularVelocity: 0,
      timeStep: STEP,
      groundLimit: 0,
      onGround: state.onSupport,
      hitTest: (fx, fy, fz, faz, tx, ty, tz, taz) => C.findTankObstacle(
        obstacles, tx, ty, tz,
        { azimuth: taz, fromX: fx, fromY: fy, fromZ: fz, radius: TANK_HEIGHT },
      ),
      getNormal: (obs, px, py, pz, paz, hx, hy, hz, haz, fx, fy, faz, tx, ty, taz) => (
        C.getTankHitNormal(obs, px, py, pz, paz, hz, TANK_HEIGHT, {
          fromX: fx, fromY: fy, fromAz: faz, toX: tx, toY: ty, toAz: taz, hitX: hx, hitY: hy,
          halfWidth: C.TANK_HALF_WIDTH, halfLength: C.TANK_HALF_LENGTH,
        })
      ),
      isFlatTop: (obs) => (obs ? obs.type !== 'pyramid' : false),
      getObstacleTop: (obs) => C.getObstacleBase(obs) + C.getObstacleHeight(obs),
      maxBumpHeight: 0.33,
      stuckFrameCount: state.stuckFrameCount,
    });
    state = {
      x: result.x,
      y: result.y,
      z: result.z,
      onSupport: result.onBuilding || result.z <= 0,
      stuckFrameCount: result.stuckFrameCount,
    };
    const next = ((state.x - startX) * ux) + ((state.y - startY) * uy);
    if (next - progress < SPEED * STEP * 0.1) {
      stall += 1;
      if (stall > longestStall) longestStall = stall;
    } else {
      stall = 0;
    }
    progress = next;
  }
  return { progress, z: state.z, longestStall };
}

const TOP = 12;
let checks = 0;

// Two decks sharing the whole edge at x = 0, and the same pair with a two-metre
// gap. Driven both ways, and off-centre along the seam (in y) as well as
// through it.
for (const [label, west, east] of [
  ['abutting', slab('west', -40, 0, -20, 20, TOP), slab('east', 0, 40, -20, 20, TOP)],
  ['gapped', slab('west', -40, -1, -20, 20, TOP), slab('east', 1, 40, -20, 20, TOP)],
]) {
  const obstacles = [west, east];
  for (const offset of [-12, -6, 0, 6, 12]) {
    // Azimuth pi drives toward -x, azimuth 0 toward +x (forward at azimuth a
    // is (cos a, sin a), matching server/motion.cjs).
    for (const [azimuth, fromX] of [[Math.PI, 20], [0, -20]]) {
      const run = drive(obstacles, fromX, offset, TOP, azimuth, 1.5);
      const direction = fromX > 0 ? 'east->west' : 'west->east';
      assert.ok(
        run.longestStall < 12,
        `${label} ${direction} at y=${offset} stalled for ${run.longestStall} frames`,
      );
      // 1.5s at 25 u/s is 37.5 units; the far deck's own far edge is 40 away,
      // so a tank that crossed the seam has covered most of that.
      assert.ok(
        run.progress > 30,
        `${label} ${direction} at y=${offset} only reached ${run.progress.toFixed(2)}`,
      );
      assert.ok(
        run.z > TOP - 0.5,
        `${label} ${direction} at y=${offset} fell to z=${run.z.toFixed(2)}`,
      );
      checks += 1;
    }
  }
}

// A tank travelling exactly along a face is sliding, not driving into it: the
// dot product is mathematically zero there and only rounding decides its sign.
// `meshFaceBlocksDirection` must not read that as a hit -- a blocked step with
// nothing to cancel resolves to no progress at all, every frame.
{
  const deck = slab('deck', -40, 0, -20, 20, TOP);
  // The wall is `deck.faces[1]`, and the direction test reads a mesh's flat
  // arrays rather than its face objects now (issue #153), so it is named by
  // index against those.
  const deckArrays = meshArrays(deck);
  const wall = 1;
  const along = { x: 0, y: -SPEED * STEP, z: -0.5 * STEP };
  assert.equal(
    C.meshFaceBlocksDirection(deckArrays, wall, along, TOP),
    false,
    'a face travelled exactly along must not block',
  );
  const into = { x: -SPEED * STEP, y: 0, z: -0.5 * STEP };
  assert.equal(
    C.meshFaceBlocksDirection(deckArrays, wall, into, TOP),
    true,
    'a face driven straight into must still block',
  );
  checks += 2;
}

// The client resolves the move and the server rejects it, so the two have to
// agree about this as much as about anything else in the pair.
assert.equal(
  typeof clientCollision.meshFaceBlocksDirection,
  'function',
  'client collision is missing meshFaceBlocksDirection',
);

console.log(`mesh seam tests passed (${checks} drives)`);
