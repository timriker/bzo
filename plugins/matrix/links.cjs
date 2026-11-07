/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Matrix accounts linked to BZFlag ones, and what a link grants. See
// docs/matrix.md, "Links".
//
// `!link` in a room the bot is in: the bot answers in a direct message,
// never the room, with a one-time URL to the plugin's page behind a
// bzflag.org login. Signing in there pairs the Matrix user ID the URL was made for with
// the BZID bzflag.org vouched for. Nothing is trusted from the browser but
// the key, which is good once and for ten minutes.
//
// With a space, the space holds the links: one `org.bzflag.link` state event
// per member, which only an admin of the space may send, so every bzo server
// bridging a room in it knows every link. One of them answers the link
// commands, in any room its account is in (`answer`); the rest only read the
// links. Without a space, links are this server's own, in its file, and it
// answers in its bridged room.
//
// A link gives the member, in every room of the space the bot is admin in,
// the power level their groups map to, and invites them to the rooms their
// groups have. Groups are what bzflag.org named at the link: it answers about
// groups only for a fresh login, so linking again is what refreshes them,
// and what is no longer named is taken back. A level is only ever lowered
// where the bot set it, and never for anyone the bot cannot outrank.

'use strict';

const crypto = require('node:crypto');
const { LINK_EVENT } = require('./client.cjs');

const PENDING_TTL_MS = 10 * 60 * 1000;
const PENDING_LIMIT = 500;
// The pseudo-groups: a member in one of the server's admin groups, and any
// linked member at all.
const ADMIN = 'ADMIN';
const LINKED = 'LINKED';
// Moderator for an admin, unless the options say otherwise.
const DEFAULT_LEVELS = Object.freeze({ admin: 50 });

const enc = encodeURIComponent;
// A state key may not start with `@` unless it is the sender's own, so a
// link's is the user ID without it.
const stateKeyOf = (userId) => String(userId).replace(/^@/, '');

