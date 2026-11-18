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
const { NativeTranslator, moveFromBzfs } = require('../server/bzflag-native.cjs');
const { decodePlayerUpdate, decodeFlagUpdate, decodeShotBegin } = require('../server/bzfs-session.cjs');
const { channelTeam, teamChannel } = require('../server/player-ids.cjs');

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

// Team chat goes by upstream's numbers both ways: 251 Rogue down to 244
// Hunter (`FirstTeam - team`), and a native client is sent the same byte.
assert.equal(teamChannel(1), 250, 'red');
assert.equal(channelTeam(250), 1);
assert.equal(channelTeam('251'), 0, 'rogue, either spelling');
assert.equal(channelTeam(244), 7, 'hunter');
assert.equal(channelTeam(243), null, 'a player');
assert.equal(channelTeam(252), null, 'the admins');
assert.equal(channelTeam(undefined), null);
assert.equal(translator.sourceSlot(250), 250, 'a team passes through to a native client');
assert.equal(translator.sourceSlot(252), 252);
assert.equal(translator.sourceSlot('7'), 7);

// A server shot reaches a native client from `ServerPlayer`, which the client
// files under its world weapons, and a guided one with its target named in
// the MsgGMUpdate that follows.
translator.accepted = true;
frames.length = 0;
translator.handle({
  type: 'shotBegin', id: 'p1', playerId: 253, shotSlot: -1, x: 1, y: 2, z: 3,
  vx: -100, vy: 0, vz: 0, team: 'rogue', flag: 'GM', target: '7', speed: 100,
  dirX: -1, dirY: 0, dirZ: 0,
});
const begin = frames.find((frame) => frame.code === 'sb');
assert.equal(begin.payload.readUInt8(4), 253, 'shot from ServerPlayer');
const update = frames.find((frame) => frame.code === 'gm');
assert.ok(update, 'and a MsgGMUpdate');
assert.equal(update.payload.readUInt8(0), 253);
assert.equal(update.payload.readUInt8(update.payload.length - 1), 7, 'naming the target');

// Chat a BZFlag client cannot draw -- Cyrillic folds to nothing -- is read in
// the writer's English copy where the line came with one, and dropped as
// before where it did not (docs/chat-translation-plan.md).
const chatTo = (message) => {
  frames.length = 0;
  translator.handle({ type: 'message', src: '3', dst: -1, msgType: 'chat', ts: 0, ...message });
  return frames.filter((frame) => frame.code === 'mg').map((frame) => frame.payload.subarray(3).toString('latin1').replace(/\0+$/, ''));
};
assert.deepEqual(chatTo({ text: 'привет всем' }), [], 'a line that folds to nothing is not sent');
assert.deepEqual(chatTo({ text: 'привет всем', en: 'hello everyone' }), ['hello everyone'], 'its English copy is');
assert.deepEqual(chatTo({ text: 'hello' }), ['hello'], 'a plain line as written');

// On a physics driver a BZFlag client is sent the whole velocity and turn, the
// driver's in them, and the driver named; what it sends back is turned into
// the tank's own motion again, the driver named as `pd`. A move goes round
// unchanged.
{
  const drivers = [
    { index: 0, linear: [0, -50, 0], angular: null },
    { index: 1, linear: null, angular: [Math.PI / 2, 100, 0] },
  ];
  const config = { TANK_SPEED, TANK_ROTATION_SPEED: Math.PI / 4 };
  const sent = [];
  const native = new NativeTranslator({
    selfSlot: 200,
    send: (code, payload) => sent.push({ code, payload: Buffer.from(payload) }),
    teamIndex: () => 0,
    config: () => config,
    driverAt: (index) => drivers[index] ?? null,
  });
  const roundTrip = (move) => {
    sent.length = 0;
    native.playerUpdate({ id: '0', z: 0, vv: 0, vx: 0, vy: 0, ...move });
    const update = decodePlayerUpdate(sent.find((f) => f.code === 'pu').payload, false);
    return { update, back: moveFromBzfs(update, config, (index) => drivers[index] ?? null) };
  };
  const conveyor = roundTrip({ x: 10, y: 0, a: 0, fs: 1, rs: 0, pd: 0 });
  near(conveyor.update.velocity, [TANK_SPEED, -50, 0], 'the conveyor in the velocity');
  assert.equal(conveyor.update.phydrv, 0, 'and named');
  assert.equal(conveyor.back.fs, 1, 'the tank\'s own speed back out');
  assert.equal(conveyor.back.pd, 0);
  const turntable = roundTrip({ x: 110, y: 0, a: Math.PI / 2, fs: 0.5, rs: 0.5, pd: 1 });
  near(turntable.update.velocity, [0, (TANK_SPEED / 2) + ((Math.PI / 2) * 10), 0], 'the carry in the velocity');
  assert.ok(Math.abs(turntable.update.angVel - (((Math.PI / 4) * 0.5) + (Math.PI / 2))) < 1e-6, 'and the spin in the turn');
  assert.equal(turntable.back.fs, 0.5);
  assert.equal(turntable.back.rs, 0.5);
  assert.equal(turntable.back.pd, 1);
  const plain = roundTrip({ x: 0, y: 0, a: 0, fs: 1, rs: 0 });
  assert.equal(plain.update.phydrv, 0, 'no driver, none named');
  assert.equal(plain.update.status & (1 << 7), 0);
  assert.equal(plain.back.pd, undefined);
}

