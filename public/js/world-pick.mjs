/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Which obstacle a ray meets first, for the world viewer (docs/editor-plan.md):
// what is drawn, not what collides, so drive-through and shoot-through
// obstacles and faces are found too. World frame, z up.

import { meshArrays } from './mesh-arrays.mjs';

// A flat base or a zero-height box still has a top to look at.
const MIN_THICKNESS = 0.05;

// The ray's entry and exit parameters through an axis-aligned box, or null.
function rayBoxInterval(origin, dir, min, max, maxT) {
  let near = 0;
  let far = maxT;
  for (let axis = 0; axis < 3; axis += 1) {
    const o = origin[axis];
    const d = dir[axis];
    if (Math.abs(d) < 1e-12) {
      if (o < min[axis] || o > max[axis]) return null;
      continue;
    }
    let t0 = (min[axis] - o) / d;
    let t1 = (max[axis] - o) / d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > near) near = t0;
    if (t1 < far) far = t1;
    if (near > far) return null;
  }
  return [near, far];
}

// The ray in an obstacle's own frame: centred on its `pos`, turned by minus
// its angle, z still measured from the world's ground.
function toLocal(obs, origin, dir) {
  const c = Math.cos(-(obs.angle || 0));
  const s = Math.sin(-(obs.angle || 0));
  const ox = origin[0] - obs.pos[0];
  const oy = origin[1] - obs.pos[1];
  return {
    origin: [(c * ox) - (s * oy), (s * ox) + (c * oy), origin[2] - obs.pos[2]],
    dir: [(c * dir[0]) - (s * dir[1]), (s * dir[0]) + (c * dir[1]), dir[2]],
  };
}

function boxHit(obs, origin, dir, maxT) {
  const local = toLocal(obs, origin, dir);
  const height = Math.max(obs.size[2] || 0, MIN_THICKNESS);
  const hit = rayBoxInterval(local.origin, local.dir,
    [-obs.size[0], -obs.size[1], 0], [obs.size[0], obs.size[1], height], maxT);
  return hit ? hit[0] : null;
}

// A pyramid is the box less four slopes, each a half-space; an inverted one
// has its point at the bottom.
function pyramidHit(obs, origin, dir, maxT) {
  const local = toLocal(obs, origin, dir);
  const [w, d, h] = [obs.size[0], obs.size[1], Math.abs(obs.size[2]) || MIN_THICKNESS];
  const box = rayBoxInterval(local.origin, local.dir, [-w, -d, 0], [w, d, h], maxT);
  if (!box) return null;
  let [near, far] = box;
  // Each slope as n . p <= 1: |x| / w + z / h for an upright pyramid, and
  // (h - z) / h for an inverted one.
  const zSign = obs.inverted ? -1 : 1;
  const zBase = obs.inverted ? 1 : 0;
  for (const [nx, ny] of [[1 / w, 0], [-1 / w, 0], [0, 1 / d], [0, -1 / d]]) {
    const nz = zSign / h;
    const at = (nx * local.origin[0]) + (ny * local.origin[1]) + (nz * local.origin[2]) + zBase - 1;
    const rate = (nx * local.dir[0]) + (ny * local.dir[1]) + (nz * local.dir[2]);
    if (Math.abs(rate) < 1e-12) {
      if (at > 0) return null;
      continue;
    }
    const t = -at / rate;
    if (rate < 0) near = Math.max(near, t);
    else far = Math.min(far, t);
    if (near > far) return null;
  }
  return near;
}

// The nearest face the ray crosses, both sides, every face.
function meshHit(obs, origin, dir, maxT) {
  const arrays = meshArrays(obs);
  let best = null;
  for (let f = 0; f < arrays.faceCount; f += 1) {
    const nx = arrays.facePlanes[f * 4];
    const ny = arrays.facePlanes[(f * 4) + 1];
    const nz = arrays.facePlanes[(f * 4) + 2];
    const denom = (nx * dir[0]) + (ny * dir[1]) + (nz * dir[2]);
    if (Math.abs(denom) < 1e-9) continue;
    const dist = (nx * origin[0]) + (ny * origin[1]) + (nz * origin[2]) + arrays.facePlanes[(f * 4) + 3];
    const t = -dist / denom;
    if (t < 0 || t > maxT || (best !== null && t >= best)) continue;
    const px = origin[0] + (dir[0] * t);
    const py = origin[1] + (dir[1] * t);
    const pz = origin[2] + (dir[2] * t);
    let inside = true;
    for (let c = arrays.faceStart[f]; c < arrays.faceStart[f + 1]; c += 1) {
      const e = c * 4;
      if ((arrays.edgePlanes[e] * px) + (arrays.edgePlanes[e + 1] * py)
        + (arrays.edgePlanes[e + 2] * pz) + arrays.edgePlanes[e + 3] > 0.001) {
        inside = false;
        break;
      }
    }
    if (inside) best = t;
  }
  return best;
}

function exactHit(obs, origin, dir, maxT) {
  if (obs.type === 'mesh') return meshHit(obs, origin, dir, maxT);
  if (!obs.pos || !obs.size) return null;
  if (obs.type === 'pyramid') return pyramidHit(obs, origin, dir, maxT);
  return boxHit(obs, origin, dir, maxT);
}

// `origin` and `dir` are [x, y, z]; `dir` need not be unit length, and the
// distance comes back in its units. Returns `{ index, distance }` into
// `obstacles`, or null when the ray meets nothing within `maxDistance`.
export function pickObstacle(obstacles, origin, dir, maxDistance = 4000) {
  const candidates = [];
  obstacles.forEach((obs, index) => {
    const b = obs.bounds;
    if (!b) return;
    const hit = rayBoxInterval(origin, dir, [b.minX, b.minY, b.minZ],
      [b.maxX, b.maxY, Math.max(b.maxZ, b.minZ + MIN_THICKNESS)], maxDistance);
    if (hit) candidates.push({ index, enter: hit[0] });
  });
  candidates.sort((a, b) => a.enter - b.enter);
  let best = null;
  for (const { index, enter } of candidates) {
    if (best && enter > best.distance) break;
    const t = exactHit(obstacles[index], origin, dir, best ? best.distance : maxDistance);
    if (t !== null && (!best || t < best.distance)) best = { index, distance: t };
  }
  return best;
}
