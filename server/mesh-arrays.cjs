/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// A mesh's collision geometry as flat typed arrays rather than an object per
// face (issue #153).
//
// A parsed face carries twenty-six properties and costs about 2,134 bytes;
// collision reads five of them. Counted over `public/js/collision.mjs` and
// `server/collision.cjs`: `plane` sixty-four times, `vertexIndices` eighteen,
// `edgePlanes` six, `shootThrough` twice and `phydrv` twice. Everything else
// on a face is for the renderer, which builds its own typed arrays from them
// anyway -- so the object graph exists to be walked once into the two things
// that actually read it.
//
// In these arrays the same geometry is 93 bytes a face:
// `ahs3_Paradise_Valley`, 79,872 faces over 54,567 vertices, is 7.1 MB here
// against 166 MB of heap parsed.
//
// Nothing reads this yet. It is built beside the object form and checked
// against it face for face (`scripts/test-mesh-arrays.mjs`), which is what
// makes moving collision onto it afterwards a change that can be verified
// rather than hoped about.

// What the renderer reads off a face that is not geometry: everything that
// decides which material it draws with, plus the alpha threshold the material
// keeps for its own texture callback. Deduped into a table per mesh the same
// way physics drivers are, because a mesh of eighty thousand faces has a
// handful of materials -- and holding them as a table is what lets the faces
// themselves stop being objects.
const MATERIAL_FIELDS = [
  'texture', 'textureUrl', 'color', 'dynamicColor', 'textureMatrix',
  'specular', 'shininess', 'emission', 'alphaThreshold',
  'noSorting', 'useTextureAlpha', 'useColorOnTexture', 'noCulling',
];

// Two faces share a material when every one of those fields matches. The
// renderer builds its own key for the same purpose (`_buildMeshObject`) and
// this has to agree with it, or a map would draw with the wrong number of
// materials.
//
// A `dyncol` or `texmat` is an object, and it is compared by *contents*, not
// by reference. The parser hands the same object to every face naming it, so
// reference would work in memory -- but a world that has been through JSON
// gives each occurrence an object of its own, and the same mesh would then
// dedupe into a different number of materials depending on where it came
// from. Two animations stated identically are the same animation, so merging
// them is right as well as stable.
function materialKey(face, objectIds) {
  const parts = [];
  for (const field of MATERIAL_FIELDS) {
    const value = face[field];
    if (value === undefined || value === null) {
      parts.push('');
    } else if (Array.isArray(value)) {
      parts.push(value.join(','));
    } else if (typeof value === 'object') {
      let id = objectIds.get(value);
      if (id === undefined) {
        id = JSON.stringify(value);
        objectIds.set(value, id);
      }
      parts.push(id);
    } else {
      parts.push(String(value));
    }
  }
  return parts.join('|');
}

// `shootThrough` and `driveThrough` are the two a face carries for itself.
// Bits rather than a byte apiece: they are read together and there will be
// more of them.
const FACE_SHOOT_THROUGH = 1;
const FACE_DRIVE_THROUGH = 2;
// A material's `noradar` keeps a face off the panel. Not collision's business
// but the radar's, and it belongs with the other per-face bits rather than
// making the radar reach for a face object to read one flag.
const FACE_NO_RADAR = 4;

// A face with no physics driver. Every distinct driver on a mesh goes in a
// table beside the arrays and is named here by its index, since a map has a
// handful of drivers and tens of thousands of faces.
const NO_PHYDRV = -1;

// A corner whose face stated no normal or no texcoord of its own.
const NO_INDEX = -1;

