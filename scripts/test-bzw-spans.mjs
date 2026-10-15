#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Source spans (docs/editor-plan.md): every object the parser returns knows
// the block it came from, a copy a `group` placed knows the `group` blocks
// that placed it, and none of it reaches the world JSON.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseBZWMap } = require('../server/bzw-parse.cjs');

const text = `# spans
box
  pos 0 0 0
  size 5 5 5
end

box
  name Named
  pos 20 0 0
  size 5 5 5
end
define tower
  box
    pos 0 0 0
    size 2 2 10
  end
  arc
    pos 0 0 10
    size 4 4 2
  end
enddef
define pair
  group tower
    shift 5 0 0
  end
  group tower
    shift -5 0 0
  end
enddef
group pair
  shift 50 50 0
end
zone
  pos -50 -50 0
  size 5 5 5
  flag GM
end
physics
  name slide
  linear 1 0 0
end
`;
const block = (s) => text.slice(s.start, s.end);
const lineOf = (needle) => text.slice(0, text.indexOf(needle)).split('\n').length;
const map = parseBZWMap('spans.bzw', { quiet: true, text });

const [first, named] = map.obstacles;
assert.equal(block(first.source), 'box\n  pos 0 0 0\n  size 5 5 5\nend\n');
assert.deepEqual([first.source.startLine, first.source.endLine], [2, 5]);
assert.ok(block(named.source).startsWith('box\n  name Named'));
assert.equal(named.placedBy, undefined);

// Two towers in one pair: a box and an arc (a mesh by then) each, four copies
// in all, each from its own line in the define and placed by the outer
// `group pair` and then one of the two inner `group tower`s.
const placed = map.obstacles.filter((o) => o.placedBy);
assert.equal(placed.length, 4);
const outer = lineOf('group pair');
const inner = [lineOf('group tower\n    shift 5'), lineOf('group tower\n    shift -5')];
for (const o of placed) {
  assert.ok(['box', 'arc'].includes(block(o.source).split('\n')[0].trim()));
  assert.equal(o.placedBy.length, 2);
  assert.equal(o.placedBy[0].startLine, outer);
  assert.ok(inner.includes(o.placedBy[1].startLine));
  assert.ok(block(o.placedBy[1]).trimEnd().endsWith('end'));
}
assert.equal(new Set(placed.map((o) => `${o.source.start}/${o.placedBy[1].start}`)).size, 4);

assert.equal(map.zones[0].source.startLine, lineOf('zone'));
assert.ok(block(map.zones[0].source).trimEnd().endsWith('end'));
const slide = Object.values(map.physicsDrivers).find((d) => d.name === 'slide') || map.physicsDrivers[0];
assert.equal(slide.source.startLine, lineOf('physics'));
assert.equal(block(slide.source), 'physics\n  name slide\n  linear 1 0 0\nend\n');

// Hidden from JSON, so the world sent to clients and its cache hash are
// unchanged.
assert.ok(!JSON.stringify(map).includes('startLine'));
assert.ok(!JSON.stringify(map).includes('placedBy'));

// Every shipped map: every obstacle has a span that reads as a whole block.
for (const file of ['bzo.bzw', 'hix.bzw', 'pizza_box.bzw']) {
  const path = new URL(`../maps/${file}`, import.meta.url).pathname;
  const source = fs.readFileSync(path, 'utf8');
  for (const o of parseBZWMap(path, { quiet: true }).obstacles) {
    assert.ok(o.source, `${file} ${o.name}: no span`);
    const lines = source.slice(o.source.start, o.source.end).trim().split('\n');
    assert.match(lines[0].trim(), /^[a-z]/, `${file} ${o.name}`);
    assert.match(lines.at(-1).trim(), /^end\b/, `${file} ${o.name}`);
  }
}

console.log('bzw spans ok');
