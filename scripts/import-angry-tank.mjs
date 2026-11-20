#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The angry tank, a Tripo AI export (one object, one material, one baked
// texture), turned into a model bzo can build: its pieces sorted into the
// named parts docs/tank-model-format.md asks for, turned to face -Z, fitted
// to the stock tank, with its own nav lights and texture.
// Its own tracks and road wheels are painted on and cannot move, so they are
// taken out and the stock tank's treads and wheels (public/obj/bzflag.obj)
// are fitted into the space they leave, where the renderer animates them.
//
//   node scripts/import-angry-tank.mjs [source] [outDir] [--width 2.8] [--length 6]
//
// reads the export from `source` -- the OBJ, or the zip holding it, by default
// src/angry-src.zip -- and writes angry.obj, angry.mtl and angry.jpg to
// outDir (default public/obj).
// It stands the stock tank's height, and its hull is stretched to the stock
// width and length (or those given). The turret keeps its own round shape,
// face and all, where the hull's stretch puts its middle, and the barrel
// grows out of it to the stock gun's length.
// The sorting thresholds are this model's own, read off its pieces' bounds.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPSTREAM_TANK, navLightPositions, navLightSpot, surfaceUnderPoint } from '../public/js/tank-dimensions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const options = { width: UPSTREAM_TANK.width, length: UPSTREAM_TANK.length };
const positional = [];
for (let i = 2; i < process.argv.length; i += 1) {
  const flag = process.argv[i].match(/^--(width|length)$/);
  if (flag) options[flag[1]] = Number(process.argv[(i += 1)]);
  else positional.push(process.argv[i]);
}
const objDir = path.join(__dirname, '..', 'public', 'obj');
const [sourceArg, outArg] = positional;
const outDir = outArg || objDir;
const ID = 'angry';

// A zip is unpacked beside nothing else and read from there.
let source = sourceArg || path.join(__dirname, '..', 'src', 'angry-src.zip');
let unpacked = null;
if (source.toLowerCase().endsWith('.zip')) {
  unpacked = mkdtempSync(path.join(os.tmpdir(), 'angry-src-'));
  execFileSync('unzip', ['-q', source, '-d', unpacked]);
  const obj = readdirSync(unpacked).find((name) => name.toLowerCase().endsWith('.obj'));
  if (!obj) {
    console.error(`no OBJ in ${source}`);
    process.exit(1);
  }
  source = path.join(unpacked, obj);
}
process.on('exit', () => {
  if (unpacked) rmSync(unpacked, { recursive: true, force: true });
});

const vertices = [];
const texcoords = [];
const normals = [];
const faces = [];
let texture = null;
const sourceDir = path.dirname(source);
for (const line of readFileSync(source, 'utf8').split('\n')) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (cmd === 'v') vertices.push(rest.slice(0, 3).map(Number));
  else if (cmd === 'vt') texcoords.push(rest.slice(0, 2).join(' '));
  else if (cmd === 'vn') normals.push(rest.slice(0, 3).map(Number));
  else if (cmd === 'f') faces.push(rest);
  else if (cmd === 'mtllib') {
    const mtl = readFileSync(path.join(sourceDir, rest.join(' ')), 'utf8');
    const map = mtl.match(/^map_Kd\s+(.+)$/m);
    if (map) texture = path.join(sourceDir, map[1].trim());
  }
}
const vertexOf = (corner) => Number(corner.split('/')[0]) - 1;
const fixed = (n) => n.toFixed(6);

// The pieces the mesh is made of: faces joined through shared vertices.
const parent = vertices.map((_, index) => index);
const find = (index) => {
  while (parent[index] !== index) {
    parent[index] = parent[parent[index]];
    index = parent[index];
  }
  return index;
};
for (const face of faces) {
  const first = find(vertexOf(face[0]));
  for (const corner of face.slice(1)) parent[find(vertexOf(corner))] = first;
}
const bounds = new Map();
vertices.forEach((vertex, index) => {
  const root = find(index);
  const box = bounds.get(root) || { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let axis = 0; axis < 3; axis += 1) {
    box.min[axis] = Math.min(box.min[axis], vertex[axis]);
    box.max[axis] = Math.max(box.max[axis], vertex[axis]);
  }
  bounds.set(root, box);
});

