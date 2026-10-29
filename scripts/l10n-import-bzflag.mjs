#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Seeds l10n/bzo_<locale>.po from upstream's data/l10n/bzflag_<locale>.po by
// exact msgid, so a locale starts with the terms BZFlag already chose for it
// (docs/i18n-plan.md, "Tooling"). A one-time tool: run it before translating
// anything new, then after `npm run l10n:update` whenever new strings arrive.
//
//   node scripts/l10n-import-bzflag.mjs [locale ...]
//
// `source:locale` imports upstream's catalog under another id: upstream calls
// Klingon `kg`, which is Kongo's code, so it comes in as `kg:tlh`.
//
// BZFLAG names the upstream tree, $HOME/bzflag by default. A catalog that does
// not exist yet is created; one that does keeps its own translations, and
// upstream only fills what it leaves empty.
//
// Upstream's catalogs are ASCII-only -- Czech and Slovak without their
// accents, Russian transliterated into Latin -- and bzo renders through the
// browser, so every entry filled from upstream is flagged `# review:` for its
// accents or script to be restored (docs/i18n-plan.md, "Reviewing").

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePo } from '../public/js/i18n.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const l10nDir = path.join(rootDir, 'l10n');
const potPath = path.join(l10nDir, 'bzo.pot');
const upstreamDir = path.join(process.env.BZFLAG || path.join(os.homedir(), 'bzflag'), 'data', 'l10n');

function poString(text) {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

// Upstream's files have no header and repeat some msgids; a compendium for
// msgmerge needs neither problem, so it is rewritten from the parsed messages.
function writeCompendium(source, file, upstreamId, locale) {
  const messages = parsePo(fs.readFileSync(source, 'utf8'));
  // The catalog's own name is keyed by its id, which a renamed one changes.
  if (messages[upstreamId]) messages[locale] = messages[upstreamId];
  const lines = ['msgid ""', 'msgstr ""', '"Content-Type: text/plain; charset=UTF-8\\n"', ''];
  for (const [msgid, msgstr] of Object.entries(messages)) {
    lines.push(`msgid ${poString(msgid)}`, `msgstr ${poString(msgstr)}`, '');
  }
  fs.writeFileSync(file, lines.join('\n'));
}

const REVIEW_NOTE = '# review: from upstream BZFlag, which is ASCII-only; restore accents or native script';

// Mark each entry translated by this run and not before.
function flagImported(catalog, before) {
  const blocks = fs.readFileSync(catalog, 'utf8').split('\n\n');
  let filled = 0;
  const marked = blocks.map((block) => {
    const entry = parsePo(block);
    const [msgid] = Object.keys(entry);
    if (!msgid || before[msgid] || block.includes(REVIEW_NOTE)) return block;
    filled++;
    return `${REVIEW_NOTE}\n${block}`;
  });
  fs.writeFileSync(catalog, marked.join('\n\n'));
  return filled;
}

const imports = process.argv.slice(2).map((arg) => {
  const [source, locale = source] = arg.split(':');
  return { source, locale };
});
const locales = imports.map(({ locale }) => locale);
if (!locales.length) {
  console.error('usage: l10n-import-bzflag.mjs <locale> [...]  (e.g. es en_US_l33t)');
  process.exit(2);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzo-l10n-import-'));
try {
  for (const locale of locales) {
    const catalog = path.join(l10nDir, `bzo_${locale}.po`);
    if (fs.existsSync(catalog)) continue;
    // Not msginit, which copies every msgid into an English locale's msgstr
    // and would leave the joke locales looking finished.
    const template = fs.readFileSync(potPath, 'utf8');
    fs.writeFileSync(catalog, template.replace('"Language: \\n"', `"Language: ${locale}\\n"`));
  }
  // A new catalog's id becomes a msgid only once the catalog exists, and that
  // msgid is where the locale's own name comes from.
  execFileSync(process.execPath, [path.join(rootDir, 'scripts', 'l10n-update.mjs')], { stdio: 'inherit' });
  for (const { source: upstreamId, locale } of imports) {
    const source = path.join(upstreamDir, `bzflag_${upstreamId}.po`);
    const catalog = path.join(l10nDir, `bzo_${locale}.po`);
    const compendium = path.join(tmpDir, `${locale}.po`);
    writeCompendium(source, compendium, upstreamId, locale);
    const before = parsePo(fs.readFileSync(catalog, 'utf8'));
    execFileSync('msgmerge', ['--quiet', '--update', '--backup=none', '--no-fuzzy-matching', `--compendium=${compendium}`, catalog, potPath], { stdio: 'inherit' });
    const filled = flagImported(catalog, before);
    console.log(`${locale}: ${filled} filled from ${source}, each flagged for review`);
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
