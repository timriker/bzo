/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// upgrade.cjs - tells a BZFlag client older than `minVersion` that the map
// draws things it cannot, and where to see them: a newer BZFlag, or this
// server on the web. Said shortly after the player joins, then every
// `interval` minutes while they stay. Options in server.json:
// `{ "minVersion": "2.4.32", "interval": 10, "maps": "hix_ad", "url": "" }`.
// `maps` is a comma-separated list of map names, as `bz_getMapName` gives
// them; empty warns on every map. `url` empty is the server's own
// `publicUrl`.

'use strict';

const parseVersion = (text) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
  return match ? match.slice(1, 4).map(Number) : null;
};

const older = (version, minimum) => {
  for (let i = 0; i < 3; i += 1) {
    if (version[i] !== minimum[i]) return version[i] < minimum[i];
  }
  return false;
};

module.exports = {
  meta: {
    name: 'Upgrade',
    version: '1.0',
    author: 'Tim Riker',
    description: 'tells older BZFlag clients what the map needs to be seen',
    license: 'AGPL-3.0',
    options: [
      { name: 'minVersion', type: 'string', maxLength: 16, default: '2.4.32', help: 'Oldest BZFlag that draws the map' },
      { name: 'interval', type: 'number', min: 1, max: 120, step: 1, default: 10, help: 'Minutes between reminders' },
      { name: 'maps', type: 'string', maxLength: 400, default: '', help: 'Maps to warn on, comma-separated (empty: all)' },
      { name: 'url', type: 'string', maxLength: 200, default: '', help: 'Web address to suggest (empty: this server)' },
    ],
  },

  Init(bz, config) {
    this.bz = bz;
    this.minimum = parseVersion(config.minVersion) || [2, 4, 32];
    this.minText = this.minimum.join('.');
    const minutes = Number(config.interval) > 0 ? Number(config.interval) : 10;
    this.maps = new Set(String(config.maps || '').split(',').map((name) => name.trim()).filter(Boolean));
    this.url = String(config.url || '').trim();
    bz.Register(bz.bz_ePlayerJoinEvent);
    this.timer = bz.setInterval(() => this.remindAll(), minutes * 60 * 1000);
  },

  Event(data) {
    const { bz } = this;
    if (data.eventType === bz.bz_ePlayerJoinEvent) {
      const id = data.playerID;
      // After the join's own greetings, so it is not scrolled away at once.
      bz.setTimeout(() => this.remind(id), 15 * 1000);
    }
  },

  needsUpgrade(id) {
    const { bz } = this;
    if (this.maps.size > 0 && !this.maps.has(bz.bz_getMapName())) return false;
    const record = bz.bz_getPlayerByIndex(id);
    if (!record || record.client !== 'bzflag') return false;
    const version = parseVersion(record.clientVersion);
    return version !== null && older(version, this.minimum);
  },

  remind(id) {
    const { bz } = this;
    if (!this.needsUpgrade(id)) return;
    bz.bz_sendTextMessage(bz.BZ_SERVER, id,
      'This map uses features that only display in BZFlag {version} and newer, or on the web at {url}',
      { version: this.minText, url: this.url || bz.bz_getPublicAddr() });
  },

  remindAll() {
    for (const id of this.bz.bz_getPlayerIndexList()) this.remind(id);
  },

  Cleanup() {
    this.bz.clearTimer(this.timer);
  },
};