// In the export's own axes: +Y up, the barrel out along +Z, and its +X side
// the tank's port once it is turned round. The running gear is every piece
// low on one side, and the axle and roller rows that cross under the hull
// from one track to the other.
function isRunningGear({ min, max }) {
  const oneSide = min[0] > 0.15 || max[0] < -0.15;
  if (max[1] <= 0.25 && oneSide) return true;
  return max[1] <= 0.22 && max[0] - min[0] > 0.5;
}

const isBarrel = ({ min, max }) => max[2] > 0.45 && min[1] > 0.4 && Math.max(-min[0], max[0]) < 0.08;

function partOf(face) {
  const box = bounds.get(find(vertexOf(face[0])));
  if (isRunningGear(box)) return null;
  if (isBarrel(box)) return 'barrel';
  if (box.min[1] >= 0.405) return 'turret';
  return 'body';
}

// Turned half round about +Y so the barrel points down -Z, and scaled on
// each axis to the size asked for.
const extent = [[Infinity, -Infinity], [Infinity, -Infinity], [Infinity, -Infinity]];
const hullZ = [Infinity, -Infinity];
vertices.forEach((vertex, index) => {
  vertex.forEach((value, axis) => {
    extent[axis][0] = Math.min(extent[axis][0], value);
    extent[axis][1] = Math.max(extent[axis][1], value);
  });
  if (!isBarrel(bounds.get(find(index)))) {
    hullZ[0] = Math.min(hullZ[0], vertex[2]);
    hullZ[1] = Math.max(hullZ[1], vertex[2]);
  }
});
const minY = extent[1][0];
const stretch = [
  options.width / (extent[0][1] - extent[0][0]),
  UPSTREAM_TANK.height / (extent[1][1] - extent[1][0]),
  options.length / (hullZ[1] - hullZ[0]),
];
// The turret, its bandana and the ring it sits on are stretched along the
// tank only as much as across it, about their own middle; the barrel runs
// from the front of the turret to the stock gun's reach past the tracks.
const onTurret = (box) => box.min[1] >= 0.37 && !isBarrel(box);
const turretZ = [Infinity, -Infinity];
const barrelZ = [Infinity, -Infinity];
vertices.forEach((vertex, index) => {
  const box = bounds.get(find(index));
  const span = onTurret(box) ? turretZ : isBarrel(box) ? barrelZ : null;
  if (!span) return;
  span[0] = Math.min(span[0], vertex[2]);
  span[1] = Math.max(span[1], vertex[2]);
});
const turretMiddle = (turretZ[0] + turretZ[1]) / 2;
const turretAt = (z) => (turretMiddle * stretch[2]) + ((z - turretMiddle) * stretch[0]);
// Upstream's barrel ends this far past the front of its tracks.
const BARREL_REACH = -UPSTREAM_TANK.barrel.z[0] + UPSTREAM_TANK.tread.z[0];
const barrelStretch = ((hullZ[1] * stretch[2]) + BARREL_REACH - turretAt(barrelZ[0])) / (barrelZ[1] - barrelZ[0]);
const zFor = (box, z) => {
  if (onTurret(box)) return turretAt(z);
  if (isBarrel(box)) return turretAt(barrelZ[0]) + ((z - barrelZ[0]) * barrelStretch);
  return z * stretch[2];
};
const zStretchFor = (box) => (onTurret(box) ? stretch[0] : isBarrel(box) ? barrelStretch : stretch[2]);
const place = ([x, y, z], index) => [-x * stretch[0], (y - minY) * stretch[1], -zFor(bounds.get(find(index)), z)];
// A normal goes the other way to the surface it stands on: divided by the
// stretch of the piece it belongs to, then made a unit again.
const normalBox = [];
for (const face of faces) {
  for (const corner of face) {
    const normal = corner.split('/')[2];
    if (normal) normalBox[Number(normal) - 1] = bounds.get(find(vertexOf(corner)));
  }
}
const turnNormal = ([x, y, z], index) => {
  const zStretch = normalBox[index] ? zStretchFor(normalBox[index]) : stretch[2];
  const n = [-x / stretch[0], y / stretch[1], -z / zStretch];
  const length = Math.hypot(...n) || 1;
  return n.map((value) => value / length);
};
const placed = vertices.map(place);

