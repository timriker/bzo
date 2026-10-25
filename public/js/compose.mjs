/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The compose line: what has been typed into chat before, and what the word
// under the caret could become. Upstream keeps both in `ComposeDefaultKey`
// (`ComposeDefaultKey.cxx`) and `AutoCompleter` (`AutoCompleter.cxx`); they live
// here rather than in client.js because neither needs the DOM, and both are the
// kind of rule worth a test rather than a play session.
//
// client.js owns the input element and the vocabulary -- who is on the server,
// which commands this server answers -- and this module owns what happens to a
// string.

// MAX_MESSAGE_HISTORY (ComposeDefaultKey.cxx:27).
export const MAX_MESSAGE_HISTORY = 20;

// Which list a word may be completed from. `SLOT` is a player's id rather than
// their name, the `#3` form every command that names a player also takes.
export const WORD_KIND = Object.freeze({
  COMMAND: 'command',
  CALLSIGN: 'callsign',
  FLAG: 'flag',
  SLOT: 'slot',
});

// A word that has been typed before it: `@` marks a mention, `"` opens a
// callsign with spaces in it, and both are stripped before matching and put
// back afterwards. `#` is not here because a slot's word *is* `#3` -- the mark
// is part of what gets completed.
const MENTION = '@';
const QUOTE = '"';

