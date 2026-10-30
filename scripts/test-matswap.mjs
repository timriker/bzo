#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// A `group`'s `matswap`, as upstream's ObstacleModifier composes it: a
// placement trades materials by identity, `a b` with `b a` trades both, the
// placement's own `matref` wins over its swaps, and an outer placement's
// swap applies to what an inner one's already swapped.
// whammo.bmbz.org:5154 places its base twice, the second red for green.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { configureBzwParse, parseBZWMap } = require('../server/bzw-parse.cjs');

const MAP = `
material
  name red
  diffuse 1 0 0 1
end
material
  name green
  diffuse 0 1 0 1
end
material
  name blue
  diffuse 0 0 1 1
end
define pad
  mesh
    vertex 0 0 0
    vertex 1 0 0
    vertex 1 1 0
    face
      vertices 0 1 2
      matref red
    endface
  end
  mesh
    vertex 0 0 1
    vertex 1 0 1
    vertex 1 1 1
    face
      vertices 0 1 2
      matref green
    endface
  end
enddef
define outer
  group pad
    matswap red blue
  end
enddef
group pad
  position 0 0 0
end
group pad
  position 10 0 0
  matswap red green
  matswap green red
end
group pad
  position 20 0 0
  matref blue
  matswap red green
end
group outer
  position 30 0 0
  matswap blue green
end
`;

configureBzwParse({ log: () => {}, gameConfigDefaults: {} });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzo-matswap-'));
const file = path.join(dir, 'map.bzw');
fs.writeFileSync(file, MAP);
const world = parseBZWMap(file, { quiet: true });
fs.rmSync(dir, { recursive: true, force: true });

const NAMES = { '1,0,0,1': 'red', '0,1,0,1': 'green', '0,0,1,1': 'blue' };
const colours = (prefix) => world.obstacles
  .filter((o) => o.type === 'mesh' && o.name.startsWith(prefix))
  .map((o) => NAMES[o.arrays.materials[0].color.join(',')]);

assert.deepEqual(colours('pad#0:'), ['red', 'green'], 'a plain placement keeps its materials');
assert.deepEqual(colours('pad#1:'), ['green', 'red'], 'two swaps trade both materials');
assert.deepEqual(colours('pad#2:'), ['blue', 'blue'], "a placement's own matref wins over its swaps");
assert.deepEqual(colours('outer#0:'), ['green', 'green'], "an outer swap applies to an inner swap's result");

console.log('matswap tests passed');
