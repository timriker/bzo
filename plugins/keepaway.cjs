/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// keepaway.cjs - upstream's plugins/keepaway: one flag at a time is the Keep
// Away flag, and whoever holds it long enough kills every other tank.
//
//   keepaway
//     keepawayflags GM L SW
//     holdtime 120
//     teamplay
//     autotime
//     forcedflags
//     noflagreset
//     nosound
//   end
//
// `keepawayflags` are the flags taken in turn, the next one free once one is
// kept; without them the plugin does nothing. `holdtime` is the seconds to
// keep one, 1 to 7200, 120 if none. `teamplay` makes a colour team win
// together. `autotime` shortens the hold by 3% for each player past two, to
// no less than half; upstream reads a percentage and a floor after it too,
// but its bare `autotime` test catches the line first, so they are never
// used, here as there. `forcedflags` takes the next flag from whoever holds
// it rather than skipping to a free one. `noflagreset` leaves unheld flags
// where they are after a win. `nosound` turns off sounds, which upstream's
// API never sends anyway.
//
// `/kas <message>` talks to the keeper and `/kaf` names the flag. The rest
// are for admins: `/kaon`, `/kaoff`, `/kastatus`, `/katime <seconds>`,
// `/kaautotimeon`, `/kaautotimeoff`, `/katimemult <percent>`,
// `/katimemultmin <percent>`, `/kaffon`, `/kaffoff`, `/kaf+` (the next
// flag), `/kasoundon`, `/kasoundoff`, `/kaflagreseton` and `/kaflagresetoff`.

'use strict';

const COMMANDS = {
  kastatus: '- say how Keep Away is set',
  kaon: '- turn Keep Away on',
  kaoff: '- turn Keep Away off',
  katimemult: '<percent> - shorten the hold this much per player past two',
  katimemultmin: '<percent> - never shorten the hold below this',
  katime: '<seconds> - how long the flag must be kept',
  kaautotimeon: '- shorten the hold as players join',
  kaautotimeoff: '- keep the hold time whoever plays',
  kas: '<message> - talk to whoever keeps the flag',
  kaffon: '- take the next flag from whoever holds it',
  kaffoff: '- skip to the next free flag instead',
  kaf: '- name the Keep Away flag',
  'kaf+': '- move on to the next Keep Away flag',
  kasoundon: '- turn Keep Away sounds on',
  kasoundoff: '- turn Keep Away sounds off',
  kaflagreseton: '- reset unheld flags after a win',
  kaflagresetoff: '- leave unheld flags after a win',
};

// convertFlag: the flags Keep Away may use, by abbreviation, as upstream
// names them.
const FLAG_NAMES = {
  V: 'High Speed (V)', QT: 'Quick Turn (QT)', A: 'Agility (A)', OO: 'Oscillation Overthruster (OO)',
  F: 'Rapid Fire (F)', MG: 'Machine Gun (MG)', GM: 'Guided Missile (GM)', L: 'Laser (L)', R: 'Ricochet (R)',
  SB: 'Super Bullet (SB)', ST: 'Stealth (ST)', CL: 'Cloaking (CL)', IB: 'Invisible Bullet (IB)', T: 'Tiny (T)',
  N: 'Narrow (N)', SH: 'Shield (SH)', SR: 'Steamroller (SR)', SW: 'ShockWave (SW)', PZ: 'Phantom Zone (PZ)',
  G: 'Genocide (G)', JP: 'Jumping (JP)', ID: 'Identify (ID)', MQ: 'Masquerade (MQ)', BU: 'Burrow (BU)',
  SE: 'Seer (SE)', TH: 'Thief (TH)', US: 'Useless (US)', WG: 'Wings (WG)', CB: 'Colorblindness (CB)',
  OB: 'Obesity (OB)', LT: 'Left Turn Only (LT)', RT: 'Right Turn Only (RT)', FO: 'Forward Only (FO)',
  RO: 'Reverse Only (RO)', M: 'Momentum (M)', B: 'Blindness (B)', JM: 'Jamming (JM)', WA: 'Wide Angle (WA)',
  NJ: 'No Jumping (NJ)', TR: 'Trigger Happy (TR)', RC: 'Reverse Controls (RC)', 'R*': 'Red Team (R*)',
  'G*': 'Green Team (G*)', 'B*': 'Blue Team (B*)', 'P*': 'Purple Team (P*)',
};