const emptyBox = () => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
const grow = (box, point) => {
  for (let axis = 0; axis < 3; axis += 1) {
    box.min[axis] = Math.min(box.min[axis], point[axis]);
    box.max[axis] = Math.max(box.max[axis], point[axis]);
  }
};

// What each side's tracks filled, which the stock ones are fitted to. The
// middles of the crossing rows are under the hull, not in a track.
const gearBox = { left: emptyBox(), right: emptyBox() };
const parts = new Map();
let removed = 0;
for (const face of faces) {
  const name = partOf(face);
  if (name === null) {
    removed += 1;
    for (const corner of face) {
      const point = placed[vertexOf(corner)];
      if (Math.abs(point[0]) > 0.12 * stretch[0]) grow(point[0] < 0 ? gearBox.left : gearBox.right, point);
    }
    continue;
  }
  if (!parts.has(name)) parts.set(name, []);
  parts.get(name).push(face);
}

// The stock tank's running gear, each side scaled on each axis from its own
// tread's bounds into that side's space. Wheels go with their side's tread.
const STOCK = path.join(__dirname, '..', 'public', 'obj', 'bzflag.obj');
const GRAFT = {
  left: ['ltread', /^leftWheel\d+$/],
  right: ['rtread', /^rightWheel\d+$/],
};
const stock = { v: [], vt: [], vn: [], objects: [] };
let current = null;
for (const line of readFileSync(STOCK, 'utf8').split('\n')) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (cmd === 'v') stock.v.push(rest.slice(0, 3).map(Number));
  else if (cmd === 'vt') stock.vt.push(rest.slice(0, 2).join(' '));
  else if (cmd === 'vn') stock.vn.push(rest.slice(0, 3).map(Number));
  else if (cmd === 'o' || cmd === 'g') {
    current = { name: rest.join(' '), lines: [] };
    stock.objects.push(current);
  } else if (current && (cmd === 'f' || cmd === 'usemtl')) current.lines.push([cmd, rest]);
}
const sideOf = (name) => Object.keys(GRAFT).find((side) => GRAFT[side][0] === name || GRAFT[side][1].test(name));
const grafted = stock.objects.filter((object) => sideOf(object.name));

const fits = {};
for (const side of Object.keys(GRAFT)) {
  const from = emptyBox();
  const tread = stock.objects.find((object) => object.name === GRAFT[side][0]);
  for (const [cmd, rest] of tread.lines) {
    if (cmd === 'f') rest.forEach((corner) => grow(from, stock.v[vertexOf(corner)]));
  }
  const to = gearBox[side];
  const factor = [0, 1, 2].map((axis) => (to.max[axis] - to.min[axis]) / (from.max[axis] - from.min[axis]));
  fits[side] = {
    point: (p) => p.map((value, axis) => to.min[axis] + ((value - from.min[axis]) * factor[axis])),
    normal: (n) => {
      const scaled = n.map((value, axis) => value / factor[axis]);
      const length = Math.hypot(...scaled) || 1;
      return scaled.map((value) => value / length);
    },
  };
}

// The stock geometry's indices, renumbered past the export's own.
const extra = { v: [], vt: [], vn: [] };
const graftedFaces = new Map();
for (const object of grafted) {
  const fit = fits[sideOf(object.name)];
  const maps = { v: new Map(), vt: new Map(), vn: new Map() };
  const renumber = (kind, index, base, convert) => {
    if (!index) return '';
    if (!maps[kind].has(index)) {
      extra[kind].push(convert(stock[kind][Number(index) - 1]));
      maps[kind].set(index, base + extra[kind].length);
    }
    return maps[kind].get(index);
  };
  const lines = [];
  for (const [cmd, rest] of object.lines) {
    if (cmd === 'usemtl') {
      lines.push(`usemtl ${rest.join(' ')}`);
      continue;
    }
    lines.push(`f ${rest.map((corner) => {
      const [v, vt, vn] = corner.split('/');
      return [
        renumber('v', v, placed.length, fit.point),
        renumber('vt', vt, texcoords.length, (t) => t),
        renumber('vn', vn, normals.length, fit.normal),
      ].join('/');
    }).join(' ')}`);
  }
  graftedFaces.set(object.name, lines);
}

