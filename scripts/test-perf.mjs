/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The growth tracking behind a `renderer.stats` line. A leak is a trend and no
// single sample can show one, so these are the parts that turn a series of
// samples into one -- and the part that has to stay quiet when nothing is
// leaking, because a line full of `+0` is a line nobody reads.

import assert from 'node:assert/strict';
import { describeGrowth, getHeapUsedMB, noteGrowth } from '../public/perf.js';

// The first sighting of a counter is the baseline, and a baseline is not growth.
assert.equal(noteGrowth('a', 100), null, 'the first sample sets the baseline');
assert.equal(noteGrowth('a', 100), null, 'and an unchanged counter is silent');
assert.equal(noteGrowth('a', 112), 12);
// Measured from the baseline every time, not from the previous sample: what
// matters is how far a counter has drifted since the page loaded, not the last
// five minutes of it.
assert.equal(noteGrowth('a', 120), 20);
assert.equal(noteGrowth('a', 100), null, 'back where it started is silent again');
// Shrinking is worth seeing too -- a count that falls after a reconnect is the
// evidence that the reconnect is what clears the leak.
assert.equal(noteGrowth('a', 90), -10);

// Each counter keeps its own baseline.
assert.equal(noteGrowth('b', 5), null);
assert.equal(noteGrowth('b', 6), 1);
assert.equal(noteGrowth('a', 100), null, 'b did not disturb a');

// Fractions survive to one place, which is what a heap figure in MB needs.
assert.equal(noteGrowth('heapish', 10.25), null);
assert.equal(noteGrowth('heapish', 50.75), 40.5);

// Anything that is not a number is not a measurement.
assert.equal(noteGrowth('junk', undefined), null);
assert.equal(noteGrowth('junk', NaN), null);
assert.equal(noteGrowth('junk', 'lots'), null);

// The stats line's own field. Absent entirely while nothing moves, which is the
// common case and the reason it is one field rather than a delta beside every
// counter.
assert.equal(describeGrowth({ objects: 300, textures: 46 }), null, 'first sample');
assert.equal(describeGrowth({ objects: 300, textures: 46 }), null, 'nothing moved');
assert.equal(describeGrowth({ objects: 312, textures: 46 }), 'objects+12',
  'only the counter that moved');
assert.equal(describeGrowth({ objects: 312, textures: 49 }), 'objects+12,textures+3');
// Named in the order given, so the caller decides what a reader sees first.
assert.equal(describeGrowth({ textures: 50, objects: 312 }), 'textures+4,objects+12');
assert.equal(describeGrowth({ objects: 290, textures: 46 }), 'objects-10');
assert.equal(describeGrowth({}), null);

// `performance.memory` is Chrome and Edge only. Node has no such thing, so this
// is the "absent" branch -- and absent is null rather than zero, because a zero
// would read as "no memory used" beside another browser's real figure.
{
  const original = performance.memory;
  assert.equal(getHeapUsedMB(), null, 'no performance.memory, no field');

  // And the present branch, in MB to one decimal place.
  Object.defineProperty(performance, 'memory', {
    value: { usedJSHeapSize: 76 * 1024 * 1024 },
    configurable: true,
  });
  assert.equal(getHeapUsedMB(), 76);
  Object.defineProperty(performance, 'memory', {
    value: { usedJSHeapSize: 1572864 },
    configurable: true,
  });
  assert.equal(getHeapUsedMB(), 1.5);
  // A browser that has the object but not the number is the absent case too.
  Object.defineProperty(performance, 'memory', { value: {}, configurable: true });
  assert.equal(getHeapUsedMB(), null);
  if (original === undefined) delete performance.memory;
}

console.log('perf tests passed');
