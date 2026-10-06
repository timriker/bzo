/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The geometry the radar panel repaints with: what fits inside the square it
// shows, and what can be dropped before anything is projected.
//
// It is here rather than in `client.js` because the rejection has an invariant
// worth a test of its own -- an obstacle with any part of itself on the panel
// must never be dropped -- and because the panel is redrawn over every obstacle
// in the map every frame, which on a large map is the biggest single phase the
// client owns.

// A box footprint's four corners as signs of its half width and half depth,
// walked in order so the polygon comes out wound the one way.
export const RADAR_BOX_CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1];

// Sutherland-Hodgman against the four edges of the panel, over flat
// `x, y, x, y` buffers rather than arrays of points. Every obstacle and every
// upward mesh face in the map runs through this every frame, which is more
// vertices than a form allocating an object apiece can afford. Three scratch
// buffers serve the whole panel: the caller fills the polygon scratch and reads
// the clip's own count of vertices out of the clip buffer.
let polygonScratch = new Float64Array(64);
let clipFront = new Float64Array(64);
let clipBack = new Float64Array(64);

export function getRadarPolygonScratch() {
  return polygonScratch;
}

export function getRadarClipBuffer() {
  return clipBack;
}

// Grown to fit the widest face a map has and then left alone, since the panel
// draws the same set every frame.
export function ensureRadarPolygonBuffers(vertices) {
  const needed = Math.max(16, vertices) * 2;
  if (polygonScratch.length >= needed) return;
  let size = polygonScratch.length;
  while (size < needed) size *= 2;
  polygonScratch = new Float64Array(size);
  clipFront = new Float64Array(size);
  clipBack = new Float64Array(size);
}

// One edge. `axis` is 0 for x and 1 for y, and `keepLessEqual` picks which side
// of `boundary` survives; returns how many vertices were written to `out`.
function clipPolygonAxisAligned(src, count, out, axis, boundary, keepLessEqual) {
  let written = 0;
  for (let i = 0; i < count; i += 1) {
    const currentIndex = i * 2;
    const previousIndex = ((i + count - 1) % count) * 2;
    const currentX = src[currentIndex];
    const currentY = src[currentIndex + 1];
    const previousX = src[previousIndex];
    const previousY = src[previousIndex + 1];
    const currentOn = axis === 0 ? currentX : currentY;
    const previousOn = axis === 0 ? previousX : previousY;
    const currentInside = keepLessEqual ? currentOn <= boundary : currentOn >= boundary;
    const previousInside = keepLessEqual ? previousOn <= boundary : previousOn >= boundary;
    if (currentInside !== previousInside) {
      // An edge that runs along the boundary has no crossing to solve for, so
      // it contributes the vertex it started at.
      const delta = currentOn - previousOn;
      const t = Math.abs(delta) < 1e-9 ? 0 : (boundary - previousOn) / delta;
      out[written * 2] = previousX + ((currentX - previousX) * t);
      out[(written * 2) + 1] = previousY + ((currentY - previousY) * t);
      written += 1;
    }
    if (currentInside) {
      out[written * 2] = currentX;
      out[(written * 2) + 1] = currentY;
      written += 1;
    }
  }
  return written;
}

// Clips `count` vertices of `src` -- radar-relative, the panel's centre at the
// origin -- to the square the panel shows, and returns how many came out. The
// survivors are in `getRadarClipBuffer()`.
export function clipPolygonToRadarSquare(src, count, halfExtent) {
  // A convex polygon gains at most one vertex an edge, so four edges can only
  // reach count + 4. The buffers are sized past that.
  ensureRadarPolygonBuffers((count * 2) + 8);
  let n = clipPolygonAxisAligned(src, count, clipFront, 0, halfExtent, true);
  n = clipPolygonAxisAligned(clipFront, n, clipBack, 0, -halfExtent, false);
  n = clipPolygonAxisAligned(clipBack, n, clipFront, 1, halfExtent, true);
  n = clipPolygonAxisAligned(clipFront, n, clipBack, 1, -halfExtent, false);
  return n;
}

