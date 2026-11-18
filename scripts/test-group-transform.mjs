#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// A `group`'s transforms in the order written, as upstream's
// `MeshTransform::Tool::processTransforms` applies them, and its `team` on
// every base it places. reri.sandybees.com:6015 shifts each team's base
// triangle north and then spins it round the map's centre, inside a group
// scaled twice over.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { configureBzwParse, parseBZWMap } = require('../server/bzw-parse.cjs');

const MAP = `
world
  size 1700
end
define corner
  base
    position 0 -85 1
    size 30 30 9
    color 1
  end
  box
    position 0 -110 1
    size 60 2.5 9
  end
enddef
define allmap
  group corner
    shift 0 620 10
    spin -45 0 0 1
    team 1
  end
  group corner
    shift 0 620 10
    spin 75 0 0 1
    team 2
  end
  group corner
    spin 90 0 0 1
    shift 0 620 10
    team 3
  end
enddef
group allmap
  scale 2 2 1
end
`;

configureBzwParse({ log: () => {}, gameConfigDefaults: {} });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzo-group-transform-'));
const file = path.join(dir, 'groups.bzw');
fs.writeFileSync(file, MAP);
const world = parseBZWMap(file, { quiet: true });

// Where upstream puts a point of `corner`: through each op in turn, then
// `allmap`'s scale.
const place = (x, y, ops) => {
  let p = [x, y];
  for (const [type, a, b] of ops) {
    if (type === 'shift') p = [p[0] + a, p[1] + b];
    else {
      const r = (a * Math.PI) / 180;
      p = [(p[0] * Math.cos(r)) - (p[1] * Math.sin(r)), (p[0] * Math.sin(r)) + (p[1] * Math.cos(r))];
    }
  }
  return [p[0] * 2, p[1] * 2];
};
const near = (got, want, what) => assert.ok(Math.hypot(got[0] - want[0], got[1] - want[1]) < 0.01,
  `${what}: ${got.map((v) => v.toFixed(2))} not ${want.map((v) => v.toFixed(2))}`);

const bases = world.obstacles.filter((o) => o.kind === 'base').sort((a, b) => a.team - b.team);
assert.deepEqual(bases.map((b) => b.team), [1, 2, 3], "each group's team on the base it places");
near(bases[0].pos, place(0, -85, [['shift', 0, 620], ['spin', -45]]), 'shift then spin carries the shift round');
near(bases[1].pos, place(0, -85, [['shift', 0, 620], ['spin', 75]]), 'for every instance');
near(bases[2].pos, place(0, -85, [['spin', 90], ['shift', 0, 620]]), 'spin then shift turns it in place');
// The wall beside each base lands as it does, so the base stays inside.
const walls = world.obstacles.filter((o) => o.type === 'box' && o.kind !== 'base');
near(walls.map((w) => w.pos).find((p) => Math.hypot(p[0] - bases[0].pos[0], p[1] - bases[0].pos[1]) < 60),
  place(0, -110, [['shift', 0, 620], ['spin', -45]]), 'and the walls with it');
assert.ok(Math.abs(bases[0].angle - (-45 * Math.PI) / 180) < 1e-9, 'facing turned by the spin');

console.log('group transform tests passed');
