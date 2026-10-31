/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// wwzones.cjs - upstream's plugins/wwzones: a map's `wwzone` blocks fire a
// world weapon when a tank drives into them.
//
//   wwzone
//     position 0 0 0
//     size 10 10 5
//     zoneweapon SW 1 0 0 0 0 0 0 0
//     repeat 2
//     timedelay 0
//     playermessage "Boom"
//     servermessage "Somebody stepped on the mine"
//     infomessage
//   end
//
// `zoneweapon <flag> <lifetime> <x> <y> <z> <tilt> <direction> <shotid> <dt>`
// is the weapon, its angles in degrees; lifetime, shot id and dt are read
// and, as upstream, not used. It fires once a tank has been in the zone for
// `timedelay` seconds, and with `repeat` again every that many seconds (half
// a second if none) while one stays. `playermessage` goes to the tank that set
// it off, `servermessage` to everyone, and `infomessage` says who did.

'use strict';

// A message's text: the rest of the line, a quoted one without its quotes,
// as upstream's tokenizer keeps a quoted string whole.
function restOfLine(line, key) {
  return line.slice(key.length).trim().replace(/^"(.*)"$/, '$1');
}

module.exports = {
  meta: {
    name: 'World Weapon Zones',
    version: '1.0',
    author: 'Tim Riker, after upstream',
    description: 'a map\'s wwzone blocks fire a world weapon at a tank that drives in',
    license: 'AGPL-3.0',
    enabled: false,
  },

  Init(bz) {
    this.bz = bz;
    this.zones = [];
    bz.bz_registerCustomMapObject('WWZONE', (name, data) => this.mapObject(name, data));
    bz.Register(bz.bz_eTickEvent);
  },

  mapObject(name, data) {
    if (name !== 'WWZONE' || !data) return false;
    const zone = new this.bz.bz_CustomZoneObject();
    zone.handleDefaultOptions(data);
    Object.assign(zone, {
      weapon: '', position: [0, 0, 0], tilt: 0, direction: 0,
      repeat: false, minFireTime: 0.5, timeDelay: 0, infoMessage: false,
      playerMessage: '', serverMessage: '',
      players: new Map(), fired: false, sentMessage: false, lastFired: 0,
    });
    for (const line of data.data) {
      const nubs = line.split(/\s+/);
      const key = nubs[0].toUpperCase();
      const n = (i) => Number.parseFloat(nubs[i]) || 0;
      if (key === 'ZONEWEAPON' && nubs.length > 9) {
        zone.weapon = nubs[1];
        zone.position = [n(3), n(4), n(5)];
        zone.tilt = n(6) * Math.PI / 180;
        zone.direction = n(7) * Math.PI / 180;
      } else if (key === 'REPEAT') {
        zone.repeat = true;
        if (nubs.length > 1) zone.minFireTime = n(1);
      } else if (key === 'TIMEDELAY' && nubs.length > 1) {
        zone.timeDelay = Math.max(0, n(1));
      } else if (key === 'PLAYERMESSAGE' && nubs.length > 1) {
        zone.playerMessage = restOfLine(line, nubs[0]);
      } else if (key === 'SERVERMESSAGE' && nubs.length > 1) {
        zone.serverMessage = restOfLine(line, nubs[0]);
      } else if (key === 'INFOMESSAGE') {
        zone.infoMessage = true;
      }
    }
    this.zones.push(zone);
    return true;
  },

  // wasHere: true for a tank already in the zone; one arriving is noted, and
  // the zone is armed again for it.
  wasHere(zone, id, now) {
    if (zone.players.has(id)) return true;
    zone.players.set(id, now);
    zone.sentMessage = false;
    zone.fired = false;
    return false;
  },

  notHere(zone, id) {
    if (!zone.players.delete(id)) return;
    zone.fired = false;
    zone.sentMessage = false;
  },

  okToFire(zone, id, now) {
    const since = zone.players.get(id);
    if (since === undefined || now - since <= zone.timeDelay || zone.fired) return false;
    zone.players.set(id, now);
    return true;
  },

  Event(data) {
    const { bz } = this;
    if (data.eventType !== bz.bz_eTickEvent) return;
    const now = bz.bz_getCurrentTime();
    for (const id of bz.bz_getPlayerIndexList()) {
      const player = bz.bz_getPlayerByIndex(id);
      if (!player) continue;
      for (const zone of this.zones) {
        if (!player.spawned || !zone.pointInZone(player.lastKnownState.pos)) {
          this.notHere(zone, id);
          continue;
        }
        if (this.wasHere(zone, id, now) && this.okToFire(zone, id, now) && !zone.fired) {
          bz.bz_fireServerShot(zone.weapon, zone.position, bz.bz_vectorFromRotations(zone.tilt, zone.direction));
          zone.fired = true;
          zone.lastFired = now;
        } else if (zone.repeat && now - zone.lastFired > zone.minFireTime) {
          zone.fired = false;
        }
        if (!zone.sentMessage && zone.fired) {
          if (zone.playerMessage) bz.bz_sendTextMessage(bz.BZ_SERVER, id, zone.playerMessage);
          if (zone.serverMessage) bz.bz_sendTextMessage(bz.BZ_SERVER, bz.BZ_ALLUSERS, zone.serverMessage);
          if (zone.infoMessage) {
            bz.bz_sendTextMessage(bz.BZ_SERVER, bz.BZ_ALLUSERS, '{weapon} triggered by {player}.',
              { weapon: zone.weapon, player: player.callsign });
          }
          zone.sentMessage = true;
        }
      }
    }
  },

  // Translations of what the plugin says, `{ locale: { msgid: msgstr } }`,
  // merged into what a bzo client is sent while the plugin runs
  // (docs/plugins-plan.md, "Translations"). None yet; its other messages are
  // the map's own.
  l10n: {},
};
