/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// killall.cjs - upstream's plugins/killall: `/killall` kills every player, and
// says who did it. Admins only, which bzo checks before the command runs where
// upstream's plugin checks it itself.

'use strict';

module.exports = {
  meta: {
    name: 'Kill All',
    version: '1.0',
    author: 'Tim Riker, after upstream',
    description: '/killall kills every player',
    license: 'AGPL-3.0',
    enabled: false,
  },

  Init(bz) {
    bz.bz_registerCustomSlashCommand('killall', (playerID) => {
      bz.bz_sendTextMessage(bz.BZ_SERVER, bz.BZ_ALLUSERS, '{player} has killed everyone',
        { player: bz.bz_getPlayerCallsign(playerID) ?? '' });
      for (const id of bz.bz_getPlayerIndexList()) bz.bz_killPlayer(id, false);
      return true;
    }, { help: '- kill every player', operator: true });
  },

  // Translations of what the plugin says, `{ locale: { msgid: msgstr } }`,
  // merged into what a bzo client is sent while the plugin runs
  // (docs/plugins-plan.md, "Translations"). None yet.
  l10n: {},
};
