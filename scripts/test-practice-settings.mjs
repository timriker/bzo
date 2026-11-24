#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// Practice's own settings (public/js/practice.mjs): what is kept in the
// browser, and that a map's changed settings go into its config the way the
// map's own do.
import assert from 'node:assert/strict';
import { practiceConfig } from '../public/js/bzdb.mjs';
import {
  PRACTICE_DEFAULT_BOTS, PRACTICE_MAX_BOTS, practiceUrl, readPracticeChoice, readPracticeMapSettings,
  withPracticeMapSettings, writePracticeChoice, writePracticeMapSettings,
} from '../public/js/practice.mjs';

const storage = (() => {
  const items = new Map();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value)) };
})();

assert.deepEqual(readPracticeChoice(storage), { level: 'normal', bots: PRACTICE_DEFAULT_BOTS }, 'nothing kept yet');
writePracticeChoice({ level: 'hard', bots: 99 }, storage);
assert.deepEqual(readPracticeChoice(storage), { level: 'hard', bots: PRACTICE_MAX_BOTS }, 'kept, bots in range');

writePracticeMapSettings('a.bzw', { shotMaxActive: 3 }, storage);
writePracticeMapSettings('a.bzw', { jumping: true, title: 'not a setting' }, storage);
assert.deepEqual(readPracticeMapSettings('a.bzw', storage), { shotMaxActive: 3, jumping: true }, 'per map, merged');
assert.deepEqual(readPracticeMapSettings('b.bzw', storage), {}, 'another map has its own');

const base = { SHOT_MAX_ACTIVE: 1, SHOT_RANGE: 350, SHOT_SPEED: 100, ALLOW_JUMPING: false, ALL_SHOTS_RICOCHET: false };
const world = { gameplay: { SHOT_MAX_ACTIVE: 2 }, bzdb: { _disableBots: '1' } };
const plain = practiceConfig(base, world).config;
assert.equal(plain.SHOT_MAX_ACTIVE, 2, "the map's own -ms");
const changed = practiceConfig(base, {
  ...world,
  gameplay: withPracticeMapSettings(world.gameplay, readPracticeMapSettings('a.bzw', storage)),
}).config;
assert.equal(changed.SHOT_MAX_ACTIVE, 3, "the player's over the map's");
assert.equal(changed.ALLOW_JUMPING, true);
assert.equal(changed.SHOT_RELOAD_TIME, plain.SHOT_RELOAD_TIME * 2 / 3, 'reload follows the shot count');
assert.deepEqual(practiceConfig(base, world).bzdb, {}, '_disableBots is not practice\'s to keep');

assert.equal(practiceUrl({ level: 'easy', map: 'x y.bzw', bots: 4 }), '/?practice=easy&map=x+y.bzw&bots=4');

console.log('practice settings tests passed');
