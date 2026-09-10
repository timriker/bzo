/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

import assert from 'node:assert/strict';
import {
  createBuriedTriangleTest,
  getObstacleBounds,
  getObstacleHalfSpaces,
  hidesGeometry,
} from '../public/face-trim.mjs';
import { getColliderLocalPoint, getPyramidSurfaceLocalHeight } from '../public/collision.mjs';

// Obstacles as the BZW importer leaves them: `w` and `d` full extents, `baseY`
// the underside, `rotation` in radians.
const box = (over = {}) => ({
  type: 'box', x: 0, z: 0, baseY: 0, w: 10, d: 10, h: 10, rotation: 0, ...over,
});
const pyramid = (over = {}) => ({ ...box({ h: 10, ...over }), type: 'pyramid' });

// The obstacle's own axes, as `getColliderLocalPoint` and a Three rotation about
// +Y both have them. A rosette is its own mirror, so a test built on the wrong
// handedness would pass on the octagon and be wrong about every other angle.
const axes = (obs) => {
  const cos = Math.cos(obs.rotation || 0);
  const sin = Math.sin(obs.rotation || 0);
  return { ex: [cos, 0, -sin], ez: [sin, 0, cos] };
};

// A corner of the obstacle's footprint, at height y.
const corner = (obs, sx, sz, y) => {
  const { ex, ez } = axes(obs);
  return [
    obs.x + (ex[0] * (obs.w / 2) * sx) + (ez[0] * (obs.d / 2) * sz),
    y,
    obs.z + (ex[2] * (obs.w / 2) * sx) + (ez[2] * (obs.d / 2) * sz),
  ];
};

// A box face as its two triangles. `axis` picks which face: the long pair of a
// plank is 'z', the short ends 'x', and the caps 'y'.
const boxFaceTriangles = (obs, axis, sign) => {
  const y0 = obs.baseY;
  const y1 = obs.baseY + obs.h;
  let quad;
  if (axis === 'y') {
    const y = sign > 0 ? y1 : y0;
    quad = [corner(obs, -1, -1, y), corner(obs, 1, -1, y), corner(obs, 1, 1, y), corner(obs, -1, 1, y)];
  } else if (axis === 'x') {
    quad = [corner(obs, sign, -1, y0), corner(obs, sign, 1, y0), corner(obs, sign, 1, y1), corner(obs, sign, -1, y1)];
  } else {
    quad = [corner(obs, -1, sign, y0), corner(obs, 1, sign, y0), corner(obs, 1, sign, y1), corner(obs, -1, sign, y1)];
  }
  return [
    [...quad[0], ...quad[1], ...quad[2]],
    [...quad[0], ...quad[2], ...quad[3]],
  ];
};

// One slanted side of a pyramid, which is a single triangle. 'z' is the side
// whose base edge runs the long way.
const pyramidSideTriangle = (obs, axis, sign) => {
  const ringY = obs.inverted ? obs.baseY + obs.h : obs.baseY;
  const apex = [obs.x, obs.inverted ? obs.baseY : obs.baseY + obs.h, obs.z];
  const [a, b] = axis === 'z'
    ? [corner(obs, -1, sign, ringY), corner(obs, 1, sign, ringY)]
    : [corner(obs, sign, -1, ringY), corner(obs, sign, 1, ringY)];
  return [...a, ...b, ...apex];
};

const buried = (world, owner, triangle) => createBuriedTriangleTest(world)(owner, ...triangle);
const allBuried = (world, owner, triangles) => triangles.every((t) => buried(world, owner, t));
const noneBuried = (world, owner, triangles) => triangles.every((t) => !buried(world, owner, t));

// A box on its own hides nothing of itself, however the test is asked.
{
  const only = box();
  const world = [only];
  for (const [axis, sign] of [['x', 1], ['x', -1], ['z', 1], ['z', -1], ['y', 1], ['y', -1]]) {
    assert.ok(noneBuried(world, only, boxFaceTriangles(only, axis, sign)),
      `a lone box keeps its ${axis}${sign > 0 ? '+' : '-'} face`);
  }
}

// A box swallowed by a bigger one loses everything.
{
  const inner = box({ w: 4, d: 4, h: 4, baseY: 2 });
  const outer = box({ w: 20, d: 20, h: 20 });
  const world = [inner, outer];
  for (const [axis, sign] of [['x', 1], ['x', -1], ['z', 1], ['z', -1], ['y', 1], ['y', -1]]) {
    assert.ok(allBuried(world, inner, boxFaceTriangles(inner, axis, sign)),
      `a nested box loses its ${axis}${sign > 0 ? '+' : '-'} face`);
  }
  assert.ok(noneBuried(world, outer, boxFaceTriangles(outer, 'y', 1)),
    'and the box around it keeps its own');
}

