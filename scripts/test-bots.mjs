/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Server-run bots (`server/bots.cjs`): the fill rule, and the driver a bot's
// tank moves by, on an empty world.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planBotFill, pickBotToRemove, BotDriver } = require('../server/bots.cjs');

// The fill: bots make up the roster to `fill`, and none once people do.
assert.equal(planBotFill({ fill: 4, humans: 0, bots: 0 }), 4);
assert.equal(planBotFill({ fill: 4, humans: 1, bots: 3 }), 0);
assert.equal(planBotFill({ fill: 4, humans: 2, bots: 3 }), -1, 'a person joining takes a bot\'s place');
assert.equal(planBotFill({ fill: 4, humans: 1, bots: 2 }), 1, 'a person leaving gives one back');
assert.equal(planBotFill({ fill: 4, humans: 5, bots: 1 }), -1, 'four or more people, no bots');
assert.equal(planBotFill({ fill: 0, humans: 0, bots: 2 }), -2);

// The bot that leaves is on the biggest team.
{
  const sizes = new Map([['red', 3], ['blue', 1]]);
  const chosen = pickBotToRemove([{ id: 'a', team: 'blue' }, { id: 'b', team: 'red' }], sizes);
  assert.equal(chosen.id, 'b');
}

const CONFIG = {
  TANK_SPEED: 25,
  TANK_ROTATION_SPEED: Math.PI / 4,
  GRAVITY: 9.8,
  JUMP_VELOCITY: 19,
  ALLOW_JUMPING: true,
  MAX_BUMP_HEIGHT: 0.33,
};

function makeDriver(think, flag = null) {
  const sent = [];
  const driver = new BotDriver({
    pilot: { think },
    env: {
      config: () => CONFIG,
      flag: () => flag,
      colliders: () => [],
      topOf: () => 0,
      state: () => ({ alive: true, x: 0, y: 0, z: 0, azimuth: Math.PI / 2 }),
      view: (self) => ({ self }),
      send: (message) => sent.push(message),
      act: () => {},
    },
  });
  return { driver, sent };
}

// Full speed ahead for a second covers the world's tank speed, northwards, and
// says so on the wire.
{
  const { driver, sent } = makeDriver(() => ({ speed: 1, rotation: 0 }));
  for (let i = 0; i < 20; i++) driver.tick(0.05);
  assert.ok(Math.abs(driver.y - 25) < 0.01, `drove to y=${driver.y}`);
  assert.ok(Math.abs(driver.x) < 1e-9);
  const moves = sent.filter((message) => message.type === 'm');
  assert.ok(moves.length >= 1);
  assert.ok(Math.abs(moves.at(-1).fs - 1) < 0.01, 'fs reports the speed made');
}

// A jump rises and comes down where it left, and reports both ends.
{
  let jumped = false;
  const { driver, sent } = makeDriver(() => {
    const jump = !jumped;
    jumped = true;
    return { speed: 0, rotation: 0, jump };
  });
  let peak = 0;
  for (let i = 0; i < 100; i++) {
    driver.tick(0.05);
    peak = Math.max(peak, driver.z);
  }
  const expected = (CONFIG.JUMP_VELOCITY ** 2) / (2 * CONFIG.GRAVITY);
  assert.ok(Math.abs(peak - expected) < 1.5, `peak ${peak.toFixed(2)} near ${expected.toFixed(2)}`);
  assert.equal(driver.z, 0, 'back on the ground');
  assert.equal(driver.jumpDirection, null);
  const airborne = sent.filter((message) => message.type === 'm' && message.air === 1);
  assert.ok(airborne.length >= 1 && airborne[0].vv > 18, 'the take-off is reported');
}

// A shot leaves the muzzle, after a move that says where from.
{
  const { driver, sent } = makeDriver(() => ({ speed: 0, rotation: 0, fire: true }));
  driver.tick(0.05);
  const shoot = sent.findIndex((message) => message.type === 'shoot');
  assert.ok(shoot > 0 && sent[shoot - 1].type === 'm', 'a move rides ahead of the shot');
  assert.ok(Math.abs(sent[shoot].y - 3) < 1e-9 && Math.abs(sent[shoot].z - 1.57) < 1e-9);
  assert.deepEqual([sent[shoot].vx, sent[shoot].vy, sent[shoot].vz].map((v) => Math.round(v * 1e6) / 1e6),
    [0, 100, 0], 'a standing tank fires at the shot speed');
}

// A moving tank's shot carries its velocity on top of the shot speed, as the
// move riding ahead of it reports it.
{
  const { driver, sent } = makeDriver(() => ({ speed: 1, rotation: 0, fire: false }));
  for (let i = 0; i < 40; i++) driver.tick(0.05);
  driver.fire();
  const shot = sent.at(-1);
  const move = sent.findLast((message) => message.type === 'm');
  assert.equal(shot.type, 'shoot');
  assert.ok(Math.abs(shot.vy - (100 + (move.fs * CONFIG.TANK_SPEED * Math.sin(move.a)))) < 1e-9, `shot vy ${shot.vy}`);
  assert.equal(shot.vz, 0, 'level unless the world keeps vertical velocity');
}

// A bot drives by the same step as a browser's tank, flag and all: holding
// Burrow it sinks into the ground, and turns slower once it is there.
{
  const { driver } = makeDriver(() => ({ speed: 0, rotation: 1 }), { type: 'BU', zoned: false });
  for (let i = 0; i < 20; i++) driver.tick(0.05);
  assert.ok(driver.z < -1, `burrowed to ${driver.z.toFixed(2)}`);
  const turnRate = driver.self().turnRate;
  assert.ok(turnRate < CONFIG.TANK_ROTATION_SPEED * 0.6, `turns at ${turnRate.toFixed(2)} underground`);
}

console.log('bot tests passed');
