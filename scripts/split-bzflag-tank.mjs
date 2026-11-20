#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Read directly from the upstream BZFlag tank.obj (BZFlag misc/tank.obj).
// Coord system of tank.obj: +X = toward muzzle (front), +Y = left, +Z = up.
// Target coord system for Three.js: +X = left, +Y = up, +Z = toward rear.
// Combined rotation: (x, y, z) -> (-y, z, -x)
const inputPath = resolve(__dirname, '../src/tank.obj');
const outputPath = resolve(__dirname, '../public/obj/bzflag-notracks.obj');
const defaultTankPath = resolve(__dirname, '../public/obj/modern.obj');

const src = readFileSync(inputPath, 'utf-8').split(/\r?\n/);

const vertices = [];
const texcoords = [];
const normals = [];

let currentGroup = null;
const facesByGroup = new Map();

function parseObjByObject(filePath) {
  const lines = readFileSync(filePath, 'utf-8').split(/\r?\n/);
  const parsed = {
    vertices: [],
    texcoords: [],
    normals: [],
    faceEntriesByObject: new Map(),
  };

  let currentObject = null;
  let currentGroup = null;
  let currentMaterial = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('v ')) {
      const [, xs, ys, zs] = line.split(/\s+/);
      parsed.vertices.push([Number(xs), Number(ys), Number(zs)]);
      continue;
    }

    if (line.startsWith('vt ')) {
      const [, us, vs] = line.split(/\s+/);
      parsed.texcoords.push([Number(us), Number(vs)]);
      continue;
    }

    if (line.startsWith('vn ')) {
      const [, xs, ys, zs] = line.split(/\s+/);
      parsed.normals.push([Number(xs), Number(ys), Number(zs)]);
      continue;
    }

    if (line.startsWith('o ')) {
      currentObject = line.split(/\s+/)[1];
      if (!parsed.faceEntriesByObject.has(currentObject)) parsed.faceEntriesByObject.set(currentObject, []);
      continue;
    }

    if (line.startsWith('g ')) {
      currentGroup = line.split(/\s+/)[1];
      if (!currentObject && !parsed.faceEntriesByObject.has(currentGroup)) parsed.faceEntriesByObject.set(currentGroup, []);
      continue;
    }

    if (line.startsWith('usemtl ')) {
      currentMaterial = line.split(/\s+/)[1] || null;
      continue;
    }

    if (line.startsWith('f ')) {
      const key = currentObject || currentGroup;
      if (!key) continue;
      if (!parsed.faceEntriesByObject.has(key)) parsed.faceEntriesByObject.set(key, []);
      const refs = line.split(/\s+/).slice(1).map((token) => {
        const [v, vt, vn] = token.split('/').map((part) => Number(part));
        return { v, vt, vn };
      });
      parsed.faceEntriesByObject.get(key).push({ refs, material: currentMaterial });
    }
  }

  return parsed;
}

function buildSequentialFaces(startIndex, endIndex) {
  const faces = [];
  for (let i = startIndex; i <= endIndex; i += 3) {
    faces.push([
      { v: i, vt: i, vn: i },
      { v: i + 1, vt: i + 1, vn: i + 1 },
      { v: i + 2, vt: i + 2, vn: i + 2 },
    ]);
  }
  return faces;
}

function pickFaces(groupNames, fallbackRange = null) {
  for (const groupName of groupNames) {
    const faces = facesByGroup.get(groupName);
    if (faces && faces.length > 0) return faces;
  }
  if (fallbackRange) {
    const [startIndex, endIndex] = fallbackRange;
    return buildSequentialFaces(startIndex, endIndex);
  }
  return [];
}

