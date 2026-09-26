/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Hunting: marking players on the scoreboard and then being told when one of
// them is in your sights. `ScoreboardRenderer`'s three-state machine
// (`ScoreboardRenderer.cxx:283`) lives here rather than in client.js, because
// the keys, the scoreboard cursor and Rabbit Chase's own anointing all move the
// same state and two of them had no business knowing how the third works.
//
// The state machine only says what is marked and what the cursor is on. Where
// the mark is drawn -- the scoreboard row, the radar ring, the sky beacon -- and
// when the bearing sounds are client.js's, and the sounds are named back to the
// caller rather than played here, the way `PauseState` reports rather than
// sends.

// Hunt cyan, upstream's own `(0.0, 0.8, 0.9)` for the hunted blip
// (RadarRenderer.cxx:138). One literal, because three surfaces wear it -- the
// radar ring, the scoreboard's bullseye, and the beacon over the rabbit -- and a
// second copy is how they would eventually disagree.
//
// It is the colour of "hunted", not of a player, so it is used exactly where the
// mark sits on something that already carries the player's own colour: a radar
// blip, a scoreboard row. Where the mark stands alone -- a beacon against the
// sky -- the player's colour is what it wears instead, since nothing else there
// says who it is over. See "Three surfaces point at the same things" in
// AGENTS.md.
export const HUNT_MARKER_COLOR = 0x00cce5;

// ScoreboardRenderer.h:47-49.
export const HUNT_STATE = Object.freeze({
  NONE: 0,
  SELECTING: 1,
  ENABLED: 2,
});

// The two samples the state machine asks for, by bzo's own sound names. Upstream
// plays `SFX_HUNT` when hunting begins or ends and `SFX_HUNT_SELECT` for every
// step in between, which is what makes the first target and the last one sound
// different from the ones between them.
const SOUND_HUNT = 'hunt';
const SOUND_HUNT_SELECT = 'huntSelect';

export class HuntState {
  constructor() {
    this.state = HUNT_STATE.NONE;
    // huntAddMode. Set while the cursor is open, and it decides what committing
    // means: replace everything hunted, or add to it and toggle one off.
    this.addMode = false;
    // huntPosition, as an id rather than upstream's index into the sorted
    // roster. bzo's board re-sorts on every kill, so an index would leave the
    // cursor pointing at whoever happened to take that row -- the player picks
    // a player, not a line number. null when there is nobody to point at.
    this.cursorId = null;
    this.hunted = new Set();
  }

  isSelecting() {
    return this.state === HUNT_STATE.SELECTING;
  }

  isHunted(playerId) {
    return this.hunted.has(playerId);
  }

  hasHunted() {
    return this.hunted.size > 0;
  }

  // The row the cursor is on, which is only ever drawn while selecting.
  getCursorId() {
    return this.state === HUNT_STATE.SELECTING ? this.cursorId : null;
  }

  // setHuntState (ScoreboardRenderer.cxx:312). Leaving the cursor drops add
  // mode, leaving hunting altogether drops the marks, and entering the cursor
  // puts it on the first candidate -- upstream's `huntPosition = 0`.
  setState(next, candidates = []) {
    if (this.state === next) return;
    if (next !== HUNT_STATE.SELECTING) this.addMode = false;
    if (next === HUNT_STATE.NONE) this.hunted.clear();
    else if (next === HUNT_STATE.SELECTING) this.cursorId = candidates[0] ?? null;
    this.state = next;
  }

  // huntReset (ScoreboardRenderer.cxx:333) -- joining a server.
  reset() {
    this.state = HUNT_STATE.NONE;
    this.addMode = false;
    this.cursorId = null;
    this.hunted.clear();
  }

  // exitSelectState (ScoreboardRenderer.cxx:215). Backing out of the cursor
  // keeps whatever was already marked and goes quiet if nothing was.
  exitSelect() {
    this.setState(this.hunted.size > 0 ? HUNT_STATE.ENABLED : HUNT_STATE.NONE);
    return SOUND_HUNT_SELECT;
  }

  // huntKeyEvent (ScoreboardRenderer.cxx:283) -- `U` with `isAdd` false, `7`
  // with it true. One key opens the cursor, closes it again, and turns hunting
  // off; which of the three depends on where it already was. Returns the sound
  // to play, or null.
  pressHuntKey(isAdd, candidates = []) {
    if (this.state === HUNT_STATE.ENABLED) {
      // `7` reopens the cursor over what is already marked; `U` clears it.
      this.setState(isAdd ? HUNT_STATE.SELECTING : HUNT_STATE.NONE, candidates);
      this.addMode = isAdd;
      return isAdd ? SOUND_HUNT_SELECT : SOUND_HUNT;
    }
    if (this.state === HUNT_STATE.SELECTING) return this.exitSelect();
    this.setState(HUNT_STATE.SELECTING, candidates);
    this.addMode = isAdd;
    return SOUND_HUNT_SELECT;
  }

