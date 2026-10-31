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
const { formatMessage, parsePo, languageTag, textDirection } = require('../public/js/i18n.mjs');
const { escapeHtml } = require('./server-name.cjs');
const { parseCookies } = require('./sessions.cjs');

const L10N_DIR = path.join(__dirname, '..', 'l10n');
const CATALOG_FILE = /^bzo_(\w+)\.po$/;
const DEFAULT_LOCALE = 'en';
// The language a player chose in Settings, which every page the server renders
// follows (public/js/i18n.mjs writes it). Absent means Automatic.
const LOCALE_COOKIE = 'bzo_lang';

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

// The loaded plugins' own strings for one locale, `{ msgid: msgstr }`, which
// server.js supplies (docs/plugins-plan.md, "Translations").
let pluginMessages = () => ({});

function usePluginMessages(lookup) {
  pluginMessages = lookup;
}

// Upstream's parent fallback: `pt_PT` over `pt`, both over the msgid. The
// interface catalog takes the loaded plugins' strings under its own, so a
// plugin adds translations but never changes one bzo already has.
function catalogMessages(locale, domain = 'bzo') {
  const plugin = {};
  const messages = {};
  const parts = locale.split('_');
  for (let i = 1; i <= parts.length; i++) {
    const level = parts.slice(0, i).join('_');
    if (domain === 'bzo') Object.assign(plugin, pluginMessages(level) || {});
    Object.assign(messages, readCatalog(level, domain) || {});
  }
  return { ...plugin, ...messages };
}

// `t` for a page the server renders in `locale`, as the client's `t` is:
// `const t = l10n.translator(locale)` -- named `t` so the strings are
// extracted with the client's.
function translator(locale) {
  const messages = catalogMessages(locale);
  const lookup = (msgid) => messages[msgid] || msgid;
  return (msgid, params) => formatMessage(lookup(msgid), params, lookup);
}

// `browser` is the language Automatic means for this reader, so Settings can
// tell a choice that only repeats it from one that overrides it.
function catalogFor(locale, browser = locale) {
  return { locale, browser, locales: listLocales(), messages: catalogMessages(locale) };
}

// Browser tags that mean a catalog without naming it: Hong Kong and Macau
// read Traditional Chinese, Singapore Simplified, and a script subtag says
// which outright. Bare `pt` is Brazilian, as CLDR has it; the other
// Portuguese-speaking countries write the European standard.
const TAG_ALIASES = Object.freeze({
  'pt-AO': 'pt_PT', 'pt-MZ': 'pt_PT', 'pt-CV': 'pt_PT', 'pt-GW': 'pt_PT', 'pt-ST': 'pt_PT',
  'pt-TL': 'pt_PT', 'pt-MO': 'pt_PT', 'pt-GQ': 'pt_PT', 'pt-LU': 'pt_PT', 'pt-CH': 'pt_PT',
  'zh-Hant': 'zh_TW', 'zh-Hant-TW': 'zh_TW', 'zh-Hant-HK': 'zh_TW', 'zh-Hant-MO': 'zh_TW',
  'zh-HK': 'zh_TW', 'zh-MO': 'zh_TW',
  'zh-Hans': 'zh_CN', 'zh-Hans-CN': 'zh_CN', 'zh-Hans-SG': 'zh_CN', 'zh-SG': 'zh_CN',
});

