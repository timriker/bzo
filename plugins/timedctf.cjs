/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// timedctf.cjs - upstream's plugins/timedctf: each colour team must capture
// a flag within the time limit or the whole team dies, warned as the time
// runs down. With fair CTF on, it runs only while the teams are balanced --
// no worse than 3 against 4 -- and a team flag is taken from whoever grabs
// one while they are not. Its option is the limit in minutes, 1 to 120,
// `{ "minutes": 5 }`, 5 if none.
//
// For admins: `/tctfon`, `/tctfoff`, `/tctfstatus`, `/tctftime <minutes>`,
// `/fairctfon`, `/fairctfoff`, `/tctfsoundon` and `/tctfsoundoff`.

'use strict';

const COMMANDS = {
  tctfstatus: '- say how Timed CTF is set',
  tctftime: '<minutes> - the time each team has to capture',
  tctfon: '- turn Timed CTF on',
  tctfoff: '- turn Timed CTF off',
  fairctfon: '- run only while the teams are balanced',
  fairctfoff: '- run whatever the team sizes',
  tctfsoundon: '- turn Timed CTF sounds on',
  tctfsoundoff: '- turn Timed CTF sounds off',
};

const TEAM_FLAGS = new Set(['R*', 'G*', 'B*', 'P*']);

// ConvertToInt: one to three digits and nothing else, 1 to 120, or 0.
function convertToInt(message) {
  if (!/^[0-9]{1,3}$/.test(String(message ?? ''))) return 0;
  const value = Number(message);
  return value >= 1 && value <= 120 ? value : 0;
}

