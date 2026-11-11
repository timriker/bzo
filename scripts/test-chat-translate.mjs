#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Chat translation (`public/js/chat-translate.mjs`, docs/chat-translation-plan.md)
// against a stand-in for the browser's `Translator` and `LanguageDetector`:
// what is held out, what is too short, what waits on a download, and the
// English copy a writer sends for BZFlag clients.

import assert from 'node:assert/strict';
import {
  baseLanguage, chatTranslationSupported, englishCopy, holdOut, putBack, translateLine, worthTranslating,
} from '../public/js/chat-translate.mjs';

assert.equal(chatTranslationSupported(), false, 'no API, nothing to do');
assert.equal(await translateLine('hola a todos mis amigos', 'en'), null);

assert.equal(baseLanguage('pt-BR'), 'pt');
assert.equal(baseLanguage('en_US'), 'en');

// Held out: links, /commands, @names, callsigns and flag abbreviations.
{
  const { text, held } = holdOut('Tim Riker tiene GM, mira https://x.y/z y usa /flag show @ann', ['Tim Riker'], ['GM', 'SW']);
  assert.ok(!text.includes('Tim Riker') && !text.includes('GM') && !text.includes('https') && !text.includes('/flag'));
  assert.equal(held.length, 5);
  assert.equal(putBack(text, held), 'Tim Riker tiene GM, mira https://x.y/z y usa /flag show @ann');
  // A token the translator spaced out still comes back.
  assert.equal(putBack('⟦ 0 ⟧ has GM', ['Tim Riker']), 'Tim Riker has GM');
}

assert.equal(worthTranslating('gg'), false);
assert.equal(worthTranslating('lol nice one'), true);
assert.equal(worthTranslating('nice'), false);
assert.equal(worthTranslating('你好你好，大家好啊'), true, 'unspaced scripts by letters');

// The browser's APIs, stood in for: Spanish and Russian detected by a word,
// a Spanish-to-English pack on the device and the Russian one still to fetch.
const downloaded = new Set(['es>en']);
globalThis.LanguageDetector = {
  create: async () => ({
    detect: async (text) => [/hola|amigos/.test(text) ? { detectedLanguage: 'es', confidence: 0.95 }
      : /привет/.test(text) ? { detectedLanguage: 'ru', confidence: 0.9 }
        : { detectedLanguage: 'en', confidence: 0.9 }],
  }),
};
globalThis.Translator = {
  availability: async ({ sourceLanguage, targetLanguage }) => (downloaded.has(`${sourceLanguage}>${targetLanguage}`)
    ? 'available' : 'downloadable'),
  create: async ({ sourceLanguage, targetLanguage }) => {
    downloaded.add(`${sourceLanguage}>${targetLanguage}`);
    return { translate: async (text) => `[${targetLanguage}] ${text.replace('hola', 'hello')}` };
  },
};
assert.equal(chatTranslationSupported(), true);

{
  const out = await translateLine('hola Tim Riker, mis amigos', 'en-US', { names: ['Tim Riker'] });
  assert.equal(out.from, 'es');
  assert.equal(out.text, '[en] hello Tim Riker, mis amigos', 'translated, the callsign as written');
  assert.equal(await translateLine('this is already english', 'en'), null, 'nothing in the reader\'s language');
  assert.equal(await translateLine('hola', 'en'), null, 'nothing too short');
  assert.deepEqual(await translateLine('привет всем моим друзьям', 'en'), { offer: 'ru' }, 'a pack to download first');
}

// The writer's English copy: made where the pack is here, never fetched for it.
{
  assert.equal(await englishCopy('hola a todos mis amigos'), '[en] hello a todos mis amigos');
  downloaded.delete('ru>en');
  assert.equal(await englishCopy('привет всем моим друзьям'), null, 'no download while sending');
  assert.equal(await englishCopy('hello there everyone'), null, 'none for English');
}

console.log('chat translation tests passed');
