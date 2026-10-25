/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The two countdowns a player starts on their own tank, and what the client
// believes about the pause. Upstream keeps both beside each other in
// playing.cxx -- updatePauseCountdown (:6863) and updateDestructCountdown
// (:6950) -- and they share one rule: a countdown on a tank that is not alive
// is over, because what it was asked for no longer exists.
//
// They differ in who owns the clock. bzo's *server* owns the pause countdown,
// since the server is what decides whether a tank may be hit, so `PauseState`
// is what the client believes about the server's answer and every method here
// is a transition it may make. The destruct countdown has no such stake -- it
// ends in a request the client sends -- so `DestructCountdown` keeps its own
// clock, as upstream's does.
//
// Both live here rather than in client.js so the P key and a menu covering the
// game answer to one set of rules. Two callers each keeping their own rules is
// how the tank came to be left frozen after dying mid-countdown: only one of
// them had a rule for a life ending.

// pausedByUnmap (playing.cxx:124) is the third fact, beside paused and
// counting: whether the pause is one a menu took rather than one the player
// asked for. A menu's pause is the menu's to undo, and the player's own outlives
// the life it was asked in.
export class PauseState {
  constructor() {
    this.paused = false;
    // When the server said the countdown began, in `Date.now()` terms; 0 when
    // no countdown is running.
    this.countdownStart = 0;
    this.byMenu = false;
    // The player's own asking, which a life ending does not cancel: the tank
    // comes back and asks again, and the pause key still cancels it.
    this.wantedNextLife = false;
  }

  // What freezes the tank. The countdown counts as well as the pause itself,
  // because the menu path starts one and the tank has to stop when the menu
  // opens rather than five seconds later.
  isFrozen() {
    return this.paused || this.countdownStart > 0;
  }

  // --- what the server said ------------------------------------------------

  countdownStarted(now) {
    this.countdownStart = now;
  }

  pausedByServer() {
    this.paused = true;
    this.countdownStart = 0;
  }

  unpausedByServer() {
    this.paused = false;
    this.countdownStart = 0;
    this.byMenu = false;
    this.wantedNextLife = false;
  }

  // The countdown ended in anything but a pause: the player asked again, or the
  // tank had driven somewhere it may not pause from. Either way nobody is
  // waiting for a pause any more.
  cancelledByServer() {
    this.countdownStart = 0;
    this.wantedNextLife = false;
  }

  // --- the pause key -------------------------------------------------------

  // cmdPause (clientCommands.cxx:424). One toggle, and the server reads it: it
  // cancels a countdown that has not finished, unpauses one that has, and starts
  // one otherwise. Returns whether the caller should send it.
  //
  // A pause a menu asked for is the menu's to undo, which is why the key does
  // nothing at all while `byMenu` is set -- upstream's `pausedByUnmap` guard.
  pressPauseKey({ observer = false } = {}) {
    if (observer || this.byMenu) return false;
    // Asking again is the player's answer either way, so a countdown they call
    // off is not one to take up again in the next life.
    if (this.isFrozen()) this.wantedNextLife = false;
    return true;
  }

  // --- a menu, or the window ----------------------------------------------

  // The Unmap/Map pair (playing.cxx:1211, :1246). Every menu and the window's
  // own visibility reconcile through this rather than each toggling a pause of
  // its own, so opening a menu, hiding the window and showing it again leaves
  // the tank paused for as long as the menu is still up. Returns whether the
  // caller should send a pause toggle.
  syncMenu({ covered, alive = true, observer = false }) {
    if (covered) {
      if (this.byMenu || this.isFrozen()) return false;
      if (observer || !alive) return false;
      this.byMenu = true;
      return true;
    }
    if (!this.byMenu) return false;
    this.byMenu = false;
    // Nothing to undo if the pause never landed -- a countdown the tank died
    // under, or one the server refused.
    return this.isFrozen();
  }

  // --- a life ending, and the next one beginning --------------------------

  // playing.cxx:6866, and the server's own `respawn`: a pause belongs to the
  // life it was taken in. The server abandons its copy without sending anything,
  // so the client keeps its own honest rather than waiting to be told -- it can
  // see its own tank explode. Without this the tank comes back playing on the
  // server and frozen here, which is issue #48.
  //
  // Returns whether anything was cleared, so the caller knows to clear the
  // countdown's alert with it.
  tankDied() {
    if (!this.isFrozen()) return false;
    // The asking outlives the life, but only the player's own: a menu's pause is
    // taken again below by the menu still being there, and must not be taken
    // again once it is gone.
    this.wantedNextLife = !this.byMenu;
    this.paused = false;
    this.countdownStart = 0;
    this.byMenu = false;
    return true;
  }

  // The new life starts unpaused on both ends -- the server's `respawn` says so
  // -- and then asks again for whatever is still true: a menu still in front of
  // the game, or a countdown the player was in when they died. One or the other
  // and never both, since the second toggle would cancel the first.
  //
  // Returns whether the caller should send a pause toggle.
  respawned({ covered, alive = true, observer = false }) {
    this.paused = false;
    this.countdownStart = 0;
    this.byMenu = false;
    const wanted = this.wantedNextLife;
    this.wantedNextLife = false;
    if (this.syncMenu({ covered, alive, observer })) return true;
    return wanted && alive && !observer;
  }
}

// cmdDestruct (clientCommands.cxx:400) and updateDestructCountdown
// (playing.cxx:6950). Five seconds, called off by asking again, and abandoned
// with the life -- the same rule the pause countdown follows. bzo sends the
// request when the count runs out rather than blowing the tank up where it
// stands, because bzo's server is what decides a tank died.
export class DestructCountdown {
  constructor(durationMs) {
    this.durationMs = durationMs;
    this.start = 0;
  }

  isCounting() {
    return this.start > 0;
  }

  // The destruct key. Returns 'started', 'cancelled', or null when there is no
  // tank to destroy -- an observer has none and a dead one is already gone.
  pressDestructKey(now, { observer = false, alive = true } = {}) {
    if (observer || !alive) return null;
    if (this.start > 0) {
      this.start = 0;
      return 'cancelled';
    }
    this.start = now;
    return 'started';
  }

  // What the alert shows, counting whole seconds down to 1 as upstream's
  // `(int)(destructCountdown + 0.99f)` does.
  secondsLeft(now) {
    if (this.start === 0) return 0;
    return Math.max(1, Math.ceil((this.durationMs - (now - this.start)) / 1000));
  }

  // Every frame: 'fire' when the count has run out and the tank should be asked
  // to destroy itself, 'cleared' when the tank stopped being alive under it, and
  // null while it is still running or when there is none.
  tick(now, { alive = true } = {}) {
    if (this.start === 0) return null;
    if (!alive) {
      this.start = 0;
      return 'cleared';
    }
    if (now - this.start >= this.durationMs) {
      this.start = 0;
      return 'fire';
    }
    return null;
  }
}
