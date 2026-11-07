/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// A game's public chat and one Matrix room, both ways, as an ordinary Matrix
// client: the client-server API over HTTPS, as the bridge's own account. See
// docs/matrix.md.
//
// Out: lines queue and go at most one message every `FLUSH_MS`, each line led
// by its speaker in bold, with `m.mentions` empty so nothing pings. A unique
// transaction id per message makes a retry safe.
//
// In: a `/sync` long poll filtered to the room. Its `next_batch` is saved
// (`store`) after every answer, so a restart picks up where it left off; with
// none saved, the room's past is skipped rather than replayed into the game.

'use strict';

const crypto = require('node:crypto');
const { QUEUE_LIMIT, plain, gameLines, isCommand } = require('../bridge/lines.cjs');

const FLUSH_MS = 2000;
// How long a sync waits for something to happen, and how long past that the
// request itself is given before it counts as lost.
const SYNC_WAIT_MS = 30000;
const SYNC_GRACE_MS = 15000;
const REQUEST_MS = 10000;
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 5 * 60 * 1000;

// Where a space keeps who is linked to whom (links.cjs), one state event per
// Matrix user.
const LINK_EVENT = 'org.bzflag.link';

// Only messages, the members who sent them, and links.
const SYNC_FILTER = JSON.stringify({
  presence: { not_types: ['*'] },
  account_data: { not_types: ['*'] },
  room: {
    timeline: { types: ['m.room.message', LINK_EVENT], limit: 50 },
    state: { types: ['m.room.member', LINK_EVENT], lazy_load_members: true },
    ephemeral: { not_types: ['*'] },
    account_data: { not_types: ['*'] },
  },
});

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// A reply carries the message it answers as `> ` lines ahead of its own;
// the game sees only the answer.
function withoutReplyFallback(body) {
  const lines = String(body).split('\n');
  if (!lines[0]?.startsWith('> ')) return String(body);
  let at = 0;
  while (at < lines.length && lines[at].startsWith('>')) at++;
  return lines.slice(at).join('\n').replace(/^\n+/, '');
}

