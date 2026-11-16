/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// bzw-metadata.cjs - A map's `metadata` block (docs/bzw.md, "Metadata"):
// its title, authors, licence and the like. Taken out of the text before
// either map reader walks it, so neither bzo's reader (bzw-parse.cjs) nor the
// bzfs-faithful compiler (bzw-compile.cjs) reads a line of it as an obstacle.

'use strict';

const OPEN = /^[ \t]*metadata[ \t]*\r?$/im;

// `{ metadata, text, unterminated }`: the fields, each key lower-cased to a
// list of its values in file order, or null when the map states none; the
// text with the block's lines blanked to spaces, so every other line keeps
// its number and every character its offset (a span the world viewer shows
// is an offset into the file); and whether the file ended before
// `endmetadata`. A text with no block is handed back as it came.
function splitBzwMetadata(text) {
  if (!OPEN.test(text)) return { metadata: null, text, unterminated: false };
  const lines = text.split('\n');
  const fields = new Map();
  // A `metablock` with no key still owns its lines; they go nowhere.
  const add = (key, value) => {
    if (!key) return;
    if (!fields.has(key)) fields.set(key, []);
    fields.get(key).push(value);
  };
  let open = false;
  // The key a `metablock` is filling, whose lines are its values as written.
  let block = null;
  const blank = (n) => { lines[n] = lines[n].replace(/[^\r]/g, ' '); };
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    const word = line.split(/\s+/, 1)[0].toLowerCase();
    if (!open) {
      if (word === 'metadata' && line.length === word.length) {
        open = true;
        blank(n);
      }
      continue;
    }
    blank(n);
    if (block !== null) {
      if (word === 'endmetablock') block = null;
      else add(block, line);
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    if (word === 'endmetadata') {
      open = false;
      continue;
    }
    const value = line.slice(word.length).trim();
    if (word === 'metablock') block = value.toLowerCase();
    else add(word, value);
  }
  return {
    metadata: fields.size ? Object.fromEntries(fields) : null,
    text: lines.join('\n'),
    unterminated: open,
  };
}

module.exports = { splitBzwMetadata };
