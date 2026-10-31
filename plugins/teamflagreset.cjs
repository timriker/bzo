/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// teamflagreset.cjs - upstream's plugins/teamflagreset: a team flag that has
// been held and then left lying for `minutes` goes home, while at least two
// teams have players. Admins tune it with `/tfrtime <minutes>`, `/tfroff`,
// `/tfron` and `/tfrstatus`. Options in server.json: `{ "minutes": 5 }`,
// 1 to 120, upstream's `-loadplugin teamflagreset,5`.

'use strict';

const TEAMS = Object.freeze([
  { flag: 'R*', team: 1, name: 'Red' },
  { flag: 'G*', team: 2, name: 'Green' },
  { flag: 'B*', team: 3, name: 'Blue' },
  { flag: 'P*', team: 4, name: 'Purple' },
]);

// ConvertToInteger: a whole number of minutes, 1 to 120, or 0.
function minutesFrom(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,3}$/.test(text)) return 0;
  const minutes = Number(text);
  return minutes >= 1 && minutes <= 120 ? minutes : 0;
}

module.exports = {
  meta: {
    name: 'Team Flag Reset',
    version: '1.0',
    author: 'Tim Riker, after upstream',
    description: 'a team flag left lying too long goes home',
    license: 'AGPL-3.0',
    enabled: false,
  },

  Init(bz, config) {
    this.bz = bz;
    this.idleTime = (minutesFrom(config.minutes) || 5) * 60;
    this.timerOff = false;
    this.resetData();
    bz.Register(bz.bz_eTickEvent);
    const command = (playerID, channel, name, message) => this.command(playerID, name.toLowerCase(), message);
    bz.bz_registerCustomSlashCommand('tfrtime', command,
      { help: '<minutes> - how long a team flag may lie before it goes home', operator: true });
    bz.bz_registerCustomSlashCommand('tfroff', command, { help: '- stop resetting team flags', operator: true });
    bz.bz_registerCustomSlashCommand('tfron', command, { help: '- reset idle team flags again', operator: true });
    bz.bz_registerCustomSlashCommand('tfrstatus', command, { help: '- show team flag reset', operator: true });
  },

  resetData() {
    const now = this.bz.bz_getCurrentTime();
    this.lastTouched = new Map(TEAMS.map(({ team }) => [team, now]));
    this.wasHeld = new Map(TEAMS.map(({ team }) => [team, false]));
  },

  Event(data) {
    const { bz } = this;
    if (data.eventType !== bz.bz_eTickEvent || this.timerOff) return;
    const now = bz.bz_getCurrentTime();
    for (const id of bz.bz_getPlayerIndexList()) {
      const held = TEAMS.find(({ flag }) => flag === bz.bz_getPlayerFlag(id));
      if (held) {
        this.lastTouched.set(held.team, now);
        this.wasHeld.set(held.team, true);
      }
    }
    // No team play, nothing to reset: two teams with players between them.
    const teamsPlaying = TEAMS.filter(({ team }) => bz.bz_getTeamCount(team) > 0).length;
    if (teamsPlaying < 2) {
      this.resetData();
      return;
    }
    for (const { flag, team, name } of TEAMS) {
      if (now - this.lastTouched.get(team) <= this.idleTime || !this.wasHeld.get(team)) continue;
      if (bz.bz_getTeamCount(team) > 0) {
        for (let index = 0; index < bz.bz_getNumFlags(); index += 1) {
          if (bz.bz_getFlagName(index) === flag) bz.bz_resetFlag(index);
        }
        bz.bz_sendTextMessage(bz.BZ_SERVER, bz.BZ_ALLUSERS, '{team} flag sat idle too long - reset by server.',
          { team: { msgid: name } });
      }
      this.wasHeld.set(team, false);
      this.lastTouched.set(team, now);
    }
  },

  command(playerID, name, message) {
    const { bz } = this;
    const minutes = () => Math.trunc(this.idleTime / 60 + 0.5);
    if (name === 'tfrtime') {
      const value = minutesFrom(message);
      if (!value) {
        bz.bz_sendTextMessage(bz.BZ_SERVER, playerID,
          'Team flag idle time invalid: must be between 1 and 120 minutes.', {});
        return true;
      }
      this.timerOff = false;
      this.idleTime = value * 60;
      bz.bz_sendTextMessage(bz.BZ_SERVER, bz.BZ_ALLUSERS, 'Team flag idle time has been set to {minutes} minutes.',
        { minutes: minutes() });
      this.resetData();
      return true;
    }
    if (name === 'tfroff') {
      this.timerOff = true;
      bz.bz_sendTextMessage(bz.BZ_SERVER, bz.BZ_ALLUSERS, 'Team flag reset is disabled.', {});
      return true;
    }
    if (name === 'tfron') {
      this.timerOff = false;
      this.resetData();
      bz.bz_sendTextMessage(bz.BZ_SERVER, bz.BZ_ALLUSERS, 'Team flag reset is enabled.', {});
      return true;
    }
    if (name === 'tfrstatus') {
      bz.bz_sendTextMessage(bz.BZ_SERVER, playerID,
        this.timerOff ? 'Team flag reset is disabled.' : 'Team flag reset is enabled.', {});
      bz.bz_sendTextMessage(bz.BZ_SERVER, playerID, 'Team flag idle time is: {minutes} minutes.',
        { minutes: minutes() });
      return true;
    }
    return false;
  },

  // Translations of what the plugin says, `{ locale: { msgid: msgstr } }`,
  // merged into what a bzo client is sent while the plugin runs
  // (docs/plugins-plan.md, "Translations"). None yet.
  l10n: {},
};
