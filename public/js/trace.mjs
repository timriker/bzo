/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// trace.mjs - Where a shot goes once it is fired: one step of a shell's flight
// through the world's teleporters, and a beam's whole path through buildings,
// the ground, teleporters and the world's edge, bouncing where the world says
// shots bounce. The server flies every shot by it and decides kills from where
// they go; a browser predicts its own shells and draws a beam it was not handed
// by it -- one answer for both, so they cannot drift.
//
// `teleports` is `buildTeleporterIndex` (the `teleport` pair). Positions and
// directions are in upstream's frame: +Z up, +Y north.

import {
  findShotEmbeddedObstacle,
  findShotSegmentImpact,
  getShotObstacleNormal,
  reflectShotDirection,
  SHOT_BOUNCE_CLEARANCE,
  SHOT_COLLISION_RADIUS,
} from './collision.mjs';
import {
  getShotTeleporterCrossing,
  getShotTeleporterFrameHit,
  getTeleportDestinationFace,
  teleportReentryBlockDistance,
  transformShotThroughTeleporter,
} from './teleport.mjs';

// The most teleporters one step of a shell passes through.
const MAX_TELEPORTS_PER_STEP = 8;
// How far past the destination face a teleported shell is put down.
const SHOT_TELEPORT_EXIT = 0.02;
// makeSegments' own maxSegment. A straight beam is one segment; a ricocheting
// one is as many as it can fit into its range, which on an enclosed map is what
// ends it rather than the range doing so.
const MAX_BEAM_SEGMENTS = 100;
// How far off a surface a beam's next segment is traced from, along that
// surface's normal -- a shell's own clearance, so a beam's bounce and a shell's
// agree. It has to clear SHOT_COLLISION_RADIUS: within that distance the shot
// still counts as inside the obstacle, and a segment that starts inside
// something is carried straight through it.
const BEAM_SURFACE_CLEARANCE = SHOT_BOUNCE_CLEARANCE;

// The nearest thing a segment meets among the teleporters: a doorway it goes
// through, or a frame it hits. A teleporter just come out of is passed over
// while the re-entry block lasts. A frame is a building, so a shot that goes
// through buildings goes through frames too (`ignoreFrames`). A frame hit no
// later than the nearest crossing wins: a crossing of that same teleporter
// would already have proved it is not the frame.
export function findTeleporterEvent(teleports, from, to, blockedIndex, blockedDistance, ignoreFrames = false) {
  let crossing = null;
  let frame = null;
  for (const obs of teleports.teleporters.values()) {
    const through = getShotTeleporterCrossing(from, to, obs);
    const blocked = blockedIndex !== null && blockedDistance > 1e-6 && obs.teleporterIndex === blockedIndex;
    if (through && !blocked && (!crossing || through.t < crossing.event.t)) crossing = { obs, type: 'teleport', event: through };
    if (ignoreFrames) continue;
    const hit = getShotTeleporterFrameHit(from, to, obs);
    if (hit && (!frame || hit.t < frame.event.t)) frame = { obs, type: 'frameHit', event: hit };
  }
  if (frame && (!crossing || frame.event.t <= crossing.event.t)) return frame;
  return crossing;
}

// Where a segment leaving the world crosses its edge, by bisection; the end of
// the segment where it did not start inside and leave.
export function findMapEdgeImpactPoint(prevX, prevY, prevZ, nextX, nextY, nextZ, halfMap) {
  const inside = (x, y) => Math.abs(x) <= halfMap && Math.abs(y) <= halfMap;
  if (!inside(prevX, prevY) || inside(nextX, nextY)) return { x: nextX, y: nextY, z: nextZ };
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) * 0.5;
    if (inside(prevX + ((nextX - prevX) * mid), prevY + ((nextY - prevY) * mid))) lo = mid;
    else hi = mid;
  }
  return {
    x: prevX + ((nextX - prevX) * lo),
    y: prevY + ((nextY - prevY) * lo),
    z: prevZ + ((nextZ - prevZ) * lo),
  };
}