// One mesh's geometry. `faceStart` is a prefix over corners, so face `i` owns
// corners `faceStart[i]` up to `faceStart[i + 1]` -- which is why it holds one
// more entry than there are faces, and why a face's corner count never needs
// storing. `edgePlanes` is aligned with `corners`: a face's edge planes are
// that same span, one per corner, each the plane through that edge.
function buildMeshArrays(mesh) {
  const faces = Array.isArray(mesh.faces) ? mesh.faces : [];
  const vertices = Array.isArray(mesh.vertices) ? mesh.vertices : [];

  let cornerCount = 0;
  for (const face of faces) cornerCount += face.vertexIndices.length;

  const normals = Array.isArray(mesh.normals) ? mesh.normals : [];
  const texcoords = Array.isArray(mesh.texcoords) ? mesh.texcoords : [];

  const out = {
    vertices: new Float32Array(vertices.length * 3),
    faceCount: faces.length,
    faceStart: new Uint32Array(faces.length + 1),
    corners: new Uint32Array(cornerCount),
    facePlanes: new Float32Array(faces.length * 4),
    edgePlanes: new Float32Array(cornerCount * 4),
    faceFlags: new Uint8Array(faces.length),
    facePhydrv: new Int32Array(faces.length),
    phydrvs: [],
    // The renderer's half. A face states its own normals and texcoords only
    // sometimes -- `NO_INDEX` is "this face said nothing", which is what
    // makes the renderer fall back to a flat normal and a planar projection.
    normals: new Float32Array(normals.length * 3),
    texcoords: new Float32Array(texcoords.length * 2),
    cornerNormal: new Int32Array(cornerCount),
    cornerTexcoord: new Int32Array(cornerCount),
    faceMaterial: new Int32Array(faces.length),
    materials: [],
  };

  for (let n = 0; n < normals.length; n += 1) {
    const normal = normals[n];
    out.normals[n * 3] = normal.x;
    out.normals[(n * 3) + 1] = normal.y;
    out.normals[(n * 3) + 2] = normal.z;
  }
  for (let t = 0; t < texcoords.length; t += 1) {
    const texcoord = texcoords[t];
    out.texcoords[t * 2] = texcoord.u;
    out.texcoords[(t * 2) + 1] = texcoord.v;
  }

  for (let v = 0; v < vertices.length; v += 1) {
    const vertex = vertices[v];
    out.vertices[v * 3] = vertex.x;
    out.vertices[(v * 3) + 1] = vertex.y;
    out.vertices[(v * 3) + 2] = vertex.z;
  }

  // Contents, not identity: the parser hands every face of one driver the
  // same object, but a world that has been through JSON gives each face an
  // object of its own -- and a mesh has to dedupe to the same table whichever
  // it was built from, or the two sides of the wire disagree. Two drivers
  // stated identically are one driver.
  const phydrvIndex = new Map();
  const phydrvKeys = new Map();
  const materialIndex = new Map();
  const objectIds = new Map();
  let corner = 0;
  for (let f = 0; f < faces.length; f += 1) {
    const face = faces[f];
    out.faceStart[f] = corner;

    const plane = face.plane || [0, 0, 0, 0];
    out.facePlanes[f * 4] = plane[0];
    out.facePlanes[(f * 4) + 1] = plane[1];
    out.facePlanes[(f * 4) + 2] = plane[2];
    out.facePlanes[(f * 4) + 3] = plane[3];

    let flags = 0;
    if (face.shootThrough) flags |= FACE_SHOOT_THROUGH;
    if (face.driveThrough) flags |= FACE_DRIVE_THROUGH;
    if (face.noRadar) flags |= FACE_NO_RADAR;
    out.faceFlags[f] = flags;

    if (face.phydrv) {
      let key = phydrvKeys.get(face.phydrv);
      if (key === undefined) {
        key = JSON.stringify(face.phydrv);
        phydrvKeys.set(face.phydrv, key);
      }
      let index = phydrvIndex.get(key);
      if (index === undefined) {
        index = out.phydrvs.length;
        out.phydrvs.push(face.phydrv);
        phydrvIndex.set(key, index);
      }
      out.facePhydrv[f] = index;
    } else {
      out.facePhydrv[f] = NO_PHYDRV;
    }

    const key = materialKey(face, objectIds);
    let material = materialIndex.get(key);
    if (material === undefined) {
      material = out.materials.length;
      const descriptor = {};
      for (const field of MATERIAL_FIELDS) descriptor[field] = face[field];
      out.materials.push(descriptor);
      materialIndex.set(key, material);
    }
    out.faceMaterial[f] = material;

    // A face states normals and texcoords for all of its corners or for none
    // of them, which is the test the renderer already makes before using
    // either -- so a face that states a partial set is read as stating none.
    const faceNormals = Array.isArray(face.normalIndices)
      && face.normalIndices.length === face.vertexIndices.length ? face.normalIndices : null;
    const faceTexcoords = Array.isArray(face.texcoordIndices)
      && face.texcoordIndices.length === face.vertexIndices.length ? face.texcoordIndices : null;

    const edges = face.edgePlanes || [];
    for (let c = 0; c < face.vertexIndices.length; c += 1) {
      out.corners[corner] = face.vertexIndices[c];
      out.cornerNormal[corner] = faceNormals ? faceNormals[c] : NO_INDEX;
      out.cornerTexcoord[corner] = faceTexcoords ? faceTexcoords[c] : NO_INDEX;
      const edge = edges[c] || [0, 0, 0, 0];
      out.edgePlanes[corner * 4] = edge[0];
      out.edgePlanes[(corner * 4) + 1] = edge[1];
      out.edgePlanes[(corner * 4) + 2] = edge[2];
      out.edgePlanes[(corner * 4) + 3] = edge[3];
      corner += 1;
    }
  }
  out.faceStart[faces.length] = corner;
  return out;
}

