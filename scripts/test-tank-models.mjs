#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The part contract, checked against the models that ship. There is no generic
// tank to fall back on, so a model in public/obj that misses a part is a model
// the picker drops and a player cannot choose -- which is worth catching here
// rather than in play.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TANK_LIGHT_ALIASES,
  missingTankParts,
  readObjObjectNames,
  tankRunningGear,
} from '../public/tank-parts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const objDir = path.join(__dirname, '..', 'public', 'obj');

// tank.obj is upstream's own single-object mesh, the source split-bzflag-tank
// reads. The server hides it from the picker, so it is not held to the contract.
const HIDDEN = new Set(['tank.obj']);

const offered = readdirSync(objDir)
  .filter((name) => name.toLowerCase().endsWith('.obj'))
  .filter((name) => !HIDDEN.has(name.toLowerCase()));

assert.ok(offered.length > 0, 'public/obj should carry at least one tank model');

for (const fileName of offered) {
  const names = readObjObjectNames(readFileSync(path.join(objDir, fileName), 'utf8'));
  assert.deepEqual(
    missingTankParts(names),
    [],
    `${fileName} is offered in the picker but the renderer cannot build it`,
  );
}

// The navigation lights each model places for itself. The renderer falls back
// to upstream's fixed coordinates for a model that names none, and upstream's
// height is inside the turret of half the models here -- so a model that ships
// without its own is a model whose lights are invisible, which is a thing only
// a check like this notices.
//
// `o` blocks, their vertices and faces, and which blocks carry a `p`: enough
// to say where a light sits, that nothing but a light does, and what the model
// draws underneath it.
function readObj(text) {
  const vertices = [];
  const triangles = [];
  const points = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('o ')) current = line.slice(2).trim();
    else if (line.startsWith('v ')) {
      const [x, y, z] = line.slice(2).trim().split(/\s+/).map(Number);
      vertices.push({ object: current, x, y, z });
    } else if (line.startsWith('p ')) {
      points.set(current, vertices[vertices.length - 1]);
    } else if (line.startsWith('f ')) {
      const corners = line.slice(2).trim().split(/\s+/)
        .map((part) => Number(part.split('/')[0]))
        .map((i) => (i > 0 ? i - 1 : vertices.length + i));
      // A fan, so a quad or an n-gon is read the same way the loader reads it.
      for (let i = 1; i < corners.length - 1; i += 1) {
        triangles.push([corners[0], corners[i], corners[i + 1]]);
      }
    }
  }
  return { vertices, triangles, points };
}

// The highest the model reaches in the column straight under (x, z), or null
// where it reaches nothing at all.
function surfaceUnder(vertices, triangles, x, z) {
  let top = null;
  for (const [ai, bi, ci] of triangles) {
    const a = vertices[ai]; const b = vertices[bi]; const c = vertices[ci];
    if (!a || !b || !c) continue;
    const det = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
    if (Math.abs(det) < 1e-12) continue;
    const u = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / det;
    const v = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / det;
    const w = 1 - u - v;
    if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
    const y = (u * a.y) + (v * b.y) + (w * c.y);
    if (top === null || y > top) top = y;
  }
  return top;
}

const lightNames = Object.values(TANK_LIGHT_ALIASES).map(([name]) => name);

// How far above the surface a light may sit. Upstream draws all three of the
// stock tank's at one flat height, so its rear light already clears the deck
// under it by 0.05; that is the slack every model gets, rounded up past the
// noise in an OBJ's six decimal places. Under it a light is inside the hull
// and depth-tested away, over it the light visibly floats.
const LIGHT_CLEARANCE_MIN = 0.01;
const LIGHT_CLEARANCE_MAX = 0.06;

