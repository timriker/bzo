/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Which map file produced which cached world, so a restart can tell at once
// what it already has (issue #147).
//
// It is also what `MAP_REGISTRY` is rebuilt from at boot: a map whose entry
// still holds is listed from its hash, picture and stats here, and parsed only
// when someone views it (`prepareMapForView`). Only the live map keeps its
// world JSON on disk, so an entry does not promise one.
//
// This is only an index. It is never the source of a map's contents, and a
// wrong or stale entry costs a re-parse rather than a wrong world: an entry
// counts only while the `.bzw` it names still has the size and mtime it had
// when the hash was computed, only while its picture is still there, and only
// for the bzo version that made it.
const fs = require('fs');
const path = require('path');

function createMapIndex({ statePath, overviewDir, log, logError }) {
  // mapFileName -> { hash, overview, mtimeMs, size, stats, version },
  // `overview` being the picture's name in `overviewDir` without its `.svg`
  let entries = new Map();
  let writeTimer = null;

  // Debounced: a boot pass touches every map, and nothing waits on this file.
  function save() {
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      try {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(Object.fromEntries(entries), null, 1) + '\n');
      } catch (error) {
        logError(`Could not write ${statePath}:`, error);
      }
    }, 5000);
    if (writeTimer.unref) writeTimer.unref();
  }

  function statOf(filePath) {
    if (!filePath) return null;
    try {
      const { mtimeMs, size } = fs.statSync(filePath);
      return { mtimeMs, size };
    } catch {
      return null;
    }
  }

  return {
    load() {
      try {
        const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        for (const [name, value] of Object.entries(parsed || {})) {
          if (value && typeof value.hash === 'string') entries.set(name, value);
        }
        log(`[MAPS] restored an index of ${entries.size} cached world(s)`);
      } catch {
        // No index yet, or an unreadable one. Either way the boot pass below
        // rebuilds it from what it parses, which is where it came from.
        entries = new Map();
      }
    },

    // Called as each map registers, with the file it was read from.
    // `bzfsHash` is the world's hash as bzfs would give it, or null where it
    // could not be made.
    note(fileName, hash, overview, filePath, { stats = null, version = '', bzfsHash = null } = {}) {
      const stat = statOf(filePath);
      if (!stat) return;
      const existing = entries.get(fileName);
      if (existing && existing.hash === hash && existing.overview === overview
        && existing.mtimeMs === stat.mtimeMs && existing.size === stat.size
        && existing.version === version && existing.bzfsHash === bzfsHash) return;
      entries.set(fileName, { hash, overview, ...stat, stats, version, bzfsHash });
      save();
    },

    // Whether this server already holds a parsed, drawn copy of `fileName` --
    // answerable without parsing it. The picture has to be there: an index
    // entry whose picture was swept is a promise this cannot keep.
    has(fileName, filePath) {
      const entry = entries.get(fileName);
      if (!entry) return false;
      const stat = statOf(filePath);
      if (!stat || stat.mtimeMs !== entry.mtimeMs || stat.size !== entry.size) return false;
      return typeof entry.overview === 'string'
        && fs.existsSync(path.join(overviewDir, `${entry.overview}.svg`));
    },

    // What a map was registered with, for listing it without a parse: only
    // where `has` holds, the stats were kept, and this bzo made them. An
    // entry from before `bzfsHash` was kept is parsed once more for it.
    restore(fileName, filePath, version) {
      if (!this.has(fileName, filePath)) return null;
      const entry = entries.get(fileName);
      return entry.stats && entry.version === version && entry.bzfsHash !== undefined ? entry : null;
    },

    // The picture's name `has` vouches for, or null.
    overviewOf(fileName, filePath) {
      return this.has(fileName, filePath) ? entries.get(fileName).overview : null;
    },

    // Drops what no current map file names, so a removed map does not keep an
    // entry for ever. Run from the same sweep that clears the cache itself.
    prune(knownFileNames) {
      let removed = 0;
      for (const name of [...entries.keys()]) {
        if (!knownFileNames.has(name)) { entries.delete(name); removed += 1; }
      }
      if (removed > 0) save();
      return removed;
    },
  };
}

module.exports = { createMapIndex };
