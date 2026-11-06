/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The Matrix bridge (plugins/matrix/client.cjs) against a homeserver that
// answers from here: joining, the room's past skipped, its messages into the
// game, and the game's lines out, batched, unpinging and retried.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMatrixBridge, withoutReplyFallback } = require('../plugins/matrix/client.cjs');

const ROOM = '!room:example.org';
const BOT = '@bzo:example.org';

function homeserver({ encrypted = false, syncs = [], sendStatuses = [] } = {}) {
  const calls = [];
  const sent = [];
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const fetchImpl = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    calls.push({ method: init.method, pathname, searchParams, init });
    if (pathname.endsWith('/account/whoami')) return json(200, { user_id: BOT });
    if (pathname.includes('/directory/room/')) return json(200, { room_id: ROOM });
    if (pathname.includes('/join/')) return json(200, { room_id: ROOM });
    if (pathname.endsWith('/state/m.room.encryption/')) {
      return encrypted ? json(200, { algorithm: 'm.megolm.v1.aes-sha2' }) : json(404, { errcode: 'M_NOT_FOUND' });
    }
    if (pathname.includes('/send/m.room.message/')) {
      const status = sendStatuses.shift() ?? 200;
      if (status === 200) sent.push(JSON.parse(init.body));
      return status === 429 ? json(429, { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 1500 }) : json(status, {});
    }
    if (pathname.endsWith('/sync')) {
      const next = syncs.shift();
      if (next) return json(200, next);
      // Nothing more: a long poll that waits until it is given up.
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return json(404, { errcode: 'M_UNRECOGNIZED' });
  };
  return { calls, sent, fetchImpl };
}

function timers() {
  const pending = [];
  return {
    setTimer: (fn, ms) => { pending.push({ fn, ms }); return pending.length; },
    run: async () => {
      while (pending.length) await pending.shift().fn();
    },
    pending,
  };
}

const tick = () => new Promise((resolve) => { setImmediate(resolve); });
const message = (sender, body, extra = {}) => ({
  type: 'm.room.message', sender, content: { msgtype: 'm.text', body, ...extra },
});
const sync = (next, events = [], state = []) => ({
  next_batch: next, rooms: { join: { [ROOM]: { timeline: { events }, state: { events: state } } } },
});