for (const fileName of offered) {
  const text = readFileSync(path.join(objDir, fileName), 'utf8');
  const { vertices, triangles, points } = readObj(text);
  const lightSet = new Set(lightNames);

  for (const name of lightNames) {
    assert.ok(
      points.has(name),
      `${fileName} should place its own ${name}, or its lights fall back to coordinates`
      + ' fitted to bzflag.obj and can end up inside its turret',
    );
  }
  for (const object of points.keys()) {
    assert.ok(lightSet.has(object), `${fileName} carries a stray point object ${object}`);
  }

  // Resting on the model, not floating over it and not sunk into it. Measured
  // against the surface in the light's own column rather than the top of the
  // whole tank: a light beside a tall turret belongs on the deck it is over.
  const hull = triangles.filter(([i]) => !lightSet.has(vertices[i]?.object));
  for (const name of lightNames) {
    const light = points.get(name);
    const surface = surfaceUnder(vertices, hull, light.x, light.z);
    assert.ok(
      surface !== null,
      `${fileName}'s ${name} is over empty space at x=${light.x}, z=${light.z}`,
    );
    const clearance = light.y - surface;
    assert.ok(
      clearance >= LIGHT_CLEARANCE_MIN && clearance <= LIGHT_CLEARANCE_MAX,
      `${fileName}'s ${name} sits ${clearance.toFixed(2)} above the surface under it`
      + ` (${surface.toFixed(2)}); it should rest between ${LIGHT_CLEARANCE_MIN}`
      + ` and ${LIGHT_CLEARANCE_MAX} over it`,
    );
  }

  // Port is the tank's left and starboard its right: bzo's tank faces -Z and
  // stands on +Y, which puts its left at -X. Reading them the wrong way round
  // tells every other player the tank is pointing the other way.
  assert.ok(points.get('lightPort').x < 0, `${fileName}'s lightPort should sit to -X`);
  assert.ok(points.get('lightStarboard').x > 0, `${fileName}'s lightStarboard should sit to +X`);
  assert.ok(
    points.get('lightRear').z > points.get('lightPort').z,
    `${fileName}'s lightRear should sit aft of the beam lights, at +Z`,
  );
}

// A `p` object is invisible to the part contract, which is what makes adding
// lights to a model safe: nothing that builds a tank out of meshes can pick
// one up, and no model can be made unbuildable by gaining them.
assert.deepEqual(
  readObjObjectNames([
    'o body', 'f 1 2 3',
    'o lightRear', 'v 0 2.1 1.53', 'p -1',
  ].join('\n')),
  ['body'],
);

// Upstream's five names are enough on their own -- ltread and rtread stand in
// for all three tread parts on their side.
assert.deepEqual(missingTankParts(['body', 'turret', 'barrel', 'ltread', 'rtread']), []);

// So is a wheeled layout with no treads at all, at whatever wheel count.
assert.deepEqual(missingTankParts(['body', 'turret', 'barrel', 'leftWheel1', 'rightWheel1']), []);
assert.deepEqual(missingTankParts([
  'body', 'turret', 'barrel',
  'wheel_left1', 'wheel_left2', 'wheel_left3',
  'wheel_right1', 'wheel_right2', 'wheel_right3',
]), []);

// A model naming nothing is missing everything, in the words the docs use.
assert.deepEqual(missingTankParts([]), ['body', 'turret', 'barrel', 'treads or wheels on both sides']);

// Blender's default object names carry no roles, which is what a model exported
// without renaming its objects looks like.
assert.deepEqual(
  missingTankParts(['Cube', 'Cube.001', 'Cylinder', 'Sphere', 'Plane']),
  ['body', 'turret', 'barrel', 'treads or wheels on both sides'],
);

// Running gear on one side only is not running gear.
assert.deepEqual(missingTankParts(['body', 'turret', 'barrel', 'ltread']), ['treads or wheels on both sides']);
assert.deepEqual(missingTankParts(['body', 'turret', 'barrel', 'leftWheel1']), ['treads or wheels on both sides']);

