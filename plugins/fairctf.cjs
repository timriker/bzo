/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// fairctf.cjs - upstream's plugins/fairCTF: while the colour teams are
// uneven, nobody may grab a team flag, and one already held is taken back
// after a delay.
//
// Its options are upstream's `ratio:gapBy1:gap:dropDelay`, by name:
// `{ "ratio": 0.25, "gapBy1": 2, "gap": 3, "dropDelay": 5 }`, those if none.
// Teams are even when they are the same size; when the smallest has more
// than `gapBy1` players and the largest only one more; or when the
// difference is under `gap` and no more than `ratio` of the smallest.
// `dropDelay` is the seconds a held team flag has left.
//
// `/ctf on|off|auto` forces CTF on or off, or goes back to deciding by the
// teams; it needs FAIRCTF, which an admin holds.

'use strict';

const TEAM_FLAGS = new Set(['R*', 'G*', 'B*', 'P*']);
// A held team flag by the name a player record gives it. Upstream's labels
// a team flag "Red team flag"; bzo names every flag alike.
const TEAM_FLAG_LABELS = new Set(['Red Team (+R*)', 'Green Team (+G*)', 'Blue Team (+B*)', 'Purple Team (+P*)']);

module.exports = {
  meta: {
    name: 'Fair CTF',
    version: '1.0',
    author: 'Tim Riker, after upstream',
    description: 'no team flags while the teams are uneven',
    license: 'AGPL-3.0',
    options: [
      { name: 'ratio', type: 'number', min: 0.05, max: 1, step: 0.05, default: 0.25,
        help: 'Largest difference, as a share of the smallest team' },
      { name: 'gapBy1', type: 'number', min: 1, max: 20, step: 1, default: 2,
        help: 'Smallest team size at which one player more is even' },
      { name: 'gap', type: 'number', min: 1, max: 20, step: 1, default: 3, help: 'Difference that is never even' },
      { name: 'dropDelay', type: 'number', min: 1, max: 60, step: 1, default: 5,
        help: 'Seconds before a held team flag is taken back' },
    ],
  },

  Init(bz, config = {}) {
    this.bz = bz;
    this.allowCTF = true;
    this.autoMode = true;
    this.maxRatio = Number(config.ratio) > 0 ? Number(config.ratio) : 0.25;
    this.maxGapBy1 = Math.trunc(Number(config.gapBy1)) > 0 ? Math.trunc(Number(config.gapBy1)) : 2;
    this.maxGap = Math.trunc(Number(config.gap)) > 0 ? Math.trunc(Number(config.gap)) : 3;
    this.dropDelay = Math.trunc(Number(config.dropDelay)) > 0 ? Math.trunc(Number(config.dropDelay)) : 5;
    this.droptime = 0;
    bz.Register(bz.bz_eAllowFlagGrab);
    bz.Register(bz.bz_ePlayerJoinEvent);
    bz.Register(bz.bz_ePlayerPartEvent);
    bz.Register(bz.bz_eTickEvent);
    bz.bz_registerCustomSlashCommand('ctf', (playerID, _channel, _command, message) => this.slashCommand(playerID, message),
      { help: 'on|off|auto - allow team flags, refuse them, or decide by team sizes' });
    this.updateState(bz.eNoTeam);
  },

  say(to, message, params) {
    this.bz.bz_sendTextMessage(this.bz.BZ_SERVER, to, message, params);
  },

  toAdmins(message, params) {
    this.bz.bz_sendTextMessageToTeam(this.bz.BZ_SERVER, this.bz.eAdministrators, message, params);
  },

  Event(data) {
    const { bz } = this;
    switch (data.eventType) {
      case bz.bz_eAllowFlagGrab:
        if (!this.allowCTF && TEAM_FLAGS.has(bz.bz_getFlagName(data.flagID))) {
          data.allow = false;
          this.say(data.playerID, 'CTF play is currently disabled.');
        }
        break;
      case bz.bz_ePlayerJoinEvent:
        this.updateState(bz.eNoTeam);
        break;
      case bz.bz_ePlayerPartEvent:
        this.updateState(data.record.team);
        break;
      case bz.bz_eTickEvent:
        if (this.droptime !== 0 && bz.bz_getCurrentTime() >= this.droptime) {
          for (const id of bz.bz_getPlayerIndexList()) this.dropTeamFlag(id);
          this.droptime = 0;
        }
        break;
      default:
        break;
    }
  },

  slashCommand(playerID, message) {
    const { bz } = this;
    const cs = bz.bz_getPlayerByIndex(playerID)?.callsign ?? 'UNKNOWN';
    if (!bz.bz_hasPerm(playerID, 'FAIRCTF')) {
      this.say(playerID, '{player}, you do not have permission to use the /ctf command.', { player: cs });
      return true;
    }
    if (message === 'on') {
      if (!this.autoMode && this.allowCTF) {
        this.say(playerID, 'CTF is already set to "on".');
        return true;
      }
      this.autoMode = false;
      this.toAdmins('CTF setting has been changed to "on" by {player}.', { player: cs });
      if (!this.allowCTF) {
        this.say(bz.BZ_ALLUSERS, 'CTF has been enabled by {player}.', { player: cs });
        this.allowCTF = true;
        this.droptime = 0;
      }
    } else if (message === 'off') {
      if (!this.autoMode && !this.allowCTF) {
        this.say(playerID, 'CTF is already set to "off".');
        return true;
      }
      this.autoMode = false;
      this.toAdmins('CTF setting has been changed to "off" by {player}.', { player: cs });
      if (this.allowCTF) {
        this.say(bz.BZ_ALLUSERS, 'CTF has been disabled by {player}.', { player: cs });
        this.allowCTF = false;
        this.setDropTime();
      }
    } else if (message === 'auto') {
      if (this.autoMode) {
        this.say(playerID, 'CTF is already set to "auto".');
        return true;
      }
      this.autoMode = true;
      this.toAdmins('CTF setting has been changed to "auto" by {player}.', { player: cs });
      this.updateState(bz.eNoTeam);
    } else {
      this.say(playerID, 'Usage: /ctf on|off|auto');
    }
    return true;
  },

  dropTeamFlag(playerID) {
    const record = this.bz.bz_getPlayerByIndex(playerID);
    if (!record || !TEAM_FLAG_LABELS.has(record.currentFlag)) return;
    this.bz.bz_removePlayerFlag(playerID);
    this.say(playerID, 'CTF play is currently disabled.');
  },

  updateState(teamLeaving) {
    const { bz } = this;
    if (!this.autoMode) return;
    const fair = this.isEven(teamLeaving);
    if (fair && !this.allowCTF) {
      this.allowCTF = true;
      this.droptime = 0;
      this.say(bz.BZ_ALLUSERS, 'Team sizes are sufficiently even. CTF play is now enabled.');
    } else if (!fair && this.allowCTF) {
      this.allowCTF = false;
      this.say(bz.BZ_ALLUSERS, 'Team sizes are uneven. CTF play is now disabled.');
      this.setDropTime();
    }
  },

  // Held team flags go after the delay.
  setDropTime() {
    const { bz } = this;
    const carried = bz.bz_getPlayerIndexList().some((id) => TEAM_FLAGS.has(bz.bz_getPlayerFlag(id)));
    if (!carried) return;
    this.droptime = bz.bz_getCurrentTime() + this.dropDelay;
    if (this.dropDelay > 1) {
      this.say(bz.BZ_ALLUSERS, 'Currently-held team flags will be dropped in {seconds} seconds.', { seconds: this.dropDelay });
    } else {
      this.say(bz.BZ_ALLUSERS, 'Currently-held team flags will be dropped in 1 second.');
    }
  },

  isEven(teamLeaving) {
    const { bz } = this;
    const sizes = [bz.eRedTeam, bz.eGreenTeam, bz.eBlueTeam, bz.ePurpleTeam]
      .map((team) => bz.bz_getTeamCount(team) - (team === teamLeaving ? 1 : 0));
    const largest = Math.max(0, ...sizes);
    const playing = sizes.filter((size) => size !== 0);
    // No team tanks at all, or every team the same size.
    if (playing.length === 0) return true;
    const smallest = Math.min(...playing);
    if (largest === smallest) return true;
    if (smallest <= this.maxGapBy1) return false;
    if (largest - smallest === 1) return true;
    if ((largest - smallest) / smallest > this.maxRatio) return false;
    return largest - smallest < this.maxGap;
  },

  // Translations of what the plugin says, `{ locale: { msgid: msgstr } }`.
  // None yet.
  l10n: {},
};