// One step of a shell's flight through the world's teleporters: `distance`
// along `dir` from `start`, through every doorway it meets, stopping where it
// meets a frame. `onTeleport` hears each crossing, for a host that logs them.
//
// Returns where the shell ends up and heading which way, how many teleporters
// it went through, the re-entry block it carries on with, and -- for a frame
// hit -- the frame and how much of the step was left.
export function traceShotThroughTeleporters(
  teleports, start, dir, distance, reentryBlockTeleporterIndex = null, reentryBlockDistance = 0, onTeleport = null,
) {
  let point = { ...start };
  let direction = { ...dir };
  let remaining = distance;
  let teleportCount = 0;
  let blockedIndex = Number.isInteger(reentryBlockTeleporterIndex) ? reentryBlockTeleporterIndex : null;
  let blockedDistance = Math.max(0, Number(reentryBlockDistance) || 0);

  while (remaining > 1e-6 && teleportCount < MAX_TELEPORTS_PER_STEP) {
    const end = {
      x: point.x + (direction.x * remaining),
      y: point.y + (direction.y * remaining),
      z: point.z + (direction.z * remaining),
    };
    const met = findTeleporterEvent(teleports, point, end, blockedIndex, blockedDistance);
    if (!met) {
      blockedDistance = Math.max(0, blockedDistance - remaining);
      if (blockedDistance <= 1e-6) blockedIndex = null;
      point = end;
      break;
    }
    if (met.type === 'frameHit') {
      return {
        point: met.event.point,
        direction,
        teleports: teleportCount,
        reentryBlockTeleporterIndex: blockedIndex,
        reentryBlockDistance: Math.max(0, blockedDistance - (remaining * met.event.t)),
        frameHit: true,
        frameHitObstacle: met.obs,
        frameHitRemaining: remaining * (1 - met.event.t),
      };
    }
    const sourceFaceId = met.event.sourceFaceId;
    const destFaceId = getTeleportDestinationFace(teleports.links, sourceFaceId);
    const destIndex = Math.floor(destFaceId / 2);
    const destObs = teleports.teleporters.get(destIndex);
    if (!destObs) break;
    const out = transformShotThroughTeleporter(
      met.event.point, direction, met.obs, sourceFaceId % 2, destObs, destFaceId % 2);
    remaining = Math.max(0, remaining - (remaining * met.event.t));
    point = {
      x: out.pointOut.x + (out.dirOut.x * SHOT_TELEPORT_EXIT),
      y: out.pointOut.y + (out.dirOut.y * SHOT_TELEPORT_EXIT),
      z: out.pointOut.z + (out.dirOut.z * SHOT_TELEPORT_EXIT),
    };
    direction = out.dirOut;
    blockedIndex = destIndex;
    blockedDistance = teleportReentryBlockDistance(destObs);
    teleportCount++;
    if (onTeleport) onTeleport({ sourceFaceId, destFaceId, source: met.obs, dest: destObs });
  }

  return {
    point,
    direction,
    teleports: teleportCount,
    reentryBlockTeleporterIndex: blockedIndex,
    reentryBlockDistance: blockedDistance,
    frameHit: false,
    frameHitObstacle: null,
  };
}