// Joining by alias, the past skipped, then the room's lines into the game.
{
  const saved = [];
  const heard = [];
  const logged = [];
  const server = homeserver({
    syncs: [
      sync('s1', [message('@old:example.org', 'from before the bridge')]),
      sync('s2', [
        message('@tim:example.org', 'hello game'),
        message(BOT, 'our own line'),
        message('@bot:example.org', 'a notice', { msgtype: 'm.notice' }),
        message('@tim:example.org', '* hello game!', { 'm.relates_to': { rel_type: 'm.replace' } }),
        message('@tim:example.org', '!kick someone'),
        message('@tim:example.org', '> <@ann:example.org> what map?\n\nhix'),
        message('@ann:example.org', 'waves', { msgtype: 'm.emote' }),
        message('@ann:example.org', 'one\ntwo\nthree\nfour'),
      ], [{ type: 'm.room.member', state_key: '@tim:example.org', content: { displayname: 'Tim' } }]),
    ],
  });
  const clock = timers();
  const bridge = createMatrixBridge({
    homeserver: 'https://matrix.example.org/',
    accessToken: 'token',
    room: '#bz:example.org',
    announce: (line) => heard.push(line),
    store: { load: () => null, save: (value) => saved.push(value) },
    log: (line) => logged.push(line),
    logError: (what, error) => { throw error; },
    fetchImpl: server.fetchImpl,
    setTimer: clock.setTimer,
  });
  assert.deepEqual(await bridge.start(), { userId: BOT, roomId: ROOM });
  assert.ok(server.calls.some((call) => call.pathname === `/_matrix/client/v3/join/${encodeURIComponent(ROOM)}`));
  assert.ok(server.calls.every((call) => call.init.headers.Authorization === 'Bearer token'));
  for (let i = 0; i < 5; i++) await tick();

  const syncs = server.calls.filter((call) => call.pathname.endsWith('/sync'));
  assert.equal(syncs[0].searchParams.get('timeout'), '0', 'the first sync only finds where now is');
  assert.equal(syncs[1].searchParams.get('since'), 's1');
  assert.deepEqual(saved.map((value) => value.since), ['s1', 's2']);
  assert.deepEqual(heard, [
    { name: 'Tim', line: 'hello game' },
    { name: 'Tim', line: 'hix' },
    { name: '@ann:example.org', line: '* waves' },
    { name: '@ann:example.org', line: 'one' },
    { name: '@ann:example.org', line: 'two' },
    { name: '@ann:example.org', line: 'three (more in Matrix)' },
  ]);
  assert.match(logged.join('\n'), /"Tim" sent a command, not relayed: !kick someone/);

  // The game's lines out: one message, unpinging, the speaker in bold.
  bridge.relay('Tim Riker', 'hi @room <b>', 'chat', '@');
  bridge.relay('\u001b[31mRed', 'drives off', 'action', '+');
  assert.equal(clock.pending.length, 1, 'one message per window');
  await clock.run();
  assert.equal(server.sent.length, 1);
  assert.deepEqual(server.sent[0], {
    msgtype: 'm.text',
    body: '@Tim Riker: hi @room <b>\n* +Red drives off',
    format: 'org.matrix.custom.html',
    formatted_body: '<b>@Tim Riker</b>: hi @room &#60;b&#62;<br>* <b>+Red</b> drives off',
    'm.mentions': {},
  });
  bridge.stop();
}

// A rate limit: the lines wait as long as the homeserver says, then go.
{
  let time = 1000;
  const server = homeserver({ sendStatuses: [429, 200] });
  const clock = timers();
  const bridge = createMatrixBridge({
    homeserver: 'https://matrix.example.org',
    accessToken: 'token',
    room: ROOM,
    announce: () => {},
    store: { load: () => ({ since: 's9' }), save: () => {} },
    log: () => {},
    logError: (what, error) => { throw error; },
    fetchImpl: server.fetchImpl,
    setTimer: clock.setTimer,
    now: () => time,
  });
  await bridge.start();
  assert.ok(!server.calls.some((call) => call.pathname.includes('/directory/')), 'an id needs no lookup');
  bridge.relay('Tim', 'one', 'chat');
  await clock.pending.shift().fn();
  assert.equal(server.sent.length, 0);
  assert.equal(bridge.pending, 1, 'back in the queue');
  time += 1000;
  await clock.pending.shift().fn();
  assert.equal(server.sent.length, 0, 'not before it was told');
  time += 500;
  await clock.run();
  assert.equal(server.sent.length, 1);
  assert.equal(server.sent[0].body, 'Tim: one');
  const ids = server.calls.filter((call) => call.pathname.includes('/send/')).map((call) => call.pathname.split('/').at(-1));
  assert.notEqual(ids[0], ids[1], 'each message its own transaction');
  bridge.stop();
}

// An encrypted room is refused.
{
  const server = homeserver({ encrypted: true });
  const bridge = createMatrixBridge({
    homeserver: 'https://matrix.example.org',
    accessToken: 'token',
    room: ROOM,
    announce: () => {},
    store: { load: () => null, save: () => {} },
    log: () => {},
    logError: () => {},
    fetchImpl: server.fetchImpl,
    setTimer: () => 0,
  });
  await assert.rejects(bridge.start(), /encrypted/);
  assert.ok(!server.calls.some((call) => call.pathname.endsWith('/sync')));
}

assert.equal(withoutReplyFallback('> <@a:b> quoted\n> more\n\nanswer'), 'answer');
assert.equal(withoutReplyFallback('no reply'), 'no reply');

console.log('matrix tests passed');
