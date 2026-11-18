/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// laptimer.cjs - times laps of a race track. The map draws the line:
//
//   finishline
//     position -85 90 0
//     heading 180
//     width 30
//     height 10
//   end
//
// `position` is the line's middle, `heading` the way racers cross it in
// degrees (0 east, 90 north), `width` how far the line reaches either side,
// and `height` how far above `position` a tank still counts. Crossing it the
// right way starts a lap, and the next crossing finishes it and starts the
// next. Crossing it backwards, dying or leaving drops the lap under way.
//
// `checkpoint` blocks are lines of the same shape, with `order` for which
// comes first (file order where none is given). A lap counts only once every
// checkpoint has been crossed in order since it started, so no teleporter or
// cut across the infield is a shortcut.
//
// Each racer's waypoint (docs/waypoints.md) is the next line to cross: the
// finish line until a lap starts, then each checkpoint in turn, then the
// finish line again.
//
// Each lap is a point on the scoreboard. The best lap of each player on each
// map is kept in the data directory, and `/laps` lists the ten fastest. A
// bot's laps score and are announced, but are not records.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RECORDS_KEPT = 10;
// A move faster than this, across or up, is a teleport or a respawn, not a
// crossing. A BZFlag client sends its position only when it strays from where
// it said it was going, about once a second on a conveyor, so the step is
// judged against the time it took rather than a fixed length. Tank and
// conveyor together run about 135 a second; a jump or a fall changes height
// far slower than a teleporter does.
const MAX_SPEED = 200;
const MAX_CLIMB = 60;
const STEP_SLACK = 10;

function formatTime(ms) {
  const minutes = Math.floor(ms / 60000);
  const seconds = (ms % 60000) / 1000;
  return `${minutes}:${seconds.toFixed(2).padStart(5, '0')}`;
}