// Whether a point sits beyond the panel, allowing `margin` of the thing it
// stands for reaching back towards it.
export function isOutsideRadarSquare(radarX, radarY, halfExtent, margin = 0) {
  return Math.abs(radarX) > halfExtent + margin || Math.abs(radarY) > halfExtent + margin;
}

// The radius of a circle around the obstacle's centre that holds its whole
// footprint at any rotation, which is what lets the panel drop an obstacle
// without projecting its corners. It has to be the whole footprint and not a
// guess at one: hix's walkways are long enough that their centres sit well
// outside the panel while a span of them is still on it, and anything that
// tested the centre alone would blink them out from under the player.
export function getRadarObstacleCullRadius(obs) {
  return obs.size ? Math.hypot(obs.size[0], obs.size[1]) : Math.hypot(4, 4);
}

// The same rejection circle around a whole mesh, from the world-space vertex
// box the server hands over, plus the footprint that stands in for the mesh
// when it is too small on the panel for its own faces to be worth drawing.
// Spin-aware for the same reason a face's is: a mesh turning about
// `spinPivot` leaves every corner the same distance from it.
// A mesh spinning about an axis a tipped group turned off vertical (#168)
// swings its points through height as well, so its rejection circle has to
// hold the full 3D distance from the pivot rather than the flat one.
export function isTippedRadarSpin(obs) {
  return Boolean(obs.angvel && obs.spinPivot && obs.spinAxis && Math.abs(obs.spinAxis.z) < 0.999999);
}

export function getRadarMeshObstacleCull(obs) {
  const {
    minX, maxX, minY, maxY, minZ, maxZ,
  } = obs.bounds;
  const footprint = [minX, maxY, maxX, maxY, maxX, minY, minX, minY];
  const spins = Boolean(obs.angvel && obs.spinPivot);
  const tipped = isTippedRadarSpin(obs);
  const cullX = spins ? obs.spinPivot.x : (minX + maxX) / 2;
  const cullY = spins ? obs.spinPivot.y : (minY + maxY) / 2;
  const dz = tipped ? Math.max(Math.abs(minZ - obs.spinPivot.z), Math.abs(maxZ - obs.spinPivot.z)) : 0;
  let cullRadius = 0;
  for (let i = 0; i < 4; i += 1) {
    cullRadius = Math.max(
      cullRadius,
      Math.hypot(footprint[i * 2] - cullX, footprint[(i * 2) + 1] - cullY, dz),
    );
  }
  return { cullX, cullY, cullRadius, footprint };
}

// The same rejection circle, built around one face's own vertices. A mesh with
// an `angvel` (#88) spins its faces about `spinPivot`, and a spin leaves every
// vertex the same distance from that pivot -- so centring the circle there
// makes one radius hold for every angle the face will ever be drawn at, and the
// cached list keeps its meaning for as long as the map does.
export function getRadarMeshFaceCull(obs, arrays, f) {
  const spins = Boolean(obs.angvel && obs.spinPivot);
  const tipped = isTippedRadarSpin(obs);
  const start = arrays.faceStart[f];
  const end = arrays.faceStart[f + 1];
  let cullX = 0;
  let cullY = 0;
  if (spins) {
    cullX = obs.spinPivot.x;
    cullY = obs.spinPivot.y;
  } else {
    for (let c = start; c < end; c += 1) {
      const v = arrays.corners[c] * 3;
      cullX += arrays.vertices[v];
      cullY += arrays.vertices[v + 1];
    }
    cullX /= (end - start);
    cullY /= (end - start);
  }
  let cullRadius = 0;
  for (let c = start; c < end; c += 1) {
    const v = arrays.corners[c] * 3;
    const dz = tipped ? arrays.vertices[v + 2] - obs.spinPivot.z : 0;
    cullRadius = Math.max(
      cullRadius, Math.hypot(arrays.vertices[v] - cullX, arrays.vertices[v + 1] - cullY, dz),
    );
  }
  return { cullX, cullY, cullRadius };
}