// Upstream matches case exactly, because its word list is sorted and it walks
// it with `lower_bound`. bzo matches either case, in both halves of this file:
// a callsign is capitalised however its owner felt that day, and `@ti` should
// still reach `@Tim`.
function startsWithFold(text, prefix) {
  return text.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

// The word the caret is in, and everything before it. Upstream cuts at the last
// space (`AutoCompleter.cxx:83`), so a callsign with a space in it only
// completes up to its own space -- which is why the completed form is quoted
// rather than the typed one.
function splitLastWord(head) {
  const at = Math.max(head.lastIndexOf(' '), head.lastIndexOf('\t'));
  return { before: head.slice(0, at + 1), word: head.slice(at + 1) };
}

// Which lists the word may come from. The shape of what has been typed decides
// it, not a table of commands and their arguments: a table would be a second
// copy of the server's own, kept in the client, drifting.
//
// - `@ti` is a mention, and mentions are people.
// - `#3` is a slot, and slots are people too, by their id.
// - a first word beginning with `/` is a command.
// - any later word on a `/` line is an argument, and every bzo command that
//   takes one takes a player or a flag (`/msg <nick>`, `/kill <#slot|
//   PlayerName>`, `/flag give ... <FlagAbbr>`).
// - anything else is ordinary chat, where only a callsign is worth completing.
export function wordKindsFor(head) {
  const { before, word } = splitLastWord(head);
  if (word.startsWith(MENTION) || word.startsWith(QUOTE)) return [WORD_KIND.CALLSIGN];
  if (word.startsWith('#')) return [WORD_KIND.SLOT];
  if (before.length === 0) {
    return word.startsWith('/') ? [WORD_KIND.COMMAND] : [WORD_KIND.CALLSIGN];
  }
  if (head.startsWith('/')) return [WORD_KIND.CALLSIGN, WORD_KIND.FLAG];
  return [WORD_KIND.CALLSIGN];
}

// A vocabulary entry is the word itself and, where the word alone does not say
// what it is, a label to list it under: `#3` means nothing without the callsign
// beside it, and `SW` little without `Shock Wave`.
function normalizeEntry(entry) {
  return typeof entry === 'string' ? { word: entry, label: entry } : {
    word: entry.word,
    label: entry.label || entry.word,
  };
}

// The longest prefix every match shares, spelled the way the first match spells
// it -- so completing `sh` against `Shock` gives `Shock`, not `shock`.
function commonPrefix(words) {
  let length = Math.min(...words.map((word) => word.length));
  for (let i = 0; i < length; i += 1) {
    const ch = words[0][i].toLowerCase();
    if (words.some((word) => word[i].toLowerCase() !== ch)) {
      length = i;
      break;
    }
  }
  return words[0].slice(0, length);
}

// Complete the word the caret is in.
//
// `head` is the line up to the caret and `vocabulary` is `{ command, callsign,
// flag, slot }`, each an array of words or `{ word, label }`. Returns the new
// `head` and, when more than one word matched, the labels to list -- which is
// upstream's own answer to an ambiguous completion: fill in as far as they
// agree and print the candidates (`ComposeDefaultKey.cxx:67`).
export function completeCompose(head, vocabulary) {
  const { before, word } = splitLastWord(head);
  const mark = word.startsWith(MENTION) || word.startsWith(QUOTE) ? word[0] : '';
  const typed = mark === '' ? word : word.slice(1);
  if (typed.length === 0) return { head, matches: [] };

  const entries = wordKindsFor(head)
    .flatMap((kind) => (vocabulary[kind] || []).map(normalizeEntry))
    .filter((entry) => startsWithFold(entry.word, typed));
  if (entries.length === 0) return { head, matches: [] };

  const single = entries.length === 1;
  const completed = single
    ? entries[0].word
    : commonPrefix(entries.map((entry) => entry.word));

  // Upstream quotes a completed word with a space in it unless it is the first
  // word on the line (`noQuotes`, AutoCompleter.cxx:135), because that is the
  // form a command's argument parser takes -- and only when one word matched,
  // since a closing quote after a prefix would end a word still being typed. A
  // quote already typed is honoured the same way, so opening one and completing
  // closes it. A mention is prose rather than an argument and is never quoted,
  // so `@Some One` reads as it was meant to.
  const quoted = single && mark !== MENTION && before.length > 0
    && (/\s/.test(completed) || mark === QUOTE);
  const text = quoted ? `${QUOTE}${completed}${QUOTE}` : `${mark}${completed}`;
  return {
    head: before + text,
    matches: single ? [] : entries.map((entry) => entry.label),
  };
}

// The lines this client has sent, newest first.
//
// Upstream cycles them with Up and Down and resets to the newest on send
// (`ComposeDefaultKey.cxx:139`). bzo adds the issue's own ask: the characters
// already typed when the cycling starts are kept as a prefix, and only lines
// that start with them are offered -- so `/m` then Up reaches the last `/msg`
// rather than the last thing said. Down past the newest match puts the typed
// characters back, which upstream has no equivalent of because upstream clears
// the line instead.
export class ComposeHistory {
  constructor(max = MAX_MESSAGE_HISTORY) {
    this.max = max;
    this.lines = [];
    // -1 while nothing is being recalled; the index into `lines` otherwise.
    this.index = -1;
    this.stem = '';
  }

  // Upstream moves a line already in the list to the front rather than keeping
  // a second copy of it (ComposeDefaultKey.cxx:105), so saying the same thing
  // twice does not cost two slots.
  remember(text) {
    if (text.length === 0) return;
    const at = this.lines.indexOf(text);
    if (at !== -1) this.lines.splice(at, 1);
    this.lines.unshift(text);
    if (this.lines.length > this.max) this.lines.length = this.max;
    this.reset();
  }

  reset() {
    this.index = -1;
    this.stem = '';
  }

  matchesStem(line) {
    return startsWithFold(line, this.stem);
  }

  // The next older line that still starts with what was typed, or null when
  // there is none -- and a null leaves the line alone rather than clearing it.
  earlier(current) {
    if (this.index === -1) this.stem = current;
    for (let i = this.index + 1; i < this.lines.length; i += 1) {
      if (this.matchesStem(this.lines[i])) {
        this.index = i;
        return this.lines[i];
      }
    }
    return null;
  }

  // The next newer match, or what was being typed when the recall started.
  later() {
    if (this.index === -1) return null;
    for (let i = this.index - 1; i >= 0; i -= 1) {
      if (this.matchesStem(this.lines[i])) {
        this.index = i;
        return this.lines[i];
      }
    }
    const { stem } = this;
    this.reset();
    return stem;
  }
}
