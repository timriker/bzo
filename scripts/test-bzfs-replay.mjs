#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// A bzfs recording read and written by `server/bzfs-replay.cjs`: the bundled
// sample, `replays/hix-robots.rec`, and one built here to reach what the
// sample does not. The built one's packets come from `NativeTranslator`,
// which packs bzo's game as bzfs would broadcast it. Both are read back by
// `BzfsSession.handleFrame`, the proxy's decoder.
//
// `node scripts/test-bzfs-replay.mjs <file>` reads any other recording, for
// one made with `/record` (docs/replay.md).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  PACKET_MODE, HEADER_SIZE, PACKET_HEADER_SIZE, readReplay, writeReplay, snapshotAt,
} = require('../server/bzfs-replay.cjs');
const { BzfsSession } = require('../server/bzfs-session.cjs');
const { NativeTranslator } = require('../server/bzflag-native.cjs');
const { compileBzwWorld } = require('../server/bzw-compile.cjs');
const { packWorldDatabase } = require('../server/bzflag-world.cjs');
const { parseWorldDatabase } = require('../server/remote-world-import.cjs');

// Every mode-0 and mode-1 packet through a socketless session, as a replay
// room will; mode 2 is an empty marker and mode 3 is never sent.
function decode(replay) {
  const session = new BzfsSession({ host: '', port: 0, callsign: 'viewer' });
  for (const packet of replay.packets) {
    if (packet.mode === PACKET_MODE.REAL || packet.mode === PACKET_MODE.STATE) {
      session.handleFrame(packet.code, packet.payload);
    }
  }
  return session.state;
}

const file = process.argv[2];
if (file) {
  const replay = readReplay(fs.readFileSync(file));
  const state = decode(replay);
  const world = parseWorldDatabase(replay.world);
  console.log(`${file}: ${(replay.fileTime / 1e6).toFixed(1)} s by ${replay.callsign}, `
    + `${replay.protocol} ${replay.appVersion}, ${replay.packets.length} packets, `
    + `${replay.snapshots.length} snapshots, world v${world.mapVersion}`);
  console.log(`  players: ${[...state.players.values()].map((p) => p.callsign).join(', ')}`);
  process.exit(0);
}

const T0 = 1_760_000_000_000_000;
const packets = [];
let now = T0;
const record = (mode) => (code, payload) => packets.push({ mode, code, time: now, payload: Buffer.from(payload) });
const teams = { rogue: 0, red: 1, green: 2, blue: 3, purple: 4, observer: 5 };
const translatorFor = (mode) => new NativeTranslator({
  selfSlot: 200,
  send: record(mode),
  teamIndex: (team) => teams[team] ?? 0,
  config: () => ({ TANK_ROTATION_SPEED: Math.PI / 4 }),
});
const real = translatorFor(PACKET_MODE.REAL);
const state = translatorFor(PACKET_MODE.STATE);
const ann = { id: '0', name: 'ann', motto: '', team: 'red', wins: 0, losses: 0, tks: 0 };
const bob = { id: '1', name: 'bob', motto: 'hi', team: 'blue', wins: 0, losses: 0, tks: 0 };

real.addPlayer(ann);
real.addPlayer(bob);
real.alive({ ...ann, x: 10, y: 0, z: 20, rotation: 0 });
now += 500_000;
real.playerUpdate({ id: '0', x: 11, y: 0, z: 20, r: 0, vx: 2, vz: 0, vv: 0, rs: 0 });
// The marker, then everything a new viewer needs, as `Record::sendStates`
// writes it every 10 s.
now = T0 + 10_000_000;
packets.push({ mode: PACKET_MODE.UPDATE, code: '\0\0', time: now, payload: Buffer.alloc(0) });
state.addPlayer({ ...ann, wins: 1 });
state.addPlayer({ ...bob, losses: 1 });
packets.push({ mode: PACKET_MODE.HIDDEN, code: 'mg', time: now, payload: Buffer.from('private') });
now += 250_000;
real.scores([{ id: '0', wins: 1, losses: 0, tks: 0 }, { id: '1', wins: 0, losses: 1, tks: 0 }]);
real.playerUpdate({ id: '1', x: -5, y: 0, z: 3, r: 1, vx: 0, vz: 0, vv: 0, rs: 0.5 });

const world = packWorldDatabase(compileBzwWorld('box\n  position 0 0 0\n  size 10 10 5\nend\n'));
const source = {
  player: 200, callsign: 'recorder', motto: '', protocol: 'BZFS0221',
  appVersion: 'bzo test', worldHash: 'p0123', worldSettings: Buffer.alloc(34, 7),
  flagTypes: Buffer.from([0, 0]), world, packets,
};
const bytes = writeReplay(source);
const replay = readReplay(bytes);

