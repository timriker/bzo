/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// teleport.mjs - Teleporters as something passes through them: whether a
// segment goes through one's doorway or hits its frame (Teleporter::isTeleported),
// where it comes out of the linked face and heading which way
// (Teleporter::getPointWRT). A shot's flight through them is the `trace` pair's,
// and a tank's crossing the server's and the client's -- all of them by this
// one geometry.
//
// `teleporters` is the world's teleporters by index and `links` the face each
// face sends to (`buildTeleporterIndex`). A face id is `index * 2 + face`, face
// 0 the front -- the side the teleporter's own +X points to -- and 1 the back.
//
// Positions and directions are in upstream's frame: +Z up, +Y north.

import { getColliderLocalPoint, getShotTeleporterDims } from './collision.mjs';

const BZFLAG_TELEPORT_TOLERANCE = 1e-6;
// How far a shot that has just come out of a teleporter travels before that
// teleporter can take it again: past its own doorway, so it does not go
// straight back in.
export const SHOT_TELEPORT_REENTRY_BLOCK_DISTANCE = 0.5;

// The world's teleporters by index, and where each face sends: the map's own
// links (`{ sourceFaceId, destFaceId }`), each face's destinations in order and
// once each. A face with no link sends to its teleporter's other face
// (`getTeleportDestinationFace`).
export function buildTeleporterIndex(obstacles, links = []) {
  const teleporters = new Map();
  for (const obs of obstacles || []) {
    if (obs?.kind === 'teleporter' && Number.isInteger(obs.teleporterIndex)) teleporters.set(obs.teleporterIndex, obs);
  }
  const bySource = new Map();
  for (const link of Array.isArray(links) ? links : []) {
    if (!Number.isInteger(link?.sourceFaceId) || !Number.isInteger(link?.destFaceId)) continue;
    if (!bySource.has(link.sourceFaceId)) bySource.set(link.sourceFaceId, []);
    bySource.get(link.sourceFaceId).push(link.destFaceId);
  }
  for (const [face, destinations] of bySource) {
    bySource.set(face, Array.from(new Set(destinations)).sort((a, b) => a - b));
  }
  return { teleporters, links: bySource };
}

// Where a segment enters a box, as a fraction of it: 0 when it starts inside,
// null when it misses.
export function getSegmentBoxEntryTime(localStart, localEnd, bounds) {
  let tMin = 0;
  let tMax = 1;
  for (const axis of ['x', 'y', 'z']) {
    const start = localStart[axis];
    const d = localEnd[axis] - start;
    const min = bounds.min[axis];
    const max = bounds.max[axis];
    if (Math.abs(d) < 1e-9) {
      if (start < min || start > max) return null;
      continue;
    }
    let t1 = (min - start) / d;
    let t2 = (max - start) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }
  if (tMax < 0 || tMin > 1) return null;
  return Math.max(0, tMin);
}

// The segment in the teleporter's own frame, and when it enters the frame's
// outer block and the doorway's inner one.
// Where a teleporter stands.
function baseOf(obs) {
  return (obs.pos && obs.pos[2]) || 0;
}

function teleporterEntries(start, end, obs) {
  const dims = getShotTeleporterDims(obs);
  const startLocal = getColliderLocalPoint(start.x, start.y, obs);
  const endLocal = getColliderLocalPoint(end.x, end.y, obs);
  const base = baseOf(obs);
  const localStart = { x: startLocal.x, y: startLocal.y, z: start.z - base };
  const localEnd = { x: endLocal.x, y: endLocal.y, z: end.z - base };
  const outer = getSegmentBoxEntryTime(localStart, localEnd, {
    min: { x: -dims.halfW, y: -dims.halfD, z: 0 },
    max: { x: dims.halfW, y: dims.halfD, z: dims.h },
  });
  const inner = getSegmentBoxEntryTime(localStart, localEnd, {
    min: { x: -dims.halfW, y: -dims.activeHalfD, z: 0 },
    max: { x: dims.halfW, y: dims.activeHalfD, z: dims.activeH },
  });
  return { localStart, localEnd, outer, inner };
}

function pointAlong(start, end, t) {
  return {
    x: start.x + ((end.x - start.x) * t),
    y: start.y + ((end.y - start.y) * t),
    z: start.z + ((end.z - start.z) * t),
  };
}

