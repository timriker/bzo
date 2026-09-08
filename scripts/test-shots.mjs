import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  MAX_SHOT_SLOTS,
  normalizeShotSlotCount,
  WORLD_WEAPON_PLAYER_ID,
  WORLD_WEAPON_NAME,
  WORLD_WEAPON_TEAM,
  WORLD_WEAPON_DEFAULT_DELAY,
  WORLD_WEAPON_MIN_DELAY,
  normalizeWorldWeaponDelays,
  getWorldWeaponDirection,
} from '../public/shots.mjs';

const require = createRequire(import.meta.url);
const serverLimits = require('../server/shots.cjs');

assert.equal(MAX_SHOT_SLOTS, 64);
assert.equal(serverLimits.MAX_SHOT_SLOTS, MAX_SHOT_SLOTS);
assert.equal(normalizeShotSlotCount(1), 1);
assert.equal(normalizeShotSlotCount(3), 3);
assert.equal(normalizeShotSlotCount('3'), 3);
assert.equal(normalizeShotSlotCount(MAX_SHOT_SLOTS), MAX_SHOT_SLOTS);
assert.equal(normalizeShotSlotCount(MAX_SHOT_SLOTS + 1), MAX_SHOT_SLOTS);
assert.equal(normalizeShotSlotCount(0), 1);
assert.equal(normalizeShotSlotCount(-1), 1);
assert.equal(normalizeShotSlotCount(1.5), 1);
assert.equal(normalizeShotSlotCount(Number.POSITIVE_INFINITY), 1);
assert.equal(normalizeShotSlotCount(Number.MAX_SAFE_INTEGER + 1), 1);
assert.equal(normalizeShotSlotCount(null), 1);
assert.equal(normalizeShotSlotCount(undefined), 1);

for (const value of [1, 3, '3', MAX_SHOT_SLOTS, MAX_SHOT_SLOTS + 1, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, null, undefined]) {
  assert.equal(
    serverLimits.normalizeShotSlotCount(value),
    normalizeShotSlotCount(value),
    `client/server normalization diverged for ${String(value)}`
  );
}

// --- World weapons -----------------------------------------------------------
{
  // PlayerId ServerPlayer (Address.h:75), which is what upstream stamps on every
  // shot nobody fired -- 253, and not the 252 next to it, which is the admin
  // channel.
  assert.equal(WORLD_WEAPON_PLAYER_ID, 253);
  assert.equal(serverLimits.WORLD_WEAPON_PLAYER_ID, WORLD_WEAPON_PLAYER_ID);

  // CustomWeapon's defaults and its floor on a delay.
  assert.equal(WORLD_WEAPON_DEFAULT_DELAY, 10);
  assert.equal(WORLD_WEAPON_MIN_DELAY, 0.1);
  assert.deepEqual(normalizeWorldWeaponDelays([]), [10], 'no delay is ten seconds');
  assert.deepEqual(normalizeWorldWeaponDelays(undefined), [10]);
  assert.deepEqual(normalizeWorldWeaponDelays(['6']), [6], 'stated as text in a BZW');
  assert.deepEqual(normalizeWorldWeaponDelays([2, 1, 3]), [2, 1, 3], 'a rhythm, not a rate');
  // Under the floor is dropped, and dropping every entry leaves the default.
  assert.deepEqual(normalizeWorldWeaponDelays([0.05, 4]), [4]);
  assert.deepEqual(normalizeWorldWeaponDelays([0.05]), [10]);
  assert.deepEqual(normalizeWorldWeaponDelays([0.1]), [0.1], 'the floor itself is allowed');
  assert.deepEqual(normalizeWorldWeaponDelays(['x', -3, null]), [10]);

  // WorldPlayer's collective identity: one pseudo-player for every world weapon
  // on the map, on the rogue team, and no name per weapon because a BZW cannot
  // give one.
  assert.equal(WORLD_WEAPON_NAME, 'world weapon');
  assert.equal(WORLD_WEAPON_TEAM, 'rogue');
  assert.equal(serverLimits.WORLD_WEAPON_NAME, WORLD_WEAPON_NAME);
  assert.equal(serverLimits.WORLD_WEAPON_TEAM, WORLD_WEAPON_TEAM);

  // bz_vectorFromRotations, in bzo's axes. A weapon at rotation 0 fires along
  // BZFlag +x, which is bzo +x.
  const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-9, `${message}: ${a} != ${b}`);
  const east = getWorldWeaponDirection(0, 0);
  close(east.x, 1, 'rotation 0 is +x');
  close(east.y, 0, 'and level');
  close(east.z, 0, 'and nothing across');

  // BZFlag +y is north, which is bzo -z, so rotation 90 fires at bzo -z. That is
  // what aims `fountains.bzw`'s lasers down the length of the map: the one at
  // BZW y -190 has rotation 90 and has to fire towards the middle.
  const north = getWorldWeaponDirection(Math.PI / 2, 0);
  close(north.x, 0, 'rotation 90 has nothing along x');
  close(north.z, -1, 'and fires towards bzo -z');
  const south = getWorldWeaponDirection(3 * Math.PI / 2, 0);
  close(south.z, 1, 'rotation 270 fires the other way');
  const west = getWorldWeaponDirection(Math.PI, 0);
  close(west.x, -1, 'rotation 180 is -x');

  // Tilt is the vertical angle, and it is bzo's +y.
  const up = getWorldWeaponDirection(0, Math.PI / 2);
  close(up.y, 1, 'straight up');
  close(up.x, 0, 'with nothing left along the ground');
  const half = getWorldWeaponDirection(0, Math.PI / 4);
  close(half.y, Math.SQRT1_2, 'and a unit vector at any tilt');
  close(half.x, Math.SQRT1_2);
  for (const [rotation, tilt] of [[0, 0], [1, 0.3], [2.5, -0.7], [Math.PI, 1.2]]) {
    const dir = getWorldWeaponDirection(rotation, tilt);
    close(Math.hypot(dir.x, dir.y, dir.z), 1, `unit length at ${rotation}/${tilt}`);
    assert.deepEqual(serverLimits.getWorldWeaponDirection(rotation, tilt), dir,
      'client/server weapon aim diverged');
  }
}

console.log('Shot slot limit tests passed');
