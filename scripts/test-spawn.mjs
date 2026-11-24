#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// Where a tank spawns (public/js/spawn.mjs): on the ground only unless `-sb`
// lets it onto buildings, as upstream's SpawnPolicy does.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildCollisionColliders } from '../public/js/collision.mjs';
import { pickSpawnPosition, spawnsOnBuildings, SPAWN_DROP_FUDGE } from '../public/js/spawn.mjs';

const require = createRequire(import.meta.url);
const { parseBZWMap, buildWorldFile } = require('../server/bzw-parse.cjs');
const map = parseBZWMap(new URL('../maps/hix.bzw', import.meta.url).pathname, { quiet: true });
const world = JSON.parse(buildWorldFile(map, {
  gameConfig: {}, serverBzdb: new Map(), puffClouds: false, defaultMapSize: 800,
}).json);
const colliders = buildCollisionColliders(world.obstacles, world.mapSize, world.noWalls, world.wallHeight);

const heights = (onBuildings) => Array.from({ length: 200 }, () => pickSpawnPosition({
  colliders, mapSize: world.mapSize, config: { SPAWN_MAX_COMP_TIME: 0 }, onBuildings,
}).z);
assert.ok(heights(false).every((z) => Math.abs(z - SPAWN_DROP_FUDGE) < 1e-9), 'without -sb, the ground only');
assert.ok(heights(true).some((z) => z > 1), 'with -sb, on buildings too');

assert.equal(spawnsOnBuildings({}, null), false, 'upstream default: the ground');
assert.equal(spawnsOnBuildings({ SPAWN_ON_BUILDINGS: true }, null), true, '-sb');
assert.equal(spawnsOnBuildings({ SPAWN_ON_BUILDINGS: true }, null, true), false, 'bots stay on the ground');
assert.equal(spawnsOnBuildings({}, 2), true, 'a water level turns it on');
assert.equal(spawnsOnBuildings({}, 2, true), true, 'for bots too, over water');

console.log('spawn tests passed');
