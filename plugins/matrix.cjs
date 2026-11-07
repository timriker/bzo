/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// matrix.cjs - a game server's public chat and one Matrix room, both ways,
// through a Matrix account of the bridge's own, and Matrix accounts linked
// to BZFlag ones. See docs/matrix.md; the client is
// plugins/matrix/client.cjs, the links plugins/matrix/links.cjs.
//
// Options, from server.json's "plugins": { "matrix": { ... } }:
//   homeserver    the account's client-server API, as
//                 https://matrix-client.matrix.org
//   accessToken   the account's token
//   room          the room, by alias (#name:server) or id (!id:server)
//   space         the space that keeps the links, for every bzo server
//                 bridging a room in it, and whose rooms a link's power
//                 level applies in; without one, this server's own links
//                 and the bridged room alone
//   powerLevels   a bzflag.org group, "admin" for the server's admin
//                 groups, or "linked" for every linked member, to a power
//                 level; "admin" is 50 unless set
//   groupRooms    a group, "admin" or "linked", to a room its linked
//                 members are invited to
//   links         true on the one server that answers !link, !unlink and
//                 !whois for the space, in any room its account is in,
//                 serves the link page, and answers direct rooms for a
//                 member who has picked no server; the others only read the
//                 links. Without a space, every server answers for itself.
//   name          this server as members pick it with !use; the host of
//                 its publicUrl unless set
//
// Server commands, `!playerlist` for `/playerlist`, are
// plugins/matrix/commands.cjs.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createMatrixBridge } = require('./matrix/client.cjs');
const { createMatrixLinks } = require('./matrix/links.cjs');
const { createMatrixCommands } = require('./matrix/commands.cjs');

let running = null;

const LINK_COMMANDS = new Set(['!link', '!unlink', '!whois']);

// The page a `!link` URL opens, behind a bzflag.org login: the server's own
// admin groups and every group the options name are asked about.
function linkPage(bz, links) {
  const codes = { 200: bz.e200OK, 403: bz.e403Forbiden, 500: bz.e500ServerError };
  const answer = (response, { status, text }) => {
    response.ReturnCode = codes[status];
    response.AddHeader('Content-Type', 'text/plain; charset=utf-8');
    response.AddHeader('X-Content-Type-Options', 'nosniff');
    response.AddBodyData(`${text}\n`);
    return bz.ePageDone;
  };
  return {
    VDirName: () => 'matrix',
    VDirDescription: () => 'Link a Matrix account to a bzflag.org one',
    RequiredAuthentiction: bz.eBZID,
    BZIDAuthenicationGroups: links.groupsToAsk,
    async GeneratePage(request, response) {
      const page = request.Resource.replace(/^\/plugins\/matrix\/?/i, '');
      if (page !== 'link') return bz.eNoPage;
      return answer(response, await links.complete({
        key: request.GetParamater('key'),
        bzid: request.BZID,
        callsign: request.BZIDCallsign,
        groups: request.BZIDGroups,
        // bzfs's own test for an admin (PlayerAccessInfo::isAdmin).
        admin: request.UserHasPerm('ban') || request.UserHasPerm('shortBan'),
      }));
    },
    GenerateNoAuthPage(request, response) {
      answer(response, { status: 403, text: 'bzflag.org did not accept that sign-in. Type !link in the room again.' });
      return true;
    },
  };
}

module.exports = {
  meta: {
    name: 'Matrix',
    version: '1.0',
    author: 'Tim Riker',
    description: 'Public chat to and from a Matrix room, and Matrix accounts linked to BZFlag ones',
    license: 'AGPL-3.0',
  },

  Init(bz, config) {
    const log = (text) => bz.log(text);
    const logError = (what, error) => bz.log(`${what}: ${error?.message || error}`);
    const missing = ['homeserver', 'accessToken', 'room']
      .filter((key) => typeof config[key] !== 'string' || !config[key]);
    if (missing.length > 0) {
      log(`not bridging: no ${missing.join(', ')}`);
      return;
    }
    // The sync position and the links, beside server.json, readable only by
    // the server's user.
    const jsonStore = (name) => {
      const file = path.join(bz.bz_getDataDir(), name);
      return {
        load: () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null),
        save: (value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 }),
      };
    };
    let links = null;
    let commands = null;
    const bridge = createMatrixBridge({
      homeserver: config.homeserver,
      accessToken: config.accessToken,
      room: config.room,
      nameFor: (userId, displayName) => links?.nameFor(userId) || displayName || userId,
      announce: ({ name, line }) => bz.bz_sendRelayMessage('Matrix', name, line),
      onCommand: (command) => {
        // `/link` sent as a message in a direct room is `!link`, and so on.
        const text = command.text.replace(/^\//, '!');
        const word = text.split(/\s+/)[0].toLowerCase();
        const run = LINK_COMMANDS.has(word) ? links?.command({ ...command, text }) : commands?.handle({ ...command, text });
        Promise.resolve(run).catch((error) => logError(command.text, error));
      },
      onInvite: (invite) => commands?.invited(invite).catch((error) => logError(`invite to ${invite.roomId}`, error)),
      onEncrypted: (event) => commands?.encrypted(event).catch((error) => logError('encrypted message', error)),
      onLink: (event) => links?.heard(event),
      onServer: (event) => commands?.heard(event).catch((error) => logError('server event', error)),
      store: jsonStore('matrix-sync.json'),
      log,
      logError,
      setTimer: bz.setTimeout,
    });
    links = createMatrixLinks({
      client: bridge,
      store: jsonStore('matrix-links.json'),
      publicUrl: bz.bz_getPublicAddr(),
      powerLevels: config.powerLevels,
      groupRooms: config.groupRooms,
      space: typeof config.space === 'string' && config.space ? config.space : null,
      answer: !config.space || config.links === true,
      log,
      logError,
    });
    const publicUrl = bz.bz_getPublicAddr();
    let host = '';
    try { host = new URL(publicUrl).host; } catch { host = ''; }
    commands = createMatrixCommands({
      bz,
      client: bridge,
      links,
      name: typeof config.name === 'string' && config.name ? config.name : host || config.room,
      room: config.room,
      url: publicUrl,
      space: typeof config.space === 'string' && config.space ? config.space : null,
      answer: links.answer,
      log,
    });
    running = { bz, bridge };
    bz.Register(bz.bz_eFilteredChatMessageEvent);
    if (links.answer) bz.bzhttp_RegisterVDir(linkPage(bz, links));
    bridge.start()
      .then((started) => started && links.start().then(() => commands.start()))
      .catch((error) => logError('could not start', error));
  },

  // Public chat, as every player read it, to the room: with BZFlag's
  // scoreboard mark, `@` for an admin and `+` for a signed-in player.
  Event(data) {
    if (data.eventType !== 'bz_eFilteredChatMessageEvent' || !running) return;
    const { bz, bridge } = running;
    if (data.to !== bz.BZ_ALLUSERS) return;
    const record = bz.bz_getPlayerByIndex(data.from);
    if (!record) return;
    bridge.relay(record.callsign, data.message, data.messageType === bz.eActionMessage ? 'action' : 'chat',
      record.admin ? '@' : (record.verified ? '+' : ''));
  },

  Cleanup() {
    running?.bridge.stop();
    running = null;
  },

  l10n: {},
};