// The octagon: four planks at one spot, 45 degrees apart, `hix.bzw`'s own
// figures. The long faces are buried in the neighbours -- by the three of them
// together, never by any one -- and the short ends are the octagon's outer
// sides, which have to survive.
{
  const OCT_HALF_WIDTH = 19.313708499;
  const OCT_HALF_DEPTH = 8;
  const planks = [0, 45, 90, 135].map((deg) => box({
    w: OCT_HALF_WIDTH * 2, d: OCT_HALF_DEPTH * 2, h: 15,
    rotation: (deg * Math.PI) / 180,
  }));
  for (const plank of planks) {
    for (const sign of [1, -1]) {
      assert.ok(allBuried(planks, plank, boxFaceTriangles(plank, 'z', sign)),
        'an octagon plank loses its long faces');
      assert.ok(noneBuried(planks, plank, boxFaceTriangles(plank, 'x', sign)),
        'an octagon plank keeps its short ends');
    }
    assert.ok(noneBuried(planks, plank, boxFaceTriangles(plank, 'y', 1)),
      'and keeps its top, which is only partly covered');
  }
  // No single plank is enough on its own, which is the whole reason this
  // subtracts a union rather than asking for containment.
  for (const plank of planks) {
    for (const other of planks) {
      if (other === plank) continue;
      assert.ok(noneBuried([plank, other], plank, boxFaceTriangles(plank, 'z', 1)),
        'one neighbour alone never buries a long face');
    }
  }
}

// The same idiom in pyramids, which is `hix.bzw`'s roof. Both half-extents
// shrink together, so the cross-section stays a regular octagon all the way to
// the point and the long sides are interior at every height.
{
  const planks = [0, 45, 90, 135].map((deg) => pyramid({
    w: 9.6568542495 * 2, d: 4 * 2, h: 5, baseY: 52,
    rotation: (deg * Math.PI) / 180,
  }));
  for (const plank of planks) {
    for (const sign of [1, -1]) {
      assert.ok(buried(planks, plank, pyramidSideTriangle(plank, 'z', sign)),
        'a roof pyramid loses its long slanted sides');
      assert.ok(!buried(planks, plank, pyramidSideTriangle(plank, 'x', sign)),
        'a roof pyramid keeps its short slanted sides');
    }
  }
  // Upside down is the same solid stood on its point.
  const flipped = planks.map((p) => ({ ...p, inverted: true }));
  for (const plank of flipped) {
    assert.ok(buried(flipped, plank, pyramidSideTriangle(plank, 'z', 1)),
      'and so does an inverted one');
  }
}

// Two faces in the same plane cover each other equally, so neither may go:
// something has to be drawn there. A box resting exactly on another keeps the
// bottom that lies on the roof, and the roof keeps its top.
{
  const lower = box({ w: 20, d: 20, h: 5 });
  const upper = box({ w: 6, d: 6, h: 5, baseY: 5 });
  const world = [lower, upper];
  assert.ok(noneBuried(world, upper, boxFaceTriangles(upper, 'y', -1)),
    'a box standing on another keeps its underside');
  assert.ok(noneBuried(world, lower, boxFaceTriangles(lower, 'y', 1)),
    'and the one underneath keeps its roof');
  assert.ok(noneBuried(world, upper, boxFaceTriangles(upper, 'x', 1)),
    'the walls above the roof stay too');
}

// A wall buried in a wide box loses the span that is inside it and keeps the
// rest, one triangle at a time, because a triangle is never cut.
{
  const wall = box({ w: 60, d: 1, h: 16 });
  const blocker = box({ w: 20, d: 20, h: 20 });
  const world = [wall, blocker];
  const inside = [
    ...corner({ ...wall, w: 8 }, -1, 1, 1), ...corner({ ...wall, w: 8 }, 1, 1, 1),
    ...corner({ ...wall, w: 8 }, 1, 1, 9),
  ];
  assert.ok(buried(world, wall, inside), 'a triangle inside the blocker goes');
  assert.ok(noneBuried(world, wall, boxFaceTriangles(wall, 'x', 1)),
    'the far end of the wall stays');
}

// What may hide something, and what may not.
{
  assert.ok(hidesGeometry(box()), 'a box hides');
  assert.ok(hidesGeometry(pyramid()), 'a pyramid hides');
  assert.ok(!hidesGeometry(box({ h: 0 })), 'a flat pad is not a solid');
  assert.ok(!hidesGeometry({ ...box(), kind: 'teleporter' }), 'a teleporter is see-through');
  assert.ok(!hidesGeometry(null), 'and nothing is nothing');

  // A pad cannot bury a face even where it covers one exactly.
  const pad = box({ w: 40, d: 40, h: 0 });
  const post = box({ w: 4, d: 4, h: 6 });
  assert.ok(noneBuried([pad, post], post, boxFaceTriangles(post, 'y', -1)),
    'a pad buries nothing');

  // Neither can a teleporter that a box passes through.
  const gate = { ...box({ w: 8, d: 2, h: 20 }), kind: 'teleporter' };
  const through = box({ w: 40, d: 1, h: 6 });
  assert.ok(noneBuried([gate, through], through, boxFaceTriangles(through, 'x', 1)),
    'a teleporter buries nothing');
}

