/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// The move channel (#8): which candidates the server will use, and one round
// trip between server/move-channel.cjs and public/move-channel.mjs over
// loopback -- the browser's offer, candidates in either order, the server's
// answer, and a message each way on the channel.
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMoveChannels, candidateIsUsable } = require('../server/move-channel.cjs');

assert.equal(candidateIsUsable('candidate:1 1 UDP 2122317823 192.168.12.5 5153 typ host'), true);
assert.equal(candidateIsUsable('a=candidate:1 1 UDP 1686052607 166.70.97.196 5153 typ srflx raddr 0.0.0.0 rport 0'), true);
assert.equal(candidateIsUsable('candidate:2 1 UDP 2122187007 2607:fa18::1 40000 typ host'), false);
assert.equal(candidateIsUsable('candidate:3 1 udp 2113937151 0d6e6c1f-0d2c-4a4b.local 51234 typ host'), false);
assert.equal(candidateIsUsable(''), false);

// IPv6 and a missing port turn it off rather than half on.
assert.equal(createMoveChannels({ listen: '[::]:5153' }), null);
assert.equal(createMoveChannels({ listen: '0.0.0.0' }), null);
assert.equal(createMoveChannels({ listen: '0.0.0.0:5153', load: () => { throw new Error('absent'); } }), null);

let polyfill;
try {
  polyfill = await import('node-datachannel/polyfill');
} catch {
  console.log('test-move-channel: ok (node-datachannel absent; round trip skipped)');
  process.exit(0);
}

// A free UDP port on loopback.
const port = await new Promise((resolve) => {
  const probe = dgram.createSocket('udp4');
  probe.bind(0, '127.0.0.1', () => {
    const { port: free } = probe.address();
    probe.close(() => resolve(free));
  });
});

const { createMoveChannel } = await import('../public/move-channel.mjs');
const channels = createMoveChannels({ listen: `127.0.0.1:${port}` });
assert.ok(channels);

const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('channel did not carry a message each way')), 10000);
  const got = {};
  let server = null;
  const client = createMoveChannel({
    PeerConnection: polyfill.RTCPeerConnection,
    // Signalling crosses on the event loop, as it does over a WebSocket.
    sendSignal: (signal) => setImmediate(() => server.signal(signal)),
    onMessage: (text) => {
      got.down = text;
      if (got.up) { clearTimeout(timer); resolve({ got, client, server }); }
    },
  });
  server = channels.open({
    name: 'test',
    sendSignal: (signal) => setImmediate(() => client.signal(signal)),
    onOpen: () => server.send('{"type":"pmBatch","n":1,"moves":[]}'),
    onMessage: (text) => {
      got.up = text;
      if (got.down) { clearTimeout(timer); resolve({ got, client, server }); }
    },
  });
  void client.start().then(() => {
    const send = () => { if (!client.send('{"type":"m"}')) setTimeout(send, 50); };
    send();
  });
});
assert.equal(result.got.up, '{"type":"m"}');
assert.equal(result.got.down, '{"type":"pmBatch","n":1,"moves":[]}');
result.client.close();
channels.close();
console.log('test-move-channel: ok');
setTimeout(() => process.exit(0), 100);
