/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// How long a chat line may be: 127 characters, upstream's `MessageLen` less
// its terminating NUL (`global.h:35`), counted as the eye counts them -- 🂡,
// 👍🏽 and a flag are one each -- so a line in any script holds the same
// number. A character built of many code points could still make a line
// huge, so the bytes are capped as well. The client stops typing at it and
// the server cuts at it, so a modified client gains nothing. A BZFlag client
// is sent its own ASCII and its own byte limit (`toBzfsChatText`).

export const CHAT_TEXT_CHARS = 127;
export const CHAT_TEXT_BYTES = 1024;

const encoder = new globalThis.TextEncoder();
const segmenter = globalThis.Intl?.Segmenter
  ? new globalThis.Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

function characters(text) {
  return segmenter
    ? Array.from(segmenter.segment(text), (part) => part.segment)
    : Array.from(text);
}

// `text` cut to `maxChars` characters and `maxBytes` of UTF-8, between
// characters.
export function clipChatText(text, maxChars = CHAT_TEXT_CHARS, maxBytes = CHAT_TEXT_BYTES) {
  const source = String(text ?? '');
  if (source.length <= maxChars) return source;
  let bytes = 0;
  let count = 0;
  let out = '';
  for (const char of characters(source)) {
    const size = encoder.encode(char).length;
    if (count >= maxChars || bytes + size > maxBytes) break;
    bytes += size;
    count += 1;
    out += char;
  }
  return out;
}
