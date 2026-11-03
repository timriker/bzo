/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// koth.cjs - upstream's plugins/koth, King of the Hill: hold the map's `koth`
// zone long enough and every other tank dies.
//
//   koth
//     position 0 0 0
//     size 20 20 10
//     teamplay
//     holdtime 60
//     autotime 3 50
//     nosound
//   end
//
// The zone is a box (`size`) or a cylinder (`radius`, `height`). `holdtime`
// is the seconds to hold it, 1 to 7200, 60 if none. `teamplay` makes a
// colour team king together, and the whole team must leave before taking it
// again. `autotime` shortens the hold by its first number in percent for each
// player past two, to no less than its second; 3 and 50 if none. `nosound`
// turns off sounds, which upstream's API never sends anyway.
//
// `/kingsay <message>` talks to whoever holds the hill. The rest are for
// admins: `/kothon`, `/kothoff`, `/kothstatus`, `/kothtime <seconds>`,
// `/kothautotimeon`, `/kothautotimeoff`, `/kothtimemult <percent>`,
// `/kothtimemultmin <percent>`, `/kothsoundon` and `/kothsoundoff`.

'use strict';

const COMMANDS = {
  kothstatus: '- say how King of the Hill is set',
  kothon: '- turn King of the Hill on',
  kothoff: '- turn King of the Hill off',
  kothsoundon: '- turn King of the Hill sounds on',
  kothsoundoff: '- turn King of the Hill sounds off',
  kothtimemult: '<percent> - shorten the hold this much per player past two',
  kothtimemultmin: '<percent> - never shorten the hold below this',
  kothtime: '<seconds> - how long the hill must be held',
  kothautotimeon: '- shorten the hold as players join',
  kothautotimeoff: '- keep the hold time whoever plays',
  kingsay: '<message> - talk to whoever holds the hill',
};

// A callsign longer than 16 is cut to 16 and marked.
function truncate(callsign) {
  return `${callsign.slice(0, 16)}~`;
}

// ConvertToNum: one to four digits and nothing else, within the bounds, or 0.
function convertToNum(message, minNum, maxNum) {
  if (!/^[0-9]{1,4}$/.test(message)) return 0;
  const value = Number(message);
  return value >= minNum && value <= maxNum ? value : 0;
}

