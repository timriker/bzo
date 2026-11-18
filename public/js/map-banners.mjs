/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// Banners a map builds out of mesh faces: a thin upright box, flag-sized,
// whose two broad faces wear the `flag` texture and whose one upright edge
// stands against something else in the same mesh, its pole. bzo draws such a
// banner as cloth rippling on the game flags' waves; upstream has no way to
// animate a mesh but `angvel`, so a BZFlag client keeps the box.
//
// Shape alone decides. A floor or a sign wearing the texture is not upright or
// not thin; a banner nothing touches has no edge to hang from and stays as the
// map drew it.

import { NO_INDEX } from './mesh-arrays.mjs';

// The tile `MeshSceneNodeGenerator::makeTexcoords` projects a face's own
// texcoords at, where it states none.
export const MESH_AUTO_UV_TILE_SIZE = 8;

const BANNER_TEXTURE = 'flag';
const BANNER_MIN_SIDE = 0.2;
const BANNER_MAX_SIDE = 4;
const BANNER_MAX_THICKNESS = 0.1;
// How far from level an edge or a normal may lean and still count as level.
const LEVEL_TOLERANCE = 0.02;
const BOX_TOLERANCE = 1e-3;
// The pole side must be clearly the nearer: at most this share of the free
// side's distance to the rest of the mesh.
const HINGE_RATIO = 0.5;

function vertexAt(arrays, vertexIndex) {
  const i = vertexIndex * 3;
  return { x: arrays.vertices[i], y: arrays.vertices[i + 1], z: arrays.vertices[i + 2] };
}

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => (a.x * b.x) + (a.y * b.y) + (a.z * b.z);
const cross = (a, b) => ({
  x: (a.y * b.z) - (a.z * b.y),
  y: (a.z * b.x) - (a.x * b.z),
  z: (a.x * b.y) - (a.y * b.x),
});
const length = (a) => Math.hypot(a.x, a.y, a.z);
const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

// A face's texcoords where it states none: `MeshSceneNodeGenerator::
// makeTexcoords`. Vertex 0 pins (0,0), the first edge is U, the face's plane
// normal crossed with it is V, and each corner is its offset from vertex 0 in
// that basis over the 8-unit tile. One [u, v] per corner, or null for a face
// without a plane or with a zero-length first edge.
export function planarFaceUVs(arrays, f) {
  const nx = arrays.facePlanes[f * 4];
  const ny = arrays.facePlanes[(f * 4) + 1];
  const nz = arrays.facePlanes[(f * 4) + 2];
  if (nx === 0 && ny === 0 && nz === 0) return null;
  const start = arrays.faceStart[f];
  const end = arrays.faceStart[f + 1];
  const p0 = vertexAt(arrays, arrays.corners[start]);
  const p1 = vertexAt(arrays, arrays.corners[start + 1]);
  const xLen = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
  if (!(xLen > 0)) return null;
  const ux = (p1.x - p0.x) / xLen;
  const uy = (p1.y - p0.y) / xLen;
  const uz = (p1.z - p0.z) / xLen;
  const vx = (ny * uz) - (nz * uy);
  const vy = (nz * ux) - (nx * uz);
  const vz = (nx * uy) - (ny * ux);
  const vLen = Math.hypot(vx, vy, vz);
  if (!(vLen > 0)) return null;
  const nvx = vx / vLen; const nvy = vy / vLen; const nvz = vz / vLen;
  const uvs = [];
  for (let c = start; c < end; c += 1) {
    const v = vertexAt(arrays, arrays.corners[c]);
    const dx = v.x - p0.x; const dy = v.y - p0.y; const dz = v.z - p0.z;
    uvs.push([
      ((dx * ux) + (dy * uy) + (dz * uz)) / MESH_AUTO_UV_TILE_SIZE,
      ((dx * nvx) + (dy * nvy) + (dz * nvz)) / MESH_AUTO_UV_TILE_SIZE,
    ]);
  }
  return uvs;
}

