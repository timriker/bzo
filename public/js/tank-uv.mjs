/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// How big one camo patch is, in world units, wherever camo is drawn. The treads
// already work this way -- TREAD_UNITS_PER_TILE in render.js sizes a tread link
// so a longer track carries more links rather than the same few stretched
// further -- and a camo patch is the same kind of thing: a feature of the
// material, not of the part it happens to be painted on.
//
// Without a rule like this each generator's geometry decided its own scale by
// accident. An ExtrudeGeometry hands back its own model-space coordinates as
// texture coordinates, so a body came out tiled about once per unit; a
// BoxGeometry or a CylinderGeometry hands back 0..1 per face, so a wheel or a
// barrel came out with exactly one copy stretched over it however big it was.
// On one tank that read as three different camos -- fine noise on the hull,
// broad patches on the turret, a single smear on each wheel.
//
// A tank is about six units long, so this puts roughly a patch and a half along
// a hull. It is the one number to turn if camo should be coarser or finer.
export const CAMO_UNITS_PER_TILE = 4.0;

// Camo is a skin rather than a decal: there is no right way up for it and no
// feature that has to land anywhere in particular, so the projection only has
// to keep the patches the same size everywhere and not stretch them.
//
// Which is what this does, per face, by the axis the face points down. A face
// is textured with the two coordinates it does not point along, so it is always
// projected onto the plane it most nearly lies in and never sees the texture
// edge-on. That costs a seam wherever the dominant axis changes, but on a
// pattern with no orientation a seam is only a place two patches meet, which is
// what the pattern is made of anyway.
//
// `position` and `normal` are flat XYZ arrays, and the result is a flat UV
// array. Non-indexed geometry only: it reads a triangle as three consecutive
// vertices, the way OBJ and the loaders that read it hand them over.
export function tileTankUVsByPosition(position, normal, unitsPerTile = CAMO_UNITS_PER_TILE) {
  const vertexCount = position.length / 3;
  const uv = new Float32Array(vertexCount * 2);
  const scale = 1 / (unitsPerTile || 1);

  for (let triangle = 0; triangle + 2 < vertexCount; triangle += 3) {
    // One axis for the whole triangle, from its summed normal. Choosing per
    // vertex would let a triangle's three corners be projected onto three
    // different planes, which does not produce a triangle of the texture at
    // all -- it produces a smear across it.
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let corner = 0; corner < 3; corner += 1) {
      const slot = (triangle + corner) * 3;
      nx += normal ? normal[slot] : 0;
      ny += normal ? normal[slot + 1] : 0;
      nz += normal ? normal[slot + 2] : 0;
    }
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);

    // Ties go to Y and then Z, which only decides which of two equally
    // side-on planes an exactly diagonal face lands on.
    let axis = 0;
    if (ay >= ax && ay >= az) axis = 1;
    else if (az >= ax && az >= ay) axis = 2;

    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = triangle + corner;
      const slot = vertex * 3;
      const x = position[slot];
      const y = position[slot + 1];
      const z = position[slot + 2];
      if (axis === 0) {
        uv[vertex * 2] = z * scale;
        uv[vertex * 2 + 1] = y * scale;
      } else if (axis === 1) {
        uv[vertex * 2] = x * scale;
        uv[vertex * 2 + 1] = z * scale;
      } else {
        uv[vertex * 2] = x * scale;
        uv[vertex * 2 + 1] = y * scale;
      }
    }
  }

  return uv;
}
