/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

import assert from 'node:assert/strict';
import { DestructCountdown, PauseState } from '../public/pause.mjs';

// The server's countdown, arriving as the client sees it: the toggle goes out,
// `pauseCountdown` comes back, and five seconds later `playerPaused` does.
const runCountdown = (state, now = 1000) => {
  state.countdownStarted(now);
  return state;
};

// --- the pause key ---------------------------------------------------------

{
  const state = new PauseState();
  assert.equal(state.isFrozen(), false);
  // cmdPause is one toggle; the server reads it as start, cancel or resume.
  assert.equal(state.pressPauseKey(), true);
  runCountdown(state);
  assert.equal(state.isFrozen(), true, 'a countdown freezes the tank, not just the pause');
  state.pausedByServer();
  assert.equal(state.paused, true);
  assert.equal(state.countdownStart, 0);
  assert.equal(state.pressPauseKey(), true);
  state.unpausedByServer();
  assert.equal(state.isFrozen(), false);
  // An observer has no tank to pause, and the server drops the message.
  assert.equal(state.pressPauseKey({ observer: true }), false);
}

// --- a menu, or the window -------------------------------------------------

{
  const state = new PauseState();
  assert.equal(state.syncMenu({ covered: true }), true, 'a menu in front of the game pauses');
  assert.equal(state.byMenu, true);
  // Hiding the window and showing it again while the menu is up changes nothing:
  // one flag covers both, so the pause holds until the menu itself goes.
  assert.equal(state.syncMenu({ covered: true }), false);
  runCountdown(state);
  state.pausedByServer();
  assert.equal(state.syncMenu({ covered: true }), false);
  // A pause a menu asked for is the menu's to undo (pausedByUnmap).
  assert.equal(state.pressPauseKey(), false, 'the pause key is ignored while the menu holds it');
  assert.equal(state.syncMenu({ covered: false }), true, 'leaving the last menu resumes');
  assert.equal(state.byMenu, false);
  state.unpausedByServer();
  assert.equal(state.isFrozen(), false);
  assert.equal(state.pressPauseKey(), true, 'and the key answers again once it does');
}

{
  // A menu opened over a pause the player took stays out of it: there is nothing
  // to arm, so closing the menu resumes nothing either.
  const state = new PauseState();
  state.pressPauseKey();
  runCountdown(state);
  state.pausedByServer();
  assert.equal(state.syncMenu({ covered: true }), false);
  assert.equal(state.byMenu, false);
  assert.equal(state.syncMenu({ covered: false }), false);
  assert.equal(state.paused, true, 'the player\'s own pause survives a menu visit');
}

{
  // Nothing is armed for a tank that cannot be paused, so nothing is sent for it
  // -- and nothing is left believing a pause is on its way.
  const dead = new PauseState();
  assert.equal(dead.syncMenu({ covered: true, alive: false }), false);
  assert.equal(dead.isFrozen(), false);
  const observer = new PauseState();
  assert.equal(observer.syncMenu({ covered: true, observer: true }), false);
  assert.equal(observer.isFrozen(), false);
}

// --- a life ending, which is issue #48 -------------------------------------

// Both ways in reach the same rule, which is the point of one state machine: a
// tank shot during the countdown is not frozen by a countdown that will never
// end, whoever started it.
for (const started of ['key', 'menu']) {
  const state = new PauseState();
  if (started === 'key') {
    state.pressPauseKey();
  } else {
    assert.equal(state.syncMenu({ covered: true }), true);
  }
  runCountdown(state);
  assert.equal(state.isFrozen(), true);

  assert.equal(state.tankDied(), true, `${started}: the countdown dies with the life`);
  assert.equal(state.isFrozen(), false, `${started}: and the tank is not frozen by it`);
  assert.equal(state.byMenu, false);
  // Nothing to clear twice, and nothing sent for a tank that is already dead.
  assert.equal(state.tankDied(), false);
}

