/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The interface's language: docs/i18n-plan.md. English source strings are the
// msgids, as upstream's are, so a string with no translation reads as the
// English it already is.
//
// Shared: the server parses `l10n/*.po` with `parsePo` and names locales with
// `languageTag`; the browser half below runs only where there is a document.

const UNESCAPES = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };

function unquote(text) {
  const body = text.trim().replace(/^"|"$/g, '');
  return body.replace(/\\(.)/g, (whole, ch) => UNESCAPES[ch] ?? whole);
}

// A gettext catalog as `{ msgid: msgstr }`. Upstream's `data/l10n` files are
// read by the same function, since they are `.po` without a header. Fuzzy and
// untranslated entries are dropped, so they fall back to the msgid, which is
// what gettext does too. A plural entry keeps its first form only; the
// strings avoid plurals (see the plan's "Keys").
export function parsePo(text) {
  const messages = {};
  let entry = null;
  let field = null;
  let fuzzy = false;

  const flush = () => {
    if (entry && entry.msgid && entry.msgstr && !entry.fuzzy) {
      const key = entry.msgctxt ? `${entry.msgctxt}\u0004${entry.msgid}` : entry.msgid;
      messages[key] = entry.msgstr;
    }
    entry = null;
    field = null;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
      fuzzy = false;
      continue;
    }
    if (line.startsWith('#')) {
      if (line.startsWith('#,') && /\bfuzzy\b/.test(line)) fuzzy = true;
      continue;
    }
    if (line.startsWith('"')) {
      if (entry && field) entry[field] += unquote(line);
      continue;
    }
    const match = line.match(/^(msgctxt|msgid_plural|msgid|msgstr(?:\[(\d+)\])?)\s+(".*")$/);
    if (!match) continue;
    const [, keyword, index] = match;
    // A new msgid or msgctxt after a msgstr starts the next entry even where a
    // hand-edited catalog left out the blank line between them.
    if ((keyword === 'msgid' || keyword === 'msgctxt') && entry && (entry.msgstr !== undefined || keyword === 'msgctxt')) {
      flush();
    }
    if (!entry) entry = { fuzzy };
    if (keyword === 'msgstr' || index === '0') field = 'msgstr';
    else if (keyword === 'msgid_plural' || index !== undefined) field = null;
    else field = keyword;
    if (field) entry[field] = unquote(match[3]);
  }
  flush();
  return messages;
}

// gettext names a locale `pt_BR`; HTML and Accept-Language want `pt-BR`.
// Anything past the region is not a BCP 47 subtag, so upstream's joke locales
// become private use: `en_US_l33t` is `en-US-x-l33t`.
export function languageTag(locale) {
  const [language, region, ...rest] = String(locale).split('_');
  const parts = [language];
  if (region && /^[A-Za-z]{2}$|^\d{3}$/.test(region)) parts.push(region);
  else if (region) rest.unshift(region);
  if (rest.length) parts.push('x', ...rest);
  return parts.join('-');
}

// No shipped catalog is right to left; the page says which way it reads anyway,
// so one that arrives needs no code (docs/i18n-plan.md, "Right to Left").
const RTL_LANGUAGES = new Set(['ar', 'dv', 'fa', 'he', 'ps', 'ur', 'yi']);

export function textDirection(locale) {
  return RTL_LANGUAGES.has(String(locale).split('_')[0]) ? 'rtl' : 'ltr';
}

// `{name}` placeholders, filled after the lookup so a translation may put them
// in its own order. An unknown name stays as written.
//
// A value may itself be `{ msgid, params }` -- a flag's name, "on" -- which
// `lookup` translates too; a callsign or a number is a plain value and is
// never looked up.
export function formatMessage(text, params, lookup = (msgid) => msgid) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) => {
    if (!(name in params)) return whole;
    const value = params[name];
    if (value && typeof value === 'object' && typeof value.msgid === 'string') {
      return formatMessage(lookup(value.msgid), value.params, lookup);
    }
    return String(value);
  });
}

// What the server sends a bzo client: the English line, finished, as `text`
// -- which is all a BZFlag client, a log, a replay or the Discord bridge ever
// read -- and beside it the msgid and params a bzo client translates from
// (docs/i18n-plan.md, "Server Text Is a Third Category"). Spread into the
// message: `{ type: 'message', ...localized('{player} joined', { player }) }`.
export function localized(msgid, params) {
  if (!params) return { text: msgid };
  return { text: formatMessage(msgid, params), msgid, params };
}

