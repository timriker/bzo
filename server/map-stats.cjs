/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// map-stats.cjs - How much each local map is used (docs/map-archive-plan.md,
// "Use counts"), kept in data/map-stats.json by map file name: views and
// practice starts by day, time played here as the live map, and the bzfs
// servers seen running its world. Counts only; who did it is not kept.
'use strict';

const fs = require('fs');
const path = require('path');

const day = (at = Date.now()) => new Date(at).toISOString().slice(0, 10);
const sum = (byDay) => Object.values(byDay || {}).reduce((total, n) => total + n, 0);

function createMapStats({ statePath, logError = console.error }) {
  let maps = null;
  let writeTimer = null;
  // What has been counted today, as `kind|file|who`, so a session reloading
  // or rejoining counts once a day. Cleared when the day turns.
  let countedDay = '';
  const counted = new Set();

  function load() {
    if (maps) return;
    try {
      maps = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') logError(`Could not read ${statePath}:`, error);
      maps = {};
    }
  }

  function save() {
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      try {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(maps, null, 1) + '\n');
      } catch (error) {
        logError(`Could not write ${statePath}:`, error);
      }
    }, 5000);
    if (writeTimer.unref) writeTimer.unref();
  }

  function entry(file) {
    load();
    if (!maps[file]) maps[file] = {};
    return maps[file];
  }

  // Whether `who` is new to this kind of use of this map today.
  function firstToday(kind, file, who) {
    const today = day();
    if (today !== countedDay) {
      countedDay = today;
      counted.clear();
    }
    const key = `${kind}|${file}|${who}`;
    if (counted.has(key)) return false;
    counted.add(key);
    return true;
  }

  return {
    // A view or a practice start (`kind`), once a day for each `who`.
    note(file, kind, who) {
      if (!file || !firstToday(kind, file, who)) return;
      const byDay = (entry(file)[kind] ||= {});
      const today = day();
      byDay[today] = (byDay[today] || 0) + 1;
      save();
    },

    // `seconds` of play on the live map by the players `who` (one each).
    addPlay(file, seconds, whos) {
      if (!file || whos.length === 0) return;
      const stats = entry(file);
      const today = day();
      stats.play ||= {};
      stats.play[today] = (stats.play[today] || 0) + seconds * whos.length;
      stats.players ||= {};
      for (const who of whos) {
        if (firstToday('players', file, who)) stats.players[today] = (stats.players[today] || 0) + 1;
      }
      save();
    },

    // The bzfs servers seen running the map's world, `host:port` to when
    // each was last checked, kept with when each was first seen.
    noteServers(file, seen) {
      const keys = Object.keys(seen);
      if (!file || keys.length === 0) return;
      const servers = (entry(file).servers ||= {});
      for (const key of keys) {
        const at = day(seen[key]);
        const known = servers[key];
        if (!known) servers[key] = { first: at, last: at };
        else if (at > known.last) known.last = at;
        else continue;
        save();
      }
    },

    // Totals, as the map list shows them.
    summary(file) {
      load();
      const stats = maps[file] || {};
      return {
        views: sum(stats.views),
        practice: sum(stats.practice),
        playSeconds: sum(stats.play),
        players: sum(stats.players),
        servers: stats.servers || {},
      };
    },

    // A map whose file has gone takes its counts with it.
    prune(files) {
      load();
      const keep = new Set(files);
      let removed = false;
      for (const file of Object.keys(maps)) {
        if (keep.has(file)) continue;
        delete maps[file];
        removed = true;
      }
      if (removed) save();
    },
  };
}

module.exports = { createMapStats };