{
  // The asking outlives the life when it was the player's own: the tank comes
  // back and asks again, so P is all it takes to call it off.
  const state = new PauseState();
  state.pressPauseKey();
  runCountdown(state);
  state.tankDied();
  assert.equal(state.wantedNextLife, true);
  assert.equal(state.respawned({ covered: false }), true, 'so the new life asks again');
  assert.equal(state.byMenu, false, 'as the player\'s own pause, not a menu\'s');
  assert.equal(state.wantedNextLife, false, 'and only once');
  runCountdown(state, 2000);
  // Asking again is the player's answer: a countdown they call off is not one to
  // take up in the next life either.
  assert.equal(state.pressPauseKey(), true);
  state.cancelledByServer();
  assert.equal(state.wantedNextLife, false);
  assert.equal(state.isFrozen(), false);
  state.tankDied();
  assert.equal(state.respawned({ covered: false }), false);
}

{
  // A menu's pause is re-taken by the menu still being there...
  const state = new PauseState();
  state.syncMenu({ covered: true });
  runCountdown(state);
  state.tankDied();
  assert.equal(state.wantedNextLife, false, 'the menu did the asking, not the player');
  assert.equal(state.respawned({ covered: true }), true);
  assert.equal(state.byMenu, true, 'so the menu owns the new pause too');
  // ...and only one toggle goes out, since a second would cancel the first.
  assert.equal(state.syncMenu({ covered: true }), false);
}

{
  // ...and is not re-taken once the menu is gone. A player who opened a menu,
  // was killed behind it and closed it before respawning comes back playing.
  const state = new PauseState();
  state.syncMenu({ covered: true });
  runCountdown(state);
  state.tankDied();
  assert.equal(state.syncMenu({ covered: false }), false, 'nothing to undo: the countdown is gone');
  assert.equal(state.respawned({ covered: false }), false);
  assert.equal(state.isFrozen(), false);
}

{
  // A tank that was paused when it died -- genocide and `/kill` both reach a
  // paused tank -- comes back playing on the server, so the client agrees and
  // asks again rather than staying frozen on a pause the server has dropped.
  const state = new PauseState();
  state.pressPauseKey();
  runCountdown(state);
  state.pausedByServer();
  assert.equal(state.tankDied(), true);
  assert.equal(state.paused, false);
  assert.equal(state.respawned({ covered: false }), true);
}

{
  // An observer respawning is nobody's pause, whatever was pending.
  const state = new PauseState();
  state.pressPauseKey();
  runCountdown(state);
  state.tankDied();
  assert.equal(state.respawned({ covered: false, observer: true }), false);
  assert.equal(state.isFrozen(), false);
}

// --- the destruct countdown, issue #50 -------------------------------------

{
  const destruct = new DestructCountdown(5000);
  assert.equal(destruct.isCounting(), false);
  assert.equal(destruct.tick(1000, { alive: true }), null, 'no countdown, nothing to do');

  assert.equal(destruct.pressDestructKey(1000), 'started');
  assert.equal(destruct.isCounting(), true);
  // Whole seconds down to 1, as upstream's `(int)(countdown + 0.99f)` counts.
  assert.equal(destruct.secondsLeft(1000), 5);
  assert.equal(destruct.secondsLeft(1500), 5);
  assert.equal(destruct.secondsLeft(4001), 2);
  assert.equal(destruct.secondsLeft(5999), 1);
  assert.equal(destruct.tick(4000, { alive: true }), null);
  assert.equal(destruct.tick(6000, { alive: true }), 'fire');
  assert.equal(destruct.isCounting(), false, 'and it fires once');
  assert.equal(destruct.tick(7000, { alive: true }), null);
}

{
  // The key again calls it off, and nothing is asked of the server.
  const destruct = new DestructCountdown(5000);
  destruct.pressDestructKey(1000);
  assert.equal(destruct.pressDestructKey(2000), 'cancelled');
  assert.equal(destruct.isCounting(), false);
  assert.equal(destruct.tick(9000, { alive: true }), null);
}

{
  // The same rule the pause countdown follows: a countdown on a tank that is not
  // alive is over -- otherwise a tank shot while counting would ask to destroy
  // the life it came back in.
  const destruct = new DestructCountdown(5000);
  destruct.pressDestructKey(1000);
  assert.equal(destruct.tick(2000, { alive: false }), 'cleared');
  assert.equal(destruct.isCounting(), false);
  assert.equal(destruct.tick(7000, { alive: true }), null);
  // And there is no tank to destroy while dead, or for an observer.
  assert.equal(destruct.pressDestructKey(3000, { alive: false }), null);
  assert.equal(destruct.pressDestructKey(3000, { observer: true }), null);
  assert.equal(destruct.isCounting(), false);
}

console.log('pause tests passed');
