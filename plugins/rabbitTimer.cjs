/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// rabbitTimer.cjs - upstream's plugins/rabbitTimer: in rabbit chase, the rabbit
// has `time` seconds to make a kill or the server kills it, once at least
// three hunters are playing. Each kill starts the clock again, or with
// `rollOver` adds `time` to what is left. Options in server.json:
// `{ "time": 30, "rollOver": false }`, upstream's `-loadplugin rabbitTimer,+30`.
//
// The clock starts when a rabbit is picked. Upstream's starts only at a
// rabbit's death or departure, so the first rabbit after a restart waits out
// a placeholder hour, and one picked long after the last death is killed at
// once.

'use strict';

module.exports = {
  meta: {
    name: 'Rabbit Timer',
    version: '1.0',
    author: 'Tim Riker, after upstream',
    description: 'the rabbit must make a kill in time or die',
    license: 'AGPL-3.0',
    enabled: false,
  },

  Init(bz, config) {
    this.bz = bz;
    this.limit = Number(config.time) > 0 ? Math.trunc(Number(config.time)) : 30;
    this.rollOver = config.rollOver === true;
    this.rabbit = -1;
    this.deathTime = Infinity;
    bz.Register(bz.bz_ePlayerDieEvent);
    bz.Register(bz.bz_ePlayerPartEvent);
    bz.Register(bz.bz_eTickEvent);
  },

  Event(data) {
    const { bz } = this;
    if (data.eventType === bz.bz_eTickEvent) {
      if (this.rabbit !== -1 && data.eventTime >= this.deathTime) {
        bz.bz_killPlayer(this.rabbit, false, bz.BZ_SERVER);
        this.rabbit = -1;
        this.deathTime = data.eventTime + this.limit;
        bz.bz_sendTextMessage(bz.BZ_SERVER, bz.BZ_ALLUSERS, "Time's up! Selecting new rabbit.", {});
      } else if (this.rabbit === -1 && bz.bz_getTeamCount(bz.eHunterTeam) >= 3) {
        const rabbit = bz.bz_getPlayerIndexList().find((id) => bz.bz_getPlayerTeam(id) === bz.eRabbitTeam);
        if (rabbit !== undefined) {
          this.rabbit = rabbit;
          this.deathTime = data.eventTime + this.limit;
          bz.bz_sendTextMessage(bz.BZ_SERVER, rabbit, 'You have {seconds} seconds to make a kill!',
            { seconds: this.limit });
        }
      }
    } else if (data.eventType === bz.bz_ePlayerDieEvent) {
      if (data.team === bz.eRabbitTeam) {
        this.rabbit = -1;
        this.deathTime = data.eventTime + this.limit;
      } else if (data.killerTeam === bz.eRabbitTeam && this.rabbit !== -1) {
        if (this.rollOver) {
          this.deathTime += this.limit;
          bz.bz_sendTextMessage(bz.BZ_SERVER, this.rabbit, '+{added} seconds: {seconds} seconds remaining.',
            { added: this.limit, seconds: Math.trunc(this.deathTime - data.eventTime) });
        } else {
          this.deathTime = data.eventTime + this.limit;
          bz.bz_sendTextMessage(bz.BZ_SERVER, this.rabbit, '{seconds} seconds remaining.', { seconds: this.limit });
        }
      }
    } else if (data.eventType === bz.bz_ePlayerPartEvent && data.record?.team === bz.eRabbitTeam) {
      this.rabbit = -1;
      this.deathTime = data.eventTime + this.limit;
    }
  },

  // Translations of what the plugin says, `{ locale: { msgid: msgstr } }`,
  // merged into what a bzo client is sent while the plugin runs
  // (docs/plugins-plan.md, "Translations"). None yet.
  l10n: {},
};