// `client` is the room's Matrix client (client.cjs). `store` keeps this
// server's own `{ links, dms }`. `publicUrl` is where this server's pages are
// reached. `powerLevels` maps a group, `admin` or `linked` to a power level;
// `groupRooms` a group, `admin` or `linked` to a room. `space` holds the
// links and is where levels apply; without one, the bridged room alone.
// `answer` is whether this server answers `!link`, `!unlink` and `!whois`
// for the space.
function createMatrixLinks({
  client, store, publicUrl, powerLevels = {}, groupRooms = {}, space = null, answer = !space,
  log, logError, now = Date.now,
}) {
  const local = { links: {}, dms: {}, ...(store.load() || {}) };
  const links = new Map(space ? [] : Object.entries(local.links));
  const levels = Object.entries({ ...DEFAULT_LEVELS, ...(powerLevels || {}) })
    .map(([group, level]) => [String(group).toUpperCase(), Number(level)])
    .filter(([, level]) => Number.isFinite(level) && level > 0);
  const rooms = Object.entries(groupRooms || {}).map(([group, room]) => [String(group).toUpperCase(), String(room)]);
  const pending = new Map();
  let spaceId = null;

  const saveLocal = () => {
    try {
      store.save(local);
    } catch (error) {
      logError('could not save links', error);
    }
  };

  // The groups worth asking bzflag.org about: every real one an option names.
  const groupsToAsk = [...new Set([...levels, ...rooms].map(([group]) => group)
    .filter((group) => group !== ADMIN && group !== LINKED))];

  const groupsOf = (groups, admin) => new Set([
    ...groups.map((group) => String(group).toUpperCase()), LINKED, ...(admin ? [ADMIN] : []),
  ]);

  async function roomIdOf(room) {
    if (!room.startsWith('#')) return room;
    return (await client.must('GET', `/directory/room/${enc(room)}`)).room_id;
  }

  // A link, written where links are kept: the space, or this server's file.
  // Only what the room already shows -- callsign, admin -- and what the link
  // granted, so any server can take it back; never the member's groups.
  // `null` removes it.
  async function writeLink(userId, given) {
    const record = given && {
      bzid: String(given.bzid), callsign: String(given.callsign), admin: Boolean(given.admin),
      linkedAt: given.linkedAt, granted: given.granted || { levels: {}, rooms: [] },
    };
    if (record) links.set(userId, record);
    else links.delete(userId);
    if (spaceId) {
      await client.must('PUT', `/rooms/${enc(spaceId)}/state/${LINK_EVENT}/${enc(stateKeyOf(userId))}`, {
        body: record ? { user: userId, ...record } : {},
      });
    } else {
      local.links = Object.fromEntries(links);
      saveLocal();
    }
  }

  // A link event in the space, from any server's bot: kept if an admin of
  // the space sent it, which the space's power levels make sure of.
  function heard({ roomId, event }) {
    if (!spaceId || roomId !== spaceId) return;
    const content = event.content || {};
    const userId = `@${event.state_key}`;
    if (content.user === userId && content.bzid && content.callsign) {
      const record = { ...content };
      delete record.user;
      links.set(userId, record);
    } else {
      links.delete(userId);
    }
  }

  // The space's links read, only its admins allowed to send them, and this
  // server's own file links moved into it.
  async function start() {
    if (space) await startSpace();
    await shareDirectRooms();
    if (answer) await raiseAll();
  }

  // Direct rooms this server knows of and the account's `m.direct` does not,
  // added there, so every server using the account answers in them. Rooms
  // another account made -- the options named a different one before -- are
  // forgotten: this one is not in them.
  async function shareDirectRooms() {
    if (local.dmsOf !== client.userId) {
      local.dms = {};
      local.dmsOf = client.userId;
      saveLocal();
    }
    const direct = await directRooms();
    const missing = Object.entries(local.dms).filter(([userId, roomId]) => !(direct[userId] || []).includes(roomId));
    if (missing.length === 0) return;
    for (const [userId, roomId] of missing) direct[userId] = [roomId, ...(direct[userId] || [])];
    await client.must('PUT', directPath(), { body: direct });
    log(`${missing.length} direct room${missing.length === 1 ? '' : 's'} shared with the account`);
  }

  async function startSpace() {
    spaceId = await roomIdOf(space);
    const state = await client.must('GET', `/rooms/${enc(spaceId)}/state`);
    for (const event of state.filter((each) => each.type === LINK_EVENT)) heard({ roomId: spaceId, event });
    const path = `/rooms/${enc(spaceId)}/state/m.room.power_levels/`;
    const power = await client.must('GET', path);
    if ((power.events?.[LINK_EVENT] ?? -1) < 100) {
      await client.must('PUT', path, { body: { ...power, events: { ...(power.events || {}), [LINK_EVENT]: 100 } } });
      log(`only admins of ${space} may send ${LINK_EVENT}`);
    }
    for (const [userId, record] of Object.entries(local.links || {})) {
      if (!links.has(userId)) await writeLink(userId, record);
    }
    if (Object.keys(local.links || {}).length > 0) {
      local.links = {};
      saveLocal();
    }
    log(`${links.size} linked in ${space}`);
  }

  // The rooms a level applies in: the space and every room in it, or the
  // bridged room alone.
  async function levelRooms() {
    if (!spaceId) return [client.roomId];
    const answer = await client.api('GET', `/rooms/${enc(spaceId)}/hierarchy`, {
      query: { max_depth: '1' }, version: 'v1',
    });
    if (!answer.ok) throw new Error(`the space's rooms: ${answer.status} ${answer.data.errcode || ''}`);
    return (answer.data.rooms || []).map((room) => room.room_id);
  }

  // A room's creators. From room version 12 they outrank everyone and may
  // not be named in its power levels at all; in older rooms they are admins
  // already. Either way the bot leaves them be.
  const creators = new Map();
  async function creatorsOf(roomId) {
    if (!creators.has(roomId)) {
      // The whole event, since from version 11 the creator is its sender,
      // which the content alone does not carry.
      const answer = await client.api('GET', `/rooms/${enc(roomId)}/state`);
      const events = answer.ok && Array.isArray(answer.data) ? answer.data : [];
      const create = events.find((event) => event.type === 'm.room.create') || {};
      creators.set(roomId, new Set([create.sender, create.content?.creator,
        ...(create.content?.additional_creators || [])].filter(Boolean)));
    }
    return creators.get(roomId);
  }

  // One room's level for one member: raised to what their groups give, or
  // lowered from what the bot gave them before, unless `raiseOnly`.
  // `granted` is what the bot set there last, kept in the link.
  async function setLevel(roomId, userId, level, granted, raiseOnly = false) {
    if ((await creatorsOf(roomId)).has(userId)) return granted;
    const path = `/rooms/${enc(roomId)}/state/m.room.power_levels/`;
    const answer = await client.api('GET', path);
    if (!answer.ok) return granted;
    const power = answer.data;
    const usersDefault = power.users_default ?? 0;
    const mine = power.users?.[client.userId] ?? usersDefault;
    const needed = power.events?.['m.room.power_levels'] ?? power.state_default ?? 50;
    const current = power.users?.[userId] ?? usersDefault;
    if (mine < needed || current >= mine) return granted;
    const want = Math.min(level, mine);
    let next = null;
    if (want > current) next = want;
    else if (!raiseOnly && want < current && granted === current) next = want;
    if (next === null) return granted;
    const users = { ...(power.users || {}) };
    if (next <= usersDefault) delete users[userId];
    else users[userId] = next;
    await client.must('PUT', path, { body: { ...power, users } });
    log(`${userId} power ${current} -> ${next} in ${roomId}`);
    return next > usersDefault ? next : undefined;
  }

  // Every link raised to what `linked` and `admin` give, in every room the
  // levels apply in, so a level set after people linked, or a room added to
  // the space since, reaches them too. Never lowers: a link does not keep
  // the member's other groups, so what they gave cannot be judged here.
  async function raiseAll() {
    let raised = 0;
    try {
      const roomIds = await levelRooms();
      for (const [userId, record] of [...links]) {
        const level = Math.max(0, ...levels.filter(([group]) => groupsOf([], record.admin).has(group))
          .map(([, each]) => each));
        if (level === 0) continue;
        const granted = { levels: { ...(record.granted?.levels || {}) }, rooms: record.granted?.rooms || [] };
        let changed = false;
        for (const roomId of roomIds) {
          const set = await setLevel(roomId, userId, level, granted.levels[roomId], true);
          if (set !== granted.levels[roomId] && set !== undefined) {
            granted.levels[roomId] = set;
            changed = true;
          }
        }
        if (changed) {
          await writeLink(userId, { ...record, granted });
          raised++;
        }
      }
    } catch (error) {
      logError('raising links', error);
    }
    if (raised > 0) log(`${raised} link${raised === 1 ? '' : 's'} raised to their level`);
  }

  // What a member's groups grant, given what was granted before; returns
  // what is granted now.
  async function apply(userId, held, was = { levels: {}, rooms: [] }) {
    const level = Math.max(0, ...levels.filter(([group]) => held.has(group)).map(([, each]) => each));
    const granted = { levels: {}, rooms: [] };
    try {
      for (const roomId of await levelRooms()) {
        const set = await setLevel(roomId, userId, level, was.levels?.[roomId]);
        if (set !== undefined) granted.levels[roomId] = set;
      }
    } catch (error) {
      logError('power levels', error);
      granted.levels = was.levels || {};
    }
    for (const [group, room] of rooms) {
      try {
        const roomId = await roomIdOf(room);
        if (held.has(group)) {
          if (!granted.rooms.includes(roomId)) granted.rooms.push(roomId);
          if ((was.rooms || []).includes(roomId)) continue;
          const invited = await client.api('POST', `/rooms/${enc(roomId)}/invite`, { body: { user_id: userId } });
          if (invited.ok) log(`${userId} invited to ${room}`);
        } else if ((was.rooms || []).includes(roomId) && !granted.rooms.includes(roomId)) {
          await client.api('POST', `/rooms/${enc(roomId)}/kick`, {
            body: { user_id: userId, reason: `No longer in ${group} at bzflag.org` },
          });
          log(`${userId} removed from ${room}`);
        }
      } catch (error) {
        logError(`group room ${room}`, error);
      }
    }
    return granted;
  }

  // The account's direct rooms, `m.direct`: each member's, shared by every
  // server using the account, whichever made or joined it.
  const directPath = () => `/user/${enc(client.userId)}/account_data/m.direct`;
  async function directRooms() {
    const listed = await client.api('GET', directPath());
    return listed.ok ? listed.data : {};
  }

  // A room as `userId`'s direct room with the bot, first in their list.
  async function addDirect(userId, roomId) {
    const direct = await directRooms();
    const theirs = (direct[userId] || []).filter((each) => each !== roomId);
    await client.must('PUT', directPath(), { body: { ...direct, [userId]: [roomId, ...theirs] } });
    local.dms[userId] = roomId;
    saveLocal();
  }

  // Whether `roomId` is one of `userId`'s direct rooms with the bot.
  async function isDirect(userId, roomId) {
    if (local.dms[userId] === roomId) return true;
    return ((await directRooms())[userId] || []).includes(roomId);
  }

  // The direct room the bot talks to a member in: the one `m.direct` names,
  // or a new one, added there.
  async function directRoom(userId) {
    if (local.dms[userId]) return local.dms[userId];
    let roomId = ((await directRooms())[userId] || [])[0];
    if (!roomId) {
      roomId = (await client.must('POST', '/createRoom', {
        body: { is_direct: true, invite: [userId], preset: 'private_chat' },
      })).room_id;
      await addDirect(userId, roomId);
    }
    local.dms[userId] = roomId;
    saveLocal();
    return roomId;
  }

  const describe = (userId) => {
    const record = links.get(userId);
    return record ? `${userId} is BZFlag ${record.callsign}${record.admin ? ' (admin)' : ''}.`
      : `${userId} is not linked to a BZFlag account.`;
  };

  // `!link`, `!unlink` and `!whois`, answered in the room they were asked
  // in -- any room the account is in, with a space; the bridged room alone
  // without one.
  async function command({ roomId = client.roomId, userId, text }) {
    if (!answer || (!space && roomId !== client.roomId)) return;
    const [word, ...rest] = text.split(/\s+/);
    switch (word.toLowerCase()) {
      case '!link': {
        if (!publicUrl) {
          log(`${userId} asked to link, and this server has no publicUrl`);
          return;
        }
        for (const [key, entry] of pending) {
          if (entry.at < now() - PENDING_TTL_MS) pending.delete(key);
        }
        while (pending.size >= PENDING_LIMIT) pending.delete(pending.keys().next().value);
        const key = crypto.randomBytes(24).toString('base64url');
        pending.set(key, { userId, roomId, at: now() });
        const url = `${publicUrl.replace(/\/+$/, '')}/plugins/matrix/link?key=${key}`;
        const dm = await directRoom(userId);
        await client.notice(dm, `To link ${userId} to your BZFlag account, sign in at bzflag.org here,`
          + ` within ten minutes: ${url}`);
        if (roomId !== dm) {
          await client.notice(roomId, `${userId}: sent you a direct message to link your BZFlag account.`);
        }
        log(`${userId} asked to link`);
        return;
      }
      case '!unlink': {
        const record = links.get(userId);
        if (!record) return;
        await writeLink(userId, null);
        await apply(userId, new Set(), record.granted);
        await client.notice(roomId, `${userId} is no longer linked to BZFlag ${record.callsign}.`);
        log(`${userId} unlinked from "${record.callsign}"`);
        return;
      }
      case '!whois': {
        // A Matrix user, a callsign, or with neither, the asker.
        const asked = rest.join(' ').trim();
        if (!asked) {
          await client.notice(roomId, describe(userId));
        } else if (asked.startsWith('@')) {
          await client.notice(roomId, describe(asked.split(/\s+/)[0]));
        } else {
          const found = [...links].find(([, record]) => record.callsign.toLowerCase() === asked.toLowerCase());
          await client.notice(roomId, found ? describe(found[0])
            : `No Matrix account is linked to BZFlag ${asked}.`);
        }
        return;
      }
      default:
    }
  }

  // The link page, signed in: `key` from the URL, and who bzflag.org said.
  async function complete({ key, bzid, callsign, groups, admin }) {
    const entry = typeof key === 'string' ? pending.get(key) : null;
    pending.delete(key);
    if (!entry || entry.at < now() - PENDING_TTL_MS) {
      return { status: 403, text: 'That link has expired or was already used. Type !link in the room again.' };
    }
    const { userId, roomId } = entry;
    const was = links.get(userId)?.granted;
    const record = {
      bzid: String(bzid), callsign: String(callsign), admin: Boolean(admin),
      linkedAt: new Date(now()).toISOString(), granted: was || { levels: {}, rooms: [] },
    };
    try {
      await writeLink(userId, record);
    } catch (error) {
      logError('could not keep the link', error);
      return { status: 500, text: 'The link could not be kept just now. Type !link in the room again.' };
    }
    log(`linked ${userId} to "${callsign}" bzid=${bzid}${admin ? ' admin' : ''}`);
    try {
      await client.notice(roomId, `${userId} is BZFlag ${callsign}.`);
      record.granted = await apply(userId, groupsOf(groups, admin), was);
      await writeLink(userId, record);
    } catch (error) {
      logError('after linking', error);
    }
    return { status: 200, text: `Linked: Matrix ${userId} is BZFlag "${callsign}". You can close this.` };
  }

  return {
    start,
    heard,
    answer,
    directRoom,
    addDirect,
    isDirect,
    command,
    complete,
    groupsToAsk,
    // A linked member's name in the game: their callsign, marked `@` for an
    // admin and `+` for anyone else signed in.
    nameFor: (userId) => {
      const record = links.get(userId);
      return record ? `${record.admin ? '@' : '+'}${record.callsign}` : null;
    },
    linkFor: (userId) => links.get(userId) || null,
    get size() { return links.size; },
  };
}

module.exports = { createMatrixLinks };
