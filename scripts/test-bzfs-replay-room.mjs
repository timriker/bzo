#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The bundled sample played through a `ReplayRoom` on a clock this test
// turns by hand: who each viewer sees as they join, midway or not, what their
// chat reaches, and what happens at the end of the recording and when the
// last viewer leaves.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readReplay } = require('../server/bzfs-replay.cjs');
const {
  ReplayRoom, ReplaySession, FIRST_VIEWER_ID, summarizeReplay,
} = require('../server/bzfs-replay-room.cjs');

const replay = readReplay(fs.readFileSync(new URL('../replays/hix-robots.rec', import.meta.url)));
const RECORDED = ['recorder', 'robohost', 'robohost00', 'robohost01', 'robohost02', 'robohost03'];

let clock = 1_000_000;
const listFiles = async () => [
  { name: 'hix-robots', seconds: 91.0 },
  { name: 'b-short', seconds: 12.5 },
  { name: 'a-long', seconds: 600 },
];
const room = new ReplayRoom({
  name: 'hix-robots', replay, now: () => clock, restartDelayMs: 5000, listFiles,
});
// A command's answer arrives once the room has worked it out.
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });
const advance = (ms) => {
  // In steps, as the room's own timer would.
  for (let left = ms; left > 0; left -= 20) {
    clock += Math.min(20, left);
    room.tick();
  }
};
const recorded = (session) => [...session.state.players.values()]
  .filter((p) => p.id < FIRST_VIEWER_ID).map((p) => p.callsign).sort();
const viewers = (session) => [...session.state.players.values()]
  .filter((p) => p.id >= FIRST_VIEWER_ID).map((p) => `${p.id}:${p.callsign}`).sort();
const watch = (session) => {
  const seen = { messages: [], left: [], motion: 0 };
  session.on('message', (m) => seen.messages.push(m));
  session.on('playerLeft', (p) => seen.left.push(p.callsign));
  session.on('motion', () => { seen.motion += 1; });
  return seen;
};

// The first viewer starts the clock, and has the opening snapshot by the
// time its join resolves.
const ann = new ReplaySession({ room, callsign: 'ann' });
await ann.connect();
assert.equal(ann.playerId, FIRST_VIEWER_ID);
assert.deepEqual(viewers(ann), ['200:ann']);
assert.deepEqual(recorded(ann), RECORDED);
assert.ok(ann.state.vars.size > 0, 'and the server variables with it');
const annSaw = watch(ann);
advance(1000);
assert.deepEqual(recorded(ann), RECORDED);
assert.ok(annSaw.motion > 0, 'tanks move');

// A viewer midway has the game at once, before any tick, and the two see each
// other. A name the recording already has is let in, as upstream does.
advance(44_000);
const bob = new ReplaySession({ room, callsign: 'robohost' });
await bob.connect();
assert.equal(bob.playerId, FIRST_VIEWER_ID + 1);
assert.deepEqual(recorded(bob), RECORDED);
assert.ok(bob.state.motion.size > 0, 'a late joiner knows where the tanks are');
assert.deepEqual(viewers(ann), ['200:ann', '201:robohost']);
assert.deepEqual(viewers(bob), ['200:ann', '201:robohost']);
// Viewers are marked as watching, for the scoreboard's group of their own;
// the recorded players, the recorded observer among them, are not.
for (const player of bob.state.players.values()) {
  assert.equal(player.watching === true, player.id >= FIRST_VIEWER_ID, player.callsign);
}
// Recorded scores, as of now, match what a viewer there from the start has.
const scoreOf = (session) => [...session.state.players.values()]
  .filter((p) => p.id < FIRST_VIEWER_ID).map((p) => `${p.callsign}:${p.wins}-${p.losses}`).sort();
assert.deepEqual(scoreOf(bob), scoreOf(ann));
const bobSaw = watch(bob);

// Chat: to everyone, to one viewer, and a command.
const chat = (session, to, text) => {
  const payload = Buffer.alloc(129);
  payload.writeUInt8(to, 0);
  payload.write(text, 1, 'latin1');
  session.send('mg', payload);
};
chat(bob, 254, 'hello');
assert.deepEqual(annSaw.messages.at(-1), { from: 201, to: 254, kind: 0, text: 'hello' });
assert.deepEqual(bobSaw.messages.at(-1), { from: 201, to: 254, kind: 0, text: 'hello' });
chat(ann, 201, 'psst');
assert.equal(bobSaw.messages.at(-1).text, 'psst');
assert.equal(annSaw.messages.at(-1).text, 'psst', 'the sender sees its own line');
const before = annSaw.messages.length;
chat(bob, 254, '/kick ann');
await settle();
assert.equal(annSaw.messages.length, before, 'a command reaches nobody else');
assert.match(bobSaw.messages.at(-1).text, /not available/);
// `/replay stats`, as upstream words it, to the one who asked.
chat(bob, 254, '/replay stats');
await settle();
assert.equal(annSaw.messages.length, before);
assert.equal(bobSaw.messages.at(-2).text, 'Replay File:  hix-robots');
assert.match(bobSaw.messages.at(-1).text,
  /^Replay Date: {2}\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4} \[49\.\d\d %\] {2}\(45\.0 secs \/ 91\.0 secs\)$/);
