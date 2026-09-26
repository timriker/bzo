/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Obstacle geometry shared by the client and the server.
//
// These predicates mirror upstream BZFlag so that both sides of bzo agree with
// each other by agreeing with the same reference implementation:
//   - testOrigRectCircle    -> src/game/Intersect.cxx testOrigRectCircle
//   - pyramidShrinkFactor   -> src/obstacle/PyramidBuilding.cxx shrinkFactor
//   - pyramidIntersects     -> src/obstacle/PyramidBuilding.cxx inBox
//   - isPyramidFlatTop      -> src/obstacle/PyramidBuilding.cxx isFlatTop
//   - movingTankOverlapsHeight -> src/obstacle/BoxBuilding.cxx inMovingBox
//   - crossedFlatTop        -> src/obstacle/Obstacle.cxx getHitNormal (roof)
//
// bzo stores pyramid height as a positive `h` plus an `inverted` flag, which is
// what upstream calls ZFlip. bzo models tanks and shots as cylinders, so where
// upstream tests a rotated rectangle (testRectRect) bzo tests a circle
// (testRectCircle) against the same shrunk cross-section.
//
// Keep this file byte-identical in behavior with server/collision.cjs.
// scripts/test-collision.mjs enforces that.

const ZERO_TOLERANCE = 1.0e-6;

// Rotate a world point into an obstacle's local, axis-aligned frame.
//
// Upstream testRectCircle rotates by -angle; bzo rotates by +rotation. The
// difference is a coordinate-layout artifact, not a different world.
//
// bzo is BZFlag's world relabeled for Three.js: bzo(x, y, z) = bzf(x, z, -y),
// a proper rotation, not a mirror. But the ordered pair (x, z) viewed from +Y
// has the opposite orientation to (x, y) viewed from +Z, so a Three.js rotation
// about +Y is a negative 2D rotation in (x, z), and its inverse is +rotation.
// render.js draws obstacles with `mesh.rotation.y = obs.rotation`, so the form
// below is exactly the inverse of how the mesh is drawn. Do not "fix" the sign.
function getColliderLocalPoint(x, z, obs) {
  const rotation = obs.rotation;
  const dx = x - obs.x;
  const dz = z - obs.z;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return {
    x: dx * cos - dz * sin,
    z: dx * sin + dz * cos
  };
}

// Squared distance from a local point to the nearest point of an axis-aligned
// rectangle centered at the origin.
function origRectPointDistanceSquared(halfW, halfD, localX, localZ) {
  const closestX = Math.max(-halfW, Math.min(localX, halfW));
  const closestZ = Math.max(-halfD, Math.min(localZ, halfD));
  const distX = localX - closestX;
  const distZ = localZ - closestZ;
  return distX * distX + distZ * distZ;
}

// True when an axis-aligned rectangle centered at the origin intersects a
// circle of radius r centered at the local point.
function testOrigRectCircle(halfW, halfD, localX, localZ, radius) {
  return origRectPointDistanceSquared(halfW, halfD, localX, localZ) < radius * radius;
}

// Tank collision box, matching BZFlag's _tankWidth (2.8) and _tankLength (6.0).
// Player.cxx:120 sets dimensions[0] = 0.5 * tankLength (forward half-extent) and
// dimensions[1] = 0.5 * tankWidth (lateral). Every tank shares this box whatever
// model is selected, so the model is cosmetic and never changes gameplay.
const TANK_HALF_LENGTH = 3.0;
const TANK_HALF_WIDTH = 1.4;
// _tankHeight. Player.cxx:120 keeps this one whole rather than halved, and it is
// what a shot's vertical hit test measures against.
const TANK_HEIGHT = 2.05;

// _wallHeight, which upstream states as 3.0 * _tankHeight. This is how tall the
// world's border wall is *drawn* and how high up it stops a shot; a tank is
// stopped by it at any altitude, because WallObstacle::inCylinder ignores height
// and tests an infinite half-space. makeSegments spells the difference out: a
// bouncing shot whose impact is above the top of the outer wall has the hit
// ignored and carries on over it rather than bouncing back into the arena.
const WORLD_WALL_HEIGHT = 3.0 * TANK_HEIGHT;

// A rectangle centred at (localX, localZ), rotated so its lateral axis points
// along (cos a, sin a), against the axis-aligned rectangle at the origin.
// Ported from Intersect.cxx testOrigRectRect: dx1/dy1 are the rotated rect's
// half-extents, dx2/dy2 the origin rect's.
function testOrigRectRect(px, pz, angle, dx1, dy1, dx2, dy2) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);

  // The origin rect's centre inside the rotated rect.
  const sx = c * px + s * pz;
  const sy = c * pz - s * px;
  if (Math.abs(sx) < dx1 && Math.abs(sy) < dy1) return true;

  // Corners of the rotated rect, classified against the origin rect.
  const box = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
  const corner = [];
  const region = [];
  for (let i = 0; i < 4; i++) {
    const cx = px + c * dx1 * box[i][0] - s * dy1 * box[i][1];
    const cz = pz + s * dx1 * box[i][0] + c * dy1 * box[i][1];
    corner.push([cx, cz]);
    const rx = cx < -dx2 ? -1 : (cx > dx2 ? 1 : 0);
    const rz = cz < -dy2 ? -1 : (cz > dy2 ? 1 : 0);
    region.push([rx, rz]);
    if (!rx && !rz) return true;
  }

  // Each edge of the rotated rect against the origin rect.
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    if (region[i][0] === region[j][0]) {
      if (region[i][0] === 0 && region[i][1] !== region[j][1]) return true;
      continue;
    } else if (region[i][1] === region[j][1]) {
      if (region[i][1] === 0) return true;
      continue;
    }

    let c2x;
    let c2z;
    if (region[i][0] === 0) {
      c2x = region[j][0] * dx2;
      c2z = region[i][1] * dy2;
    } else if (region[j][0] === 0) {
      c2x = region[i][0] * dx2;
      c2z = region[j][1] * dy2;
    } else if (region[i][1] === 0) {
      c2x = region[i][0] * dx2;
      c2z = region[j][1] * dy2;
    } else {
      c2x = region[j][0] * dx2;
      c2z = region[i][1] * dy2;
    }

    const ex = corner[j][0] - corner[i][0];
    const ez = corner[j][1] - corner[i][1];
    const a = ez * (c2x - corner[i][0]) - ex * (c2z - corner[i][1]);
    const b = ez * (c2x + corner[i][0]) - ex * (c2z + corner[i][1]);
    if (a * b > 0.0) return true;
  }
  return false;
}

// The tank box against an obstacle, both expressed in the obstacle's local
// frame. `rotation` is the tank's heading in bzo terms, where forward is
// (-sin r, -cos r); the lateral axis leads by a quarter turn.
function testOrigRectTank(halfW, halfD, localX, localZ, tankAngle, slack = 0, tankScale = null) {
  // Player::getDimensions, which a flag scales on the lateral and forward axes
  // and never on height. `null` is the tank's own size, which is every tank
  // without one of the three dimension flags.
  const halfWidth = TANK_HALF_WIDTH * (tankScale ? tankScale.width : 1);
  const halfLength = TANK_HALF_LENGTH * (tankScale ? tankScale.length : 1);
  // Slack shrinks the tank, never the obstacle, mirroring how the circle path
  // reduces the tested radius.
  const trim = Math.max(0, Math.min(slack, halfWidth));
  return testOrigRectRect(
    localX, localZ, tankAngle,
    halfWidth - trim, halfLength - trim,
    halfW, halfD
  );
}

// A segment against an oriented box centred on a tank, in the same frame
// testOrigRectTank works in: `angle` is what getTankLocalAngle returns, the
// lateral axis, so `halfWidth` measures across the tank and `halfLength` along
// it. Returns the fraction of the segment at first contact, 0 if it began
// inside, or null if it never touches.
//
// This is timeRayHitsBlock reduced to two dimensions and a unit interval. The
// caller owns the height gate, as it does for the cylinder.
function getSegmentBoxHitFraction(
  fromX, fromZ, toX, toZ, centreX, centreZ, angle, halfWidth, halfLength
) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // Both endpoints into the box's frame, the way testOrigRectRect rotates a
  // point into the rotated rect's.
  const px = fromX - centreX;
  const pz = fromZ - centreZ;
  const qx = toX - centreX;
  const qz = toZ - centreZ;
  const ox = (c * px) + (s * pz);
  const oz = (c * pz) - (s * px);
  const ex = ((c * qx) + (s * qz)) - ox;
  const ez = ((c * qz) - (s * qx)) - oz;

  let tMin = 0;
  let tMax = 1;
  const slab = (origin, delta, half) => {
    if (Math.abs(delta) < 1e-12) return Math.abs(origin) <= half;
    let near = (-half - origin) / delta;
    let far = (half - origin) / delta;
    if (near > far) {
      const swap = near;
      near = far;
      far = swap;
    }
    if (near > tMin) tMin = near;
    if (far < tMax) tMax = far;
    return tMin <= tMax;
  };
  if (!slab(ox, ex, halfWidth)) return null;
  if (!slab(oz, ez, halfLength)) return null;
  return tMin;
}

// The tank's lateral axis angle inside an obstacle's local frame.
function getTankLocalAngle(rotation, obsRotation = 0) {
  return Math.PI - rotation + (obsRotation || 0);
}

// Height of the pyramid's sloped surface above its base, at a local point.
// Returns null outside the base footprint. This is the inverse of
// pyramidShrinkFactor: the surface sits where the shrunk rectangle's edge
// passes through the point.
function getPyramidSurfaceLocalHeight(obs, localX, localZ) {
  const halfW = obs.w / 2;
  const halfD = obs.d / 2;
  if (Math.abs(localX) > halfW || Math.abs(localZ) > halfD) return null;
  const height = getPyramidHeight(obs);
  const edgeFactor = Math.max(Math.abs(localX) / halfW, Math.abs(localZ) / halfD);
  return obs.inverted ? height * edgeFactor : height * (1 - edgeFactor);
}

function getPyramidHeight(obs) {
  return Math.abs(obs.h || 0);
}

// How tall an obstacle stands, and bzo's fallback for one whose map gave no
// size at all -- there is no `size` line a `.bzw` is obliged to write, and an
// undefined extent is the NaN trap the teleporter defaults in the map parser
// describe.
//
// A height of *zero* is a real answer rather than a missing one. A `base` drawn
// flat on the ground is exactly that: upstream's CustomBase leaves `size[2]` at
// 0 unless the map says otherwise, and such a base is a painted square a tank
// drives over and a shot flies across, not a solid. So this asks whether the
// number is there, not whether it is truthy -- which is what `getColliderTopY`
// has always done, and the two disagreed until this existed.
const DEFAULT_OBSTACLE_HEIGHT = 4;

function getObstacleHeight(obs) {
  if (obs?.type === 'mesh' && obs.bounds) return obs.bounds.maxY - obs.bounds.minY;
  return Number.isFinite(obs?.h) ? obs.h : DEFAULT_OBSTACLE_HEIGHT;
}

// Inverted pyramids present a flat top that can be driven on; upright ones come
// to a point. Upstream: isFlatTop() { return getZFlip(); }
function isPyramidFlatTop(obs) {
  return obs.inverted === true;
}

// Fraction the pyramid's cross-section is scaled to at world height y, for an
// occupant of the given height. Upstream PyramidBuilding::shrinkFactor.
function pyramidShrinkFactor(obs, y, height = 0) {
  const oHeight = getPyramidHeight(obs);
  const flip = isPyramidFlatTop(obs);
  if (oHeight <= ZERO_TOLERANCE) return 1;

  // Height relative to the pyramid base, normalized.
  let z = (y - (obs.baseY || 0)) / oHeight;

  // When flipped, the widest intersection is at the top of the object, so the
  // occupant's own height is what reaches it.
  if (flip) z += height / oHeight;

  const shrink = flip ? z : 1 - z;
  if (shrink < 0) return 0;
  if (shrink > 1) return 1;
  return shrink;
}

// Local-space outward horizontal normal of an axis-aligned rectangle centered
// at the origin, for a point inside OR outside it. Mirrors
// src/game/Intersect.cxx getNormalOrigRect -- note that upstream always yields a
// normal, which is why a pyramid can never report "no surface" to slide on.
function getOrigRectNormal(halfW, halfD, localX, localZ) {
  const normalize = (x, z) => {
    const length = Math.hypot(x, z);
    return length > 0 ? { x: x / length, z: z / length } : { x: 1, z: 0 };
  };

  if (localX > halfW) {
    if (localZ > halfD) return normalize(localX - halfW, localZ - halfD);
    if (localZ < -halfD) return normalize(localX - halfW, localZ + halfD);
    return { x: 1, z: 0 };
  }
  if (localX < -halfW) {
    if (localZ > halfD) return normalize(localX + halfW, localZ - halfD);
    if (localZ < -halfD) return normalize(localX + halfW, localZ + halfD);
    return { x: -1, z: 0 };
  }
  if (localZ > halfD) return { x: 0, z: 1 };
  if (localZ < -halfD) return { x: 0, z: -1 };

  // Inside: pick the nearer wall, weighted by the rectangle's aspect so a long
  // thin rib resolves to its long face rather than its end cap.
  if (halfD * Math.abs(localX) >= halfW * Math.abs(localZ)) {
    return { x: localX >= 0 ? 1 : -1, z: 0 };
  }
  return { x: 0, z: localZ >= 0 ? 1 : -1 };
}

// True when a point lies over the pyramid's base footprint.
//
// Colliding with a pyramid and being held up by one are different questions.
// getPyramidFaceLocalNormal deliberately answers everywhere, so the slide
// resolver always has a surface to work with. Support must additionally be
// contained, or a tank can be "held up" by a pyramid it is nowhere near.
function isWithinPyramidFootprint(obs, x, z) {
  const local = getColliderLocalPoint(x, z, obs);
  return Math.abs(local.x) <= obs.w / 2 && Math.abs(local.z) <= obs.d / 2;
}

