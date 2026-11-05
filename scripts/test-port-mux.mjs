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
const { classifyDatagram, classifyOpening, createBzflagServer } = require('../server/bzflag-server.cjs');
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

// Limits on the BZFlag port: an untrusted PROXY signature is refused before
// the rest of its header, a message longer than MaxPacketLen allows drops the
// connection, one address holds only so many connections, and a banned
// address is rejected at MsgEnter without holding a player number.
{
  const port = 20000 + Math.floor(Math.random() * 20000);
  let banned = null;
  let reserved = 0;
  const mux = createBzflagServer({
    getStatus: () => ({}), getPlayers: () => [], getTeams: () => [], getGameSettings: () => ({}),
    getWorld: () => ({ blob: Buffer.alloc(0), hash: 'h' }), onEnter: (link) => link.verified(),
    reserveId: () => { reserved += 1; return 5; }, releaseId: () => {},
    rejectReason: () => '', banRefusal: () => banned,
  });
  await mux.listen('127.0.0.1', port);
  // Writes `opening`, then resolves with everything received and how long the
  // server took to close, or with what arrived by `waitMs` if it did not.
  const session = (opening, { then = null, waitMs = 2000 } = {}) => new Promise((resolve) => {
    const started = Date.now();
    let got = Buffer.alloc(0);
    let sentThen = false;
    const socket = net.connect(port, '127.0.0.1', () => socket.write(opening));
    const finish = (closed) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ got, closed, ms: Date.now() - started });
    };
    const timer = setTimeout(() => finish(false), waitMs);
    socket.on('data', (data) => {
      got = Buffer.concat([got, data]);
      if (then && !sentThen && got.length >= 9) {
        sentThen = true;
        socket.write(then);
      }
    });
    socket.on('close', () => finish(true));
    socket.on('error', () => {});
  });
  const message = (code, body = []) => {
    const out = Buffer.alloc(4 + body.length);
    out.writeUInt16BE(body.length, 0);
    out.write(code, 2, 2, 'latin1');
    Buffer.from(body).copy(out, 4);
    return out;
  };
  const header = Buffer.from('BZFLAG\r\n\r\n', 'latin1');
  const claimsMore = Buffer.from([...SIGNATURE, 0x21, 0x11, 0, 0]);
  claimsMore.writeUInt16BE(60000, 14);
  const proxy = await session(claimsMore);
  assert.ok(proxy.closed && proxy.ms < 1000, 'an untrusted v2 signature is refused at once');

  const huge = await session(header, { then: message('qg', new Array(1021).fill(0)) });
  assert.ok(huge.closed, 'a 1021-byte message drops the connection');
  const largest = await session(header, { then: message('lp', new Array(1020).fill(0)), waitMs: 500 });
  assert.ok(!largest.closed, 'a 1020-byte message is allowed');

  const open = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(header);
      resolve(socket);
    });
    socket.on('error', () => {});
  })));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const ninth = await session(header);
  assert.ok(ninth.closed && ninth.got.length === 0, 'the ninth connection from one address is refused');
  for (const socket of open) socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 100));

  // A verified login stops counting: eight logged in leave room for eight more.
  const enter = () => new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(Buffer.concat([header, message('wh')])));
    let got = Buffer.alloc(0);
    socket.on('data', (data) => {
      got = Buffer.concat([got, data]);
      if (got.includes(Buffer.from('wh', 'latin1'))) {
        socket.write(message('en'));
        setTimeout(() => resolve(socket), 50);
      }
    });
    socket.on('error', () => {});
  });
  const seated = [];
  for (let i = 0; i < 8; i += 1) seated.push(await enter());
  const guests = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(header);
      resolve(socket);
    });
    socket.on('error', () => {});
  })));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const pastGuests = await session(header);
  assert.ok(pastGuests.closed && pastGuests.got.length === 0, 'eight guests still fill the cap');
  for (const socket of [...seated, ...guests]) socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 100));

  banned = 'REFUSED:testing';
  reserved = 0;
  const ban = await session(header, { then: message('en') });
  assert.equal(reserved, 0, 'a banned address holds no player number');
  assert.equal(ban.got.readUInt8(8), 0, 'its hello names slot 0');
  assert.ok(ban.got.includes(Buffer.from('rj', 'latin1')) && ban.got.includes(Buffer.from('REFUSED:testing')),
    'MsgEnter is rejected with the ban');
  await mux.close?.();
}

// What a datagram on the BZFlag port is (#189): BZFlag by its length and
// code, STUN by its length and cookie, DTLS and QUIC by the first byte.
const frame = (code, body = []) => {
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt16BE(body.length, 0);
  out.write(code, 2, 2, 'latin1');
  Buffer.from(body).copy(out, 4);
  return out;
};
const stun = (type, attributes = 0) => {
  const out = Buffer.alloc(20 + attributes);
  out.writeUInt16BE(type, 0);
  out.writeUInt16BE(attributes, 2);
  out.writeUInt32BE(0x2112a442, 4);
  return out;
};
assert.equal(classifyDatagram(Buffer.from([0, 2, 4, 4, 0, 0])), 'bzflag', "upstream's ping request");
assert.equal(classifyDatagram(frame('of', [3])), 'bzflag', 'MsgUDPLinkRequest');
assert.equal(classifyDatagram(frame('pu', new Array(300).fill(0))), 'bzflag', 'a long update: first byte 1');
assert.equal(classifyDatagram(Buffer.concat([frame('ps', [1, 2]), frame('sb', [3])])), 'bzflag', 'frames together');
assert.equal(classifyDatagram(frame('zz', [1])), 'other', 'not a UDP code');
assert.equal(classifyDatagram(Buffer.from([0, 9, 0x70, 0x75, 0])), 'other', 'longer than it is');
assert.equal(classifyDatagram(stun(0x0001, 8)), 'stun', 'binding request');
assert.equal(classifyDatagram(stun(0x0101)), 'stun', 'binding response');
const badCookie = stun(0x0001);
badCookie.writeUInt32BE(1, 4);
assert.equal(classifyDatagram(badCookie), 'other', 'no cookie');
assert.equal(classifyDatagram(Buffer.from([22, 0xfe, 0xfd, 0, 0])), 'dtls', 'a DTLS 1.2 handshake');
assert.equal(classifyDatagram(Buffer.from([0x40, 1, 2, 3, 4])), 'quic', 'a short header');
assert.equal(classifyDatagram(Buffer.from([0xc3, 0, 0, 0, 1])), 'quic', 'a long header');
assert.equal(classifyDatagram(Buffer.from([0x90, 0, 0, 0])), 'other', 'RTP, which nothing here speaks');
assert.equal(classifyDatagram(Buffer.from([0, 1])), 'other', 'too short to be anything');

console.log('test-port-mux: ok');
process.exit(0);
