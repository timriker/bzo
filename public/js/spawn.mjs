/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Where a tank is put on a world: upstream's spawn search, on any set of
// colliders. The server spawns its players with it, the offline worker its
// player and bots, and a Map Viewer itself on the map it is viewing -- one
// rule, so a map spawns a tank in the same place whoever is choosing.

import {
  TANK,
  findTankObstacle,
  getObstacleBase,
  getObstacleHeight,
  isOverFlatTop,
  isPyramidFlatTop,
  meshFlatTopsAt,
} from './collision.mjs';
import { getShotEffects } from './flags.mjs';

// DropGeometry::dropPlayer (DropGeometry.cxx:67)'s `fudge`, so a tank does not
// spawn welded to the surface it landed on.
// Upstream's is a float epsilon, because a `MeshFace` there is infinitely thin
// and a tank resting exactly on one is clear of it. bzo's collision reads a tank
// sitting exactly on a surface as inside it -- see the "resting exactly on a
// surface" note in AGENTS.md, which is unfixed -- so a drop tested at the
// surface height rejects every real landing and falls through to the ground.
// Five centimetres is under the height a tank settles through in one frame, and
// it is the one place that behaviour has to be worked around rather than
// inherited: the alternative is every spawn landing under a mesh floor.
export const SPAWN_DROP_FUDGE = 0.05;

// Whether a tank fits here: the server's own anti-cheat test, which is the
// looser one, so a spot it picks is never one it would then refuse.
function isSpawnClear(colliders, x, y, z, azimuth, tankRadius = 2) {
  return !findTankObstacle(colliders, x, y, z, {
    azimuth,
    radius: tankRadius,
    reversingOnGround: false,
    verticalEpsilon: 0.15,
  });
}

// `waterLevel` -- a floating-point tank has no ground to fall to under a map
// with one; upstream's own `minZ = waterLevel` for this search
// (`RandomSpawnPolicy.cxx:93-96`, `SpawnPolicy.cxx:116-119`), so the "else the
// ground" floor moves up to the water's surface rather than leaving one that
// only ever resolves to an instant `WaterDeath`.
function groundLevelOf(waterLevel) {
  return Number.isFinite(waterLevel) && waterLevel > 0 ? waterLevel : 0;
}

// The flat tops a tank could stand on over this point. isValidLanding(): a
// flat top that is not drive-through. The world boundary and a teleporter are
// not surfaces a tank is put on, which is the same set `findFlagLandingZ`
// refuses. A mesh offers one landing per flat face, which is what upstream's
// ray gets back: each face is an obstacle of its own there. Asking the mesh for
// `baseY + height` answers the top of the whole object instead -- the peak of a
// mountain range rather than the valley floor under the tank.
function flatTopsAt(colliders, x, y) {
  const tops = [];
  for (const obs of colliders) {
    if (obs.driveThrough) continue;
    if (obs.collisionKind === 'boundary' || obs.kind === 'teleporter') continue;
    if (obs.type === 'mesh') {
      for (const top of meshFlatTopsAt(obs, x, y)) tops.push(top);
      continue;
    }
    if (obs.type === 'pyramid' && !isPyramidFlatTop(obs)) continue;
    if (!isOverFlatTop(obs, x, y)) continue;
    tops.push(getObstacleBase(obs) + getObstacleHeight(obs));
  }
  return tops;
}

// Where a tank put at this point would actually stand. Upstream's `dropIt`
// (DropGeometry.cxx:210) has two branches and both matter here:
//
//   - the point is **clear**, so the tank falls: take the highest flat top
//     under it, or the ground.
//   - the point is **blocked**, so the tank climbs: take the lowest flat top at
//     or above it that the tank fits on.
//
// The second is the one a hand-written coordinate needs. A `testSpawn` is typed
// against a map's coordinates, and a point inside a building spawns a tank that
// cannot move -- which is what `server.json`'s own spawn at the origin does on
// `fountains.bzw`, where a 60-unit box sits there. Upstream climbs it out onto
// the roof, and so does this.
//
// Returns the resolved z, or null when there is nowhere: the caller falls back
// to a random spawn rather than putting a tank somewhere it is stuck.
export function dropSpawnPosition(colliders, x, y, z, azimuth, waterLevel = null) {
  const clear = (atZ) => isSpawnClear(colliders, x, y, atZ, azimuth);
  const tops = flatTopsAt(colliders, x, y);
  const groundLevel = groundLevelOf(waterLevel);

  if (clear(z)) {
    const below = tops.filter((top) => top <= z).sort((a, b) => b - a);
    for (const top of below) {
      if (clear(top + SPAWN_DROP_FUDGE)) return top + SPAWN_DROP_FUDGE;
    }
    if (z >= groundLevel && clear(groundLevel + SPAWN_DROP_FUDGE)) {
      return groundLevel + SPAWN_DROP_FUDGE;
    }
    return z + SPAWN_DROP_FUDGE;
  }

  const above = tops.filter((top) => top >= z).sort((a, b) => a - b);
  for (const top of above) {
    if (clear(top + SPAWN_DROP_FUDGE)) return top + SPAWN_DROP_FUDGE;
  }
  return null;
}

