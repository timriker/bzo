/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// holdtheflag.cjs - upstream's plugins/HoldTheFlag: one team plays, each
// capture scores the capper a point and resets every flag, and a match's
// winner is whoever has the most.
//
// Its option is the team, `{ "team": "red" }`; anybody else but an observer is
// kicked as they join. Upstream reads `team=<color>` from its command line,
// but compares the whole line to "team=", so any line gives green; here the
// team named is the team played, and green is still the default when the
// option names none. With no options at all nobody joins the list, as
// upstream's.
//
// `/htf` shows the scores; `/htf stats` the version and team; `/htf reset`
// clears the scores, with the COUNTDOWN permission; `/htf on` and `/htf off`
// switch it, with HTFONOFF.

'use strict';

const VERSION = '1.00.02';
const DO_FLAG_RESET = true;

module.exports = {
  meta: {
    name: 'Hold the Flag',
    version: VERSION,
    author: 'Tim Riker, after upstream',
    description: 'one team plays; each capture scores the capper and resets the flags',
    license: 'AGPL-3.0',
    options: [
      { name: 'team', type: 'choice', values: ['green', 'red', 'blue', 'purple', 'rogue'], default: 'green',
        help: 'The one team that plays' },
    ],
  },

  Init(bz, config = {}) {
    this.bz = bz;
    this.players = new Map(); // id -> { score, callsign, capNum }
    this.matchActive = false;
    this.htfEnabled = true;
    this.nextCapNum = 0;
    this.leader = -1;
    this.htfTeam = bz.eNoTeam;
    if (Object.keys(config).length > 0) {
      this.htfTeam = config.team === undefined ? bz.eGreenTeam : this.colorNameToDef(String(config.team));
      if (this.htfTeam === bz.eNoTeam) {
        bz.bz_debugMessage(0, '+++ HoldTheFlag plugin command-line error');
        bz.bz_debugMessage(0, 'Command line args:  PLUGINNAME,team=color');
        return;
      }
    }
    for (const id of bz.bz_getPlayerIndexList()) {
      const record = bz.bz_getPlayerByIndex(id);
      if (record) this.listAdd(id, record.callsign);
    }
    bz.bz_registerCustomSlashCommand('htf', (playerID, _channel, _command, _message, params) => this.slashCommand(playerID, params),
      { help: '[reset|off|on|stats] - Hold the Flag scores, or one of its commands' });
    bz.Register(bz.bz_ePlayerJoinEvent);
    bz.Register(bz.bz_ePlayerPartEvent);
    bz.Register(bz.bz_eCaptureEvent);
    bz.Register(bz.bz_eGameStartEvent);
    bz.Register(bz.bz_eGameEndEvent);
  },

  colorNameToDef(color) {
    const { bz } = this;
    return {
      green: bz.eGreenTeam, red: bz.eRedTeam, purple: bz.ePurpleTeam, blue: bz.eBlueTeam,
      rogue: bz.eRogueTeam, observer: bz.eObservers,
    }[color.toLowerCase()] ?? bz.eNoTeam;
  },

  colorDefToName(team) {
    const { bz } = this;
    return {
      [bz.eGreenTeam]: 'Green', [bz.eBlueTeam]: 'Blue', [bz.eRedTeam]: 'Red', [bz.ePurpleTeam]: 'Purple',
      [bz.eObservers]: 'Observer', [bz.eRogueTeam]: 'Rogue', [bz.eRabbitTeam]: 'Rabbit',
      [bz.eHunterTeam]: 'Hunters', [bz.eAdministrators]: 'Administrators',
    }[team] ?? 'No Team';
  },

  say(to, message, params) {
    this.bz.bz_sendTextMessage(this.bz.BZ_SERVER, to, message, params);
  },

  // A callsign is kept to 20 characters, as upstream's strncpy keeps it.
  listAdd(playerID, callsign) {
    this.players.set(playerID, { score: 0, capNum: -1, callsign: String(callsign).slice(0, 20) });
  },

  listDel(playerID) {
    return this.players.delete(playerID);
  },

  dispScores(who) {
    if (!this.htfEnabled) return;
    this.say(who, '**** HTF  Scoreboard ****');
    this.leader = -1;
    if (this.players.size < 1) return;
    let playerLastCapped = -1;
    let lastCapNum = -1;
    for (const [id, player] of this.players) {
      if (player.capNum > lastCapNum) {
        playerLastCapped = id;
        lastCapNum = player.capNum;
      }
    }
    // Most points first, and the latest capture first between equals.
    const sorted = [...this.players].sort(([, a], [, b]) => (b.score - a.score) || (b.capNum - a.capNum));
    for (const [id, player] of sorted) {
      this.say(who, '{player} :{score} {mark}', {
        player: player.callsign.padStart(20),
        score: String(player.score).padStart(3),
        mark: id === playerLastCapped ? '*' : ' ',
      });
    }
    [[this.leader]] = sorted;
  },

  resetScores() {
    for (const player of this.players.values()) {
      player.score = 0;
      player.capNum = -1;
    }
    this.nextCapNum = 0;
  },

  htfCapture(who) {
    const { bz } = this;
    if (!this.htfEnabled) return;
    if (DO_FLAG_RESET) bz.bz_resetFlags(false);
    const player = this.players.get(who);
    this.say(bz.BZ_ALLUSERS, 'HTF FLAG CAPTURED by {player}', { player: player?.callsign ?? '' });
    if (player) {
      player.score += 1;
      player.capNum = this.nextCapNum++;
    }
    this.dispScores(bz.BZ_ALLUSERS);
  },

  htfStartGame() {
    if (!this.htfEnabled) return;
    this.resetScores();
    this.matchActive = true;
    this.say(this.bz.BZ_ALLUSERS, 'HTF MATCH has begun, good luck!');
  },

  htfEndGame() {
    const { bz } = this;
    if (this.htfEnabled && this.matchActive) {
      this.dispScores(bz.BZ_ALLUSERS);
      this.say(bz.BZ_ALLUSERS, 'HTF MATCH has ended.');
      if (this.leader >= 0) {
        this.say(bz.BZ_ALLUSERS, '{player} is the WINNER !', { player: this.players.get(this.leader)?.callsign ?? '' });
      }
    }
    this.matchActive = false;
  },

  Event(data) {
    const { bz } = this;
    switch (data.eventType) {
      case bz.bz_ePlayerJoinEvent: {
        const { team, callsign } = data.record;
        if (this.htfTeam !== bz.eNoTeam && team !== this.htfTeam && team !== bz.eObservers) {
          bz.bz_kickUser(data.playerID,
            `HTF mode enabled, you must join the ${this.colorDefToName(this.htfTeam)} team to play`, true);
          return;
        }
        if (team === this.htfTeam) this.listAdd(data.playerID, callsign);
        break;
      }
      case bz.bz_ePlayerPartEvent:
        if (data.record.team === this.htfTeam) this.listDel(data.playerID);
        break;
      case bz.bz_eCaptureEvent:
        this.htfCapture(data.playerCapping);
        break;
      case bz.bz_eGameStartEvent:
        this.htfStartGame();
        break;
      case bz.bz_eGameEndEvent:
        this.htfEndGame();
        break;
      default:
        break;
    }
  },

  checkPerms(playerID, htfCmd, permName) {
    if (this.bz.bz_hasPerm(playerID, permName)) return true;
    this.say(this.bz.BZ_ALLUSERS, 'you need "{permission}" permission to do /htf {command}',
      { permission: permName, command: htfCmd });
    return false;
  },

  // Upstream compares the first four letters of the subcommand.
  slashCommand(playerID, params) {
    const { bz } = this;
    if (!params[0]) {
      this.dispScores(playerID);
      return true;
    }
    const subCmd = params[0].slice(0, 4).toLowerCase();
    const callsign = () => this.players.get(playerID)?.callsign ?? '';
    if (subCmd === 'rese') {
      if (this.checkPerms(playerID, 'reset', 'COUNTDOWN')) {
        this.resetScores();
        this.say(bz.BZ_ALLUSERS, '*** HTF scores reset by {player}', { player: callsign() });
      }
    } else if (subCmd === 'off' || subCmd === 'on') {
      if (this.checkPerms(playerID, 'off', 'HTFONOFF')) {
        const onoff = subCmd === 'on';
        if (onoff === this.htfEnabled) {
          this.say(playerID, 'HTF mode is already that way.');
        } else {
          this.htfEnabled = onoff;
          this.say(bz.BZ_ALLUSERS, onoff ? '*** HTF mode ENabled by {player}' : '*** HTF mode DISabled by {player}',
            { player: callsign() });
        }
      }
    } else if (subCmd === 'stat') {
      this.say(playerID, 'HTF plugin version {version}', { version: VERSION });
      this.say(playerID, '  Team: {team}', { team: this.colorDefToName(this.htfTeam) });
      this.say(playerID, DO_FLAG_RESET ? '  Flag Reset: ENabled' : '  Flag Reset: DISabled');
    } else {
      this.say(playerID, 'HTF commands: reset, off, on, stats');
    }
    return true;
  },

  // Translations of what the plugin says, `{ locale: { msgid: msgstr } }`.
  // None yet.
  l10n: {},
};
