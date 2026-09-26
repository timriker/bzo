/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The hunt's three-state machine (ScoreboardRenderer.cxx:283). Three surfaces
// move it -- the two keys, the scoreboard cursor, and Rabbit Chase's anointing
// -- and every one of them is a sequence rather than a single call, which is
// what these hold: which sound each step owes, and what is marked afterwards.

import assert from 'node:assert/strict';
import { HUNT_STATE, HuntState } from '../public/hunt.mjs';

const CANDIDATES = ['a', 'b', 'c'];
const marked = (hunt) => [...hunt.hunted].sort();

// huntKeyEvent from a standing start: `U` opens the cursor on the first
// candidate, and `U` again backs out of it with nothing marked.
{
  const hunt = new HuntState();
  assert.equal(hunt.pressHuntKey(false, CANDIDATES), 'huntSelect');
  assert.equal(hunt.state, HUNT_STATE.SELECTING);
  assert.equal(hunt.getCursorId(), 'a', 'the cursor opens on the first row');
  assert.equal(hunt.addMode, false);

  assert.equal(hunt.pressHuntKey(false, CANDIDATES), 'huntSelect', 'exitSelectState');
  assert.equal(hunt.state, HUNT_STATE.NONE, 'nothing was marked, so hunting is off');
  assert.equal(hunt.getCursorId(), null, 'the cursor is only drawn while selecting');
}

// The first target sounds `hunt` and the ones after it sound `huntSelect`, which
// is how hunting starting is heard apart from hunting growing.
{
  const hunt = new HuntState();
  hunt.pressHuntKey(true, CANDIDATES);
  assert.equal(hunt.addMode, true, '7 commits by adding');
  assert.equal(hunt.select(CANDIDATES), 'hunt', 'the first target starts the hunt');
  assert.equal(hunt.state, HUNT_STATE.ENABLED);
  assert.deepEqual(marked(hunt), ['a']);

  // Add mode survives a commit, so `7` reopens the cursor over what is there.
  assert.equal(hunt.pressHuntKey(true, CANDIDATES), 'huntSelect');
  hunt.moveCursor(CANDIDATES, 1);
  assert.equal(hunt.getCursorId(), 'b');
  assert.equal(hunt.select(CANDIDATES), 'huntSelect', 'a second target only adds');
  assert.deepEqual(marked(hunt), ['a', 'b']);
}

// In add mode, committing on a row that is already marked takes it off again.
{
  const hunt = new HuntState();
  hunt.pressHuntKey(true, CANDIDATES);
  hunt.select(CANDIDATES);
  hunt.pressHuntKey(true, CANDIDATES);
  hunt.moveCursor(CANDIDATES, 1);
  hunt.select(CANDIDATES);
  assert.deepEqual(marked(hunt), ['a', 'b']);

  hunt.pressHuntKey(true, CANDIDATES);
  hunt.moveCursor(CANDIDATES, 1);
  assert.equal(hunt.getCursorId(), 'b');
  assert.equal(hunt.select(CANDIDATES), 'huntSelect', 'one target is left');
  assert.deepEqual(marked(hunt), ['a']);

  hunt.pressHuntKey(true, CANDIDATES);
  assert.equal(hunt.getCursorId(), 'a');
  assert.equal(hunt.select(CANDIDATES), null, 'the last one off says nothing here');
  assert.deepEqual(marked(hunt), []);
}

// Outside add mode a commit replaces the whole set, which is what `U` is for.
{
  const hunt = new HuntState();
  hunt.pressHuntKey(true, CANDIDATES);
  hunt.select(CANDIDATES);
  hunt.pressHuntKey(true, CANDIDATES);
  hunt.moveCursor(CANDIDATES, 1);
  hunt.select(CANDIDATES);
  assert.deepEqual(marked(hunt), ['a', 'b']);

  hunt.pressHuntKey(false, CANDIDATES);
  assert.equal(hunt.state, HUNT_STATE.NONE, 'U on a running hunt turns it off');
  assert.deepEqual(marked(hunt), [], 'and clears every mark');
}

