/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// flagStay.cjs - upstream's plugins/flagStay: a map's `flagStayZone` blocks
// keep the flags they name inside them. A tank that grabs one of those flags
// in the zone loses it the moment it drives out, and is told the zone's
// message if it has one:
//
//   flagStayZone
//     position 0 0 0
//     size 20 20 10
//     flag GM
//     message "The missile launcher stays in the armoury"
//   end
//
// A zone is a box (`position`, `size`, `rotation`) or a cylinder (`radius`,
// `height`), as every upstream zone plugin reads it.

'use strict';

module.exports = {
  meta: {
    name: 'Flag Stay Zones',
    version: '1.0',
    author: 'Tim Riker, after upstream',
    description: 'a map\'s flagStayZone blocks keep the flags they name inside them',
    license: 'AGPL-3.0',
    enabled: false,
  },

  Init(bz) {
    this.bz = bz;
    this.zones = [];
    // The zone each player took a staying flag in, by player.
    this.heldIn = new Map();
    bz.bz_registerCustomMapObject('FLAGSTAYZONE', (name, data) => this.mapObject(name, data));
    bz.Register(bz.bz_eFlagGrabbedEvent);
    bz.Register(bz.bz_ePlayerUpdateEvent);
    bz.Register(bz.bz_ePlayerPartEvent);
  },

  mapObject(name, data) {
    if (name !== 'FLAGSTAYZONE' || !data) return false;
    const zone = new this.bz.bz_CustomZoneObject();
    zone.handleDefaultOptions(data);
    zone.flags = [];
    zone.message = '';
    for (const line of data.data) {
      const nubs = line.split(/\s+/);
      const key = nubs[0].toUpperCase();
      if (key === 'FLAG' && nubs.length > 1) zone.flags.push(nubs[1].toUpperCase());
      // The rest of the line, quotes and all, as upstream's tokenizer keeps a
      // quoted message whole.
      else if ((key === 'MESSAGE' || key === 'MSG') && nubs.length > 1) {
        zone.message = line.slice(nubs[0].length).trim().replace(/^"(.*)"$/, '$1');
      }
    }
    this.zones.push(zone);
    return true;
  },

  Event(data) {
    const { bz } = this;
    if (data.eventType === bz.bz_eFlagGrabbedEvent) {
      const type = String(data.flagType).toUpperCase();
      const index = this.zones.findIndex((zone) => zone.pointInZone(data.pos) && zone.flags.includes(type));
      if (index >= 0) this.heldIn.set(data.playerID, index);
    } else if (data.eventType === bz.bz_ePlayerUpdateEvent) {
      const index = this.heldIn.get(data.playerID);
      if (index === undefined) return;
      if (!bz.bz_getPlayerFlag(data.playerID)) {
        this.heldIn.delete(data.playerID);
        return;
      }
      const zone = this.zones[index];
      if (zone.pointInZone(data.state.pos)) return;
      bz.bz_removePlayerFlag(data.playerID);
      this.heldIn.delete(data.playerID);
      if (zone.message) bz.bz_sendTextMessage(bz.BZ_SERVER, data.playerID, zone.message);
    } else if (data.eventType === bz.bz_ePlayerPartEvent) {
      this.heldIn.delete(data.playerID);
    }
  },

  // Translations of what the plugin says, `{ locale: { msgid: msgstr } }`,
  // merged into what a bzo client is sent while the plugin runs
  // (docs/plugins-plan.md, "Translations"). Its one message is the map's own.
  l10n: {},
};
