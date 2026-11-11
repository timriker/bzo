/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The game at a glance, pinned in the bridged room: the map, the game type
// and who is in, as one notice the bridge edits as it changes rather than a
// line each time. An edit replaces the message where it stands, so the room
// carries no new line and nobody is notified. See docs/matrix.md, "Status".

'use strict';

const { plain } = require('../bridge/lines.cjs');

// Edits at most this often: a burst of joins is one edit.
const STATUS_EDIT_MS = 10000;
const PINNED = 'm.room.pinned_events';

// BZFlag's own short names for the game types, by bz_eGameType.
const GAME_TYPES = ['ffa', 'offa', 'ctf', 'rabbit'];

// What the message says, from the game as it is: the map, the game type,
// the counts -- players, observers, bots, each left out at none -- and the
// players by name, with the scoreboard's `@` for an admin and `+` for one
// signed in: `hix, ctf, 3p 1o 2b, @Alice, +Bob, Charlie`.
function statusText(bz) {
  const names = [];
  let observing = 0;
  let bots = 0;
  for (const id of bz.bz_getPlayerIndexList()) {
    const record = bz.bz_getPlayerByIndex(id);
    if (!record) continue;
    if (record.team === bz.eObservers) observing++;
    else if (record.bot) bots++;
    else names.push(`${record.admin ? '@' : (record.verified ? '+' : '')}${plain(record.callsign)}`);
  }
  names.sort((a, b) => a.replace(/^[@+]/, '').localeCompare(b.replace(/^[@+]/, '')));
  const counts = [[names.length, 'p'], [observing, 'o'], [bots, 'b']].filter(([n]) => n > 0)
    .map(([n, key]) => `${n}${key}`).join(' ');
  const map = typeof bz.bz_getMapName === 'function' ? bz.bz_getMapName() : '';
  const type = GAME_TYPES[typeof bz.bz_getGameType === 'function' ? bz.bz_getGameType() : -1];
  return [map, type, counts || 'nobody in', ...names].filter(Boolean).join(', ');
}

// `client` is the bridge (`api`, `must`, `roomId`); `store` keeps the pinned
// message's id, so a restart edits the one already there.
function createMatrixStatus({ bz, client, store, setTimer = setTimeout, now = Date.now, log = () => {} }) {
  let eventId = store.load()?.eventId ?? null;
  let shown = null;
  let lastEditAt = -Infinity;
  let timer = null;
  const enc = encodeURIComponent;
  const txn = () => `bzo-status-${now()}-${Math.random().toString(36).slice(2, 8)}`;
  const content = (text) => ({ msgtype: 'm.notice', body: text, 'm.mentions': {} });

  // Pinned among whatever else is, once.
  async function pin(id) {
    const path = `/rooms/${enc(client.roomId)}/state/${PINNED}`;
    const answered = await client.api('GET', path);
    const pinned = answered.ok && Array.isArray(answered.data.pinned) ? answered.data.pinned : [];
    if (pinned.includes(id)) return;
    const put = await client.api('PUT', path, { body: { pinned: [...pinned, id] } });
    if (!put.ok) log(`could not pin the status: ${put.status}; make me able to pin in the room`);
  }

  async function post(text) {
    const path = `/rooms/${enc(client.roomId)}/send/m.room.message/${txn()}`;
    if (eventId) {
      const edited = await client.api('PUT', path, {
        body: {
          ...content(`* ${text}`),
          'm.new_content': content(text),
          'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
        },
      });
      if (edited.ok) return;
      // Gone -- redacted, or the room is new: a fresh one.
      eventId = null;
    }
    eventId = (await client.must('PUT', path, { body: content(text) })).event_id;
    store.save({ eventId });
    await pin(eventId);
  }

  async function update() {
    timer = null;
    if (!client.roomId) return;
    const text = statusText(bz);
    if (text === shown) return;
    lastEditAt = now();
    shown = text;
    await post(text).catch((error) => {
      shown = null;
      log(`status not posted: ${error.message}`);
    });
  }

  return {
    // The game changed: an edit now, or once the last one is old enough.
    changed() {
      if (timer) return;
      const wait = Math.max(0, STATUS_EDIT_MS - (now() - lastEditAt));
      timer = setTimer(() => update(), wait);
    },
    update,
  };
}

module.exports = { createMatrixStatus, statusText, STATUS_EDIT_MS };