  // setHuntNextEvent / setHuntPrevEvent (ScoreboardRenderer.cxx:263-274) and the
  // wrapping the renderer does for them (`:494-520`), which is where upstream
  // skips your own row -- you cannot hunt yourself. Silent: upstream plays
  // nothing for a cursor move, only for what the cursor commits to.
  moveCursor(candidates, direction) {
    if (candidates.length === 0) {
      this.cursorId = null;
      return;
    }
    const at = candidates.indexOf(this.cursorId);
    if (at === -1) {
      this.cursorId = direction < 0 ? candidates[candidates.length - 1] : candidates[0];
      return;
    }
    const step = direction < 0 ? -1 : 1;
    const next = (at + step + candidates.length) % candidates.length;
    this.cursorId = candidates[next];
  }

  // renderScoreboard's own housekeeping for the cursor (ScoreboardRenderer.cxx:
  // 494-520): with nobody left to point at the cursor closes, and a cursor left
  // on somebody who has gone moves to the top of what remains. Silent, because
  // nothing was picked.
  refreshCursor(candidates) {
    if (this.state !== HUNT_STATE.SELECTING) return;
    if (candidates.length === 0) {
      this.setState(HUNT_STATE.NONE);
      return;
    }
    if (!candidates.includes(this.cursorId)) this.cursorId = candidates[0];
  }

  // Marking one player, and what that costs in sound: the first target and the
  // last one to leave sound different from the ones between, which is how you
  // hear hunting start and stop without watching the board.
  //
  // `replace` is what separates `U` from `7` -- the whole set goes and this one
  // takes its place, rather than this one being added to or taken off it.
  //
  // The scoreboard cursor reaches this through `select` below; the Settings row
  // calls it directly, because a row that shows one player at a time is already
  // its own cursor and has no select state to be in. One place decides what a
  // mark costs, so the two surfaces cannot disagree about it.
  toggle(id, { replace = false } = {}) {
    if (id === null || id === undefined) return null;
    if (replace) this.hunted.clear();
    let sound;
    if (this.hunted.has(id)) {
      this.hunted.delete(id);
      sound = this.hunted.size === 0 ? null : SOUND_HUNT_SELECT;
    } else {
      this.hunted.add(id);
      sound = this.hunted.size === 1 ? SOUND_HUNT : SOUND_HUNT_SELECT;
    }
    // Upstream assigns `huntState` here rather than going through
    // `setHuntState`, so add mode survives a commit and the next `7` reopens
    // the cursor on the set that is already there.
    this.state = HUNT_STATE.ENABLED;
    return sound;
  }

  // 'fire' while the cursor is open (ScoreboardRenderer.cxx:522-542).
  select(candidates = []) {
    if (this.state !== HUNT_STATE.SELECTING) return null;
    const id = this.cursorId;
    if (id === null || !candidates.includes(id)) return null;
    return this.toggle(id, { replace: !this.addMode });
  }

  // What `U` does to a hunt that is already running (huntKeyEvent's
  // `HUNT_ENABLED` branch), reachable without the key: every mark goes and
  // hunting is over. The Settings row needs it because a headset and a phone
  // have no `U` to press, and clearing three marks by finding each one again is
  // the one thing the row cannot do in a single step.
  clearAll() {
    if (this.hunted.size === 0) return null;
    this.hunted.clear();
    this.state = HUNT_STATE.NONE;
    this.addMode = false;
    return SOUND_HUNT;
  }

  // Marks on players who have left, and the "last hunted player must have left
  // the game" rule underneath it (ScoreboardRenderer.cxx:581). Upstream reaches
  // it by recounting the hunted rows every time it draws the board; bzo asks it
  // off the roster instead, since the board is not redrawn every frame here.
  // Returns the sound hunting ending owes, or null.
  prune(liveIds) {
    let dropped = false;
    this.hunted.forEach((id) => {
      if (liveIds.has(id)) return;
      this.hunted.delete(id);
      dropped = true;
    });
    if (this.cursorId !== null && !liveIds.has(this.cursorId)) this.cursorId = null;
    if (!dropped || this.state !== HUNT_STATE.ENABLED || this.hunted.size > 0) return null;
    this.state = HUNT_STATE.NONE;
    this.addMode = false;
    return SOUND_HUNT;
  }

  // MsgNewRabbit (playing.cxx:2851). A new rabbit clears every mark and then
  // marks the rabbit, so Rabbit Chase hands the hunt its target rather than
  // asking the player to pick one -- and the rabbit itself is left hunting
  // nobody, since it is what everyone else is hunting. An observer gets the
  // clearing and nothing else: it has no sights to spot anyone down.
  //
  // Silent on purpose. The alert and `hunt_select.wav` the new rabbit hears are
  // the message's, not the hunt's (playing.cxx:2877), and a hunter hearing
  // hunting "begin" every time the rabbit changed would ring on every capture.
  rabbitChanged(rabbitId, { iAmTheRabbit = false, observing = false } = {}) {
    this.hunted.clear();
    if (iAmTheRabbit) {
      this.setState(HUNT_STATE.NONE);
      return;
    }
    if (observing || rabbitId === null || rabbitId === undefined) return;
    this.hunted.add(rabbitId);
    this.setState(HUNT_STATE.ENABLED);
  }
}
