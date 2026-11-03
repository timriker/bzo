/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// chathistory.cjs - upstream's plugins/chathistory: the last lines each
// callsign said, for admins. `/last <lines> <callsign>` shows them, five when
// the count is not a number; `/flushchat` forgets them all. Its option is the
// lines kept per callsign, `{ "lines": 50 }`, 50 if none.

'use strict';

module.exports = {
  meta: {
    name: 'Chat History',
    version: '1.0',
    author: 'Tim Riker, after upstream',
    description: 'admins see the last lines a callsign said',
    license: 'AGPL-3.0',
    options: [
      { name: 'lines', type: 'number', min: 1, max: 500, step: 1, default: 50, help: 'Lines kept for each callsign' },
    ],
  },

  Init(bz, config = {}) {
    this.bz = bz;
    this.histories = new Map(); // lower-case callsign -> [line, ...]
    this.maxChatLines = config.lines === undefined ? 50 : Math.trunc(Number(config.lines)) || 0;
    const options = { operator: true };
    bz.bz_registerCustomSlashCommand('last', (playerID, _channel, _command, message) => this.last(playerID, message),
      { ...options, help: '<lines> <callsign> - show the last lines a player said' });
    bz.bz_registerCustomSlashCommand('flushchat', (playerID) => this.flush(playerID),
      { ...options, help: '- forget every chat history' });
    bz.Register(bz.bz_eRawChatMessageEvent);
  },

  say(to, message, params) {
    this.bz.bz_sendTextMessage(this.bz.BZ_SERVER, to, message, params);
  },

  allowed(playerID) {
    if (this.bz.bz_getAdmin(playerID)) return true;
    this.say(playerID, 'You must be admin to use the ChatHistory plugin');
    return false;
  },

  last(playerID, message) {
    if (!this.allowed(playerID)) return true;
    const params = message.split(' ').filter(Boolean);
    if (params.length !== 2) {
      this.say(playerID, 'Usage: /last <NUMBER OF LINES> <CALLSIGN>');
      return true;
    }
    let numLines = Number.parseInt(params[0], 10) || 0;
    if (numLines <= 0) numLines = 5;
    const history = this.histories.get(params[1].toLowerCase());
    if (!history || history.length === 0) {
      this.say(playerID, 'That player has no chat history.');
      return true;
    }
    numLines = Math.min(numLines, history.length);
    this.say(playerID, 'Last {count} message(s) for {player}', { count: numLines, player: params[1] });
    for (const line of history.slice(-numLines)) {
      this.say(playerID, '  <{player}> {message}', { player: params[1], message: line });
    }
    return true;
  },

  flush(playerID) {
    if (!this.allowed(playerID)) return true;
    this.histories.clear();
    this.say(playerID, 'Chat History has been flushed');
    return true;
  },

  Event(data) {
    if (data.eventType !== this.bz.bz_eRawChatMessageEvent) return;
    const from = this.bz.bz_getPlayerByIndex(data.from);
    if (!from) return;
    const callsign = from.callsign.toLowerCase();
    if (!this.histories.has(callsign)) this.histories.set(callsign, []);
    const history = this.histories.get(callsign);
    history.push(String(data.message));
    if (history.length > this.maxChatLines) history.shift();
  },

  // Translations of what the plugin says, `{ locale: { msgid: msgstr } }`.
  // None yet.
  l10n: {},
};
