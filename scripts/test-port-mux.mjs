/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// What the BZFlag port takes a connection for, from its opening bytes (#190,
// docs/port-mux-plan.md): BZFlag, TLS, HTTP, something else, or not enough
// arrived yet to tell.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const http = require('node:http');
const net = require('node:net');
const { classifyOpening, createBzflagServer } = require('../server/bzflag-server.cjs');
const { parseProxyHeader } = require('../server/proxy-protocol.cjs');
const of = (text) => classifyOpening(Buffer.from(text, 'latin1'));

assert.equal(of('BZFLAG\r\n\r\n'), 'bzflag');
assert.equal(of('BZFLAG\r\n\r\nextra'), 'bzflag');
assert.equal(of('BZF'), 'more', 'part of the BZFlag greeting waits for the rest');
assert.equal(of(''), 'more');

assert.equal(of('GET / HTTP/1.1\r\n'), 'http');
assert.equal(of('HEAD /x HTTP/1.1\r\n'), 'http');
assert.equal(of('POST /api HTTP/1.1\r\n'), 'http');
assert.equal(of('OPTIONS * HTTP/1.1\r\n'), 'http');
assert.equal(of('GE'), 'more', 'part of a method waits for the rest');
assert.equal(of('GETX / HTTP/1.1'), 'other', 'not a method');

assert.equal(classifyOpening(Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00])), 'tls', 'a ClientHello');
assert.equal(classifyOpening(Buffer.from([0x16])), 'more');
assert.equal(classifyOpening(Buffer.from([0x16, 0x09])), 'other', 'not TLS after all');

assert.equal(of('SSH-2.0-OpenSSH\r\n'), 'other');
assert.equal(classifyOpening(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0])), 'other');

// PROXY headers, v1 and v2 (proxy-protocol.cjs).
const v1 = (line) => parseProxyHeader(Buffer.from(line, 'latin1'));
assert.deepEqual(v1('PROXY TCP4 203.0.113.7 192.0.2.1 4242 443\r\nGET'),
  { state: 'ok', length: 43, address: '203.0.113.7', port: 4242 });
assert.deepEqual(v1('PROXY TCP6 2001:DB8::7 2001:db8::1 4242 443\r\n'),
  { state: 'ok', length: 45, address: '2001:db8::7', port: 4242 });
assert.deepEqual(v1('PROXY UNKNOWN\r\n'), { state: 'ok', length: 15 });
assert.equal(v1('PROXY TCP4 203.0.113.7').state, 'more', 'no line end yet');
assert.equal(v1('P').state, 'more');
assert.equal(v1('PUT / HTTP/1.1\r\n').state, 'none', 'a method starting with P');
assert.equal(v1('GET / HTTP/1.1\r\n').state, 'none');
assert.equal(v1('PROXY TCP4 not-an-address 192.0.2.1 1 2\r\n').state, 'bad');
assert.equal(v1(`PROXY TCP4 ${'1'.repeat(120)}`).state, 'bad', 'longer than any v1 line');

const SIGNATURE = [0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a];
const v2 = (command, family, body) => {
  const header = Buffer.from([...SIGNATURE, 0x20 | command, family, 0, 0]);
  header.writeUInt16BE(body.length, 14);
  return Buffer.concat([header, Buffer.from(body)]);
};
const ipv4Body = [203, 0, 113, 7, 192, 0, 2, 1, 0x10, 0x92, 0x01, 0xbb];
assert.deepEqual(parseProxyHeader(v2(1, 0x11, ipv4Body)),
  { state: 'ok', length: 28, address: '203.0.113.7', port: 4242 });
const ipv6Body = [0x20, 0x01, 0x0d, 0xb8, ...Array(11).fill(0), 7, ...Array(16).fill(0), 0x10, 0x92, 0x01, 0xbb];
assert.deepEqual(parseProxyHeader(v2(1, 0x21, ipv6Body)),
  { state: 'ok', length: 52, address: '2001:db8::7', port: 4242 });
assert.deepEqual(parseProxyHeader(v2(0, 0x00, [])), { state: 'ok', length: 16 }, 'LOCAL names nobody');
assert.deepEqual(parseProxyHeader(v2(1, 0x11, [...ipv4Body, 1, 0, 1, 9])).length, 32, 'TLVs are skipped');
assert.equal(parseProxyHeader(v2(1, 0x11, ipv4Body).subarray(0, 20)).state, 'more');
assert.equal(parseProxyHeader(Buffer.from(SIGNATURE.slice(0, 5))).state, 'more');

// End to end: a trusted peer's header renames the request, an untrusted
// peer's is refused, and no header leaves the socket's own address.
const web = http.createServer((req, res) => res.end(req.socket.remoteAddress));
for (const trusted of [true, false]) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const logged = [];
  const mux = createBzflagServer({
    getStatus: () => ({}), getPlayers: () => [], getTeams: () => [], getGameSettings: () => ({}),
    getWorld: () => null, onEnter: () => {}, reserveId: () => 0xff, releaseId: () => {},
    rejectReason: () => '', log: (line) => logged.push(line),
    onHttp: (socket) => web.emit('connection', socket),
    trustsProxyHeader: () => trusted,
  });
  await mux.listen('127.0.0.1', port);
  const ask = (opening) => new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(Buffer.concat([opening, Buffer.from('GET / HTTP/1.0\r\n\r\n', 'latin1')]));
    });
    let body = '';
    socket.on('data', (data) => { body += data; });
    socket.on('close', () => resolve(body.split('\r\n\r\n')[1] ?? null));
    socket.on('error', () => resolve(null));
  });
  const viaV1 = await ask(Buffer.from('PROXY TCP4 203.0.113.7 192.0.2.1 4242 443\r\n', 'latin1'));
  const viaV2 = await ask(v2(1, 0x21, ipv6Body));
  const plain = await ask(Buffer.alloc(0));
  if (trusted) {
    assert.equal(viaV1, '203.0.113.7');
    assert.equal(viaV2, '2001:db8::7');
  } else {
    assert.ok(!viaV1 && !viaV2, 'an untrusted peer is refused');
    assert.ok(logged.some((line) => line.includes('not in proxyProtocolFrom')));
  }
  assert.match(plain, /127\.0\.0\.1$/);
  await mux.close?.();
}

console.log('test-port-mux: ok');
process.exit(0);
