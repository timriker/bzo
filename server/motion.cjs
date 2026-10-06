/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// motion.mjs - Tank movement against solid geometry, ported from BZFlag's
// LocalPlayer::doUpdateMotion (LocalPlayer.cxx:520-666).
//
// BZFlag does not push a tank out of an obstacle it already overlaps. It
// advances the tank over the timestep, and when that lands in something it
// binary-searches the timestep for the last moment the tank was clear, stops
// there, cancels the velocity component along the surface normal, and spends
// the remaining time sliding. Repeat until the time is used up.
//
// That matters for an oriented box: a rotated rectangle's Minkowski sum with a
// rectangle is a hexagon, so there is no radius by which an obstacle can be
// grown to turn the tank into a point. Searching in time sidesteps the shape
// question entirely -- it only ever asks "is the tank clear here", which the
// collision test already answers exactly.

const MIN_SEARCH_STEP = 0.0001;
const MAX_SEARCH_STEPS = 7;
// An angle brought into [-pi, pi].
function normalizeAngle(angle) {
  let normalized = Number(angle) || 0;
  while (normalized > Math.PI) normalized -= Math.PI * 2;
  while (normalized < -Math.PI) normalized += Math.PI * 2;
  return normalized;
}

const TINY_DISTANCE = 0.001;
const MAX_BUMP_HEIGHT = 0.33;
const ZERO_TOLERANCE = 1e-8;
// Upstream loops until the timestep is spent; this bounds a pathological wedge.
const MAX_SLIDE_PASSES = 4;
// LocalPlayer.cxx:426, "only any 100 frames while stuck, take an action".
const STUCK_FRAME_LIMIT = 100;
// LocalPlayer.cxx:470: the escape shove is bounded to what a laggy frame would
// otherwise cover, so a stall right before a huge `dt` cannot fling the tank
// through a wall it would never have reached under a normal step.
const STUCK_ESCAPE_MAX_DT = 0.1;

function nearZero(value) {
  return Math.abs(value) < ZERO_TOLERANCE;
}