module.exports = {
  meta: {
    name: 'King Of The Hill',
    version: '1.0',
    author: 'Tim Riker, after upstream',
    description: "hold the map's koth zone long enough and every other tank dies",
    license: 'AGPL-3.0',
  },

  Init(bz) {
    this.bz = bz;
    this.koth = {
      id: -1,
      startTime: 0,
      team: bz.eNoTeam,
      callsign: '',
      teamPlay: false,
      TTH: 60,
      adjustedTime: 60,
      timeMult: 0.03,
      timeMultMin: 0.50,
      enabled: true,
      toldHillOpen: false,
      onePlayerWarn: false,
      autoTimeOn: false,
      TTHminutes: 0,
      TTHseconds: 30,
      playerJustWon: -1,
      soundEnabled: true,
    };
    this.zone = new bz.bz_CustomZoneObject();
    bz.bz_registerCustomMapObject('KOTH', (name, data) => this.mapObject(name, data));
    bz.Register(bz.bz_ePlayerUpdateEvent);
    bz.Register(bz.bz_ePlayerPausedEvent);
    bz.Register(bz.bz_ePlayerPartEvent);
    bz.Register(bz.bz_ePlayerJoinEvent);
    bz.Register(bz.bz_ePlayerDieEvent);
    for (const [command, help] of Object.entries(COMMANDS)) {
      bz.bz_registerCustomSlashCommand(command,
        (playerID, _channel, name, message) => this.slashCommand(playerID, name.toLowerCase(), message), { help });
    }
  },

  mapObject(name, data) {
    const { koth } = this;
    if (name !== 'KOTH' || !data) return false;
    this.zone.handleDefaultOptions(data);
    for (const line of data.data) {
      const nubs = line.split(/\s+/).filter(Boolean);
      if (nubs.length === 0) continue;
      const key = nubs[0].toUpperCase();
      if (key === 'TEAMPLAY') {
        koth.teamPlay = true;
      } else if (key === 'NOSOUND') {
        koth.soundEnabled = false;
      } else if (key === 'AUTOTIME' && nubs.length === 1) {
        koth.autoTimeOn = true;
      } else if (key === 'AUTOTIME' && nubs.length > 2) {
        const temp1 = Number.parseFloat(nubs[1]) || 0;
        const temp2 = Number.parseFloat(nubs[2]) || 0;
        if (temp1 >= 1 && temp1 <= 99) koth.timeMult = temp1 / 100;
        if (temp2 >= 1 && temp2 <= 99) koth.timeMultMin = temp2 / 100;
        koth.autoTimeOn = true;
      } else if (key === 'HOLDTIME' && nubs.length > 1) {
        const temp = Number.parseFloat(nubs[1]) || 0;
        if (temp >= 1 && temp <= 7200) koth.TTH = temp;
      }
    }
    return true;
  },

  teamColor(team) {
    const { bz } = this;
    return {
      [bz.eRedTeam]: 'RED', [bz.eGreenTeam]: 'GREEN', [bz.eBlueTeam]: 'BLUE',
      [bz.ePurpleTeam]: 'PURPLE', [bz.eRogueTeam]: 'ROGUE',
    }[team] ?? ' ';
  },

  playerCount() {
    const { bz } = this;
    return [bz.eRedTeam, bz.eGreenTeam, bz.eBlueTeam, bz.ePurpleTeam, bz.eRogueTeam]
      .reduce((sum, team) => sum + bz.bz_getTeamCount(team), 0);
  },

  say(to, message, params) {
    this.bz.bz_sendTextMessage(this.bz.BZ_SERVER, to, message, params);
  },

  sound(playerID, name) {
    if (this.koth.soundEnabled) this.bz.bz_sendPlayCustomLocalSound(playerID, name);
  },

  onePlayer() {
    const { koth, bz } = this;
    if (this.playerCount() <= 1) {
      if (!koth.onePlayerWarn) this.say(bz.BZ_ALLUSERS, 'King of the Hill disabled: less than 2 players.');
      koth.onePlayerWarn = true;
      return true;
    }
    if (koth.onePlayerWarn) this.say(bz.BZ_ALLUSERS, 'King of the Hill enabled: more than 1 player.');
    koth.onePlayerWarn = false;
    return false;
  },

  autoTime() {
    const { koth } = this;
    const numPlayers = this.playerCount();
    if (!koth.autoTimeOn || numPlayers < 3) {
      koth.adjustedTime = koth.TTH;
      return;
    }
    const timeDown = Math.max(1 - (numPlayers - 2) * koth.timeMult, koth.timeMultMin);
    koth.adjustedTime = Math.trunc(koth.TTH * timeDown);
  },

  // Everyone off `safeTeam` dies, killed by the server.
  killTeams(safeTeam, callsign) {
    const { bz } = this;
    for (const id of bz.bz_getPlayerIndexList()) {
      const player = bz.bz_getPlayerByIndex(id);
      if (!player) continue;
      if (player.team !== safeTeam) {
        bz.bz_killPlayer(player.playerID, true, bz.BZ_SERVER);
        this.sound(player.playerID, 'flag_lost');
      } else {
        this.sound(player.playerID, 'flag_won');
      }
    }
    this.say(bz.BZ_ALLUSERS, '{team} ({player}) IS KING OF THE HILL!', { team: this.teamColor(safeTeam), player: callsign });
  },

  // Everyone but the king dies, killed by the king.
  killPlayers(safeID, callsign) {
    const { bz } = this;
    for (const id of bz.bz_getPlayerIndexList()) {
      const player = bz.bz_getPlayerByIndex(id);
      if (!player) continue;
      if (player.playerID !== safeID) {
        bz.bz_killPlayer(player.playerID, true, this.koth.id);
        this.sound(player.playerID, 'flag_lost');
      } else {
        this.sound(player.playerID, 'flag_won');
      }
    }
    this.say(bz.BZ_ALLUSERS, '{player} IS KING OF THE HILL!', { player: callsign });
  },

  willBeKing(seconds) {
    const { koth, bz } = this;
    if (!koth.teamPlay || koth.team === bz.eRogueTeam) {
      this.say(bz.BZ_ALLUSERS, '{player} will be King in {seconds} secs!', { player: koth.callsign, seconds });
    } else {
      this.say(bz.BZ_ALLUSERS, '{team} ({player}) will be King in {seconds} secs!',
        { team: this.teamColor(koth.team), player: koth.callsign, seconds });
    }
  },

  // A warning each minute, then every ten seconds from thirty.
  sendWarnings() {
    const { koth, bz } = this;
    const timeRemaining = koth.adjustedTime - (bz.bz_getCurrentTime() - koth.startTime);
    const toTens = Math.trunc((timeRemaining + 5) / 10) * 10;
    if (timeRemaining / 60 < koth.TTHminutes && koth.adjustedTime > 59) {
      this.willBeKing(toTens);
      koth.TTHminutes -= 1;
    }
    if (koth.adjustedTime < koth.TTHseconds) {
      koth.TTHseconds -= 10;
      return;
    }
    if (timeRemaining < koth.TTHseconds) {
      this.willBeKing(koth.TTHseconds);
      koth.TTHseconds -= 10;
    }
  },

  initiateKoth(team, callsign, playerID) {
    const { koth, bz } = this;
    koth.team = team;
    koth.callsign = callsign.length > 16 ? truncate(callsign) : callsign;
    koth.id = playerID;
    koth.startTime = bz.bz_getCurrentTime();
    koth.TTHminutes = Math.trunc(koth.adjustedTime / 60 + 0.5);
    koth.TTHseconds = 30;
    koth.toldHillOpen = false;
    // A hold time a multiple of 30 is announced by the warnings instead.
    if (Math.trunc(koth.adjustedTime / 30 + 0.5) !== koth.adjustedTime / 30) {
      const seconds = Math.trunc(koth.adjustedTime);
      if (!koth.teamPlay || koth.team === bz.eRogueTeam) {
        this.say(bz.BZ_ALLUSERS, '{player} has Hill; will be King in {seconds} secs!', { player: koth.callsign, seconds });
      } else {
        this.say(bz.BZ_ALLUSERS, '{team} ({player}) has Hill; will be King in {seconds} secs!',
          { team: this.teamColor(koth.team), player: koth.callsign, seconds });
      }
    }
    if (koth.soundEnabled) {
      for (const id of bz.bz_getPlayerIndexList()) {
        const player = bz.bz_getPlayerByIndex(id);
        if (player) this.sound(player.playerID, player.team !== koth.team ? 'flag_alert' : 'teamgrab');
      }
    }
  },

  // Whether no live tank of `team` is on the hill.
  teamClear(team) {
    const { koth, bz } = this;
    if (team === bz.eRogueTeam || team === bz.eNoTeam || !koth.teamPlay) return true;
    return !bz.bz_getPlayerIndexList().some((id) => {
      const player = bz.bz_getPlayerByIndex(id);
      return player && player.team === team && this.zone.pointInZone(player.lastKnownState.pos) && player.spawned;
    });
  },

  Event(data) {
    const { koth, bz } = this;
    switch (data.eventType) {
      case bz.bz_ePlayerUpdateEvent:
        this.onUpdate(data.playerID, data.state.pos);
        break;
      case bz.bz_ePlayerDieEvent:
        if (koth.enabled && data.playerID === koth.id) {
          koth.id = -1;
          koth.team = bz.eNoTeam;
        }
        break;
      case bz.bz_ePlayerJoinEvent:
        if (koth.enabled) this.autoTime();
        break;
      case bz.bz_ePlayerPartEvent:
        if (!koth.enabled) break;
        this.autoTime();
        if (data.playerID === koth.id) {
          koth.id = -1;
          koth.team = bz.eNoTeam;
        }
        break;
      case bz.bz_ePlayerPausedEvent: {
        if (!koth.enabled) break;
        const player = bz.bz_getPlayerByIndex(data.playerID);
        if (player && this.zone.pointInZone(player.lastKnownState.pos)) {
          bz.bz_killPlayer(data.playerID, true, bz.BZ_SERVER);
          this.say(data.playerID, 'Cannot pause while on the Hill.');
        }
        break;
      }
      default:
        break;
    }
  },

  onUpdate(playerID, pos) {
    const { koth, bz } = this;
    if (!koth.enabled || this.onePlayer()) return;
    if (!koth.toldHillOpen && koth.id === -1) {
      this.say(bz.BZ_ALLUSERS, 'Hill is not controlled - take it!');
      koth.toldHillOpen = true;
    }
    if (!this.zone.pointInZone(pos)) {
      if (playerID === koth.playerJustWon) koth.playerJustWon = -1;
      if (playerID === koth.id) {
        koth.id = -1;
        koth.team = bz.eNoTeam;
      }
      return;
    }
    const player = bz.bz_getPlayerByIndex(playerID);
    if (!player || player.playerID === koth.playerJustWon || !player.spawned) return;
    if ((koth.id === -1 && player.team !== koth.team) || (koth.id === -1 && this.teamClear(koth.team))) {
      this.initiateKoth(player.team, player.callsign, player.playerID);
    }
    const timeStanding = bz.bz_getCurrentTime() - koth.startTime;
    if (timeStanding >= koth.adjustedTime && koth.id !== -1) {
      if (koth.teamPlay && koth.team !== bz.eRogueTeam) {
        this.killTeams(koth.team, koth.callsign);
        bz.bz_sendTextMessageToTeam(bz.BZ_SERVER, koth.team,
          'Your team is King of the Hill!  Entire team must leave hill to retake it.');
      } else {
        this.killPlayers(koth.id, koth.callsign);
        this.say(koth.id, 'You are King of the Hill!  You must leave hill to retake it.');
      }
      koth.playerJustWon = koth.id;
      koth.id = -1;
      return;
    }
    if (koth.id !== -1) this.sendWarnings();
  },

  slashCommand(playerID, command, message) {
    const { koth, bz } = this;
    if (command === 'kingsay') {
      if (koth.id !== -1) bz.bz_sendTextMessage(playerID, koth.id, message);
      else this.say(playerID, 'There is no one attempting to be king right now.');
      return true;
    }
    const fromPlayer = bz.bz_getPlayerByIndex(playerID);
    if (fromPlayer && !fromPlayer.admin) {
      this.say(playerID, 'You must be admin to use the koth commands.');
      return true;
    }
    const all = bz.BZ_ALLUSERS;
    switch (command) {
      case 'kothon':
        koth.enabled = true;
        this.say(all, 'King of the Hill is enabled.');
        return true;
      case 'kothoff':
        koth.enabled = false;
        this.say(all, 'King of the Hill is disabled.');
        return true;
      case 'kothsoundon':
        koth.soundEnabled = true;
        this.say(all, 'King of the Hill sounds are enabled.');
        return true;
      case 'kothsoundoff':
        koth.soundEnabled = false;
        this.say(all, 'King of the Hill sounds are disabled.');
        return true;
      case 'kothtimemult': {
        const value = convertToNum(message, 1, 99);
        if (value > 0) {
          koth.timeMult = value / 100;
          this.say(playerID, 'Auto time multiplier set to {percent} percent.',
            { percent: Math.trunc(koth.timeMult * 100 + 0.5) });
        } else {
          this.say(playerID, 'Auto time multiplier must be between 1 and 99 percent.');
        }
        this.autoTime();
        return true;
      }
      case 'kothtimemultmin': {
        const value = convertToNum(message, 1, 99);
        if (value > 0) {
          koth.timeMultMin = value / 100;
          this.say(playerID, 'Auto time multiplier minimum set to {percent} percent.',
            { percent: Math.trunc(koth.timeMultMin * 100 + 0.5) });
        } else {
          this.say(playerID, 'Auto time multiplier minimum must be between 1 and 99 percent.');
        }
        this.autoTime();
        return true;
      }
      case 'kothstatus':
        this.say(playerID, koth.enabled ? 'King of the Hill is currently enabled.'
          : 'King of the Hill is currently disabled.');
        this.say(playerID, koth.soundEnabled ? 'King of the Hill sounds are currently enabled.'
          : 'King of the Hill sounds are currently disabled.');
        this.say(playerID, koth.autoTimeOn ? 'Automatic time adjustment is currently enabled.'
          : 'Automatic time adjustment is currently disabled.');
        this.say(playerID, 'Time multiplier = {percent} percent.', { percent: Math.trunc(koth.timeMult * 100 + 0.5) });
        this.say(playerID, 'Time multiplier minimum = {percent} percent.',
          { percent: Math.trunc(koth.timeMultMin * 100 + 0.5) });
        this.say(playerID, 'King of the Hill hold time is currently set to: {seconds} seconds',
          { seconds: Math.trunc(koth.adjustedTime + 0.5) });
        return true;
      case 'kothtime': {
        const value = convertToNum(message, 1, 7200);
        if (value > 0) {
          koth.TTH = value;
          this.autoTime();
          this.say(all, 'King of the Hill hold time has been set to {seconds} seconds.', { seconds: Math.trunc(value + 0.5) });
        } else {
          this.say(playerID, 'King of the Hill hold time invalid: must be between 1 and 7200 seconds.');
        }
        this.autoTime();
        return true;
      }
      case 'kothautotimeon':
        koth.autoTimeOn = true;
        this.autoTime();
        this.say(all, 'King of the Hill automatic time adjustment on.');
        return true;
      case 'kothautotimeoff':
        koth.autoTimeOn = false;
        koth.adjustedTime = koth.TTH;
        this.autoTime();
        this.say(all, 'King of the Hill automatic time adjustment off.');
        return true;
      default:
        return false;
    }
  },

  // Translations of what the plugin says, `{ locale: { msgid: msgstr } }`.
  // None yet.
  l10n: {},
};
