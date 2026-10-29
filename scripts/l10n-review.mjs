#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// What in l10n/ still wants a translator: docs/i18n-plan.md, "Reviewing".
//
//   npm run l10n:review            every locale, one line each
//   npm run l10n:review -- es ja   those locales, with each entry to look at
//
// A catalog nobody fluent has read carries `X-Review:` in its header. An entry
// with a doubt carries a translator comment starting `# review:`, which
// msgmerge keeps across updates. A reviewer fixes the entry and deletes the
// comment, and removes the header field once the whole catalog has been read.
// Untranslated and fuzzy entries are counted too, since both read as English.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const l10nDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'l10n');

function unquote(line) {
  return line.trim().replace(/^"|"$/g, '').replace(/\\"/g, '"').replace(/\\n/g, '\n');
}

// Each entry as { msgid, msgstr, fuzzy, notes } -- enough to report on, and
// independent of the runtime reader, which drops what this has to show.
function entries(file) {
  const found = [];
  for (const block of fs.readFileSync(file, 'utf8').split(/\n{2,}/)) {
    const lines = block.split('\n');
    if (lines.every((line) => line.startsWith('#~') || !line.trim())) continue;
    const entry = { msgid: '', msgstr: '', fuzzy: false, notes: [] };
    let field = null;
    for (const line of lines) {
      if (line.startsWith('# review:')) entry.notes.push(line.slice('# review:'.length).trim());
      else if (line.startsWith('#,')) entry.fuzzy ||= /\bfuzzy\b/.test(line);
      else if (line.startsWith('msgid ')) { field = 'msgid'; entry.msgid = unquote(line.slice(6)); }
      else if (line.startsWith('msgstr ')) { field = 'msgstr'; entry.msgstr = unquote(line.slice(7)); }
      else if (line.startsWith('"') && field) entry[field] += unquote(line);
    }
    found.push(entry);
  }
  return found;
}

const ids = fs.readdirSync(l10nDir)
  .map((name) => name.match(/^bzo_(\w+)\.po$/)?.[1])
  .filter(Boolean)
  .sort();
const asked = process.argv.slice(2);
const detail = asked.length > 0;

for (const id of detail ? asked : ids) {
  const summary = [];
  const items = [];
  let unreviewed = null;
  for (const domain of ['bzo', 'doc']) {
    const file = path.join(l10nDir, `${domain}_${id}.po`);
    if (!fs.existsSync(file)) continue;
    const all = entries(file);
    const header = all.find((entry) => entry.msgid === '');
    const review = header?.msgstr.match(/^X-Review: (.*)$/m)?.[1];
    if (review) unreviewed = review;
    // Every catalog carries every locale's own name as a msgid; only its own
    // is one to translate.
    const body = all.filter((entry) => entry.msgid && (domain === 'doc' || entry.msgid === id || !ids.includes(entry.msgid)));
    const missing = body.filter((entry) => !entry.msgstr).length;
    const fuzzy = body.filter((entry) => entry.fuzzy).length;
    const flagged = body.filter((entry) => entry.notes.length);
    summary.push(`${domain} ${body.length - missing - fuzzy}/${body.length}`
      + `${fuzzy ? ` ${fuzzy} fuzzy` : ''}${flagged.length ? ` ${flagged.length} to review` : ''}`);
    for (const entry of flagged) items.push({ domain, ...entry });
  }
  console.log(`${id.padEnd(14)} ${summary.join(', ')}${unreviewed ? `  [${unreviewed}]` : ''}`);
  if (!detail) continue;
  for (const { domain, msgid, msgstr, notes } of items) {
    console.log(`  ${domain}: ${JSON.stringify(msgid.slice(0, 70))} -> ${JSON.stringify(msgstr.slice(0, 70))}`);
    for (const note of notes) console.log(`    ${note}`);
  }
}
