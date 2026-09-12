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
export const TINY_DISTANCE = 0.001;
export const MAX_BUMP_HEIGHT = 0.33;
const ZERO_TOLERANCE = 1e-8;
// Upstream loops until the timestep is spent; this bounds a pathological wedge.
const MAX_SLIDE_PASSES = 4;

function nearZero(value) {
  return Math.abs(value) < ZERO_TOLERANCE;
}

// `hitTest(fromX, fromY, fromZ, fromAz, toX, toY, toZ, toAz)` returns the
// blocking obstacle or null. `getNormal(obstacle, x, y, z, az, hitX, hitY, hitZ,
// hitAz, fromX, fromZ, fromAz, toX, toZ, toAz)` returns a unit {x, y, z}
// pointing out of the surface -- the last six are this pass's own start and
// original (pre-search) end, which a caller wanting a swept normal needs and
// nothing here otherwise provides.
export function resolveTankMotion({
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

  for (let pass = 0; pass < MAX_SLIDE_PASSES && remaining > MIN_SEARCH_STEP; pass++) {
    const fromX = posX;
    const fromY = posY;
    const fromZ = posZ;
    const fromAz = az;

    let toAz = fromAz + remaining * angVel;
    let toX = fromX + remaining * velX;
    let toY = fromY + remaining * velY;
    let toZ = fromZ + remaining * velZ;
    if (toY < groundLimit && velY < 0) toY = groundLimit;

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
      if (top !== fromY && top < fromY + maxBumpHeight) {
        const bumpY = top;
        if (!hitTest(fromX, bumpY, fromZ, fromAz, fromX, bumpY, fromZ, toAz)) {
          posX = fromX + velX * remaining * 0.5;
          posY = bumpY;
          posZ = fromZ + velZ * remaining * 0.5;
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
      let tryY = fromY + t * velY;
      const tryZ = fromZ + t * velZ;
      if (tryY < groundLimit && velY < 0) tryY = groundLimit;

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
    if (posY < groundLimit && velY < 0) posY = groundLimit;
    remaining -= searchTime;

    const normal = getNormal(hit, posX, posY, posZ, az, hitX, hitY, hitZ, hitAz, fromX, fromZ, fromAz, toX, toZ, toAz);
    if (!normal) break;

    if (posY > 0 && normal.y > 0.001) {
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
      velY = 0;
      continue;
    }

    let mag = normal.x * velX + normal.z * velZ;
    if (!nearZero(normal.y)) {
      // A surface below stops a fall, which is upstream's own test.
      if (velY < 0 && velY - (mag + normal.y * velY) * normal.y > 0) velY = 0;
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
      if (velY > 0 && normal.y < 0) velY = 0;
      const horNormal = normal.x * normal.x + normal.z * normal.z;
      if (!nearZero(horNormal)) mag /= horNormal;
    }

    if (mag < 0) {
      velX -= mag * normal.x;
      velZ -= mag * normal.z;
      // Back off a hair so the next pass does not re-hit the same face.
      posX -= TINY_DISTANCE * mag * normal.x;
      posZ -= TINY_DISTANCE * mag * normal.z;
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
  };
}
