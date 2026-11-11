/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Server commands from Matrix: `!playerlist` for `/playerlist`, run as the
// sender's linked BZFlag account. See docs/matrix.md, "Server commands".
//
// Each server announces itself in its own bridged room (`org.bzflag.server`),
// which its bot is admin of: its name, room, URL, the account it answers as,
// and whether it answers links for the space. The server that answers links
// joins every room in the space it may, so it can list them all.
//
// In a server's bridged room, that server runs a command and answers in the
// member's direct room with its account. In a direct room, a member talks to
// every server that shares the account, so they agree on one: `!use <server>`
// records the member's choice on the account (`org.bzflag.targets`) and only
// that server runs what follows. With no choice, the account's server that
// answers links answers; an operator's own bot, with no such server on its
// account, answers itself -- the first of its servers by name, if it runs
// several.

'use strict';

const SERVER_EVENT = 'org.bzflag.server';
const TARGETS = 'org.bzflag.targets';
// A Matrix message's limit is far above this; a reply this long is better
// cut than scrolled.
const REPLY_LIMIT = 4000;
const HELP = [
  'Talk to the game servers here:',
  '!servers lists them, !use <server> picks the one your commands go to, and !use none goes back to mine.',
  'Then !playerlist, or any server command with ! for its slash; !shelp is that server\'s /help.',
  '!link links your BZFlag account, which commands run as; !whois says who someone is, !whois * who is linked.',
].join('\n');

const enc = encodeURIComponent;