// The rest of `/replay` needs the REPLAY permission, an operator's here.
chat(bob, 254, '/replay list');
await settle();
assert.equal(bobSaw.messages.at(-1).text, 'You do not have permission to run the /replay command');
bob.operator = true;
const listed = async (text) => {
  const from = bobSaw.messages.length;
  chat(bob, 254, text);
  await settle();
  return bobSaw.messages.slice(from).map((m) => m.text);
};
assert.deepEqual(await listed('/replay list'), [
  'dir:  replays/',
  '#01:  a-long                          [    600.0 seconds]',
  '#02:  b-short                         [     12.5 seconds]',
  '#03:  hix-robots                      [     91.0 seconds]',
]);
assert.deepEqual((await listed('/replay list -t')).slice(1).map((l) => l.split(/\s+/)[1]),
  ['b-short', 'hix-robots', 'a-long']);
assert.deepEqual((await listed('/replay list -- h*')).slice(1).map((l) => l.split(/\s+/)[1]), ['hix-robots']);
assert.equal((await listed('/replay list -x'))[0], 'usage:');
assert.equal((await listed('/replay play'))[0], 'usage:', 'not built yet, so the usage');
assert.equal(annSaw.messages.length, before, 'none of it reaches anyone else');
bob.operator = false;
// Nothing else a browser says goes anywhere.
bob.send('pu', Buffer.alloc(40));
bob.sendUdp('pu', Buffer.alloc(40));

// The end: said once, then everyone recorded leaves and it plays again.
advance(47_000);
assert.ok(annSaw.messages.some((m) => /End of replay hix-robots/.test(m.text)));
advance(5000);
assert.ok(annSaw.messages.some((m) => /restarted/.test(m.text)));
assert.ok(RECORDED.every((name) => annSaw.left.includes(name)));
assert.deepEqual(viewers(ann), ['200:ann', '201:robohost'], 'viewers stay through a restart');
// The opening snapshot again, on the tick after.
advance(1000);
assert.deepEqual(recorded(ann), RECORDED);
assert.deepEqual(recorded(bob), RECORDED);

// Leaving: the others are told; the last one out closes the room.
let emptied = 0;
room.onEmpty = () => { emptied += 1; };
bob.close();
assert.deepEqual(viewers(ann), ['200:ann']);
assert.equal(emptied, 0);
ann.close();
ann.close();
assert.equal(emptied, 1);
assert.equal(room.timer, null);
assert.equal(room.progress().viewers, 0);

// Full: the sixteen viewer ids are all there is.
const crowd = [];
for (let i = 0; i < 16; i += 1) {
  const s = new ReplaySession({ room, callsign: `v${i}` });
  await s.connect();
  crowd.push(s);
}
assert.equal(crowd.at(-1).playerId, FIRST_VIEWER_ID + 15);
await assert.rejects(new ReplaySession({ room, callsign: 'late' }).connect(), /16 viewers/);
for (const s of crowd) s.close();

// A list row's summary: when, how long, how the players finished, and who
// watched.
const summary = summarizeReplay(replay);
assert.equal(Math.round(summary.seconds), 91);
assert.equal(new Date(summary.start).getUTCFullYear(), 2026);
assert.deepEqual(summary.players.map((p) => p.callsign).sort(), RECORDED.filter((n) => n !== 'recorder'));
assert.deepEqual(summary.observers, ['recorder']);
assert.equal(summary.recordedBy, 'recorder');
assert.equal(summary.worldHash, 'p4386b6bf22a275e408753515ac472a96');
// Best first, by wins less losses.
const net = summary.players.map((p) => p.wins - p.losses);
assert.deepEqual(net, [...net].sort((a, b) => b - a));
console.log(`  ${summary.players.map((p) => `${p.callsign} ${p.wins}-${p.losses}`).join(', ')}`);

console.log('bzfs replay room: ok');
