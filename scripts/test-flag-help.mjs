/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The flag help clock and the wrap both renderers share. HUDRenderer keeps one
// piece of text with one clock and draws it on the one surface it has; bzo has
// two, a DOM element and a canvas panel in a headset, and they read the same
// state so they cannot disagree about what is showing.

import assert from 'node:assert/strict';
import {
  FLAG_HELP_SECONDS,
  getActiveFlagHelp,
  setFlagHelp,
  updateFlagHelpHud,
  wrapText,
} from '../public/js/hud.js';
import { FLAG_TYPES } from '../public/js/flags.mjs';

// FlagHelpDuration (playing.cxx:98, callbacks.cxx:43). A minute, not the few
// seconds the flag name alert beside it gets: this is a sentence to read, and
// the flag is usually still in your hands when it goes.
assert.equal(FLAG_HELP_SECONDS, 60);

// Every flag the table carries says what it does. The HUD help and the help
// menu are both generated from this field, so a flag added without one shows a
// blank line in one place and nothing in the other.
for (const [abbreviation, type] of Object.entries(FLAG_TYPES)) {
  assert.ok(type.help && type.help.trim().length > 0, `${abbreviation} has help text`);
}

// The XR panel paints into a fixed canvas, five lines of 26px sans-serif on a
// 1024-wide canvas with a 32px margin each side. A sans-serif character averages
// well under 0.6em, so 960 / (0.6 * 26) is a floor of 61 characters a line and
// 305 for the panel. A help string longer than that could reach the last line
// and be cut, which is a thing to notice when the string is written rather than
// in a headset.
const XR_FLAG_HELP_CHARACTER_BUDGET = 305;
for (const [abbreviation, type] of Object.entries(FLAG_TYPES)) {
  assert.ok(
    type.help.length <= XR_FLAG_HELP_CHARACTER_BUDGET,
    `${abbreviation} help fits the XR panel (${type.help.length} characters)`,
  );
}

// The clock. Setting help makes it active, and it clears itself once its time
// is up rather than waiting to be cleared.
{
  setFlagHelp('Tank can jump.', 60);
  assert.equal(getActiveFlagHelp(), 'Tank can jump.');
  assert.equal(getActiveFlagHelp(performance.now() + 59_000), 'Tank can jump.');
  assert.equal(getActiveFlagHelp(performance.now() + 61_000), '', 'the clock runs out');
  assert.equal(getActiveFlagHelp(), '', 'and stays out');

  // Carrying nothing clears it, which upstream gets out of Flags::Null having
  // no help string of its own (playing.cxx:1459 calls setFlagHelp either way).
  setFlagHelp('Tank can jump.', 60);
  setFlagHelp('');
  assert.equal(getActiveFlagHelp(), '');
}

// updateFlagHelpHud against a stub DOM. The element is written when the text
// changes and left alone otherwise: this is up for a minute at a time, and the
// frame loop calls it every frame of that minute.
{
  const flagHelp = { textContent: '' };
  globalThis.document = { getElementById: (id) => (id === 'flagHelp' ? flagHelp : null) };

  setFlagHelp('Tank can jump.  Use Tab key.', 60);
  updateFlagHelpHud();
  assert.equal(flagHelp.textContent, 'Tank can jump.  Use Tab key.');

  flagHelp.textContent = 'touched';
  updateFlagHelpHud();
  assert.equal(flagHelp.textContent, 'touched', 'unchanged help does not write the element');

  setFlagHelp('');
  updateFlagHelpHud();
  assert.equal(flagHelp.textContent, '', 'and dropping the flag empties it');

  delete globalThis.document;
}

// wrapText, which is what makeHelpString does (HUDRenderer.cxx:581) measured
// against a canvas instead of a font manager.
{
  // One unit of width per character, so the widths below are countable.
  const context = { measureText: (text) => ({ width: text.length }) };

  assert.deepEqual(wrapText(context, '', 10), [], 'nothing wraps to no lines');
  assert.deepEqual(wrapText(context, '   ', 10), [], 'and so does whitespace');
  assert.deepEqual(wrapText(context, 'one two', 100), ['one two'], 'text that fits is one line');
  assert.deepEqual(wrapText(context, 'one two three', 7), ['one two', 'three']);
  // The double spaces upstream puts between sentences collapse, exactly as they
  // do in makeHelpString, which skips a space that follows a space.
  assert.deepEqual(wrapText(context, 'one.  two', 100), ['one. two']);
  // A word wider than the line keeps its own line rather than being cut.
  assert.deepEqual(wrapText(context, 'a supercalifragilistic b', 5), ['a', 'supercalifragilistic', 'b']);
  // Thai and Japanese write no spaces, and still break between words, never
  // inside one.
  for (const text of ['ภาษาไทยไม่มีการเว้นวรรคระหว่างคำ', '日本語の文章はスペースなしで書かれます。']) {
    const lines = wrapText(context, text, 8);
    assert.ok(lines.length > 1, `${text} wraps`);
    assert.equal(lines.join(''), text, 'nothing is lost or added at a break');
  }
}

console.log('flag help tests passed');