module.exports = {
  meta: {
    name: 'Timed CTF',
    version: '1.0',
    author: 'Tim Riker, after upstream',
    description: 'a team that does not capture a flag in time dies',
    license: 'AGPL-3.0',
    options: [
      { name: 'minutes', type: 'number', min: 1, max: 120, step: 1, default: 5, help: 'Time each team has to capture' },
    ],
  },

  Init(bz, config = {}) {
    this.bz = bz;
    this.teams = [
      { team: bz.eRedTeam, color: 'RED', name: 'red' },
      { team: bz.eGreenTeam, color: 'GREEN', name: 'green' },
      { team: bz.eBlueTeam, color: 'BLUE', name: 'blue' },
      { team: bz.ePurpleTeam, color: 'PURPLE', name: 'purple' },
    ];
    const minutes = convertToInt(config.minutes === undefined ? '' : String(config.minutes));
    this.tctf = {
      timeLimit: minutes > 0 ? minutes * 60 : 300,
      timerRunning: false,
      enabled: true,
      fairCTFEnabled: true,
      notifiedCTFOK: false,
      fairCTF: false,
      soundEnabled: true,
    };
    this.resetTeamData();
    bz.Register(bz.bz_eCaptureEvent);
    bz.Register(bz.bz_ePlayerJoinEvent);
    bz.Register(bz.bz_ePlayerUpdateEvent);
    bz.Register(bz.bz_eTickEvent);
    for (const [command, help] of Object.entries(COMMANDS)) {
      bz.bz_registerCustomSlashCommand(command,
        (playerID, _channel, name, message) => this.slashCommand(playerID, name.toLowerCase(), message), { help });
    }
  },

  say(to, message, params) {
    this.bz.bz_sendTextMessage(this.bz.BZ_SERVER, to, message, params);
  },

  sayTeam(team, message, params) {
    this.bz.bz_sendTextMessageToTeam(this.bz.BZ_SERVER, team, message, params);
  },

  // When each team last captured and was last warned: now.
  resetTeamData() {
    const now = this.bz.bz_getCurrentTime();
    for (const entry of this.teams) {
      entry.lastTime = now;
      entry.lastWarn = now;
    }
  },

  count(team) {
    return this.bz.bz_getTeamCount(team);
  },

  // At least two colour players, and some pair of teams within 3 to 4.
  teamsBalanced() {
    const sizes = this.teams.map(({ team }) => this.count(team));
    if (sizes.reduce((sum, size) => sum + size, 0) <= 1) return false;
    for (let a = 0; a < sizes.length; a += 1) {
      for (let b = a + 1; b < sizes.length; b += 1) {
        const big = Math.max(sizes[a], sizes[b]);
        if (big !== 0 && Math.min(sizes[a], sizes[b]) / big >= 0.75) return true;
      }
    }
    return false;
  },

  onlyOneTeamPlaying() {
    return this.teams.filter(({ team }) => this.count(team) > 0).length === 1;
  },

  killTeam(teamToKill) {
    const { bz, tctf } = this;
    for (const id of bz.bz_getPlayerIndexList()) {
      const player = bz.bz_getPlayerByIndex(id);
      if (!player) continue;
      if (player.team === teamToKill) {
        bz.bz_killPlayer(player.playerID, true, bz.BZ_SERVER);
        if (tctf.soundEnabled) bz.bz_sendPlayCustomLocalSound(player.playerID, 'flag_lost');
      } else if (tctf.soundEnabled) {
        bz.bz_sendPlayCustomLocalSound(player.playerID, 'flag_won');
      }
    }
  },

  // A team's warnings, or its end: 1 resets its warning time, 2 its capture
  // time as well.
  teamCheck(entry) {
    const { bz, tctf } = this;
    if (this.count(entry.team) === 0 || !tctf.timerRunning) return 0;
    const now = bz.bz_getCurrentTime();
    const timeElapsed = now - entry.lastTime;
    const timeRemaining = tctf.timeLimit - timeElapsed;
    const color = entry.color;
    if (now - entry.lastWarn > 60) {
      this.sayTeam(entry.team, '{team} Team: less than {minutes} minute(s) left to capture a flag!',
        { team: color, minutes: Math.trunc(timeRemaining / 60) + 1 });
      return 1;
    }
    if (now - entry.lastWarn > 30 && timeRemaining < 30) {
      this.sayTeam(entry.team, '{team} Team: less than 30 seconds left to capture a flag!', { team: color });
      return 1;
    }
    if (now - entry.lastWarn > 10 && timeRemaining < 20 && timeRemaining > 10) {
      this.sayTeam(entry.team, '{team} Team: less than 20 seconds left to capture a flag!', { team: color });
      return 1;
    }
    if (now - entry.lastWarn > 10 && timeRemaining < 10 && timeRemaining > 1) {
      this.sayTeam(entry.team, '{team} Team: less than 10 seconds left to capture a flag!', { team: color });
      return 1;
    }
    if (timeElapsed >= tctf.timeLimit) {
      this.killTeam(entry.team);
      this.say(bz.BZ_ALLUSERS, '{team} team did not capture any other team flags in time.', { team: color });
      this.sayTeam(entry.team, 'CTF timer is reset to {minutes} minutes for the {team} team.',
        { minutes: Math.trunc(tctf.timeLimit / 60 + 0.5), team: color });
      return 2;
    }
    return 0;
  },

  Event(data) {
    const { bz } = this;
    switch (data.eventType) {
      case bz.bz_ePlayerUpdateEvent: this.onUpdate(data); break;
      case bz.bz_eTickEvent: this.onTick(); break;
      case bz.bz_eCaptureEvent: this.onCapture(data); break;
      case bz.bz_ePlayerJoinEvent: this.onJoin(data); break;
      default: break;
    }
  },

  onJoin(data) {
    const { bz, tctf } = this;
    if (!tctf.fairCTF) {
      this.say(data.playerID, 'Capture The Flag disabled - teams are not evenly balanced.');
      return;
    }
    if (!tctf.enabled && tctf.fairCTFEnabled) {
      this.say(data.playerID, 'Capture The Flag enabled - teams are evenly balanced.');
      return;
    }
    if (!tctf.enabled || !tctf.timerRunning) return;
    const entry = this.teams.find(({ team }) => team === data.record.team);
    if (!entry) return;
    const timeRemaining = tctf.timeLimit - (bz.bz_getCurrentTime() - entry.lastTime);
    this.say(data.playerID, 'Timed CTF now in progress - capture a flag in less than {minutes} minute(s)!',
      { minutes: Math.trunc(timeRemaining / 60) + 1 });
  },

  onCapture(data) {
    const { bz, tctf } = this;
    if (!tctf.enabled || !tctf.timerRunning) return;
    const entry = this.teams.find(({ team }) => team === data.teamCapping);
    if (!entry) return;
    this.sayTeam(entry.team, 'CTF timer is reset to {minutes} minutes for the {team} team.',
      { minutes: Math.trunc(tctf.timeLimit / 60 + 0.5), team: entry.name });
    entry.lastTime = bz.bz_getCurrentTime();
    entry.lastWarn = entry.lastTime;
  },

  onTick() {
    const { bz, tctf } = this;
    tctf.fairCTF = this.teamsBalanced() || !tctf.fairCTFEnabled;
    if (tctf.fairCTF && !tctf.notifiedCTFOK && !tctf.enabled && tctf.fairCTFEnabled) {
      this.say(bz.BZ_ALLUSERS, 'Capture The Flag enabled - teams are evenly balanced.');
      tctf.notifiedCTFOK = true;
      return;
    }
    if (!tctf.fairCTF && tctf.notifiedCTFOK && !tctf.enabled && tctf.fairCTFEnabled) {
      this.say(bz.BZ_ALLUSERS, 'Capture The Flag disabled - teams are not evenly balanced.');
      tctf.notifiedCTFOK = false;
      return;
    }
    if (!tctf.enabled) return;
    if (!tctf.fairCTF && !tctf.timerRunning) return;
    if (!tctf.fairCTF && tctf.timerRunning && tctf.fairCTFEnabled) {
      this.say(bz.BZ_ALLUSERS, 'Capture The Flag disabled - teams are not evenly balanced.');
      tctf.timerRunning = false;
      this.resetTeamData();
      return;
    }
    if (tctf.fairCTF && !tctf.fairCTFEnabled && this.onlyOneTeamPlaying()) {
      if (tctf.timerRunning) this.say(bz.BZ_ALLUSERS, 'Timed CTF disabled - not enough teams.');
      tctf.timerRunning = false;
      this.resetTeamData();
      return;
    }
    if (tctf.fairCTF && !tctf.timerRunning && !this.onlyOneTeamPlaying()) {
      this.say(bz.BZ_ALLUSERS, 'Timed CTF now in progress - capture a flag in less than {minutes} minute(s)!',
        { minutes: Math.trunc(tctf.timeLimit / 60 + 0.5) });
      tctf.timerRunning = true;
      this.resetTeamData();
      return;
    }
    const results = this.teams.map((entry) => this.teamCheck(entry));
    const now = bz.bz_getCurrentTime();
    this.teams.forEach((entry, index) => {
      if (results[index] >= 1) entry.lastWarn = now;
      if (results[index] === 2) entry.lastTime = now;
    });
    // A team with nobody on it starts its clock again.
    for (const entry of this.teams) {
      if (this.count(entry.team) === 0) {
        entry.lastTime = now;
        entry.lastWarn = now;
      }
    }
  },

  onUpdate(data) {
    const { bz, tctf } = this;
    if (tctf.fairCTF) return;
    if (TEAM_FLAGS.has(bz.bz_getPlayerFlag(data.playerID))) {
      bz.bz_removePlayerFlag(data.playerID);
      this.say(data.playerID, 'Capture The Flag disabled - teams are not evenly balanced.');
    }
  },

  slashCommand(playerID, command, message) {
    const { bz, tctf } = this;
    const fromPlayer = bz.bz_getPlayerByIndex(playerID);
    if (fromPlayer && !fromPlayer.admin) {
      this.say(playerID, 'You must be admin to use the ctfcaptime commands.');
      return true;
    }
    const all = bz.BZ_ALLUSERS;
    const minutes = () => Math.trunc(tctf.timeLimit / 60 + 0.5);
    switch (command) {
      case 'tctfon':
        tctf.enabled = true;
        if (!tctf.timerRunning) this.resetTeamData();
        this.say(all, 'Timed CTF is enabled.');
        return true;
      case 'tctfoff':
        tctf.enabled = false;
        tctf.timerRunning = false;
        this.say(all, 'Timed CTF is disabled.');
        return true;
      case 'fairctfon':
        tctf.fairCTFEnabled = true;
        this.say(all, 'Fair CTF is enabled.');
        return true;
      case 'fairctfoff':
        tctf.fairCTFEnabled = false;
        this.say(all, 'Fair CTF is disabled.');
        if (!tctf.timerRunning) this.resetTeamData();
        return true;
      case 'tctfsoundon':
        tctf.soundEnabled = true;
        this.say(all, 'Timed CTF sound is enabled.');
        return true;
      case 'tctfsoundoff':
        tctf.soundEnabled = false;
        this.say(all, 'Timed CTF sound is disabled.');
        return true;
      case 'tctfstatus':
        if (tctf.enabled && !tctf.timerRunning) this.say(playerID, 'Timed CTF is currently enabled, but not running.');
        if (tctf.enabled && tctf.timerRunning) this.say(playerID, 'Timed CTF is currently enabled, and running');
        if (!tctf.enabled) this.say(playerID, 'Timed CTF is currently disabled.');
        this.say(playerID, tctf.fairCTFEnabled ? 'Fair CTF is currently enabled' : 'Fair CTF is currently disabled');
        this.say(playerID, tctf.soundEnabled ? 'Timed CTF sounds are currently enabled'
          : 'Timed CTF sounds are currently disabled');
        this.say(playerID, 'CTF capture time is currently set to: {minutes} minutes', { minutes: minutes() });
        return true;
      case 'tctftime': {
        const value = convertToInt(message);
        if (value > 0) {
          tctf.timeLimit = value * 60;
          this.say(all, 'CTF capture time has been set to {minutes} minutes.', { minutes: minutes() });
          if (!tctf.enabled) this.say(all, '(Timed CTF is still disabled)');
          this.resetTeamData();
        } else {
          this.say(playerID, 'CTF capture time invalid: must be between 1 and 120 minutes.');
        }
        return true;
      }
      default:
        return false;
    }
  },

  // Translations of what the plugin says, `{ locale: { msgid: msgstr } }`.
  // None yet.
  l10n: {},
};
