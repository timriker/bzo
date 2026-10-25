/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// The UDP channel (#8): which candidates the server will use, and one round
// trip with public/js/udp-channel.mjs -- the browser's offer, candidates in
// either order, the server's answer, and a message each way on the channel --
// against server/udp-channel.cjs on a socket shared the way the BZFlag port
// shares its own (#189). werift plays the browser too, on sockets of its own.
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createUdpChannels, candidateIsUsable } = require('../server/udp-channel.cjs');
const { classifyDatagram } = require('../server/bzflag-server.cjs');

assert.equal(candidateIsUsable('candidate:1 1 UDP 2122317823 192.168.12.5 5154 typ host'), true);
assert.equal(candidateIsUsable('a=candidate:1 1 UDP 1686052607 166.70.97.196 5154 typ srflx raddr 0.0.0.0 rport 0'), true);
assert.equal(candidateIsUsable('candidate:2 1 UDP 2122187007 2607:fa18::1 40000 typ host'), false);
assert.equal(candidateIsUsable('candidate:3 1 udp 2113937151 0d6e6c1f-0d2c-4a4b.local 51234 typ host'), false);
assert.equal(candidateIsUsable(''), false);

let werift;
try {
  werift = require('werift');
} catch {
  console.log('test-udp-channel: ok (werift absent; round trip skipped)');
  process.exit(0);
}
const { createUdpChannel } = await import('../public/js/udp-channel.mjs');

// One message each way between a browser's channel and the server's.
function roundTrip(channels) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('channel did not carry a message each way')), 10000);
    const got = {};
    let server = null;
    const client = createUdpChannel({
      PeerConnection: werift.RTCPeerConnection,
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
}

async function check(channels) {
  const result = await roundTrip(channels);
  assert.equal(result.got.up, '{"type":"m"}');
  assert.equal(result.got.down, '{"type":"pmBatch","n":1,"moves":[]}');
  result.client.close();
  channels.close();
}

// A socket that sorts its datagrams as the BZFlag port does.
const shared = dgram.createSocket('udp4');
await new Promise((resolve) => shared.bind(0, '0.0.0.0', resolve));
const routes = {};
shared.on('message', (datagram, from) => routes[classifyDatagram(datagram)]?.(datagram, from));
const channels = await createUdpChannels({
  socket: shared,
  routeUdp: (kind, handler) => { routes[kind] = handler; },
  port: shared.address().port,
});
assert.ok(channels, 'werift loads');
await check(channels);
shared.close();

console.log('test-udp-channel: ok');
setTimeout(() => process.exit(0), 100);