// `name` is this server's, as members pick it; `room` its bridged room, by the
// alias the options gave. `answer` is whether it answers links for the space.
// `space` gathers the servers' rooms.
function createMatrixCommands({ bz, client, links, name, room, url = '', space = null, answer, log }) {
  let spaceId = null;
  // Whether this server answers its account's direct rooms when a member has
  // picked no server, and the rooms other servers bridge: worked out from the
  // announcements, again whenever one changes.
  let directs = answer;
  let serverRooms = new Set();
  const refused = new Set();
  const me = () => ({ name, room, url, account: client.userId, links: Boolean(answer) });

  // The ways a member may name a server: its name with or without the port,
  // its room's alias with or without the `#` and server, or its URL's host.
  const namesOf = (server) => {
    const alias = String(server.room || '');
    const host = (() => {
      try { return new URL(server.url).host; } catch { return ''; }
    })();
    return new Set([server.name, String(server.name).split(':')[0], alias, alias.replace(/^#/, ''),
      alias.replace(/^#/, '').split(':')[0], host].filter(Boolean).map((each) => each.toLowerCase()));
  };
  const isNamed = (server, asked) => namesOf(server).has(String(asked).trim().toLowerCase());
  // The servers a member's word best names: by one of its names exactly,
  // else as the start of one, else anywhere in one -- the first of these
  // that names any.
  const bestNamed = (all, asked) => {
    const word = String(asked).trim().toLowerCase();
    for (const fits of [(each) => each === word, (each) => each.startsWith(word), (each) => each.includes(word)]) {
      const found = all.filter((server) => [...namesOf(server)].some(fits));
      if (found.length) return found;
    }
    return [];
  };

  // The space's rooms, by the space's own hierarchy.
  async function spaceRooms() {
    const answered = await client.api('GET', `/rooms/${enc(spaceId)}/hierarchy`, {
      query: { max_depth: '1' }, version: 'v1',
    });
    return answered.ok ? (answered.data.rooms || []).map((each) => each.room_id).filter((id) => id !== spaceId) : [];
  }

  // A room of the space joined, as anyone may join a public one or a member
  // of the space one open to its members; an invite-only one is passed over,
  // and said so once.
  async function join(roomId) {
    const joined = await client.api('POST', `/join/${enc(roomId)}`, { body: {} });
    if (!joined.ok && !refused.has(roomId)) {
      refused.add(roomId);
      log(`cannot join ${roomId} (${joined.status} ${joined.data.errcode || ''}); invite me to read its server`);
    }
    return joined.ok;
  }

  // Every server announced in a room of the space, or this one alone without
  // a space. A server that answers direct rooms joins a room it is not in
  // yet, to list it.
  async function servers() {
    if (!spaceId) return [me()];
    const found = [];
    for (const roomId of await spaceRooms()) {
      let state = await client.api('GET', `/rooms/${enc(roomId)}/state`);
      if (!state.ok && directs && await join(roomId)) state = await client.api('GET', `/rooms/${enc(roomId)}/state`);
      if (!state.ok || !Array.isArray(state.data)) continue;
      for (const event of state.data) {
        if (event.type === SERVER_EVENT && event.content?.name) found.push({ ...event.content, roomId });
      }
    }
    return found;
  }

  // Who answers what, from the announcements as they stand.
  async function refresh() {
    const all = await servers();
    serverRooms = new Set(all.filter((server) => server.account !== client.userId || server.name !== name)
      .map((server) => server.roomId));
    const mine = all.filter((server) => server.account === client.userId);
    const answering = mine.filter((server) => server.links);
    if (answering.length > 1) {
      log(`more than one server has "links": true -- ${answering.map((server) => server.name).join(', ')}; keep it on one`);
    }
    directs = answer || (answering.length === 0
      && (mine.length === 0 || mine.map((server) => server.name).sort()[0] === name));
    return all;
  }

  // This server announced in its own room. The server that answers links
  // also joins every room in the space it may, and clears the announcements
  // servers once made in the space itself.
  async function start() {
    if (space) {
      spaceId = space.startsWith('#')
        ? (await client.must('GET', `/directory/room/${enc(space)}`)).room_id : space;
    }
    const announced = await client.api('PUT', `/rooms/${enc(client.roomId)}/state/${SERVER_EVENT}/${enc(name)}`, {
      body: me(),
    });
    if (!announced.ok) log(`could not announce in ${room}: ${announced.status}; make me admin there`);
    if (spaceId && answer) {
      for (const roomId of await spaceRooms()) await join(roomId);
      const state = await client.api('GET', `/rooms/${enc(spaceId)}/state`);
      const old = (state.ok ? state.data : []).filter((event) => event.type === SERVER_EVENT && event.content?.name);
      for (const event of old) {
        await client.api('PUT', `/rooms/${enc(spaceId)}/state/${SERVER_EVENT}/${enc(event.state_key)}`, { body: {} });
      }
    }
    await refresh();
    log(`announced as ${name} in ${room}`);
  }

  // A room added to the space, joined by the server that answers links; a
  // server's announcement changed. Either may change who answers what.
  async function heard({ roomId, event }) {
    if (event.type === 'm.space.child' && roomId === spaceId && answer && event.content?.via?.length) {
      await join(event.state_key);
    }
    if (event.type === 'm.space.child' || event.type === SERVER_EVENT) await refresh();
  }

  const targetsPath = () => `/user/${enc(client.userId)}/account_data/${TARGETS}`;
  async function targets() {
    const answered = await client.api('GET', targetsPath());
    return answered.ok ? answered.data : {};
  }

  // Run as the member's linked account, the answer cut to a message's size,
  // led by the server and the command unless `echo` is false.
  async function run(userId, text, { echo = true } = {}) {
    const record = links.linkFor(userId);
    if (!record) return 'Link your BZFlag account first: type !link.';
    const line = /^[!/]shelp$/i.test(text.trim()) ? '/help' : `/${text.replace(/^[!/]/, '')}`;
    const replies = await bz.bz_runCommand(line, {
      callsign: record.callsign, bzid: record.bzid, admin: record.admin, via: 'Matrix',
    });
    const body = [...(echo ? [`${name}: ${line}`] : []), ...(replies.length ? replies : ['(no reply)'])].join('\n');
    return body.length > REPLY_LIMIT ? `${body.slice(0, REPLY_LIMIT - 1)}…` : body;
  }

  // The servers, as a member reads them: the one they picked, and which
  // answer as another account and so in a direct chat of their own.
  function describe(all, chosen) {
    return all.map((server) => `${server.name}${server.room ? ` (${server.room})` : ''}`
      + (chosen && isNamed(server, chosen) ? ' -- yours' : '')
      + (server.account && server.account !== client.userId ? ` -- message ${server.account}` : ''));
  }

  // A direct room with a member: the servers, a choice of one, help, or a
  // command for the chosen one. `!shelp` is that server's `/help`, which
  // the server that answers direct rooms names first -- said even if the
  // server picked runs too old a bzo to answer.
  async function direct({ roomId, userId, text }) {
    const [word, ...rest] = text.split(/\s+/);
    const asked = rest.join(' ').trim();
    switch (word.toLowerCase()) {
      case '!help': {
        if (directs) await client.notice(roomId, HELP);
        return;
      }
      case '!shelp': {
        const chosen = (await targets())[userId];
        const header = `/help on ${chosen || name}; !use <server> changes it.`;
        if (chosen ? isNamed(me(), chosen) : directs) {
          const help = await run(userId, '/help', { echo: false });
          await client.notice(roomId, directs ? `${header}\n${help}` : help);
        } else if (directs) {
          await client.notice(roomId, header);
        }
        return;
      }
      case '!servers': {
        if (!directs) return;
        const list = describe(await refresh(), (await targets())[userId]);
        await client.notice(roomId, list.length ? `Servers:\n${list.join('\n')}` : 'No servers have announced themselves.');
        return;
      }
      case '!use': {
        if (!directs) return;
        if (!asked) {
          const chosen = (await targets())[userId];
          await client.notice(roomId, chosen ? `Your commands go to ${chosen}.`
            : `No server picked: your commands go to ${name}, the default. !use <server> picks one.`);
          return;
        }
        if (asked.toLowerCase() === 'none') {
          const now = await targets();
          delete now[userId];
          await client.must('PUT', targetsPath(), { body: now });
          await client.notice(roomId, `No server picked: your commands go to ${name}, the default. !use <server> picks one.`);
          return;
        }
        const named = bestNamed(await refresh(), asked);
        if (named.length !== 1) {
          await client.notice(roomId, named.length
            ? `${asked} could be ${named.map((server) => server.name).join(' or ')}; say which.`
            : `No server is called ${asked}. !servers lists them.`);
          return;
        }
        const [found] = named;
        if (found.account && found.account !== client.userId) {
          await client.notice(roomId, `${found.name} answers as ${found.account}: message it there.`);
          return;
        }
        const now = await targets();
        await client.must('PUT', targetsPath(), { body: { ...now, [userId]: found.name } });
        await client.notice(roomId, `Your commands now go to ${found.name}.`);
        return;
      }
      default: {
        const chosen = (await targets())[userId];
        if (chosen ? !isNamed(me(), chosen) : !directs) return;
        await client.notice(roomId, await run(userId, text));
      }
    }
  }

  // Any command line from Matrix that is not a link command. In the bridged
  // room, this server runs it and answers in the member's direct room;
  // `!servers` and `!help` there are the links server's. In a direct room, as
  // `direct` says. Elsewhere in the space, the server that answers links
  // lists the servers or gives the help, since neither says anything
  // private, and points anything else at the direct room -- except in
  // another server's room, where that server runs it.
  async function handle({ roomId, userId, text }) {
    const word = text.split(/\s+/)[0].toLowerCase();
    const listing = word === '!servers' || word === '!help';
    if (roomId === client.roomId) {
      if (listing) {
        if (answer) await direct({ roomId, userId, text });
        return;
      }
      if (!text.startsWith('!')) return;
      await client.notice(await links.directRoom(userId), await run(userId, text));
      return;
    }
    if (await links.isDirect(userId, roomId)) {
      await direct({ roomId, userId, text });
      return;
    }
    if (!answer) return;
    if (listing) {
      await direct({ roomId, userId, text });
    } else if (/^![a-z]+$/.test(word) && !serverRooms.has(roomId)) {
      await links.directRoom(userId);
      await client.notice(roomId, `${userId}: server commands go in your direct chat with me, where !use picks`
        + ' the server; I have opened it if it was not.');
    }
  }

  // Invited to a direct room: joined, and kept as that member's, by the
  // server that answers its account's direct rooms, which also says what it
  // is for.
  async function invited({ roomId, inviter, direct: isDirectRoom, encrypted }) {
    if (!directs || !isDirectRoom) return;
    await client.must('POST', `/join/${enc(roomId)}`, { body: {} });
    if (encrypted) {
      await moveOut(roomId, inviter);
      return;
    }
    await links.addDirect(inviter, roomId);
    await client.notice(roomId, HELP);
    log(`direct room with ${inviter}`);
  }

  // An encrypted direct room, which Element makes by default: the bot reads
  // none of it, so it says so there -- in the clear, which an encrypted room
  // still shows -- and opens an unencrypted one. Once a room, however many
  // messages it is sent.
  const movedOut = new Set();
  async function moveOut(roomId, userId) {
    if (movedOut.has(roomId)) return;
    movedOut.add(roomId);
    const opened = await links.openDirectRoom(userId);
    await client.notice(roomId, 'This chat is encrypted, which I cannot read. I have opened an unencrypted'
      + ' chat with you: talk to me there.');
    await client.notice(opened, HELP);
    log(`encrypted room ${roomId} from ${userId}; opened ${opened}`);
  }

  // An encrypted message in one of a member's direct rooms.
  async function encrypted({ roomId, userId }) {
    if (!directs || !(await links.isDirect(userId, roomId))) return;
    await moveOut(roomId, userId);
  }

  return {
    start, handle, heard, invited, encrypted, servers, isNamed, get directs() { return directs; },
  };
}

module.exports = { createMatrixCommands, SERVER_EVENT, TARGETS };