// Outward normal of a pyramid face at a point, in the obstacle's local frame,
// including the tilt from the slope. Mirrors PyramidBuilding::getNormal and
// getHitNormal: take the normal of the cross-section rectangle at the
// occupant's height, then angle it by the slope of the wall.
function getPyramidFaceLocalNormal(obs, x, y, z, height = 0) {
  const shrink = pyramidShrinkFactor(obs, y, height);
  const local = getColliderLocalPoint(x, z, obs);
  const flat = getOrigRectNormal((obs.w / 2) * shrink, (obs.d / 2) * shrink, local.x, local.z);

  // Upstream notes this assumes a square base.
  const pyramidHeight = getPyramidHeight(obs);
  const baseHalfWidth = obs.w / 2;
  const scale = 1 / (Math.hypot(pyramidHeight, baseHalfWidth) || 1);
  return {
    x: flat.x * scale * pyramidHeight,
    y: (isPyramidFlatTop(obs) ? -1 : 1) * scale * baseHalfWidth,
    z: flat.z * scale * pyramidHeight
  };
}

// True when a cylinder of the given radius and height, whose base sits at y,
// intersects the solid volume of a pyramid. Upstream PyramidBuilding::inBox,
// with a circle footprint instead of a rotated rectangle.
function pyramidIntersectsCylinder(obs, x, y, z, radius, height) {
  const baseY = obs.baseY || 0;
  // Occupant is entirely below the pyramid.
  if (y + height < baseY) return false;
  // Occupant is entirely above the pyramid.
  if (y >= baseY + getPyramidHeight(obs)) return false;

  const shrink = pyramidShrinkFactor(obs, y, height);
  if (shrink <= 0) return false;

  const local = getColliderLocalPoint(x, z, obs);
  return testOrigRectCircle((obs.w / 2) * shrink, (obs.d / 2) * shrink, local.x, local.z, radius);
}

// The tank box against a pyramid. The pyramid's cross-section shrinks with
// height exactly as it does for the cylinder test, so only the shape tested
// against it differs.
function pyramidIntersectsTank(obs, x, y, z, rotation, height, slack = 0, tankScale = null) {
  const baseY = obs.baseY || 0;
  if (y + height < baseY) return false;
  if (y >= baseY + getPyramidHeight(obs)) return false;

  const shrink = pyramidShrinkFactor(obs, y, height);
  if (shrink <= 0) return false;

  const local = getColliderLocalPoint(x, z, obs);
  return testOrigRectTank(
    (obs.w / 2) * shrink, (obs.d / 2) * shrink,
    local.x, local.z,
    getTankLocalAngle(rotation, obs.rotation),
    slack,
    tankScale
  );
}

// A box's own extreme corner along `dir`, and the opposite one -- the two
// candidates any separating-axis test ever needs from an axis-aligned box,
// upstream's own `projectAxisBox` (Intersect.cxx). `mins`/`maxs` are each
// `[x, y, z]`; returns `[min, max]` of the box's projection onto `dir`.
function projectAxisBox(dir, mins, maxs) {
  let ix; let iy; let iz;
  let ox; let oy; let oz;
  if (dir[0] > 0) { ix = maxs[0]; ox = mins[0]; } else { ix = mins[0]; ox = maxs[0]; }
  if (dir[1] > 0) { iy = maxs[1]; oy = mins[1]; } else { iy = mins[1]; oy = maxs[1]; }
  if (dir[2] > 0) { iz = maxs[2]; oz = mins[2]; } else { iz = mins[2]; oz = maxs[2]; }
  const idist = (dir[0] * ix) + (dir[1] * iy) + (dir[2] * iz);
  const odist = (dir[0] * ox) + (dir[1] * oy) + (dir[2] * oz);
  return idist < odist ? [idist, odist] : [odist, idist];
}

// A polygon's own projection onto `dir` -- upstream's own `projectPolygon`.
// `points` is an array of `[x, y, z]`.
function projectPolygon(dir, points) {
  let minDist = Infinity;
  let maxDist = -Infinity;
  for (const p of points) {
    const dist = (p[0] * dir[0]) + (p[1] * dir[1]) + (p[2] * dir[2]);
    if (dist < minDist) minDist = dist;
    if (dist > maxDist) maxDist = dist;
  }
  return [minDist, maxDist];
}

// Does a planar polygon touch an axis-aligned box, both already expressed in
// the same frame -- upstream's own `testPolygonInAxisBox` (Intersect.cxx),
// the general routine every wall/mesh scene node and `MeshFace::inBox` itself
// build on. `plane` is the polygon's own `[nx, ny, nz, d]`; `points` its
// vertices, `[x, y, z]` each, in face-winding order. Two kinds of separating
// axis rule this out: the polygon's own plane (does the box straddle it at
// all), then each edge crossed with each of the box's three face normals --
// the box's own face normals need no test of their own, since they *are* the
// coordinate axes here and the plane test already covers the polygon's.
function testPolygonInAxisBox(points, plane, mins, maxs) {
  const i = [0, 0, 0];
  const o = [0, 0, 0];
  for (let t = 0; t < 3; t++) {
    if (plane[t] > 0) { i[t] = maxs[t]; o[t] = mins[t]; } else { i[t] = mins[t]; o[t] = maxs[t]; }
  }
  const icross = (plane[0] * i[0]) + (plane[1] * i[1]) + (plane[2] * i[2]) + plane[3];
  const ocross = (plane[0] * o[0]) + (plane[1] * o[1]) + (plane[2] * o[2]) + plane[3];
  if (icross * ocross > 0) return false;

  const axisNormals = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const n = points.length;
  for (let t = 0; t < n; t++) {
    const next = (t + 1) % n;
    const edge = [
      points[next][0] - points[t][0],
      points[next][1] - points[t][1],
      points[next][2] - points[t][2],
    ];
    for (let a = 0; a < 3; a++) {
      const axis = axisNormals[a];
      const cross = [
        (edge[1] * axis[2]) - (edge[2] * axis[1]),
        (edge[2] * axis[0]) - (edge[0] * axis[2]),
        (edge[0] * axis[1]) - (edge[1] * axis[0]),
      ];
      const lenSq = (cross[0] * cross[0]) + (cross[1] * cross[1]) + (cross[2] * cross[2]);
      if (lenSq < 0.001) continue;
      const [boxMin, boxMax] = projectAxisBox(cross, mins, maxs);
      const [polyMin, polyMax] = projectPolygon(cross, points);
      if (boxMin > polyMax || boxMax < polyMin) return false;
    }
  }
  return true;
}

// A face's own normal is exactly vertical (upstream's `UpPlane`/`DownPlane`,
// MeshFace.cxx:220-236 -- a fudge of 1e-5 off dead flat) rather than merely
// tilted some: the one case `meshFaceBlocksDirection` must treat as always
// blocking regardless of travel direction, because resting on one with zero
// vertical velocity has nothing meaningful to dot against, and it still has
// to hold the tank up.
const MESH_FLAT_PLANE_THRESHOLD = 1 - 1e-5;

// Whether a face blocks a query travelling in `direction` -- upstream's own
// filter, and the reason it never gets the straddle bug bzo's first version
// had: `World::hitBuilding` (World.cxx:367-380) does not accept a candidate
// face as a hit at all unless it is a flat top/bottom or the query is
// actually moving into its outward normal (`scratchPad < 0.0`); a face the
// query is moving *along* or *away from* is not a blocker no matter how much
// of the query's own extent still geometrically overlaps its plane. Without
// this, a tank exiting a mesh through one of its own full-height walls --
// off the edge of a roof, or sliding along a wall at an angle -- can find
// that same wall "still touching" for its own entire body length while
// straddling the exit, and since a single frame's motion never covers that
// whole length, the search this file's own binary search runs resolves to
// "no progress possible" every single frame: not a fall or a slide, a
// motionless stall. `direction` is null for a static, non-directional query
// (upstream's own `!directional`), which always blocks regardless -- the
// same as never having read this function at all.
//
// A flat top/bottom's own always-block exemption is *only* good within its
// own actual footprint, though -- `pointInMeshFacePolygon` gates it there.
// A query box is wide enough to still overlap a floor's polygon (a corner
// candidate) from a position genuinely outside it, past whichever wall
// meets it there, exactly the same straddle this function otherwise
// prevents -- but that wall has already correctly let the query pass, since
// it is a wall and gets the dot-product test above. Without this gate the
// floor overrode that answer, its own flat exemption blocking motion no
// wall was blocking a step outside the mesh's footprint at the mesh's own
// ground level was ever going to be near in the first place.
function meshFaceBlocksDirection(face, direction, obs, x, y, z) {
  if (!direction) return true;
  if (Math.abs(face.plane[1]) >= MESH_FLAT_PLANE_THRESHOLD) {
    return pointInMeshFacePolygon(obs, face, x, y, z);
  }
  const dot = (face.plane[0] * direction.x) + (face.plane[1] * direction.y) + (face.plane[2] * direction.z);
  return dot < 0;
}

// A mesh against a vertical cylinder, face by face -- `MeshFace::inCylinder`
// is itself `inBox(p, 0, radius, radius, height)` upstream (a square
// footprint, not a true circle), so that is what this tests too: each face
// translated into the cylinder's own frame (never rotated -- a cylinder has
// none), against an axis-aligned box `radius` out on X and Z, `height` tall
// on Y. `obs.bounds` rejects the whole mesh in one check before any face's
// own polygon test runs, the same win a broad-phase octree gives upstream --
// see `docs/bzw-plan.md`'s "Mesh geometry". `passField` names whichever of a
// face's own two passability flags this query cares about -- `driveThrough`
// for a tank, `shootThrough` for a shot -- so a face let through by one still
// stops the other, the same per-face split every other obstacle only gets at
// the whole-obstacle level. `direction`, when given, additionally filters
// through `meshFaceBlocksDirection` -- see its own comment.
function findMeshHitFace(obs, x, y, z, radius, height, passField = 'driveThrough', direction = null) {
  const { bounds } = obs;
  if (bounds && (x + radius < bounds.minX || x - radius > bounds.maxX
    || z + radius < bounds.minZ || z - radius > bounds.maxZ)) {
    return null;
  }
  const boxMins = [-radius, 0, -radius];
  const boxMaxs = [radius, height, radius];
  for (const face of obs.faces) {
    if (!face.plane || face[passField] || !meshFaceBlocksDirection(face, direction, obs, x, y, z)) continue;
    const localPoints = face.vertexIndices.map((vi) => {
      const v = obs.vertices[vi];
      return [v.x - x, v.y - y, v.z - z];
    });
    const [nx, ny, nz, d] = face.plane;
    const localPlane = [nx, ny, nz, d + (nx * x) + (ny * y) + (nz * z)];
    if (testPolygonInAxisBox(localPoints, localPlane, boxMins, boxMaxs)) return face;
  }
  return null;
}

// Which face a tank standing at this position is over, ignoring both
// passability flags -- unlike `findMeshHitFace`, which is asking "what
// stopped this tank" and so must skip a `driveThrough` face. A `linear`
// driver still needs an actually-solid face underneath (see
// `findPhysicsSurfaceObstacle`'s own comment) -- a real river's push comes
// from a solid mesh floor, not a passable one (`import-
// bmbz.ducatileague.org_5152.bzw`'s `river_35`/`river_45`/`river_55` faces
// carry no `drivethrough` at all). What genuinely needs this to ignore
// passability is `death`: upstream's own check
// (`LocalPlayer::getHitBuilding`/`collectInsideBuildings`,
// LocalPlayer.cxx:927-937, 986-992) runs on any face the tank's box
// overlaps, before ever asking whether that face is drive-through. No
// `direction` filter either, for the same reason `meshFaceBlocksDirection`
// exists at all: that filter answers "did the tank just hit this face
// moving the way it was," which only matters for a collision response, not
// for "which face is under me right now."
function findMeshFaceAt(obs, x, y, z, radius, height) {
  const { bounds } = obs;
  if (bounds && (x + radius < bounds.minX || x - radius > bounds.maxX
    || z + radius < bounds.minZ || z - radius > bounds.maxZ)) {
    return null;
  }
  const boxMins = [-radius, 0, -radius];
  const boxMaxs = [radius, height, radius];
  for (const face of obs.faces) {
    if (!face.plane) continue;
    const localPoints = face.vertexIndices.map((vi) => {
      const v = obs.vertices[vi];
      return [v.x - x, v.y - y, v.z - z];
    });
    const [nx, ny, nz, d] = face.plane;
    const localPlane = [nx, ny, nz, d + (nx * x) + (ny * y) + (nz * z)];
    if (testPolygonInAxisBox(localPoints, localPlane, boxMins, boxMaxs)) return face;
  }
  return null;
}

// The one physics-driver lookup both the client (motion) and the server
// (anti-cheat extrapolation and the death check) call, so they can never
// disagree about which driver -- if any -- applies at a pose. `obstacle` is
// whatever the caller already knows the tank is currently resting on/
// touching (the client's `lastMotionObstacle`, or a fresh `findTankObstacle`
// result server-side); this never re-derives that itself. A plain box,
// pyramid, or group member carries its own `phydrv` directly; a mesh needs
// its specific face resolved first, since `phydrv` is a per-face property
// there (falling back to the mesh's own top-level default when the found
// face has none, the same default every mesh face already inherits at
// parse time).
function resolvePhysicsDriverAt(obstacle, x, y, z) {
  if (!obstacle) return null;
  if (obstacle.type === 'mesh') {
    const face = findMeshFaceAt(obstacle, x, y, z, 2, 2);
    return (face && face.phydrv) || obstacle.phydrv || null;
  }
  return obstacle.phydrv || null;
}

function meshIntersectsCylinder(obs, x, y, z, radius, height, passField = 'driveThrough', direction = null) {
  return findMeshHitFace(obs, x, y, z, radius, height, passField, direction) !== null;
}