// The arrays for one mesh, built on first ask and kept for as long as the
// mesh is. A `WeakMap` rather than a field on the obstacle: a mesh arriving
// from the world JSON is plain data the client and the server both hold, and
// nothing that reads it should have to know whether its arrays were built
// yet. Collision asks for these on a hot path, so the miss happens once per
// mesh per process and never again.
const arraysByMesh = new WeakMap();

function meshArrays(mesh) {
  let arrays = arraysByMesh.get(mesh);
  if (arrays === undefined) {
    // What the world already carries, where it carries it -- a map built by a
    // server that sends its meshes as arrays needs no second pass to rebuild
    // what it was just handed. A mesh assembled in a test, or one from a
    // server that sends only faces, is built from those instead.
    arrays = mesh.arrays ? decodeMeshArrays(mesh.arrays) : buildMeshArrays(mesh);
    arraysByMesh.set(mesh, arrays);
  }
  return arrays;
}

// The arrays the *renderer* wants, which are not always the collision ones: a
// mesh carrying a `drawInfo` block states a second, separate geometry to draw
// -- every tank model in `RatsNest.bzw` states only that one -- and drawing
// the collision faces instead would draw the wrong shape, or nothing at all.
// A mesh without one draws its collision faces, so the two are the same
// arrays and the same cache entry.
const drawArraysByMesh = new WeakMap();

function meshDrawArrays(mesh) {
  let arrays = drawArraysByMesh.get(mesh);
  if (arrays !== undefined) return arrays;
  // Decoded ahead of the `drawFaces` check, not after it: the wire carries
  // the arrays, and the face objects they were built from need not come with
  // them.
  if (mesh.drawArrays) {
    arrays = decodeMeshArrays(mesh.drawArrays);
    drawArraysByMesh.set(mesh, arrays);
    return arrays;
  }
  // The face list alone says whether there is a separate geometry to draw.
  // Its vertices, normals and texcoords are the mesh's own unless `drawInfo`
  // stated its own -- `bzo.bzw`'s spinning tank states 274 draw faces and no
  // draw vertices, indexing the 174 the mesh already has.
  if (!Array.isArray(mesh.drawFaces) || mesh.drawFaces.length === 0) return meshArrays(mesh);
  const pick = (drawList, ownList) => (Array.isArray(drawList) && drawList.length > 0
    ? drawList : (ownList || []));
  arrays = buildMeshArrays({
    vertices: pick(mesh.drawVertices, mesh.vertices),
    normals: pick(mesh.drawNormals, mesh.normals),
    texcoords: pick(mesh.drawTexcoords, mesh.texcoords),
    faces: mesh.drawFaces,
  });
  drawArraysByMesh.set(mesh, arrays);
  return arrays;
}

