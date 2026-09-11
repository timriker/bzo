/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

import { getObstacleHeight } from './collision.mjs';

// Faces nothing can ever see, left out of the world mesh.
//
// Upstream already does this for the two cases every map hits: a box's bottom
// polygon is not generated when it sits on the ground or lower
// (BoxSceneNodeGenerator.cxx:66) and a pyramid's base only when the pyramid is
// raised or stood on its point (PyramidSceneNodeGenerator.cxx:109). Both are the
// same rule with the answer worked out by hand -- a face buried in the ground.
// This is that rule asked of the world instead: a triangle every point of which
// lies inside the solid part of other obstacles cannot be seen from any position
// outside those obstacles, so it is never built.
//
// The reason it is worth doing is the way maps fake a curve. Lacking any curved
// obstacle, a map crosses several boxes at one spot -- `hix.bzw` builds four
// octagons, its top of the world and its roof out of four planks each, and
// `bzo.bzw` carries one in its north-east corner for testing -- and every long
// face of every plank is buried in its neighbours. Those are also the faces a
// phased tank sees as slabs across its view, because from inside one plank the
// others are still solid, so this is as much about what the eighth dimension
// looks like as about what the frame costs.
//
// The unit is the triangle, and a triangle is either kept whole or dropped
// whole: nothing is clipped and no vertex is invented, so the buffers only ever
// shrink. A face half buried keeps both halves.

// World units, and the figure that matters most here. The triangles come out of
// a BufferGeometry, so their coordinates are float32 however exactly the map
// wrote them: `hix.bzw`'s octagon half-width of 19.313708499 arrives as
// 19.31370926, and a map is 800 units across, where float32 steps about 6e-5.
// So a plank's corner lands a fraction either side of the neighbour it should be
// touching, and a tolerance tighter than that noise turns a buried face into a
// face with a hairline crack down it -- for one rosette and not the next,
// depending on nothing but which way the rounding went.
//
// A millimetre sits far above the noise and far below anything a player could
// see through, and the same figure serves the two rules below: a face within a
// millimetre of a solid's surface counts as on it, and a face a millimetre
// outside counts as outside.
const PLANE_EPSILON = 1e-3;
// Square world units. Clipping still leaves slivers along the seams where two
// solids meet; a square millimetre of exposure is not a hole anybody could see
// through, and treating one as covered is what lets a seam close.
const MIN_PIECE_AREA = 1e-4;
// A triangle crossed by this many solids is left alone rather than pursued. No
// map geometry reaches it; a pathological one would cost more to answer than the
// answer is worth.
const MAX_PIECES = 32;

// An obstacle that can hide another obstacle's geometry. A pad with no height is
// not a solid -- `bzo.bzw` puts one under most of its flag zones, and the
// importer already makes those drive- and shoot-through -- and a teleporter is
// translucent and animates, so a face hidden inside one would show through it.
export function hidesGeometry(obs) {
  if (!obs) return false;
  if (obs.kind === 'teleporter') return false;
  return getObstacleHeight(obs) > 0;
}