module.exports = {
  meta: {
    name: 'Lap Timer',
    version: '1.0',
    author: 'Tim Riker',
    description: "times laps across the map's finishline, through its checkpoints, and keeps the best",
    license: 'AGPL-3.0',
  },

  Init(bz) {
    this.bz = bz;
    this.finishes = [];
    this.checkpoints = [];
    this.racers = new Map();
    this.file = path.join(bz.bz_getDataDir(), 'laptimer.json');
    this.records = this.load();
    bz.bz_registerCustomMapObject('FINISHLINE', (name, data) => this.mapObject(name, data));
    bz.bz_registerCustomMapObject('CHECKPOINT', (name, data) => this.mapObject(name, data));
    bz.Register(bz.bz_ePlayerUpdateEvent);
    bz.Register(bz.bz_ePlayerDieEvent);
    bz.Register(bz.bz_ePlayerSpawnEvent);
    bz.Register(bz.bz_ePlayerPartEvent);
    bz.bz_registerCustomSlashCommand('laps',
      (playerID) => this.listRecords(playerID), { help: '- the fastest laps on this map' });
  },

  mapObject(name, data) {
    if ((name !== 'FINISHLINE' && name !== 'CHECKPOINT') || !data) return false;
    const line = { x: 0, y: 0, z: 0, heading: 0, width: 30, height: 10, order: this.checkpoints.length };
    for (const text of data.data) {
      const nubs = String(text).trim().split(/\s+/);
      const key = nubs[0].toUpperCase();
      const n = (i) => Number.parseFloat(nubs[i]);
      if ((key === 'POSITION' || key === 'POS') && nubs.length > 3) {
        [line.x, line.y, line.z] = [n(1), n(2), n(3)];
      } else if (key === 'HEADING' && nubs.length > 1) {
        line.heading = n(1);
      } else if (key === 'WIDTH' && nubs.length > 1) {
        line.width = n(1);
      } else if (key === 'HEIGHT' && nubs.length > 1) {
        line.height = n(1);
      } else if (key === 'ORDER' && nubs.length > 1) {
        line.order = n(1);
      }
    }
    if (![line.x, line.y, line.z, line.heading, line.width, line.height, line.order].every(Number.isFinite)) {
      return false;
    }
    const radians = line.heading * Math.PI / 180;
    line.dirX = Math.cos(radians);
    line.dirY = Math.sin(radians);
    if (name === 'FINISHLINE') {
      this.finishes.push(line);
    } else {
      this.checkpoints.push(line);
      this.checkpoints.sort((a, b) => a.order - b.order);
    }
    return true;
  },

  Event(data) {
    const { bz } = this;
    switch (data.eventType) {
      case bz.bz_ePlayerUpdateEvent:
        this.onUpdate(data.playerID, data.state.pos);
        break;
      case bz.bz_ePlayerSpawnEvent:
      case bz.bz_ePlayerDieEvent:
        this.drop(data.playerID);
        this.aim(data.playerID);
        break;
      case bz.bz_ePlayerPartEvent:
        this.racers.delete(data.playerID);
        break;
      default:
        break;
    }
  },

  racer(playerID) {
    let racer = this.racers.get(playerID);
    if (!racer) {
      racer = { pos: null, at: 0, lapStart: null, next: 0, laps: 0, best: null };
      this.racers.set(playerID, racer);
    }
    return racer;
  },

  // A death or a respawn: the lap under way is lost, and the next position is
  // not a step from the last one.
  drop(playerID) {
    const racer = this.racer(playerID);
    racer.pos = null;
    racer.lapStart = null;
    racer.next = 0;
    racer.aimed = null;
  },

  onUpdate(playerID, pos) {
    const now = Date.now();
    const racer = this.racer(playerID);
    const from = racer.pos;
    const fromAt = racer.at;
    racer.pos = [pos[0], pos[1], pos[2]];
    racer.at = now;
    if (!from) return;
    const seconds = (now - fromAt) / 1000;
    if (Math.hypot(pos[0] - from[0], pos[1] - from[1]) > (MAX_SPEED * seconds) + STEP_SLACK) return;
    if (Math.abs(pos[2] - from[2]) > (MAX_CLIMB * seconds) + STEP_SLACK) return;
    // Every line the step crossed, in the order it crossed them.
    const crossings = [...this.finishes, ...this.checkpoints]
      .map((line) => ({ line, ...this.crossing(line, from, pos) }))
      .filter((crossing) => crossing.fraction !== undefined)
      .sort((a, b) => a.fraction - b.fraction);
    for (const { line, forward, fraction } of crossings) {
      if (this.finishes.includes(line)) {
        if (forward) {
          // When it crossed, between the two moves, rather than when it was told.
          this.cross(playerID, racer, fromAt + ((now - fromAt) * fraction));
        } else {
          racer.lapStart = null;
        }
      } else if (forward && racer.lapStart !== null && this.checkpoints[racer.next] === line) {
        racer.next += 1;
      }
    }
    if (crossings.length > 0) this.aim(playerID);
  },

  // The racer's waypoint at the next line to cross, labelled with which. It
  // has no arrival radius: the line's crossing moves it on.
  aim(playerID) {
    const { bz } = this;
    const racer = this.racer(playerID);
    const checkpoint = racer.lapStart !== null ? this.checkpoints[racer.next] : null;
    const line = checkpoint || this.finishes[0];
    if (!line) return;
    const label = checkpoint
      ? `Checkpoint ${racer.next + 1} of ${this.checkpoints.length}`
      : 'Finish line';
    const key = `${line.x},${line.y},${label}`;
    if (racer.aimed === key) return;
    racer.aimed = key;
    bz.bz_setWaypoint?.(playerID, line.x, line.y, line.z, label, 0);
  },

  // Where the step from `from` to `to` passes the line, if it does: which way,
  // and how far along the step.
  crossing(line, from, to) {
    const along = (p) => ((p[0] - line.x) * line.dirX) + ((p[1] - line.y) * line.dirY);
    const before = along(from);
    const after = along(to);
    if ((before < 0) === (after < 0)) return null;
    const fraction = before / (before - after);
    const x = from[0] + ((to[0] - from[0]) * fraction);
    const y = from[1] + ((to[1] - from[1]) * fraction);
    const z = from[2] + ((to[2] - from[2]) * fraction);
    const across = ((x - line.x) * -line.dirY) + ((y - line.y) * line.dirX);
    if (Math.abs(across) > line.width) return null;
    if (z < line.z - 1 || z > line.z + line.height) return null;
    return { forward: after > before, fraction };
  },

  cross(playerID, racer, at) {
    const { bz } = this;
    const started = racer.lapStart;
    const missed = racer.next < this.checkpoints.length ? racer.next + 1 : null;
    racer.lapStart = at;
    racer.next = 0;
    if (started === null) {
      this.say(playerID, 'Lap started.');
      return;
    }
    if (missed !== null) {
      this.say(playerID, 'Lap not counted: missed checkpoint {checkpoint}. Lap started.', { checkpoint: missed });
      return;
    }
    const ms = Math.round(at - started);
    racer.laps += 1;
    const personal = racer.best === null || ms < racer.best;
    if (personal) racer.best = ms;
    bz.bz_incrementPlayerWins(playerID, 1);
    const player = bz.bz_getPlayerByIndex(playerID);
    if (!player) return;
    // A bot's lap scores, but the records are the players'.
    const place = player.bot ? null : this.record(player, ms);
    const params = { player: player.callsign, lap: racer.laps, time: formatTime(ms), place };
    if (place === 1) this.say(bz.BZ_ALLUSERS, '{player}: lap {lap} in {time} -- a new lap record!', params);
    else if (place) this.say(bz.BZ_ALLUSERS, '{player}: lap {lap} in {time} -- #{place} on this map', params);
    else if (personal && racer.laps > 1) this.say(bz.BZ_ALLUSERS, '{player}: lap {lap} in {time} -- a personal best', params);
    else this.say(bz.BZ_ALLUSERS, '{player}: lap {lap} in {time}', params);
  },

  // Keeps the racer's best on this map among the fastest, and says where it
  // placed, or null where it did not improve their place.
  record(player, ms) {
    const map = this.bz.bz_getMapName();
    const who = player.bzID ? { bzid: player.bzID } : { callsign: player.callsign };
    const list = this.records[map] || [];
    const same = (entry) => (who.bzid ? entry.bzid === who.bzid : !entry.bzid && entry.callsign === player.callsign);
    const mine = list.find(same);
    if (mine && mine.ms <= ms) return null;
    const next = list.filter((entry) => !same(entry));
    next.push({ ...who, callsign: player.callsign, ms, at: new Date().toISOString() });
    next.sort((a, b) => a.ms - b.ms);
    const place = next.findIndex((entry) => entry.ms === ms && same(entry)) + 1;
    if (place > RECORDS_KEPT) return null;
    this.records[map] = next.slice(0, RECORDS_KEPT);
    this.save();
    return place;
  },

  listRecords(playerID) {
    const { bz } = this;
    const list = this.records[bz.bz_getMapName()] || [];
    if (list.length === 0) {
      this.say(playerID, 'No laps recorded on this map yet.');
      return true;
    }
    this.say(playerID, 'Fastest laps on this map:');
    list.forEach((entry, index) => {
      this.say(playerID, '{place}. {time} {player}', { place: index + 1, time: formatTime(entry.ms), player: entry.callsign });
    });
    return true;
  },

  say(to, message, params) {
    this.bz.bz_sendTextMessage(this.bz.BZ_SERVER, to, message, params);
  },

  load() {
    try {
      const records = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return records && typeof records === 'object' ? records : {};
    } catch {
      return {};
    }
  },

  save() {
    try {
      fs.writeFileSync(this.file, `${JSON.stringify(this.records, null, 2)}\n`);
    } catch (error) {
      this.bz.bz_debugMessage(0, `laptimer: could not save ${this.file}: ${error.message}`);
    }
  },

  Cleanup() {
    this.bz.bz_removeCustomSlashCommand('laps');
  },
};