// The tank box against a mesh, face by face -- `MeshFace::inBox`
// (MeshFace.cxx:454) with a real `_angle`, rather than the `inCylinder`
// square it collapses to at zero. Upstream's own comment on why it rotates
// the polygon rather than the box applies here too ("this assumes that it is
// cheaper to move the polygon than the box"): each face's own vertices and
// plane are translated to the tank's position and rotated by its heading, so
// the box being tested against is the plain axis-aligned one below, aligned
// with the tank's own lateral (X) and forward (Z) axes rather than the
// world's. `rotation` is bzo's own tank heading (forward is
// `(-sin r, -cos r)`, everywhere else in this file too) -- at `rotation`
// zero that points forward at local -Z, which is why `halfLength` is this
// box's Z half-extent and `halfWidth` its X one.
function findMeshHitFaceOriented(
  obs, x, y, z, rotation, halfWidth, halfLength, height, passField = 'driveThrough', direction = null,
) {
  const { bounds } = obs;
  // A circular reject cheap enough to run before any face's own rotation --
  // the tank box's own bounding radius around its centre, so this never
  // rejects a face the precise test below would still have caught.
  const boundingRadius = Math.hypot(halfWidth, halfLength);
  if (bounds && (x + boundingRadius < bounds.minX || x - boundingRadius > bounds.maxX
    || z + boundingRadius < bounds.minZ || z - boundingRadius > bounds.maxZ)) {
    return null;
  }
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const boxMins = [-halfWidth, 0, -halfLength];
  const boxMaxs = [halfWidth, height, halfLength];
  for (const face of obs.faces) {
    if (!face.plane || face[passField] || !meshFaceBlocksDirection(face, direction, obs, x, y, z)) continue;
    const localPoints = face.vertexIndices.map((vi) => {
      const v = obs.vertices[vi];
      const dx = v.x - x;
      const dz = v.z - z;
      return [(dx * cos) - (dz * sin), v.y - y, (dx * sin) + (dz * cos)];
    });
    const [nx, ny, nz, d] = face.plane;
    const localPlane = [
      (nx * cos) - (nz * sin),
      ny,
      (nx * sin) + (nz * cos),
      d + (nx * x) + (ny * y) + (nz * z),
    ];
    if (testPolygonInAxisBox(localPoints, localPlane, boxMins, boxMaxs)) return face;
  }
  return null;
}

function meshIntersectsTank(obs, x, y, z, rotation, height, slack = 0, tankScale = null, direction = null) {
  const halfWidth = TANK_HALF_WIDTH * (tankScale ? tankScale.width : 1);
  const halfLength = TANK_HALF_LENGTH * (tankScale ? tankScale.length : 1);
  const trim = Math.max(0, Math.min(slack, halfWidth));
  return findMeshHitFaceOriented(
    obs, x, y, z, rotation, halfWidth - trim, halfLength - trim, height, 'driveThrough', direction,
  ) !== null;
}

// Every face of `obs` touching the box, rather than `findMeshHitFaceOriented`'s
// first -- `World::hitBuilding` (World.cxx:295-378) needs every candidate face
// gathered *before* it decides which one actually answers (see
// `pickPriorityMeshFace`'s own comment for why one mesh's wall is not allowed
// to out-rank a *different* mesh's flat top), so this is that function's own
// loop body with `return` swapped for a push. Appends to `out` and returns it.
function collectMeshHitFacesTank(
  obs, x, y, z, rotation, halfWidth, halfLength, height, passField, direction, out,
) {
  const { bounds } = obs;
  const boundingRadius = Math.hypot(halfWidth, halfLength);
  if (bounds && (x + boundingRadius < bounds.minX || x - boundingRadius > bounds.maxX
    || z + boundingRadius < bounds.minZ || z - boundingRadius > bounds.maxZ)) {
    return out;
  }
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const boxMins = [-halfWidth, 0, -halfLength];
  const boxMaxs = [halfWidth, height, halfLength];
  for (const face of obs.faces) {
    if (!face.plane || face[passField] || !meshFaceBlocksDirection(face, direction, obs, x, y, z)) continue;
    const localPoints = face.vertexIndices.map((vi) => {
      const v = obs.vertices[vi];
      const dx = v.x - x;
      const dz = v.z - z;
      return [(dx * cos) - (dz * sin), v.y - y, (dx * sin) + (dz * cos)];
    });
    const [nx, ny, nz, d] = face.plane;
    const localPlane = [
      (nx * cos) - (nz * sin),
      ny,
      (nx * sin) + (nz * cos),
      d + (nx * x) + (ny * y) + (nz * z),
    ];
    if (testPolygonInAxisBox(localPoints, localPlane, boxMins, boxMaxs)) out.push({ obs, face });
  }
  return out;
}

// The cylinder's own version of `collectMeshHitFacesTank`, mirroring
// `findMeshHitFace`'s loop the same way that one mirrors
// `findMeshHitFaceOriented`.
function collectMeshHitFacesCylinder(obs, x, y, z, radius, height, passField, direction, out) {
  const { bounds } = obs;
  if (bounds && (x + radius < bounds.minX || x - radius > bounds.maxX
    || z + radius < bounds.minZ || z - radius > bounds.maxZ)) {
    return out;
  }
  const boxMins = [-radius, 0, -radius];
  const boxMaxs = [radius, height, radius];
  for (const face of obs.faces) {
    if (!face.plane || face[passField] || !meshFaceBlocksDirection(face, direction, obs, x, y, z)) continue;
    const localPoints = face.vertexIndices.map((vi) => {
      const v = obs.vertices[vi];
      return [v.x - x, v.y - y, v.z - z];
    });
    const [nx, ny, nz, d] = face.plane;
    const localPlane = [nx, ny, nz, d + (nx * x) + (ny * y) + (nz * z)];
    if (testPolygonInAxisBox(localPoints, localPlane, boxMins, boxMaxs)) out.push({ obs, face });
  }
  return out;
}

// `World::compareHitNormal` (World.cxx:268-293) plus its caller's own accept
// test right below it: an up plane always outranks a wall, whichever mesh
// each belongs to, because a tank standing on a flat top has nothing
// meaningful to slide along a *different* mesh's wall with -- that wall
// happening to also brush the query box at the exact seam between two
// abutting meshes is geometry, not a reason to stop. Ties between two up
// planes go to the higher one; ties between walls go to whichever the query
// is heading into more squarely (most negative dot first), upstream's own
// order, kept here only because it is free once the list is already sorted.
//
// This is what `findTankObstacle` did not do before: it asked each mesh in
// turn and returned the first one that answered at all, so which of two
// abutting meshes' faces won depended on their position in the obstacle
// list, not on which one actually mattered. A tank crossing from one mesh's
// flat top onto another's could have the far mesh's own perimeter wall --
// found first only because of array order -- answer instead of the near
// mesh's floor, and a wall's answer is "you are blocked," which a floor's
// never is.
function pickPriorityMeshFace(candidates, direction) {
  if (candidates.length === 0) return null;
  const scored = candidates.map((candidate) => {
    const { face } = candidate;
    const isUp = face.plane[1] >= MESH_FLAT_PLANE_THRESHOLD;
    const dot = direction
      ? (direction.x * face.plane[0]) + (direction.y * face.plane[1]) + (direction.z * face.plane[2])
      : -1;
    const upHeight = isUp ? candidate.obs.vertices[face.vertexIndices[0]].y : 0;
    return { ...candidate, isUp, dot, upHeight };
  });
  scored.sort((a, b) => {
    if (a.isUp !== b.isUp) return a.isUp ? -1 : 1;
    if (a.isUp) return b.upHeight - a.upHeight;
    return a.dot - b.dot;
  });
  return scored[0].obs;
}

// The plane normal to reflect a ricocheting shot about. `hitFace`, when
// given, is the exact face `findMeshFaceCrossing` already found by walking
// the ray itself -- the caller's job, since only the ray sweep knows which
// face the shot actually crossed. Without one (a caller that never traced a
// ray to get here) this falls back to `findMeshHitFace`'s static touching
// test, which is a real "first hit wins" ambiguity right where a small
// mesh's faces meet -- e.g. a tetrahedron's three walls all share their
// base edge with its flat bottom face, so a shot resting close to the
// ground there can be "touching" more than one face, and array order used
// to pick a wrong one, reflecting the shot off the bottom's normal instead
// of the wall's. Passing `hitFace` sidesteps that rather than resolving it.
function getMeshHitNormal(obs, x, y, z, radius, hitFace = null) {
  const face = hitFace || findMeshHitFace(obs, x, y, z, radius, radius, 'shootThrough');
  if (!face) return { x: 0, y: 1, z: 0 };
  return { x: face.plane[0], y: face.plane[1], z: face.plane[2] };
}

// A teleporter's frame and the opening inside it. The importer resolves the
// frame itself into `w`/`d`/`h` before the world goes on the wire, so this
// derives only the portal, which is the frame minus its border.
function getShotTeleporterDims(obs) {
  const halfW = obs.w / 2;
  const halfD = obs.d / 2;
  const h = obs.h;
  const border = obs.border;
  return {
    halfW,
    halfD,
    h,
    border,
    activeHalfD: Math.max(0.1, halfD - border),
    activeH: Math.max(0.2, h - border),
  };
}

// World::hitBuilding (World.cxx:322): the first solid in `obstacles` that the
// occupant is inside of, or null.
//
// One implementation, called by both ends. The client resolves moves with it and
// the server rejects them with it -- different jobs, but "which volume is solid"
// is one question and used to be answered by two copies of this loop that had
// already drifted: the server tested every inverted pyramid as though it were
// upright, and its vertical gate carried a slack the client's did not.
//
// The occupant is BZFlag's oriented 2.8 x 6.0 tank box (Obstacle::inBox) when a
// `rotation` is given, and a cylinder of `radius` when it is not -- upstream's
// own split, `inBox` for a tank and `inCylinder` for a projectile. `height`
// defaults to the radius, which is what the cylinder callers mean by it.
//
// `fromY` is where a step began, and it is what makes this Obstacle::inBox or
// Obstacle::inMovingBox: given one, the vertical extent is the span the occupant
// swept rather than the point it ended at, so a frame long enough to carry a
// tank through a roof still reports the roof. Pyramids opt out exactly as
// PyramidBuilding::inMovingBox does -- a slope's cross-section depends on the
// height it is taken at, so there is no one rectangle to sweep.
//
// `slack` shrinks the occupant and nothing else, so it can only ever remove a
// collision. It is how the server stays strictly more permissive than the
// client about a quantized position; the teleporter's portal keeps the full
// shape, because slack there would make a portal harder to pass through.
//
// `phased` is `OO` and a zoned `PZ`: a phased tank is not expelled by what it
// drives into, so what it passes through is not something this can report.
function findTankObstacle(obstacles, x, y, z, options = {}) {
  const rotation = options.rotation;
  const useTankBox = Number.isFinite(rotation);
  const radius = Number.isFinite(options.radius) ? options.radius : 2;
  const height = Number.isFinite(options.height) ? options.height : radius;
  const fromY = Number.isFinite(options.fromY) ? options.fromY : y;
  const slack = Math.max(0, Math.min(options.slack || 0, radius));
  // The direction this particular query is travelling, for a mesh's own
  // `meshFaceBlocksDirection` filter -- null (always-blocking, upstream's
  // own `!directional`) unless the caller actually knows where it came
  // from. Only meaningful with a real step behind it, so a static "is this
  // point clear" query (no `fromX`/`fromZ` given) still treats every
  // touching face as a hit, same as before this existed.
  const direction = (Number.isFinite(options.fromX) && Number.isFinite(options.fromZ))
    ? { x: x - options.fromX, y: y - fromY, z: z - options.fromZ }
    : null;
  const tankScale = options.tankScale || null;
  const phased = options.phased === true;
  const reversingOnGround = options.reversingOnGround === true;
  const ignoreTeleporters = options.ignoreTeleporters === true;
  const epsilon = Number.isFinite(options.verticalEpsilon) ? options.verticalEpsilon : 0;
  // A safe (never-too-small) horizontal margin for the broad-phase reject
  // below: the oriented tank box's own circumscribing radius when this is a
  // box query, since its real half-extents can exceed the plain `radius`
  // the cylinder case uses -- the same `Math.hypot(halfWidth, halfLength)`
  // `findMeshHitFaceOriented` already computes for the identical reason.
  const boundsMargin = useTankBox
    ? Math.hypot(
      TANK_HALF_WIDTH * (tankScale ? tankScale.width : 1),
      TANK_HALF_LENGTH * (tankScale ? tankScale.length : 1),
    )
    : radius;

  // A mesh face is never returned the instant it answers -- see
  // `pickPriorityMeshFace`'s own comment -- so every touching face from
  // every mesh obstacle collects here first, and only the winner of that
  // whole set is returned once the loop below finishes without a non-mesh
  // hit.
  const meshCandidates = [];

  for (const obs of obstacles) {
    if (!obs) continue;
    if (ignoreTeleporters && obs.kind === 'teleporter') continue;
    if (phased && !phasedObstacleExpels(obs, reversingOnGround)) continue;
    // `drivethrough` in a `.bzw`, `Obstacle::isDriveThrough`: an obstacle an
    // occupant passes straight through. `shootThrough` is its other half.
    if (obs.driveThrough) continue;

    // Every obstacle now carries a precomputed world-space AABB (`obs.bounds`,
    // set once at map load -- see server.js), the same shape a mesh's own
    // vertex-derived one always was. Entirely out of horizontal range on
    // this one -- to any one side of the query point, by more than this
    // query's own reach -- can never hit, whatever shape the obstacle
    // actually is, so this runs before any type-specific narrow-phase test
    // below rather than duplicated inside each one.
    if (obs.bounds && (x + boundsMargin < obs.bounds.minX || x - boundsMargin > obs.bounds.maxX
      || z + boundsMargin < obs.bounds.minZ || z - boundsMargin > obs.bounds.maxZ)) continue;

    const obstacleBase = obs.baseY || 0;
    const obstacleTop = obstacleBase + getObstacleHeight(obs);
    // A pyramid already tests the candidate height alone rather than sweeping
    // from `fromY`, because its cross-section changes with height and a stale
    // start height answers the wrong question. A teleporter's jamb needs the
    // same treatment for a different reason: it is tall (its active portal
    // spans nearly its own full height) and thin in the horizontal plane it
    // actually needs tunnelling protection on, so sweeping the *vertical* test
    // from `fromY` buys nothing -- and once a tank is already embedded at some
    // height inside that tall span (jammed against the jamb, still falling),
    // `fromY` stops being a known-clear starting point and starts being the
    // stuck one. Every candidate the search then tries still has `fromY` as
    // one end of its swept range, so the sweep always crosses the whole active
    // band regardless of how far the candidate has actually fallen -- nothing
    // is ever "newly clear", and the tank is pinned at that height forever,
    // however much velocity gravity piles on. Testing the candidate alone, as
    // the pyramid already does, lets a tank slide down (or up past) a
    // teleporter's edge exactly as it would off any other obstacle's corner.
    const spanFromY = (obs.type === 'pyramid' || obs.kind === 'teleporter') ? y : fromY;
    if (!movingTankOverlapsHeight(
      obstacleBase, obstacleTop, spanFromY, y, height, epsilon)) continue;

    if (obs.type === 'pyramid') {
      const hits = useTankBox
        ? pyramidIntersectsTank(obs, x, y, z, rotation, height, slack, tankScale)
        : pyramidIntersectsCylinder(obs, x, y, z, radius - slack, height);
      if (hits) return obs;
      continue;
    }

    if (obs.type === 'mesh') {
      if (useTankBox) {
        const halfWidth = TANK_HALF_WIDTH * (tankScale ? tankScale.width : 1);
        const halfLength = TANK_HALF_LENGTH * (tankScale ? tankScale.length : 1);
        const trim = Math.max(0, Math.min(slack, halfWidth));
        collectMeshHitFacesTank(
          obs, x, y, z, rotation, halfWidth - trim, halfLength - trim, height, 'driveThrough', direction,
          meshCandidates,
        );
      } else {
        collectMeshHitFacesCylinder(obs, x, y, z, radius - slack, height, 'driveThrough', direction, meshCandidates);
      }
      continue;
    }

    const local = getColliderLocalPoint(x, z, obs);
    const tankAngle = useTankBox ? getTankLocalAngle(rotation, obs.rotation) : 0;
    const hitsRect = (rectHalfW, rectHalfD, rectSlack, centerOffsetZ = 0) => (useTankBox
      ? testOrigRectTank(rectHalfW, rectHalfD, local.x, local.z - centerOffsetZ, tankAngle, rectSlack, tankScale)
      : testOrigRectCircle(rectHalfW, rectHalfD, local.x, local.z - centerOffsetZ, radius - rectSlack));

    if (obs.kind === 'teleporter') {
      const dims = getShotTeleporterDims(obs);
      if (!hitsRect(dims.halfW, dims.halfD, slack)) continue;

      // Teleporter::inBox (Teleporter.cxx:259): the frame is not a footprint
      // with a hole cut from its middle -- it is two border-square pillars
      // flanking the doorway, plus a crossbar above them spanning the whole
      // width. "Does the occupant overlap the doorway rectangle" is not the
      // same question as "is it passing cleanly through": the occupant is
      // bigger than the border (every tank is -- the border here is ~1 unit,
      // the tank 6.0 long), so it can reach past the border into the doorway
      // while its centre, and the rest of its body, is still over solid
      // pillar material. Testing each pillar directly, as upstream does,
      // answers the actual question.
      const pillarR = dims.border / 2;
      const pillarOffset = dims.halfD - pillarR;
      const overlapsPillarBand = movingTankOverlapsHeight(
        obstacleBase, obstacleBase + dims.activeH, spanFromY, y, height, epsilon);
      if (overlapsPillarBand && (
        hitsRect(pillarR, pillarR, 0, pillarOffset) || hitsRect(pillarR, pillarR, 0, -pillarOffset)
      )) return obs;

      const overlapsHeaderBand = movingTankOverlapsHeight(
        obstacleBase + dims.activeH, obstacleTop, spanFromY, y, height, epsilon);
      if (overlapsHeaderBand && hitsRect(dims.halfW, dims.halfD, 0)) return obs;

      continue;
    }

    if (hitsRect(obs.w / 2, obs.d / 2, slack)) return obs;
  }
  return pickPriorityMeshFace(meshCandidates, direction);
}

