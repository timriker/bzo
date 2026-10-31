/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// autoFlagReset.cjs - upstream's plugins/autoFlagReset: every `minutes`, each
// superflag nobody holds goes back to a fresh spawn, so flags a map's corners
// collect come back into play. `incremental` spreads that out, one flag at a
// time across the period. Team flags are never touched. Options in
// server.json: `{ "minutes": 15, "incremental": false }`, upstream's
// `-loadplugin autoFlagReset,15i`.

'use strict';

const TEAM_FLAGS = new Set(['R*', 'G*', 'B*', 'P*', '']);

module.exports = {
  meta: {
    name: 'Automatic Flag Reset',
    version: '1.0',
    author: 'Tim Riker, after upstream',
    description: 'superflags nobody holds go back to a fresh spawn every so often',
    license: 'AGPL-3.0',
    enabled: false,
  },

  Init(bz, config) {
    this.bz = bz;
    this.freq = Number(config.minutes) > 0 ? Number(config.minutes) * 60 : 900;
    this.incremental = config.incremental === true;
    this.nextRunTime = bz.bz_getCurrentTime();
    this.nextFlag = 0;
    bz.Register(bz.bz_eTickEvent);
  },

  Event(data) {
    const { bz } = this;
    const count = bz.bz_getNumFlags();
    if (data.eventType !== bz.bz_eTickEvent || count === 0 || bz.bz_getCurrentTime() < this.nextRunTime) return;
    if (this.incremental) {
      // One flag, trying each at most once, so a world whose flags are all
      // held does not spin.
      for (let tried = 0; tried < count; tried += 1) {
        const worked = this.resetUnused(this.nextFlag);
        this.nextFlag = (this.nextFlag + 1) % count;
        if (worked) break;
      }
      this.nextRunTime += this.freq / count;
    } else {
      for (let index = 0; index < count; index += 1) this.resetUnused(index);
      this.nextRunTime += this.freq;
    }
  },

  resetUnused(index) {
    const { bz } = this;
    if (index >= bz.bz_getNumFlags() || bz.bz_flagPlayer(index) !== -1) return false;
    if (TEAM_FLAGS.has(bz.bz_getFlagName(index))) return false;
    return bz.bz_resetFlag(index);
  },
};