// A tread trio split into its own parts is tracked on that side, and one part
// short of the trio is not.
const split = tankRunningGear([
  'leftTreadMiddle', 'leftTreadFrontCap', 'leftTreadRearCap',
  'rightTreadMiddle', 'rightTreadFrontCap',
]);
assert.equal(split.leftTread, true);
assert.equal(split.rightTread, false);

// A loose `l` edge mixed into an otherwise normal object taints the whole
// block: OBJLoader.js builds it as a LineSegments node, not a Mesh, so the
// renderer's `child.isMesh` lookup can never find it. `readObjObjectNames`
// has to drop a part like that the same way it drops one with no faces --
// bzship.obj shipped exactly this defect (four stray `l` lines at the tail
// of its barrel block) and the server offered it anyway because it only
// checked for the name.
const taintedBarrel = [
  'o body',
  'f 1 2 3',
  'o turret',
  'f 1 2 3',
  'o barrel',
  'f 1 2 3',
  'l 1 2',
  'o ltread',
  'f 1 2 3',
  'o rtread',
  'f 1 2 3',
].join('\n');
assert.deepEqual(
  missingTankParts(readObjObjectNames(taintedBarrel)),
  ['barrel'],
  'a barrel block with a stray loose edge should not count as a usable barrel',
);

// `g` opens a block the same way `o` does -- OBJLoader.js matches both with one
// pattern -- so a per-material export leaves the `o` blocks empty and builds
// meshes named for the material instead. The names the renderer looks for are
// declared and build nothing, which is the shape PR #127's bzship arrived in.
const materialGroups = [
  'o body',
  'g body_body_skin',
  'f 1 2 3',
  'g body_barrel_dark',
  'f 1 2 3',
  'o turret',
  'g turret_body_skin',
  'f 1 2 3',
  'o barrel',
  'g barrel_barrel_dark',
  'f 1 2 3',
  'o ltread',
  'g ltread_treads',
  'f 1 2 3',
  'o rtread',
  'g rtread_treads',
  'f 1 2 3',
].join('\n');
assert.deepEqual(
  readObjObjectNames(materialGroups),
  [
    'body_body_skin', 'body_barrel_dark', 'turret_body_skin',
    'barrel_barrel_dark', 'ltread_treads', 'rtread_treads',
  ],
  'a group split by material names the meshes the loader actually builds',
);
assert.deepEqual(
  missingTankParts(readObjObjectNames(materialGroups)),
  ['body', 'turret', 'barrel', 'treads or wheels on both sides'],
  'and an `o` block whose faces all went to a `g` inside it builds no part',
);

// The pairing bzflag.obj uses -- `o name` immediately followed by `g name` --
// is the same name twice, and names the one mesh it builds once.
assert.deepEqual(
  readObjObjectNames(['o barrel', 'g barrel', 'f 1 2 3'].join('\n')),
  ['barrel'],
);

// public/client.js keeps a hardcoded TANK_MODELS array as the tank it renders
// before /api/tank-models answers (and if that call ever fails), falling back
// to server.js's live directory scan once it does. Nothing else keeps that
// array in sync with public/obj, so a renamed or removed file here would
// silently break the very first frame until the async fetch corrects it.
const clientSource = readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
const arrayLiteral = clientSource.match(/let TANK_MODELS = (\[[\s\S]*?\]);/)?.[1];
assert.ok(arrayLiteral, 'public/client.js should declare a TANK_MODELS fallback array');
const fallbackModels = new Function(`return ${arrayLiteral}`)();

const offeredLower = new Set(offered.map((name) => name.toLowerCase()));
for (const model of fallbackModels) {
  const fileName = path.basename(model.path);
  assert.ok(
    offeredLower.has(fileName.toLowerCase()),
    `client.js fallback model ${model.id} points at ${model.path}, which public/obj no longer offers`,
  );
  assert.equal(
    model.id,
    fileName.slice(0, -path.extname(fileName).length).toLowerCase(),
    `client.js fallback model id ${model.id} does not match the id server.js derives from ${fileName}`,
  );
}

console.log(`tank model parts OK (${offered.join(', ')})`);