// The obstacle a physics driver applies from at this position -- a support
// test, not a collision one, and deliberately not `findTankObstacle` with a
// generous epsilon: that function's vertical slack (`movingTankOverlapsHeight`)
// exists to let a tank resting exactly on solid ground read as *clear*, which
// is exactly backwards for "what am I resting on". Upstream keeps these
// separate too -- `LocalPlayer::collectInsideBuildings`/`getHitBuilding`
// (LocalPlayer.cxx:927-937, 986-992) run the physics-driver/death check on
// every face `MeshFace::inBox` reports touching, before ever asking whether
// that face is drive-through, and `inBox`'s own Z test (MeshFace.cxx:460,
// `mins[2] > p[2]+height` / `maxs[2] < p[2]`) is inclusive at the touching
// boundary rather than exclusive like this file's anti-cheat one. So this
// ignores `driveThrough` entirely (a conveyor or death floor a tank drives
// straight across is exactly what a physics driver is often carried on --
// `findMeshFaceAt` already does the same for a mesh face, for the same
// reason) and tests the vertical span the same inclusive way.
function findPhysicsSurfaceObstacle(obstacles, x, y, z, radius = 2, height = 2) {
  for (const obs of obstacles) {
    if (!obs) continue;
    if (obs.bounds && (x + radius < obs.bounds.minX || x - radius > obs.bounds.maxX
      || z + radius < obs.bounds.minZ || z - radius > obs.bounds.maxZ)) continue;

    if (obs.type === 'mesh') {
      if (findMeshFaceAt(obs, x, y, z, radius, height)) return obs;
      continue;
    }

    const obstacleBase = obs.baseY || 0;
    const obstacleTop = obstacleBase + getObstacleHeight(obs);
    if (obstacleBase > y + height || obstacleTop < y) continue;

    if (obs.type === 'pyramid') {
      if (pyramidIntersectsCylinder(obs, x, y, z, radius, height)) return obs;
      continue;
    }
    if (obs.kind === 'teleporter' || obs.kind === 'base') continue;

    const local = getColliderLocalPoint(x, z, obs);
    if (testOrigRectCircle(obs.w / 2, obs.d / 2, local.x, local.z, radius)) return obs;
  }
  return null;
}

// BaseBuilding, as World::whoseBase reads it (World.cxx:181). A base's top
// surface is what counts: a tank captures by standing on it, not by driving
// past its side.
function getBaseTopY(obs) {
  return (obs.baseY || 0) + (obs.h || 0);
}

// True when (x, y, z) is on this base's top face. Upstream tests the rotated
// rectangle and then the altitude against a 0.1 epsilon kludge -- its comment,
// and it is what lets a tank sitting on the surface count as on it.
const BASE_TOP_TOLERANCE = 0.1;

function isOnBaseTop(obs, x, y, z) {
  const { x: localX, z: localZ } = getColliderLocalPoint(x, z, obs);
  if (Math.abs(localX) >= obs.w / 2) return false;
  if (Math.abs(localZ) >= obs.d / 2) return false;
  return Math.abs(y - getBaseTopY(obs)) < BASE_TOP_TOLERANCE;
}

// Which team's base a point is standing on, as its BZFlag colour index, or null
// for none. Bases are the obstacles carrying kind 'base'.
function getBaseTeamAtPoint(obstacles, x, y, z) {
  for (const obs of obstacles) {
    if (obs.kind !== 'base') continue;
    if (isOnBaseTop(obs, x, y, z)) return obs.team;
  }
  return null;
}

// MeshFace::isUpPlane's own threshold (MeshFace.cxx: `(fabsf(plane[2]) + fudge)
// >= 1.0f`, upstream's Z being bzo's Y) -- a face this close to horizontal, and
// no closer, counts as a real flat top rather than a steep roof someone could
// still stand near the peak of.
const MESH_FLAT_TOP_MIN_UP = 1 - 1e-4;

// isValidLanding()'s mesh case: upstream never asks a whole MeshObstacle
// whether it isFlatTop() -- a mesh has no one answer, since one of its faces
// may be a wall and another a roof -- it asks each `MeshFace` alone, because
// the collision manager's ray test already hands back individual faces. bzo
// has no per-face ray test to reuse here, so this walks every face itself and
// asks the same two questions upstream's ray hit would have answered for it:
// pointing up, and standing under (x, z). The point-in-polygon test reuses
// `testPolygonInAxisBox` with a box shrunk to a fleck -- the same call
// `findMeshFaceAt` makes for a real occupant, just with no size of its own.
// Every flat top this mesh presents over (x, z), as heights, highest last is not
// promised -- the caller sorts for the direction it is searching.
//
// Upstream never needs this: each mesh face is its own collision obstacle there
// (`CollisionManager.cxx:345` files `mesh->getFace(f)` individually), so
// `DropGeometry::dropIt` gets face heights straight out of a downward ray and
// `getExtents().maxs[2]` is the height of *that face*. bzo keeps a mesh whole,
// where the same expression gives the top of the entire object -- a mountain
// peak rather than the ground you are standing on -- so the per-face heights
// are gathered here instead and the caller picks among them as `dropIt` does.
function meshFlatTopYsAt(obs, x, z) {
  const { bounds } = obs;
  if (!bounds || x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) {
    return [];
  }
  const speck = 1e-3;
  const tops = [];
  for (const face of obs.faces) {
    if (!face.plane || face.plane[1] < MESH_FLAT_TOP_MIN_UP) continue;
    // An up-plane is horizontal to within the same fudge at both ends, so every
    // vertex of one shares a height and the first is the face's own.
    const y = obs.vertices[face.vertexIndices[0]].y;
    const localPoints = face.vertexIndices.map((vi) => {
      const v = obs.vertices[vi];
      return [v.x - x, v.y - y, v.z - z];
    });
    const [nx, ny, nz, d] = face.plane;
    const localPlane = [nx, ny, nz, d + (nx * x) + (ny * y) + (nz * z)];
    if (testPolygonInAxisBox(
      localPoints,
      localPlane,
      [-speck, -speck, -speck],
      [speck, speck, speck],
    )) {
      tops.push(y);
    }
  }
  return tops;
}
// Whether any of them exists, which is all a footprint test needs.
function isOverMeshFlatTopAt(obs, x, z) {
  return meshFlatTopYsAt(obs, x, z).length > 0;
}

// The footprint test a flag drop uses, with no radius: DropGeometry gives a team
// flag a radius of 0, so only the point itself has to be over the surface.
function isOverFlatTop(obs, x, z) {
  if (obs.type === 'mesh') {
    return isOverMeshFlatTopAt(obs, x, z);
  }
  if (obs.type === 'pyramid') {
    if (!isPyramidFlatTop(obs)) return false;
    return isWithinPyramidFootprint(obs, x, z);
  }
  const { x: localX, z: localZ } = getColliderLocalPoint(x, z, obs);
  return Math.abs(localX) < obs.w / 2 && Math.abs(localZ) < obs.d / 2;
}

// --- Swept motion -----------------------------------------------------------
//
// A tank moves once per frame, so a slow frame moves it a long way, and asking
// only where the step ended lets it pass clean through a surface it crossed on
// the way. Upstream answers this without a smaller timestep: it widens the
// *vertical* extent of the occupant test to the span the step covered
// (BoxBuilding::inMovingBox, Teleporter::inMovingBox; a base delegates to the
// box). The footprint stays where the step ended, and pyramids opt out --
// PyramidBuilding::inMovingBox ignores the old position entirely, because a
// slope's cross-section depends on the height it is taken at, so there is no
// one rectangle to sweep.
//
// `epsilon` is the caller's own vertical tolerance, so an occupant resting
// exactly on a surface reads as on it rather than in it, as the point test does.
function movingTankOverlapsHeight(obstacleBase, obstacleTop, fromY, toY, tankHeight, epsilon) {
  const lowY = fromY < toY ? fromY : toY;
  const highY = fromY < toY ? toY : fromY;
  if (lowY >= obstacleTop - epsilon) return false;
  if (highY + tankHeight <= obstacleBase + epsilon) return false;
  return true;
}

// The roof half of Obstacle::getHitNormal (Obstacle.cxx:165). Upstream rays the
// tank's corners at the obstacle's sides, then -- on the way down only, "don't
// care about way up" -- solves for the moment the tank met the flat top, and
// takes the top when that came first. The surface it hands back has an up
// normal, which the motion resolver reads as a landing rather than a wall.
//
// So a landing is a question about which plane the step crossed, not about how
// near the top it started: a step beginning at or above the top and ending
// below it landed on it, however far it fell.
function crossedFlatTop(obstacleTop, fromY, toY) {
  return fromY >= obstacleTop && toY < obstacleTop;
}

// --- Phasing ----------------------------------------------------------------

// LocalPlayer::getHitBuilding's `expelled` (LocalPlayer.cxx:914). A phased tank
// -- one carrying `OO` Oscillation Overthruster -- finds obstacles the same way
// any other does and is simply not thrown out of them, which is the whole of
// how it drives through a building. Three things throw it out anyway:
//
//   - a wall, which is bzo's world border. Upstream's WallObstacle is a
//     height-ignoring half-space no flag passes, and phasing out of the world
//     would be leaving it.
//   - a teleporter, so `OO` crosses one rather than driving through its frame.
//   - a reverse at ground level, which is upstream's own third term. Backing out
//     of a building is refused by `applyMotionInput` while the tank is inside
//     one, so this is what stops a tank *outside* one from reversing into it.
//
// Nothing else is exempt: a phased tank falls through a roof rather than resting
// on it, because a roof it is not expelled from is not a surface.
function phasedObstacleExpels(obs, reversingOnGround = false) {
  if (!obs) return false;
  if (obs.collisionKind === 'boundary') return true;
  if (obs.kind === 'teleporter') return true;
  return reversingOnGround === true;
}

// True when the tank's footprint sits entirely within the obstacle's, both
// already in the obstacle's local frame. `testRectInRect` (Intersect.cxx), and
// the reason a tank swallowed whole by a building gets no lights: every corner
// is inside, so there is no wall for the effect to hang off.
function tankRectInsideOrigRect(halfW, halfD, localX, localZ, tankAngle, tankScale = null) {
  const halfWidth = TANK_HALF_WIDTH * (tankScale ? tankScale.width : 1);
  const halfLength = TANK_HALF_LENGTH * (tankScale ? tankScale.length : 1);
  const cos = Math.cos(tankAngle);
  const sin = Math.sin(tankAngle);
  for (const [sw, sl] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
    const cornerW = sw * halfWidth;
    const cornerL = sl * halfLength;
    const cx = localX + cos * cornerW - sin * cornerL;
    const cz = localZ + sin * cornerW + cos * cornerL;
    if (Math.abs(cx) > halfW || Math.abs(cz) > halfD) return false;
  }
  return true;
}