// The texcoords a face draws with: its own where it states them, projected
// where it does not.
function faceUVs(arrays, f) {
  const start = arrays.faceStart[f];
  const end = arrays.faceStart[f + 1];
  if (arrays.cornerTexcoord[start] === NO_INDEX) return planarFaceUVs(arrays, f);
  const uvs = [];
  for (let c = start; c < end; c += 1) {
    const t = arrays.cornerTexcoord[c] * 2;
    uvs.push([arrays.texcoords[t], arrays.texcoords[t + 1]]);
  }
  return uvs;
}

// An upright rectangle wearing the banner texture, measured: its two bottom
// corners, its height, its outward normal. Null for anything else.
function bannerFace(arrays, f) {
  const start = arrays.faceStart[f];
  if (arrays.faceStart[f + 1] - start !== 4) return null;
  const material = arrays.materials[arrays.faceMaterial[f]];
  if (!material || material.texture !== BANNER_TEXTURE || material.textureUrl) return null;
  const corners = [0, 1, 2, 3].map((k) => ({ k, p: vertexAt(arrays, arrays.corners[start + k]) }));
  const normal = cross(sub(corners[1].p, corners[0].p), sub(corners[2].p, corners[0].p));
  const normalLength = length(normal);
  if (!(normalLength > 0)) return null;
  const n = scale(normal, 1 / normalLength);
  if (Math.abs(n.z) > LEVEL_TOLERANCE) return null;
  const byHeight = [...corners].sort((a, b) => a.p.z - b.p.z);
  const [b0, b1, t0, t1] = byHeight;
  const height = ((t0.p.z + t1.p.z) / 2) - ((b0.p.z + b1.p.z) / 2);
  if (Math.abs(b0.p.z - b1.p.z) > LEVEL_TOLERANCE || Math.abs(t0.p.z - t1.p.z) > LEVEL_TOLERANCE) return null;
  if (height < BANNER_MIN_SIDE || height > BANNER_MAX_SIDE) return null;
  const width = Math.hypot(b1.p.x - b0.p.x, b1.p.y - b0.p.y);
  if (width < BANNER_MIN_SIDE || width > BANNER_MAX_SIDE) return null;
  // Each top corner straight above a bottom one: a rectangle, not a rhombus.
  const above = (top, bottom) => Math.hypot(top.p.x - bottom.p.x, top.p.y - bottom.p.y) <= LEVEL_TOLERANCE * width;
  const tops = above(t0, b0) ? [t0, t1] : [t1, t0];
  if (!above(tops[0], b0) || !above(tops[1], b1)) return null;
  return { f, n, width, height, bottom: [b0, b1], top: tops };
}

// Every banner in one mesh's draw arrays, and the faces drawing it -- its two
// broad faces and the thin edges between them -- for the caller to leave out.
// Each banner is three points in the mesh's own frame: `hinge`, the bottom of
// the edge at the pole, on the box's middle plane; `free`, the bottom of the
// far edge; `top`, the top of the pole edge. `uvs` are the front face's
// texcoords at those three corners, before any `texmat`, and `material` is
// that face's descriptor.
export function findMeshBanners(arrays) {
  const dropFaces = new Set();
  const banners = [];
  if (!arrays || !arrays.faceCount) return { dropFaces, banners };

  const candidates = [];
  for (let f = 0; f < arrays.faceCount; f += 1) {
    const face = bannerFace(arrays, f);
    if (face) candidates.push(face);
  }
  if (candidates.length < 2) return { dropFaces, banners };

  const used = new Set();
  for (let i = 0; i < candidates.length; i += 1) {
    if (used.has(i)) continue;
    const a = candidates[i];
    for (let j = i + 1; j < candidates.length; j += 1) {
      if (used.has(j)) continue;
      const b = candidates[j];
      if (dot(a.n, b.n) > -0.99) continue;
      if (Math.abs(a.width - b.width) > BOX_TOLERANCE * 10 || Math.abs(a.height - b.height) > BOX_TOLERANCE * 10) continue;
      const thickness = Math.abs(dot(sub(b.bottom[0].p, a.bottom[0].p), a.n));
      if (thickness > BANNER_MAX_THICKNESS) continue;
      // The same rectangle seen from both sides: each bottom corner of one
      // has a partner across the thickness on the other.
      const across = (p) => b.bottom.some((q) => Math.hypot(q.p.x - p.x, q.p.y - p.y) <= thickness + BOX_TOLERANCE);
      if (!across(a.bottom[0].p) || !across(a.bottom[1].p)) continue;
      const banner = pairBanner(arrays, a, b, thickness);
      if (!banner) continue;
      used.add(i);
      used.add(j);
      banner.faces.forEach((f) => dropFaces.add(f));
      banners.push(banner.banner);
      break;
    }
  }
  return { dropFaces, banners };
}

