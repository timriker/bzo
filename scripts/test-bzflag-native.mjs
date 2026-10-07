/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// What a BZFlag client is told of another tank's motion: MsgPlayerUpdate's
// velocity, which it dead-reckons by between updates. A zero there for a
// moving tank is a tank that stands still and snaps forward at each update.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { NativeTranslator } = require('../server/bzflag-native.cjs');
const { decodePlayerUpdate } = require('../server/bzfs-session.cjs');

const TANK_SPEED = 25;
const frames = [];
const translator = new NativeTranslator({
  selfSlot: 200,
  send: (code, payload) => frames.push({ code, payload: Buffer.from(payload) }),
  teamIndex: () => 0,
  config: () => ({ TANK_SPEED, TANK_ROTATION_SPEED: Math.PI / 4 }),
});
const velocityOf = (move) => {
  frames.length = 0;
  translator.playerUpdate({ id: '0', x: 0, y: 0, z: 0, a: 0, fs: 0, rs: 0, vv: 0, vx: 0, vy: 0, ...move });
  const frame = frames.find((f) => f.code === 'pu');
  return decodePlayerUpdate(frame.payload, false).velocity;
};
const near = (actual, expected, message) => {
  for (let i = 0; i < 3; i += 1) {
    assert.ok(Math.abs(actual[i] - expected[i]) < 1e-3, `${message}: ${actual} != ${expected}`);
  }
};

near(velocityOf({ a: 0, fs: 1 }), [TANK_SPEED, 0, 0], 'full speed east');
near(velocityOf({ a: Math.PI / 2, fs: 0.5 }), [0, TANK_SPEED / 2, 0], 'half speed north');
near(velocityOf({ a: 0, fs: -0.5 }), [-TANK_SPEED / 2, 0, 0], 'reversing');
near(velocityOf({ a: 0, fs: 0 }), [0, 0, 0], 'standing still');
// Sliding: the speed is along `sd`, not the heading.
near(velocityOf({ a: 0, fs: 1, sd: Math.PI / 2 }), [0, TANK_SPEED, 0], 'sliding north while facing east');
// In the air the move carries the velocity itself.
near(velocityOf({ a: 0, fs: 1, vx: 3, vy: 4, vv: 5 }), [3, 4, 5], 'airborne');
near(velocityOf({ a: 0, fs: 1, vv: -2 }), [0, 0, -2], 'falling straight down');

console.log('test-bzflag-native: ok');
