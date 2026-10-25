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
const BODY_WIDTH = 1.755;
const BODY_HALF_WIDTH = BODY_WIDTH / 2;
const BODY_X_SCALE = BODY_WIDTH / 4.5;
const BODY_DEPTH = BODY_WIDTH;

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

function scaleGroupUVs(geometry, groupIndex, { scaleU = 1, scaleV = 1 } = {}) {
  const uv = geometry.attributes.uv;
  if (!uv || !geometry.groups || !geometry.groups[groupIndex]) return geometry;

  const group = geometry.groups[groupIndex];
  const indexArray = geometry.index ? geometry.index.array : null;
  const touched = new Set();

  for (let i = group.start; i < group.start + group.count; i += 1) {
    touched.add(indexArray ? indexArray[i] : i);
  }

  for (const vertexIndex of touched) {
    uv.setXY(vertexIndex, uv.getX(vertexIndex) * scaleU, uv.getY(vertexIndex) * scaleV);
  }

  uv.needsUpdate = true;
  return geometry;
}

function makeTreadMiddleGeometry() {
  const geometry = new THREE.BoxGeometry(treadWidth, treadHeight, treadMiddleLength);
  const lengthScale = treadMiddleLength / 3.0;
  const widthScale = treadWidth / 1.0;

  scaleGroupUVs(geometry, 0, { scaleU: lengthScale });
  scaleGroupUVs(geometry, 1, { scaleU: lengthScale });
  scaleGroupUVs(geometry, 4, { scaleU: widthScale });
  scaleGroupUVs(geometry, 5, { scaleU: widthScale });

  return geometry;
}

function makeTreadCapGeometry(thetaStart) {
  const geometry = new THREE.CylinderGeometry(treadCapRadius, treadCapRadius, treadWidth, 16, 1, false, thetaStart, Math.PI);
  const widthScale = treadWidth / 1.0;

  scaleGroupUVs(geometry, 0, { scaleV: widthScale });

  return geometry;
}

function makeCurvedBodyGeometry() {
  const profile = new THREE.Shape();
  profile.moveTo(-BODY_HALF_WIDTH, 0.70);
  profile.lineTo(BODY_HALF_WIDTH, 0.70);
  profile.lineTo(2.18 * BODY_X_SCALE, 0.46);
  profile.bezierCurveTo(1.55 * BODY_X_SCALE, 0.16, 0.85 * BODY_X_SCALE, 0.03, 0.00, -0.08);
  profile.bezierCurveTo(-0.85 * BODY_X_SCALE, 0.03, -1.55 * BODY_X_SCALE, 0.16, -2.18 * BODY_X_SCALE, 0.46);
  profile.lineTo(-BODY_HALF_WIDTH, 0.70);

  const body = new THREE.ExtrudeGeometry(profile, {
    depth: BODY_DEPTH,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 20,
  });

  body.translate(0, 0, -BODY_DEPTH / 2);
  body.rotateY(Math.PI / 2);
  body.computeVertexNormals();
  return body;
}

