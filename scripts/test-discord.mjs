/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Discord Linked Roles (server/discord.cjs) against a Discord and a
// bzflag.org that answer from here: the whole round trip, and each way it is
// refused.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { URLSearchParams } from 'node:url';

const require = createRequire(import.meta.url);
const { createDiscordLink, discordLinkConfigured, ROLE_METADATA } = require('../server/discord.cjs');

const config = { applicationId: '111', clientSecret: 'secret', botToken: 'bot', publicKey: 'pk', guildId: '777' };

function harness({ tokenGood = true, groups = [], held = [], nickStatus = 200 } = {}) {
  const calls = [];
  const saved = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (url.endsWith('/oauth2/token')) {
      const body = new URLSearchParams(init.body);
      return body.get('code') === 'good-code' ? json(200, { access_token: 'member-token' }) : json(400, { error: 'invalid_grant' });
    }
    if (url.endsWith('/users/@me')) return json(200, { id: '999', username: 'tim' });
    if (url.endsWith('/guilds/777/members/999')) return json(nickStatus, nickStatus < 300 ? {} : { message: 'Missing Permissions' });
    if (url.includes('/role-connections/metadata')) return json(200, init.method === 'PUT' ? JSON.parse(init.body) : held);
    if (url.includes('/role-connection')) return json(200, {});
    return json(404, { message: 'unexpected' });
  };
  const link = createDiscordLink({
    config,
    checkToken: async (callsign) => (tokenGood
      ? { good: true, bzid: '4242', callsign, groups }
      : { good: false, bzid: null, callsign: null, groups: [] }),
    isAdmin: (named) => named.includes('BZBB.ADMIN'),
    store: { load: () => ({}), save: (links) => saved.push(links) },
    log: () => {},
    logError: () => {},
    fetchImpl,
  });
  return { link, calls, saved };
}

function response() {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.status = (code) => { res.statusCode = code; return res; };
  res.set = (name, value) => { res.headers[name.toLowerCase()] = value; return res; };
  res.send = (body) => { res.body = body; return res; };
  res.end = () => res;
  res.redirect = (code, url) => { res.statusCode = code; res.headers.location = url; return res; };
  return res;
}

const host = 'bz.example.org';

