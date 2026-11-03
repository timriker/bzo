/*
 * Ported from https://github.com/allejo/mapchange by Tim Riker
 * <timriker@gmail.com>, 2026. Licensed under the GNU Lesser General Public
 * License v3.0, as the plugin it ports.
 * Source: https://github.com/timriker/bzo
 */

// mapchange.cjs - allejo's mapchange (Gnurdux's, updated by allejo and
// Constitution): `/mapchange <name>` starts a new game on another map,
// `/maprandom` on one picked at random, and `/maplist` names them. Changing
// needs the MAPCHANGE permission, which an admin holds, and is refused while
// a match runs -- with a kick, as upstream's.
//
// Its option is the list, in place of upstream's map list file: a name and a
// map file each, as that file's lines are, separated by commas --
// `{ "maps": "HiX hix.bzw, bzo bzo.bzw" }` -- or by name,
// `{ "maps": { "HiX": "hix.bzw", "bzo": "bzo.bzw" } }`. Upstream writes
// the next configuration to a file and shuts bzfs down for a wrapper script
// to start again; bzo switches the map itself (`bz_changeMap`).

'use strict';

module.exports = {
  meta: {
    name: 'Map Change',
    version: '1.0',
    author: 'Tim Riker, after Gnurdux, allejo and Constitution',
    description: '/mapchange starts a new game on another map from a list',
    license: 'LGPL-3.0',
    options: [
      { name: 'maps', type: 'string', maxLength: 1000, default: '',
        help: 'Maps by name and file: HiX hix.bzw, bzo bzo.bzw' },
    ],
  },

  Init(bz, config = {}) {
    this.bz = bz;
    const pairs = typeof config.maps === 'string'
      ? config.maps.split(',').map((entry) => entry.trim().split(/\s+/)).filter((entry) => entry.length === 2)
      : Object.entries(config.maps && typeof config.maps === 'object' ? config.maps : {});
    this.maps = pairs.filter(([name, file]) => name && typeof file === 'string' && file);
    this.matchInProgress = false;
    bz.Register(bz.bz_eGameEndEvent);
    bz.Register(bz.bz_eGameStartEvent);
    bz.bz_registerCustomSlashCommand('mapchange', (playerID, _c, _n, _m, params) => this.change(playerID, params),
      { help: '<name> - start a new game on that map' });
    bz.bz_registerCustomSlashCommand('maplist', (playerID) => this.list(playerID),
      { help: '- the maps /mapchange knows' });
    bz.bz_registerCustomSlashCommand('maprandom', (playerID) => this.change(playerID, null),
      { help: '- start a new game on a map picked at random' });
  },

  Event(data) {
    if (data.eventType === this.bz.bz_eGameEndEvent) this.matchInProgress = false;
    else if (data.eventType === this.bz.bz_eGameStartEvent) this.matchInProgress = true;
  },

  say(to, message, params) {
    this.bz.bz_sendTextMessage(this.bz.BZ_SERVER, to, message, params);
  },

  list(playerID) {
    this.say(playerID, 'Available configurations: ');
    for (const [name] of this.maps) this.say(playerID, ' -  {name}', { name });
    return true;
  },

  // `params` null is /maprandom.
  change(playerID, params) {
    const { bz } = this;
    const player = bz.bz_getPlayerByIndex(playerID);
    if (!player) return true;
    if (!bz.bz_hasPerm(playerID, 'MAPCHANGE')) {
      this.say(playerID, 'Sorry, you are not allowed to change configurations on this server');
      return true;
    }
    if (this.matchInProgress) {
      this.say(playerID, 'Sorry, you are not allowed to change configurations when a match is in progress');
      this.say(playerID, 'For this malicious activity, you will be kicked');
      bz.bz_kickUser(playerID, 'mapchange during match', true);
      return true;
    }
    let chosen;
    if (params === null) {
      if (this.maps.length === 0) return true;
      chosen = this.maps[Math.floor(Math.random() * this.maps.length)];
    } else {
      if (params.length !== 1) {
        this.say(playerID, 'Usage: /mapchange <confname>');
        return true;
      }
      chosen = this.maps.find(([name]) => name.toLowerCase() === params[0].toLowerCase());
      if (!chosen) {
        this.say(playerID, 'The configuration you selected does not exist');
        return true;
      }
    }
    // Told once the change is sure, where upstream says it first: a map
    // that is missing or already played starts nothing here.
    const [name, file] = chosen;
    const outcome = bz.bz_changeMap(file, `"${player.callsign}" via /mapchange`);
    if (outcome !== true) {
      this.say(playerID, '{name}: {error}', { name, error: outcome });
      return true;
    }
    this.say(bz.BZ_ALLUSERS, params === null
      ? 'Server restarting with randomly selected configuration ({name}): Requested by {player}'
      : 'Server restarting with configuration {name}: Requested by {player}', { name, player: player.callsign });
    return true;
  },

  // Translations of what the plugin says, `{ locale: { msgid: msgstr } }`.
  // None yet.
  l10n: {},
};
