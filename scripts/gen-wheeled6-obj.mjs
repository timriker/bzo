#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

import * as THREE from 'three';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { writeFileSync } from 'fs';
import { tileTankUVsByPosition } from '../public/js/tank-uv.mjs';
import { UPSTREAM_TANK, fitGeometryAxes, navLightPositions, navLightSpot, surfaceUnderPoint } from '../public/js/tank-dimensions.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

class OBJBuilder {
  constructor() {
    // Every triangle written so far, so a nav light can be sat on the deck
    // it is over rather than at a remembered height.
    this.surface = [];
    // What each named part spans, so nav lights can be placed against it.
    this.bounds = new Map();
    this.vOffset = 0;
    this.vtOffset = 0;
    this.vnOffset = 0;
    this.out = '';
  }


  // A nav light is a single point, not a surface: it marks where render.js
  // hangs a light on the model and has no geometry of its own. `p -1` is the
  // OBJ spelling for "the vertex just written", which keeps a point
  // independent of how many vertices came before it.
  addComment(text) {
    this.out += `\n# ${text}\n`;
  }

  addPointOnSurface(name, x, z, clearance = 0.03) {
    // Walks in toward the middle if the chosen spot is over fresh air.
    for (let step = 0; step <= 20; step += 1) {
      const t = step / 20;
      const atX = x * (1 - t);
      const atZ = z * (1 - t);
      const surface = surfaceUnderPoint(this.surface, atX, atZ);
      if (surface !== null) {
        this.addPoint(name, atX, surface + clearance, atZ);
        return;
      }
    }
    throw new Error(`${name} at ${x},${z} is over empty space`);
  }

  addPoint(name, x, y, z) {
    this.out += `\no ${name}\n`;
    this.out += `v ${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)}\n`;
    this.out += 'p -1\n';
    this.vOffset += 1;
  }

  addObject(name, geo, matNames) {
    const pos = geo.attributes.position;
    // Triangles, three vertices at a time -- so an indexed geometry has to
    // be walked through its index or the triples are not its triangles.
    const order = geo.index ? geo.index.array : null;
    const corners = order ? order.length : pos.count;
    for (let i = 0; i < corners; i += 1) {
      const vertex = order ? order[i] : i;
      this.surface.push([pos.getX(vertex), pos.getY(vertex), pos.getZ(vertex)]);
    }
    geo.computeBoundingBox();
    this.bounds.set(name, {
      min: [geo.boundingBox.min.x, geo.boundingBox.min.y, geo.boundingBox.min.z],
      max: [geo.boundingBox.max.x, geo.boundingBox.max.y, geo.boundingBox.max.z],
    });
    const nor = geo.attributes.normal;
    const uv = geo.attributes.uv;
    const indexed = geo.index !== null;

    this.out += `\no ${name}\n`;

    for (let i = 0; i < pos.count; i += 1) {
      this.out += `v ${pos.getX(i).toFixed(6)} ${pos.getY(i).toFixed(6)} ${pos.getZ(i).toFixed(6)}\n`;
    }
    if (uv) {
      for (let i = 0; i < uv.count; i += 1) {
        this.out += `vt ${uv.getX(i).toFixed(6)} ${uv.getY(i).toFixed(6)}\n`;
      }
    }
    if (nor) {
      for (let i = 0; i < nor.count; i += 1) {
        this.out += `vn ${nor.getX(i).toFixed(6)} ${nor.getY(i).toFixed(6)} ${nor.getZ(i).toFixed(6)}\n`;
      }
    }

    const hasUV = !!uv;
    const hasNor = !!nor;
    const vOff = this.vOffset;
    const vtOff = this.vtOffset;
    const vnOff = this.vnOffset;

    const fRef = (i) => {
      const v = i + 1 + vOff;
      const vt = i + 1 + vtOff;
      const vn = i + 1 + vnOff;
      if (hasUV && hasNor) return `${v}/${vt}/${vn}`;
      if (hasUV) return `${v}/${vt}`;
      if (hasNor) return `${v}//${vn}`;
      return `${v}`;
    };

    const groups = (geo.groups && geo.groups.length > 0)
      ? geo.groups
      : [{ start: 0, count: indexed ? geo.index.count : pos.count, materialIndex: 0 }];

    const useGroups = matNames && matNames.length > 1;
    const indexArr = indexed ? geo.index.array : null;

    for (const group of groups) {
      if (useGroups) {
        const mName = matNames[group.materialIndex] ?? matNames[0];
        this.out += `usemtl ${mName}\n`;
      }
      for (let i = group.start; i < group.start + group.count; i += 3) {
        const a = indexArr ? indexArr[i] : i;
        const b = indexArr ? indexArr[i + 1] : i + 1;
        const c = indexArr ? indexArr[i + 2] : i + 2;
        this.out += `f ${fRef(a)} ${fRef(b)} ${fRef(c)}\n`;
      }
    }

    this.vOffset += pos.count;
    if (uv) this.vtOffset += uv.count;
    if (nor) this.vnOffset += nor.count;
  }

