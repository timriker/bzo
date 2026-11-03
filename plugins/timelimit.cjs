/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// timelimit.cjs - upstream's plugins/TimeLimit: on a server whose clock
// waits for /countdown, `/timelimit <minutes>` sets the next match's
// length, `/timelimit show` says it and `/timelimit reset` puts back the
// server's own. It goes back to the server's own after each match, and when
// the first player joins an empty server. Its option is the lengths allowed,
// in minutes, as upstream's command line: `{ "times": "10,15,20" }` or a
// range, `{ "times": "5-30" }`; any length if none. Needs TIMELIMIT, which an
// admin holds.

'use strict';

const MAX_TIMES = 20;

// parseCommand: `a-b` is every minute from a to b, and a list of digits and
// commas is those, up to MAX_TIMES; anything else allows any length.
function parseTimes(text) {
  const line = String(text ?? '');
  const range = /^(\d+)-(\d+)$/.exec(line);
  if (range) {
    const times = [];
    for (let minute = Number(range[1]); minute <= Number(range[2]); minute += 1) times.push(minute);
    return times;
  }
  if (line && /^[,0-9]+$/.test(line)) return line.split(',').filter(Boolean).slice(0, MAX_TIMES).map(Number);
  return [];
}

module.exports = {
  meta: {
    name: 'Time Limit',
    version: '1.0',
    author: 'Tim Riker, after upstream',
    description: '/timelimit sets the next match length on a manually started server',
    license: 'AGPL-3.0',
    options: [
      { name: 'times', type: 'string', maxLength: 100, default: '',
        help: 'Match lengths allowed, in minutes: 10,15,20 or 5-30; any if empty' },
    ],
  },

  Init(bz, config = {}) {
    this.bz = bz;
    this.timeList = parseTimes(config.times);
    this.saveTimeLimit = bz.bz_getTimeLimit();
    bz.bz_registerCustomSlashCommand('timelimit', (playerID, _channel, _command, _message, params) => this.slashCommand(playerID, params),
      { help: '<minutes>|show|reset - the next match length' });
    bz.Register(bz.bz_ePlayerJoinEvent);
    bz.Register(bz.bz_eGameEndEvent);
  },

  Cleanup() {
    this.bz.bz_setTimeLimit(this.saveTimeLimit);
  },

  say(to, message, params) {
    this.bz.bz_sendTextMessage(this.bz.BZ_SERVER, to, message, params);
  },

  isValidTime(minutes) {
    return this.timeList.length === 0 || this.timeList.includes(minutes);
  },

  Event(data) {
    const { bz } = this;
    if (data.eventType === bz.bz_ePlayerJoinEvent) {
      if (bz.bz_getPlayerCount() === 1 && bz.bz_isTimeManualStart() && !bz.bz_isCountDownActive()
        && !bz.bz_isCountDownInProgress()) {
        bz.bz_setTimeLimit(this.saveTimeLimit);
      }
    } else if (data.eventType === bz.bz_eGameEndEvent) {
      bz.bz_setTimeLimit(this.saveTimeLimit);
    }
  },

  slashCommand(playerID, params) {
    const { bz } = this;
    if (!bz.bz_hasPerm(playerID, 'TIMELIMIT')) {
      this.say(playerID, 'You do not have permission to run the timelimit command');
      return true;
    }
    if (!bz.bz_isTimeManualStart()) {
      this.say(playerID, 'This server was not configured for manual clock countdowns');
      return true;
    }
    const arg = params[0] ?? '';
    if (!arg) {
      this.say(playerID, 'Usage : /timelimit <minutes>|show|reset');
      return true;
    }
    const minutes = () => Math.round(bz.bz_getTimeLimit() / 60);
    if (arg.toLowerCase() === 'show') {
      this.say(playerID, 'Match duration is set to {minutes} minute(s)', { minutes: minutes() });
      return true;
    }
    if (bz.bz_isCountDownInProgress()) {
      this.say(playerID, "There is a countdown already in progress, match duration can't be changed now");
      return true;
    }
    if (bz.bz_isCountDownActive()) {
      this.say(playerID, "A game is already in progress, match duration can't be changed now");
      return true;
    }
    const callsign = bz.bz_getPlayerByIndex(playerID)?.callsign ?? '';
    if (arg.toLowerCase() === 'reset') {
      bz.bz_setTimeLimit(this.saveTimeLimit);
      this.say(bz.BZ_ALLUSERS, 'Match duration reset to {minutes} minute(s) by {player}', { minutes: minutes(), player: callsign });
      return true;
    }
    if (!/^[0-9]+$/.test(arg)) {
      this.say(playerID, 'Not a correct value');
      return true;
    }
    const limit = Number(arg);
    if (limit <= 0) {
      this.say(playerID, "Match duration can't be equal or lower then 0");
      return true;
    }
    if (!this.isValidTime(limit)) {
      this.say(playerID, 'Not a valid match duration, valid match durations are : ');
      for (const time of this.timeList) this.say(playerID, '* {minutes} minute(s)', { minutes: time });
      return true;
    }
    bz.bz_setTimeLimit(limit * 60);
    this.say(bz.BZ_ALLUSERS, 'Match duration set to {minutes} minute(s) by {player}', { minutes: minutes(), player: callsign });
    return true;
  },

  // Translations of what the plugin says, `{ locale: { msgid: msgstr } }`.
  // None yet.
  l10n: {},
};