function makeTurretGeometry() {
  const pts = [
    new THREE.Vector2(0.00, 0.42),
    new THREE.Vector2(0.24, 0.40),
    new THREE.Vector2(0.55, 0.32),
    new THREE.Vector2(0.80, 0.18),
    new THREE.Vector2(0.95, 0.00),
    new THREE.Vector2(0.88, -0.14),
    new THREE.Vector2(0.62, -0.26),
    new THREE.Vector2(0.25, -0.33),
    new THREE.Vector2(0.00, -0.35),
  ];

  const lathe = new THREE.LatheGeometry([...pts].reverse(), 32);
  lathe.rotateY(Math.PI / 2);
  lathe.computeVertexNormals();
  return lathe;
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
// The barrel keeps the end it is seated in the turret by, at z -0.08, and
// reaches forward to the muzzle from there.
const BARREL_REAR_Z = -0.08;
const BARREL_LENGTH = BARREL_REAR_Z + MUZZLE_FORWARD;
const BARREL_CENTRE_Z = (BARREL_REAR_Z - MUZZLE_FORWARD) / 2;

function makeBarrelGeometry() {
  const barrel = new THREE.CylinderGeometry(0.16, 0.20, BARREL_LENGTH, 12, 1, false);
  barrel.rotateX(Math.PI / 2);
  barrel.computeVertexNormals();
  return barrel;
}

function makeWheelGeometry() {
  const wheel = new THREE.CylinderGeometry(0.495, 0.495, WHEEL_THICKNESS, 20);
  wheel.rotateZ(Math.PI / 2);
  wheel.computeVertexNormals();
  return wheel;
}

// BZFlag exposed tread dimensions (from AnimatedTreads.cxx, Exposed style)
const treadHeight = 1.2;              // BZFlag treadHeight (exposed)
const treadWidth = 0.525;             // BZFlag treadWidth = treadOutside - treadInside = 1.4 - 0.875
const treadCapRadius = treadHeight / 2;
const treadMiddleLength = 4.8;         // BZFlag fullLength - treadHeight = 6.0 - 1.2
const treadCenterOffset = 0.875 + treadWidth / 2; // BZFlag treadYCenter = treadInside + half treadWidth = 1.1375
const WHEEL_THICKNESS = 0.473;         // BZFlag wheelWidth ≈ treadWidth * 0.9 = 0.4725
const TARGET_HALF_MODEL_WIDTH = 1.4;
const wheelCenterOffset = TARGET_HALF_MODEL_WIDTH - (WHEEL_THICKNESS / 2);
const wheelCenterZStart = treadMiddleLength / 2;  // = 2.4 = BZFlag wheelSpacing * 1.5
const wheelCenterZStep = treadMiddleLength / 3;   // = 1.6 = BZFlag wheelSpacing
const CAP_MATS = ['tread_side', 'tread_cap', 'tread_cap'];
const WHEEL_MATS = ['tread_side', 'tread_cap', 'tread_cap'];
const BOX_MATS = ['bm0', 'bm1', 'bm2', 'bm3', 'bm4', 'bm5'];

const builder = new OBJBuilder();
builder.out = `# DefaultTank geometry for BZO\n# Generated by scripts/gen-default-obj.mjs\n# Assembled BZFlag-like body/turret + treads + wheels\n# Naming contract used by render.js template-driven assembly\n`;


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

// Upstream's hull runs nearly the whole length of the tank. This one was a
// short block between full-length tracks, which left the tracks standing
// well out in front of it and the turret looking pushed forward on a stub.
builder.addObject('body', tileCamo(fitGeometryAxes(
  transformedGeometry(makeCurvedBodyGeometry(), { y: 0.38 }),
  UPSTREAM_TANK.body, { z: 'both', y: 'min' },
)));

builder.addObject('leftTreadMiddle', transformedGeometry(
  makeTreadMiddleGeometry(),
  { x: -treadCenterOffset, y: treadCapRadius },
), BOX_MATS);

// The barrel points -Z, so -Z is forward and the cap at +Z is the rear one.
builder.addObject('leftTreadRearCap', transformedGeometry(
  makeTreadCapGeometry(0),
  { x: -treadCenterOffset, y: treadCapRadius, z: treadMiddleLength / 2, rx: Math.PI / 2, rz: Math.PI / 2 },
), CAP_MATS);

builder.addObject('leftTreadFrontCap', transformedGeometry(
  makeTreadCapGeometry(Math.PI),
  { x: -treadCenterOffset, y: treadCapRadius, z: -treadMiddleLength / 2, rx: Math.PI / 2, rz: Math.PI / 2 },
), CAP_MATS);

builder.addObject('rightTreadMiddle', transformedGeometry(
  makeTreadMiddleGeometry(),
  { x: treadCenterOffset, y: treadCapRadius },
), BOX_MATS);

builder.addObject('rightTreadFrontCap', transformedGeometry(
  makeTreadCapGeometry(0),
  { x: treadCenterOffset, y: treadCapRadius, z: treadMiddleLength / 2, rx: Math.PI / 2, rz: Math.PI / 2 },
), CAP_MATS);

builder.addObject('rightTreadRearCap', transformedGeometry(
  makeTreadCapGeometry(Math.PI),
  { x: treadCenterOffset, y: treadCapRadius, z: -treadMiddleLength / 2, rx: Math.PI / 2, rz: Math.PI / 2 },
), CAP_MATS);

// Upstream's turret footprint and height, so a turret reads the same size
// across models. The underside is left where each model puts it: Modern's
// floats clear of the hull, and seating it on upstream's would take that away.
builder.addObject('turret', fitGeometryAxes(
  transformedGeometry(makeTurretGeometry(), { y: 1.76, sx: 1.18, sy: 1.15, sz: 1.18 }),
  UPSTREAM_TANK.turret, { x: 'both', z: 'both', y: 'min' },
));
// Upstream's gun reaches past the hull and the tracks; fitted to its span
// so it does, rather than stopping flush with them.
builder.addObject('barrel', fitGeometryAxes(
  transformedGeometry(makeBarrelGeometry(), { x: 0, y: MUZZLE_HEIGHT, z: BARREL_CENTRE_Z }),
  UPSTREAM_TANK.barrel, { z: 'both', y: 'both' },
));

const wheelZ = Array.from({ length: 4 }, (_, index) => wheelCenterZStart - (index * wheelCenterZStep));
for (let i = 0; i < wheelZ.length; i += 1) {
  builder.addObject(`leftWheel${i + 1}`, transformedGeometry(makeWheelGeometry(), {
    x: -wheelCenterOffset,
    y: treadCapRadius,
    z: wheelZ[i],
  }), WHEEL_MATS);
  builder.addObject(`rightWheel${i + 1}`, transformedGeometry(makeWheelGeometry(), {
    x: wheelCenterOffset,
    y: treadCapRadius,
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
const outPath = resolve(__dirname, '../public/obj/modern.obj');
writeFileSync(outPath, objText, 'utf-8');

console.log(`Written: ${outPath}`);
console.log(`Objects: ${(objText.match(/^o /mg) || []).length}`);
console.log(`usemtl groups: ${(objText.match(/^usemtl /mg) || []).length}`);
console.log(`Global vertex count: ${builder.vOffset}`);