// +Z is up. The heading is the caller's: this only turns it at
// `angularVelocity` and hands it to the callbacks.
//
// `hitTest(fromX, fromY, fromZ, fromAz, toX, toY, toZ, toAz)` returns the
// blocking obstacle or null. `getNormal(obstacle, x, y, z, az, hitX, hitY, hitZ,
// hitAz, fromX, fromY, fromAz, toX, toY, toAz)` returns a unit {x, y, z}
// pointing out of the surface -- the last six are this pass's own start and
// original (pre-search) end, which a caller wanting a swept normal needs and
// nothing here otherwise provides.
function resolveTankMotion({
  x, y, z, azimuth,
  velocityX, velocityY, velocityZ,
  angularVelocity = 0,
  timeStep,
  groundLimit = 0,
  onGround = true,
  hitTest,
  getNormal,
  isFlatTop = () => false,
  getObstacleTop = () => 0,
  // `_maxBumpHeight` (LocalPlayer.cxx:534), a map or a server may raise or
  // lower with `-set`/`maxBumpHeight` -- see server.js. Defaulting to the
  // module constant is what every existing caller keeps getting for free.
  maxBumpHeight = MAX_BUMP_HEIGHT,
  // LocalPlayer.cxx:421-490's own `stuckFrameCount`, a tank-lifetime counter
  // the caller carries across frames and hands back in -- this function is
  // otherwise stateless, so it cannot count consecutive frames itself.
  stuckFrameCount = 0,
}) {
  let posX = x;
  let posY = y;
  let posZ = z;
  let az = azimuth;
  let velX = velocityX;
  let velY = velocityY;
  let velZ = velocityZ;
  let angVel = angularVelocity;
  let remaining = timeStep;
  let obstacle = null;
  let onBuilding = false;

  // A tank whose *resting* pose -- no movement at all -- is still found
  // inside a solid every single frame is wedged, not merely blocked: sliding
  // alone can leave it there forever where two or more obstacles pinch a
  // gap too tight to slide out of (LocalPlayer.cxx:441-490). A pinch like
  // that is exactly what letting a mesh's flat top take priority over a
  // wall (`pickPriorityMeshFace`) cannot fix by itself -- that rule only
  // says which *single* face wins a query, not what to do when the winning
  // answer still leaves no clear direction to slide in. Upstream counts
  // consecutive stuck frames and, past the limit, shoves the tank back out
  // along the obstacle's own normal instead of resolving the frame
  // normally; this is that shove, applied to the starting pose before the
  // ordinary slide loop below ever runs, exactly where upstream applies it.
  const restingHit = hitTest(posX, posY, posZ, az, posX, posY, posZ, az);
  let nextStuckFrameCount = restingHit ? stuckFrameCount + 1 : 0;
  if (nextStuckFrameCount > STUCK_FRAME_LIMIT) {
    nextStuckFrameCount = 0;
    const escapeNormal = getNormal(restingHit, posX, posY, posZ, az, posX, posY, posZ, az, posX, posY, az, posX, posY, az);
    if (escapeNormal) {
      const desiredSpeed = Math.hypot(velX, velY);
      const delta = Math.min(remaining, STUCK_ESCAPE_MAX_DT);
      const movementMax = desiredSpeed * delta;
      posX += movementMax * escapeNormal.x;
      posY += movementMax * escapeNormal.y;
      velX = movementMax * escapeNormal.x;
      velY = movementMax * escapeNormal.y;
      remaining -= delta;
    }
  }

  for (let pass = 0; pass < MAX_SLIDE_PASSES && remaining > MIN_SEARCH_STEP; pass++) {
    const fromX = posX;
    const fromY = posY;
    const fromZ = posZ;
    const fromAz = az;

    let toAz = fromAz + remaining * angVel;
    let toX = fromX + remaining * velX;
    let toY = fromY + remaining * velY;
    let toZ = fromZ + remaining * velZ;
    if (toZ < groundLimit && velZ < 0) toZ = groundLimit;

    // The final pass of a slide normally ends clear, so remember the last
    // obstacle actually struck rather than whatever the last pass saw.
    let hit = hitTest(fromX, fromY, fromZ, fromAz, toX, toY, toZ, toAz);
    if (!hit) {
      posX = toX; posY = toY; posZ = toZ; az = toAz;
      remaining = 0;
      break;
    }
    obstacle = hit;

    // Drive over a low flat-topped ledge rather than stopping dead against it.
    if (onGround && isFlatTop(hit)) {
      const top = getObstacleTop(hit);
      if (top !== fromZ && top < fromZ + maxBumpHeight) {
        const bumpZ = top;
        if (!hitTest(fromX, fromY, bumpZ, fromAz, fromX, fromY, bumpZ, toAz)) {
          posX = fromX + velX * remaining * 0.5;
          posZ = bumpZ;
          posY = fromY + velY * remaining * 0.5;
          az = toAz;
          remaining = 0;
          // A bump is a landing too: without this the next frame finds the
          // tank above groundLimit and not on a building, calls that falling,
          // and the landing an instant later repeats every frame it holds
          // still on the ledge -- one ring and one thump per frame, the same
          // buzz a knife-edge footprint used to cause before the tank was
          // pinned to it.
          onBuilding = true;
          break;
        }
      }
    }

    // Latest time in the step at which the tank is still clear.
    let hitX = toX;
    let hitY = toY;
    let hitZ = toZ;
    let hitAz = toAz;
    let searchTime = 0;
    let searchStep = 0.5 * remaining;
    for (let i = 0; searchStep > MIN_SEARCH_STEP && i < MAX_SEARCH_STEPS; searchStep *= 0.5, i++) {
      const t = searchTime + searchStep;
      const tryAz = fromAz + t * angVel;
      const tryX = fromX + t * velX;
      const tryY = fromY + t * velY;
      let tryZ = fromZ + t * velZ;
      if (tryZ < groundLimit && velZ < 0) tryZ = groundLimit;

      const found = hitTest(fromX, fromY, fromZ, fromAz, tryX, tryY, tryZ, tryAz);
      if (!found) {
        searchTime = t;
      } else {
        hit = found;
        obstacle = found;
        hitX = tryX; hitY = tryY; hitZ = tryZ; hitAz = tryAz;
      }
    }

    az = fromAz + searchTime * angVel;
    posX = fromX + searchTime * velX;
    posY = fromY + searchTime * velY;
    posZ = fromZ + searchTime * velZ;
    if (posZ < groundLimit && velZ < 0) posZ = groundLimit;
    remaining -= searchTime;

    const normal = getNormal(hit, posX, posY, posZ, az, hitX, hitY, hitZ, hitAz, fromX, fromY, fromAz, toX, toY, toAz);
    if (!normal) break;

    if (posZ > 0 && normal.z > 0.001) {
      // Landing on top of something rather than running into its side. Upstream
      // stops the fall and *keeps going* with the time the step has left
      // (LocalPlayer.cxx:617, then the loop turns over): the next pass moves
      // horizontally at this height, which is now clear, so the tank finishes
      // its travel along the surface it just met.
      //
      // Ending the step here instead is what made driving on a roof feel stuck.
      // A tank on a surface always carries a little downward velocity -- gravity
      // is applied every frame it is above its floor -- so every frame hit the
      // roof, and a step that ends at the hit has only travelled as far as the
      // fraction of the frame before the tank sank the first millimetre.
      onBuilding = true;
      velZ = 0;
      continue;
    }

    let mag = normal.x * velX + normal.y * velY;
    if (!nearZero(normal.z)) {
      // A surface below stops a fall, which is upstream's own test.
      if (velZ < 0 && velZ - (mag + normal.z * velZ) * normal.z > 0) velZ = 0;
      // And a surface above stops a rise, which is bzo's one deviation here.
      // Upstream leaves the rise in place -- it only ever cancels downward
      // motion -- so a tank that jumps into an overhang stays pinned under it
      // until gravity turns the velocity around, up to jumpVelocity/gravity.
      // Stopping the rise drops it from where it hit instead.
      //
      // Only the vertical. `mag` is zero against a flat ceiling, so nothing
      // horizontal is touched there either way, and against a sloped underside
      // the component heading into the slope is still the only one cancelled --
      // a tank that jumps into a ceiling while driving keeps its speed and
      // simply starts to fall. See AGENTS.md.
      if (velZ > 0 && normal.z < 0) velZ = 0;
      const horNormal = normal.x * normal.x + normal.y * normal.y;
      if (!nearZero(horNormal)) mag /= horNormal;
    }

    if (mag < 0) {
      velX -= mag * normal.x;
      velY -= mag * normal.y;
      // Back off a hair so the next pass does not re-hit the same face.
      posX -= TINY_DISTANCE * mag * normal.x;
      posY -= TINY_DISTANCE * mag * normal.y;
    }
    if (mag > -0.01) {
      // Nothing significant left to cancel, so stop turning too.
      angVel = 0;
    }
  }

  return {
    x: posX, y: posY, z: posZ,
    azimuth: az,
    velocityX: velX, velocityY: velY, velocityZ: velZ,
    angularVelocity: angVel,
    obstacle,
    onBuilding,
    stuckFrameCount: nextStuckFrameCount,
  };
}

module.exports = {
  normalizeAngle,
  TINY_DISTANCE,
  MAX_BUMP_HEIGHT,
  STUCK_FRAME_LIMIT,
  resolveTankMotion,
};
