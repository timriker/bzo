/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// matrix.cjs - a game server's public chat and one Matrix room, both ways,
// through a Matrix account of the bridge's own. See docs/matrix.md; the
// client is plugins/matrix/client.cjs.
//
// Options, from server.json's "plugins": { "matrix": { ... } }:
//   homeserver    the account's client-server API, as
//                 https://matrix-client.matrix.org
//   accessToken   the account's token
//   room          the room, by alias (#name:server) or id (!id:server)

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createMatrixBridge } = require('./matrix/client.cjs');

let running = null;

module.exports = {
  meta: {
    name: 'Matrix',
    version: '1.0',
    author: 'Tim Riker',
    description: 'Public chat to and from a Matrix room',
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
    // The sync position, beside server.json, readable only by the server's
    // user.
    const file = path.join(bz.bz_getDataDir(), 'matrix-sync.json');
    const bridge = createMatrixBridge({
      homeserver: config.homeserver,
      accessToken: config.accessToken,
      room: config.room,
      announce: ({ name, line }) => bz.bz_sendRelayMessage('Matrix', name, line),
      store: {
        load: () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null),
        save: (value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }),
      },
      log,
      logError,
      setTimer: bz.setTimeout,
    });
    running = { bz, bridge };
    bz.Register(bz.bz_eFilteredChatMessageEvent);
    bridge.start().catch((error) => logError('could not start', error));
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
