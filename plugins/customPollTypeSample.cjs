/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// customPollTypeSample.cjs - upstream's plugins/customPollTypeSample: a poll
// type of the plugin's own, `/poll mute <callsign>`, which takes the player's
// TALK permission when it passes. Starting one takes the custom POLLMUTE
// permission, which nobody has until a plugin grants it.

'use strict';

module.exports = {
  meta: {
    name: 'Custom Poll Type',
    version: '1.0',
    author: 'Tim Riker, after upstream',
    description: 'a sample poll type, /poll mute <callsign>',
    license: 'AGPL-3.0',
    enabled: false,
  },

  Init(bz) {
    this.bz = bz;
    bz.bz_registerCustomPollType('mute', 'callsign', this);
  },

  // Asked before a `/poll mute` starts; false stops it, and the player
  // should be told why.
  PollOpen(player, action) {
    const { bz } = this;
    if (!bz.bz_hasPerm(player.playerID, 'pollMute')) {
      bz.bz_sendTextMessage(bz.BZ_SERVER, player.playerID, "You can't start a poll!");
      return false;
    }
    return action === 'mute';
  },

  PollClose(action, parameters, success) {
    const { bz } = this;
    if (action !== 'mute' || !success) return;
    const record = bz.bz_getPlayerBySlotOrCallsign(parameters);
    if (!record) {
      bz.bz_sendTextMessage(bz.BZ_SERVER, bz.BZ_ALLUSERS, 'player {player} not found', { player: parameters });
      return;
    }
    bz.bz_revokePerm(record.playerID, 'talk');
  },

  l10n: {},
};