// The obstacle as the intersection of half-spaces, each `dot(normal, p) <= off`.
// A box is six, a pyramid five: its cap and one per slanted side. Both shapes are
// convex, which is what lets a triangle be tested by its corners alone.
export function getObstacleHalfSpaces(obs) {
  const height = getObstacleHeight(obs);
  const baseY = obs.baseY || 0;
  const topY = baseY + height;
  const cos = Math.cos(obs.rotation || 0);
  const sin = Math.sin(obs.rotation || 0);
  const halfW = obs.w / 2;
  const halfD = obs.d / 2;
  // The obstacle's own axes in world space, and its centre. The handedness is
  // `getColliderLocalPoint`'s, which is also what a Three rotation about +Y
  // gives the obstacle's mesh -- the two have to agree or this would hide the
  // faces of a box that is somewhere else, and only for obstacles turned by
  // something other than a right angle, since a box is its own mirror at 90.
  const ex = [cos, 0, -sin];
  const ez = [sin, 0, cos];
  const cx = obs.x;
  const cz = obs.z;

  if (obs.type === 'pyramid') {
    // The rectangle end and the point end. An inverted pyramid is the same solid
    // stood on its point, so only which end is which changes.
    const ringY = obs.inverted ? topY : baseY;
    const apex = [cx, obs.inverted ? baseY : topY, cz];
    const planes = obs.inverted
      ? [{ n: [0, 1, 0], off: topY }]
      : [{ n: [0, -1, 0], off: -baseY }];
    const ring = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([sx, sz]) => [
      cx + (ex[0] * halfW * sx) + (ez[0] * halfD * sz),
      ringY,
      cz + (ex[2] * halfW * sx) + (ez[2] * halfD * sz),
    ]);
    // A point known to be inside, to orient the slanted planes by.
    const inside = [cx, (baseY + topY) / 2, cz];
    for (let i = 0; i < 4; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % 4];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [apex[0] - a[0], apex[1] - a[1], apex[2] - a[2]];
      let n = [
        (u[1] * v[2]) - (u[2] * v[1]),
        (u[2] * v[0]) - (u[0] * v[2]),
        (u[0] * v[1]) - (u[1] * v[0]),
      ];
      const length = Math.hypot(n[0], n[1], n[2]);
      if (length < PLANE_EPSILON) continue;
      n = [n[0] / length, n[1] / length, n[2] / length];
      let off = (n[0] * a[0]) + (n[1] * a[1]) + (n[2] * a[2]);
      if ((n[0] * inside[0]) + (n[1] * inside[1]) + (n[2] * inside[2]) > off) {
        n = [-n[0], -n[1], -n[2]];
        off = -off;
      }
      planes.push({ n, off });
    }
    return planes;
  }

  const dotEx = (ex[0] * cx) + (ex[2] * cz);
  const dotEz = (ez[0] * cx) + (ez[2] * cz);
  return [
    { n: ex, off: dotEx + halfW },
    { n: [-ex[0], 0, -ex[2]], off: -dotEx + halfW },
    { n: ez, off: dotEz + halfD },
    { n: [-ez[0], 0, -ez[2]], off: -dotEz + halfD },
    { n: [0, 1, 0], off: topY },
    { n: [0, -1, 0], off: -baseY },
  ];
}

// The obstacle's axis-aligned bounds, for rejecting candidates before any
// clipping happens. A rotated box needs its corners; a pyramid's widest
// cross-section is its rectangle end whichever way up it is.
export function getObstacleBounds(obs) {
  const height = getObstacleHeight(obs);
  const baseY = obs.baseY || 0;
  const cos = Math.cos(obs.rotation || 0);
  const sin = Math.sin(obs.rotation || 0);
  const halfW = obs.w / 2;
  const halfD = obs.d / 2;
  const spanX = (Math.abs(cos) * halfW) + (Math.abs(sin) * halfD);
  const spanZ = (Math.abs(sin) * halfW) + (Math.abs(cos) * halfD);
  return {
    minX: obs.x - spanX,
    maxX: obs.x + spanX,
    minY: baseY,
    maxY: baseY + height,
    minZ: obs.z - spanZ,
    maxZ: obs.z + spanZ,
  };
}

// Sutherland-Hodgman against one half-space. Polygons are flat `[x, y, z, ...]`
// and stay in the plane of the triangle they came from, so this can work in 3D
// and never has to choose a projection.
//
// A point on the plane belongs to both sides. That is what stops two faces in
// the same plane from covering each other: neither is subtracted, both are
// drawn, and the pair is left to the depth test rather than to a rule that would
// let each eat the other's overlap and leave a hole.
function clipPolygon(polygon, plane, keepInside) {
  const count = polygon.length / 3;
  if (count < 3) return [];
  const { n, off } = plane;
  const side = keepInside ? 1 : -1;
  const clipped = [];
  let previous = ((n[0] * polygon[(count - 1) * 3]) + (n[1] * polygon[((count - 1) * 3) + 1])
    + (n[2] * polygon[((count - 1) * 3) + 2]) - off) * side;
  for (let i = 0; i < count; i += 1) {
    const at = i * 3;
    const distance = ((n[0] * polygon[at]) + (n[1] * polygon[at + 1])
      + (n[2] * polygon[at + 2]) - off) * side;
    const from = ((i + count - 1) % count) * 3;
    if ((previous > PLANE_EPSILON) !== (distance > PLANE_EPSILON)) {
      const t = previous / (previous - distance);
      clipped.push(
        polygon[from] + (t * (polygon[at] - polygon[from])),
        polygon[from + 1] + (t * (polygon[at + 1] - polygon[from + 1])),
        polygon[from + 2] + (t * (polygon[at + 2] - polygon[from + 2])),
      );
    }
    if (distance <= PLANE_EPSILON) clipped.push(polygon[at], polygon[at + 1], polygon[at + 2]);
    previous = distance;
  }
  return clipped.length >= 9 ? clipped : [];
}

