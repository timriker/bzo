#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The radar panel drops most of a large map before it projects anything, and
// the one thing that rejection may never do is drop something the player can
// see. hix's walkways are the case that names it: long enough that the centre
// sits well off the panel while a span of them is still on it.

import assert from 'node:assert/strict';
import {
  RADAR_BOX_CORNERS,
  clipPolygonToRadarSquare,
  ensureRadarPolygonBuffers,
  getRadarClipBuffer,
  getRadarMeshFaceCull,
  getRadarObstacleCullRadius,
  getRadarPolygonScratch,
  isOutsideRadarSquare,
} from '../public/radar-geometry.mjs';

// Deterministic PRNG so a failure is reproducible from the printed seed.
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = ((state * 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const seed = Number(process.argv[2] || 20260925);
const random = makeRandom(seed);
const between = (low, high) => low + (random() * (high - low));

// The clipper the panel used before it moved onto flat buffers, kept here as
// the reference the flat one has to agree with vertex for vertex.
function clipEdgeReference(points, axis, boundary, keepLessEqual) {
  const output = [];
  const inside = (point) => (keepLessEqual ? point[axis] <= boundary : point[axis] >= boundary);
  const crossing = (from, to) => {
    const delta = to[axis] - from[axis];
    if (Math.abs(delta) < 1e-9) return { x: from.x, y: from.y };
    const t = (boundary - from[axis]) / delta;
    return { x: from.x + ((to.x - from.x) * t), y: from.y + ((to.y - from.y) * t) };
  };
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const previous = points[(i + points.length - 1) % points.length];
    if (inside(current)) {
      if (!inside(previous)) output.push(crossing(previous, current));
      output.push(current);
    } else if (inside(previous)) {
      output.push(crossing(previous, current));
    }
  }
  return output;
}

function clipReference(points, halfExtent) {
  let clipped = points;
  clipped = clipEdgeReference(clipped, 'x', halfExtent, true);
  clipped = clipEdgeReference(clipped, 'x', -halfExtent, false);
  clipped = clipEdgeReference(clipped, 'y', halfExtent, true);
  clipped = clipEdgeReference(clipped, 'y', -halfExtent, false);
  return clipped;
}

// A convex polygon, which is all the panel ever clips: a box footprint or one
// planar mesh face.
function convexPolygon(vertexCount) {
  const centerX = between(-120, 120);
  const centerY = between(-120, 120);
  const radiusX = between(0.5, 90);
  const radiusY = between(0.5, 90);
  const angles = Array.from({ length: vertexCount }, () => random() * Math.PI * 2)
    .sort((left, right) => left - right);
  return angles.map((angle) => ({
    x: centerX + (Math.cos(angle) * radiusX),
    y: centerY + (Math.sin(angle) * radiusY),
  }));
}

let clippedInside = 0;
for (let trial = 0; trial < 20000; trial += 1) {
  const vertexCount = 3 + Math.floor(random() * 8);
  const points = convexPolygon(vertexCount);
  const halfExtent = 50;
  const expected = clipReference(points, halfExtent);

  const scratch = getRadarPolygonScratch();
  points.forEach((point, index) => {
    scratch[index * 2] = point.x;
    scratch[(index * 2) + 1] = point.y;
  });
  const count = clipPolygonToRadarSquare(scratch, vertexCount, halfExtent);
  const clipped = getRadarClipBuffer();

  assert.equal(count, expected.length, `seed ${seed}: clipped vertex count`);
  for (let i = 0; i < count; i += 1) {
    assert.equal(clipped[i * 2], expected[i].x, `seed ${seed}: clipped x at ${i}`);
    assert.equal(clipped[(i * 2) + 1], expected[i].y, `seed ${seed}: clipped y at ${i}`);
  }
  if (count >= 3) clippedInside += 1;
}
assert.ok(clippedInside > 1000, 'the clip cases have to actually reach the panel');

// The invariant. Half the footprints here are walkway-shaped -- tens to
// hundreds of units on one side -- because a rejection keyed on the centre
// alone passes a test made only of boxes.
let culled = 0;
let drawn = 0;
for (let trial = 0; trial < 200000; trial += 1) {
  const radarDistance = between(10, 60);
  const playerX = between(-200, 200);
  const playerZ = between(-200, 200);
  const heading = between(0, Math.PI * 2);
  const headingCos = Math.cos(heading);
  const headingSin = Math.sin(heading);

  const obs = {
    x: between(-250, 250),
    z: between(-250, 250),
    rotation: between(0, Math.PI * 2),
    w: random() < 0.5 ? between(0.5, 8) : between(40, 300),
    d: random() < 0.5 ? between(0.5, 8) : between(40, 300),
  };

  const dx = obs.x - playerX;
  const dz = obs.z - playerZ;
  const centerX = (dx * headingCos) - (dz * headingSin);
  const centerY = (dx * headingSin) + (dz * headingCos);
  const cullRadius = getRadarObstacleCullRadius(obs);
  const rejected = isOutsideRadarSquare(centerX, centerY, radarDistance, cullRadius);

  const rotation = -obs.rotation + heading;
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);
  const scratch = getRadarPolygonScratch();
  for (let i = 0; i < 4; i += 1) {
    const cornerX = RADAR_BOX_CORNERS[i * 2] * (obs.w / 2);
    const cornerZ = RADAR_BOX_CORNERS[(i * 2) + 1] * (obs.d / 2);
    scratch[i * 2] = centerX + ((cornerX * cosR) - (cornerZ * sinR));
    scratch[(i * 2) + 1] = centerY + ((cornerX * sinR) + (cornerZ * cosR));
  }
  const visible = clipPolygonToRadarSquare(scratch, 4, radarDistance) >= 3;

  assert.ok(!(rejected && visible), `seed ${seed}: an obstacle on the panel was rejected`);
  if (rejected) culled += 1; else drawn += 1;
}
assert.ok(culled > drawn, 'the rejection has to be worth making');