let messages = {};
let currentLocale = 'en';
let servedLocale = 'en';
let locales = [{ id: 'en', name: 'English' }];
const listeners = new Set();

const STORAGE_KEY = 'locale';
export const AUTOMATIC_LOCALE = 'auto';

export function t(msgid, params) {
  return formatMessage(messages[msgid] || msgid, params, (inner) => messages[inner] || inner);
}

// A line the server sent: its own msgid and params where it has them, else
// its whole text looked up, which is what a fixed sentence needs.
export function translateServerText(message) {
  if (message.msgid) return t(message.msgid, message.params);
  return typeof message.text === 'string' ? t(message.text) : '';
}

// Marks a msgid for extraction where the lookup happens later, as the Settings
// rows' labels are.
export function N_(msgid) {
  return msgid;
}

export function getLocale() {
  return currentLocale;
}

export function getLocales() {
  return locales;
}

export function onLocaleChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// What the player chose in Settings: a locale id, or `auto` to follow what the
// server negotiated from Accept-Language and `?lang=`.
export function getLocalePreference() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored && locales.some((entry) => entry.id === stored) ? stored : AUTOMATIC_LOCALE;
  } catch {
    return AUTOMATIC_LOCALE;
  }
}

export async function setLocalePreference(choice) {
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Private browsing: the choice lasts for this page only.
  }
  await setLocale(choice === AUTOMATIC_LOCALE ? servedLocale : choice);
}

function applyCatalog(catalog) {
  messages = catalog.messages;
  currentLocale = catalog.locale;
  locales = catalog.locales;
  document.documentElement.lang = languageTag(currentLocale);
  document.documentElement.dir = textDirection(currentLocale);
  translateDocument(document);
  for (const listener of listeners) listener(currentLocale);
}

export async function setLocale(locale) {
  if (locale === currentLocale) return;
  const response = await fetch(`/l10n/${encodeURIComponent(locale)}.json`);
  if (!response.ok) throw new Error(`l10n ${locale}: HTTP ${response.status}`);
  applyCatalog(await response.json());
}

// One pass over markup tagged in index.html. The English is the msgid, taken
// from the element the first time and kept in the attribute, so a second pass
// in another language still has it.
//
// Script owns a good deal of tagged text once the page is running -- the mic
// button's state, Apply turning into Restart -- so a later pass rewrites only
// what still says what the last pass wrote. Text script has changed since is
// left for its owner to repaint, in the new language, on `onLocaleChange`.
const ATTRIBUTES = [
  ['data-i18n-title', 'title'],
  ['data-i18n-placeholder', 'placeholder'],
  ['data-i18n-aria-label', 'aria-label'],
];
const written = new WeakMap();

function lastWritten(element) {
  let record = written.get(element);
  if (!record) {
    record = {};
    written.set(element, record);
  }
  return record;
}

export function translateDocument(root) {
  for (const element of root.querySelectorAll('[data-i18n]')) {
    if (!element.dataset.i18n) element.dataset.i18n = element.textContent.trim();
    const record = lastWritten(element);
    if ('text' in record && element.textContent.trim() !== record.text.trim()) continue;
    record.text = t(element.dataset.i18n);
    element.textContent = record.text;
  }
  for (const [marker, attribute] of ATTRIBUTES) {
    for (const element of root.querySelectorAll(`[${marker}]`)) {
      if (!element.getAttribute(marker)) element.setAttribute(marker, element.getAttribute(attribute) || '');
      const record = lastWritten(element);
      if (attribute in record && element.getAttribute(attribute) !== record[attribute]) continue;
      record[attribute] = t(element.getAttribute(marker));
      element.setAttribute(attribute, record[attribute]);
    }
  }
}

// The server inlines the negotiated catalog into the page, so the first frame
// is already in the player's language. A stored choice that differs is
// fetched; the page shows the negotiated language until it arrives.
function initFromPage() {
  const inline = document.getElementById('bzo-l10n');
  if (!inline) return;
  const catalog = JSON.parse(inline.textContent);
  servedLocale = catalog.locale;
  applyCatalog(catalog);
  const preference = getLocalePreference();
  if (preference !== AUTOMATIC_LOCALE && preference !== servedLocale) {
    setLocale(preference).catch((error) => console.warn(error.message));
  }
}

if (typeof document !== 'undefined') initFromPage();
