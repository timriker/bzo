#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// bzfs keeps an arc, meshbox, cone or sphere whose size upstream's
// `makeMesh` refuses (`ArcObstacle::isValid` is always true), so it reaches
// clients in the world; each client drops it there and loads the rest. A
// zero-height `meshbox` with `phydrv deathy` on bmbz.org:5162 is the case
// that motivated this. bzo has to drop it with a warning, not fail the map.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { parseBZWMap } = require('../server/bzw-parse.cjs');

const cases = [
  ['zero-height meshbox', 'meshbox\n position 0 0 0\n size 300 300 0\nend\n', 'Not creating meshbox'],
  ['zero-height arc', 'arc\n position 0 0 0\n size 10 10 0\nend\n', 'Not creating arc'],
  ['zero-height cone', 'cone\n position 0 0 0\n size 10 10 0\nend\n', 'Not creating cone'],
  ['zero-radius sphere', 'sphere\n position 0 0 0\n size 0 0 0\nend\n', 'Not creating sphere'],
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzo-refused-'));
let failures = 0;
for (const [name, text, expected] of cases) {
  const file = path.join(dir, 'map.bzw');
  fs.writeFileSync(file, `${text}box\n position 50 50 0\n size 5 5 5\nend\n`);
  try {
    const world = parseBZWMap(file, { quiet: true });
    if (!world.warnedMessages.some((m) => m.startsWith(expected))) {
      failures++;
      console.error(`FAIL ${name}: no "${expected}" warning`);
    }
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}
fs.rmSync(dir, { recursive: true, force: true });

if (failures) process.exit(1);
console.log(`refused shapes: ${cases.length} cases OK`);