// A spinning mesh's faces turn about `spinPivot`, so the circle is centred
// there and one radius covers every angle the face is ever drawn at.
const spinningMesh = {
  angvel: 1,
  spinPivot: { x: 10, z: -4 },
  vertices: [
    { x: 4, y: 0, z: -9 },
    { x: 28, y: 0, z: -9 },
    { x: 28, y: 0, z: 3 },
    { x: 4, y: 0, z: 3 },
  ],
};
const spinningFace = { vertexIndices: [0, 1, 2, 3] };
const spinCull = getRadarMeshFaceCull(spinningMesh, spinningFace);
assert.equal(spinCull.cullX, 10);
assert.equal(spinCull.cullZ, -4);
for (const vertex of spinningMesh.vertices) {
  const reach = Math.hypot(vertex.x - spinCull.cullX, vertex.z - spinCull.cullZ);
  assert.ok(reach <= spinCull.cullRadius + 1e-9, 'a vertex reached outside the spin circle');
}

// A still mesh takes the centroid of its own face.
const stillMesh = {
  vertices: [
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 10, y: 0, z: 6 },
    { x: 0, y: 0, z: 6 },
  ],
};
const stillCull = getRadarMeshFaceCull(stillMesh, { vertexIndices: [0, 1, 2, 3] });
assert.equal(stillCull.cullX, 5);
assert.equal(stillCull.cullZ, 3);
assert.ok(Math.abs(stillCull.cullRadius - Math.hypot(5, 3)) < 1e-9);

// A map whose widest face is wider than the buffers start out sizes them once,
// as `getRadarMeshFaces` does when it builds its list, and then every vertex of
// a face wholly inside the panel comes back. Written past the end instead, a
// typed array drops the overflow and the face comes back a fragment of itself.
const wide = 64;
assert.ok(getRadarPolygonScratch().length < wide * 2, 'the buffers start smaller than this face');
ensureRadarPolygonBuffers((wide * 2) + 8);
const wideScratch = getRadarPolygonScratch();
assert.ok(wideScratch.length >= wide * 2, 'the buffers did not grow to fit the face');
for (let i = 0; i < wide; i += 1) {
  const angle = (i / wide) * Math.PI * 2;
  wideScratch[i * 2] = Math.cos(angle) * 10;
  wideScratch[(i * 2) + 1] = Math.sin(angle) * 10;
}
assert.equal(clipPolygonToRadarSquare(wideScratch, wide, 50), wide);

console.log(`radar geometry ok (seed ${seed}, ${culled} rejected, ${drawn} drawn)`);