// The face a phasing tank is currently straddling, or null. `isCrossing`
// (BoxBuilding.cxx:143, PyramidBuilding.cxx:228, BaseBuilding.cxx:85 -- the
// three bodies are the same one, so this is one function), which is what
// upstream feeds both the tank clip plane and the interdimensional lights.
//
// Null in two different situations that look alike from outside: the tank is
// clear of the obstacle, or it is *entirely inside* it. A tank swallowed whole
// has no wall to be half-in, so upstream draws nothing -- which is why the
// lights appear on the way in, vanish in the middle of a thick building and
// appear again on the way out.
//
// The returned plane is `nx*x + ny*y + nz*z + d`, unit-length and signed
// positive on the *outside*: the tank's visible half is the positive one and
// the half buried in the building is what a clip plane cuts away.
//
// Which wall is a guess -- the one the tank's centre is nearest -- and upstream
// calls it one: "this is a guestimate, should really do a careful test". It is
// wrong only for a tank straddling a corner, where either wall is defensible.
// Kept as a guess deliberately, because the effect it feeds is decoration and
// the careful test would be paid for by every phasing tank every frame.
function getBoxCrossingPlane(obs, x, y, z, rotation, tankScale = null) {
  if (!obs) return null;
  const base = obs.baseY || 0;
  const height = getObstacleHeight(obs);
  // inBox's height term. A tank clear of the obstacle vertically is not in it,
  // whatever its footprint says -- this is what stops a tank driving over a
  // low wall from wearing lights.
  if (y >= base + height || y + TANK_HEIGHT <= base) return null;

  const halfW = obs.w / 2;
  const halfD = obs.d / 2;
  const local = getColliderLocalPoint(x, z, obs);
  const tankAngle = getTankLocalAngle(rotation, obs.rotation);
  if (!testOrigRectTank(halfW, halfD, local.x, local.z, tankAngle, 0, tankScale)) return null;
  if (tankRectInsideOrigRect(halfW, halfD, local.x, local.z, tankAngle, tankScale)) return null;

  // The nearer wall, measured from the centre to each face. Local, so the two
  // candidates are the local x and z axes and the sign picks which of the pair.
  let localNormalX = 0;
  let localNormalZ = 0;
  let reach = 0;
  if (Math.abs(Math.abs(local.x) - halfW) < Math.abs(Math.abs(local.z) - halfD)) {
    localNormalX = local.x < 0 ? -1 : 1;
    reach = halfW;
  } else {
    localNormalZ = local.z < 0 ? -1 : 1;
    reach = halfD;
  }

  // Vertical for a box, tilted to the slope for a pyramid. Upstream's own
  // `plane[2] = h * getWidth()` with `h = 1/hypot(height, width)`, and its own
  // FIXME that this assumes a square base -- so a pyramid with w != d gets a
  // plane at the wrong angle here exactly as it does upstream.
  let normalY = 0;
  let scale = 1;
  if (obs.type === 'pyramid' && height > 0) {
    // Upstream's `getWidth()` is the half-extent -- `pw = position + getWidth()
    // * normal` is a point on the wall -- so this reads halfW, not the span.
    const h = 1 / Math.hypot(height, halfW);
    normalY = h * halfW;
    scale = h * height;
  }
  // rotateNormalToWorld normalises, so this is the wall's unit outward
  // direction whatever length goes in; `reach` turns it back into a distance.
  const normal = rotateNormalToWorld(obs, localNormalX, 0, localNormalZ);
  const nx = normal.x * scale;
  const nz = normal.z * scale;
  // Through the point on the wall. `d` uses only the horizontal components
  // because that point has no height of its own, which is upstream's
  // arithmetic even where the plane is tilted.
  const pointX = obs.x + normal.x * reach;
  const pointZ = obs.z + normal.z * reach;
  return { x: nx, y: normalY, z: nz, d: -(nx * pointX + nz * pointZ) };
}

// `getBoxCrossingPlane`'s own guess, generalized to a mesh (#77): a box or a
// pyramid has one wall per side to be nearest to, so "which face is the tank
// straddling" is arithmetic on `w`/`d`; a mesh has whatever faces its author
// gave it, so the same question is answered the way collision already answers
// "which face is this tank touching" -- `findMeshHitFaceOriented`, the same
// call `findInsideBuildings` itself uses to decide a tank is inside this mesh
// at all. A mesh face's own `plane` is already `nx*x + ny*y + nz*z + d`,
// unit-length, outward-positive -- `getBoxCrossingPlane`'s own convention --
// because it is the same convention `meshFaceBlocksDirection` already needs
// to tell a solid face's front from its back, so nothing here has to rebuild
// it.
function getMeshCrossingPlane(obs, x, y, z, rotation, tankScale = null) {
  if (!obs) return null;
  const halfWidth = TANK_HALF_WIDTH * (tankScale ? tankScale.width : 1);
  const halfLength = TANK_HALF_LENGTH * (tankScale ? tankScale.length : 1);
  const face = findMeshHitFaceOriented(obs, x, y, z, rotation, halfWidth, halfLength, TANK_HEIGHT);
  if (!face || !face.plane) return null;
  const [nx, ny, nz, d] = face.plane;
  return { x: nx, y: ny, z: nz, d };
}

// --- Shots ------------------------------------------------------------------
//
// A shot occupies the world the way a tank does, but always as a cylinder:
// upstream tests Obstacle::inCylinder for a projectile and keeps
// Obstacle::inBox for a tank. Ricochet is
// SegmentedShotStrategy::makeSegments(Reflect) -- the shot reflects about the
// surface normal and keeps its lifetime running instead of ending at the wall.
//
// Upstream builds the whole bounce path once, when the shot is fired, because
// each of its clients owns the shots it fires. bzo integrates a shot a fixed
// step at a time on both sides, so a reflection happens inside a step; the
// client draws the bounce and the server hits with it, and they agree because
// this is the only copy of it.

// A shot resting exactly on a surface is on it, not in it -- upstream's own
// version of this (BoxBuilding::get3DNormal's "cruft" top/bottom check) uses
// `Epsilon`, which is `ZERO_TOLERANCE` (global.h), not a real physical
// margin. This used to borrow the much larger tolerance an occupant's own
// resting check needs (checkCollision's, in motion.mjs) -- fine for a box or
// pyramid tens of units tall, but for a box shorter than twice that margin
// (a thin stacked slice, `stack1`..`stack10` in bzo.bzw at 0.25 units each)
// the margin eats the entire height from both ends at once, so every side hit
// misreads as already past the top or short of the bottom, and reflecting a
// level shot off that all-vertical normal is a no-op -- indistinguishable
// from sailing straight through (a bug, not an upstream difference).
const SHOT_VERTICAL_EPSILON = ZERO_TOLERANCE;
// The cylinder a shot collides with, which is not the radius it is drawn at.
// Upstream collides a shot as a ray, and a cylinder this thin is as near to one
// as bzo's occupant test gets.
const SHOT_COLLISION_RADIUS = 0.1;
// Reflections resolved inside a single step. Upstream caps its segment list at
// 100 for the same reason: a shot wedged into a corner must not spin the loop.
// A step that spends them all forfeits whatever travel it had left.
const MAX_SHOT_BOUNCES_PER_STEP = 4;
// How far off a surface a bounced shot resumes from, along that surface's
// normal, before its next pass is traced -- `traceShotBeam`'s own
// `BEAM_SURFACE_CLEARANCE` (server.js), shared here so a beam's bounce and an
// ordinary shot's agree. It has to clear `SHOT_COLLISION_RADIUS`: within that
// distance the shot still reads as inside the obstacle it just left, and a
// pass that starts inside something is carried straight through rather than
// tested against it -- which at a grazing angle, where the reflection leaves
// almost no perpendicular gap on its own, is what let a shot re-catch the
// same face pass after pass rather than actually leaving it (#93).
const SHOT_BOUNCE_CLEARANCE = SHOT_COLLISION_RADIUS * 4;

// An obstacle-local normal in world space, normalized. The rotation is the
// inverse of getColliderLocalPoint's, so the sign follows the same reasoning.
function rotateNormalToWorld(obs, localX, localY, localZ) {
  const cos = Math.cos(obs.rotation);
  const sin = Math.sin(obs.rotation);
  const worldX = localX * cos + localZ * sin;
  const worldZ = -localX * sin + localZ * cos;
  const length = Math.hypot(worldX, localY, worldZ) || 1;
  return { x: worldX / length, y: localY / length, z: worldZ / length };
}

// True when a shot centred at (x, y, z) is inside this obstacle's solid volume.
function shotInsideObstacle(obs, x, y, z, radius) {
  // A mesh has no single flat top/bottom to name the way a box or a pyramid
  // does, so it skips that pair of epsilon checks entirely and goes straight
  // to its own per-face test, which already includes its own vertical gate.
  if (obs.type === 'mesh') {
    return meshIntersectsCylinder(obs, x, y, z, radius, radius, 'shootThrough');
  }
  const base = obs.baseY || 0;
  const top = base + getObstacleHeight(obs);
  if (y + radius <= base + SHOT_VERTICAL_EPSILON) return false;
  if (y >= top - SHOT_VERTICAL_EPSILON) return false;
  if (obs.type === 'pyramid') {
    return pyramidIntersectsCylinder(obs, x, y, z, radius, radius);
  }
  const local = getColliderLocalPoint(x, z, obs);
  return testOrigRectCircle(obs.w / 2, obs.d / 2, local.x, local.z, radius);
}

// The obstacle a shot is inside, or null. Teleporters are never consulted here:
// a portal teleports a shot and a frame stops one, and the teleporter trace
// decides both before this runs.
//
// `shootThrough` is upstream's own per-obstacle flag -- `shootthrough` in a
// `.bzw`, `Obstacle::isShootThrough`, tested by `getFirstBuilding` before it
// looks at the geometry at all -- and it is what makes the invisible part of the
// world border transparent to shots while it still stops tanks.
function findShotObstacle(obstacles, x, y, z, radius) {
  for (const obs of obstacles) {
    if (obs.kind === 'teleporter') continue;
    if (obs.shootThrough) continue;
    if (shotInsideObstacle(obs, x, y, z, radius)) return obs;
  }
  return null;
}

// True when a point sits inside a box's real volume, no radius at all --
// upstream's shot has none, and `findShotEmbeddedObstacle` below needs to ask
// this rather than `shotInsideObstacle`'s padded version specifically for a
// box: once a box's own hit detection is the exact bare ray
// (`exactBoxShotHit`), an ordinary grazing pass can leave the shot's plain
// position within the padding of a box it is still short of truly entering,
// and the padded test would misread that graze as "already embedded," the
// same carry-through a teleport exit gets -- silently waiving collision for
// the rest of the flight instead of registering the real crossing a step or
// two later (#94).
function shotExactlyInsideBox(obs, x, y, z) {
  const base = obs.baseY || 0;
  const top = base + getObstacleHeight(obs);
  if (y < base || y > top) return false;
  const local = getColliderLocalPoint(x, z, obs);
  return Math.abs(local.x) <= obs.w / 2 && Math.abs(local.z) <= obs.d / 2;
}

// The obstacle a shot's plain position (no radius) has to already be inside
// for `traceShotStep`/`traceShotBeam` to carry it straight through rather
// than test it for a new impact -- what a teleport exit looks like from here,
// since there is no surface between where the shot is and where it came from
// to bounce off. A box asks `shotExactlyInsideBox` instead of the padded
// `findShotObstacle` above, for the same reason `exactBoxShotHit` does not
// pad a box's own hit test; everything else keeps the padded read, unchanged.
function findShotEmbeddedObstacle(obstacles, x, y, z, radius) {
  for (const obs of obstacles) {
    if (obs.kind === 'teleporter') continue;
    if (obs.shootThrough) continue;
    if (obs.type === 'box') {
      if (shotExactlyInsideBox(obs, x, y, z)) return obs;
      continue;
    }
    if (shotInsideObstacle(obs, x, y, z, radius)) return obs;
  }
  return null;
}

// Where and which single face of a box a shot's own path actually crosses,
// treating the shot as the bare ray upstream's `BoxBuilding::intersect` does --
// radius left out entirely, unlike the occupant-cylinder bisection this
// preempts. That bisection inflates the box by the shot's own (deliberately
// thin, but nonzero) collision radius, so a shot grazing close enough to a
// corner can register as "inside" while still short of either face's real
// plane -- both a hit fraction earlier than a real ray would ever reach it,
// and, since `getOrigRectNormal` always answers a corner the same way
// upstream's occupant-normal helper does for a tank, a diagonal "corner"
// normal a bare ray would never actually meet at all, since
// `timeRayHitsOrigBox` always resolves to exactly one axis (#94).
//
// The side (x/z) faces and the top/bottom planes are both tested, same as
// upstream's own `timeRayHitsOrigBox` tests all three axes -- a box stacked
// on, or under, another (a step, a raised platform, a floating ledge) needs
// the roof and floor answered exactly too, not just the walls, or a shot
// approaching one from above or below finds nothing to stop it at all. Each
// candidate is only considered when the segment actually starts on the far
// side of that plane (mirroring upstream's own "doesn't matter" cases for an
// axis the ray starts already inside), and validated against the *other* two
// axes at its own crossing time, so a corner where two candidates would
// otherwise both look valid resolves to whichever the ray truly reaches
// first, never a blend of both.
//
// Null when the exact ray crosses none of the three axis pairs within this
// segment's own length (`t` must land in [0, 1] -- a box a step merely passes
// on its way toward, still several segments off, is not a hit yet) -- which
// leaves the occupant-cylinder bisection to answer instead.
function exactBoxShotHit(obs, fromX, fromY, fromZ, toX, toY, toZ) {
  const halfW = obs.w / 2;
  const halfD = obs.d / 2;
  const base = obs.baseY || 0;
  const top = base + getObstacleHeight(obs);
  const vx = toX - fromX;
  const vy = toY - fromY;
  const vz = toZ - fromZ;

  let best = null;

  const side = timeAndSideRayHitsRect(fromX, fromZ, vx, vz, obs, halfW, halfD);
  if (side.side >= 0 && side.t <= 1) {
    const y = fromY + (vy * side.t);
    if (y >= base && y <= top) best = { fraction: side.t, face: side.side };
  }

  let verticalT = -1;
  if (fromY > top && vy < 0) verticalT = (top - fromY) / vy;
  else if (fromY < base && vy > 0) verticalT = (base - fromY) / vy;
  if (verticalT >= 0 && verticalT <= 1 && (!best || verticalT < best.fraction)) {
    const local = getColliderLocalPoint(fromX + (vx * verticalT), fromZ + (vz * verticalT), obs);
    if (Math.abs(local.x) <= halfW && Math.abs(local.z) <= halfD) {
      // `getShotObstacleNormal`'s own top/bottom check reads the hit point's
      // `y` before it ever looks at `face`, so a roof or floor crossing needs
      // no face of its own here -- the fraction alone is enough to answer it.
      best = { fraction: verticalT, face: null };
    }
  }

  return best;
}