// A beam's whole path, walked when it is fired. `_laserAdVel` 1000 puts the
// shell further downrange inside one step than any world is wide, so upstream
// builds its laser's entire segment list in LaserStrategy's constructor and
// draws along it; this is that list.
//
// Each segment ends at whichever of a building, the ground, a teleporter, the
// world's edge and a tank the beam reaches first, as makeSegments narrows one
// `t` across them, and carries what ended it -- which is what tells a client to
// play a ricochet where the next one starts. `world` is { colliders, teleports,
// mapSize }; `options` { ricochet, throughBuildings, findHit(from, to),
// onTeleport }. `findHit` is the tank test, for a host that decides hits: the
// first tank the segment reaches, as { point, ... }, or null.
//
// Returns { segments, endReason, bounces, hit }.
export function traceBeam(world, start, dir, range, options = {}) {
  const { ricochet = false, throughBuildings = false, findHit = null, onTeleport = null } = options;
  const obstacles = throughBuildings ? [] : world.colliders;
  const halfMap = world.mapSize / 2;
  const segments = [];
  let point = { ...start };
  // Where the segment is drawn from, which is the surface it bounced off rather
  // than the clearance point the next segment is traced from.
  let drawFrom = { ...point };
  let direction = { ...dir };
  let remaining = range;
  let blockedIndex = null;
  let blockedDistance = 0;
  // True only for the segment starting right after a teleport, never for the
  // muzzle's own starting point or after a bounce (issue #83).
  let justTeleported = false;
  let endReason = 'range';
  let bounces = 0;

  for (let segment = 0; segment < MAX_BEAM_SEGMENTS && remaining > 1e-6; segment++) {
    const far = {
      x: point.x + (direction.x * remaining),
      y: point.y + (direction.y * remaining),
      z: point.z + (direction.z * remaining),
    };
    // The ground and the buildings are asked over the whole reach and the
    // nearer of the two truncates the segment; the teleporters are asked over
    // what is left -- a portal behind a wall is not one the beam reaches.
    const groundFraction = (direction.z < 0 && far.z < 0) ? (0 - point.z) / (direction.z * remaining) : Infinity;
    // A beam that begins inside something because it just came out of a
    // teleporter is carried through; anything else that started embedded --
    // the muzzle overlapping a thin wall -- is a hit right there.
    const embedded = findShotEmbeddedObstacle(obstacles, point.x, point.y, point.z, SHOT_COLLISION_RADIUS);
    const impact = embedded
      ? (justTeleported ? null : { fraction: 0, obstacle: embedded, face: null })
      : findShotSegmentImpact(obstacles, point, far, SHOT_COLLISION_RADIUS);
    const obstacleFraction = impact ? impact.fraction : Infinity;
    justTeleported = false;

    let reason = 'range';
    let obstacle = null;
    let obstacleFace = -1;
    let fraction = 1;
    if (obstacleFraction <= groundFraction && obstacleFraction < 1) {
      reason = 'obstacle';
      obstacle = impact.obstacle;
      obstacleFace = Number.isInteger(impact.face) ? impact.face : -1;
      fraction = obstacleFraction;
    } else if (groundFraction < 1) {
      reason = 'ground';
      fraction = groundFraction;
    }
    let end = {
      x: point.x + ((far.x - point.x) * fraction),
      y: point.y + ((far.y - point.y) * fraction),
      z: reason === 'ground' ? 0 : point.z + ((far.z - point.z) * fraction),
    };

    const met = findTeleporterEvent(world.teleports, point, end, blockedIndex, blockedDistance, throughBuildings);
    if (met) {
      end = { ...met.event.point };
      reason = met.type === 'frameHit' ? 'frame_hit' : 'teleport';
      obstacle = met.type === 'frameHit' ? met.obs : null;
      obstacleFace = -1;
    }
    if (Math.abs(end.x) > halfMap || Math.abs(end.y) > halfMap) {
      end = findMapEdgeImpactPoint(point.x, point.y, point.z, end.x, end.y, end.z, halfMap);
      reason = 'out_of_bounds';
      obstacle = null;
      obstacleFace = -1;
    }

    const hit = findHit ? findHit(point, end) : null;
    if (hit) {
      segments.push({ from: { ...drawFrom }, to: { ...hit.point }, end: 'player_hit' });
      return { segments, endReason: 'player_hit', bounces, hit };
    }

    segments.push({ from: { ...drawFrom }, to: { ...end }, end: reason });
    const travelled = Math.hypot(end.x - point.x, end.y - point.y, end.z - point.z);
    remaining = Math.max(0, remaining - travelled);
    blockedDistance = Math.max(0, blockedDistance - travelled);
    if (blockedDistance <= 1e-6) blockedIndex = null;
    endReason = reason;

    if (reason === 'teleport') {
      const sourceFaceId = met.event.sourceFaceId;
      const destFaceId = getTeleportDestinationFace(world.teleports.links, sourceFaceId);
      const destIndex = Math.floor(destFaceId / 2);
      const destObs = world.teleports.teleporters.get(destIndex);
      if (!destObs) break;
      const out = transformShotThroughTeleporter(end, direction, met.obs, sourceFaceId % 2, destObs, destFaceId % 2);
      point = {
        x: out.pointOut.x + (out.dirOut.x * BEAM_SURFACE_CLEARANCE),
        y: out.pointOut.y + (out.dirOut.y * BEAM_SURFACE_CLEARANCE),
        z: out.pointOut.z + (out.dirOut.z * BEAM_SURFACE_CLEARANCE),
      };
      direction = out.dirOut;
      drawFrom = { ...point };
      justTeleported = true;
      blockedIndex = destIndex;
      blockedDistance = teleportReentryBlockDistance(destObs);
      if (onTeleport) onTeleport({ sourceFaceId, destFaceId, source: met.obs, dest: destObs });
      continue;
    }

    // makeSegments promotes Stop to Reflect on a world where every shot
    // bounces, so a laser fired there bends. All three surfaces bounce it: a
    // building about its own normal, the ground about straight up, and a
    // teleporter frame about its nearest border column's (issue #110). The
    // next segment is traced from clear of the surface, along its normal: a
    // grazing bounce leaves almost no perpendicular gap, and it is the
    // perpendicular gap that decides whether the shot still reads as inside.
    if (ricochet && (reason === 'obstacle' || reason === 'ground' || reason === 'frame_hit')) {
      const normal = reason === 'ground'
        ? { x: 0, y: 0, z: 1 }
        : getShotObstacleNormal(obstacle, end.x, end.y, end.z, SHOT_COLLISION_RADIUS, obstacleFace);
      direction = reflectShotDirection(direction.x, direction.y, direction.z, normal);
      drawFrom = { ...end };
      point = {
        x: end.x + (normal.x * BEAM_SURFACE_CLEARANCE),
        y: end.y + (normal.y * BEAM_SURFACE_CLEARANCE),
        z: end.z + (normal.z * BEAM_SURFACE_CLEARANCE),
      };
      bounces++;
      continue;
    }
    break;
  }
  return { segments, endReason, bounces, hit: null };
}
