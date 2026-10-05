#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// bzo's own games recorded (`server/bzo-recorder.cjs`): the buffer keeps
// broadcasts and snapshots within its cap, a slice starts at a snapshot, and
// a saved slice is a bzfs recording that the proxy's decoder and the replay
// summary both read back as the game that was played.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BroadcastBuffer, bufferToReplay } = require('../server/bzo-recorder.cjs');
const { readReplay, writeReplay, PACKET_MODE } = require('../server/bzfs-replay.cjs');
const { summarizeReplay } = require('../server/bzfs-replay-room.cjs');

let clock = 1_760_000_000_000;
const ann = { id: '1', name: 'ann', team: 'red', wins: 0, losses: 0, tks: 0, joined: true, alive: true, x: 0, y: 0, z: 0, rotation: 0 };
const bob = { id: '2', name: 'bob', team: 'blue', wins: 0, losses: 0, tks: 0, joined: true, alive: true, x: 50, y: 0, z: 0, rotation: 1 };
const game = { players: [ann, bob] };
const snapshot = () => ({
  bzdb: { _tankSpeed: '25' },
  flags: [],
  players: game.players.map((p) => ({ ...p })),
  teamScores: [],
  rabbitId: null,
});

// The buffer: off until started, a snapshot first, another every rate.
{
  const buffer = new BroadcastBuffer({ snapshot, now: () => clock, rateMs: 10_000 });
  assert.equal(buffer.record('{}'), null, 'nothing kept before start');
  buffer.start();
  assert.ok(buffer.entries[0].snapshot);
  for (let i = 0; i < 30; i += 1) {
    clock += 1000;
    buffer.record(JSON.stringify({ type: 'pmBatch', moves: [] }));
  }
  assert.equal(buffer.entries.filter((e) => e.snapshot).length, 4, 'one at start, then at 10, 20 and 30 s');
  assert.equal(Math.round(buffer.stats().seconds), 30);
  // The last 5 s start at 25 s, so they come from the snapshot at 20 s.
  const recent = buffer.slice(5);
  assert.ok(recent[0].snapshot);
  assert.equal(recent[0].at, clock - 10_000);
  assert.equal(buffer.slice().length, buffer.entries.length);
  // A cap drops whole snapshots' worth from the front, never the newest.
  buffer.setMaxBytes(buffer.bytes / 2);
  assert.ok(buffer.entries[0].snapshot, 'what is kept starts at a snapshot');
  assert.ok(buffer.bytes <= buffer.maxBytes);
  buffer.setMaxBytes(1);
  assert.equal(buffer.entries.filter((e) => e.snapshot).length, 1, 'the newest snapshot stays');
  buffer.stop();
  assert.equal(buffer.entries.length, 0);
  assert.equal(buffer.stats().recording, false);
}

// A short game, saved: ann kills bob after both move.
const buffer = new BroadcastBuffer({ snapshot, now: () => clock });
buffer.start();
const send = (message, extra) => {
  clock += 250;
  const entry = buffer.record(JSON.stringify(message));
  if (extra) entry.extra = extra;
};
send({ type: 'pmBatch', moves: [{ id: '1', x: 1, y: 0, z: 0, r: 0, fs: 1, rs: 0, vv: 0, vx: 0, vz: -25 }] });
send({ type: 'pmBatch', moves: [{ id: '2', x: 50, y: 0, z: 1, r: 1, fs: 0, rs: 0.5, vv: 0, vx: 0, vz: 0 }] });
send({ type: 'killed', victimId: '2', shooterId: '1', projectileId: null, reason: 'shot' },
  { scores: { 1: { wins: 1, losses: 0, tks: 0 }, 2: { wins: 0, losses: 1, tks: 0 } } });
send({ type: 'message', src: '1', dst: 254, msgType: 'chat', text: 'gg' });

const header = {
  player: 253, callsign: 'operator', protocol: 'BZFS0221', appVersion: 'bzo test',
  worldHash: 'p0', worldSettings: Buffer.alloc(34), flagTypes: Buffer.alloc(0), world: Buffer.alloc(0),
};
const replay = bufferToReplay(buffer.slice(), {
  header,
  translator: { teamIndex: (team) => ({ red: 1, blue: 3 })[team] ?? 0, config: () => ({ TANK_ROTATION_SPEED: 1 }) },
});
const read = readReplay(writeReplay(replay));
assert.equal(read.callsign, 'operator');
assert.equal(read.packets[0].mode, PACKET_MODE.UPDATE, 'it opens on a snapshot');
assert.ok(read.packets.some((p) => p.mode === PACKET_MODE.STATE && p.code === 'ap'));
assert.ok(read.packets.some((p) => p.mode === PACKET_MODE.REAL && p.code === 'pu'));
assert.ok(read.packets.some((p) => p.mode === PACKET_MODE.REAL && p.code === 'kl'));
assert.ok(read.packets.some((p) => p.mode === PACKET_MODE.REAL && p.code === 'mg'));
assert.equal(read.fileTime, 1_000_000, 'four broadcasts a quarter second apart');
assert.equal(read.snapshots.length, 1);
// Packet times are the broadcasts' own, in microseconds.
assert.equal(read.packets.at(-1).time - read.packets[0].time, 1_000_000);

const summary = summarizeReplay(read);
assert.deepEqual(summary.players.map((p) => `${p.callsign} ${p.wins}-${p.losses}`), ['ann 1-0', 'bob 0-1'],
  'the kill and the scores captured with it');
assert.equal(summary.recordedBy, 'operator');

console.log('bzo recorder: ok');