// The nav lights on the turret, placed as the generated models' are, each a
// couple of centimetres over the surface beneath it.
const span = (axis, list = placed) => [Math.min(...list.map((v) => v[axis])), Math.max(...list.map((v) => v[axis]))];
const partBounds = new Map();
const surface = [];
for (const [name, list] of parts) {
  const box = emptyBox();
  for (const face of list) {
    face.forEach((corner) => grow(box, placed[vertexOf(corner)]));
    for (let corner = 1; corner + 1 < face.length; corner += 1) {
      surface.push(placed[vertexOf(face[0])], placed[vertexOf(face[corner])], placed[vertexOf(face[corner + 1])]);
    }
  }
  partBounds.set(name, box);
}
const lights = {};
for (const [name, spot] of Object.entries(navLightPositions(partBounds))) {
  const [x, z] = navLightSpot(surface, spot, partBounds.get('turret'));
  lights[name] = [x, (surfaceUnderPoint(surface, x, z) ?? 0) + 0.02, z];
}

const out = [
  '# angry tank',
  '# Author: Tim Riker',
  '# License: GNU Affero General Public License v3.0 (AGPLv3)',
  '# Built in Tripo AI (commercial tier) from an image made with ChatGPT; its',
  '# maker assigned ownership to Tim Riker and asked not to be credited.',
  '# Source: src/angry-src.zip, split into parts and running on the stock',
  '# tank\'s treads and wheels by scripts/import-angry-tank.mjs.',
  `mtllib ${ID}.mtl`,
  ...placed.map((v) => `v ${v.map(fixed).join(' ')}`),
  ...extra.v.map((v) => `v ${v.map(fixed).join(' ')}`),
  ...texcoords.map((t) => `vt ${t}`),
  ...extra.vt.map((t) => `vt ${t}`),
  ...normals.map((n, index) => `vn ${turnNormal(n, index).map(fixed).join(' ')}`),
  ...extra.vn.map((n) => `vn ${n.map(fixed).join(' ')}`),
];
for (const name of ['body', 'turret', 'barrel']) {
  out.push(`o ${name}`, `usemtl ${ID}`, 's 1');
  for (const face of parts.get(name) || []) out.push(`f ${face.join(' ')}`);
}
for (const [name, lines] of graftedFaces) out.push(`o ${name}`, ...lines);
let next = placed.length + extra.v.length;
for (const [name, point] of Object.entries(lights)) {
  next += 1;
  out.push(`o ${name}`, `v ${point.map(fixed).join(' ')}`, `p ${next}`);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, `${ID}.obj`), `${out.join('\n')}\n`);
const textureName = texture ? `${ID}${path.extname(texture).toLowerCase()}` : null;
writeFileSync(path.join(outDir, `${ID}.mtl`), [
  `newmtl ${ID}`,
  'Kd 1.000000 1.000000 1.000000',
  ...(textureName ? [`map_Kd ${textureName}`] : []),
  '',
].join('\n'));
if (texture) copyFileSync(texture, path.join(outDir, textureName));

const counts = [...parts].map(([name, list]) => `${name} ${list.length}`).join(', ');
const all = [...placed, ...extra.v];
const size = [span(0, all), span(1, all), span(2, all)].map(([lo, hi]) => (hi - lo).toFixed(2)).join(' x ');
console.log(`${ID}.obj: ${counts}; ${removed} running-gear faces replaced by ${[...graftedFaces.keys()].join(' ')};`
  + ` ${size} (w x h x l)`);
