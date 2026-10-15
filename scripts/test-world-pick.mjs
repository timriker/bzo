#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The world viewer's pick (public/world-pick.mjs): the first obstacle a ray
// meets, by its real shape -- a box turned as it is, a pyramid's slopes, a
// mesh's faces -- and drive-through ones too; and its summary of a world
// (public/world-summary.mjs).

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pickObstacle } from '../public/world-pick.mjs';
import { summarizeWorld, obstacleTextures } from '../public/world-summary.mjs';

const require = createRequire(import.meta.url);
const { parseBZWMap } = require('../server/bzw-parse.cjs');

const map = parseBZWMap('pick.bzw', {
  quiet: true,
  text: `box
  name turned
  pos 0 0 0
  size 10 2 5
  rotation 45
end
pyramid
  name point
  pos 100 0 0
  size 10 10 10
end
pyramid
  name cup
  pos 200 0 0
  size 10 10 -10
end
box
  name ghost
  pos 0 100 0
  size 5 5 5
  passable
end
arc
  name ring
  pos 0 -100 0
  size 20 20 5
  ratio 0.5
  divisions 16
end
`,
});
const obstacles = map.obstacles;
const name = (hit) => (hit ? obstacles[hit.index].name : null);
const down = (x, y) => pickObstacle(obstacles, [x, y, 100], [0, 0, -1]);

// The turned box: along its own long axis it reaches 10 out, across only 2.
const diagonal = Math.SQRT1_2 * 9;
assert.equal(name(down(diagonal, diagonal)), 'turned');
assert.equal(name(down(diagonal, -diagonal)), null);
assert.equal(down(diagonal, diagonal).distance, 95);

// An upright pyramid near its corner is low; an inverted one there is full
// height.
assert.ok(Math.abs(down(108, 0).distance - 98) < 1e-9);
assert.ok(Math.abs(down(208, 0).distance - 90) < 1e-9);
// From the side at half height: the upright one's slope is halfway in, the
// inverted one's further out.
const side = (x0) => pickObstacle(obstacles, [x0 - 50, 0, 5], [1, 0, 0]).distance;
assert.ok(Math.abs(side(100) - 45) < 1e-9);
assert.ok(Math.abs(side(200) - 45) < 1e-9);
assert.equal(name(pickObstacle(obstacles, [50, 0, 9.5], [1, 0, 0])), 'point');
assert.ok(pickObstacle(obstacles, [50, 0, 9.5], [1, 0, 0]).distance > 49.4);

// Passable is still there to look at.
assert.equal(name(down(0, 100)), 'ghost');

// The arc is a mesh: its ring is found, its hole is not.
assert.equal(name(down(15, -100)), 'ring');
assert.equal(name(down(0, -100)), null);

// The nearer of two along the ray.
assert.equal(name(pickObstacle(obstacles, [-50, 0, 2], [1, 0, 0])), 'turned');
assert.equal(name(pickObstacle(obstacles, [300, 0, 2], [-1, 0, 0])), 'cup');
assert.equal(pickObstacle(obstacles, [0, 0, 100], [0, 0, 1]), null);

// The summary of the same world: counts by type, the arc's faces, and the
// largest mesh pointing back at it.
const summary = summarizeWorld({ obstacles, mapSize: 400 });
assert.equal(summary.obstacles, 5);
assert.deepEqual(summary.types, [['box', 2], ['pyramid', 2], ['mesh', 1]]);
assert.ok(summary.meshFaces > 16);
assert.equal(summary.largestMeshes[0].name, 'ring');
assert.equal(obstacles[summary.largestMeshes[0].index].name, 'ring');
assert.deepEqual(obstacleTextures({ wallTexture: 'boxwall', capTextureUrl: '//x/roof.png', capTexture: 'roof' }),
  ['boxwall', '//x/roof.png']);

console.log('world pick ok');
