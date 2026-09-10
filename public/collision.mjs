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
export const TANK_HALF_LENGTH = 3.0;
export const TANK_HALF_WIDTH = 1.4;
// _tankHeight. Player.cxx:120 keeps this one whole rather than halved, and it is
// what a shot's vertical hit test measures against.
export const TANK_HEIGHT = 2.05;

// _wallHeight, which upstream states as 3.0 * _tankHeight. This is how tall the
// world's border wall is *drawn* and how high up it stops a shot; a tank is
// stopped by it at any altitude, because WallObstacle::inCylinder ignores height
// and tests an infinite half-space. makeSegments spells the difference out: a
// bouncing shot whose impact is above the top of the outer wall has the hit
// ignored and carries on over it rather than bouncing back into the arena.
export const WORLD_WALL_HEIGHT = 3.0 * TANK_HEIGHT;

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
export function testOrigRectTank(halfW, halfD, localX, localZ, tankAngle, slack = 0, tankScale = null) {
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
export function getSegmentBoxHitFraction(
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
export const DEFAULT_OBSTACLE_HEIGHT = 4;

export function getObstacleHeight(obs) {
  return Number.isFinite(obs?.h) ? obs.h : DEFAULT_OBSTACLE_HEIGHT;
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
export function pyramidIntersectsTank(obs, x, y, z, rotation, height, slack = 0, tankScale = null) {
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

// A teleporter's frame and the opening inside it. The importer resolves the
// frame itself into `w`/`d`/`h` before the world goes on the wire, so this
// derives only the portal, which is the frame minus its border.
export function getShotTeleporterDims(obs) {
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
export function findTankObstacle(obstacles, x, y, z, options = {}) {
  const rotation = options.rotation;
  const useTankBox = Number.isFinite(rotation);
  const radius = Number.isFinite(options.radius) ? options.radius : 2;
  const height = Number.isFinite(options.height) ? options.height : radius;
  const fromY = Number.isFinite(options.fromY) ? options.fromY : y;
  const slack = Math.max(0, Math.min(options.slack || 0, radius));
  const tankScale = options.tankScale || null;
  const phased = options.phased === true;
  const reversingOnGround = options.reversingOnGround === true;
  const ignoreTeleporters = options.ignoreTeleporters === true;
  const epsilon = Number.isFinite(options.verticalEpsilon) ? options.verticalEpsilon : 0;

  for (const obs of obstacles) {
    if (!obs) continue;
    if (ignoreTeleporters && obs.kind === 'teleporter') continue;
    if (phased && !phasedObstacleExpels(obs, reversingOnGround)) continue;
    // `drivethrough` in a `.bzw`, `Obstacle::isDriveThrough`: an obstacle an
    // occupant passes straight through. `shootThrough` is its other half.
    if (obs.driveThrough) continue;

    const obstacleBase = obs.baseY || 0;
    const obstacleTop = obstacleBase + getObstacleHeight(obs);
    const spanFromY = obs.type === 'pyramid' ? y : fromY;
    if (!movingTankOverlapsHeight(
      obstacleBase, obstacleTop, spanFromY, y, height, epsilon)) continue;

    if (obs.type === 'pyramid') {
      const hits = useTankBox
        ? pyramidIntersectsTank(obs, x, y, z, rotation, height, slack, tankScale)
        : pyramidIntersectsCylinder(obs, x, y, z, radius - slack, height);
      if (hits) return obs;
      continue;
    }

    const local = getColliderLocalPoint(x, z, obs);
    const tankAngle = useTankBox ? getTankLocalAngle(rotation, obs.rotation) : 0;
    const hitsRect = (rectHalfW, rectHalfD, rectSlack) => (useTankBox
      ? testOrigRectTank(rectHalfW, rectHalfD, local.x, local.z, tankAngle, rectSlack, tankScale)
      : testOrigRectCircle(rectHalfW, rectHalfD, local.x, local.z, radius - rectSlack));

    if (obs.kind === 'teleporter') {
      const dims = getShotTeleporterDims(obs);
      if (!hitsRect(dims.halfW, dims.halfD, slack)) continue;
      const overlapsPortalVertically = movingTankOverlapsHeight(
        obstacleBase, obstacleBase + dims.activeH, spanFromY, y, height, epsilon);
      if (overlapsPortalVertically && hitsRect(dims.halfW, dims.activeHalfD, 0)) continue;
      return obs;
    }

    if (hitsRect(obs.w / 2, obs.d / 2, slack)) return obs;
  }
  return null;
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
export function phasedObstacleExpels(obs, reversingOnGround = false) {
  if (!obs) return false;
  if (obs.collisionKind === 'boundary') return true;
  if (obs.kind === 'teleporter') return true;
  return reversingOnGround === true;
}

// True when the tank's footprint sits entirely within the obstacle's, both
// already in the obstacle's local frame. `testRectInRect` (Intersect.cxx), and
// the reason a tank swallowed whole by a building gets no lights: every corner
// is inside, so there is no wall for the effect to hang off.
export function tankRectInsideOrigRect(halfW, halfD, localX, localZ, tankAngle, tankScale = null) {
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
export function getBoxCrossingPlane(obs, x, y, z, rotation, tankScale = null) {
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
const SHOT_VERTICAL_EPSILON = 0.15;
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
function rotateNormalToWorld(obs, localX, localY, localZ) {
  const cos = Math.cos(obs.rotation);
  const sin = Math.sin(obs.rotation);
  const worldX = localX * cos + localZ * sin;
  const worldZ = -localX * sin + localZ * cos;
  const length = Math.hypot(worldX, localY, worldZ) || 1;
  return { x: worldX / length, y: localY / length, z: worldZ / length };
}

// True when a shot centred at (x, y, z) is inside this obstacle's solid volume.
export function shotInsideObstacle(obs, x, y, z, radius) {
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
export function findShotObstacle(obstacles, x, y, z, radius) {
  for (const obs of obstacles) {
    if (obs.kind === 'teleporter') continue;
    if (obs.shootThrough) continue;
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

// The parametric interval over which a segment overlaps one obstacle's oriented
// bounding box, grown by the shot's radius, or null when it never does. The box
// is the exact solid for a box, a base and the world border; for a pyramid it is
// a hull the solid sits inside, which is why the caller still asks
// shotInsideObstacle within the interval it gets back.
//
// Vertical bounds are shotInsideObstacle's own, so the two agree about what
// counts as inside.
export function getShotObstacleInterval(obs, from, to, radius) {
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
// Returns the same shape findShotImpact does, and by the same convention: the
// last point still outside, which is where the impact is drawn and where a
// bounce starts from.
export function findShotSegmentImpact(obstacles, from, to, radius) {
  const candidates = [];
  for (const obs of obstacles) {
    if (obs.kind === 'teleporter') continue;
    if (obs.shootThrough) continue;
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
    if (!best || lo < best.fraction) best = { fraction: lo, obstacle: candidate.obs };
  }
  return best;
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
  const local = getColliderLocalPoint(x, z, obs);
  const side = getOrigRectNormal(obs.w / 2, obs.d / 2, local.x, local.z);
  return rotateNormalToWorld(obs, side.x, 0, side.z);
}

// The outward unit normal of the surface a *tank's* step met, in world space.
//
// Obstacle::getHitNormal (Obstacle.cxx:122) rays the four corners of the moving
// box at the obstacle's sides, then -- "on the way down; don't care about way
// up" -- solves for the moment the box met the roof, and takes the roof when
// that came first. bzo's caller has already resolved the step to the last
// moment the tank was clear, so which plane the step crossed is the question
// `crossedFlatTop` answers, and the sides fall through to the cross-section's
// horizontal normal, which getNormalOrigRect always gives.
//
// PyramidBuilding overrides it (PyramidBuilding.cxx:271): the flat end of the
// shape is named first -- the plateau of a flipped pyramid, the underside of an
// upright one -- and everything else is the cross-section normal angled up by
// the slope of the wall. That upward tilt is the whole reason a pyramid face
// reads as a landing rather than as a wall, at every slope.
//
// `y` and `z` are where the step was last clear; `toY` is where it hit.
export function getTankHitNormal(obs, x, y, z, rotation, toY, height) {
  const base = obs.baseY || 0;

  if (obs.type === 'pyramid') {
    const pyramidHeight = getPyramidHeight(obs);
    const flip = isPyramidFlatTop(obs);
    const high = y > toY ? y : toY;
    const low = y > toY ? toY : y;
    if (flip && high >= base + pyramidHeight) return { x: 0, y: 1, z: 0 };
    if (!flip && low + height < base) return { x: 0, y: -1, z: 0 };
    const face = getPyramidFaceLocalNormal(obs, x, y, z, height);
    return rotateNormalToWorld(obs, face.x, face.y, face.z);
  }

  if (crossedFlatTop(base + getObstacleHeight(obs), y, toY)) return { x: 0, y: 1, z: 0 };
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