// `U` from a running hunt sounds `hunt`, the same as starting one: hunting
// beginning and hunting ending are the same event heard twice.
{
  const hunt = new HuntState();
  hunt.pressHuntKey(false, CANDIDATES);
  hunt.select(CANDIDATES);
  assert.equal(hunt.state, HUNT_STATE.ENABLED);
  assert.equal(hunt.pressHuntKey(false, CANDIDATES), 'hunt');
  assert.equal(hunt.state, HUNT_STATE.NONE);
}

// The cursor wraps both ways and is silent, since upstream plays nothing for a
// move -- only for what the move commits to.
{
  const hunt = new HuntState();
  hunt.pressHuntKey(false, CANDIDATES);
  assert.equal(hunt.moveCursor(CANDIDATES, -1), undefined, 'a move returns no sound');
  assert.equal(hunt.getCursorId(), 'c', 'up from the first row wraps to the last');
  hunt.moveCursor(CANDIDATES, 1);
  assert.equal(hunt.getCursorId(), 'a', 'down from the last wraps to the first');
}

// A cursor pointing at somebody who has left lands back on an end of the list
// rather than nowhere.
{
  const hunt = new HuntState();
  hunt.pressHuntKey(false, CANDIDATES);
  hunt.cursorId = 'gone';
  hunt.moveCursor(CANDIDATES, 1);
  assert.equal(hunt.getCursorId(), 'a');
  hunt.cursorId = 'gone';
  hunt.moveCursor(CANDIDATES, -1);
  assert.equal(hunt.getCursorId(), 'c');
}

// With nobody to hunt there is nothing to point at, and a commit marks nothing.
{
  const hunt = new HuntState();
  hunt.pressHuntKey(false, []);
  assert.equal(hunt.getCursorId(), null);
  assert.equal(hunt.select([]), null);
  assert.deepEqual(marked(hunt), []);
}

// "last hunted player must have left the game" (ScoreboardRenderer.cxx:581).
{
  const hunt = new HuntState();
  hunt.pressHuntKey(true, CANDIDATES);
  hunt.select(CANDIDATES);
  hunt.pressHuntKey(true, CANDIDATES);
  hunt.moveCursor(CANDIDATES, 1);
  hunt.select(CANDIDATES);
  assert.deepEqual(marked(hunt), ['a', 'b']);

  assert.equal(hunt.prune(new Set(['a', 'c'])), null, 'one left, one still hunted');
  assert.deepEqual(marked(hunt), ['a']);
  assert.equal(hunt.state, HUNT_STATE.ENABLED);

  assert.equal(hunt.prune(new Set(['c'])), 'hunt', 'the last one leaving ends the hunt');
  assert.equal(hunt.state, HUNT_STATE.NONE);
  assert.equal(hunt.addMode, false);

  assert.equal(hunt.prune(new Set(['c'])), null, 'and it only ends once');
}

// A roster that never changes leaves the hunt exactly as it was.
{
  const hunt = new HuntState();
  hunt.pressHuntKey(false, CANDIDATES);
  hunt.select(CANDIDATES);
  assert.equal(hunt.prune(new Set(CANDIDATES)), null);
  assert.deepEqual(marked(hunt), ['a']);
  assert.equal(hunt.state, HUNT_STATE.ENABLED);
}

// A cursor left pointing at somebody who has gone moves to the top of what
// remains, and one with nobody left to point at closes -- silently, because
// nothing was picked (ScoreboardRenderer.cxx:494).
{
  const hunt = new HuntState();
  hunt.pressHuntKey(false, CANDIDATES);
  hunt.moveCursor(CANDIDATES, 1);
  assert.equal(hunt.getCursorId(), 'b');

  hunt.prune(new Set(['a', 'c']));
  hunt.refreshCursor(['a', 'c']);
  assert.equal(hunt.getCursorId(), 'a');
  assert.equal(hunt.state, HUNT_STATE.SELECTING);

  hunt.refreshCursor([]);
  assert.equal(hunt.state, HUNT_STATE.NONE, 'nobody left to point at');
  assert.equal(hunt.getCursorId(), null);
}