// A planar polygon's area, from the magnitude of its own normal.
function polygonArea(polygon) {
  const count = polygon.length / 3;
  if (count < 3) return 0;
  let ax = 0;
  let ay = 0;
  let az = 0;
  for (let i = 0; i < count; i += 1) {
    const p = i * 3;
    const q = ((i + 1) % count) * 3;
    ax += (polygon[p + 1] * polygon[q + 2]) - (polygon[p + 2] * polygon[q + 1]);
    ay += (polygon[p + 2] * polygon[q]) - (polygon[p] * polygon[q + 2]);
    az += (polygon[p] * polygon[q + 1]) - (polygon[p + 1] * polygon[q]);
  }
  return 0.5 * Math.hypot(ax, ay, az);
}

// Where every point of the polygon lies on the far side of one plane, that
// plane separates the two and the solid takes nothing out.
function separatedBy(polygon, plane) {
  const { n, off } = plane;
  for (let at = 0; at < polygon.length; at += 3) {
    if ((n[0] * polygon[at]) + (n[1] * polygon[at + 1]) + (n[2] * polygon[at + 2])
      - off <= PLANE_EPSILON) return false;
  }
  return true;
}

// Where the whole polygon lies in the plane of one of the solid's faces, it is
// on the surface and none of it is in the interior, so again the solid takes
// nothing out. This is the rule that keeps two faces in the same plane: they
// hide each other equally and something has to be drawn there, where a rule
// that let each subtract the other would leave a hole -- an octagon's four
// plank tops are exactly this case.
function coplanarWith(polygon, plane) {
  const { n, off } = plane;
  for (let at = 0; at < polygon.length; at += 3) {
    const distance = (n[0] * polygon[at]) + (n[1] * polygon[at + 1])
      + (n[2] * polygon[at + 2]) - off;
    if (distance < -PLANE_EPSILON || distance > PLANE_EPSILON) return false;
  }
  return true;
}

// What is left of a polygon once one solid is taken out of it. Each half-space
// contributes the slice of the polygon outside it, and what carries on to the
// next plane is the part inside every plane so far -- so the pieces partition
// the polygon rather than overlapping, and what never comes back is the part
// inside the solid.
//
// A solid that takes nothing out has to hand the polygon back whole rather than
// in slices. Splitting on it would be no less correct, but the slices multiply
// with every solid the triangle's bounds happen to touch, and a triangle across
// a busy part of a map touches many: the pieces run into `MAX_PIECES` and a face
// that is genuinely buried comes back kept.
function subtractSolid(polygon, planes, remainder) {
  for (const plane of planes) {
    if (separatedBy(polygon, plane) || coplanarWith(polygon, plane)) {
      remainder.push(polygon);
      return;
    }
  }
  let inside = polygon;
  for (const plane of planes) {
    const outside = clipPolygon(inside, plane, false);
    if (outside.length && polygonArea(outside) > MIN_PIECE_AREA) remainder.push(outside);
    inside = clipPolygon(inside, plane, true);
    if (!inside.length) break;
  }
}

// The test the world mesh asks per triangle. Holds the obstacles that can hide
// something and their bounds, so the per-triangle work is a bounds reject
// against each of them and clipping only against the few that survive it.
//
// Only the map's own obstacles take part. The boundary walls are built
// separately and already drop the face that points out of the arena.
export function createBuriedTriangleTest(obstacles = []) {
  const solids = [];
  for (const obs of obstacles) {
    if (!hidesGeometry(obs)) continue;
    solids.push({ obs, planes: getObstacleHalfSpaces(obs), bounds: getObstacleBounds(obs) });
  }

  // `owner` is the obstacle the triangle belongs to, which never hides itself.
  return function isBuried(owner, ax, ay, az, bx, by, bz, cx, cy, cz) {
    if (!solids.length) return false;
    const minX = Math.min(ax, bx, cx);
    const maxX = Math.max(ax, bx, cx);
    const minY = Math.min(ay, by, cy);
    const maxY = Math.max(ay, by, cy);
    const minZ = Math.min(az, bz, cz);
    const maxZ = Math.max(az, bz, cz);

    let pieces = [[ax, ay, az, bx, by, bz, cx, cy, cz]];
    for (const solid of solids) {
      if (solid.obs === owner) continue;
      const { bounds } = solid;
      if (bounds.maxX < minX - PLANE_EPSILON || bounds.minX > maxX + PLANE_EPSILON
        || bounds.maxY < minY - PLANE_EPSILON || bounds.minY > maxY + PLANE_EPSILON
        || bounds.maxZ < minZ - PLANE_EPSILON || bounds.minZ > maxZ + PLANE_EPSILON) continue;
      const remainder = [];
      for (const piece of pieces) subtractSolid(piece, solid.planes, remainder);
      if (!remainder.length) return true;
      if (remainder.length > MAX_PIECES) return false;
      pieces = remainder;
    }
    return false;
  };
}
