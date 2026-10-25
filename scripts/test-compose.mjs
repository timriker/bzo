/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The compose line: which list a half-typed word is completed from, what an
// ambiguous completion leaves behind, and how the sent lines cycle back.

import assert from 'node:assert/strict';
import {
  ComposeHistory,
  MAX_MESSAGE_HISTORY,
  WORD_KIND,
  completeCompose,
  wordKindsFor,
} from '../public/js/compose.mjs';

const VOCABULARY = {
  [WORD_KIND.COMMAND]: ['/msg', '/mute', '/mutelist', '/kill', '/flag'],
  [WORD_KIND.CALLSIGN]: ['Tim', 'Timber', 'Orin', 'Some One'],
  [WORD_KIND.FLAG]: [
    { word: 'SW', label: 'SW (Shock Wave)' },
    { word: 'SB', label: 'SB (Super Bullet)' },
    { word: 'GM', label: 'GM (Guided Missile)' },
  ],
  [WORD_KIND.SLOT]: [
    { word: '#3', label: '#3 "Tim"' },
    { word: '#4', label: '#4 "Orin"' },
  ],
};

const complete = (head) => completeCompose(head, VOCABULARY);

// Which list a word comes from is read off the shape of the line, so no table
// of commands and their arguments has to be kept in step with the server's.
{
  assert.deepEqual(wordKindsFor('/ms'), [WORD_KIND.COMMAND]);
  assert.deepEqual(wordKindsFor('/msg ti'), [WORD_KIND.CALLSIGN, WORD_KIND.FLAG]);
  assert.deepEqual(wordKindsFor('hi @ti'), [WORD_KIND.CALLSIGN]);
  assert.deepEqual(wordKindsFor('/kill #'), [WORD_KIND.SLOT]);
  assert.deepEqual(wordKindsFor('hello ti'), [WORD_KIND.CALLSIGN], 'chat completes people');
  assert.deepEqual(wordKindsFor('ti'), [WORD_KIND.CALLSIGN], 'including the first word');
}

// One match fills the word in and lists nothing, which is upstream's own answer
// (`first == last`, AutoCompleter.cxx:106).
{
  assert.deepEqual(complete('/ki'), { head: '/kill', matches: [] });
  assert.deepEqual(complete('/msg or'), { head: '/msg Orin', matches: [] });
}

// Several matches fill in as far as they agree and hand back the candidates to
// print. `/mu` reaches `/mute` and `/mutelist` and stops at the shared part.
{
  const ambiguous = complete('/mu');
  assert.equal(ambiguous.head, '/mute');
  assert.deepEqual(ambiguous.matches, ['/mute', '/mutelist']);
}

// Matching ignores case and the word keeps the spelling it was registered
// with -- the reason `@ti` reaches `@Tim` at all.
{
  assert.equal(complete('hi @ti').head, 'hi @Tim', 'one match, mention kept');
  const both = complete('@tim');
  assert.equal(both.head, '@Tim', 'Tim and Timber agree on Tim');
  assert.deepEqual(both.matches, ['Tim', 'Timber']);
}

// A mention is prose, so it is never quoted; the same callsign as a command's
// argument is, because that is the form the command parses.
{
  assert.equal(complete('@some').head, '@Some One');
  assert.equal(complete('/kill some').head, '/kill "Some One"');
  assert.equal(complete('/kill "some').head, '/kill "Some One"', 'an open quote is closed');
}

// A quote is only closed once one word is left: closing it around a prefix
// would end a word still being typed.
{
  const many = completeCompose('/kill "t', {
    [WORD_KIND.CALLSIGN]: ['Two Words', 'Two Other Words'],
  });
  assert.equal(many.head, '/kill "Two ');
  assert.deepEqual(many.matches, ['Two Words', 'Two Other Words']);
}

// A flag completes where a command takes one, and never in ordinary chat --
// "sw" in a sentence is a word, not Shock Wave.
{
  assert.equal(complete('/flag give #3 sw').head, '/flag give #3 SW');
  assert.equal(complete('that sw').head, 'that sw', 'chat has no flags to offer');
  // An argument can be either, so an ambiguous one offers both.
  const flags = complete('/flag give #3 s');
  assert.equal(flags.head, '/flag give #3 S');
  assert.deepEqual(flags.matches, ['Some One', 'SW (Shock Wave)', 'SB (Super Bullet)']);
}

// A slot is listed under the callsign standing in it, since the number alone
// says nothing about who it is.
{
  const slots = complete('/kill #');
  assert.equal(slots.head, '/kill #');
  assert.deepEqual(slots.matches, ['#3 "Tim"', '#4 "Orin"'], 'a bare # asks who is where');
  assert.deepEqual(complete('/kill #3'), { head: '/kill #3', matches: [] });
}

// A word nothing matches is left exactly as typed.
{
  assert.deepEqual(complete('/zz'), { head: '/zz', matches: [] });
  assert.deepEqual(complete('hello '), { head: 'hello ', matches: [] });
}

// History: newest first, and saying the same thing twice moves it to the front
// rather than keeping two copies of it (ComposeDefaultKey.cxx:105).
{
  const history = new ComposeHistory();
  history.remember('one');
  history.remember('two');
  history.remember('one');
  assert.deepEqual(history.lines, ['one', 'two']);
  assert.equal(history.earlier(''), 'one');
  assert.equal(history.earlier(''), 'two');
  assert.equal(history.earlier(''), null, 'the oldest line stays put');
  assert.equal(history.later(), 'one');
  assert.equal(history.later(), '', 'back to what was being typed');
}

// What was already typed is the prefix the recall matches, and it comes back
// when the cycling runs past the newest match.
{
  const history = new ComposeHistory();
  history.remember('/msg Orin hi');
  history.remember('hello all');
  history.remember('/mv 0,0');
  assert.equal(history.earlier('/m'), '/mv 0,0');
  assert.equal(history.earlier('/m'), '/msg Orin hi', 'the chat line in between is skipped');
  assert.equal(history.earlier('/m'), null);
  assert.equal(history.later(), '/mv 0,0');
  assert.equal(history.later(), '/m', 'the typed characters are put back');
  assert.equal(history.index, -1, 'and the recall is over');
}

// The prefix ignores case, as completion does.
{
  const history = new ComposeHistory();
  history.remember('Hello there');
  assert.equal(history.earlier('hel'), 'Hello there');
}

// Sending a line ends any recall in progress, so the next Up starts from the
// newest again (`messageHistoryIndex = 0`, ComposeDefaultKey.cxx:128).
{
  const history = new ComposeHistory();
  history.remember('a');
  history.remember('b');
  history.earlier('');
  history.remember('c');
  assert.equal(history.index, -1);
  assert.equal(history.earlier(''), 'c');
}

// The list is capped, and an empty line is not a line.
{
  const history = new ComposeHistory();
  for (let i = 0; i < MAX_MESSAGE_HISTORY + 5; i += 1) history.remember(`line ${i}`);
  assert.equal(history.lines.length, MAX_MESSAGE_HISTORY);
  assert.equal(history.lines[0], `line ${MAX_MESSAGE_HISTORY + 4}`);
  history.remember('');
  assert.equal(history.lines.length, MAX_MESSAGE_HISTORY);
}

console.log('compose tests passed');