// Teleporter::isTeleported: the segment goes through the doorway -- the inner,
// border-less block -- without first meeting the frame around it. Which face
// it entered by is which side of the plane it was on: "if to east of
// teleporter then face 0 else face 1", in the teleporter's own frame.
export function getShotTeleporterCrossing(start, end, obs) {
  const { localStart, localEnd, outer, inner } = teleporterEntries(start, end, obs);
  if (inner === null || inner < 0 || inner > 1) return null;
  if (outer !== null && (inner - outer) > BZFLAG_TELEPORT_TOLERANCE) return null;
  const hitLocalX = localStart.x + ((localEnd.x - localStart.x) * inner);
  const face = hitLocalX > 0 ? 0 : 1;
  return {
    t: inner,
    face,
    sourceFaceId: (obs.teleporterIndex * 2) + face,
    tOuter: outer,
    point: pointAlong(start, end, inner),
  };
}

// Teleporter::isTeleported's other outcome: the frame's own solid met before
// any doorway crossing -- the frame rather than its doorway, which a shot
// bounces off like any other building (issue #110).
export function getShotTeleporterFrameHit(start, end, obs) {
  const { outer, inner } = teleporterEntries(start, end, obs);
  if (outer === null || outer < 0 || outer > 1) return null;
  if (inner !== null && inner >= 0 && inner <= 1 && (inner - outer) <= BZFLAG_TELEPORT_TOLERANCE) return null;
  return { t: outer, point: pointAlong(start, end, outer) };
}

// A turn of `angle` counter-clockwise about +Z, upstream's `rotateZ`.
export function rotateXY(x, y, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: (cos * x) - (sin * y), y: (sin * x) + (cos * y) };
}

// Teleporter::getPointWRT: the point and direction coming out of `destFace` of
// `destObs` for one going into `sourceFace` of `sourceObs` -- the same place in
// the doorway, scaled to the destination's size, and turned by the difference
// between the two faces' headings, `rotateDelta`, which a heading adds.
export function transformShotThroughTeleporter(pointIn, dirIn, sourceObs, sourceFace, destObs, destFace) {
  const srcDims = getShotTeleporterDims(sourceObs);
  const dstDims = getShotTeleporterDims(destObs);
  const radians1 = sourceObs.angle + (sourceFace === 0 ? 0 : Math.PI);
  const radians2 = destObs.angle + (destFace === 1 ? 0 : Math.PI);
  const local = rotateXY(pointIn.x - sourceObs.pos[0], pointIn.y - sourceObs.pos[1], -radians1);
  const relativeZ = pointIn.z - baseOf(sourceObs);
  const breadthScale = srcDims.activeHalfD > 1e-6 ? (dstDims.activeHalfD / srcDims.activeHalfD) : 1;
  const heightScale = srcDims.activeH > 1e-6 ? (dstDims.activeH / srcDims.activeH) : 1;
  const rotatedOut = rotateXY(-dstDims.halfW, local.y * breadthScale, radians2);
  const pointOut = {
    x: destObs.pos[0] + rotatedOut.x,
    y: destObs.pos[1] + rotatedOut.y,
    z: baseOf(destObs) + (relativeZ * heightScale),
  };
  const rotateDelta = radians2 - radians1;
  const dirRotated = rotateXY(dirIn.x, dirIn.y, rotateDelta);
  return { pointOut, dirOut: { x: dirRotated.x, y: dirRotated.y, z: dirIn.z }, rotateDelta };
}

// How far something that has just come out of `destObs` travels before that
// teleporter can take it again: past its own doorway.
export function teleportReentryBlockDistance(destObs) {
  return Math.max(SHOT_TELEPORT_REENTRY_BLOCK_DISTANCE, (getShotTeleporterDims(destObs).activeHalfD * 2) + 0.05);
}

// World::getTeleportTarget: the face a face sends to -- its first link, or its
// own teleporter's other face.
export function getTeleportDestinationFace(links, sourceFaceId) {
  const destinations = links.get(sourceFaceId);
  if (destinations && destinations.length > 0) return destinations[0];
  return (Math.floor(sourceFaceId / 2) * 2) + (1 - (sourceFaceId % 2));
}
