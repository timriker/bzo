/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// `public/js/mesh-arrays.mjs` against the object form it replaced (issue #153).
//
// A hand-built mesh, covering every field with values chosen to be wrong in
// an obvious way if they land in the wrong slot. It states its own faces, so
// it is the one place left that can check an array against the object it was
// built from -- a cached world carries no faces at all now, the arrays being
// the whole of what a mesh is. What those worlds are checked for here is the
// codec: every mesh decoded and re-encoded, which has to come back byte for
// byte or a world does not survive its own round trip.
//
// That a real map's arrays describe the right *shape* is answered by driving
// them -- `test-collision.mjs` and `test-mesh-seams.mjs` both run against
// named geometry in `bzo.bzw` and `hix.bzw` -- rather than by comparing them
// to a stored copy.
//
// The built mesh is what makes this a test on a fresh checkout: the cache is
// written by a server that has actually run, and `check:boot` writes its own
// to a temporary directory, so CI reaches here with nothing cached at all.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  buildMeshArrays, decodeMeshArrays, encodeMeshArrays, meshArrayBytes,
  FACE_SHOOT_THROUGH, FACE_DRIVE_THROUGH, FACE_NO_RADAR, NO_PHYDRV, NO_INDEX,
} = require('../public/js/mesh-arrays.mjs');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// `Float32Array` keeps about seven significant digits, and a plane's distance
// term runs to the world's own size -- so the comparison is relative to the
// magnitude rather than absolute. A coordinate 500 units out lands within
// about 6e-5 of itself, which is four orders finer than anything collision
// resolves.
const RELATIVE_EPSILON = 1e-6;

function close(a, b) {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= RELATIVE_EPSILON * scale;
}

let checkedMaps = 0;
let checkedFaces = 0;
let arrayBytes = 0;
let decodedMeshes = 0;
const failures = [];

