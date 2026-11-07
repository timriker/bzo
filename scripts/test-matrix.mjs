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

function homeserver({ encrypted = false, syncs = [], sendStatuses = [], joinedRooms = [ROOM] } = {}) {
  const calls = [];
  const sent = [];
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const fetchImpl = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    calls.push({ method: init.method, pathname, searchParams, init });
    if (pathname.endsWith('/account/whoami')) return json(200, { user_id: BOT });
    if (pathname.endsWith('/joined_rooms')) return json(200, { joined_rooms: joinedRooms });
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
  const commands = [];
  const server = homeserver({
    syncs: [
      sync('s1', [message('@old:example.org', 'from before the bridge')]),
      sync('s2', [
        message('@tim:example.org', 'hello game'),
        message(BOT, 'our own line'),
        message('@bot:example.org', 'a notice', { msgtype: 'm.notice' }),
        message('@tim:example.org', '* hello game!', { 'm.relates_to': { rel_type: 'm.replace' } }),
        message('@tim:example.org', '!kick someone'),
        message('@tim:example.org', '/nick Tim'),
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
    onCommand: (command) => commands.push(command),
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
  assert.deepEqual(commands, [{ roomId: ROOM, userId: '@tim:example.org', name: 'Tim', text: '!kick someone' }]);
  assert.match(logged.join('\n'), /"Tim" sent a command, not relayed: \/nick Tim/);

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

// A room joined -- first, or again after a leave -- arrives with its past,
// which is neither relayed nor run.
{
  const heard = [];
  const commands = [];
  const logged = [];
  const left = { next_batch: 's3', rooms: { leave: { [ROOM]: {} } } };
  const server = homeserver({
    joinedRooms: [],
    syncs: [
      sync('s2', [message('@tim:example.org', 'said before the join'), message('@tim:example.org', '!playerlist')]),
      sync('s3', [message('@tim:example.org', 'new')]),
      left,
      sync('s5', [message('@tim:example.org', 'said again before the rejoin')]),
      sync('s6', [message('@tim:example.org', 'newer')]),
    ],
  });
  const bridge = createMatrixBridge({
    homeserver: 'https://matrix.example.org',
    accessToken: 'token',
    room: ROOM,
    announce: (line) => heard.push(line.line),
    onCommand: (command) => commands.push(command),
    store: { load: () => ({ since: 's1' }), save: () => {} },
    log: (line) => logged.push(line),
    logError: (what, error) => { throw error; },
    fetchImpl: server.fetchImpl,
    setTimer: () => 0,
  });
  await bridge.start();
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(heard, ['new', 'newer']);
  assert.deepEqual(commands, []);
  assert.equal(logged.filter((line) => /its past is not relayed/.test(line)).length, 2);
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

// Links held by the space: `!link` answered in a direct message, the link
// page, the link written to the space, power levels across it from groups
// and `linked`, a group's room, `!whois`, and all of it taken back.
{
  const { createMatrixLinks } = require('../plugins/matrix/links.cjs');
  const BOT_ID = '@bot:example.org';
  const TIM = '@tim:example.org';
  const OWNER = '@owner:example.org';
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const power = {
    '!space': { users: { [BOT_ID]: 100, [OWNER]: 100 }, users_default: 0, events: { 'm.room.power_levels': 100 } },
    '!chat': { users: { [BOT_ID]: 100 }, users_default: 0, events: { 'm.room.power_levels': 100 } },
    // A room the bot holds too little power in to change anyone's.
    '!weak': { users: { [BOT_ID]: 50 }, users_default: 0, events: { 'm.room.power_levels': 100 } },
  };
  // One link already in the space, made by another server's bot.
  const spaceState = [{
    type: 'org.bzflag.link', state_key: 'ann:example.org',
    content: { user: '@ann:example.org', bzid: '7', callsign: 'Ann', admin: false },
  }];
  const notices = [];
  const calls = [];
  const ok = (data = {}) => ({ ok: true, status: 200, data });
  const client = {
    roomId: '!chat',
    userId: BOT_ID,
    async api(method, path, { body, version } = {}) {
      calls.push({ method, path, body });
      const room = decodeURIComponent(path.split('/')[2] || '');
      if (path.endsWith('/hierarchy')) {
        assert.equal(version, 'v1', "the hierarchy is v1's");
      }
      if (path.endsWith('/hierarchy')) return ok({ rooms: [{ room_id: '!space' }, { room_id: '!chat' }, { room_id: '!weak' }] });
      if (path.endsWith('/state/m.room.power_levels/')) {
        if (method === 'PUT') { power[room] = body; return ok(); }
        return ok(clone(power[room]));
      }
      if (path === '/rooms/!space/state') return ok(clone(spaceState));
      // The room's creator, who the bot never touches.
      if (path === '/rooms/!chat/state') return ok([{ type: 'm.room.create', sender: '@creator:example.org', content: { room_version: '12' } }]);
      if (path.endsWith('/state')) return ok([]);
      if (path.startsWith('/rooms/!space/state/org.bzflag.link/')) return ok();
      if (path.endsWith('/invite') || path.endsWith('/kick')) return ok();
      return { ok: false, status: 404, data: {} };
    },
    async must(method, path, options) {
      if (path.startsWith('/directory/room/')) {
        return { room_id: { '#bzo:example.org': '!space', '#admins:example.org': '!admins' }[decodeURIComponent(path.split('/').pop())] };
      }
      if (path === '/createRoom') { calls.push({ method, path, body: options.body }); return { room_id: '!dm' }; }
      return (await client.api(method, path, options)).data;
    },
    async notice(room, body) { notices.push({ room, body }); },
  };
  const saved = [];
  const links = createMatrixLinks({
    client,
    // This server's own link from before the space kept them: moved there,
    // without its groups.
    store: { load: () => ({ links: { '@old:example.org': { bzid: '3', callsign: 'Old', admin: false, groups: ['X'] } }, dms: {} }),
      save: (value) => saved.push(clone(value)) },
    publicUrl: 'https://bz.example.org/',
    powerLevels: { linked: 1 },
    groupRooms: { admin: '#admins:example.org' },
    space: '#bzo:example.org',
    answer: true,
    log: () => {},
    logError: (what, error) => { throw error; },
  });
  assert.deepEqual(links.groupsToAsk, [], 'admin and linked are not bzflag.org groups');
  await links.start();
  assert.equal(links.nameFor('@ann:example.org'), '+Ann', 'a link another server made');
  assert.equal(power['!space'].events['org.bzflag.link'], 100, 'only admins of the space may send links');
  assert.ok(calls.some((call) => call.method === 'PUT' && call.path === '/rooms/!space/state/org.bzflag.link/old%3Aexample.org'
    && call.body.callsign === 'Old' && call.body.groups === undefined), 'a file link moved into the space');
  assert.deepEqual(saved.at(-1).links, {});

  // Asked in another room of the space, answered there.
  await links.command({ roomId: '!general', userId: TIM, text: '!link' });
  assert.ok(notices.some((notice) => notice.room === '!general' && notice.body.includes('direct message')));
  const create = calls.find((call) => call.path === '/createRoom');
  assert.deepEqual(create.body.invite, [TIM]);
  assert.equal(create.body.is_direct, true);
  const dm = notices.find((notice) => notice.room === '!dm');
  const key = /plugins\/matrix\/link\?key=([\w-]+)/.exec(dm.body)[1];
  assert.ok(dm.body.includes('https://bz.example.org/plugins/matrix/link?key='), dm.body);
  assert.ok(!notices.some((notice) => notice.room === '!chat' && notice.body.includes(key)), 'the key never in the room');

  assert.equal((await links.complete({ key: 'forged', bzid: '1', callsign: 'X', groups: [], admin: false })).status, 403);
  const done = await links.complete({ key, bzid: '42', callsign: 'Tim Riker', groups: ['BZADMIN'], admin: true });
  assert.equal(done.status, 200);
  assert.equal((await links.complete({ key, bzid: '42', callsign: 'Tim Riker', groups: [], admin: true })).status, 403,
    'a key is good once');
  assert.equal(links.nameFor(TIM), '@Tim Riker');
  const written = calls.filter((call) => call.path === '/rooms/!space/state/org.bzflag.link/tim%3Aexample.org').at(-1);
  assert.equal(written.body.user, TIM);
  assert.equal(written.body.callsign, 'Tim Riker');
  assert.equal(written.body.groups, undefined, 'only what the room already shows');
  assert.equal(written.body.granted.levels['!chat'], 50, 'what was granted, for any server to take back');
  assert.ok(notices.some((notice) => notice.room === '!general' && notice.body === `${TIM} is BZFlag Tim Riker.`),
    'said where it was asked');
  assert.equal(power['!space'].users[TIM], 50, 'admin is moderator across the space');
  assert.equal(power['!chat'].users[TIM], 50);
  assert.equal(power['!weak'].users[TIM], undefined, 'not where the bot cannot change levels');
  assert.equal(power['!space'].users[OWNER], 100, 'someone the bot cannot outrank, untouched');
  await links.command({ roomId: '!chat', userId: '@creator:example.org', text: '!link' });
  const creatorKey = /key=([\w-]+)/.exec(notices.filter((notice) => notice.room === '!dm').at(-1).body)[1];
  await links.complete({ key: creatorKey, bzid: '8', callsign: 'Maker', groups: [], admin: true });
  assert.equal(power['!chat'].users['@creator:example.org'], undefined, "a room's creator, never named in its levels");
  assert.equal(power['!space'].users['@creator:example.org'], 50, 'elsewhere, as anyone');
  assert.ok(calls.some((call) => call.path === '/rooms/!admins/invite' && call.body.user_id === TIM));

  // `!whois`: a Matrix user, a callsign, nobody, oneself.
  await links.command({ userId: '@ann:example.org', text: `!whois ${TIM}` });
  await links.command({ userId: '@ann:example.org', text: '!whois tim riker' });
  await links.command({ userId: '@ann:example.org', text: '!whois @nobody:example.org' });
  await links.command({ userId: '@ann:example.org', text: '!whois' });
  assert.deepEqual(notices.slice(-4).map((notice) => notice.body), [
    `${TIM} is BZFlag Tim Riker (admin).`,
    `${TIM} is BZFlag Tim Riker (admin).`,
    '@nobody:example.org is not linked to a BZFlag account.',
    '@ann:example.org is BZFlag Ann.',
  ]);

  // Another server's bot unlinking someone: heard from the space.
  links.heard({ roomId: '!space', event: { type: 'org.bzflag.link', state_key: 'ann:example.org', content: {} } });
  assert.equal(links.nameFor('@ann:example.org'), null);
  // An event naming someone else than its key is not a link.
  links.heard({ roomId: '!space', event: { type: 'org.bzflag.link', state_key: 'eve:example.org',
    content: { user: TIM, bzid: '9', callsign: 'Eve' } } });
  assert.equal(links.nameFor('@eve:example.org'), null);

  // A level raised by hand is left alone; one the bot set is lowered on unlink.
  power['!space'].users[TIM] = 75;
  await links.command({ userId: TIM, text: '!unlink' });
  assert.equal(links.nameFor(TIM), null);
  assert.deepEqual(calls.filter((call) => call.path === '/rooms/!space/state/org.bzflag.link/tim%3Aexample.org').at(-1).body, {});
  assert.equal(power['!space'].users[TIM], 75, 'raised by hand, kept');
  assert.equal(power['!chat'].users[TIM], undefined, 'set by the bot, taken back');
  assert.ok(calls.some((call) => call.path === '/rooms/!admins/kick' && call.body.user_id === TIM));
}

// Another server in the same space: it reads the links and answers nothing.
{
  const { createMatrixLinks } = require('../plugins/matrix/links.cjs');
  const said = [];
  const links = createMatrixLinks({
    client: { roomId: '!gus', notice: async (room, body) => said.push(body) },
    store: { load: () => null, save: () => {} },
    publicUrl: '',
    space: '#bzo:example.org',
    log: () => {},
    logError: () => {},
  });
  assert.equal(links.answer, false);
  await links.command({ roomId: '!gus', userId: '@a:b', text: '!whois' });
  assert.deepEqual(said, []);
}

// A level set after people linked: raised to it on start, never lowered.
{
  const { createMatrixLinks } = require('../plugins/matrix/links.cjs');
  const power = { '!chat': { users: { '@bot:x': 100, '@hi:x': 30 }, users_default: 0, events: {} } };
  const saved = [];
  const client = {
    roomId: '!chat',
    userId: '@bot:x',
    async api(method, path, { body } = {}) {
      if (method === 'PUT') { power['!chat'] = body; return { ok: true, status: 200, data: {} }; }
      return { ok: true, status: 200, data: JSON.parse(JSON.stringify(power['!chat'])) };
    },
    async must(method, path, options) { return (await client.api(method, path, options)).data; },
  };
  const links = createMatrixLinks({
    client,
    store: {
      load: () => ({
        links: {
          '@lo:x': { bzid: '1', callsign: 'Lo', admin: false },
          // Given 30 by a group the link no longer remembers: kept.
          '@hi:x': { bzid: '2', callsign: 'Hi', admin: false, granted: { levels: { '!chat': 30 }, rooms: [] } },
        },
        dms: {},
      }),
      save: (value) => saved.push(JSON.parse(JSON.stringify(value))),
    },
    publicUrl: 'https://bz.example.org',
    powerLevels: { linked: 20 },
    log: () => {},
    logError: (what, error) => { throw error; },
  });
  await links.start();
  assert.equal(power['!chat'].users['@lo:x'], 20, 'raised to linked');
  assert.equal(power['!chat'].users['@hi:x'], 30, 'never lowered');
  assert.equal(saved.at(-1).links['@lo:x'].granted.levels['!chat'], 20, 'remembered, to take back on unlink');
}

// A direct room another server using the account made, named in its
// `m.direct`: used, not made again. A new one is added there.
{
  const { createMatrixLinks } = require('../plugins/matrix/links.cjs');
  const calls = [];
  const direct = { '@known:x': ['!theirs'] };
  const client = {
    roomId: '!chat',
    userId: '@bot:x',
    async api(method, path, { body } = {}) {
      calls.push({ method, path, body });
      if (path === '/user/%40bot%3Ax/account_data/m.direct') {
        if (method === 'PUT') { Object.assign(direct, body); return { ok: true, status: 200, data: {} }; }
        return { ok: true, status: 200, data: { ...direct } };
      }
      return { ok: false, status: 404, data: {} };
    },
    async must(method, path, options) {
      if (path === '/createRoom') return { room_id: '!new' };
      return (await client.api(method, path, options)).data;
    },
  };
  const links = createMatrixLinks({
    client, store: { load: () => null, save: () => {} }, publicUrl: '', log: () => {}, logError: () => {},
  });
  assert.equal(await links.directRoom('@known:x'), '!theirs');
  assert.equal(await links.directRoom('@new:x'), '!new');
  assert.deepEqual(direct['@new:x'], ['!new'], 'listed for every server using the account');
}

// Without a space: this server's own links, and `linked` alone.
{
  const { createMatrixLinks } = require('../plugins/matrix/links.cjs');
  const power = { '!chat': { users: { '@bot:x': 100 }, users_default: 0, events: {} } };
  const saved = [];
  const notices = [];
  const client = {
    roomId: '!chat',
    userId: '@bot:x',
    async api(method, path, { body } = {}) {
      if (path.endsWith('/state/m.room.power_levels/')) {
        if (method === 'PUT') { power['!chat'] = body; return { ok: true, status: 200, data: {} }; }
        return { ok: true, status: 200, data: JSON.parse(JSON.stringify(power['!chat'])) };
      }
      return { ok: false, status: 404, data: {} };
    },
    async must(method, path, options) {
      if (path === '/createRoom') return { room_id: '!dm' };
      return (await client.api(method, path, options)).data;
    },
    async notice(room, body) { notices.push({ room, body }); },
  };
  const links = createMatrixLinks({
    client,
    store: { load: () => null, save: (value) => saved.push(JSON.parse(JSON.stringify(value))) },
    publicUrl: 'https://bz.example.org',
    powerLevels: { linked: 1 },
    log: () => {},
    logError: (what, error) => { throw error; },
  });
  await links.start();
  await links.command({ userId: '@pat:x', text: '!link' });
  const key = /key=([\w-]+)/.exec(notices[0].body)[1];
  await links.complete({ key, bzid: '5', callsign: 'Pat', groups: [], admin: false });
  assert.equal(saved.at(-1).links['@pat:x'].callsign, 'Pat', 'kept in the file');
  assert.equal(power['!chat'].users['@pat:x'], 1, 'linked, at its level');
  assert.equal(links.nameFor('@pat:x'), '+Pat');
}

// No publicUrl: no link can be offered.
{
  const { createMatrixLinks } = require('../plugins/matrix/links.cjs');
  const logged = [];
  const links = createMatrixLinks({
    client: { roomId: '!r', notice: async () => { throw new Error('nothing to say'); } },
    store: { load: () => null, save: () => {} },
    publicUrl: '',
    log: (line) => logged.push(line),
    logError: () => {},
  });
  await links.command({ userId: '@a:b', text: '!link' });
  assert.match(logged[0], /no publicUrl/);
}

// An operator's own bot, not admin of the space: joins it to read the links,
// and writes nothing there.
{
  const { createMatrixLinks } = require('../plugins/matrix/links.cjs');
  const calls = [];
  let member = false;
  const client = {
    roomId: '!ops',
    userId: '@ops:x',
    async api(method, path) {
      calls.push({ method, path });
      if (path === '/join/!space') { member = true; return { ok: true, status: 200, data: {} }; }
      if (path === '/rooms/!space/state') {
        return member ? { ok: true, status: 200, data: [{ type: 'org.bzflag.link', state_key: 'ann:x',
          content: { user: '@ann:x', bzid: '7', callsign: 'Ann' } }] } : { ok: false, status: 403, data: {} };
      }
      if (path.includes('/account_data/m.direct')) return { ok: true, status: 200, data: {} };
      return { ok: false, status: 404, data: {} };
    },
    async must(method, path, options) {
      if (path.startsWith('/directory/room/')) return { room_id: '!space' };
      const answer = await client.api(method, path, options);
      if (!answer.ok) throw new Error(`${path} ${answer.status}`);
      return answer.data;
    },
    async notice() {},
  };
  const links = createMatrixLinks({
    client, store: { load: () => null, save: () => {} }, space: '#bzo:x', answer: false,
    log: () => {}, logError: (what, error) => { throw error; },
  });
  await links.start();
  assert.equal(links.nameFor('@ann:x'), '+Ann');
  assert.ok(!calls.some((call) => call.method === 'PUT' && call.path.startsWith('/rooms/')), 'nothing written');
}

// Commands: in a bridged room, answered in the direct room; in the direct
// room, sent to the server the member picked, which two servers sharing the
// account agree on through their rooms' announcements and the account's
// data. An operator's own bot, on an account of its own, answers its own.
{
  const { createMatrixCommands } = require('../plugins/matrix/commands.cjs');
  const TIM = '@tim:x';
  // One homeserver: each room's state, who is in it, and each account's data.
  const state = { '!space': [], '!rikers': [], '!gus': [], '!ops': [], '!chat': [] };
  const members = {
    '@bot:x': new Set(['!space', '!rikers', '!gus']),
    '@ops:x': new Set(['!ops']),
  };
  const accounts = { '@bot:x': {}, '@ops:x': {} };
  const notices = [];
  const ran = [];
  const joined = [];
  const ok = (data = {}) => ({ ok: true, status: 200, data });
  // A session of an account, bridging a room.
  const sessionFor = (roomId, userId = '@bot:x') => ({
    roomId,
    userId,
    async api(method, path, { body } = {}) {
      const account = accounts[userId];
      if (path.startsWith(`/user/${encodeURIComponent(userId)}/account_data/`)) {
        const type = decodeURIComponent(path.split('/').pop());
        if (method === 'PUT') { account[type] = body; return ok(); }
        return account[type] ? ok({ ...account[type] }) : { ok: false, status: 404, data: {} };
      }
      if (path === '/rooms/!space/hierarchy') {
        return ok({ rooms: Object.keys(state).map((room_id) => ({ room_id })) });
      }
      if (path.startsWith('/join/')) {
        const room = decodeURIComponent(path.split('/')[2]);
        joined.push({ userId, room });
        members[userId].add(room);
        return ok();
      }
      const room = decodeURIComponent(path.split('/')[2] || '');
      if (!state[room]) return { ok: false, status: 404, data: {} };
      if (!members[userId].has(room)) return { ok: false, status: 403, data: { errcode: 'M_FORBIDDEN' } };
      if (path === `/rooms/${encodeURIComponent(room)}/state`) return ok(state[room]);
      const put = /^\/rooms\/[^/]+\/state\/([^/]+)\/(.*)$/.exec(path);
      if (put && method === 'PUT') {
        const [type, key] = [put[1], decodeURIComponent(put[2])];
        state[room] = state[room].filter((event) => event.type !== type || event.state_key !== key);
        state[room].push({ type, state_key: key, sender: userId, content: body });
        return ok();
      }
      return { ok: false, status: 404, data: {} };
    },
    async must(method, path, options) {
      if (path.startsWith('/directory/room/')) return { room_id: '!space' };
      const answer = await this.api(method, path, options);
      if (!answer.ok) throw new Error(`${path} ${answer.status}`);
      return answer.data;
    },
    async notice(room, body) { notices.push({ server: roomId, room, body }); },
  });
  // A server announced in the space itself, as servers once were.
  state['!space'].push({ type: 'org.bzflag.server', state_key: 'old', content: { name: 'old' } });
  const linked = new Map([[TIM, { callsign: 'Tim Riker', bzid: '42', admin: true }]]);
  const linksFor = (userId) => ({
    linkFor: (who) => linked.get(who) || null,
    directRoom: async () => '!dm',
    isDirect: async (who, roomId) => roomId === (userId === '@ops:x' ? '!opsdm' : '!dm'),
    addDirect: async (who, roomId) => { accounts[userId]['m.direct'] = { [who]: [roomId] }; },
    openDirectRoom: async (who) => { accounts[userId]['m.direct'] = { [who]: ['!clear'] }; return '!clear'; },
  });
  const bzFor = (server) => ({
    bz_runCommand: async (line, who) => { ran.push({ server, line, who }); return [`${server} answers ${line}`]; },
  });
  const make = (roomId, name, answer, userId) => createMatrixCommands({
    bz: bzFor(name), client: sessionFor(roomId, userId), links: linksFor(userId || '@bot:x'), name,
    room: `#${name.split(':')[0].replace(/\./g, '-')}:x`, url: `https://${name}`, space: '#bzo:x', answer, log: () => {},
  });
  const rikers = make('!rikers', 'bz.rikers.org:5154', true);
  const gus = make('!gus', 'gus.rikers.org:5154', false);
  const ops = make('!ops', 'bz.example.net', false, '@ops:x');
  await rikers.start();
  await gus.start();
  await ops.start();
  // Each hears the others' announcements in its sync.
  for (const each of [rikers, gus]) await each.heard({ roomId: '!ops', event: { type: 'org.bzflag.server' } });
  assert.deepEqual(state['!rikers'].map((event) => event.content),
    [{ name: 'bz.rikers.org:5154', room: '#bz-rikers-org:x', url: 'https://bz.rikers.org:5154', account: '@bot:x', links: true }],
    'announced in its own room');
  assert.deepEqual(state['!space'].find((event) => event.state_key === 'old').content, {}, 'the space announcement cleared');
  assert.ok(joined.some((each) => each.userId === '@bot:x' && each.room === '!ops'), 'the links server joins the space\'s rooms');
  assert.deepEqual((await rikers.servers()).map((server) => server.name),
    ['bz.rikers.org:5154', 'gus.rikers.org:5154', 'bz.example.net']);
  assert.equal(rikers.directs, true);
  assert.equal(gus.directs, false, 'its account has a server that answers links');
  assert.equal(ops.directs, true, 'an operator\'s own bot answers its own direct rooms');

  // In a bridged room: that server runs it, the answer in the direct room.
  await gus.handle({ roomId: '!gus', userId: TIM, text: '!playerlist' });
  assert.deepEqual(ran.at(-1), { server: 'gus.rikers.org:5154', line: '/playerlist',
    who: { callsign: 'Tim Riker', bzid: '42', admin: true, via: 'Matrix' } });
  assert.deepEqual(notices.at(-1), { server: '!gus', room: '!dm', body: 'gus.rikers.org:5154: /playerlist\ngus.rikers.org:5154 answers /playerlist' });

  // In the operator's room: its bot runs it, and the links server, in that
  // room too, says nothing.
  ran.length = 0;
  const quiet = notices.length;
  await rikers.handle({ roomId: '!ops', userId: TIM, text: '!playerlist' });
  await ops.handle({ roomId: '!ops', userId: TIM, text: '!playerlist' });
  assert.deepEqual(ran.map((each) => each.server), ['bz.example.net']);
  assert.equal(notices.length, quiet + 1);
  assert.equal(notices.at(-1).server, '!ops');

  // In the direct room, with nothing picked: the server that answers links.
  const both = async (text) => {
    await rikers.handle({ roomId: '!dm', userId: TIM, text });
    await gus.handle({ roomId: '!dm', userId: TIM, text });
    await ops.handle({ roomId: '!dm', userId: TIM, text });
  };
  ran.length = 0;
  await both('/date');
  assert.deepEqual(ran.map((each) => each.server), ['bz.rikers.org:5154'], 'one server, and / works here');

  await both('!servers');
  assert.match(notices.at(-1).body, /bz\.rikers\.org:5154[\s\S]*gus\.rikers\.org:5154[\s\S]*bz\.example\.net \(#bz-example-net:x\) -- message @ops:x/);
  await both('!use nowhere');
  assert.equal(notices.at(-1).body, 'No server is called nowhere. !servers lists them.');
  await both('!use bz.example.net');
  assert.equal(notices.at(-1).body, 'bz.example.net answers as @ops:x: message it there.');
  await both('!use gus-rikers-org');
  assert.equal(notices.at(-1).body, 'Your commands now go to gus.rikers.org:5154.');
  assert.deepEqual(accounts['@bot:x']['org.bzflag.targets'], { [TIM]: 'gus.rikers.org:5154' });

  ran.length = 0;
  await both('!playerlist');
  assert.deepEqual(ran.map((each) => each.server), ['gus.rikers.org:5154'], 'the server picked, and only it');
  await both('!use');
  assert.equal(notices.at(-1).body, 'Your commands go to gus.rikers.org:5154.');
  await both('!servers');
  assert.match(notices.at(-1).body, /gus\.rikers\.org:5154 \(#gus-rikers-org:x\) -- yours/);

  // The operator's bot, in its own direct room with the member.
  ran.length = 0;
  await ops.handle({ roomId: '!opsdm', userId: TIM, text: '!playerlist' });
  assert.deepEqual(ran.map((each) => each.server), ['bz.example.net']);

  // Not linked: told so, nothing run.
  ran.length = 0;
  await both('!use bz.rikers.org');
  await rikers.handle({ roomId: '!dm', userId: '@stranger:x', text: '!playerlist' });
  assert.equal(ran.length, 0);
  assert.equal(notices.at(-1).body, 'Link your BZFlag account first: type !link.');

  // Elsewhere in the space: the server list and help there, anything else
  // pointed at the direct room, from the server that answers alone.
  const before = notices.length;
  await rikers.handle({ roomId: '!chat', userId: TIM, text: '!servers' });
  await gus.handle({ roomId: '!chat', userId: TIM, text: '!servers' });
  assert.equal(notices.length, before + 1, 'one answer');
  assert.equal(notices.at(-1).room, '!chat');
  assert.match(notices.at(-1).body, /^Servers:/);
  ran.length = 0;
  await rikers.handle({ roomId: '!chat', userId: TIM, text: '!playerlist' });
  assert.equal(ran.length, 0, 'never run where others can read the answer');
  assert.match(notices.at(-1).body, /go in your direct chat with me/);

  // Invited to a direct room: joined and kept by the server that answers.
  joined.length = 0;
  await gus.invited({ roomId: '!new', inviter: '@pat:x', direct: true });
  await rikers.invited({ roomId: '!new', inviter: '@pat:x', direct: true });
  assert.deepEqual(joined, [{ userId: '@bot:x', room: '!new' }]);
  assert.deepEqual(accounts['@bot:x']['m.direct'], { '@pat:x': ['!new'] });
  assert.match(notices.at(-1).body, /!use <server>/);
  await ops.invited({ roomId: '!opsnew', inviter: '@pat:x', direct: true });
  assert.deepEqual(accounts['@ops:x']['m.direct'], { '@pat:x': ['!opsnew'] }, 'and by an operator\'s own bot');

  // An encrypted direct room, as Element makes one: said so in the clear,
  // and an unencrypted one opened in its place -- once, however many
  // encrypted messages arrive.
  await rikers.invited({ roomId: '!secret', inviter: '@pat:x', direct: true, encrypted: true });
  assert.ok(joined.some((each) => each.room === '!secret'));
  assert.deepEqual(accounts['@bot:x']['m.direct'], { '@pat:x': ['!clear'] });
  assert.match(notices.find((notice) => notice.room === '!secret').body, /encrypted, which I cannot read/);
  assert.match(notices.find((notice) => notice.room === '!clear').body, /!use <server>/);
  const moved = notices.length;
  await rikers.encrypted({ roomId: '!dm', userId: TIM });
  await rikers.encrypted({ roomId: '!dm', userId: TIM });
  await gus.encrypted({ roomId: '!dm', userId: TIM });
  assert.equal(notices.filter((notice, index) => index >= moved && notice.room === '!dm').length, 1,
    'once, from the server that answers');

  // One operator bot bridging two rooms: the first by name answers its
  // direct rooms.
  state['!ops2'] = [];
  members['@ops:x'].add('!ops2');
  const ops2 = make('!ops2', 'a.example.net', false, '@ops:x');
  await ops2.start();
  await ops.heard({ roomId: '!ops2', event: { type: 'org.bzflag.server' } });
  assert.equal(ops2.directs, true);
  assert.equal(ops.directs, false);
}

assert.equal(withoutReplyFallback('> <@a:b> quoted\n> more\n\nanswer'), 'answer');
assert.equal(withoutReplyFallback('no reply'), 'no reply');

console.log('matrix tests passed');