  build() {
    return this.out;
  }
}

function transformedGeometry(geometry, {
  x = 0,
  y = 0,
  z = 0,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = 1,
  sz = 1,
} = {}) {
  const geo = geometry.clone();
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz));
  const position = new THREE.Vector3(x, y, z);
  const scale = new THREE.Vector3(sx, sy, sz);
  matrix.compose(position, quaternion, scale);
  geo.applyMatrix4(matrix);
  geo.computeVertexNormals();
  return geo;
}

function makeBodyGeometry() {
  const profile = new THREE.Shape();
  profile.moveTo(-0.95, 0.12);
  profile.lineTo(0.95, 0.12);
  profile.lineTo(1.48, 0.42);
  profile.lineTo(1.60, 0.72);
  profile.lineTo(1.15, 1.02);
  profile.lineTo(0.25, 1.14);
  profile.lineTo(-0.55, 1.12);
  profile.lineTo(-1.15, 0.95);
  profile.lineTo(-1.55, 0.52);
  profile.lineTo(-1.48, 0.24);
  profile.lineTo(-0.95, 0.12);

  const body = new THREE.ExtrudeGeometry(profile, {
    depth: 6.2,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 12,
  });

  body.translate(0, 0, -3.1);
  body.computeVertexNormals();
  return body;
}

function makeTurretGeometry() {
  const turretShape = new THREE.Shape();
  turretShape.moveTo(-0.55, 0.0);
  turretShape.lineTo(0.40, 0.0);
  turretShape.lineTo(0.78, 0.22);
  turretShape.lineTo(0.88, 0.48);
  turretShape.lineTo(0.52, 0.74);
  turretShape.lineTo(-0.18, 0.82);
  turretShape.lineTo(-0.72, 0.62);
  turretShape.lineTo(-0.84, 0.28);
  turretShape.lineTo(-0.55, 0.0);

  const turret = new THREE.ExtrudeGeometry(turretShape, {
    depth: 2.45,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 8,
  });

  turret.translate(0, 0, -1.225);
  turret.computeVertexNormals();
  return turret;
}

// BZFlag's `_muzzleHeight` (global.cxx) is 1.57, and a shot leaves the tank
// there. render.js reads the muzzle off this barrel's own foremost vertices
// rather than assuming it, so the barrel *is* where the shot and its flare
// come from -- a barrel modelled higher or longer than upstream's puts every
// shot somewhere the game does not think it is.
const MUZZLE_HEIGHT = 1.57;
// Half the tank's 6.0 length. render.js clamps the muzzle to
// MAX_MUZZLE_FORWARD, which is this plus 0.1, so a barrel reaching past here
// would have its flare drawn behind its own tip.
const MUZZLE_FORWARD = 3.0;
// The barrel keeps the end it is seated in the turret by, at z 0.07, and
// reaches forward to the muzzle from there.
const BARREL_REAR_Z = 0.07;
const BARREL_LENGTH = BARREL_REAR_Z + MUZZLE_FORWARD;
const BARREL_CENTRE_Z = (BARREL_REAR_Z - MUZZLE_FORWARD) / 2;

function makeBarrelGeometry() {
  const barrel = new THREE.CylinderGeometry(0.12, 0.16, BARREL_LENGTH, 12, 1, false);
  barrel.rotateX(Math.PI / 2);
  barrel.computeVertexNormals();
  return barrel;
}