// Where along a segment a shot first meets solid geometry, as a fraction of the
// segment, together with what it met. Null when the segment ends clear.
//
// A box is tested directly against the shot's own bare ray, every box in the
// list, no padding: unlike a razor-thin mesh face a box's real volume has
// nothing for a fast step to tunnel through, so there is no accuracy a radius
// would buy here that `exactBoxShotHit` does not already answer exactly for
// this exact segment (#94). Everything else -- chiefly a pyramid's sloped
// cross-section -- still goes through the occupant-cylinder bisection below,
// which settles on the last sample still outside (that is where the impact is
// drawn and where a bounce starts from); eight bisections is a fixed and
// deliberately small budget, resolving the impact to a fraction of a world
// unit, and the reflected shot leaves the surface anyway.
//
// That bisection only ever runs once `findShotObstacle` already says the
// segment's own endpoint landed inside something -- fine for a pyramid's real
// volume, which stays "inside" for the rest of a step once entered, but a
// mesh face has none: `findMeshRayImpact` is folded in alongside it, an exact
// ray-vs-face crossing this endpoint check alone would otherwise miss
// whenever the far end of a fast step happens to clear a razor-thin face's
// own tiny catch radius. See its own comment.
function findShotImpact(obstacles, fromX, fromY, fromZ, toX, toY, toZ, radius) {
  let best = null;

  for (const obs of obstacles) {
    if (obs.kind === 'teleporter') continue;
    if (obs.shootThrough) continue;
    if (obs.type !== 'box') continue;
    const exact = exactBoxShotHit(obs, fromX, fromY, fromZ, toX, toY, toZ);
    if (exact && (!best || exact.fraction < best.fraction)) {
      best = { fraction: exact.fraction, obstacle: obs, face: exact.face };
    }
  }

  const paddedObstacle = findShotObstacle(obstacles, toX, toY, toZ, radius);
  if (paddedObstacle && paddedObstacle.type !== 'box') {
    let obstacle = paddedObstacle;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) * 0.5;
      const hit = findShotObstacle(
        obstacles,
        fromX + (toX - fromX) * mid,
        fromY + (toY - fromY) * mid,
        fromZ + (toZ - fromZ) * mid,
        radius
      );
      if (hit) {
        hi = mid;
        obstacle = hit;
      } else {
        lo = mid;
      }
    }
    const paddedBest = { fraction: lo, obstacle };
    // A mesh has no single flat top/bottom the way a pyramid's `get3DNormal`
    // fallthrough reads directly off `y`, so its own reflection needs a real
    // face -- and asking for one at `lo`, the point this bisection
    // deliberately leaves just outside the solid, always comes back empty
    // (that emptiness is what makes `lo` "outside" in the first place), which
    // is what let `getMeshHitNormal` fall through to its own last-resort
    // straight-up normal here. `hi`, the last sample this bisection confirmed
    // inside, is where a face is actually there to find (#93).
    if (obstacle.type === 'mesh') {
      paddedBest.face = findMeshHitFace(
        obstacle,
        fromX + (toX - fromX) * hi,
        fromY + (toY - fromY) * hi,
        fromZ + (toZ - fromZ) * hi,
        radius,
        radius,
        'shootThrough'
      );
    }
    if (!best || paddedBest.fraction < best.fraction) best = paddedBest;
  }

  const meshHit = findMeshRayImpact(obstacles, fromX, fromY, fromZ, toX, toY, toZ, radius);
  if (meshHit && (!best || meshHit.fraction < best.fraction)) best = meshHit;

  return best;
}

// Whether a point lies inside a planar face's own boundary -- upstream's own
// `MeshFace::intersect` (MeshFace.cxx:341-349), tested against the same
// per-edge "fence" planes upstream precomputes once at `finalize()`
// (`edgePlanes`, MeshFace.cxx:201-214, ported into `face.edgePlanes` by
// `finalizeMeshGeometry`/server.js): each edge's own plane contains that edge
// and is perpendicular to the face's own plane, oriented so the polygon's
// interior is its negative side, so a point actually on the face sits on the
// negative side of every one of them (a small positive tolerance the same
// way upstream reads it). This used to drop into a 2D projection instead
// (whichever axis the face was least aligned with, then a flat
// point-in-polygon test) -- a real bug, not just a style difference: a thin,
// steeply angled face (any of a cone's narrow wedges, all sharing one edge
// with their neighbours at the apex) could project close enough to
// degenerate that a point nowhere near its real 3D area still read as
// inside, handing a shot's reflection the wrong face's normal. Every face a
// mapper writes is required to be planar and convex (CustomMeshFace.cxx), so
// this never has to handle a concave one.
function pointInMeshFacePolygon(obs, face, px, py, pz) {
  for (let i = 0; i < face.edgePlanes.length; i++) {
    const [nx, ny, nz, d] = face.edgePlanes[i];
    if (((nx * px) + (ny * py) + (nz * pz) + d) > 0.001) return false;
  }
  return true;
}

// Where a segment crosses one of a mesh's own faces, exactly -- upstream's
// own `Obstacle::intersect` (ShotStrategy.cxx:84's `getFirstBuilding`) is a
// real ray-vs-geometry test, immune to how far a single step travels. A
// mesh face has none of a box or a pyramid's real volume to be "inside" of,
// so the coarse sample-then-bisect approach every other shape here uses can
// step clean over one: `SHOT_COLLISION_RADIUS` is a tenth of a unit, an
// ordinary shot's own per-tick step is on the order of a unit and a half at
// `SHOT_SPEED`'s default, and `findShotImpact`'s endpoint-only check only
// ever catches a face if that single step happens to land within its own
// radius of the exact plane -- which a fast, perpendicular crossing of a
// razor-thin polygon very often does not. This asks the exact question
// instead: where the segment's own line crosses each face's plane -- offset
// by `radius`, so the shot's own surface reaches the face before its centre
// point does, for where the segment actually stops -- and separately, at the
// line's own exact (un-offset) crossing, whether that lands inside the
// face's own boundary rather than merely its infinite plane. See the
// comment further down on why those two are not the same point.
function findMeshFaceCrossing(obs, fromX, fromY, fromZ, toX, toY, toZ, radius) {
  const { bounds } = obs;
  if (bounds && (Math.max(fromX, toX) + radius < bounds.minX
    || Math.min(fromX, toX) - radius > bounds.maxX
    || Math.max(fromY, toY) + radius < bounds.minY
    || Math.min(fromY, toY) - radius > bounds.maxY
    || Math.max(fromZ, toZ) + radius < bounds.minZ
    || Math.min(fromZ, toZ) - radius > bounds.maxZ)) {
    return null;
  }
  const dx = toX - fromX;
  const dy = toY - fromY;
  const dz = toZ - fromZ;
  let best = null;
  for (const face of obs.faces) {
    if (!face.plane || face.shootThrough) continue;
    const [nx, ny, nz, d] = face.plane;
    const denom = (nx * dx) + (ny * dy) + (nz * dz);
    if (Math.abs(denom) < 1e-9) continue; // travelling parallel to the face
    const fromDist = (nx * fromX) + (ny * fromY) + (nz * fromZ) + d;
    // Whichever side of the plane the segment starts on is the side its own
    // radius has to close before the surface, not the centre, has reached it.
    const sign = fromDist >= 0 ? 1 : -1;
    const t = ((sign * radius) - fromDist) / denom;
    if (t < 0 || t > 1) continue;
    if (best !== null && t >= best.fraction) continue;
    // `t` is where the shot's own radius reaches the plane, not where the
    // ray through its centre does -- offset by `radius/denom` from the
    // exact crossing, along the ray. At anything but a dead-square hit that
    // offset is not purely toward the face; part of it slides sideways
    // within the face's own plane, growing without bound as the ray
    // glances the face at a shallower angle. Entering right at the shared
    // edge between two of a cone's narrow wedges, that sideways slide can
    // carry the radius-offset point past the true face's own edge even
    // though the ray's exact (zero-radius) crossing sits safely inside it --
    // which is what this checks instead: "which face" is answered at the
    // exact crossing, where a mesh face actually intersects a mathematical
    // line the way upstream's own `MeshFace::intersect` always does (it has
    // no shot radius to offset by in the first place); `t` still carries the
    // radius offset, since that is where the shot's own surface, not its
    // centre, actually meets the face.
    const t0 = -fromDist / denom;
    const px = fromX + (dx * t0);
    const py = fromY + (dy * t0);
    const pz = fromZ + (dz * t0);
    if (!pointInMeshFacePolygon(obs, face, px, py, pz)) continue;
    best = { fraction: t, obstacle: obs, face };
  }
  return best;
}

// The earliest exact mesh-face crossing across every mesh in the list --
// `findShotImpact` and `findShotSegmentImpact` both fold this in alongside
// their own box/pyramid/base search, since neither of those needs it (a
// box's own solid cross-section has no thin-plane gap for a coarse sample to
// miss) but a mesh always does.
function findMeshRayImpact(obstacles, fromX, fromY, fromZ, toX, toY, toZ, radius) {
  let best = null;
  for (const obs of obstacles) {
    if (obs.type !== 'mesh' || obs.shootThrough) continue;
    const hit = findMeshFaceCrossing(obs, fromX, fromY, fromZ, toX, toY, toZ, radius);
    if (hit && (!best || hit.fraction < best.fraction)) best = hit;
  }
  return best;
}

// findShotSegmentImpact's own candidate loop never calls this for a mesh --
// it skips straight to findMeshRayImpact's exact face test instead -- so
// every obstacle reaching here is a box, a pyramid, a base or the world
// border, all real solids with an actual bounding box to clip against.
function getShotObstacleInterval(obs, from, to, radius) {
  const base = obs.baseY || 0;
  const top = base + getObstacleHeight(obs);
  const lowest = base + SHOT_VERTICAL_EPSILON - radius;
  const highest = top - SHOT_VERTICAL_EPSILON;
  if (highest <= lowest) return null;

  const start = getColliderLocalPoint(from.x, from.z, obs);
  const end = getColliderLocalPoint(to.x, to.z, obs);
  let tMin = 0;
  let tMax = 1;

  const clip = (a, b, low, high) => {
    const delta = b - a;
    if (Math.abs(delta) < ZERO_TOLERANCE) return a >= low && a <= high;
    let near = (low - a) / delta;
    let far = (high - a) / delta;
    if (near > far) {
      const swap = near;
      near = far;
      far = swap;
    }
    if (near > tMin) tMin = near;
    if (far < tMax) tMax = far;
    return tMin <= tMax;
  };

  if (!clip(start.x, end.x, -((obs.w / 2) + radius), (obs.w / 2) + radius)) return null;
  if (!clip(start.z, end.z, -((obs.d / 2) + radius), (obs.d / 2) + radius)) return null;
  if (!clip(from.y, to.y, lowest, highest)) return null;
  if (tMax < 0 || tMin > 1) return null;
  return { tMin: Math.max(0, tMin), tMax: Math.min(1, tMax) };
}

// How finely an obstacle's own interval is walked before the bisection takes
// over. The interval spans one obstacle, so this resolves a pyramid's slope to a
// twelfth of its width and the bisection does the rest.
const SHOT_INTERVAL_SAMPLES = 12;

// Where along a segment a shot first meets solid geometry, for a segment of any
// length. findShotImpact only bisects, so it needs the far end of the segment to
// be inside something: that holds for one simulation step of an ordinary shot
// and fails outright for a beam, which crosses the whole world in one segment
// and would sail through everything on the way.
//
// Each obstacle is asked for the interval where the segment crosses its
// bounding box, and the intervals are walked in order. Every true hit on an
// obstacle lies inside that obstacle's own interval, so once an interval starts
// later than the best hit found there is nothing left that could beat it.
//
// A mesh sits out this coarse sample-then-bisect search entirely -- its own
// face has no volume to be "inside" of the way a box or a pyramid's
// cross-section does, so `findMeshRayImpact`'s exact ray-vs-face crossing
// answers for it instead, folded in below.
//
// Returns the same shape findShotImpact does, and by the same convention: the
// last point still outside, which is where the impact is drawn and where a
// bounce starts from.
function findShotSegmentImpact(obstacles, from, to, radius) {
  const candidates = [];
  for (const obs of obstacles) {
    if (obs.kind === 'teleporter') continue;
    if (obs.shootThrough) continue;
    if (obs.type === 'mesh') continue;
    const interval = getShotObstacleInterval(obs, from, to, radius);
    if (interval) candidates.push({ obs, tMin: interval.tMin, tMax: interval.tMax });
  }
  candidates.sort((a, b) => a.tMin - b.tMin);

  const insideAt = (obs, t) => shotInsideObstacle(
    obs,
    from.x + ((to.x - from.x) * t),
    from.y + ((to.y - from.y) * t),
    from.z + ((to.z - from.z) * t),
    radius
  );

  let best = null;
  for (const candidate of candidates) {
    if (best && candidate.tMin >= best.fraction) break;

    // A box gets the exact bare-ray answer directly, same reasoning as
    // `findShotImpact`'s own shortcut, and it always fully replaces the
    // occupant-cylinder bisection below rather than falling back to it on a
    // miss: a box's real volume has nothing for a fast segment to tunnel
    // through the way a razor-thin mesh face does, so a miss here (the ray
    // does not cross this box's own footprint within this segment at all)
    // means upstream would not have hit it either, not that the padded
    // approximation is needed to catch it. Falling through to the bisection
    // would also compare its `lo` -- a lower bound, since the radius can only
    // make a hit register early, never late -- against another candidate's
    // already-exact `best.fraction`, letting a closer-looking box win the
    // comparison here only to prove worse once corrected, by which point the
    // candidate it displaced is already gone. Resolving every box exactly up
    // front keeps every comparison apples to apples.
    if (candidate.obs.type === 'box') {
      const exact = exactBoxShotHit(candidate.obs, from.x, from.y, from.z, to.x, to.y, to.z);
      if (exact && (!best || exact.fraction < best.fraction)) {
        best = { fraction: exact.fraction, obstacle: candidate.obs, face: exact.face };
      }
      continue;
    }

    let lo = candidate.tMin;
    let hi = null;
    for (let sample = 1; sample <= SHOT_INTERVAL_SAMPLES; sample++) {
      const span = candidate.tMax - candidate.tMin;
      const t = candidate.tMin + ((span * sample) / SHOT_INTERVAL_SAMPLES);
      if (insideAt(candidate.obs, t)) {
        hi = t;
        break;
      }
      lo = t;
    }
    // A bounding box the segment crossed without ever reaching the solid inside
    // it, which is a pyramid the shot passed over the slope of.
    if (hi === null) continue;

    for (let step = 0; step < 8; step++) {
      const mid = (lo + hi) * 0.5;
      if (insideAt(candidate.obs, mid)) hi = mid;
      else lo = mid;
    }
    if (!best || lo < best.fraction) {
      best = { fraction: lo, obstacle: candidate.obs };
    }
  }

  const meshHit = findMeshRayImpact(obstacles, from.x, from.y, from.z, to.x, to.y, to.z, radius);
  if (meshHit && (!best || meshHit.fraction < best.fraction)) best = meshHit;

  return best;
}