// A waypoint, as a BZFlag client is shown one: its own team's flag in the
// spare slot, hovering out of a grab's reach; the label from the server; and
// a server shot straight up from clear over the point. Clearing it takes the
// flag away and stops the shots.
{
  const sent = [];
  const waypoints = new NativeTranslator({
    selfSlot: 3,
    send: (code, payload) => sent.push({ code, payload: Buffer.from(payload) }),
    teamIndex: (team) => ({ rogue: 0, red: 1, blue: 3 }[team] ?? 0),
    config: () => ({ TANK_SPEED, TANK_ROTATION_SPEED: Math.PI / 4, SHOT_SPEED: 100 }),
    waypointFlagIndex: () => 7,
  });
  waypoints.accepted = true;
  waypoints.selfBzoId = '9';
  waypoints.players.set('9', { id: '9', team: 'blue' });
  waypoints.handle({ type: 'waypoint', x: 10, y: 20, z: 2, label: 'Checkpoint 1 of 5' });
  const flag = decodeFlagUpdate(sent.find((f) => f.code === 'fu').payload)[0];
  assert.equal(flag.index, 7, 'in the spare slot');
  assert.equal(flag.type, 'B*', "the player's own team's flag");
  assert.equal(flag.status, 1, 'on the ground');
  near(flag.position, [10, 20, 2.3], 'hovering out of reach of a grab');
  assert.ok(sent.some((f) => f.code === 'mg' && f.payload.includes('Checkpoint 1 of 5')), 'the label, once');
  const shot = decodeShotBegin(sent.find((f) => f.code === 'sb').payload);
  assert.equal(shot.player, 253, "the server's");
  near(shot.pos, [10, 20, 12], 'from clear over the point');
  near(shot.velocity, [0, 0, 100], 'straight up');
  assert.equal(shot.flag, 'PZ', 'a zoned shot, through whatever covers the point');
  assert.ok(waypoints.waypointTimer, 'and again every half second');
  sent.length = 0;
  waypoints.handle({ type: 'waypoint' });
  assert.equal(decodeFlagUpdate(sent.find((f) => f.code === 'fu').payload)[0].status, 0, 'cleared, the flag goes');
  assert.equal(waypoints.waypointTimer, null, 'and the shots stop');
  waypoints.handle({ type: 'waypoint', x: 0, y: 0 });
  waypoints.close();
  assert.equal(waypoints.waypointTimer, null, 'as they do when the connection closes');
}

// A shot the server refused, where shots need a flag, ends on the client that
// fired it: MsgShotEnd for its own slot and shot, faded rather than exploded.
{
  const sent = [];
  const native = new NativeTranslator({
    selfSlot: 4,
    send: (code, payload) => sent.push({ code, payload: Buffer.from(payload) }),
    teamIndex: () => 0,
    config: () => ({ TANK_SPEED, TANK_ROTATION_SPEED: Math.PI / 4, SHOT_SPEED: 100 }),
  });
  native.accepted = true;
  native.endOwnShot(12);
  const end = sent.find((f) => f.code === 'se').payload;
  assert.deepEqual([end.readUInt8(0), end.readUInt16BE(1), end.readUInt16BE(3)], [4, 12, 1]);
}

console.log('test-bzflag-native: ok');
