/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

'use strict';

// The interface catalogs, `l10n/bzo_<locale>.po`, served to the browser as
// JSON, and the help pages' paragraph catalogs, `l10n/doc_<locale>.po`
// (server/help-docs.cjs). See docs/i18n-plan.md. The locale list is whatever the directory
// holds, and each file is reread when its mtime moves, so an edited catalog
// shows on the next page load without a restart.

const fs = require('fs');
const path = require('path');
const { parsePo, languageTag, textDirection } = require('../public/js/i18n.mjs');

const L10N_DIR = path.join(__dirname, '..', 'l10n');
const CATALOG_FILE = /^bzo_(\w+)\.po$/;
const DEFAULT_LOCALE = 'en';

const parsed = new Map();

function readCatalog(locale, domain = 'bzo') {
  const file = path.join(L10N_DIR, `${domain}_${locale}.po`);
  let mtimeMs;
  try {
    ({ mtimeMs } = fs.statSync(file));
  } catch {
    parsed.delete(file);
    return null;
  }
  const cached = parsed.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.messages;
  const messages = parsePo(fs.readFileSync(file, 'utf8'));
  parsed.set(file, { mtimeMs, messages });
  return messages;
}

function localeIds() {
  let names = [];
  try {
    names = fs.readdirSync(L10N_DIR);
  } catch {
    // No l10n/ at all is an English-only server.
  }
  const ids = names.map((name) => name.match(CATALOG_FILE)?.[1]).filter(Boolean);
  return [DEFAULT_LOCALE, ...ids.filter((id) => id !== DEFAULT_LOCALE).sort()];
}

// A locale names itself the way upstream's catalogs do: the msgid that is its
// own id, translated (`es` is "Español", `en_US_l33t` is "l337").
function localeName(id) {
  if (id === DEFAULT_LOCALE) return 'English';
  return readCatalog(id)?.[id] || id;
}

function listLocales() {
  return localeIds().map((id) => ({ id, name: localeName(id) }));
}

function hasLocale(id) {
  return localeIds().includes(id);
}

// Upstream's parent fallback: `pt_BR` over `pt`, both over the msgid.
function catalogMessages(locale, domain = 'bzo') {
  const messages = {};
  const parts = locale.split('_');
  for (let i = 1; i <= parts.length; i++) {
    Object.assign(messages, readCatalog(parts.slice(0, i).join('_'), domain) || {});
  }
  return messages;
}

function catalogFor(locale) {
  return { locale, locales: listLocales(), messages: catalogMessages(locale) };
}

// Browser tags that mean a catalog without naming it: Hong Kong and Macau
// read Traditional Chinese, Singapore Simplified, and a script subtag says
// which outright.
const TAG_ALIASES = Object.freeze({
  'zh-Hant': 'zh_TW', 'zh-Hant-TW': 'zh_TW', 'zh-Hant-HK': 'zh_TW', 'zh-Hant-MO': 'zh_TW',
  'zh-HK': 'zh_TW', 'zh-MO': 'zh_TW',
  'zh-Hans': 'zh_CN', 'zh-Hans-CN': 'zh_CN', 'zh-Hans-SG': 'zh_CN', 'zh-SG': 'zh_CN',
});

// `?lang=` first, so a link can carry a language and any locale can be tried
// from a browser that will not send it; then Accept-Language. Private-use
// tags (the joke locales) are offered to `?lang=` and Settings only -- no
// browser asks for them, and `en` must never match one by prefix.
function negotiateLocale(req) {
  const ids = localeIds();
  const asked = typeof req.query?.lang === 'string' ? req.query.lang.replace(/-/g, '_') : '';
  if (asked && ids.includes(asked)) return asked;
  const byTag = new Map();
  for (const id of ids) {
    const tag = languageTag(id);
    if (!tag.includes('-x-')) byTag.set(tag, id);
  }
  for (const [tag, id] of Object.entries(TAG_ALIASES)) {
    if (ids.includes(id)) byTag.set(tag, id);
  }
  const best = req.acceptsLanguages([...byTag.keys()]);
  return (best && byTag.get(best)) || DEFAULT_LOCALE;
}

// JSON inside a <script> element: nothing in it may close the element.
function inlineJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

module.exports = { catalogFor, catalogMessages, hasLocale, negotiateLocale, inlineJson, languageTag, textDirection, DEFAULT_LOCALE };