// The outward unit normal of the surface a shot met, in world space.
//
// Upstream's Obstacle::get3DNormal reads the face off the exact ray/surface
// intersection. bzo stops the shot at the last point that was still outside, so
// the two flat faces are named by the same vertical tests that let that point
// stay outside, and everything else falls through to the cross-section's
// horizontal normal -- which, as getNormalOrigRect does, always answers.
//
// `hitFace`, for a mesh, is the face the caller's own ray sweep already
// identified -- see `getMeshHitNormal`'s comment on why that beats
// re-deriving it here.
function getShotObstacleNormal(obs, x, y, z, radius, hitFace = null) {
  if (obs.type === 'mesh') return getMeshHitNormal(obs, x, y, z, radius, hitFace);

  // Teleporter::getNormal always answers off the nearest border column,
  // treating it as a circular post regardless of where on the frame the ray
  // actually landed -- there is no separate header case, unlike a tank's
  // wider hit test (getTankHitNormal's own teleporter branch).
  if (obs.kind === 'teleporter') {
    const dims = getShotTeleporterDims(obs);
    const pillarR = dims.border / 2;
    const pillarOffset = dims.halfD - pillarR;
    const local = getColliderLocalPoint(x, z, obs);
    const offsetZ = local.z >= 0 ? pillarOffset : -pillarOffset;
    return getSideNormal(obs, x, z, null, pillarR, pillarR, offsetZ);
  }

  const base = obs.baseY || 0;
  const top = base + getObstacleHeight(obs);

  if (obs.type === 'pyramid') {
    // PyramidBuilding::get3DNormal names the flat end of the shape -- the base
    // of an upright pyramid, the top of a flipped one -- before angling the
    // normal by the slope of the wall.
    const flip = isPyramidFlatTop(obs);
    if (pyramidShrinkFactor(obs, y, radius) >= 1 - ZERO_TOLERANCE) {
      return { x: 0, y: flip ? 1 : -1, z: 0 };
    }
    const face = getPyramidFaceLocalNormal(obs, x, y, z, radius);
    return rotateNormalToWorld(obs, face.x, face.y, face.z);
  }

  // BoxBuilding::get3DNormal names the top and the bottom before falling
  // through to the side.
  if (y >= top - SHOT_VERTICAL_EPSILON) return { x: 0, y: 1, z: 0 };
  if (y + radius <= base + SHOT_VERTICAL_EPSILON) return { x: 0, y: -1, z: 0 };
  // `hitFace`, when the caller already ran `exactBoxShotHit`'s bare-ray test,
  // names the one real face upstream would have hit. Without it (a caller
  // that never had a `from`/`to` to test, such as the debug outline's static
  // position query) this falls back to `getOrigRectNormal`'s own corner
  // guess, same as before.
  if (Number.isInteger(hitFace)) {
    const theta = hitFace * (Math.PI / 2);
    return rotateNormalToWorld(obs, Math.cos(theta), 0, Math.sin(theta));
  }
  const local = getColliderLocalPoint(x, z, obs);
  const side = getOrigRectNormal(obs.w / 2, obs.d / 2, local.x, local.z);
  return rotateNormalToWorld(obs, side.x, 0, side.z);
}

const SWEPT_TANK_CORNERS = [[1, 1], [1, -1], [-1, -1], [-1, 1]];

// Ported from Intersect.cxx timeAndSideRayHitsOrigRect: where a ray starting
// at (px, pz) with direction (vx, vz) first crosses the axis-aligned
// rectangle of half-extents (halfW, halfD) centred at the origin. `side` is
// -1 (never crosses), -2 (already inside, t 0), or 0/1/2/3 for the +x/+z/-x/-z
// face -- the same face order getOrigRectNormal's axis-aligned cases use.
function timeAndSideRayHitsOrigRect(px, pz, vx, vz, halfW, halfD) {
  if (Math.abs(px) <= halfW && Math.abs(pz) <= halfD) return { t: 0, side: -2 };

  let tx;
  if (px > halfW) {
    if (vx >= 0) return { t: -1, side: -1 };
    tx = (halfW - px) / vx;
  } else if (px < -halfW) {
    if (vx <= 0) return { t: -1, side: -1 };
    tx = -(halfW + px) / vx;
  } else {
    tx = -1;
  }

  let tz;
  if (pz > halfD) {
    if (vz >= 0) return { t: -1, side: -1 };
    tz = (halfD - pz) / vz;
  } else if (pz < -halfD) {
    if (vz <= 0) return { t: -1, side: -1 };
    tz = -(halfD + pz) / vz;
  } else {
    tz = -1;
  }

  if (Math.abs(pz + tx * vz) > halfD) tx = -1;
  if (Math.abs(px + tz * vx) > halfW) tz = -1;
  if (tx < 0 && tz < 0) return { t: -1, side: -1 };

  if (tx < 0 || (tz >= 0 && tz < tx)) return { t: tz, side: pz > halfD ? 1 : 3 };
  return { t: tx, side: px > halfW ? 0 : 2 };
}

// Ported from Intersect.cxx timeAndSideRayHitsRect: the same ray-vs-rectangle
// test, for a rectangle that is `obs`'s own footprint rather than one already
// sitting at the origin -- translates and rotates into `obs`'s local frame
// (getColliderLocalPoint's own transform) and hands off to the Orig version.
// `offsetZ` re-centres the rectangle along the obstacle's own local z axis --
// a teleporter's jamb pillar, rather than its full footprint.
function timeAndSideRayHitsRect(px, pz, vx, vz, obs, halfW, halfD, offsetZ = 0) {
  const local = getColliderLocalPoint(px, pz, obs);
  const cos = Math.cos(obs.rotation);
  const sin = Math.sin(obs.rotation);
  const dirX = vx * cos - vz * sin;
  const dirZ = vx * sin + vz * cos;
  return timeAndSideRayHitsOrigRect(local.x, local.z - offsetZ, dirX, dirZ, halfW, halfD);
}

// A tank corner's world position. `bx`/`bz` are one of SWEPT_TANK_CORNERS; the
// tank's lateral (width) axis is (-cos az, sin az) and its length axis
// (-sin az, -cos az) -- forward, this file's own heading convention (see
// testOrigRectTank above).
function sweptTankCornerWorld(cx, cz, az, bx, bz, halfWidth, halfLength) {
  const cos = Math.cos(az);
  const sin = Math.sin(az);
  return {
    x: cx - cos * halfWidth * bx - sin * halfLength * bz,
    z: cz + sin * halfWidth * bx - cos * halfLength * bz,
  };
}

// An obstacle corner's world position -- getColliderLocalPoint's inverse.
// `offsetZ` re-centres the rectangle along the obstacle's own local z axis,
// same as timeAndSideRayHitsRect's.
function sweptObstacleCornerWorld(obs, halfW, halfD, bx, bz, offsetZ = 0) {
  const cos = Math.cos(obs.rotation);
  const sin = Math.sin(obs.rotation);
  const lz = offsetZ + halfD * bz;
  return {
    x: obs.x + halfW * bx * cos + lz * sin,
    z: obs.z - halfW * bx * sin + lz * cos,
  };
}

// A world point in the tank's own local axes -- sweptTankCornerWorld's inverse.
function worldToTankLocal(wx, wz, cx, cz, az) {
  const dx = wx - cx;
  const dz = wz - cz;
  const cos = Math.cos(az);
  const sin = Math.sin(az);
  return {
    x: -dx * cos + dz * sin,
    z: -dx * sin - dz * cos,
  };
}

// Obstacle::getHitNormal's (Obstacle.cxx:122) two ray passes: the tank's four
// corners swept across the step against the obstacle's rectangle, and the
// obstacle's four corners swept across the tank's own rectangle in the
// tank's rotating frame. The second pass is what a small obstacle -- a
// teleporter's jamb, say -- needs: the tank's own corners can sweep past it
// entirely while its corner still pokes into the tank's flank partway
// through the step, which the first pass alone never sees. Whichever ray
// crosses first wins; null if neither ever does (upstream's own fallback
// case -- LocalPlayer.cxx:614).
//
// This is what a static end-of-step position cannot answer: a grazing corner
// hit rests somewhere consistent with more than one face (or with a corner
// that was never really there -- getOrigRectNormal's diagonal case), and a
// tangential slide computed from the wrong one can point right back into the
// solid it just met. The swept path only ever crosses one face.
function getSweptSideNormal(obs, fromX, fromZ, fromAz, toX, toZ, toAz, halfWidth, halfLength, halfW, halfD, offsetZ = 0) {
  let bestSide = -1;
  let minTime = 1;
  let bestIsTankFace = false;

  for (const [bx, bz] of SWEPT_TANK_CORNERS) {
    const p1 = sweptTankCornerWorld(fromX, fromZ, fromAz, bx, bz, halfWidth, halfLength);
    const p2 = sweptTankCornerWorld(toX, toZ, toAz, bx, bz, halfWidth, halfLength);
    const hit = timeAndSideRayHitsRect(p1.x, p1.z, p2.x - p1.x, p2.z - p1.z, obs, halfW, halfD, offsetZ);
    if (hit.side >= 0 && hit.t <= minTime) {
      minTime = hit.t;
      bestSide = hit.side;
      bestIsTankFace = false;
    }
  }

  for (const [bx, bz] of SWEPT_TANK_CORNERS) {
    const world = sweptObstacleCornerWorld(obs, halfW, halfD, bx, bz, offsetZ);
    const p1 = worldToTankLocal(world.x, world.z, fromX, fromZ, fromAz);
    const p2 = worldToTankLocal(world.x, world.z, toX, toZ, toAz);
    const hit = timeAndSideRayHitsOrigRect(p1.x, p1.z, p2.x - p1.x, p2.z - p1.z, halfWidth, halfLength);
    if (hit.side >= 0 && hit.t <= minTime) {
      minTime = hit.t;
      bestSide = hit.side;
      bestIsTankFace = true;
    }
  }

  if (bestSide === -1) return null;

  const theta = bestSide * (Math.PI / 2);
  if (!bestIsTankFace) {
    return rotateNormalToWorld(obs, Math.cos(theta), 0, Math.sin(theta));
  }

  // A face of the tank's own box, at the heading it had when the obstacle's
  // corner actually crossed it -- negated, since the outward direction wanted
  // here is away from the obstacle, not away from the tank.
  const impactAz = fromAz + minTime * (toAz - fromAz);
  return { x: Math.cos(impactAz - theta), y: 0, z: -Math.sin(impactAz - theta) };
}

// The horizontal normal of a box's (or a teleporter jamb's) side. `rectHalfW`/
// `rectHalfD`/`rectOffsetZ` are the actual solid rectangle to test against --
// the whole footprint for a box, but a teleporter's own two border-square
// pillars for its jamb (see findTankObstacle's teleporter branch), since a
// tank is wider than most teleporters' entire frame and would otherwise never
// register a clean crossing of the *outer* footprint at all. `sweep`, when
// the caller has one, is the step's actual endpoints and the tank's own
// half-extents, and resolves it with getSweptSideNormal above; without one
// (the debug outline's static position query has no step to sweep) or if the
// sweep found no crossing, this falls back to the plain position read.
function getSideNormal(obs, x, z, sweep, rectHalfW = obs.w / 2, rectHalfD = obs.d / 2, rectOffsetZ = 0) {
  if (sweep) {
    const swept = getSweptSideNormal(
      obs, sweep.fromX, sweep.fromZ, sweep.fromAz,
      sweep.toX, sweep.toZ, sweep.toAz,
      sweep.halfWidth, sweep.halfLength,
      rectHalfW, rectHalfD, rectOffsetZ
    );
    if (swept) return swept;
  }
  const local = getColliderLocalPoint(x, z, obs);
  const side = getOrigRectNormal(rectHalfW, rectHalfD, local.x, local.z - rectOffsetZ);
  return rotateNormalToWorld(obs, side.x, 0, side.z);
}

