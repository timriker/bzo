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

export const ZERO_TOLERANCE = 1.0e-6;

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
export function getColliderLocalPoint(x, z, obs) {
  const rotation = obs.rotation || 0;
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
export function origRectPointDistanceSquared(halfW, halfD, localX, localZ) {
  const closestX = Math.max(-halfW, Math.min(localX, halfW));
  const closestZ = Math.max(-halfD, Math.min(localZ, halfD));
  const distX = localX - closestX;
  const distZ = localZ - closestZ;
  return distX * distX + distZ * distZ;
}

// True when an axis-aligned rectangle centered at the origin intersects a
// circle of radius r centered at the local point.
export function testOrigRectCircle(halfW, halfD, localX, localZ, radius) {
  return origRectPointDistanceSquared(halfW, halfD, localX, localZ) < radius * radius;
}

// Tank collision box, matching BZFlag's _tankWidth (2.8) and _tankLength (6.0).
// Player.cxx:120 sets dimensions[0] = 0.5 * tankLength (forward half-extent) and
// dimensions[1] = 0.5 * tankWidth (lateral). Every tank shares this box whatever
// model is selected, so the model is cosmetic and never changes gameplay.
export const TANK_HALF_LENGTH = 3.0;
export const TANK_HALF_WIDTH = 1.4;

// A rectangle centred at (localX, localZ), rotated so its lateral axis points
// along (cos a, sin a), against the axis-aligned rectangle at the origin.
// Ported from Intersect.cxx testOrigRectRect: dx1/dy1 are the rotated rect's
// half-extents, dx2/dy2 the origin rect's.
export function testOrigRectRect(px, pz, angle, dx1, dy1, dx2, dy2) {
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
export function testOrigRectTank(halfW, halfD, localX, localZ, tankAngle, slack = 0) {
  // Slack shrinks the tank, never the obstacle, mirroring how the circle path
  // reduces the tested radius.
  const trim = Math.max(0, Math.min(slack, TANK_HALF_WIDTH));
  return testOrigRectRect(
    localX, localZ, tankAngle,
    TANK_HALF_WIDTH - trim, TANK_HALF_LENGTH - trim,
    halfW, halfD
  );
}

// The tank's lateral axis angle inside an obstacle's local frame.
export function getTankLocalAngle(rotation, obsRotation = 0) {
  return Math.PI - rotation + (obsRotation || 0);
}

// Height of the pyramid's sloped surface above its base, at a local point.
// Returns null outside the base footprint. This is the inverse of
// pyramidShrinkFactor: the surface sits where the shrunk rectangle's edge
// passes through the point.
export function getPyramidSurfaceLocalHeight(obs, localX, localZ) {
  const halfW = obs.w / 2;
  const halfD = obs.d / 2;
  if (Math.abs(localX) > halfW || Math.abs(localZ) > halfD) return null;
  const height = getPyramidHeight(obs);
  const edgeFactor = Math.max(Math.abs(localX) / halfW, Math.abs(localZ) / halfD);
  return obs.inverted ? height * edgeFactor : height * (1 - edgeFactor);
}

export function getPyramidHeight(obs) {
  return Math.abs(obs.h || 0);
}

// Inverted pyramids present a flat top that can be driven on; upright ones come
// to a point. Upstream: isFlatTop() { return getZFlip(); }
export function isPyramidFlatTop(obs) {
  return obs.inverted === true;
}

// Fraction the pyramid's cross-section is scaled to at world height y, for an
// occupant of the given height. Upstream PyramidBuilding::shrinkFactor.
export function pyramidShrinkFactor(obs, y, height = 0) {
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
export function getOrigRectNormal(halfW, halfD, localX, localZ) {
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
export function isWithinPyramidFootprint(obs, x, z) {
  const local = getColliderLocalPoint(x, z, obs);
  return Math.abs(local.x) <= obs.w / 2 && Math.abs(local.z) <= obs.d / 2;
}

// Outward normal of a pyramid face at a point, in the obstacle's local frame,
// including the tilt from the slope. Mirrors PyramidBuilding::getNormal and
// getHitNormal: take the normal of the cross-section rectangle at the
// occupant's height, then angle it by the slope of the wall.
export function getPyramidFaceLocalNormal(obs, x, y, z, height = 0) {
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
export function pyramidIntersectsCylinder(obs, x, y, z, radius, height) {
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
export function pyramidIntersectsTank(obs, x, y, z, rotation, height, slack = 0) {
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
    slack
  );
}

// BaseBuilding, as World::whoseBase reads it (World.cxx:181). A base's top
// surface is what counts: a tank captures by standing on it, not by driving
// past its side.
export function getBaseTopY(obs) {
  return (obs.baseY || 0) + (obs.h || 0);
}

// True when (x, y, z) is on this base's top face. Upstream tests the rotated
// rectangle and then the altitude against a 0.1 epsilon kludge -- its comment,
// and it is what lets a tank sitting on the surface count as on it.
export const BASE_TOP_TOLERANCE = 0.1;

export function isOnBaseTop(obs, x, y, z) {
  const { x: localX, z: localZ } = getColliderLocalPoint(x, z, obs);
  if (Math.abs(localX) >= obs.w / 2) return false;
  if (Math.abs(localZ) >= obs.d / 2) return false;
  return Math.abs(y - getBaseTopY(obs)) < BASE_TOP_TOLERANCE;
}

// Which team's base a point is standing on, as its BZFlag colour index, or null
// for none. Bases are the obstacles carrying kind 'base'.
export function getBaseTeamAtPoint(obstacles, x, y, z) {
  for (const obs of obstacles) {
    if (obs.kind !== 'base') continue;
    if (isOnBaseTop(obs, x, y, z)) return obs.team;
  }
  return null;
}

// The footprint test a flag drop uses, with no radius: DropGeometry gives a team
// flag a radius of 0, so only the point itself has to be over the surface.
export function isOverFlatTop(obs, x, z) {
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
export function movingTankOverlapsHeight(obstacleBase, obstacleTop, fromY, toY, tankHeight, epsilon) {
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
export function crossedFlatTop(obstacleTop, fromY, toY) {
  return fromY >= obstacleTop && toY < obstacleTop;
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

// checkCollision's vertical epsilon: an occupant resting exactly on a surface
// is on it, not in it.
export const SHOT_VERTICAL_EPSILON = 0.15;
// The cylinder a shot collides with, which is not the radius it is drawn at.
// Upstream collides a shot as a ray, and a cylinder this thin is as near to one
// as bzo's occupant test gets.
export const SHOT_COLLISION_RADIUS = 0.1;
// Reflections resolved inside a single step. Upstream caps its segment list at
// 100 for the same reason: a shot wedged into a corner must not spin the loop.
// A step that spends them all forfeits whatever travel it had left.
export const MAX_SHOT_BOUNCES_PER_STEP = 4;

// An obstacle-local normal in world space, normalized. The rotation is the
// inverse of getColliderLocalPoint's, so the sign follows the same reasoning.
export function rotateNormalToWorld(obs, localX, localY, localZ) {
  const cos = Math.cos(obs.rotation || 0);
  const sin = Math.sin(obs.rotation || 0);
  const worldX = localX * cos + localZ * sin;
  const worldZ = -localX * sin + localZ * cos;
  const length = Math.hypot(worldX, localY, worldZ) || 1;
  return { x: worldX / length, y: localY / length, z: worldZ / length };
}

// True when a shot centred at (x, y, z) is inside this obstacle's solid volume.
export function shotInsideObstacle(obs, x, y, z, radius) {
  const base = obs.baseY || 0;
  const top = base + (obs.h || 4);
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
export function findShotObstacle(obstacles, x, y, z, radius) {
  for (const obs of obstacles) {
    if (obs.kind === 'teleporter') continue;
    if (shotInsideObstacle(obs, x, y, z, radius)) return obs;
  }
  return null;
}

// Where along a segment a shot first meets solid geometry, as a fraction of the
// segment, together with what it met. Null when the segment ends clear.
//
// The search settles on the last sample still outside, which is where the
// impact is drawn and where a bounce starts from. Eight bisections is a fixed
// and deliberately small budget: it resolves the impact to a fraction of a
// world unit, and the reflected shot leaves the surface anyway.
export function findShotImpact(obstacles, fromX, fromY, fromZ, toX, toY, toZ, radius) {
  let obstacle = findShotObstacle(obstacles, toX, toY, toZ, radius);
  if (!obstacle) return null;

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
  return { fraction: lo, obstacle };
}

// The outward unit normal of the surface a shot met, in world space.
//
// Upstream's Obstacle::get3DNormal reads the face off the exact ray/surface
// intersection. bzo stops the shot at the last point that was still outside, so
// the two flat faces are named by the same vertical tests that let that point
// stay outside, and everything else falls through to the cross-section's
// horizontal normal -- which, as getNormalOrigRect does, always answers.
export function getShotObstacleNormal(obs, x, y, z, radius) {
  const base = obs.baseY || 0;
  const top = base + (obs.h || 4);

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
  const local = getColliderLocalPoint(x, z, obs);
  const side = getOrigRectNormal(obs.w / 2, obs.d / 2, local.x, local.z);
  return rotateNormalToWorld(obs, side.x, 0, side.z);
}

// ShotStrategy::reflect (ShotStrategy.cxx:140). The normal is a unit vector; the
// direction need not be. Upstream keeps a second branch for a normal that faces
// the wrong way: rather than let the shot through the surface it refracts at
// four times the factor and rescales to the incoming speed.
export function reflectShotDirection(dirX, dirY, dirZ, normal) {
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
// A shot that begins the step already inside something -- which is what a
// teleport exit looks like from here -- is carried straight through rather than
// bounced, because there is no surface between where it is and where it came
// from to bounce off.
export function traceShotStep({
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
    const impact = findShotObstacle(obstacles, posX, posY, posZ, radius)
      ? null
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
      if (!ricochet) {
        obstacle = impact.obstacle;
        remaining = 0;
        break;
      }
      const normal = getShotObstacleNormal(impact.obstacle, hitX, hitY, hitZ, radius);
      const reflected = reflectShotDirection(dX, dY, dZ, normal);
      dX = reflected.x;
      dY = reflected.y;
      dZ = reflected.z;
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