function makeWheelGeometry() {
  const wheel = new THREE.CylinderGeometry(0.62, 0.62, 0.34, 24);
  wheel.rotateZ(Math.PI / 2);
  wheel.computeVertexNormals();
  return wheel;
}

const WHEEL_MATS = ['tread_side', 'tread_cap', 'tread_cap'];

const builder = new OBJBuilder();
builder.out = `# Wheeled6 geometry for BZO
# Generated by scripts/gen-wheeled6-obj.mjs
# Six-wheeled armored car inspired by modern reconnaissance vehicles.
# Naming contract used by render.js template-driven assembly.
`;


// The camo-skinned parts take their texture coordinates from the shared rule
// rather than from whatever the primitive handed back, so a patch is the same
// size on every part of every tank. See public/js/tank-uv.mjs.
function tileCamo(geometry) {
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  geometry.setAttribute('uv', new THREE.BufferAttribute(
    tileTankUVsByPosition(position.array, normal ? normal.array : null), 2,
  ));
  return geometry;
}

// BZFlag's `_tankWidth` is 2.8, and that is the box the server slides a tank
// along a wall with. This hull was modelled 3.15 across, so it stood proud of
// its own collision box and clipped into any face it slid down. The profile is
// brought in to match rather than redrawn, which keeps its shape.
// `_tankLength` is 6.0 and `_tankWidth` 2.8, which together are the box the
// server slides a tank along a wall with. The hull was modelled 3.15 across
// and 6.2 long, so it stood proud of its own collision box on three sides and
// clipped into any face it slid down. Brought in to match rather than
// redrawn, which keeps the shape it was given.
const TANK_WIDTH = 2.8;
const TANK_LENGTH = 6.0;
const HULL_MODELLED_WIDTH = 3.15;
const HULL_MODELLED_LENGTH = 6.2;
builder.addObject('body', tileCamo(transformedGeometry(makeBodyGeometry(), {
  y: 0.18,
  sx: TANK_WIDTH / HULL_MODELLED_WIDTH,
  sz: TANK_LENGTH / HULL_MODELLED_LENGTH,
})));

// Upstream's turret footprint and height, so a turret reads the same size
// across models. The underside stays where this model puts it.
builder.addObject('turret', tileCamo(fitGeometryAxes(
  transformedGeometry(makeTurretGeometry(), { y: 1.0, z: -0.15 }),
  UPSTREAM_TANK.turret, { x: 'both', z: 'both', y: 'min' },
)));
// Upstream's gun reaches past the hull and the wheels; fitted to its span
// so it does, rather than stopping flush with them.
builder.addObject('barrel', fitGeometryAxes(
  transformedGeometry(makeBarrelGeometry(), { y: MUZZLE_HEIGHT, z: BARREL_CENTRE_Z }),
  UPSTREAM_TANK.barrel, { z: 'both', y: 'both' },
));

const wheelZ = [2.1, 0, -2.1];
for (let i = 0; i < wheelZ.length; i += 1) {
  builder.addObject(`leftWheel${i + 1}`, transformedGeometry(makeWheelGeometry(), {
    x: -1.17,
    y: 0.62,
    z: wheelZ[i],
  }), WHEEL_MATS);
  builder.addObject(`rightWheel${i + 1}`, transformedGeometry(makeWheelGeometry(), {
    x: 1.17,
    y: 0.62,
    z: wheelZ[i],
  }), WHEEL_MATS);
}

// The nav lights render.js hangs on the model. Points rather than
// geometry, and last so they cannot disturb a face index.
builder.addComment('Navigation lights. One `p` vertex each, read by the renderer for its');
builder.addComment('position only; see docs/tank-model-format.md.');
const navLights = navLightPositions(builder.bounds);
const navTurret = builder.bounds.get('turret');
for (const [name, spot] of Object.entries(navLights)) {
  const [lx, lz] = navLightSpot(builder.surface, spot, navTurret);
  builder.addPointOnSurface(name, lx, lz);
}

const objText = builder.build();
const outPath = resolve(__dirname, '../public/obj/wheeled6.obj');
writeFileSync(outPath, objText, 'utf-8');

console.log(`Written: ${outPath}`);
console.log(`Objects: ${(objText.match(/^o /mg) || []).length}`);
console.log(`usemtl groups: ${(objText.match(/^usemtl /mg) || []).length}`);
