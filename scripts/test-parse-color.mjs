#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// parseColorString as upstream's ParseColor.cxx reads a colour: numbers, an
// X11 name with an optional alpha, and nothing for what it would refuse.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseColorString } = require('../public/js/bzdb.mjs');

assert.deepEqual(parseColorString('0.5 0.25 1'), [0.5, 0.25, 1, 1]);
assert.deepEqual(parseColorString('.1 .2 .3 .4'), [0.1, 0.2, 0.3, 0.4]);
assert.deepEqual(parseColorString('black'), [0, 0, 0, 1]);
assert.deepEqual(parseColorString('DarkGrey'), parseColorString('darkgrey'), 'names are case-blind');
assert.deepEqual(parseColorString('red 0.5'), [1, 0, 0, 0.5], 'a name may carry an alpha');
assert.equal(parseColorString('grey3')[0], 0.031373, 'grey3 is not grey');
assert.equal(parseColorString('1 2'), null, 'two numbers are not a colour');
assert.equal(parseColorString('#ffffff'), null, 'upstream leaves # unfinished');
assert.equal(parseColorString('nonsense'), null);
assert.equal(parseColorString(''), null);

console.log('parse-color tests passed');