// CustomZone::getRandomPoint (CustomZone.cxx:228): anywhere in the rectangle,
// at the zone's own height -- the drop is what puts it on something.
export function getRandomZonePoint(zone, random = Math.random) {
  const offsetX = ((random() * 2) - 1) * zone.halfWidth;
  const offsetY = ((random() * 2) - 1) * zone.halfDepth;
  const cos = Math.cos(zone.rotation || 0);
  const sin = Math.sin(zone.rotation || 0);
  return {
    x: zone.x + ((offsetX * cos) - (offsetY * sin)),
    y: zone.y + ((offsetX * sin) + (offsetY * cos)),
    z: zone.z || 0,
  };
}

// A point of one of these zones, dropped. The caller picks the zones -- a
// team's own, or every spawn zone for a viewer with no team. findFlagSpawnPosition's
// own re-roll: a crowded zone is not a reason to leave it after one unlucky
// point, so this tries several before giving up to the map-wide search.
function findZoneSpawnPosition(colliders, zones, waterLevel = null) {
  if (!zones || zones.length === 0) return null;
  const zone = zones[Math.floor(Math.random() * zones.length)];
  for (let attempt = 0; attempt < 20; attempt++) {
    const spot = getRandomZonePoint(zone);
    const azimuth = Math.random() * Math.PI * 2;
    const z = dropSpawnPosition(colliders, spot.x, spot.y, spot.z, azimuth, waterLevel);
    if (z !== null) return { x: spot.x, y: spot.y, z, azimuth };
  }
  return null;
}

function worldMaxHeight(colliders) {
  let max = 0;
  for (const obs of colliders) {
    if (obs.collisionKind === 'boundary') continue;
    const top = getObstacleBase(obs) + getObstacleHeight(obs);
    if (Number.isFinite(top) && top > max) max = top;
  }
  return max;
}

// Whether the world puts anything drivable over this point, which is what
// separates "standing on the map's ground" from "standing under the map".
function hasFlatTopAbove(colliders, x, y, z) {
  return flatTopsAt(colliders, x, y).some((top) => top > z + 1);
}

// SpawnPolicy::getPosition's random point: anywhere on the map, from a random
// height up to the tallest thing on it (`bzfrand() * maxHeight`), so a
// multi-level map is entered at every level rather than only on its roof.
function findValidSpawnPosition(colliders, mapSize, waterLevel = null, tankRadius = 2) {
  const halfMap = mapSize / 2;
  const groundLevel = groundLevelOf(waterLevel);
  const ceiling = worldMaxHeight(colliders);

  for (let attempt = 0; attempt < 100; attempt++) {
    const x = Math.random() * (mapSize - tankRadius * 4) - (halfMap - tankRadius * 2);
    const y = Math.random() * (mapSize - tankRadius * 4) - (halfMap - tankRadius * 2);
    const azimuth = Math.random() * Math.PI * 2;
    const z = dropSpawnPosition(colliders, x, y, Math.random() * ceiling, azimuth, waterLevel);
    if (z === null) continue;
    // The one place bzo refuses what upstream would accept. Starting below the
    // terrain, `dropIt` skips every surface above the start and lands on bare
    // ground -- under the world, which is the bug being fixed rather than
    // behaviour worth copying. Landing on a real surface at any level is still
    // allowed, so a tank may still spawn under a bridge.
    if (z <= groundLevel + 1 && hasFlatTopAbove(colliders, x, y, z)) continue;
    if (isSpawnClear(colliders, x, y, z, azimuth, tankRadius)) return { x, y, z, azimuth };
  }

  return { x: 0, y: 0, z: groundLevel, azimuth: 0 };
}

// The zones that spawn this colour index's tanks, from a world's
// `spawnZones` (`teams` a list) or the server's own zones (`teams` a Set).
export function teamSpawnZones(zones, colorIndex) {
  if (colorIndex === null || colorIndex === undefined) return [];
  return (zones || []).filter((zone) => (zone.teams instanceof Set
    ? zone.teams.has(colorIndex)
    : zone.teams?.includes(colorIndex)));
}

// SpawnPolicy::isFacing: whether a tank at `enemy`, heading `rotation`, points
// within `deviation` of the spot, ignoring one more than two tank heights above
// or below it.
function isFacingSpawn(enemy, spot, deviation) {
  if (Math.abs(enemy.z - spot.z) > 2 * TANK.height) return false;
  const toX = spot.x - enemy.x;
  const toY = spot.y - enemy.y;
  const length = Math.hypot(toX, toY);
  if (length < 1e-6) return true;
  const forwardX = Math.cos(enemy.azimuth);
  const forwardY = Math.sin(enemy.azimuth);
  const cos = ((forwardX * toX) + (forwardY * toY)) / length;
  return Math.acos(Math.max(-1, Math.min(1, cos))) < deviation / 2;
}