function checkMesh(label, mesh) {
  const arrays = buildMeshArrays(mesh);
  arrayBytes += meshArrayBytes(arrays);

  // A world that carries its meshes as arrays has to decode to exactly what
  // building them here gives, or the two sides of the wire disagree about the
  // geometry -- which is the whole risk of sending them at all.
  if (mesh.arrays) {
    decodedMeshes += 1;
    const decoded = decodeMeshArrays(mesh.arrays);
    if (decoded.faceCount !== arrays.faceCount) {
      failures.push(`${label}: decoded ${decoded.faceCount} faces, built ${arrays.faceCount}`);
      return;
    }
    for (const field of [
      'vertices', 'faceStart', 'corners', 'facePlanes', 'edgePlanes', 'faceFlags',
      'facePhydrv', 'normals', 'texcoords', 'cornerNormal', 'cornerTexcoord', 'faceMaterial',
    ]) {
      if (decoded[field].length !== arrays[field].length) {
        failures.push(`${label}: decoded ${field} is ${decoded[field].length} long, built ${arrays[field].length}`);
        return;
      }
      for (let i = 0; i < arrays[field].length; i += 1) {
        if (decoded[field][i] !== arrays[field][i]) {
          failures.push(`${label}: decoded ${field}[${i}] is ${decoded[field][i]}, built ${arrays[field][i]}`);
          return;
        }
      }
    }
  }

  for (let v = 0; v < mesh.vertices.length; v += 1) {
    const vertex = mesh.vertices[v];
    for (const [axis, offset] of [['x', 0], ['y', 1], ['z', 2]]) {
      if (!close(arrays.vertices[(v * 3) + offset], vertex[axis])) {
        failures.push(`${label}: vertex ${v}.${axis} is ${arrays.vertices[(v * 3) + offset]}, not ${vertex[axis]}`);
        return;
      }
    }
  }

  for (let f = 0; f < mesh.faces.length; f += 1) {
    const face = mesh.faces[f];
    checkedFaces += 1;

    const plane = face.plane || [0, 0, 0, 0];
    for (let i = 0; i < 4; i += 1) {
      if (!close(arrays.facePlanes[(f * 4) + i], plane[i])) {
        failures.push(`${label}: face ${f} plane[${i}] is ${arrays.facePlanes[(f * 4) + i]}, not ${plane[i]}`);
        return;
      }
    }

    const start = arrays.faceStart[f];
    const end = arrays.faceStart[f + 1];
    if (end - start !== face.vertexIndices.length) {
      failures.push(`${label}: face ${f} has ${end - start} corners, not ${face.vertexIndices.length}`);
      return;
    }
    for (let c = 0; c < face.vertexIndices.length; c += 1) {
      if (arrays.corners[start + c] !== face.vertexIndices[c]) {
        failures.push(`${label}: face ${f} corner ${c} is ${arrays.corners[start + c]}, not ${face.vertexIndices[c]}`);
        return;
      }
      const edge = (face.edgePlanes || [])[c] || [0, 0, 0, 0];
      for (let i = 0; i < 4; i += 1) {
        const got = arrays.edgePlanes[((start + c) * 4) + i];
        if (!close(got, edge[i])) {
          failures.push(`${label}: face ${f} edge ${c} plane[${i}] is ${got}, not ${edge[i]}`);
          return;
        }
      }
    }

    const shoot = (arrays.faceFlags[f] & FACE_SHOOT_THROUGH) !== 0;
    const drive = (arrays.faceFlags[f] & FACE_DRIVE_THROUGH) !== 0;
    const noRadar = (arrays.faceFlags[f] & FACE_NO_RADAR) !== 0;
    if (shoot !== !!face.shootThrough || drive !== !!face.driveThrough
      || noRadar !== !!face.noRadar) {
      failures.push(`${label}: face ${f} flags are shoot=${shoot} drive=${drive} noradar=${noRadar}`);
      return;
    }

    const phydrv = arrays.facePhydrv[f] === NO_PHYDRV
      ? null : arrays.phydrvs[arrays.facePhydrv[f]];
    if (JSON.stringify(phydrv ?? null) !== JSON.stringify(face.phydrv ?? null)) {
      failures.push(`${label}: face ${f} names the wrong physics driver`);
      return;
    }

    // The renderer's half: the corner normals and texcoords a face states,
    // and the material it draws with.
    const stated = (list) => (Array.isArray(list) && list.length === face.vertexIndices.length
      ? list : null);
    const faceNormals = stated(face.normalIndices);
    const faceTexcoords = stated(face.texcoordIndices);
    for (let c = 0; c < face.vertexIndices.length; c += 1) {
      const wantNormal = faceNormals ? faceNormals[c] : NO_INDEX;
      const wantTexcoord = faceTexcoords ? faceTexcoords[c] : NO_INDEX;
      if (arrays.cornerNormal[start + c] !== wantNormal
        || arrays.cornerTexcoord[start + c] !== wantTexcoord) {
        failures.push(`${label}: face ${f} corner ${c} points at the wrong normal or texcoord`);
        return;
      }
    }
    const material = arrays.materials[arrays.faceMaterial[f]];
    if (!material) {
      failures.push(`${label}: face ${f} names no material`);
      return;
    }
    for (const [field, value] of Object.entries(material)) {
      const want = face[field];
      // Object fields are compared by contents, which is how the material
      // table dedupes them -- the descriptor holds the first face's own
      // object, and another face sharing that material states an equal one
      // rather than the same one once a world has been through JSON.
      const same = value !== null && typeof value === 'object'
        ? JSON.stringify(value) === JSON.stringify(want)
        : value === want;
      if (!same) {
        failures.push(`${label}: face ${f} material ${field} differs`);
        return;
      }
    }
  }
}

// A cached world's meshes, through the codec and back. Templates as well as
// obstacles: the client draws those without their ever appearing in the
// obstacle list, so an encoding fault there would be just as visible.
function roundTrip(label, mesh) {
  for (const field of ['arrays', 'drawArrays']) {
    const encoded = mesh[field];
    if (!encoded) continue;
    decodedMeshes += 1;
    const arrays = decodeMeshArrays(encoded);
    checkedFaces += arrays.faceCount;
    arrayBytes += meshArrayBytes(arrays);
    const again = encodeMeshArrays(arrays);
    for (const key of Object.keys(encoded)) {
      if (JSON.stringify(again[key]) !== JSON.stringify(encoded[key])) {
        failures.push(`${label} ${field}: ${key} changed through a decode and encode`);
        return;
      }
    }
  }
}

