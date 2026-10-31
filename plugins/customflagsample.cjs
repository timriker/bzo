/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// customflagsample.cjs - upstream's plugins/customflagsample: a flag of the
// plugin's own, `CF` "Custom Flag", and what it does is all here. Its shots
// are ordinary; firing one is announced and worth ten points, and a kill by
// its holder is announced too. A map puts it in the world as any other flag,
// `zoneflag CF 1` in a zone.

'use strict';

module.exports = {
  meta: {
    name: 'Custom Flag Sample',
    version: '1.0',
    author: 'Tim Riker, after upstream',
    description: 'a sample custom flag, CF, worth ten points a shot',
    license: 'AGPL-3.0',
    enabled: false,
  },

  Init(bz) {
    this.bz = bz;
    bz.bz_RegisterCustomFlag('CF', 'Custom Flag',
      'A simple sample custom flag from the customflagsample plugin', 0, bz.eGoodFlag);
    bz.Register(bz.bz_eFlagTransferredEvent);
    bz.Register(bz.bz_eFlagGrabbedEvent);
    bz.Register(bz.bz_eFlagDroppedEvent);
    bz.Register(bz.bz_eShotFiredEvent);
    bz.Register(bz.bz_ePlayerDieEvent);
  },

  Event(data) {
    const { bz } = this;
    const all = (text, params = {}) => bz.bz_sendTextMessage(bz.BZ_SERVER, bz.BZ_ALLUSERS, text, params);
    switch (data.eventType) {
      case bz.bz_eFlagTransferredEvent:
        if (data.flagType === 'CF') all('Custom Flag transferred!');
        break;
      case bz.bz_eFlagGrabbedEvent:
        if (data.flagType === 'CF') all('Custom Flag grabbed!');
        break;
      case bz.bz_eFlagDroppedEvent:
        if (data.flagType === 'CF') all('Custom Flag dropped!');
        break;
      case bz.bz_eShotFiredEvent: {
        const record = bz.bz_getPlayerByIndex(data.playerID);
        if (record?.currentFlag !== 'Custom Flag (+CF)') break;
        all('Shot fired by {player} with Custom Flag!', { player: record.callsign });
        // This user must be cool: ten points.
        bz.bz_incrementPlayerWins(data.playerID, 10);
        break;
      }
      case bz.bz_ePlayerDieEvent:
        if (data.flagKilledWith === 'CF') {
          all('Player {player} killed by a player with Custom Flag!',
            { player: bz.bz_getPlayerCallsign(data.playerID) ?? '' });
        }
        break;
      default:
    }
  },

  // Translations of what the plugin says, `{ locale: { msgid: msgstr } }`,
  // merged into what a bzo client is sent while the plugin runs
  // (docs/plugins-plan.md, "Translations"). None yet.
  l10n: {},
};
