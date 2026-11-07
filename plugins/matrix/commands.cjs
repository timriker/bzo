/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Server commands from Matrix: `!playerlist` for `/playerlist`, run as the
// sender's linked BZFlag account. See docs/matrix.md, "Server commands".
//
// In a server's bridged room, that server runs it and answers in the
// member's direct room with the bot. In the direct room itself, the member
// talks to every server at once -- they all share the bot account -- so the
// servers agree on one: each announces itself in the space
// (`org.bzflag.server`), `!use <server>` records the member's choice on the
// account (`org.bzflag.targets`), and only that server runs what follows;
// with no choice, the server that answers links. `!servers` lists them.

'use strict';

const SERVER_EVENT = 'org.bzflag.server';
const TARGETS = 'org.bzflag.targets';
// A Matrix message's limit is far above this; a reply this long is better
// cut than scrolled.
const REPLY_LIMIT = 4000;
const HELP = [
  'Talk to the game servers here:',
  '!servers lists them, and !use <server> picks the one your commands go to.',
  'Then !playerlist, or any server command with ! for its slash.',
  '!link links your BZFlag account, which commands run as; !whois says who someone is.',
].join('\n');

const enc = encodeURIComponent;

// `name` is this server's, as members pick it; `room` its bridged room, by the
// alias the options gave. `answer` is whether it answers for the space when
// no server has been picked. `space` is where servers announce themselves.
function createMatrixCommands({ bz, client, links, name, room, url = '', space = null, answer, log }) {
  let spaceId = null;
  const me = { name, room, url };

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

  // This server announced in the space, which only its admins may do.
  async function start() {
    if (!space) return;
    spaceId = space.startsWith('#')
      ? (await client.must('GET', `/directory/room/${enc(space)}`)).room_id : space;
    if (answer) {
      const path = `/rooms/${enc(spaceId)}/state/m.room.power_levels/`;
      const power = await client.must('GET', path);
      if ((power.events?.[SERVER_EVENT] ?? -1) < 100) {
        await client.must('PUT', path, { body: { ...power, events: { ...(power.events || {}), [SERVER_EVENT]: 100 } } });
      }
    }
    await client.must('PUT', `/rooms/${enc(spaceId)}/state/${SERVER_EVENT}/${enc(name)}`, { body: me });
    log(`announced as ${name} in ${space}`);
  }

  // Every server announced in the space; this one alone without a space.
  async function servers() {
    if (!spaceId) return [me];
    const state = await client.must('GET', `/rooms/${enc(spaceId)}/state`);
    return state.filter((event) => event.type === SERVER_EVENT && event.content?.name)
      .map((event) => event.content);
  }

  const targetsPath = () => `/user/${enc(client.userId)}/account_data/${TARGETS}`;
  async function targets() {
    const answered = await client.api('GET', targetsPath());
    return answered.ok ? answered.data : {};
  }

  // Run as the member's linked account, the answer cut to a message's size.
  async function run(userId, text) {
    const record = links.linkFor(userId);
    if (!record) return 'Link your BZFlag account first: type !link.';
    const line = `/${text.replace(/^[!/]/, '')}`;
    const replies = await bz.bz_runCommand(line, {
      callsign: record.callsign, bzid: record.bzid, admin: record.admin, via: 'Matrix',
    });
    const body = [`${name}: ${line}`, ...(replies.length ? replies : ['(no reply)'])].join('\n');
    return body.length > REPLY_LIMIT ? `${body.slice(0, REPLY_LIMIT - 1)}…` : body;
  }

  // A direct room with a member: the servers, a choice of one, help, or a
  // command for the chosen one.
  async function direct({ roomId, userId, text }) {
    const [word, ...rest] = text.split(/\s+/);
    const asked = rest.join(' ').trim();
    switch (word.toLowerCase()) {
      case '!help': {
        if (answer) await client.notice(roomId, HELP);
        return;
      }
      case '!servers': {
        if (!answer) return;
        const chosen = (await targets())[userId];
        const list = (await servers()).map((server) => `${server.name}${server.room ? ` (${server.room})` : ''}`
          + (chosen && isNamed(server, chosen) ? ' -- yours' : ''));
        await client.notice(roomId, list.length ? `Servers:\n${list.join('\n')}` : 'No servers have announced themselves.');
        return;
      }
      case '!use': {
        if (!answer) return;
        const all = await servers();
        if (!asked) {
          const chosen = (await targets())[userId];
          await client.notice(roomId, chosen ? `Your commands go to ${chosen}.`
            : `Your commands go to ${name}, until you pick another with !use <server>.`);
          return;
        }
        const found = all.find((server) => isNamed(server, asked));
        if (!found) {
          await client.notice(roomId, `No server is called ${asked}. !servers lists them.`);
          return;
        }
        const now = await targets();
        await client.must('PUT', targetsPath(), { body: { ...now, [userId]: found.name } });
        await client.notice(roomId, `Your commands now go to ${found.name}.`);
        return;
      }
      default: {
        const chosen = (await targets())[userId];
        if (chosen ? !isNamed(me, chosen) : !answer) return;
        await client.notice(roomId, await run(userId, text));
      }
    }
  }

  // Any command line from Matrix that is not a link command: in the bridged
  // room, or in a member's direct room. Elsewhere, nothing.
  async function handle({ roomId, userId, text }) {
    if (roomId === client.roomId) {
      if (!text.startsWith('!')) return;
      await client.notice(await links.directRoom(userId), await run(userId, text));
      return;
    }
    if (await links.isDirect(userId, roomId)) await direct({ roomId, userId, text });
  }

  // Invited to a direct room: joined, and kept as that member's, by the
  // server that answers for the space, which also says what it is for.
  async function invited({ roomId, inviter, direct: isDirectRoom }) {
    if (!answer || !isDirectRoom) return;
    await client.must('POST', `/join/${enc(roomId)}`, { body: {} });
    await links.addDirect(inviter, roomId);
    await client.notice(roomId, HELP);
    log(`direct room with ${inviter}`);
  }

  return { start, handle, invited, servers, isNamed };
}

module.exports = { createMatrixCommands, SERVER_EVENT, TARGETS };
