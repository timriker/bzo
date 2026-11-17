#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// A `drawInfo` block's `lines`, `linestrip`, `lineloop` and `points` reach the
// draw arrays as one flagged face per command, corners in order, beside the
// surface its `tris` state. Collision gets none of them. Delirious City
// (reri.sandybees.com:6019) draws its streets this way, from meshes with no
// faces at all; `bzo.bzw`'s spinning dodecahedron is the same thing small, and
// is checked here too.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { configureBzwParse, parseBZWMap } = require('../server/bzw-parse.cjs');
const {
  FACE_LINES, FACE_LINE_STRIP, FACE_LINE_LOOP, FACE_POINTS, FACE_NOT_SURFACE,
  decodeMeshArrays,
} = require('../public/js/mesh-arrays.mjs');

const MAP = `
material
  name glow
  diffuse 0 1 0 1
end
mesh
  drawinfo
    vertex 0 0 1
    vertex 10 0 1
    vertex 10 10 1
    vertex 0 10 1
    texcoord 0 0
    texcoord 1 0
    corner 0 0 0
    corner 1 0 1
    corner 2 0 0
    corner 3 0 1
    lod
      lengthPerPixel 0
      matref glow
        linestrip 0 1 2 3
        lineloop 0 1 2
        lines 0 2 1 3
        points 3
        tris 0 1 2
        linestrip 9 10
      end
    end
    lod
      lengthPerPixel 0.5
      matref glow
        points 0 1 2
      end
    end
  end
end
`;

configureBzwParse({ log: () => {}, gameConfigDefaults: {} });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzo-mesh-lines-'));
const file = path.join(dir, 'lines.bzw');
fs.writeFileSync(file, MAP);
const world = parseBZWMap(file, { quiet: true });
fs.rmSync(dir, { recursive: true, force: true });

const meshes = world.obstacles.filter((o) => o.type === 'mesh');
assert.equal(meshes.length, 1, 'a mesh with only a drawInfo block is kept');
const [mesh] = meshes;
assert.ok(mesh.drawArrays, 'its lines give it draw arrays');
assert.equal(decodeMeshArrays(mesh.arrays).faceCount, 0, 'collision gets no line, point or draw face');

const draw = decodeMeshArrays(mesh.drawArrays);
const faces = [];
for (let f = 0; f < draw.faceCount; f += 1) {
  faces.push({
    flags: draw.faceFlags[f] & FACE_NOT_SURFACE,
    corners: Array.from(draw.corners.subarray(draw.faceStart[f], draw.faceStart[f + 1])),
    texcoords: Array.from(draw.cornerTexcoord.subarray(draw.faceStart[f], draw.faceStart[f + 1])),
  });
}
assert.deepEqual(faces.map((face) => face.flags),
  [FACE_LINE_STRIP, FACE_LINE_LOOP, FACE_LINES, FACE_POINTS, 0],
  'one face per command of the first lod in map order, the triangle unflagged, a strip of missing corners dropped');
assert.deepEqual(faces[0].corners, [0, 1, 2, 3], 'a strip keeps its corners in order');
assert.deepEqual(faces[0].texcoords, [0, 1, 0, 1], 'and their texcoords, for a texture along the line');
assert.deepEqual(faces[2].corners, [0, 2, 1, 3], '`lines` keeps its pairs');
assert.deepEqual(faces[3].corners, [3], 'a single point is kept');

const bzo = parseBZWMap(new URL('../maps/bzo.bzw', import.meta.url).pathname, { quiet: true });
const dodecahedron = bzo.obstacles.find((o) => o.name === 'spin_dodecahedron');
assert.ok(dodecahedron, "bzo.bzw's spinning dodecahedron is a mesh");
assert.equal(decodeMeshArrays(dodecahedron.arrays).faceCount, 0, 'nothing collides with it');
assert.equal(dodecahedron.angvel, -30, 'it turns against the tank inside it');
const edges = decodeMeshArrays(dodecahedron.drawArrays);
assert.deepEqual(Array.from(edges.faceFlags, (flags) => flags & FACE_NOT_SURFACE), [FACE_LINES, FACE_POINTS],
  'its edges are one `lines` command and its vertices one `points`');
assert.equal(edges.faceStart[1], 60, 'thirty edges, two corners each');
assert.equal(edges.faceStart[2] - edges.faceStart[1], 20, 'twenty vertices');
const edgeMaterial = edges.materials[edges.faceMaterial[0]];
assert.ok(edgeMaterial.textureUrl && edgeMaterial.textureMatrix, 'its edges carry a scrolling texture');

console.log('mesh line tests passed');
