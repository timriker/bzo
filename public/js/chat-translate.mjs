/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Chat in the reader's language, by the browser's own on-device `Translator`
// and `LanguageDetector` (docs/chat-translation-plan.md). Where the browser
// has neither, nothing here does anything and chat shows as written.

// A line this short is left alone: `gg`, `lol` and `nice` are understood
// everywhere, and are exactly where detection guesses.
const MIN_LETTERS = 8;
const MIN_WORDS = 3;
// How sure the detector must be that a line is in a language.
const MIN_CONFIDENCE = 0.7;
// Held out of what is translated and put back after: callsigns, `@names`,
// `/commands`, links and flag abbreviations. A token the translator is
// unlikely to touch stands in for each.
const HOLD = (n) => `⟦${n}⟧`;
const HOLD_PATTERN = /⟦\s*(\d+)\s*⟧/g;

const scope = globalThis;

// Whether this browser can translate chat at all.
export function chatTranslationSupported() {
  return typeof scope.Translator?.create === 'function' && typeof scope.LanguageDetector?.create === 'function';
}

// A tag as the translator wants it: the language alone, `pt-BR` as `pt`.
export function baseLanguage(tag) {
  return String(tag || '').split(/[-_]/)[0].toLowerCase();
}

// `text` with every protected run swapped for a numbered token, and the runs.
// `names` are the callsigns in the game, longest first so one that contains
// another is held whole.
export function holdOut(text, names = [], flags = []) {
  const held = [];
  const hold = (run) => {
    held.push(run);
    return HOLD(held.length - 1);
  };
  let out = String(text);
  out = out.replace(/https?:\/\/\S+/g, hold);
  out = out.replace(/(^|\s)([/@]\S+)/g, (whole, space, run) => `${space}${hold(run)}`);
  for (const name of [...names].filter((n) => n && n.length > 1).sort((a, b) => b.length - a.length)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped})(?![\\p{L}\\p{N}])`, 'gu'), (whole, edge, run) => `${edge}${hold(run)}`);
  }
  if (flags.length) {
    const pattern = new RegExp(`\\b(${flags.map((f) => f.replace(/[^A-Z*]/g, '')).filter(Boolean).join('|')})\\b`, 'g');
    out = out.replace(pattern, hold);
  }
  return { text: out, held };
}

// The held runs put back where their tokens came out of the translator.
export function putBack(text, held) {
  return String(text).replace(HOLD_PATTERN, (whole, n) => held[Number(n)] ?? whole);
}

// Whether a line has enough to it to be worth a guess at its language.
export function worthTranslating(text) {
  const plainText = String(text).replace(HOLD_PATTERN, ' ');
  const letters = (plainText.match(/\p{L}/gu) || []).length;
  const words = plainText.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
  // Scripts written without spaces between words count by letters alone.
  const unspaced = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u.test(plainText);
  return letters >= MIN_LETTERS && (unspaced || words >= MIN_WORDS);
}

let detectorPromise = null;
const translators = new Map();

async function detect(text) {
  detectorPromise ??= scope.LanguageDetector.create();
  const [best] = await (await detectorPromise).detect(text);
  if (!best || best.confidence < MIN_CONFIDENCE || best.detectedLanguage === 'und') return null;
  return baseLanguage(best.detectedLanguage);
}

// A translator from `from` to `to`: one each, made once and kept. `create`
// is only asked for once the pack is on the device, or from a user gesture
// (`downloadTranslator`), as the API requires of a download.
async function translatorFor(from, to) {
  const key = `${from}>${to}`;
  if (!translators.has(key)) translators.set(key, scope.Translator.create({ sourceLanguage: from, targetLanguage: to }));
  try {
    return await translators.get(key);
  } catch (error) {
    translators.delete(key);
    throw error;
  }
}

// What becomes of a line in `to`: `{ text, from }` translated, `{ offer:
// from }` where the pack for its language is still to be downloaded, or null
// for a line left as written -- too short, already in `to`, unknown, or a
// pair the browser cannot do.
export async function translateLine(line, to, { names = [], flags = [] } = {}) {
  if (!chatTranslationSupported()) return null;
  const target = baseLanguage(to);
  const { text, held } = holdOut(line, names, flags);
  if (!worthTranslating(text)) return null;
  try {
    const from = await detect(text);
    if (!from || from === target) return null;
    const key = `${from}>${target}`;
    if (!translators.has(key)) {
      const availability = await scope.Translator.availability({ sourceLanguage: from, targetLanguage: target });
      if (availability === 'unavailable') return null;
      if (availability !== 'available') return { offer: from };
    }
    const translator = await translatorFor(from, target);
    const out = putBack(await translator.translate(text), held);
    return out && out !== line ? { text: out, from } : null;
  } catch {
    return null;
  }
}

// The pack for `from` to `to`, fetched -- from a click, the user gesture a
// download needs. Resolves once it is ready, or rejects.
export async function downloadTranslator(from, to) {
  await translatorFor(baseLanguage(from), baseLanguage(to));
}

// A line the writer sent, in English as well where it is not English and the
// browser already has what it takes: the copy a BZFlag client, which draws
// only ASCII, reads in its place. Null when there is none to send.
export async function englishCopy(line, { names = [], flags = [] } = {}) {
  if (!chatTranslationSupported()) return null;
  const { text, held } = holdOut(line, names, flags);
  if (!worthTranslating(text)) return null;
  try {
    const from = await detect(text);
    if (!from || from === 'en') return null;
    const key = `${from}>en`;
    if (!translators.has(key)
      && await scope.Translator.availability({ sourceLanguage: from, targetLanguage: 'en' }) !== 'available') return null;
    const out = putBack(await (await translatorFor(from, 'en')).translate(text), held);
    return out && out !== line ? out : null;
  } catch {
    return null;
  }
}
