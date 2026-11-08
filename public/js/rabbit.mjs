/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Rabbit Chase's choice of rabbit, for the server and for practice (the
// offline game, `bot-game.mjs`). Who is told, and what a deposed rabbit's team
// becomes, stay with whoever calls.

// PlayerInfo::canBeRabbit (PlayerInfo.cxx:504). A paused or observing player
// cannot hold it, and it wants someone alive -- `relaxing` is the pass that will
// settle for a dead player in the game, which anointRabbit below makes when
// nobody alive qualifies.
//
// A candidate is `{ paused, observer, alive, playing }`. Upstream also refuses a
// `notResponding` player; bzo has no such state, because a client that stops
// answering has a socket that closes and leaves the roster outright.
export function canBeRabbit(candidate, relaxing = false) {
  if (!candidate) return false;
  if (candidate.paused || candidate.observer) return false;
  return relaxing ? Boolean(candidate.playing) : Boolean(candidate.alive);
}

// GameKeeper::Player::anointRabbit (GameKeeper.cxx:145). The best candidate by
// ranking, preferring anyone alive who is not the old rabbit: a "good" rabbit
// beats every not-good one however they rank, and among equals the ranking
// decides. Settling for the old rabbit or for a dead player is the fallback that
// keeps a two-player game moving.
//
// `candidates` is one entry per player, `{ id, paused, observer, alive, playing,
// ranking }`, with the ranking already computed -- upstream swaps the whole
// ranking function out for `-rabbit random` (Score::setRandomRanking) rather
// than branching inside the loop, so the caller owns that choice here too.
// Returns the new rabbit's id, or null if nobody at all may hold it.
export function anointRabbit(candidates, oldRabbitId = null) {
  let chosenId = null;
  let topRanking = -Infinity;
  let goodRabbitChosen = false;

  for (const candidate of candidates) {
    if (!canBeRabbit(candidate, true)) continue;
    const good = candidate.id !== oldRabbitId && Boolean(candidate.alive);
    if (goodRabbitChosen && !good) continue;
    if (good && !goodRabbitChosen) {
      goodRabbitChosen = true;
    } else if (!(candidate.ranking > topRanking)) {
      continue;
    }
    topRanking = candidate.ranking;
    chosenId = candidate.id;
  }

  return chosenId;
}

// The selection half of anointNewRabbit (bzfs.cxx:2737), without the broadcast:
// under `-rabbit killer` whoever just killed the rabbit takes it if they are
// still around and still eligible, and otherwise -- and for the other two styles
// -- anointRabbit picks. Upstream asks the killer for the strict `canBeRabbit()`,
// so a killer who died in the same exchange does not inherit it.
export function pickNewRabbit({ candidates, oldRabbitId = null, killerId = null, selection = 'score' } = {}) {
  if (selection === 'killer' && killerId !== null && killerId !== oldRabbitId) {
    const killer = candidates.find((candidate) => candidate.id === killerId);
    if (killer?.playing && canBeRabbit(killer)) return killerId;
  }
  return anointRabbit(candidates, oldRabbitId);
}
