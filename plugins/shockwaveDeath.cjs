/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// shockwaveDeath.cjs - upstream's plugins/shockwaveDeath: every tank that dies
// goes off as a shockwave where it stood, fired by the server, so the blast
// is nobody's kill.

'use strict';

module.exports = {
  meta: {
    name: 'Shockwave Death',
    version: '1.0',
    author: 'Tim Riker, after upstream',
    description: 'a tank that dies goes off as a shockwave',
    license: 'AGPL-3.0',
    enabled: false,
  },

  Init(bz) {
    this.bz = bz;
    bz.Register(bz.bz_ePlayerDieEvent);
  },

  Event(data) {
    if (data.eventType !== this.bz.bz_ePlayerDieEvent) return;
    this.bz.bz_fireServerShot('SW', data.state.pos, [0, 0, 0]);
  },

  // Translations of what the plugin says; it says nothing.
  l10n: {},
};