// Bounds cover a rotated footprint, which is what the reject relies on.
{
  const turned = getObstacleBounds(box({ w: 10, d: 10, rotation: Math.PI / 4 }));
  const straight = getObstacleBounds(box({ w: 10, d: 10 }));
  assert.ok(turned.maxX > straight.maxX, 'a box turned 45 degrees is wider than its size');
  assert.ok(Math.abs(turned.maxX - (5 * Math.SQRT2)) < 1e-9, 'by exactly its half-diagonal');
  assert.equal(straight.minY, 0, 'bounds start at the base');
  assert.equal(straight.maxY, 10, 'and end at the top');
}

// The half-spaces have to describe the same solid the colliders do, at an angle
// that is not a multiple of a right angle -- where a box stops being its own
// mirror and the handedness starts to matter.
{
  const turned = box({ x: 12, z: -5, w: 9, d: 3, h: 6, baseY: 1, rotation: 0.7 });
  const planes = getObstacleHalfSpaces(turned);
  const insideHalfSpaces = (x, y, z) => planes.every(({ n, off }) => (
    (n[0] * x) + (n[1] * y) + (n[2] * z)
  ) <= off + 1e-9);
  let checked = 0;
  for (let sx = -20; sx <= 20; sx += 1.3) {
    for (let sz = -20; sz <= 20; sz += 1.7) {
      for (const y of [0.5, 1.5, 4, 6.5, 7.5]) {
        const x = turned.x + sx;
        const z = turned.z + sz;
        const local = getColliderLocalPoint(x, z, turned);
        // Points sitting on a face are the one thing the two may disagree
        // about, and nothing here depends on which way they round.
        if (Math.abs(Math.abs(local.x) - (turned.w / 2)) < 1e-6) continue;
        if (Math.abs(Math.abs(local.z) - (turned.d / 2)) < 1e-6) continue;
        const expected = Math.abs(local.x) <= turned.w / 2
          && Math.abs(local.z) <= turned.d / 2
          && y >= turned.baseY && y <= turned.baseY + turned.h;
        assert.equal(insideHalfSpaces(x, y, z), expected,
          `half-spaces disagree with the collider at ${x},${y},${z}`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 1000, 'the collider cross-check covered the box');
}

// A pyramid's half-spaces against the collider's own idea of its slope, both
// ways up.
{
  for (const inverted of [false, true]) {
    const cone = pyramid({ x: -6, z: 9, w: 12, d: 8, h: 10, baseY: 2, rotation: 0.4, inverted });
    const planes = getObstacleHalfSpaces(cone);
    const insideHalfSpaces = (x, y, z) => planes.every(({ n, off }) => (
      (n[0] * x) + (n[1] * y) + (n[2] * z)
    ) <= off + 1e-9);
    for (let sx = -10; sx <= 10; sx += 1.1) {
      for (let sz = -10; sz <= 10; sz += 1.3) {
        for (const y of [2.5, 5, 7, 9, 11.5]) {
          const x = cone.x + sx;
          const z = cone.z + sz;
          const local = getColliderLocalPoint(x, z, cone);
          const surface = getPyramidSurfaceLocalHeight(cone, local.x, local.z);
          if (surface === null) {
            assert.ok(!insideHalfSpaces(x, y, z), 'nothing outside the footprint is inside');
            continue;
          }
          const span = inverted
            ? { low: cone.baseY + surface, high: cone.baseY + cone.h }
            : { low: cone.baseY, high: cone.baseY + surface };
          if (Math.abs(y - span.low) < 1e-6 || Math.abs(y - span.high) < 1e-6) continue;
          assert.equal(insideHalfSpaces(x, y, z), y > span.low && y < span.high,
            `pyramid half-spaces disagree with the slope at ${x},${y},${z}`);
        }
      }
    }
  }
}

// The triangles this is asked about come out of a BufferGeometry, so their
// coordinates are float32 whatever the map wrote. `hix.bzw`'s top of the world
// is the rosette that exposed it: its half-width rounds a fraction outwards, the
// corner misses the neighbour it should touch, and a tolerance tighter than that
// leaves a hairline crack down a face that is genuinely buried.
{
  const planks = [0, 45, 90, 135].map((deg) => box({
    w: 9.6568542495 * 2, d: 8, h: 16, baseY: 29,
    rotation: ((deg * Math.PI) / 180) + Math.PI,
  }));
  const asFloat32 = (triangles) => triangles.map((t) => t.map(Math.fround));
  for (const plank of planks) {
    for (const sign of [1, -1]) {
      assert.ok(allBuried(planks, plank, asFloat32(boxFaceTriangles(plank, 'z', sign))),
        'float32 coordinates still bury the long faces');
      assert.ok(noneBuried(planks, plank, asFloat32(boxFaceTriangles(plank, 'x', sign))),
        'and still keep the short ends');
    }
  }
}

console.log('face-trim tests passed');
