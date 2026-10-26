/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The port transport (`public/js/port-transport.mjs`) over a real
// MessageChannel: it has to answer the client the way a WebSocket does, since
// the client cannot tell which it holds.

import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { setTimeout as sleep } from 'node:timers/promises';
import { CLOSED, CONNECTING, OPEN, createPortTransport } from '../public/js/port-transport.mjs';

function pair() {
  const { port1, port2 } = new MessageChannel();
  const far = [];
  port2.onmessage = ({ data }) => far.push(data);
  const transport = createPortTransport(port1);
  const events = [];
  transport.onopen = () => events.push('open');
  transport.onmessage = ({ data }) => events.push(`message ${data}`);
  transport.onclose = ({ code, reason }) => events.push(`close ${code} ${reason}`);
  return { port1, port2, far, transport, events };
}

{
  // Nothing is sent before the far end says it is open, as on a socket.
  const { port1, port2, far, transport, events } = pair();
  assert.equal(transport.readyState, CONNECTING);
  transport.send('early');
  port2.postMessage('ignored before open');
  await sleep(10);
  assert.deepEqual(far, []);
  assert.deepEqual(events, []);

  port2.postMessage({ type: 'open' });
  await sleep(10);
  assert.equal(transport.readyState, OPEN);
  transport.send('{"type":"m"}');
  port2.postMessage('{"type":"init"}');
  await sleep(10);
  assert.deepEqual(far, ['{"type":"m"}']);
  assert.deepEqual(events, ['open', 'message {"type":"init"}']);

  // The far end closing is the socket closing under the client.
  port2.postMessage({ type: 'close', code: 1008, reason: '503' });
  await sleep(10);
  assert.equal(transport.readyState, CLOSED);
  assert.deepEqual(events.at(-1), 'close 1008 503');
  transport.send('late');
  await sleep(10);
  assert.deepEqual(far, ['{"type":"m"}'], 'nothing goes out once closed');
  port1.close();
}

{
  // The client closing tells the far end and reports its own close once.
  const { port1, port2, far, transport, events } = pair();
  port2.postMessage({ type: 'open' });
  await sleep(10);
  transport.close();
  transport.close();
  await sleep(10);
  assert.equal(transport.readyState, CLOSED);
  assert.deepEqual(far, [{ type: 'close', code: 1000, reason: '' }]);
  assert.deepEqual(events, ['open', 'close 1000 ']);
  port1.close();
  port2.close();
}

{
  // A far end that never opens and closes is an attempt that failed.
  const { port1, transport, events, port2 } = pair();
  port2.postMessage({ type: 'close', code: 1006, reason: '' });
  await sleep(10);
  assert.equal(transport.readyState, CLOSED);
  assert.deepEqual(events, ['close 1006 ']);
  port1.close();
  port2.close();
}

console.log('port transport answers like a WebSocket');
