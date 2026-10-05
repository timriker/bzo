/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Which maps and replays an operator put here through the Operator panel, and
// so may take away again through it. By default the runtime `maps/` and
// `replays/` are the bundled directories themselves, so a file's place says
// nothing about whether it shipped with bzo; this record is what does. A file
// it does not name is never offered for deletion. Kept beside `server.json`,
// like `sessions.json`: losing it only stops the panel deleting old uploads.

const fs = require('node:fs');

const KINDS = Object.freeze(['maps', 'replays']);

function createUploadRecord(filePath, { log = () => {} } = {}) {
  let held = null;

  function load() {
    if (held) return held;
    held = { maps: new Set(), replays: new Set() };
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      for (const kind of KINDS) {
        if (Array.isArray(parsed[kind])) {
          for (const name of parsed[kind]) if (typeof name === 'string') held[kind].add(name);
        }
      }
    } catch {
      // None yet, or unreadable: nothing is deletable until something is uploaded.
    }
    return held;
  }

  function save() {
    const out = {};
    for (const kind of KINDS) out[kind] = [...held[kind]].sort();
    try {
      fs.writeFileSync(filePath, `${JSON.stringify(out, null, 2)}\n`);
    } catch (error) {
      log(`[UPLOADS] could not write ${filePath}: ${error.message}`);
    }
  }

  return {
    has(kind, name) {
      return load()[kind]?.has(name) === true;
    },
    add(kind, name) {
      if (!KINDS.includes(kind) || load()[kind].has(name)) return;
      held[kind].add(name);
      save();
    },
    remove(kind, name) {
      if (!KINDS.includes(kind) || !load()[kind].delete(name)) return;
      save();
    },
    list(kind) {
      return KINDS.includes(kind) ? [...load()[kind]].sort() : [];
    },
  };
}

module.exports = { createUploadRecord };
