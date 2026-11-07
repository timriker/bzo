/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Where a dropped flag comes to rest (`DropGeometry::dropIt`), for the server
// that drops it and for a pilot deciding where to let one go. `colliders` is
// the world's collision list, `floorZ` the water's height where the ground is
// under water and 0 otherwise.

import { findTankObstacle, getObstacleBase, getObstacleHeight, isOverFlatTop } from './collision.mjs';

// The radius the drop test uses for its clearance cylinder, and the step it
// walks that cylinder in. DropGeometry uses the tank radius; bzo's is 2.
export const FLAG_DROP_TEST_RADIUS = 2;
// Upstream's drop clearance radius is 0; the collision test sees nothing of
// no width, so a drop is tested this thin instead.
export const FLAG_DROP_POINT_RADIUS = 0.05;

// Every obstacle's top, teleporters included. A mesh has no `size`, so its
// height is its bounds'.
export function getColliderTopY(obs) {
  if (!obs) return 0;
  if (obs.type === 'mesh' && obs.bounds) return getObstacleBase(obs) + getObstacleHeight(obs);
  return getObstacleBase(obs) + (Number.isFinite(obs.size?.[2]) ? obs.size[2] : 0);
}

// Whether a flag `flagHeight` tall has room at a point: walked up in steps
// as tall as the test radius. The flag's own spot is always tested: a map may
// make flags 0 tall (hix does), and a cylinder of no height still finds a
// building it stands in.
export function hasFlagClearance(colliders, x, y, z, radius = FLAG_DROP_TEST_RADIUS, flagHeight = 0) {
  let offset = 0;
  do {
    const hit = findTankObstacle(colliders, x, y, z + offset, {
      radius, height: FLAG_DROP_TEST_RADIUS, reversingOnGround: false, verticalEpsilon: 0.15,
    });
    if (hit) return false;
    offset += FLAG_DROP_TEST_RADIUS;
  } while (offset < flagHeight);
  return true;
}

// The highest flat top at or below `fromZ` over a point, or the floor where
// there is no water. Null for open water: nothing above the waterline to rest
// on.
export function findFlagLandingZ(colliders, floorZ, x, y, fromZ) {
  let landingZ = floorZ;
  let found = floorZ <= 0;
  for (const obs of colliders) {
    // isValidLanding() skips anything a tank can drive through, and the world
    // boundary is not somewhere a flag belongs.
    if (obs.collisionKind === 'boundary' || obs.kind === 'teleporter') continue;
    const top = getColliderTopY(obs);
    if (top > fromZ || top <= landingZ) continue;
    if (!isOverFlatTop(obs, x, y)) continue;
    landingZ = top;
    found = true;
  }
  return found ? landingZ : null;
}

// dropIt's other branch: a flag let go of inside a building -- by a Phantom
// Zoned tank, or one that came down on a pyramid -- climbs to the lowest flat
// top above it with room on it, and has nowhere to land when there is none.
export function findFlagClimbZ(colliders, x, y, fromZ, flagHeight = 0) {
  const tops = [];
  for (const obs of colliders) {
    if (obs.collisionKind === 'boundary' || obs.kind === 'teleporter') continue;
    const top = getColliderTopY(obs);
    if (top < fromZ || !isOverFlatTop(obs, x, y)) continue;
    tops.push(top);
  }
  tops.sort((a, b) => a - b);
  return tops.find((top) => hasFlagClearance(colliders, x, y, top, FLAG_DROP_POINT_RADIUS, flagHeight)) ?? null;
}

// Where a flag dropped from a tank's feet at (x, y, z) settles, or null when
// it has nowhere to: open water, or a building it cannot climb out of. A team
// flag with nowhere goes to its team's safety zone, the centre or home.
export function findFlagRestZ(colliders, floorZ, x, y, z, flagHeight = 0) {
  const landing = findFlagLandingZ(colliders, floorZ, x, y, z);
  if (landing === null) return null;
  if (hasFlagClearance(colliders, x, y, landing, FLAG_DROP_POINT_RADIUS, flagHeight)) return landing;
  return findFlagClimbZ(colliders, x, y, z, flagHeight);
}
