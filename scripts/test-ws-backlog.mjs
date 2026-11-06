import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  WS_BACKLOG_SOFT_BYTES,
  WS_BACKLOG_HARD_BYTES,
  sendMoveBatch,
  backlogOverFor,
} = require('../server/ws-backlog.cjs');

function fakePlayer(bufferedAmount = 0) {
  const sent = [];
  return { sent, ws: { bufferedAmount, send: (data) => sent.push(JSON.parse(data)) } };
}

function batch(n, moves) {
  const message = { type: 'pmBatch', n, moves };
  return [message, JSON.stringify(message)];
}

// A socket that keeps up gets each batch as it is.
{
  const player = fakePlayer();
  sendMoveBatch(player, ...batch(1, [{ id: '1', x: 1 }]));
  assert.deepEqual(player.sent, [{ type: 'pmBatch', n: 1, moves: [{ id: '1', x: 1 }] }]);
}

// Backed up: nothing is sent, and each tank's newest move is held.
{
  const player = fakePlayer(WS_BACKLOG_SOFT_BYTES + 1);
  sendMoveBatch(player, ...batch(1, [{ id: '1', x: 1 }, { id: '2', x: 1 }]));
  sendMoveBatch(player, ...batch(2, [{ id: '1', x: 2 }]));
  assert.equal(player.sent.length, 0);

  // Drained: the held moves ride ahead of the next batch, a tank in both only
  // once and at its newest, under the new batch's number.
  player.ws.bufferedAmount = 0;
  sendMoveBatch(player, ...batch(3, [{ id: '1', x: 3 }, { id: '3', x: 3 }]));
  assert.deepEqual(player.sent, [{
    type: 'pmBatch',
    n: 3,
    moves: [{ id: '2', x: 1 }, { id: '1', x: 3 }, { id: '3', x: 3 }],
  }]);

  // Caught up, so the next goes as it is.
  sendMoveBatch(player, ...batch(4, [{ id: '2', x: 4 }]));
  assert.deepEqual(player.sent[1].moves, [{ id: '2', x: 4 }]);
}

// The hard limit: one heartbeat over starts the clock, the next one over
// reports how long; dipping under in between starts it again.
{
  const player = fakePlayer(WS_BACKLOG_HARD_BYTES + 1);
  assert.equal(backlogOverFor(player, 1000), null);
  assert.equal(backlogOverFor(player, 11000), 10000);
  player.ws.bufferedAmount = WS_BACKLOG_HARD_BYTES;
  assert.equal(backlogOverFor(player, 21000), null);
  player.ws.bufferedAmount = WS_BACKLOG_HARD_BYTES + 1;
  assert.equal(backlogOverFor(player, 31000), null);
  assert.equal(backlogOverFor(player, 41000), 10000);
}

// A socket with no `bufferedAmount` -- a bot's or a BZFlag client's link -- is
// never backed up.
{
  const player = { ws: { send: () => {} } };
  assert.equal(backlogOverFor(player, 0), null);
  assert.equal(backlogOverFor(player, 10000), null);
}

console.log('ws-backlog tests passed');