// The whole way round: Discord consent, Discord's callback, bzflag.org's.
{
  const { link, calls, saved } = harness({ groups: ['BZBB.ADMIN'] });
  const started = response();
  link.start({ query: {} }, started, host);
  const authorize = new URL(started.headers.location);
  assert.equal(authorize.origin + authorize.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(authorize.searchParams.get('client_id'), '111');
  assert.equal(authorize.searchParams.get('redirect_uri'), `https://${host}/discord/link/callback`);
  assert.equal(authorize.searchParams.get('scope'), 'identify role_connections.write');
  const state = authorize.searchParams.get('state');

  const back = response();
  await link.discordCallback({ query: { state, code: 'good-code' } }, back, host);
  assert.equal(back.statusCode, 302);
  const weblogin = back.headers.location;
  assert.ok(weblogin.startsWith('https://my.bzflag.org/weblogin.php?action=weblogin&url='), weblogin);
  assert.ok(weblogin.endsWith('?t=%TOKEN%:%USERNAME%'), 'placeholders left for weblogin.php');
  const key = /\/discord\/link\/bzflag\/([^?]+)\?/.exec(weblogin)[1];

  const done = response();
  await link.bzflagCallback({ params: { key }, query: { t: 'tok123:Tim Riker' } }, done);
  assert.equal(done.statusCode, 200, done.body);
  assert.match(done.body, /Linked: Discord "tim" is BZFlag "Tim Riker"/);
  const put = calls.find((call) => call.url.endsWith('/users/@me/applications/111/role-connection'));
  assert.equal(put.init.headers.Authorization, 'Bearer member-token');
  assert.deepEqual(JSON.parse(put.init.body), {
    platform_name: 'BZFlag', platform_username: 'Tim Riker', metadata: { verified: '1', bzflag_admin: '1' },
  });
  assert.equal(saved.at(-1)['999'].bzid, '4242');
  const nick = calls.find((call) => call.url.endsWith('/guilds/777/members/999'));
  assert.equal(nick.init.method, 'PATCH');
  assert.equal(nick.init.headers.Authorization, 'Bot bot');
  assert.deepEqual(JSON.parse(nick.init.body), { nick: 'Tim Riker' });
  assert.match(done.body, /nickname there is now your callsign/);
  assert.equal(link.linkFor('999').callsign, 'Tim Riker');

  // Each key is good once.
  const again = response();
  await link.bzflagCallback({ params: { key }, query: { t: 'tok123:Tim Riker' } }, again);
  assert.equal(again.statusCode, 400);
  const replay = response();
  await link.discordCallback({ query: { state, code: 'good-code' } }, replay, host);
  assert.equal(replay.statusCode, 400);
}

// Refusals: a state nobody issued, Discord saying no, bzflag.org saying no.
{
  const { link } = harness({ tokenGood: false });
  const forged = response();
  await link.discordCallback({ query: { state: 'made-up', code: 'good-code' } }, forged, host);
  assert.equal(forged.statusCode, 400);

  const started = response();
  link.start({ query: {} }, started, host);
  const state = new URL(started.headers.location).searchParams.get('state');
  const denied = response();
  await link.discordCallback({ query: { state, code: 'bad-code' } }, denied, host);
  assert.equal(denied.statusCode, 502, 'a code Discord will not exchange');

  const started2 = response();
  link.start({ query: {} }, started2, host);
  const state2 = new URL(started2.headers.location).searchParams.get('state');
  const back = response();
  await link.discordCallback({ query: { state: state2, code: 'good-code' } }, back, host);
  const key = /\/discord\/link\/bzflag\/([^?]+)\?/.exec(back.headers.location)[1];
  const refused = response();
  await link.bzflagCallback({ params: { key }, query: { t: 'tok:Someone' } }, refused);
  assert.equal(refused.statusCode, 403);
  assert.equal(link.size, 0, 'nothing linked');
  assert.doesNotMatch(refused.body, /Someone/, 'nothing from the query string echoed back');
}

// A nickname Discord refuses -- the owner's, or no Manage Nicknames -- leaves
// the link made.
{
  const { link } = harness({ nickStatus: 403 });
  const started = response();
  link.start({ query: {} }, started, host);
  const state = new URL(started.headers.location).searchParams.get('state');
  const back = response();
  await link.discordCallback({ query: { state, code: 'good-code' } }, back, host);
  const key = /\/discord\/link\/bzflag\/([^?]+)\?/.exec(back.headers.location)[1];
  const done = response();
  await link.bzflagCallback({ params: { key }, query: { t: 'tok:Owner' } }, done);
  assert.equal(done.statusCode, 200);
  assert.doesNotMatch(done.body, /nickname/);
  assert.equal(link.linkFor('999').callsign, 'Owner');
}

// Not an admin: verified, and admin 0.
{
  const { link, calls } = harness({ groups: [] });
  const started = response();
  link.start({ query: {} }, started, host);
  const state = new URL(started.headers.location).searchParams.get('state');
  const back = response();
  await link.discordCallback({ query: { state, code: 'good-code' } }, back, host);
  const key = /\/discord\/link\/bzflag\/([^?]+)\?/.exec(back.headers.location)[1];
  await link.bzflagCallback({ params: { key }, query: { t: 'tok:Player' } }, response());
  const put = calls.find((call) => call.url.includes('/role-connection'));
  assert.deepEqual(JSON.parse(put.init.body).metadata, { verified: '1', bzflag_admin: '0' });
}

// The metadata a role can require, declared with the bot's token.
{
  const { link, calls } = harness();
  await link.registerMetadata();
  const put = calls.find((call) => call.url.endsWith('/applications/111/role-connections/metadata')
    && call.init.method === 'PUT');
  assert.ok(put, 'declared, Discord holding none');
  assert.equal(put.init.headers.Authorization, 'Bot bot');
  assert.deepEqual(JSON.parse(put.init.body).map((entry) => entry.key), ['verified', 'bzflag_admin']);
  assert.ok(ROLE_METADATA.every((entry) => entry.name.length <= 100 && entry.description.length <= 200));
}

// Already declared as it is: read, and nothing written.
{
  const { link, calls } = harness({ held: ROLE_METADATA.map((entry) => ({ ...entry, name_localizations: null })) });
  await link.registerMetadata();
  assert.equal(calls.filter((call) => call.init.method === 'PUT').length, 0);
}

// The admin rule a link uses is the session's own, without a session: a
// record with no expiry would otherwise read as expired and never admin.
{
  const { groupsGrantAdmin } = require('../server/sessions.cjs');
  assert.equal(groupsGrantAdmin(['DEVELOPERS', 'BZADMIN'], ['bzadmin']), true);
  assert.equal(groupsGrantAdmin(['PLAYERS'], ['BZADMIN']), false);
  assert.equal(groupsGrantAdmin(['BZADMIN'], []), false);
}

// The chat mirror: one post per window, under the speaker's callsign when there
// is one speaker and the server's otherwise; no mentions; a rate limit waited out.
{
  const { createChatMirror, senderName } = require('../server/discord-bridge.cjs');
  const posts = [];
  let status = 204;
  let clock = 0;
  const timers = [];
  const mirror = createChatMirror({
    webhookUrl: 'https://discord.com/api/webhooks/1/x',
    serverName: 'bz.example.org',
    log: () => {},
    logError: (label, err) => { throw err; },
    now: () => clock,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    fetchImpl: async (url, init) => {
      posts.push(JSON.parse(init.body));
      return { ok: status < 300, status, json: async () => ({ retry_after: 1.5 }) };
    },
  });
  mirror.relay('Tim Riker', 'hello', 'chat');
  mirror.relay('Tim Riker', 'waves', 'action');
  assert.equal(timers.length, 1, 'one timer for the window');
  await mirror.flush();
  assert.deepEqual(posts[0], {
    username: 'Tim Riker', content: 'hello\n*waves*', allowed_mentions: { parse: [] },
  });

  mirror.relay('a_b', 'one', 'chat');
  mirror.relay('Orin', '\u001b[31mred @everyone', 'chat');
  await mirror.flush();
  assert.equal(posts[1].username, 'bz.example.org');
  assert.equal(posts[1].content, '**a\\_b**: one\n**Orin**: red @everyone');
  assert.deepEqual(posts[1].allowed_mentions, { parse: [] });

  status = 429;
  mirror.relay('Orin', 'later', 'chat');
  await mirror.flush();
  assert.equal(mirror.pending, 1, 'kept for after the limit');
  status = 204;
  clock += 2000;
  await mirror.flush();
  assert.equal(mirror.pending, 0);
  assert.equal(posts.at(-1).content, 'later');

  // Marks: an admin's '@' and a signed-in player's '+', before the name.
  mirror.relay('Tim Riker', 'admin here', 'chat', '@');
  await mirror.flush();
  assert.equal(posts.at(-1).username, '@Tim Riker');
  mirror.relay('Tim Riker', 'one', 'chat', '@');
  mirror.relay('Orin', 'two', 'chat', '+');
  await mirror.flush();
  assert.equal(posts.at(-1).content, '**@Tim Riker**: one\n**+Orin**: two');

  assert.equal(senderName('Discord King', 'x'), 'King');
  assert.equal(senderName('@#:', 'fallback'), 'fallback');
}

// Discord to game: the bridged channel only, nothing from a bot or the
// mirror's webhook, mentions made readable, three lines at most, commands kept.
{
  const { createDiscordToGame } = require('../server/discord-bridge.cjs');
  const said = [];
  const logged = [];
  const onMessage = createDiscordToGame({
    channelId: 'chan',
    nameFor: (message) => (message.author.id === '999' ? 'Tim Riker' : message.author.username),
    announce: ({ text, name, line }) => {
      assert.equal(text, `[Discord] ${name}: ${line}`);
      said.push(text);
    },
    log: (line) => logged.push(line),
  });
  const message = (extra) => ({ channel_id: 'chan', author: { id: '5', username: 'guest' }, content: '', ...extra });
  onMessage(message({ author: { id: '999', username: 'timriker' }, content: 'hi <@5> in <#1> :) <:tank:42>', mentions: [{ id: '5', username: 'guest' }] }));
  assert.deepEqual(said, ['[Discord] Tim Riker: hi @guest in #channel :) :tank:']);
  onMessage(message({ channel_id: 'other', content: 'elsewhere' }));
  onMessage(message({ webhook_id: 'w', content: 'echo' }));
  onMessage(message({ author: { id: '6', username: 'bot', bot: true }, content: 'beep' }));
  assert.equal(said.length, 1, 'other channels, the webhook and bots are not relayed');
  onMessage(message({ content: 'a\nb\nc\nd' }));
  assert.deepEqual(said.slice(1), ['[Discord] guest: a', '[Discord] guest: b', '[Discord] guest: c (more in Discord)']);
  onMessage(message({ content: '/kick someone' }));
  assert.equal(said.length, 4, 'a command is not chat');
  assert.match(logged.at(-1), /command, not relayed/);
  onMessage(message({ attachments: [{}] }));
  assert.equal(said.at(-1), '[Discord] guest: [attachment]');
}

// The gateway: identify the first time, resume after, and hand dispatches on.
{
  const { createGateway, INTENTS, OP } = require('../server/discord-gateway.cjs');
  const sockets = [];
  class FakeSocket {
    constructor(url) { this.url = url; this.sent = []; this.handlers = {}; this.readyState = 1; sockets.push(this); }
    on(event, fn) { this.handlers[event] = fn; }
    send(data) { this.sent.push(JSON.parse(data)); }
    close(code) { this.handlers.close?.(code); }
    emit(packet) { this.handlers.message(JSON.stringify(packet)); }
  }
  let stored = null;
  const timers = [];
  const events = [];
  const gateway = createGateway({
    token: 'bot',
    onDispatch: (type, data) => events.push([type, data]),
    store: { load: () => stored, save: (session) => { stored = JSON.parse(JSON.stringify(session)); } },
    log: () => {},
    logError: (label, err) => { throw err; },
    WebSocketImpl: FakeSocket,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
    random: () => 0,
  });
  gateway.start();
  const first = sockets[0];
  assert.equal(first.url, 'wss://gateway.discord.gg/?v=10&encoding=json');
  first.emit({ op: OP.HELLO, d: { heartbeat_interval: 41250 } });
  assert.equal(first.sent[0].op, OP.IDENTIFY);
  assert.equal(first.sent[0].d.intents, INTENTS);
  first.emit({ op: 0, s: 1, t: 'READY', d: { session_id: 'sess', resume_gateway_url: 'wss://resume.example', user: { username: 'bzo' } } });
  first.emit({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: { content: 'hello' } });
  assert.deepEqual(events.map(([type]) => type), ['READY', 'MESSAGE_CREATE']);
  assert.deepEqual(stored, { sessionId: 'sess', resumeUrl: 'wss://resume.example', seq: 2 });

  // The heartbeat: sent with the last sequence, and a connection that does
  // not answer it is closed for a fresh one.
  timers.at(-1).fn();
  assert.deepEqual(first.sent.at(-1), { op: OP.HEARTBEAT, d: 2 });
  first.emit({ op: OP.HEARTBEAT_ACK });

  // Told to reconnect: a new socket on the resume URL, resuming at seq 2.
  first.emit({ op: OP.RECONNECT });
  timers.at(-1).fn();
  const second = sockets[1];
  assert.equal(second.url, 'wss://resume.example/?v=10&encoding=json');
  second.emit({ op: OP.HELLO, d: { heartbeat_interval: 41250 } });
  assert.deepEqual(second.sent[0], { op: OP.RESUME, d: { token: 'bot', session_id: 'sess', seq: 2 } });

  // A session Discord will not resume: forgotten, and the next one identifies.
  second.emit({ op: OP.INVALID_SESSION, d: false });
  assert.deepEqual(stored, {});
  timers.at(-1).fn();
  sockets[2].emit({ op: OP.HELLO, d: { heartbeat_interval: 41250 } });
  assert.equal(sockets[2].sent[0].op, OP.IDENTIFY);
  assert.equal(sockets[2].url, 'wss://gateway.discord.gg/?v=10&encoding=json');
}

assert.equal(discordLinkConfigured(config), true);
assert.equal(discordLinkConfigured({ applicationId: '1' }), false);
assert.equal(discordLinkConfigured(undefined), false);

console.log('discord tests passed');