// The player's own choice first -- the Settings cookie; they picked it, and
// nothing should second-guess that. Then `?lang=`, so a link can carry a
// language and any locale can be tried from a browser that will not send it;
// then Accept-Language. `{ cookie: false }` is what Automatic would pick.
// Private-use tags (the joke locales) are offered to the cookie and `?lang=`
// only -- no browser asks for them, and `en` must never match one by prefix.
function negotiateLocale(req, { cookie = true } = {}) {
  const ids = localeIds();
  const chosen = cookie ? parseCookies(req.headers?.cookie)[LOCALE_COOKIE] : '';
  if (chosen && ids.includes(chosen)) return chosen;
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

// A line a proxied bzfs sends is finished English with no msgid. Matched
// against the msgids with `{name}` slots -- the loaded plugins', and those of
// bzo's own that its server sends -- it gets one back, and a bzo client shows
// it in its own language: `Welcome, {player}!` finds `{ player: 'Tim' }` in
// `Welcome, Tim!`. A msgid with no slot needs no match, since the client
// already looks a whole line up; one with fewer than three letters of its own
// would match anything.
const SLOT = /\{([A-Za-z_][A-Za-z0-9_]*)\}/;
const MIN_TEMPLATE_LETTERS = 3;
let pluginMsgids = () => [];
let lineTemplates = { key: null, list: [] };

function usePluginMsgids(lookup) {
  pluginMsgids = lookup;
}

function compileLineTemplate(msgid) {
  const parts = msgid.split(new RegExp(SLOT.source, 'g'));
  if (parts.length < 3) return null;
  const literal = parts.filter((_, i) => i % 2 === 0).join('');
  if ((literal.match(/\p{L}/gu) || []).length < MIN_TEMPLATE_LETTERS) return null;
  const names = parts.filter((_, i) => i % 2 === 1);
  const source = parts.map((part, i) => (i % 2 ? '(.+?)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('');
  return { msgid, names, literal: literal.length, pattern: new RegExp(`^${source}$`, 's') };
}

// bzo's msgids its server sends: those quoted in server.js and server/. The
// rest are the interface's -- `{count} left` would read `Tim (abc) left` as a
// count. Read once; the sources only change with a restart.
let serverSourceStrings = null;
function sentByServer(msgid) {
  if (!serverSourceStrings) {
    const root = path.join(__dirname, '..');
    const files = [path.join(root, 'server.js'),
      ...fs.readdirSync(__dirname).filter((name) => name.endsWith('.cjs')).map((name) => path.join(__dirname, name))];
    serverSourceStrings = new Set();
    for (const file of files) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(/(['"])((?:\\.|(?!\1)[^\\\n])*\{(?:\\.|(?!\1)[^\\\n])*)\1/g)) {
        serverSourceStrings.add(match[2].replace(/\\(.)/g, '$1'));
      }
    }
  }
  return serverSourceStrings.has(msgid);
}

// The plugins' first, so a tie in specificity goes to them; the most literal
// text first, so the most specific template wins.
function serverLineTemplates() {
  const plugin = pluginMsgids();
  const ids = localeIds();
  const catalogs = ids.map((id) => readCatalog(id));
  const key = [plugin, ...ids.map((id) => parsed.get(path.join(L10N_DIR, `bzo_${id}.po`))?.mtimeMs)];
  if (lineTemplates.key && key.length === lineTemplates.key.length
    && key.every((part, i) => part === lineTemplates.key[i])) return lineTemplates.list;
  const msgids = new Set(plugin);
  for (const messages of catalogs) {
    Object.keys(messages || {}).filter(sentByServer).forEach((msgid) => msgids.add(msgid));
  }
  const list = [...msgids].map(compileLineTemplate).filter(Boolean).sort((a, b) => b.literal - a.literal);
  lineTemplates = { key, list };
  return list;
}

function matchServerLine(text) {
  if (typeof text !== 'string') return null;
  for (const { msgid, names, pattern } of serverLineTemplates()) {
    const found = pattern.exec(text);
    if (!found) continue;
    const params = {};
    names.forEach((name, i) => { params[name] ??= found[i + 1]; });
    return { msgid, params };
  }
  return null;
}

// A translated sentence in an HTML page: the sentence escaped, and each
// `{name}` filled with HTML the caller already built and escaped -- a link, a
// `<code>`. `l10n.html(t('Talk on the {link}.'), { link })`: `t` with no
// params hands back the sentence with its placeholders still in it.
function html(template, params) {
  return formatMessage(escapeHtml(template), params);
}

// The msgids a browser script looks up with its own literal `t('...')` calls,
// read out of its source the way xgettext reads them, so the page that loads
// it can embed their translations (`list-page.js`, `list-l10n`).
const QUOTED_T_CALL = /\bt\((['"])((?:\\.|(?!\1)[^\\])*)\1/g;
function scriptMsgids(file) {
  const source = fs.readFileSync(file, 'utf8');
  return [...new Set([...source.matchAll(QUOTED_T_CALL)].map((match) => match[2].replace(/\\(.)/g, '$1')))];
}

// JSON inside a <script> element: nothing in it may close the element.
function inlineJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

module.exports = {
  catalogFor, catalogMessages, translator, hasLocale, negotiateLocale, html, scriptMsgids, inlineJson,
  matchServerLine, usePluginMsgids,
  languageTag, textDirection, usePluginMessages, DEFAULT_LOCALE, LOCALE_COOKIE,
};