// refreshCursor is only ever the cursor's business: a running hunt keeps its
// marks however the roster moves under it.
{
  const hunt = new HuntState();
  hunt.pressHuntKey(false, CANDIDATES);
  hunt.select(CANDIDATES);
  hunt.refreshCursor([]);
  assert.equal(hunt.state, HUNT_STATE.ENABLED);
  assert.deepEqual(marked(hunt), ['a']);
}

// `toggle` is what both surfaces mark through, so the sounds are the same
// whether a mark came from the scoreboard cursor or the Settings row.
{
  const hunt = new HuntState();
  assert.equal(hunt.toggle('a'), 'hunt', 'the first target starts the hunt');
  assert.equal(hunt.state, HUNT_STATE.ENABLED);
  assert.equal(hunt.toggle('b'), 'huntSelect', 'a second only adds');
  assert.deepEqual(marked(hunt), ['a', 'b']);
  assert.equal(hunt.toggle('b'), 'huntSelect', 'taking one off with others left');
  assert.deepEqual(marked(hunt), ['a']);
  assert.equal(hunt.toggle('a'), null, 'the last one off says nothing');
  assert.deepEqual(marked(hunt), []);
  assert.equal(hunt.toggle(null), null, 'nothing to toggle');
}

// `replace` is what separates `U` from `7`: the set goes and this one takes its
// place, and a row that was already marked stays marked rather than toggling
// off -- it is the only thing left.
{
  const hunt = new HuntState();
  hunt.toggle('a');
  hunt.toggle('b');
  assert.equal(hunt.toggle('c', { replace: true }), 'hunt', 'a fresh set of one');
  assert.deepEqual(marked(hunt), ['c']);
  hunt.toggle('a');
  assert.equal(hunt.toggle('a', { replace: true }), 'hunt');
  assert.deepEqual(marked(hunt), ['a'], 'replacing with a marked row keeps it');
}

// The Settings row's Clear entry, and `U` on a running hunt: everything goes at
// once, and it only sounds when there was something to clear.
{
  const hunt = new HuntState();
  assert.equal(hunt.clearAll(), null, 'nothing marked, nothing to say');
  hunt.toggle('a');
  hunt.toggle('b');
  assert.equal(hunt.clearAll(), 'hunt');
  assert.deepEqual(marked(hunt), []);
  assert.equal(hunt.state, HUNT_STATE.NONE);
  assert.equal(hunt.addMode, false);
  assert.equal(hunt.clearAll(), null, 'and only once');
}

// MsgNewRabbit (playing.cxx:2851): every mark is cleared and the new rabbit
// takes one, so Rabbit Chase hands the hunt its target.
{
  const hunt = new HuntState();
  hunt.pressHuntKey(false, CANDIDATES);
  hunt.select(CANDIDATES);
  assert.deepEqual(marked(hunt), ['a']);

  hunt.rabbitChanged('c');
  assert.deepEqual(marked(hunt), ['c'], 'the old mark goes, the rabbit gets one');
  assert.equal(hunt.state, HUNT_STATE.ENABLED);

  // The rabbit hunts nobody: it is what everybody else is hunting.
  hunt.rabbitChanged('me', { iAmTheRabbit: true });
  assert.deepEqual(marked(hunt), []);
  assert.equal(hunt.state, HUNT_STATE.NONE);

  // An observer gets the clearing and nothing else.
  hunt.rabbitChanged('c', { observing: true });
  assert.deepEqual(marked(hunt), []);
  assert.equal(hunt.state, HUNT_STATE.NONE);
}

// huntReset (ScoreboardRenderer.cxx:333) -- joining a server keeps nothing.
{
  const hunt = new HuntState();
  hunt.pressHuntKey(true, CANDIDATES);
  hunt.select(CANDIDATES);
  hunt.reset();
  assert.equal(hunt.state, HUNT_STATE.NONE);
  assert.equal(hunt.addMode, false);
  assert.equal(hunt.getCursorId(), null);
  assert.deepEqual(marked(hunt), []);
  assert.equal(hunt.hasHunted(), false);
}

console.log('hunt tests passed');