// The header, as `saveHeader` lays it out.
assert.equal(bytes.toString('latin1', 0, 4), 'rrBZ');
assert.equal(bytes.readUInt32BE(8), HEADER_SIZE + 2 + world.length);
assert.equal(replay.callsign, 'recorder');
assert.equal(replay.protocol, 'BZFS0221');
assert.equal(replay.appVersion, 'bzo test');
assert.equal(replay.worldHash, 'p0123');
assert.equal(replay.player, 200);
assert.deepEqual([...replay.worldSettings], Array(34).fill(7));
assert.equal(replay.fileTime, 10_250_000);
assert.deepEqual(parseWorldDatabase(replay.world).world.obstacles.box.map((box) => box.pos), [[0, 0, 0]]);

// Every packet back as it went in, and a second write the same bytes.
assert.equal(replay.packets.length, packets.length);
replay.packets.forEach((packet, i) => {
  assert.equal(packet.mode, packets[i].mode);
  assert.equal(packet.code, packets[i].code);
  assert.equal(packet.time, packets[i].time);
  assert.deepEqual(packet.payload, packets[i].payload);
});
assert.deepEqual(writeReplay(replay), bytes);

// Each packet's file positions chain, as `nextFilePacket`/`prevFilePacket`
// walk them.
let at = bytes.readUInt32BE(8);
let prev = 0;
for (const packet of replay.packets) {
  assert.equal(bytes.readUInt32BE(at + 12), prev);
  const next = bytes.readUInt32BE(at + 8);
  assert.equal(next, at + PACKET_HEADER_SIZE + packet.payload.length);
  prev = at;
  at = next;
}
assert.equal(at, bytes.length);

// The proxy's decoder rebuilds the game from it.
const game = decode(replay);
assert.deepEqual([...game.players.values()].map((p) => p.callsign).sort(), ['ann', 'bob']);
assert.equal(game.motion.size, 2);

// Snapshots: one marker, found from its time on.
const marker = packets.findIndex((p) => p.mode === PACKET_MODE.UPDATE);
assert.deepEqual(replay.snapshots, [marker]);
assert.equal(snapshotAt(replay, T0 + 9_999_999), -1);
assert.equal(snapshotAt(replay, T0 + 10_000_000), marker);
assert.equal(snapshotAt(replay, T0 + 60_000_000), marker);

// A copy to share drops the hidden packets and still reads.
const shared = readReplay(writeReplay({
  ...replay, packets: replay.packets.filter((p) => p.mode !== PACKET_MODE.HIDDEN),
}));
assert.equal(shared.packets.length, packets.length - 1);
assert.ok(!shared.packets.some((p) => p.mode === PACKET_MODE.HIDDEN));
assert.deepEqual(shared.snapshots, [marker]);

// A file cut mid-packet keeps the packets before the cut.
assert.equal(readReplay(bytes.subarray(0, bytes.length - 3)).packets.length, packets.length - 1);
// Anything else is refused.
assert.throws(() => readReplay(Buffer.alloc(10)), /too short/);
assert.throws(() => readReplay(Buffer.concat([Buffer.from('nope'), bytes.subarray(4)])), /bad magic/);
const v2 = Buffer.from(bytes);
v2.writeUInt32BE(2, 4);
assert.throws(() => readReplay(v2), /version 2/);
assert.throws(() => readReplay(bytes.subarray(0, HEADER_SIZE + 5)), /cut off/);

// bzfs 2.4.12 to 2.4.13 packed the app version 14 bytes short; the fields
// after it are read 14 bytes early.
const old = Buffer.from(bytes);
old.fill(0, 200, HEADER_SIZE);
old.write('2.4.12', 200, 'latin1');
old.write('p4386', 314, 'latin1');
const oldReplay = readReplay(old);
assert.equal(oldReplay.appVersion, '2.4.12');
assert.equal(oldReplay.worldHash, 'p4386');

// The bundled sample: four `bzflag -solo` robots on maps/hix.bzw, recorded
// by an observer with `/record file` on bzfs 2.4.30.
const sample = readReplay(fs.readFileSync(new URL('../replays/hix-robots.rec', import.meta.url)));
assert.equal(sample.protocol, 'BZFS0221');
assert.equal(sample.callsign, 'recorder');
assert.equal(Math.round(sample.fileTime / 1e6), 91);
assert.equal(sample.packets.length, 1004);
assert.equal(sample.snapshots.length, 10);
const sampleGame = decode(sample);
assert.deepEqual([...sampleGame.players.values()].map((p) => p.callsign).sort(),
  ['recorder', 'robohost', 'robohost00', 'robohost01', 'robohost02', 'robohost03']);
assert.ok(parseWorldDatabase(sample.world).world.obstacles);

console.log('bzfs replay: ok');