// ---------------------------------------------------------------------------
// Over the wire
//
// The world JSON is JSON, and a typed array is not, so each one travels as
// base64 of its own bytes -- about a third larger than the bytes and far
// smaller than the numbers spelled out, which is what a plain JSON array
// would cost. Brotli takes most of that third back.
//
// `Buffer` where there is one and a hand-rolled pass where there is not: this
// file is one of the client/server pairs, compared line for line, so it
// cannot branch on which side it is running.

// `Buffer` exists only on the server and `atob` only in the browser, and each
// use below is guarded by the check for the one it needs -- so both are named
// here rather than splitting this file, which is one of the pairs compared
// line for line.
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/* eslint-disable no-undef -- `Buffer` is the server's and `atob` the
   browser's, and each use is guarded by the check for the one it needs. This
   file is one of the pairs compared line for line, so it cannot be split. */
function bytesToBase64(view) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += BASE64_ALPHABET[a >> 2];
    out += BASE64_ALPHABET[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? BASE64_ALPHABET[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? BASE64_ALPHABET[c & 63] : '=';
  }
  return out;
}

function base64ToBytes(text) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(text, 'base64'));
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
/* eslint-enable no-undef */

// Which typed array each field is, so one table drives both directions and
// they cannot disagree about a field's width.
const ARRAY_FIELDS = [
  ['vertices', Float32Array],
  ['faceStart', Uint32Array],
  ['corners', Uint32Array],
  ['facePlanes', Float32Array],
  ['edgePlanes', Float32Array],
  ['faceFlags', Uint8Array],
  ['facePhydrv', Int32Array],
  ['normals', Float32Array],
  ['texcoords', Float32Array],
  ['cornerNormal', Int32Array],
  ['cornerTexcoord', Int32Array],
  ['faceMaterial', Int32Array],
];

function encodeMeshArrays(arrays) {
  const encoded = { faceCount: arrays.faceCount, phydrvs: arrays.phydrvs, materials: arrays.materials };
  for (const [field] of ARRAY_FIELDS) encoded[field] = bytesToBase64(arrays[field]);
  return encoded;
}

function decodeMeshArrays(encoded) {
  const arrays = {
    faceCount: encoded.faceCount,
    phydrvs: encoded.phydrvs || [],
    materials: encoded.materials || [],
  };
  for (const [field, Type] of ARRAY_FIELDS) {
    const bytes = base64ToBytes(encoded[field] || '');
    // A copy rather than a view over the decoded bytes: base64 decoding gives
    // no alignment guarantee, and a `Float32Array` over an odd offset throws.
    arrays[field] = new Type(bytes.buffer.slice(
      bytes.byteOffset, bytes.byteOffset + bytes.byteLength,
    ));
  }
  return arrays;
}

// How many bytes the arrays occupy, for measuring against the object form
// they replace. The driver table is not counted: it is a handful of entries
// a map over, and it stays objects either way.
function meshArrayBytes(arrays) {
  return arrays.vertices.byteLength
    + arrays.faceStart.byteLength
    + arrays.corners.byteLength
    + arrays.facePlanes.byteLength
    + arrays.edgePlanes.byteLength
    + arrays.faceFlags.byteLength
    + arrays.facePhydrv.byteLength
    + arrays.normals.byteLength
    + arrays.texcoords.byteLength
    + arrays.cornerNormal.byteLength
    + arrays.cornerTexcoord.byteLength
    + arrays.faceMaterial.byteLength;
}
module.exports = {
  NO_INDEX,
  buildMeshArrays,
  decodeMeshArrays,
  encodeMeshArrays,
  meshArrays,
  meshDrawArrays,
  meshArrayBytes,
  FACE_SHOOT_THROUGH,
  FACE_NO_RADAR,
  FACE_DRIVE_THROUGH,
  NO_PHYDRV,
};