// SpawnPolicy::isImminentlyDangerous, over every living tank, foe or not, as
// upstream's is: a Laser looking at the spot, a Shock Wave that reaches it, a
// Steamroller or Burrow tank close enough to squash or be squashed, or any tank
// within `_spawnSafeRadMod` tank radii looking at it.
function isSpawnImminentlyDangerous(spot, tanks, config) {
  const twentyDegrees = Math.PI / 9;
  const tankRadius = TANK.radius;
  const safeDistance = tankRadius * (config.SPAWN_SAFE_RAD_MOD ?? 20);
  const safeSRRadius = tankRadius * (config.SPAWN_SAFE_SR_MOD ?? 3);
  const safeSWRadius = (getShotEffects('SW').shockOutRadius + tankRadius) * (config.SPAWN_SAFE_SW_MOD ?? 1.5);
  for (const other of tanks) {
    const distance3 = Math.hypot(other.x - spot.x, other.y - spot.y, other.z - spot.z);
    const flag = other.flag ?? null;
    if (flag === 'L' && isFacingSpawn(other, spot, twentyDegrees)) return true;
    if (flag === 'SW' && distance3 < safeSWRadius) return true;
    if ((flag === 'SR' || flag === 'BU') && distance3 < safeSRRadius) return true;
    if (distance3 < safeDistance && isFacingSpawn(other, spot, twentyDegrees)) return true;
  }
  return false;
}

// SpawnPolicy::enemyProximityCheck: the nearest living foe on the spot's own
// level, and the way it faces; no foe is as far as can be.
function nearestSpawnEnemy(spot, tanks, isFoe) {
  let best = Infinity;
  let azimuth = null;
  for (const other of tanks) {
    if (!isFoe(other)) continue;
    if (Math.abs(other.z - spot.z) >= 1) continue;
    const dist = Math.hypot(other.x - spot.x, other.y - spot.y);
    if (dist < best) {
      best = dist;
      azimuth = other.azimuth;
    }
  }
  return { distance: best === Infinity ? 1e12 : best, azimuth };
}

// SpawnPolicy::getPosition's search (SpawnPolicy.cxx:83), every spawn that is
// not a base restart: a point of one of `zones` if there are any, else anywhere
// on the map. Try spots for as long as `_spawnMaxCompTime` allows, refuse any
// that is imminently dangerous, and keep the one farthest from the nearest
// foe -- done as soon as one is `worldSize / _spawnSafeSRMod` clear, with that
// bar lowered by 1% a try. Out of time with nothing safe, the last spot is used
// anyway, upstream's "drop the sucka in, and pray". A spot the tank is put in
// danger at faces away from the nearest foe (`getAzimuth`); any other faces
// anywhere.
//
// `tanks` is every other living tank, `{ x, y, z, azimuth, flag }` with the
// flag's abbreviation; `isFoe` says which of them count for distance.
export function pickSpawnPosition({
  colliders, mapSize, waterLevel = null, zones = [], config = {}, tanks = [], isFoe = () => true,
}) {
  const nextCandidate = () => findZoneSpawnPosition(colliders, zones, waterLevel)
    || findValidSpawnPosition(colliders, mapSize, waterLevel);
  const started = Date.now();
  const budgetMs = Number.isFinite(config.SPAWN_MAX_COMP_TIME) ? config.SPAWN_MAX_COMP_TIME : 10;
  let minProximity = mapSize / (config.SPAWN_SAFE_SR_MOD || 3);
  let best = null;
  let bestDist = -1;
  let last = null;
  do {
    const spot = nextCandidate();
    last = spot;
    if (isSpawnImminentlyDangerous(spot, tanks, config)) continue;
    const { distance } = nearestSpawnEnemy(spot, tanks, isFoe);
    if (distance > bestDist) {
      bestDist = distance;
      best = spot;
    }
    if (bestDist >= minProximity) break;
    minProximity *= 0.99;
  } while (Date.now() - started <= budgetMs);
  const chosen = best || last;
  const enemy = nearestSpawnEnemy(chosen, tanks, isFoe);
  const wanted = isSpawnImminentlyDangerous(chosen, tanks, config) && enemy.azimuth !== null
    ? enemy.azimuth + Math.PI
    : Math.random() * Math.PI * 2;
  // A spot is found clear at the heading it was tried at: upstream's clearance
  // is a circle, bzo's is the tank's own box, and a tank six long beside a
  // wall fits one way and not another. Turned into the wall, it spawns inside
  // it and hangs there, unable to fall or drive.
  const fits = !Number.isFinite(chosen.azimuth)
    || isSpawnClear(colliders, chosen.x, chosen.y, chosen.z, wanted);
  return { ...chosen, azimuth: fits ? wanted : chosen.azimuth };
}
