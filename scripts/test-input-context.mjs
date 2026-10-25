/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

import assert from 'node:assert/strict';
import { INPUT_CONTEXT, InputContextManager } from '../public/js/input-context.mjs';

let resetCount = 0;
const manager = new InputContextManager({
  resetGameplayInput: () => {
    resetCount++;
  },
});

assert.equal(manager.getContext(), INPUT_CONTEXT.GAMEPLAY);
assert.equal(manager.isGameplayActive(), true);

assert.equal(manager.setContext(INPUT_CONTEXT.DIALOG), true);
assert.equal(manager.getContext(), INPUT_CONTEXT.DIALOG);
assert.equal(manager.isGameplayActive(), false);
assert.equal(resetCount, 1);

assert.equal(manager.setContext(INPUT_CONTEXT.DIALOG), false);
assert.equal(resetCount, 1);

assert.equal(manager.setContext(INPUT_CONTEXT.GAMEPLAY), true);
assert.equal(manager.isGameplayActive(), true);
assert.equal(resetCount, 2);

assert.throws(() => manager.setContext('unknown'), /Unknown input context/);

console.log('input context tests passed');