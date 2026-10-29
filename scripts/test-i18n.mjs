#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The catalog reader, locale tags and negotiation (docs/i18n-plan.md), and
// that every shipped catalog parses and names itself.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { formatMessage, languageTag, localized, parsePo, textDirection } from '../public/js/i18n.mjs';

const require = createRequire(import.meta.url);
const l10n = require('../server/l10n.cjs');

const po = parsePo(`
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

# upstream writes entries with no blank line between them
msgid "On"
msgstr "Activado"
msgid "Off"
msgstr "Desactivado"

#, fuzzy
msgid "Close"
msgstr "Cerrar mal"

msgid "Empty"
msgstr ""

msgid "Long "
"line \\"quoted\\""
msgstr "Línea "
"larga"

msgctxt "radar"
msgid "Long"
msgstr "Larga"

#msgid "Commented"
#msgstr "Comentado"
`);
assert.deepEqual(po, {
  On: 'Activado',
  Off: 'Desactivado',
  'Long line "quoted"': 'Línea larga',
  'radar\u0004Long': 'Larga',
});

assert.equal(languageTag('es'), 'es');
assert.equal(languageTag('pt_BR'), 'pt-BR');
assert.equal(languageTag('en_US_l33t'), 'en-US-x-l33t');
assert.equal(languageTag('es_419'), 'es-419');

assert.equal(textDirection('es'), 'ltr');
assert.equal(textDirection('he'), 'rtl');
assert.equal(textDirection('fa_IR'), 'rtl');

assert.equal(formatMessage('Score limit: {n} of {max}', { n: 3 }), 'Score limit: 3 of {max}');
// A nested msgid is looked up; a plain value never is.
assert.equal(
  formatMessage('{flag} is {state} for {player}', { flag: { msgid: 'Guided Missile' }, state: { msgid: 'on' }, player: 'on' },
    (msgid) => ({ 'Guided Missile': 'Misil guiado', on: 'activado' }[msgid] || msgid)),
  'Misil guiado is activado for on',
);
// The server's line: English text for a BZFlag client, msgid and params for
// a bzo one.
assert.deepEqual(localized('{player} joined', { player: 'Tim' }), { text: 'Tim joined', msgid: '{player} joined', params: { player: 'Tim' } });
assert.deepEqual(localized('Map reloaded.'), { text: 'Map reloaded.' });

// Express's own matcher, which `req.acceptsLanguages()` is.
const Negotiator = require('negotiator');
const request = (acceptLanguage, lang) => ({
  query: lang ? { lang } : {},
  acceptsLanguages: (offers) => new Negotiator({ headers: { 'accept-language': acceptLanguage } }).languages(offers)[0] || false,
});
assert.equal(l10n.negotiateLocale(request('es-MX,es;q=0.9')), 'es');
assert.equal(l10n.negotiateLocale(request('sw-KE')), 'en');
assert.equal(l10n.negotiateLocale(request('ja-JP')), 'ja');
for (const [tag, id] of [['zh', 'zh_CN'], ['zh-TW', 'zh_TW'], ['zh-HK', 'zh_TW'], ['zh-Hant-TW', 'zh_TW'], ['zh-Hans-CN', 'zh_CN'], ['zh-SG', 'zh_CN']]) {
  assert.equal(l10n.negotiateLocale(request(tag)), id, `${tag} reads ${id}`);
}
assert.equal(l10n.negotiateLocale(request('cs')), 'cs_CZ', 'a bare language reaches its regional catalog');
assert.equal(l10n.negotiateLocale(request('en-US')), 'en', 'a joke locale is never negotiated');
assert.equal(l10n.negotiateLocale(request('es', 'en_US_l33t')), 'en_US_l33t');
assert.equal(l10n.negotiateLocale(request('es', 'xx')), 'es');
// The Settings cookie outranks `?lang=` and the browser, and is ignored when
// asking what Automatic would pick.
const withCookie = (cookie, acceptLanguage, lang) => ({ ...request(acceptLanguage, lang), headers: { cookie } });
assert.equal(l10n.negotiateLocale(withCookie('a=1; bzo_lang=de', 'es', 'fr')), 'de');
assert.equal(l10n.negotiateLocale(withCookie('bzo_lang=de', 'es'), { cookie: false }), 'es');
assert.equal(l10n.negotiateLocale(withCookie('bzo_lang=xx', 'es')), 'es', 'an unknown cookie is ignored');
assert.equal(l10n.catalogFor('de', 'es').browser, 'es');

for (const { id, name } of l10n.catalogFor('en').locales) {
  if (id !== 'en') assert.notEqual(name, id, `l10n/bzo_${id}.po translates its own id`);
  assert.ok(l10n.hasLocale(id));
}
assert.equal(l10n.catalogFor('es').messages.Settings, 'Ajustes');

// Upstream's catalogs are ASCII-only, and a catalog in a script that is not
// Latin must not carry a Latin-only translation -- transliterated Russian is
// how one would arrive. Code, placeholders, links and abbreviations aside.
for (const locale of ['ru', 'ja', 'ko', 'zh_CN', 'zh_TW', 'th']) {
  for (const domain of ['bzo', 'doc']) {
    for (const [msgid, msgstr] of Object.entries(l10n.catalogMessages(locale, domain))) {
      const words = msgstr.replace(/``[^`]+``|`[^`]+`|\{\w+\}|\]\([^)]*\)|https?:\S+|\b[A-Z0-9]{1,4}\*?\b/g, ' ');
      if (msgstr === msgid || !/[a-z]{3}/i.test(words)) continue;
      assert.ok(/[^ -~\s]/.test(words), `${domain}_${locale}: ${JSON.stringify(msgstr)} is Latin-only`);
    }
  }
}
assert.equal(l10n.inlineJson({ a: '</script>' }), '{"a":"\\u003c/script>"}');

console.log('i18n tests passed');
