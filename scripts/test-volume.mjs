#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_VOLUME_LEVEL,
  VOLUME_CHANNELS,
  VOLUME_MAX_LEVEL,
  VOLUME_MIN_LEVEL,
  clampVolumeLevel,
  formatVolumeLevel,
  readVolumeLevel,
  stepVolumeLevel,
  volumeLevelToGain,
  writeVolumeLevel,
} from '../public/js/volume.mjs';

// Every channel needs its own storage key, DOM ids, and XR row id, or two
// sliders end up driving one level.
const seen = new Set();
for (const channel of VOLUME_CHANNELS) {
  for (const key of ['id', 'storageKey', 'sliderId', 'valueId', 'xrId']) {
    assert.ok(channel[key], `channel ${channel.id} is missing ${key}`);
    assert.equal(seen.has(channel[key]), false, `duplicate ${key} ${channel[key]}`);
    seen.add(channel[key]);
  }
  assert.ok(channel.label, `channel ${channel.id} is missing a label`);
}
assert.deepEqual(VOLUME_CHANNELS.map((channel) => channel.id), ['game', 'voice', 'microphone']);

assert.equal(clampVolumeLevel(5), 5);
assert.equal(clampVolumeLevel('7'), 7);
assert.equal(clampVolumeLevel(4.4), 4);
assert.equal(clampVolumeLevel(4.5), 5);
assert.equal(clampVolumeLevel(-3), VOLUME_MIN_LEVEL);
assert.equal(clampVolumeLevel(99), VOLUME_MAX_LEVEL);
assert.equal(clampVolumeLevel(undefined), DEFAULT_VOLUME_LEVEL);
assert.equal(clampVolumeLevel('loud', 3), 3);

// Stepping stops at both ends rather than wrapping.
assert.equal(stepVolumeLevel(5, 1), 6);
assert.equal(stepVolumeLevel(5, -1), 4);
assert.equal(stepVolumeLevel(VOLUME_MAX_LEVEL, 1), VOLUME_MAX_LEVEL);
assert.equal(stepVolumeLevel(VOLUME_MIN_LEVEL, -1), VOLUME_MIN_LEVEL);

// Upstream's squared curve, scaled so the top of the range is unity.
assert.equal(volumeLevelToGain(VOLUME_MAX_LEVEL), 1);
assert.equal(volumeLevelToGain(VOLUME_MIN_LEVEL), 0);
assert.equal(volumeLevelToGain(5), 0.25);
assert.equal(volumeLevelToGain(20), 1);

assert.equal(formatVolumeLevel(0), 'Off');
assert.equal(formatVolumeLevel(5), '50%');
assert.equal(formatVolumeLevel(10), '100%');

const items = new Map();
const storage = {
  getItem: (key) => (items.has(key) ? items.get(key) : null),
  setItem: (key, value) => items.set(key, value),
};

assert.equal(readVolumeLevel(storage, 'bzo.volume.game'), DEFAULT_VOLUME_LEVEL);
assert.equal(writeVolumeLevel(storage, 'bzo.volume.game', 3), 3);
assert.equal(items.get('bzo.volume.game'), '3');
assert.equal(readVolumeLevel(storage, 'bzo.volume.game'), 3);

// A corrupt or absent store must not start the game silent.
items.set('bzo.volume.game', 'loud');
assert.equal(readVolumeLevel(storage, 'bzo.volume.game'), DEFAULT_VOLUME_LEVEL);
assert.equal(readVolumeLevel(null, 'bzo.volume.game'), DEFAULT_VOLUME_LEVEL);

const blocked = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
};
assert.equal(readVolumeLevel(blocked, 'bzo.volume.game'), DEFAULT_VOLUME_LEVEL);
assert.equal(writeVolumeLevel(blocked, 'bzo.volume.game', 2), 2);

// The channel table names the DOM rows it drives, the way SETTINGS_MENU_ITEMS
// does, so a renamed slider has to fail here rather than silently stop working.
const markup = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
for (const channel of VOLUME_CHANNELS) {
  assert.match(markup, new RegExp(`id="${channel.sliderId}"`), `index.html has no ${channel.sliderId}`);
  assert.match(markup, new RegExp(`id="${channel.valueId}"`), `index.html has no ${channel.valueId}`);
}

console.log('volume tests passed');