function checkWorld(label, world) {
  const meshes = [
    ...(world.obstacles || []).filter((obstacle) => obstacle.type === 'mesh'),
    ...Object.values(world.meshTemplates || {}).flat(),
  ].filter((mesh) => mesh && mesh.arrays);
  if (meshes.length === 0) return;
  checkedMaps += 1;
  meshes.forEach((mesh, i) => roundTrip(`${label} mesh ${i}`, mesh));
}

// Two faces sharing one physics driver and a third with none; a quad and two
// triangles, so the corner spans differ; flags in both combinations.
const BUILT = {
  vertices: [
    { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 0, z: 10 },
    { x: 0, y: 0, z: 10 }, { x: 5, y: 7.5, z: 5 },
  ],
  faces: [
    {
      vertexIndices: [0, 1, 2, 3],
      plane: [0, 1, 0, -0.5],
      edgePlanes: [[1, 0, 0, -1], [0, 0, 1, -2], [-1, 0, 0, -3], [0, 0, -1, -4]],
      shootThrough: false,
      driveThrough: false,
      phydrv: null,
      texture: 'boxwall',
      color: [1, 0, 0, 1],
    },
    {
      vertexIndices: [0, 1, 4],
      plane: [0, -0.6, 0.8, -123.5],
      edgePlanes: [[1, 0, 0, -5], [0, 1, 0, -6], [0, 0, 1, -7]],
      shootThrough: true,
      driveThrough: false,
      phydrv: { name: 'conveyor', linear: [0, -5, -33], death: null },
    },
    {
      vertexIndices: [2, 3, 4],
      plane: [0.8, 0, -0.6, 456.25],
      edgePlanes: [[0, 1, 0, -8], [0, 0, 1, -9], [1, 0, 0, -10]],
      shootThrough: true,
      driveThrough: true,
      phydrv: null,
    },
  ],
};
// The same object on two faces, which is how the parser hands a named driver
// out -- the table should hold one entry, not two.
BUILT.faces[2].phydrv = BUILT.faces[1].phydrv;
checkMesh('built mesh', BUILT);
checkedMaps += 1;
{
  const arrays = buildMeshArrays(BUILT);
  if (arrays.phydrvs.length !== 1) {
    failures.push(`built mesh: one driver on two faces became ${arrays.phydrvs.length} entries`);
  }
  if (arrays.faceStart[3] !== 10) {
    failures.push(`built mesh: corners total ${arrays.faceStart[3]}, not 10`);
  }
  // Three faces, and the two sharing every material field share an entry.
  if (arrays.materials.length !== 2) {
    failures.push(`built mesh: three faces made ${arrays.materials.length} materials, not 2`);
  }
}

const cacheDir = path.join(root, 'cache', 'maps');
let files = [];
try {
  files = fs.readdirSync(cacheDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(cacheDir, name))
    .sort((a, b) => fs.statSync(a).size - fs.statSync(b).size);
} catch {
  files = [];
}

for (const file of files) {
  let world;
  try {
    world = JSON.parse(fs.readFileSync(file));
  } catch {
    continue;
  }
  checkWorld(path.basename(file), world);
  if (failures.length) break;
}

if (failures.length) {
  for (const failure of failures.slice(0, 5)) console.error(`  ${failure}`);
  console.error(`test-mesh-arrays: ${failures.length} disagreement(s)`);
  process.exit(1);
}

console.log(`test-mesh-arrays: ${checkedFaces} faces over ${checkedMaps} world(s) agree`
  + `, ${(arrayBytes / 1048576).toFixed(1)}MB of arrays`
  + `, ${decodedMeshes} mesh(es) survived a round trip`);