// `homeserver` is the client-server API's base URL; `room` an id or an alias.
// `nameFor(userId, displayName)` is the speaker's name in game.
// `announce({ name, line })` says a line to every player. `onCommand({
// roomId, userId, name, text })` hears a line that starts with `!` -- or,
// outside the bridged room, `/` -- in any room the account is in, which never
// reaches the game. `onLink({ roomId, event })` hears a link event in any
// room, for the space that keeps them. `onInvite({ roomId, inviter, direct
// })` hears the account invited to a room.
function createMatrixBridge({
  homeserver, accessToken, room, nameFor = (userId, displayName) => displayName || userId,
  announce, onCommand = () => {}, onLink = () => {}, onInvite = () => {}, store, log, logError,
  fetchImpl = fetch, setTimer = setTimeout, now = Date.now,
}) {
  const base = String(homeserver).replace(/\/+$/, '');
  const queue = [];
  let flushTimer = null;
  let pausedUntil = 0;
  let stopped = false;
  let syncAbort = null;
  let retryMs = RETRY_MIN_MS;
  let roomId = null;
  let userId = null;
  const names = new Map();

  // `version` is the API's: v3 for most, v1 for the newer endpoints such as
  // a space's hierarchy.
  async function api(method, path, { body, query, timeoutMs = REQUEST_MS, signal, version = 'v3' } = {}) {
    const url = new URL(`${base}/_matrix/client/${version}${path}`);
    for (const [key, value] of Object.entries(query || {})) if (value !== undefined) url.searchParams.set(key, value);
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, ok: response.ok, data };
  }
  const must = async (...args) => {
    const answer = await api(...args);
    if (!answer.ok) throw new Error(`${args[0]} ${args[1]} ${answer.status} ${answer.data.errcode || ''}`.trim());
    return answer.data;
  };

  // --- Out ---

  const schedule = (delay = FLUSH_MS) => {
    if (flushTimer || queue.length === 0 || !roomId) return;
    flushTimer = setTimer(() => {
      flushTimer = null;
      return flush().catch((error) => logError('chat mirror failed', error));
    }, delay);
  };

  function compose(lines) {
    const said = (line) => (line.action ? `* ${line.mark}${line.name} ${line.text}` : `${line.mark}${line.name}: ${line.text}`);
    const html = (line) => (line.action
      ? `* <b>${escapeHtml(line.mark + line.name)}</b> ${escapeHtml(line.text)}`
      : `<b>${escapeHtml(line.mark + line.name)}</b>: ${escapeHtml(line.text)}`);
    return {
      msgtype: 'm.text',
      body: lines.map(said).join('\n'),
      format: 'org.matrix.custom.html',
      formatted_body: lines.map(html).join('<br>'),
      'm.mentions': {},
    };
  }

  async function flush() {
    if (queue.length === 0 || !roomId) return;
    if (now() < pausedUntil) {
      schedule(pausedUntil - now());
      return;
    }
    const lines = queue.splice(0, queue.length);
    const txnId = `bzo-${now()}-${crypto.randomBytes(6).toString('hex')}`;
    const answer = await api('PUT', `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`, {
      body: compose(lines),
    }).catch((error) => ({ status: 0, ok: false, data: { error: error.message } }));
    if (answer.status === 429 || answer.status === 0) {
      // Rate limited or unreachable: the lines go back to the front and wait.
      pausedUntil = now() + (Number(answer.data.retry_after_ms) || RETRY_MIN_MS);
      queue.unshift(...lines);
      if (queue.length > QUEUE_LIMIT) queue.splice(0, queue.length - QUEUE_LIMIT);
      log(`chat mirror waiting ${pausedUntil - now()}ms${answer.status ? '' : `: ${answer.data.error}`}`);
    } else if (!answer.ok) {
      log(`chat mirror dropped ${lines.length} line(s): ${answer.status} ${answer.data.errcode || ''}`.trim());
    }
    schedule();
  }

  // --- In ---

  // A line someone else wrote, as text: an edit repeats the message it
  // changes, and a notice is a bot's.
  const said = (event) => {
    const content = event.content || {};
    if (event.type !== 'm.room.message' || event.sender === userId) return null;
    if (content['m.relates_to']?.rel_type === 'm.replace') return null;
    if (content.msgtype !== 'm.text' && content.msgtype !== 'm.emote') return null;
    return { text: withoutReplyFallback(content.body || ''), emote: content.msgtype === 'm.emote' };
  };

  function receive(sync) {
    for (const [inRoom, room] of Object.entries(sync.rooms?.join || {})) {
      for (const event of [...(room.state?.events || []), ...(room.timeline?.events || [])]) {
        if (event.type === LINK_EVENT) onLink({ roomId: inRoom, event });
        if (inRoom === roomId) continue;
        // Outside the bridged room nothing is chat, so a `/` line Element
        // was told to send as a message is a command too.
        const line = said(event);
        if (line && isCommand(line.text, ['!', '/'])) {
          onCommand({ roomId: inRoom, userId: event.sender, name: event.sender, text: line.text.trim() });
        }
      }
    }
    for (const [inRoom, room] of Object.entries(sync.rooms?.invite || {})) {
      const mine = (room.invite_state?.events || [])
        .find((event) => event.type === 'm.room.member' && event.state_key === userId);
      if (mine) onInvite({ roomId: inRoom, inviter: mine.sender, direct: Boolean(mine.content?.is_direct) });
    }
    const joined = sync.rooms?.join?.[roomId];
    if (!joined) return;
    for (const event of joined.state?.events || []) {
      if (event.type === 'm.room.member') names.set(event.state_key, event.content?.displayname);
    }
    for (const event of joined.timeline?.events || []) {
      if (event.type === 'm.room.member') {
        names.set(event.state_key, event.content?.displayname);
        continue;
      }
      const line = said(event);
      if (!line) continue;
      const { text } = line;
      const name = plain(nameFor(event.sender, names.get(event.sender))) || 'someone';
      if (isCommand(text, ['!'])) {
        onCommand({ roomId, userId: event.sender, name, text: text.trim() });
        continue;
      }
      if (isCommand(text, ['/'])) {
        log(`"${name}" sent a command, not relayed: ${plain(text).slice(0, 80)}`);
        continue;
      }
      for (const each of gameLines(line.emote ? `* ${text}` : text, 'Matrix')) {
        announce({ name, line: each });
      }
    }
  }

  async function syncLoop() {
    let since = store.load()?.since;
    while (!stopped) {
      syncAbort = new globalThis.AbortController();
      try {
        const data = await must('GET', '/sync', {
          query: { filter: SYNC_FILTER, since, timeout: since ? String(SYNC_WAIT_MS) : '0' },
          timeoutMs: SYNC_WAIT_MS + SYNC_GRACE_MS,
          signal: syncAbort.signal,
        });
        // The first sync with nothing saved is the room's past: skipped.
        if (since) receive(data);
        since = data.next_batch;
        try {
          store.save({ since });
        } catch (error) {
          logError('could not save the sync position', error);
        }
        retryMs = RETRY_MIN_MS;
      } catch (error) {
        if (stopped) return;
        log(`sync failed, again in ${Math.round(retryMs / 1000)}s: ${error.message}`);
        await new Promise((resolve) => { setTimer(resolve, retryMs); });
        retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
      }
    }
  }

  // Who the account is, which room the option names, a join (which accepts an
  // invite too), and a refusal of an encrypted room, which this client cannot
  // read or write.
  async function start() {
    userId = (await must('GET', '/account/whoami')).user_id;
    // A homeserver URL that is a web page rather than the client-server API
    // -- https://matrix.org, not https://matrix-client.matrix.org -- answers
    // with no account at all.
    if (!userId) throw new Error(`${base} named no account; is homeserver its client-server API?`);
    roomId = room.startsWith('#')
      ? (await must('GET', `/directory/room/${encodeURIComponent(room)}`)).room_id
      : room;
    await must('POST', `/join/${encodeURIComponent(roomId)}`, { body: {} });
    const encrypted = await api('GET', `/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption/`);
    if (encrypted.ok) throw new Error(`${room} is encrypted; bridge an unencrypted room`);
    if (stopped) return null;
    log(`bridging ${room} as ${userId}`);
    schedule();
    syncLoop();
    return { userId, roomId };
  }

  // A notice to a room: what the bot says for itself, which bridges and bots
  // know not to repeat.
  async function notice(toRoom, body, html) {
    const txnId = `bzo-${now()}-${crypto.randomBytes(6).toString('hex')}`;
    return must('PUT', `/rooms/${encodeURIComponent(toRoom)}/send/m.room.message/${txnId}`, {
      body: {
        msgtype: 'm.notice', body, ...(html ? { format: 'org.matrix.custom.html', formatted_body: html } : {}),
        'm.mentions': {},
      },
    });
  }

  return {
    start,
    api,
    must,
    notice,
    get roomId() { return roomId; },
    get userId() { return userId; },
    stop() {
      stopped = true;
      syncAbort?.abort();
    },
    // One public chat line, from `name`, with `mark` ('@', '+' or '') before
    // it. `msgType` 'action' is `/me`.
    relay(name, text, msgType, mark = '') {
      const said = plain(text);
      if (!said) return;
      queue.push({ name: plain(name), text: said, action: msgType === 'action', mark });
      if (queue.length > QUEUE_LIMIT) queue.splice(0, queue.length - QUEUE_LIMIT);
      schedule();
    },
    flush,
    receive,
    get pending() { return queue.length; },
  };
}

module.exports = { createMatrixBridge, withoutReplyFallback, SYNC_FILTER, LINK_EVENT };
