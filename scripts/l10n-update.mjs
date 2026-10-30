#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Regenerates l10n/bzo.pot from the client and folds it into every
// l10n/bzo_<locale>.po, with the GNU gettext tools (docs/i18n-plan.md,
// "Tooling"). `t()` and `N_()` calls are xgettext's; the `data-i18n` markup in
// index.html, which xgettext cannot read, is gathered here first.
//
// Then the same for the help pages: l10n/doc.pot holds each paragraph, item,
// heading and table cell of docs/help/*.md, and l10n/doc_<locale>.po -- made
// for every interface locale that lacks one -- its translations. An edited
// English paragraph comes back fuzzy, and reads as English until it is redone.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const helpDocs = require('../server/help-docs.cjs');
const { FLAG_TYPES } = require('../public/js/flags.mjs');
const { PLAYER_TEAM, PLAYER_TEAM_LABELS } = require('../public/js/teams.mjs');

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const l10nDir = path.join(rootDir, 'l10n');
const potPath = path.join(l10nDir, 'bzo.pot');
const docPotPath = path.join(l10nDir, 'doc.pot');
const indexPath = path.join(rootDir, 'public', 'index.html');

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" };

function decode(text) {
  return text.replace(/&(\w+|#\d+);/g, (whole, name) => ENTITIES[name] ?? whole).replace(/\s+/g, ' ').trim();
}

function poString(text) {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

// Each tagged element's English, with its line, in document order.
function markupMessages(html) {
  const found = [];
  const lineOf = (index) => html.slice(0, index).split('\n').length;
  const tagPattern = /<\w+\b[^>]*>/g;
  for (const match of html.matchAll(tagPattern)) {
    const tag = match[0];
    const attr = (name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
    if (/\sdata-i18n(?=[\s>=])/.test(tag)) {
      const text = attr('data-i18n') || html.slice(match.index + tag.length).match(/^([^<]*)</)?.[1];
      if (text?.trim()) found.push({ msgid: decode(text), line: lineOf(match.index) });
    }
    for (const name of ['title', 'placeholder', 'aria-label']) {
      if (!new RegExp(`\\sdata-i18n-${name}(?=[\\s>=])`).test(tag)) continue;
      const text = attr(`data-i18n-${name}`) || attr(name);
      if (text?.trim()) found.push({ msgid: decode(text), line: lineOf(match.index) });
    }
  }
  return found;
}

// A locale names itself by the msgid that is its own id, as upstream's do, so
// every catalog's id is a msgid.
function localeIds() {
  return fs.readdirSync(l10nDir)
    .map((name) => name.match(/^bzo_(\w+)\.po$/)?.[1])
    .filter(Boolean)
    .sort();
}

const HEADER = [
  'msgid ""',
  'msgstr ""',
  '"Project-Id-Version: bzo\\n"',
  '"Report-Msgid-Bugs-To: https://github.com/timriker/bzo/issues\\n"',
  '"Language: \\n"',
  '"MIME-Version: 1.0\\n"',
  '"Content-Type: text/plain; charset=UTF-8\\n"',
  '"Content-Transfer-Encoding: 8bit\\n"',
  '',
];

function writeDocPot() {
  const refs = new Map();
  for (const { msgid, file } of helpDocs.extractMessages()) {
    if (!refs.has(msgid)) refs.set(msgid, new Set());
    refs.get(msgid).add(file);
  }
  const entries = [...HEADER];
  for (const [msgid, files] of refs) {
    entries.push(`#: ${[...files].join(' ')}`, `msgid ${poString(msgid)}`, 'msgstr ""', '');
  }
  fs.writeFileSync(docPotPath, entries.join('\n'));
}

function writeMarkupPot(file) {
  const entries = [...HEADER];
  const lines = new Map();
  for (const { msgid, line } of markupMessages(fs.readFileSync(indexPath, 'utf8'))) {
    lines.set(msgid, [...(lines.get(msgid) || []), `public/index.html:${line}`]);
  }
  for (const [msgid, refs] of lines) {
    entries.push(`#: ${refs.join(' ')}`, `msgid ${poString(msgid)}`, 'msgstr ""', '');
  }
  // The tables the game names things from: every flag's name and help, and
  // the teams. Their source files are data, not `t()` calls, so they are
  // listed here with a note saying what each one is.
  const tables = new Map();
  const note = (msgid, comment) => { if (msgid && !lines.has(msgid) && !tables.has(msgid)) tables.set(msgid, comment); };
  for (const flag of Object.values(FLAG_TYPES)) {
    note(flag.name, `TRANSLATORS: name of the ${flag.abbreviation} flag; the abbreviation stays as it is`);
  }
  for (const flag of Object.values(FLAG_TYPES)) {
    note(flag.help, `TRANSLATORS: what the ${flag.abbreviation} flag (${flag.name}) does`);
  }
  for (const label of Object.values(PLAYER_TEAM_LABELS)) note(label, 'TRANSLATORS: a team, or the team choice');
  // The server names a team by its id inside a sentence ("moved to red").
  for (const id of Object.values(PLAYER_TEAM)) note(id, 'TRANSLATORS: a team named inside a sentence, lower case where the language allows');
  for (const [msgid, comment] of tables) {
    entries.push(`#. ${comment}`, '#: public/js/flags.mjs public/js/teams.mjs', `msgid ${poString(msgid)}`, 'msgstr ""', '');
  }
  for (const id of localeIds()) {
    entries.push('#. TRANSLATORS: the name of this language, written in it', `msgid ${poString(id)}`, 'msgstr ""', '');
  }
  fs.writeFileSync(file, entries.join('\n'));
}

// The client, the server's replies -- `replyToPlayer`'s text and
// `localized`'s msgid, which a bzo client looks up -- the bundled plugins'
// `bz_sendTextMessage`, and the pages the server renders in the reader's
// language with `t` from `l10n.translator`.
function sources() {
  const list = (dir, pattern) => fs.readdirSync(path.join(rootDir, dir))
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => path.join(dir, name));
  const replies = (file) => /\b(replyToPlayer|localized|bz_sendTextMessage)\(|\bt\('/.test(fs.readFileSync(path.join(rootDir, file), 'utf8'));
  return [...list('public/js', /\.(m?js)$/),
    ...['server.js', ...list('server', /\.cjs$/), ...list('plugins', /\.cjs$/)].filter(replies)];
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzo-l10n-'));
try {
  const markupPot = path.join(tmpDir, 'markup.pot');
  writeMarkupPot(markupPot);
  execFileSync('xgettext', [
    '--language=JavaScript', '--from-code=UTF-8',
    '--keyword', '--keyword=t', '--keyword=N_', '--keyword=localized', '--keyword=replyToPlayer:2', '--keyword=bz_sendTextMessage:3',
    '--add-comments=TRANSLATORS:',
    '--package-name=bzo', '--msgid-bugs-address=https://github.com/timriker/bzo/issues',
    '--output', path.join(tmpDir, 'js.pot'),
    ...sources(),
  ], { cwd: rootDir, stdio: 'inherit' });
  execFileSync('msgcat', ['--use-first', '--output-file', potPath, markupPot, path.join(tmpDir, 'js.pot')], { stdio: 'inherit' });
  for (const id of localeIds()) {
    const catalog = path.join(l10nDir, `bzo_${id}.po`);
    execFileSync('msgmerge', ['--quiet', '--update', '--backup=none', '--no-fuzzy-matching', catalog, potPath], { stdio: 'inherit' });
    execFileSync('msgfmt', ['--check-format', '--output-file=/dev/null', catalog], { stdio: 'inherit' });
  }
  writeDocPot();
  for (const id of localeIds()) {
    const catalog = path.join(l10nDir, `doc_${id}.po`);
    if (!fs.existsSync(catalog)) {
      fs.writeFileSync(catalog, fs.readFileSync(docPotPath, 'utf8').replace('"Language: \\n"', `"Language: ${id}\\n"`));
    }
    execFileSync('msgmerge', ['--quiet', '--update', '--backup=none', catalog, docPotPath], { stdio: 'inherit' });
    execFileSync('msgfmt', ['--check-format', '--output-file=/dev/null', catalog], { stdio: 'inherit' });
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
console.log(`l10n: bzo.pot, doc.pot and ${localeIds().length} locale(s) updated`);