function pairBanner(arrays, a, b, thickness) {
  const bottomZ = a.bottom[0].p.z;
  const topZ = bottomZ + a.height;
  const along = sub(a.bottom[1].p, a.bottom[0].p);
  const alongUnit = scale({ x: along.x, y: along.y, z: 0 }, 1 / Math.hypot(along.x, along.y));
  const origin = a.bottom[0].p;
  // Inside the box the two faces bound, with a hair to spare: the faces
  // themselves, and the thin edges that close it.
  const inside = (p) => {
    const d = sub(p, origin);
    const s = dot(d, alongUnit);
    const t = dot(d, a.n);
    return s >= -BOX_TOLERANCE && s <= a.width + BOX_TOLERANCE
      && t <= BOX_TOLERANCE && t >= -thickness - BOX_TOLERANCE
      && p.z >= bottomZ - BOX_TOLERANCE && p.z <= topZ + BOX_TOLERANCE;
  };
  const faces = [];
  const others = [];
  for (let f = 0; f < arrays.faceCount; f += 1) {
    const start = arrays.faceStart[f];
    const end = arrays.faceStart[f + 1];
    let all = true;
    for (let c = start; c < end && all; c += 1) all = inside(vertexAt(arrays, arrays.corners[c]));
    if (all) {
      faces.push(f);
    } else {
      for (let c = start; c < end; c += 1) others.push(vertexAt(arrays, arrays.corners[c]));
    }
  }
  if (others.length === 0) return null;

  // The pole is whatever else the mesh holds nearest one upright edge.
  const nearest = (p) => others.reduce((best, q) => Math.min(best, Math.hypot(q.x - p.x, q.y - p.y)), Infinity);
  const d0 = nearest(a.bottom[0].p);
  const d1 = nearest(a.bottom[1].p);
  let hingeEnd; let freeEnd;
  if (d0 <= d1 * HINGE_RATIO) { hingeEnd = 0; freeEnd = 1; } else if (d1 <= d0 * HINGE_RATIO) { hingeEnd = 1; freeEnd = 0; } else return null;

  // The front is the face that shows the pole on the left, as a game flag's
  // does from the side its cloth faces.
  const up = { x: 0, y: 0, z: 1 };
  const hingeToFree = sub(a.bottom[freeEnd].p, a.bottom[hingeEnd].p);
  const frontNormal = cross(hingeToFree, up);
  const front = dot(frontNormal, a.n) > 0 ? a : b;
  const back = front === a ? b : a;
  const uvs = faceUVs(arrays, front.f);
  if (!uvs) return null;

  const frontHinge = front.bottom.reduce((best, c) => (
    Math.hypot(c.p.x - a.bottom[hingeEnd].p.x, c.p.y - a.bottom[hingeEnd].p.y)
      < Math.hypot(best.p.x - a.bottom[hingeEnd].p.x, best.p.y - a.bottom[hingeEnd].p.y) ? c : best));
  const frontFree = front.bottom[0] === frontHinge ? front.bottom[1] : front.bottom[0];
  const frontTop = front.top[front.bottom.indexOf(frontHinge)];
  // Half the thickness in from the front face: the cloth hangs where the box
  // was, not on one of its sides.
  const middle = scale(front.n, -thickness / 2);
  const hinge = add(frontHinge.p, middle);
  return {
    faces,
    banner: {
      hinge,
      free: add(frontFree.p, middle),
      top: add(frontTop.p, middle),
      uvs: {
        hinge: uvs[frontHinge.k],
        free: uvs[frontFree.k],
        top: uvs[frontTop.k],
      },
      material: arrays.materials[arrays.faceMaterial[front.f]],
      backMaterial: arrays.materials[arrays.faceMaterial[back.f]],
    },
  };
}