// The outward unit normal of the surface a *tank's* step met, in world space.
//
// Obstacle::getHitNormal (Obstacle.cxx:122) rays the four corners of the moving
// box at the obstacle's sides, then -- "on the way down; don't care about way
// up" -- solves for the moment the box met the roof, and takes the roof when
// that came first. bzo's caller has already resolved the step to the last
// moment the tank was clear, so which plane the step crossed is the question
// `crossedFlatTop` answers for the top; the bottom is `low + height < base`,
// the same test `getShotObstacleNormal` already made for a shot a few lines up
// -- a box raised clear of the ground has a real underside, and a tank rising
// into it from below is meeting that face, not a side wall. Only once both are
// ruled out does the side fall through to getSideNormal.
//
// PyramidBuilding overrides it (PyramidBuilding.cxx:271): the flat end of the
// shape is named first -- the plateau of a flipped pyramid, the underside of an
// upright one -- and everything else is the cross-section normal angled up by
// the slope of the wall. That upward tilt is the whole reason a pyramid face
// reads as a landing rather than as a wall, at every slope.
//
// `y` and `z` are where the step was last clear; `toY` is where it hit.
// `sweep`, when given, threads through to getSideNormal.
function getTankHitNormal(obs, x, y, z, rotation, toY, height, sweep = null) {
  const base = obs.baseY || 0;
  const low = y > toY ? toY : y;

  if (obs.type === 'pyramid') {
    const pyramidHeight = getPyramidHeight(obs);
    const flip = isPyramidFlatTop(obs);
    const high = y > toY ? y : toY;
    if (flip && high >= base + pyramidHeight) return { x: 0, y: 1, z: 0 };
    if (!flip && low + height < base) return { x: 0, y: -1, z: 0 };
    const face = getPyramidFaceLocalNormal(obs, x, y, z, height);
    return rotateNormalToWorld(obs, face.x, face.y, face.z);
  }

  if (obs.type === 'mesh') {
    // MeshFace::getHitNormal (MeshFace.cxx:437) ignores every argument it is
    // given and just returns whichever face's own plane -- explicitly marked
    // upstream's own "FIXME - all geometry after this point is currently
    // JUNK", so there is no top/bottom split to port here the way a box or a
    // pyramid gets: whichever face the search finds is the whole answer, the
    // same one `getMeshHitNormal` already picks for a shot's ricochet. The
    // search itself has to match whatever shape actually found the hit,
    // though (`findTankObstacle`'s own `useTankBox` split) -- a plain
    // square-cylinder query can miss a face the oriented tank box actually
    // reached nose- or tail-first, along its longer `halfLength` axis. It
    // also needs the same `meshFaceBlocksDirection` filter `findTankObstacle`
    // itself uses now, built from the same pass's own start/end -- otherwise
    // this can name a face `hitTest` already rejected as non-blocking (the
    // tank moving along or away from it, not into it), which is exactly
    // backwards from what actually stopped the tank here.
    //
    // Queried at `sweep.hitX`/`hitZ` -- the position the search actually
    // confirmed as touching -- rather than `x`/`z`, the resolved *clear*
    // position a few thousandths of a unit back from it: right at a
    // polygon's own edge (two mesh faces meeting at a corner, say) that
    // sliver is sometimes enough for the exact same SAT test to disagree
    // with itself between the two, and finding nothing here falls through
    // to a made-up "roof" normal that is wrong in every way that matters --
    // upstream has no equivalent gap, since `getHitNormal` never has to
    // relocate anything, it already knows which face it is.
    const queryX = (sweep && Number.isFinite(sweep.hitX)) ? sweep.hitX : x;
    const queryZ = (sweep && Number.isFinite(sweep.hitZ)) ? sweep.hitZ : z;
    const direction = sweep ? { x: sweep.toX - sweep.fromX, y: toY - y, z: sweep.toZ - sweep.fromZ } : null;
    const face = (sweep && Number.isFinite(rotation))
      ? findMeshHitFaceOriented(obs, queryX, low, queryZ, rotation, sweep.halfWidth, sweep.halfLength, height, 'driveThrough', direction)
      : findMeshHitFace(obs, queryX, low, queryZ, height, height, 'driveThrough', direction);
    return face ? { x: face.plane[0], y: face.plane[1], z: face.plane[2] } : { x: 0, y: 1, z: 0 };
  }

  if (crossedFlatTop(base + getObstacleHeight(obs), y, toY)) return { x: 0, y: 1, z: 0 };
  if (low + height < base) return { x: 0, y: -1, z: 0 };

  // A teleporter is a frame around a portal, not a solid block: `findTankObstacle`
  // calls it solid whenever the swept height misses the portal's own active
  // range (`activeH`, the frame's height less its border) rather than the whole
  // frame's, or the point sits outside the portal's own width there. Left
  // unhandled, a tank rising into the header from inside the doorway fell
  // through to the side normal below and got turned sideways instead of back
  // down.
  if (obs.kind === 'teleporter') {
    const dims = getShotTeleporterDims(obs);
    // Below the header, the only solid material is one of the two
    // border-square pillars flanking the doorway (findTankObstacle's own
    // jamb test) -- not the frame's full outer footprint, which a real tank
    // is wider than. Test whichever pillar the tank's side sits nearer.
    const pillarR = dims.border / 2;
    const pillarOffset = dims.halfD - pillarR;
    const local = getColliderLocalPoint(x, z, obs);
    const overPillar = Math.abs(local.x) <= pillarR && Math.abs(Math.abs(local.z) - pillarOffset) <= pillarR;

    // The ceiling only answers for a step that actually crosses into the
    // header band from below (`crossedFlatTop`'s own shape, the other
    // direction) -- not merely one that is already resting above `activeH`.
    // A Wings tank can hover and thrust into a pillar's own front face while
    // floating above `activeH`: reading that as a ceiling hit on every such
    // frame cancels the rise and leaves the forward thrust untouched, while
    // the pillar stays solid in front of it and the header solid overhead --
    // every direction the search tries is blocked, with nothing to break the
    // tie. Once the step is no longer crossing, a tank still against a
    // pillar (`overPillar`) reads its front face as the ordinary wall it is;
    // one that has actually cleared the pillar falls through to the
    // header's own front face below.
    const high = y > toY ? y : toY;
    if (low < base + dims.activeH && high >= base + dims.activeH && !overPillar) {
      return { x: 0, y: -1, z: 0 };
    }

    const offsetZ = local.z >= 0 ? pillarOffset : -pillarOffset;
    return getSideNormal(obs, x, z, sweep, pillarR, pillarR, offsetZ);
  }

  return getSideNormal(obs, x, z, sweep);
}

// ShotStrategy::reflect (ShotStrategy.cxx:140). The normal is a unit vector; the
// direction need not be. Upstream keeps a second branch for a normal that faces
// the wrong way: rather than let the shot through the surface it refracts at
// four times the factor and rescales to the incoming speed.
function reflectShotDirection(dirX, dirY, dirZ, normal) {
  let d = -2 * ((normal.x * dirX) + (normal.y * dirY) + (normal.z * dirZ));
  if (d >= 0) {
    return { x: dirX + d * normal.x, y: dirY + d * normal.y, z: dirZ + d * normal.z };
  }

  const oldSpeed = Math.hypot(dirX, dirY, dirZ);
  d = -2 * d;
  const x = dirX + d * normal.x;
  const y = dirY + d * normal.y;
  const z = dirZ + d * normal.z;
  const scale = oldSpeed / (Math.hypot(x, y, z) || 1);
  return { x: x * scale, y: y * scale, z: z * scale };
}

// One fixed simulation step of a shot against the world's solid geometry.
//
// Returns where the shot ends the step, the direction it is now travelling, how
// many times it bounced, and what stopped it: `obstacle` for a building or the
// world border, `ground` for the floor, which upstream treats as a surface of
// its own rather than as an obstacle (ShotStrategy::getGround). A shot that
// ricochets is never stopped by either.
//
// A shot that begins the step already inside something because it just
// exited a teleporter is carried straight through rather than bounced,
// because there is no surface between where it is and where it came from to
// bounce off. `justTeleported` scopes that to an actual teleport exit
// (the caller's own `traceShotThroughTeleporters` crossing count) -- without
// it, a shot whose muzzle spawned overlapping a thin wall (issue #83) hit
// this same "already inside" case and was waved through the wall with no
// impact at all, ending up whole on the far side instead of hitting the
// wall it started against.
function traceShotStep({
  obstacles,
  x,
  y,
  z,
  dirX,
  dirY,
  dirZ,
  distance,
  radius,
  ricochet,
  groundLimit = 0,
  justTeleported = false,
}) {
  let posX = x;
  let posY = y;
  let posZ = z;
  let dX = dirX;
  let dY = dirY;
  let dZ = dirZ;
  let remaining = distance;
  let bounces = 0;
  let obstacle = null;
  let ground = false;

  for (let pass = 0; pass < MAX_SHOT_BOUNCES_PER_STEP && remaining > 0; pass++) {
    const toX = posX + dX * remaining;
    const toY = posY + dY * remaining;
    const toZ = posZ + dZ * remaining;

    // Upstream takes whichever of the ground and the first building the shot
    // reaches first, so the two are compared rather than ordered.
    const groundFraction = (dY < 0 && toY < groundLimit)
      ? (groundLimit - posY) / (dY * remaining)
      : Infinity;
    const embedded = findShotEmbeddedObstacle(obstacles, posX, posY, posZ, radius);
    const impact = embedded
      // A real teleport exit: no surface to hit, carry the shot through.
      // Anything else that started embedded (a spawn overlapping a solid)
      // is an immediate hit right where it started, same as upstream's
      // muzzle guarantee would have made it, rather than being waved
      // through untested.
      ? (justTeleported ? null : { fraction: 0, obstacle: embedded, face: null })
      : findShotImpact(obstacles, posX, posY, posZ, toX, toY, toZ, radius);
    const obstacleFraction = impact ? impact.fraction : Infinity;

    if (obstacleFraction === Infinity && groundFraction === Infinity) {
      posX = toX;
      posY = toY;
      posZ = toZ;
      remaining = 0;
      break;
    }

    if (obstacleFraction <= groundFraction) {
      const hitX = posX + (toX - posX) * obstacleFraction;
      const hitY = posY + (toY - posY) * obstacleFraction;
      const hitZ = posZ + (toZ - posZ) * obstacleFraction;
      posX = hitX;
      posY = hitY;
      posZ = hitZ;
      // makeSegments reflects a Stop shot off an obstacle that declares itself
      // bouncy -- `ricochet` in a `.bzw`, `Obstacle::canRicochet` -- as well as
      // reflecting every shot on a world that says so. Upstream's own border
      // walls are built with it off (`addWall`, bzfs.cxx:1057), so only a shot
      // that ricochets of its own accord bounces off the border.
      if (!ricochet && impact.obstacle.ricochet !== true) {
        obstacle = impact.obstacle;
        remaining = 0;
        break;
      }
      const normal = getShotObstacleNormal(impact.obstacle, hitX, hitY, hitZ, radius, impact.face ?? null);
      const reflected = reflectShotDirection(dX, dY, dZ, normal);
      dX = reflected.x;
      dY = reflected.y;
      dZ = reflected.z;
      // Resume the next pass clear of the surface, along its normal -- see
      // `SHOT_BOUNCE_CLEARANCE`.
      posX = hitX + (normal.x * SHOT_BOUNCE_CLEARANCE);
      posY = hitY + (normal.y * SHOT_BOUNCE_CLEARANCE);
      posZ = hitZ + (normal.z * SHOT_BOUNCE_CLEARANCE);
      remaining *= 1 - obstacleFraction;
      bounces++;
      continue;
    }

    posX += (toX - posX) * groundFraction;
    posZ += (toZ - posZ) * groundFraction;
    posY = groundLimit;
    if (!ricochet) {
      ground = true;
      remaining = 0;
      break;
    }
    // The ground's normal is straight up, so reflecting about it only flips the
    // vertical component.
    dY = -dY;
    posY = groundLimit + SHOT_BOUNCE_CLEARANCE;
    remaining *= 1 - groundFraction;
    bounces++;
  }

  return {
    x: posX,
    y: posY,
    z: posZ,
    dirX: dX,
    dirY: dY,
    dirZ: dZ,
    bounces,
    obstacle,
    ground,
  };
}
module.exports = {
  ZERO_TOLERANCE,
  collectMeshHitFacesTank,
  collectMeshHitFacesCylinder,
  pickPriorityMeshFace,
  getColliderLocalPoint,
  testOrigRectCircle,
  TANK_HALF_LENGTH,
  TANK_HALF_WIDTH,
  TANK_HEIGHT,
  WORLD_WALL_HEIGHT,
  testOrigRectTank,
  getSegmentBoxHitFraction,
  getTankLocalAngle,
  getPyramidSurfaceLocalHeight,
  getPyramidHeight,
  DEFAULT_OBSTACLE_HEIGHT,
  getObstacleHeight,
  isPyramidFlatTop,
  pyramidShrinkFactor,
  getOrigRectNormal,
  isWithinPyramidFootprint,
  getPyramidFaceLocalNormal,
  pyramidIntersectsCylinder,
  pyramidIntersectsTank,
  projectAxisBox,
  projectPolygon,
  testPolygonInAxisBox,
  meshIntersectsCylinder,
  findMeshHitFace,
  findMeshFaceAt,
  resolvePhysicsDriverAt,
  findMeshHitFaceOriented,
  meshIntersectsTank,
  meshFaceBlocksDirection,
  getMeshHitNormal,
  pointInMeshFacePolygon,
  findMeshFaceCrossing,
  findMeshRayImpact,
  getShotTeleporterDims,
  findTankObstacle,
  findPhysicsSurfaceObstacle,
  getBaseTopY,
  BASE_TOP_TOLERANCE,
  isOnBaseTop,
  getBaseTeamAtPoint,
  isOverFlatTop,
  meshFlatTopYsAt,
  movingTankOverlapsHeight,
  crossedFlatTop,
  phasedObstacleExpels,
  tankRectInsideOrigRect,
  getBoxCrossingPlane,
  getMeshCrossingPlane,
  SHOT_COLLISION_RADIUS,
  MAX_SHOT_BOUNCES_PER_STEP,
  SHOT_BOUNCE_CLEARANCE,
  shotInsideObstacle,
  findShotObstacle,
  findShotEmbeddedObstacle,
  findShotImpact,
  getShotObstacleInterval,
  findShotSegmentImpact,
  getShotObstacleNormal,
  getTankHitNormal,
  reflectShotDirection,
  traceShotStep,
  timeAndSideRayHitsRect,
};