for (const rawLine of src) {
  const line = rawLine.trim();
  if (!line) continue;

  if (line.startsWith('v ')) {
    const [, xs, ys, zs] = line.split(/\s+/);
    vertices.push([Number(xs), Number(ys), Number(zs)]);
    continue;
  }

  if (line.startsWith('vt ')) {
    const [, us, vs] = line.split(/\s+/);
    texcoords.push([Number(us), Number(vs)]);
    continue;
  }

  if (line.startsWith('vn ')) {
    const [, xs, ys, zs] = line.split(/\s+/);
    normals.push([Number(xs), Number(ys), Number(zs)]);
    continue;
  }

  if (line.startsWith('g ')) {
    currentGroup = line.split(/\s+/)[1];
    if (!facesByGroup.has(currentGroup)) facesByGroup.set(currentGroup, []);
    continue;
  }

  if (line.startsWith('f ')) {
    if (!currentGroup) continue;
    const refs = line.split(/\s+/).slice(1).map((token) => {
      const [v, vt, vn] = token.split('/').map((part) => Number(part));
      return { v, vt, vn };
    });
    facesByGroup.get(currentGroup).push(refs);
  }
}

const rotateVertex = ([x, y, z]) => {
  // tank.obj: +X=front, +Y=left, +Z=up -> Three.js: +X=left, +Y=up, +Z=rear
  // Rotation: -90deg about Z then +90deg about X. Combined: (x,y,z) -> (-y, z, -x)
  return [-y, z, -x];
};

const rotateNormal = ([x, y, z]) => {
  return [-y, z, -x];
};

const rotatedVertices = vertices.map(rotateVertex);
const rotatedNormals = normals.map(rotateNormal);

// tank.obj body group contains only the main hull — all faces go directly to bodyMainFaces.
const bodyMainFaces = pickFaces(['body']);

const outputVertices = [...rotatedVertices];
const outputTexcoords = [...texcoords];
const outputNormals = [...rotatedNormals];

const defaultObj = parseObjByObject(defaultTankPath);

function wrapFaces(faceList, material = null) {
  return faceList.map((refs) => ({ refs, material }));
}

function importObjectFaces(parsedObj, objectName) {
  const sourceEntries = parsedObj.faceEntriesByObject.get(objectName) || [];
  if (!sourceEntries.length) return [];

  const vMap = new Map();
  const vtMap = new Map();
  const vnMap = new Map();

  const mapVertex = (sourceIndex) => {
    if (!sourceIndex) return 0;
    if (!vMap.has(sourceIndex)) {
      outputVertices.push(parsedObj.vertices[sourceIndex - 1]);
      vMap.set(sourceIndex, outputVertices.length);
    }
    return vMap.get(sourceIndex);
  };

  const mapTexcoord = (sourceIndex) => {
    if (!sourceIndex) {
      outputTexcoords.push([0, 0]);
      return outputTexcoords.length;
    }
    if (!vtMap.has(sourceIndex)) {
      outputTexcoords.push(parsedObj.texcoords[sourceIndex - 1]);
      vtMap.set(sourceIndex, outputTexcoords.length);
    }
    return vtMap.get(sourceIndex);
  };

  const mapNormal = (sourceIndex) => {
    if (!sourceIndex) {
      outputNormals.push([0, 1, 0]);
      return outputNormals.length;
    }
    if (!vnMap.has(sourceIndex)) {
      outputNormals.push(parsedObj.normals[sourceIndex - 1]);
      vnMap.set(sourceIndex, outputNormals.length);
    }
    return vnMap.get(sourceIndex);
  };

  return sourceEntries.map((entry) => ({
    material: entry.material || null,
    refs: entry.refs.map((ref) => ({
      v: mapVertex(ref.v),
      vt: mapTexcoord(ref.vt),
      vn: mapNormal(ref.vn),
    })),
  }));
}

