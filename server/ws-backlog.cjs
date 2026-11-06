/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// What a browser's WebSocket has queued and not yet read (`bufferedAmount`),
// kept bounded (#178). The kernel's send buffer, up to `tcp_wmem`'s 4 MB,
// takes a stalled reader's traffic first; these limits are for what piles up
// in the process after that.
//
// Over the soft limit a socket is passed over by move batches, which the next
// one supersedes, and catches up on each tank's newest move once it drains.
// Held over the hard limit across a heartbeat it is cut off, as a missed pong
// would be. A peak over the soft limit is worth a line when the player leaves;
// the `init` message alone queues tens of KB, so less than that is no news.

const WS_BACKLOG_SOFT_BYTES = 256 * 1024;
const WS_BACKLOG_HARD_BYTES = 4 * 1024 * 1024;

// A move batch to one player. Dropping a held batch outright would lose a
// tank's last move before it stopped, so each tank's newest is kept and goes
// ahead of the next batch the socket takes.
function sendMoveBatch(player, message, data, softBytes = WS_BACKLOG_SOFT_BYTES) {
  if (player.ws.bufferedAmount > softBytes) {
    player.heldMoves = player.heldMoves || new Map();
    for (const move of message.moves) player.heldMoves.set(move.id, move);
    return;
  }
  if (!player.heldMoves) {
    player.ws.send(data);
    return;
  }
  for (const move of message.moves) player.heldMoves.delete(move.id);
  const moves = [...player.heldMoves.values(), ...message.moves];
  player.heldMoves = null;
  player.ws.send(JSON.stringify({ ...message, moves }));
}

// At each heartbeat: how long the socket has been over the hard limit, in ms,
// once it was over at the previous heartbeat too; otherwise null.
function backlogOverFor(player, now, hardBytes = WS_BACKLOG_HARD_BYTES) {
  if (!(player.ws.bufferedAmount > hardBytes)) {
    player.backlogSince = null;
    return null;
  }
  if (!player.backlogSince) {
    player.backlogSince = now;
    return null;
  }
  return now - player.backlogSince;
}

module.exports = {
  WS_BACKLOG_SOFT_BYTES,
  WS_BACKLOG_HARD_BYTES,
  sendMoveBatch,
  backlogOverFor,
};
