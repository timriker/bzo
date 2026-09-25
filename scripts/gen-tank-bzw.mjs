#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Turns `public/obj/tank.obj` -- BZFlag's own stock tank, which this repo
// already ships -- into the BZW `define` that `maps/bzo.bzw` places over the
// map centre. The point is the *form*: a mesh whose surface lives in a
// `drawInfo` block, which is how upstream writes a render-optimized model and
// the only place it reads `angvel` from. That makes the same text spin the
// same tank in a real bzflag client and in bzo.
//
// `tank.obj` is already in BZW's own frame -- X forward, Y left, Z up, base
// at z=0 -- so nothing is transformed here. Its origin at the tank's own
// footprint is what lets the `group` instance place the model by its
// underside rather than by some point inside it.
//
//   node scripts/gen-tank-bzw.mjs > /tmp/spintank.bzw
//
// Regenerate and paste over the `define SpinTank` block in maps/bzo.bzw.

import fs from 'node:fs';

const ANGVEL = 45;          // degrees/sec -- one turn every eight seconds
const INDICES_PER_LINE = 51; // what upstream's own exporter wraps `tris` at

const source = fs.readFileSync('public/obj/tank.obj', 'utf8');

const rawVerts = [];
const rawNorms = [];
const rawTxcds = [];
const rawFaces = [];

for (const line of source.split('\n')) {
  const parts = line.trim().split(/\s+/);
  if (parts[0] === 'v') rawVerts.push(parts.slice(1, 4).map(Number));
  else if (parts[0] === 'vn') rawNorms.push(parts.slice(1, 4).map(Number));
  else if (parts[0] === 'vt') rawTxcds.push(parts.slice(1, 3).map(Number));
  else if (parts[0] === 'f') {
    // `v/vt/vn`, one-based, as every OBJ exporter writes it.
    rawFaces.push(parts.slice(1).map((corner) => {
      const [v, t, n] = corner.split('/').map((index) => parseInt(index, 10) - 1);
      return { v, t, n };
    }));
  }
}

// An OBJ is an unindexed soup -- one vertex, normal and texcoord per corner,
// repeated wherever they are shared. BZW indexes all three, so each pool is
// reduced to its distinct entries first and the corner table put back on top.
function pool(entries, digits) {
  const out = [];
  const seen = new Map();
  const index = entries.map((entry) => {
    const key = entry.map((value) => value.toFixed(digits)).join(' ');
    if (!seen.has(key)) {
      seen.set(key, out.length);
      out.push(entry);
    }
    return seen.get(key);
  });
  return { out, index };
}

const verts = pool(rawVerts, 6);
const norms = pool(rawNorms, 6);
const txcds = pool(rawTxcds, 6);

// One corner per distinct (vertex, normal, texcoord) triple, which is exactly
// what `corner` means (`MeshDrawInfo.cxx:705-716`).
const corners = [];
const cornerIndex = new Map();
const tris = [];
for (const face of rawFaces) {
  for (const corner of face) {
    const triple = [verts.index[corner.v], norms.index[corner.n], txcds.index[corner.t]];
    const key = triple.join(' ');
    if (!cornerIndex.has(key)) {
      cornerIndex.set(key, corners.length);
      corners.push(triple);
    }
    tris.push(cornerIndex.get(key));
  }
}

const out = [];
out.push('define SpinTank');
out.push('  mesh');
out.push(`    # ${verts.out.length} vertices, ${norms.out.length} normals, `
  + `${txcds.out.length} texcoords, ${corners.length} corners, `
  + `${tris.length / 3} triangles`);
for (const [x, y, z] of verts.out) out.push(`    vertex ${x} ${y} ${z}`);
for (const [x, y, z] of norms.out) out.push(`    normal ${x} ${y} ${z}`);
for (const [u, v] of txcds.out) out.push(`    texcoord ${u} ${v}`);
out.push('    drawInfo');
out.push(`      angvel ${ANGVEL}`);
for (const [v, n, t] of corners) out.push(`      corner ${v} ${n} ${t}`);
out.push('      lod');
out.push('        matref Tank');
for (let i = 0; i < tris.length; i += INDICES_PER_LINE) {
  out.push(`          tris ${tris.slice(i, i + INDICES_PER_LINE).join(' ')}`);
}
out.push('        end');
out.push('      end');
out.push('    end');
out.push('  end');
out.push('enddef');

process.stdout.write(`${out.join('\n')}\n`);