function addFlatBodySideFaces() {
  if (!bodyMainFaces.length) return;

  const usedVertexIndices = new Set();
  for (const face of bodyMainFaces) {
    for (const ref of face) {
      usedVertexIndices.add(ref.v - 1);
    }
  }

  const usedVertices = Array.from(usedVertexIndices).map((index) => outputVertices[index]);
  if (!usedVertices.length) return;

  const xs = usedVertices.map((v) => v[0]);
  const ys = usedVertices.map((v) => v[1]);
  const zs = usedVertices.map((v) => v[2]);

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);

  const cross = (origin, a, b) => ((a[0] - origin[0]) * (b[1] - origin[1])) - ((a[1] - origin[1]) * (b[0] - origin[0]));
  const computeFaceNormal = (a, b, c) => {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    return [
      (ab[1] * ac[2]) - (ab[2] * ac[1]),
      (ab[2] * ac[0]) - (ab[0] * ac[2]),
      (ab[0] * ac[1]) - (ab[1] * ac[0]),
    ];
  };
  const dot = (left, right) => (left[0] * right[0]) + (left[1] * right[1]) + (left[2] * right[2]);
  const buildConvexHull = (points2D) => {
    const sorted = [...points2D].sort((left, right) => {
      if (left[0] !== right[0]) return left[0] - right[0];
      return left[1] - right[1];
    });
    if (sorted.length <= 2) return sorted;

    const lower = [];
    for (const point of sorted) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
        lower.pop();
      }
      lower.push(point);
    }

    const upper = [];
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      const point = sorted[index];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
        upper.pop();
      }
      upper.push(point);
    }

    lower.pop();
    upper.pop();
    return lower.concat(upper);
  };

  const findDominantSidePlaneX = (sign) => {
    const counts = new Map();
    for (const vertexIndex of usedVertexIndices) {
      const [x] = outputVertices[vertexIndex];
      if ((sign < 0 && x >= 0) || (sign > 0 && x <= 0)) continue;
      const key = x.toFixed(3);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let bestKey = null;
    let bestCount = -1;
    for (const [key, count] of counts.entries()) {
      if (count > bestCount) {
        bestCount = count;
        bestKey = key;
      }
    }
    if (bestKey === null) return sign < 0 ? minX : maxX;
    return Number(bestKey);
  };

  const appendContourCap = (planeX, normal) => {
    const sideIndices = [];
    const epsilon = 0.0015;
    for (const vertexIndex of usedVertexIndices) {
      const [x] = outputVertices[vertexIndex];
      if (Math.abs(x - planeX) <= epsilon) {
        sideIndices.push(vertexIndex);
      }
    }
    if (sideIndices.length < 3) return;

    const uniqueByYZ = new Map();
    for (const vertexIndex of sideIndices) {
      const [, y, z] = outputVertices[vertexIndex];
      const key = `${y.toFixed(6)}:${z.toFixed(6)}`;
      if (!uniqueByYZ.has(key)) {
        uniqueByYZ.set(key, { yz: [y, z], vertexIndex });
      }
    }

    const contourSeeds = Array.from(uniqueByYZ.values()).map((entry) => entry.yz);
    const hull = buildConvexHull(contourSeeds);
    if (hull.length < 3) return;

    const contourVertexIndices = hull.map(([y, z]) => {
      const key = `${y.toFixed(6)}:${z.toFixed(6)}`;
      return uniqueByYZ.get(key).vertexIndex + 1;
    });

    outputNormals.push(normal);
    const vnIndex = outputNormals.length;

    for (let i = 1; i < contourVertexIndices.length - 1; i += 1) {
      const tri = [contourVertexIndices[0], contourVertexIndices[i], contourVertexIndices[i + 1]];

      const a = outputVertices[tri[0] - 1];
      const b = outputVertices[tri[1] - 1];
      const c = outputVertices[tri[2] - 1];
      const faceNormal = computeFaceNormal(a, b, c);
      if (dot(faceNormal, normal) < 0) {
        const tmp = tri[1];
        tri[1] = tri[2];
        tri[2] = tmp;
      }

      const refs = tri.map((vIndex) => {
        const [, y, z] = outputVertices[vIndex - 1];
        const u = (z - minZ) / Math.max(maxZ - minZ, 0.0001);
        const v = (y - minY) / Math.max(maxY - minY, 0.0001);
        outputTexcoords.push([u, v]);
        return { v: vIndex, vt: outputTexcoords.length, vn: vnIndex };
      });

      bodyMainFaces.push(refs);
    }
  };

  const leftPlaneX = findDominantSidePlaneX(-1);
  const rightPlaneX = findDominantSidePlaneX(1);
  appendContourCap(leftPlaneX, [-1, 0, 0]);
  appendContourCap(rightPlaneX, [1, 0, 0]);
}