function convertFlag(abbreviation) {
  return Object.hasOwn(FLAG_NAMES, abbreviation) ? FLAG_NAMES[abbreviation] : '';
}

// ConvertToNum: one to four digits and nothing else, within the bounds, or 0.
function convertToNum(message, minNum, maxNum) {
  if (!/^[0-9]{1,4}$/.test(message)) return 0;
  const value = Number(message);
  return value >= minNum && value <= maxNum ? value : 0;
}

module.exports = {
  meta: {
    name: 'Keep Away',
    version: '1.0',
    author: 'Tim Riker, after upstream',
    description: 'keep the named flag long enough and every other tank dies',
    license: 'AGPL-3.0',
  },

  Init(bz) {
    this.bz = bz;
    this.ka = {
      id: -1,
      startTime: 0,
      team: bz.eNoTeam,
      callsign: '',
      flagsList: [],
      TTH: 120,
      adjustedTime: 120,
      timeMult: 0.03,
      timeMultMin: 0.50,
      lastReminder: bz.bz_getCurrentTime(),
      reminderPeriod: 60,
      enabled: true,
      toldFlagFree: false,
      oneTeamWarn: false,
      autoTimeOn: false,
      forcedFlags: false,
      notEnoughTeams: true,
      soundEnabled: true,
      teamPlay: false,
      flagResetEnabled: true,
      TTHminutes: 0,
      TTHseconds: 30,
      flagToKeepIndex: 0,
      // Until the first player joins and the first flag is picked.
      flagToKeep: 'Initiate',
    };
    bz.bz_registerCustomMapObject('keepaway', (name, data) => this.mapObject(name, data));
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
    const { ka } = this;
    if (name !== 'KEEPAWAY' || !data) return false;
    for (const line of data.data) {
      const nubs = line.split(/\s+/).filter(Boolean);
      if (nubs.length === 0) continue;
      const key = nubs[0].toUpperCase();
      if (key === 'TEAMPLAY') {
        ka.teamPlay = true;
      } else if (key === 'AUTOTIME') {
        ka.autoTimeOn = true;
      } else if (key === 'NOSOUND') {
        ka.soundEnabled = false;
      } else if (key === 'NOFLAGRESET') {
        ka.flagResetEnabled = false;
      } else if (key === 'HOLDTIME' && nubs.length > 1) {
        const temp = Number.parseFloat(nubs[1]) || 0;
        if (temp >= 1 && temp <= 7200) ka.TTH = temp;
      } else if (key === 'KEEPAWAYFLAGS' && nubs.length > 1) {
        for (const flag of nubs.slice(1)) if (convertFlag(flag)) ka.flagsList.push(flag);
      } else if (key === 'FORCEDFLAGS') {
        ka.forcedFlags = true;
      }
    }
    if (ka.flagsList.length > 0) {
      // getFlag moves on one before it looks.
      ka.flagToKeepIndex = -1;
    } else {
      ka.flagToKeep = '';
      ka.flagToKeepIndex = 0;
    }
    return true;
  },

  teamColor(team) {
    const { bz } = this;
    return {
      [bz.eRedTeam]: 'RED', [bz.eGreenTeam]: 'GREEN', [bz.eBlueTeam]: 'BLUE',
      [bz.ePurpleTeam]: 'PURPLE', [bz.eRogueTeam]: 'ROGUE',
    }[team] ?? '';
  },

  say(to, message, params) {
    this.bz.bz_sendTextMessage(this.bz.BZ_SERVER, to, message, params);
  },

  sound(playerID, name) {
    if (this.ka.soundEnabled) this.bz.bz_sendPlayCustomLocalSound(playerID, name);
  },

  players() {
    const { bz } = this;
    return bz.bz_getPlayerIndexList().map((id) => bz.bz_getPlayerByIndex(id)).filter(Boolean);
  },

  // Whether fewer than two teams play, counting `leaving` out: two tanks of
  // different colours, or any two with a rogue among them, make a game.
  oneTeam(leaving) {
    const { ka, bz } = this;
    const count = (team) => bz.bz_getTeamCount(team) - (leaving === team ? 1 : 0);
    const RT = count(bz.eRedTeam);
    const GT = count(bz.eGreenTeam);
    const BT = count(bz.eBlueTeam);
    const PT = count(bz.ePurpleTeam);
    const RGT = count(bz.eRogueTeam);
    const test1 = (RT * GT) + (RT * BT) + (RT * PT) + (GT * BT) + (GT * PT) + (BT * PT);
    const test2 = RT + GT + BT + PT + RGT;
    if (test1 < 1 && test2 < 2) {
      if (!ka.oneTeamWarn) this.say(bz.BZ_ALLUSERS, 'Keep Away disabled: less than 2 teams.');
      ka.oneTeamWarn = true;
      return true;
    }
    if (ka.oneTeamWarn) this.say(bz.BZ_ALLUSERS, 'Keep Away enabled: more than 1 team.');
    ka.oneTeamWarn = false;
    return false;
  },

  autoTime() {
    const { ka, bz } = this;
    const numPlayers = [bz.eRedTeam, bz.eGreenTeam, bz.eBlueTeam, bz.ePurpleTeam, bz.eRogueTeam]
      .reduce((sum, team) => sum + bz.bz_getTeamCount(team), 0);
    if (!ka.autoTimeOn || numPlayers < 3) {
      ka.adjustedTime = ka.TTH;
      return;
    }
    const timeDown = Math.max(1 - (numPlayers - 2) * ka.timeMult, ka.timeMultMin);
    ka.adjustedTime = Math.trunc(ka.TTH * timeDown);
  },

  // Everyone off `safeTeam` dies, killed by the server.
  killTeams(safeTeam, callsign) {
    const { ka, bz } = this;
    for (const player of this.players()) {
      if (player.team !== safeTeam) {
        bz.bz_killPlayer(player.playerID, true, bz.BZ_SERVER);
        this.sound(player.playerID, 'flag_lost');
      } else {
        this.sound(player.playerID, 'flag_won');
      }
    }
    this.say(bz.BZ_ALLUSERS, '{team} ({player}) Kept the Flag Away!', { team: this.teamColor(safeTeam), player: callsign });
    if (ka.flagResetEnabled) bz.bz_resetFlags(true);
  },

  // Everyone but the keeper dies, killed by the keeper.
  killPlayers(safeID, callsign) {
    const { ka, bz } = this;
    for (const player of this.players()) {
      if (player.playerID !== safeID) {
        bz.bz_killPlayer(player.playerID, true, ka.id);
        this.sound(player.playerID, 'flag_lost');
      } else {
        this.sound(player.playerID, 'flag_won');
      }
    }
    this.say(bz.BZ_ALLUSERS, '{player} Kept the Flag Away!', { player: callsign });
    if (ka.flagResetEnabled) bz.bz_resetFlags(true);
  },

  secsLeft(seconds) {
    const { ka, bz } = this;
    if (!ka.teamPlay || ka.team === bz.eRogueTeam) {
      this.say(bz.BZ_ALLUSERS, '{player} has {flag} flag; {seconds} secs left!',
        { player: ka.callsign, flag: ka.flagToKeep, seconds });
    } else {
      this.say(bz.BZ_ALLUSERS, '{team} ({player}) has {flag} flag; {seconds} secs left!',
        { team: this.teamColor(ka.team), player: ka.callsign, flag: ka.flagToKeep, seconds });
    }
  },

  // A warning each minute, then every ten seconds from thirty.
  sendWarnings() {
    const { ka, bz } = this;
    const timeRemaining = ka.adjustedTime - (bz.bz_getCurrentTime() - ka.startTime);
    const toTens = Math.trunc((timeRemaining + 5) / 10) * 10;
    if (timeRemaining / 60 < ka.TTHminutes && ka.adjustedTime > 59 && timeRemaining >= 1) {
      this.secsLeft(toTens);
      ka.TTHminutes -= 1;
    }
    if (ka.adjustedTime < ka.TTHseconds) {
      ka.TTHseconds -= 10;
      return;
    }
    if (timeRemaining < ka.TTHseconds && timeRemaining >= 1) {
      this.secsLeft(ka.TTHseconds);
      ka.TTHseconds -= 10;
    }
  },

  // The next flag in the list nobody holds, or under forcedflags the next
  // one, taken from whoever has it.
  getFlag() {
    const { ka, bz } = this;
    if (ka.flagToKeepIndex < -1) return '';
    for (let h = 0; h < ka.flagsList.length; h += 1) {
      ka.flagToKeepIndex += 1;
      if (ka.flagToKeepIndex > ka.flagsList.length - 1) ka.flagToKeepIndex = 0;
      const candidate = ka.flagsList[ka.flagToKeepIndex];
      let flagNotHeld = true;
      for (const player of this.players()) {
        if (bz.bz_getPlayerFlag(player.playerID) !== candidate) continue;
        if (ka.forcedFlags) {
          bz.bz_removePlayerFlag(player.playerID);
          this.say(player.playerID, 'Sorry, server needs your flag for Keep Away :/');
        } else {
          flagNotHeld = false;
        }
      }
      if (flagNotHeld) return candidate;
    }
    return ka.flagsList[0] ?? '';
  },

  initiateKeepAway(team, callsign, playerID) {
    const { ka, bz } = this;
    ka.team = team;
    ka.callsign = callsign.length > 16 ? `${callsign.slice(0, 16)}~` : callsign;
    ka.id = playerID;
    ka.startTime = bz.bz_getCurrentTime();
    ka.TTHminutes = Math.trunc(ka.adjustedTime / 60 + 0.5);
    ka.TTHseconds = 30;
    ka.toldFlagFree = false;
    // A hold time a multiple of 30 is announced by the warnings instead.
    if (Math.trunc(ka.adjustedTime / 30 + 0.5) !== ka.adjustedTime / 30) this.secsLeft(Math.trunc(ka.adjustedTime));
    if (ka.soundEnabled) {
      for (const player of this.players()) {
        const foe = (player.team !== ka.team || player.team === bz.eRogueTeam) && player.playerID !== ka.id;
        this.sound(player.playerID, foe ? 'flag_alert' : 'teamgrab');
      }
    }
  },

  timeForReminder() {
    const { ka, bz } = this;
    if (bz.bz_getCurrentTime() - ka.lastReminder < ka.reminderPeriod) return false;
    ka.lastReminder = bz.bz_getCurrentTime();
    return true;
  },

  free() {
    const { ka, bz } = this;
    ka.id = -1;
    ka.team = bz.eNoTeam;
    ka.toldFlagFree = false;
  },

  // Who holds the flag now: a new holder starts the clock again.
  checkKeepAwayHolder() {
    const { ka, bz } = this;
    for (const player of this.players()) {
      if (bz.bz_getPlayerFlag(player.playerID) !== ka.flagToKeep) continue;
      if (ka.id !== player.playerID) this.initiateKeepAway(player.team, player.callsign, player.playerID);
      return;
    }
    ka.id = -1;
    ka.team = bz.eNoTeam;
  },

  Event(data) {
    const { ka, bz } = this;
    const running = ka.enabled && ka.flagToKeep !== '';
    switch (data.eventType) {
      case bz.bz_ePlayerDieEvent:
        if (running && data.playerID === ka.id) this.free();
        return;
      case bz.bz_ePlayerPartEvent:
        if (!running) return;
        this.autoTime();
        if (data.playerID === ka.id) this.free();
        ka.notEnoughTeams = this.oneTeam(data.record.team);
        return;
      case bz.bz_ePlayerJoinEvent:
        if (running) this.playerJoined(data);
        return;
      case bz.bz_ePlayerPausedEvent:
        if (running && bz.bz_getPlayerFlag(data.playerID) === ka.flagToKeep) {
          bz.bz_removePlayerFlag(data.playerID);
          this.say(data.playerID, 'Flag removed - cannot pause while holding flag.');
          this.free();
        }
        return;
      case bz.bz_ePlayerUpdateEvent:
        if (running && !ka.notEnoughTeams) this.onUpdate();
        return;
      default:
        break;
    }
  },

  playerJoined(data) {
    const { ka, bz } = this;
    if (ka.flagToKeep === 'Initiate') {
      ka.flagToKeep = this.getFlag();
      ka.lastReminder = bz.bz_getCurrentTime();
    }
    this.autoTime();
    ka.notEnoughTeams = this.oneTeam(bz.eNoTeam);
    if (ka.notEnoughTeams || !ka.enabled || ka.flagToKeep === '') return;
    const flag = convertFlag(ka.flagToKeep);
    const { team } = data.record;
    if (ka.id === -1) {
      this.say(data.playerID, 'Keep Away flag is {flag}: find it and keep it for {seconds} seconds!',
        { flag, seconds: Math.trunc(ka.adjustedTime) });
      this.sound(data.playerID, 'hunt_select');
    } else if (team !== ka.team || team === bz.eRogueTeam) {
      this.say(data.playerID, "{player} has Keep Away flag {flag} - kill him/her before time's up!",
        { player: ka.callsign, flag });
      this.sound(data.playerID, 'flag_alert');
    } else {
      this.say(data.playerID, "{player} has Keep Away flag {flag} - protect him/her until time's up!",
        { player: ka.callsign, flag });
      this.sound(data.playerID, 'teamgrab');
    }
  },

  onUpdate() {
    const { ka, bz } = this;
    this.checkKeepAwayHolder();
    if (!ka.toldFlagFree && ka.id === -1) {
      this.say(bz.BZ_ALLUSERS, 'Keep Away flag: {flag} is free; find it and keep it!', { flag: convertFlag(ka.flagToKeep) });
      ka.toldFlagFree = true;
      // Not over a win's or a loss's own sounds.
      if (bz.bz_getCurrentTime() - ka.lastReminder > 2 && ka.soundEnabled) {
        for (const player of this.players()) bz.bz_sendPlayCustomLocalSound(player.playerID, 'hunt_select');
      }
    }
    if (this.timeForReminder() && ka.id === -1) {
      this.say(bz.BZ_ALLUSERS, 'Keep Away flag: {flag} is free; find it and keep it!', { flag: convertFlag(ka.flagToKeep) });
    }
    if (ka.id === -1) return;
    this.sendWarnings();
    if (bz.bz_getCurrentTime() - ka.startTime < ka.adjustedTime) return;
    if (ka.teamPlay && ka.team !== bz.eRogueTeam) {
      this.killTeams(ka.team, ka.callsign);
      bz.bz_sendTextMessageToTeam(bz.BZ_SERVER, ka.team, 'Your team did it!  Go find the next Keep Away flag and keep it!');
    } else {
      this.killPlayers(ka.id, ka.callsign);
      this.say(ka.id, 'You did it!  Go find the next Keep Away flag and keep it!');
    }
    this.nextFlag();
  },

  // Gives up the flag kept, unless forcedflags will take it anyway, and names
  // the next.
  nextFlag() {
    const { ka, bz } = this;
    if (!ka.forcedFlags) bz.bz_removePlayerFlag(ka.id);
    ka.id = -1;
    ka.team = bz.eNoTeam;
    ka.toldFlagFree = false;
    ka.flagToKeep = this.getFlag();
    ka.lastReminder = bz.bz_getCurrentTime();
  },

  slashCommand(playerID, command, message) {
    const { ka, bz } = this;
    if (command === 'kas') {
      if (ka.id !== -1) bz.bz_sendTextMessage(playerID, ka.id, message);
      else this.say(playerID, 'There is no one keeping the flag right now.');
      return true;
    }
    if (command === 'kaf') {
      if (ka.id === -1) this.say(playerID, 'The Keep Away flag is: {flag}', { flag: convertFlag(ka.flagToKeep) });
      else this.say(playerID, '{player} has Keep Away flag: {flag}', { player: ka.callsign, flag: convertFlag(ka.flagToKeep) });
      return true;
    }
    const fromPlayer = bz.bz_getPlayerByIndex(playerID);
    if (fromPlayer && !fromPlayer.admin) {
      this.say(playerID, 'You must be admin to use the keepaway commands.');
      return true;
    }
    const all = bz.BZ_ALLUSERS;
    const percent = (value) => ({ percent: Math.trunc(value * 100 + 0.5) });
    switch (command) {
      case 'kasoundoff':
        ka.soundEnabled = false;
        this.say(playerID, 'Keep Away sounds are disabled.');
        return true;
      case 'kasoundon':
        ka.soundEnabled = true;
        this.say(playerID, 'Keep Away sounds are enabled.');
        return true;
      case 'kaflagresetoff':
        ka.flagResetEnabled = false;
        this.say(playerID, 'Keep Away flag reset is disabled.');
        return true;
      case 'kaflagreseton':
        ka.flagResetEnabled = true;
        this.say(playerID, 'Keep Away flag reset is enabled.');
        return true;
      case 'kaf+':
        this.nextFlag();
        this.say(playerID, 'Keep Away flag advanced to: {flag}', { flag: convertFlag(ka.flagToKeep) });
        return true;
      case 'kaon':
        ka.enabled = true;
        this.say(all, 'Keep Away is enabled.');
        return true;
      case 'kaoff':
        ka.enabled = false;
        this.say(all, 'Keep Away is disabled.');
        return true;
      case 'katimemult': {
        const value = convertToNum(message, 1, 99);
        if (value > 0) {
          ka.timeMult = value / 100;
          this.say(playerID, 'Keep Away auto time multiplier set to {percent} percent.', percent(ka.timeMult));
        } else {
          this.say(playerID, 'Keep Away auto time multiplier must be between 1 and 99 percent.');
        }
        this.autoTime();
        return true;
      }
      case 'katimemultmin': {
        const value = convertToNum(message, 1, 99);
        if (value > 0) {
          ka.timeMultMin = value / 100;
          this.say(playerID, 'Keep Away auto time multiplier minimum set to {percent} percent.', percent(ka.timeMultMin));
        } else {
          this.say(playerID, 'Keep Away auto time multiplier minimum must be between 1 and 99 percent.');
        }
        this.autoTime();
        return true;
      }
      case 'kastatus':
        this.say(playerID, ka.enabled ? 'Keep Away is currently enabled.' : 'Keep Away is currently disabled.');
        this.say(playerID, ka.autoTimeOn ? 'Keep Away automatic time adjustment is currently enabled.'
          : 'Keep Away automatic time adjustment is currently disabled.');
        this.say(playerID, 'Keep Away time multiplier = {percent} percent.', percent(ka.timeMult));
        this.say(playerID, 'Keep Away time multiplier minimum = {percent} percent.', percent(ka.timeMultMin));
        this.say(playerID, 'Keep Away hold time is currently set to: {seconds} seconds',
          { seconds: Math.trunc(ka.adjustedTime + 0.5) });
        this.say(playerID, ka.forcedFlags ? 'Keep Away forced flags is enabled.' : 'Keep Away forced flags is disabled.');
        this.say(playerID, ka.soundEnabled ? 'Keep Away sounds are enabled.' : 'Keep Away sounds are disabled.');
        this.say(playerID, ka.flagResetEnabled ? 'Keep Away flag reset is enabled.' : 'Keep Away flag reset is disabled.');
        return true;
      case 'katime': {
        const value = convertToNum(message, 1, 7200);
        if (value > 0) {
          ka.TTH = value;
          this.autoTime();
          this.say(all, 'Keep Away hold time has been set to {seconds} seconds.', { seconds: Math.trunc(value + 0.5) });
        } else {
          this.say(playerID, 'Keep Away hold time invalid: must be between 1 and 7200 seconds.');
        }
        this.autoTime();
        return true;
      }
      case 'kaautotimeon':
        ka.autoTimeOn = true;
        this.autoTime();
        this.say(all, 'Keep Away automatic time adjustment on.');
        return true;
      case 'kaautotimeoff':
        ka.autoTimeOn = false;
        ka.adjustedTime = ka.TTH;
        this.autoTime();
        this.say(all, 'Keep Away automatic time adjustment off.');
        return true;
      case 'kaffon':
        ka.forcedFlags = true;
        this.say(all, 'Forced flags on.');
        return true;
      case 'kaffoff':
        ka.forcedFlags = false;
        this.say(all, 'Forced flags off.');
        return true;
      default:
        return false;
    }
  },

  // Translations of what the plugin says, `{ locale: { msgid: msgstr } }`.
  // None yet.
  l10n: {},
};