addFlatBodySideFaces();

const outputGroups = [
  { name: 'barrel', faces: wrapFaces(pickFaces(['barrel'])) },
  { name: 'body', faces: wrapFaces(bodyMainFaces) },
  { name: 'leftTreadMiddle', faces: importObjectFaces(defaultObj, 'leftTreadMiddle') },
  { name: 'leftTreadFrontCap', faces: importObjectFaces(defaultObj, 'leftTreadFrontCap') },
  { name: 'leftTreadRearCap', faces: importObjectFaces(defaultObj, 'leftTreadRearCap') },
  { name: 'rightTreadMiddle', faces: importObjectFaces(defaultObj, 'rightTreadMiddle') },
  { name: 'rightTreadFrontCap', faces: importObjectFaces(defaultObj, 'rightTreadFrontCap') },
  { name: 'rightTreadRearCap', faces: importObjectFaces(defaultObj, 'rightTreadRearCap') },
  { name: 'leftWheel1', faces: importObjectFaces(defaultObj, 'leftWheel1') },
  { name: 'rightWheel1', faces: importObjectFaces(defaultObj, 'rightWheel1') },
  { name: 'leftWheel2', faces: importObjectFaces(defaultObj, 'leftWheel2') },
  { name: 'rightWheel2', faces: importObjectFaces(defaultObj, 'rightWheel2') },
  { name: 'leftWheel3', faces: importObjectFaces(defaultObj, 'leftWheel3') },
  { name: 'rightWheel3', faces: importObjectFaces(defaultObj, 'rightWheel3') },
  { name: 'leftWheel4', faces: importObjectFaces(defaultObj, 'leftWheel4') },
  { name: 'rightWheel4', faces: importObjectFaces(defaultObj, 'rightWheel4') },
  { name: 'turret', faces: wrapFaces(pickFaces(['turret'])) },
];

let out = '';
out += '# BZFlag tank split and re-oriented for Three.js\n';
out += '# Generated by scripts/split-bzflag-tank.mjs\n';
out += '# Source: src/tank.obj (BZFlag misc/tank.obj)\n';
out += '# Coordinate transform: (x,y,z) -> (-y, z, -x)  [tank.obj Z-up/X-front -> Three.js Y-up/Z-rear]\n\n';

for (const [x, y, z] of outputVertices) {
  out += `v ${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)}\n`;
}
for (const [u, v] of outputTexcoords) {
  out += `vt ${u.toFixed(6)} ${v.toFixed(6)}\n`;
}
for (const [x, y, z] of outputNormals) {
  out += `vn ${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)}\n`;
}

for (const group of outputGroups) {
  out += `\no ${group.name}\n`;
  out += `g ${group.name}\n`;
  out += 's 1\n';

  let currentMaterial = null;
  for (const faceEntry of group.faces) {
    if (faceEntry.material && faceEntry.material !== currentMaterial) {
      out += `usemtl ${faceEntry.material}\n`;
      currentMaterial = faceEntry.material;
    }
    const refs = faceEntry.refs.map((r) => `${r.v}/${r.vt}/${r.vn}`).join(' ');
    out += `f ${refs}\n`;
  }
}

writeFileSync(outputPath, out, 'utf-8');

console.log(`Wrote ${outputPath}`);
console.log(`Faces: body=${bodyMainFaces.length}`);
