/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// proxy-protocol.cjs - HAProxy's PROXY protocol, v1 and v2, on TCP.
//
// A TCP proxy in front of the listen port -- HAProxy, nginx's stream module,
// a load balancer -- opens each connection to this server itself, so the
// socket names the proxy. With `send-proxy` or `send-proxy-v2` it first
// writes one header naming the client, and the connection carries on as the
// client's own after it. Only a peer `proxyProtocolFrom` lists may send one:
// from anyone else a header is a client naming itself whatever it likes.
//
// https://www.haproxy.org/download/2.9/doc/proxy-protocol.txt

'use strict';

const V1_PREFIX = Buffer.from('PROXY ', 'latin1');
// v1's longest line, `PROXY TCP6` and two full IPv6 addresses and ports.
const V1_MAX_LENGTH = 107;
const V2_SIGNATURE = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
const V2_HEADER_LENGTH = 16;

// Whether `buffer`, so far, could still be the start of `prefix`.
function couldBe(buffer, prefix) {
  const length = Math.min(buffer.length, prefix.length);
  return buffer.subarray(0, length).equals(prefix.subarray(0, length));
}

function ipv6Text(bytes) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
  // The longest run of zero groups, two or more, becomes `::`.
  let best = { start: -1, length: 0 };
  for (let i = 0; i < 8;) {
    if (groups[i] !== '0') { i += 1; continue; }
    let j = i;
    while (j < 8 && groups[j] === '0') j += 1;
    if (j - i > best.length && j - i > 1) best = { start: i, length: j - i };
    i = j;
  }
  if (best.start < 0) return groups.join(':');
  return `${groups.slice(0, best.start).join(':')}::${groups.slice(best.start + best.length).join(':')}`;
}

// The header at the start of `buffer`, if there is one:
//   { state: 'more' }                    too few bytes yet to tell
//   { state: 'none' }                    no header; the connection is as it is
//   { state: 'bad', reason }             a header, but not one this reads
//   { state: 'ok', length, address?, port? }
// `length` is how many bytes the header took. No `address` is a header that
// names nobody -- v1's UNKNOWN, v2's LOCAL (a health check) or an address
// family other than TCP over IPv4 or IPv6 -- and leaves the socket's own.
function parseProxyHeader(buffer) {
  if (buffer.length === 0) return { state: 'more' };
  if (couldBe(buffer, V1_PREFIX)) {
    if (buffer.length < V1_PREFIX.length) return { state: 'more' };
    const end = buffer.indexOf('\r\n', 0, 'latin1');
    if (end < 0) return buffer.length >= V1_MAX_LENGTH ? { state: 'bad', reason: 'v1 line too long' } : { state: 'more' };
    if (end + 2 > V1_MAX_LENGTH) return { state: 'bad', reason: 'v1 line too long' };
    const length = end + 2;
    const fields = buffer.toString('latin1', 0, end).split(' ');
    if (fields[1] === 'UNKNOWN') return { state: 'ok', length };
    if (fields.length !== 6 || (fields[1] !== 'TCP4' && fields[1] !== 'TCP6')) {
      return { state: 'bad', reason: `v1 ${JSON.stringify(buffer.toString('latin1', 0, end))}` };
    }
    const port = Number(fields[4]);
    const valid = fields[1] === 'TCP4'
      ? /^\d{1,3}(\.\d{1,3}){3}$/.test(fields[2])
      : /^[0-9a-f:.]+$/i.test(fields[2]) && fields[2].includes(':');
    if (!valid || !Number.isInteger(port) || port < 0 || port > 65535) {
      return { state: 'bad', reason: `v1 ${JSON.stringify(buffer.toString('latin1', 0, end))}` };
    }
    return { state: 'ok', length, address: fields[2].toLowerCase(), port };
  }
  if (couldBe(buffer, V2_SIGNATURE)) {
    if (buffer.length < V2_HEADER_LENGTH) return { state: 'more' };
    const versionCommand = buffer[12];
    if ((versionCommand >> 4) !== 2) return { state: 'bad', reason: `v2 version ${versionCommand >> 4}` };
    const length = V2_HEADER_LENGTH + buffer.readUInt16BE(14);
    if (buffer.length < length) return { state: 'more' };
    const command = versionCommand & 0x0f;
    if (command === 0) return { state: 'ok', length };
    if (command !== 1) return { state: 'bad', reason: `v2 command ${command}` };
    const family = buffer[13];
    const body = buffer.subarray(V2_HEADER_LENGTH, length);
    // TCP over IPv4, then TCP over IPv6: source, destination, source port.
    if (family === 0x11 && body.length >= 12) {
      return { state: 'ok', length, address: [...body.subarray(0, 4)].join('.'), port: body.readUInt16BE(8) };
    }
    if (family === 0x21 && body.length >= 36) {
      return { state: 'ok', length, address: ipv6Text(body.subarray(0, 16)), port: body.readUInt16BE(32) };
    }
    return { state: 'ok', length };
  }
  return { state: 'none' };
}

// Makes `socket` name the client the header did, for everything that reads
// it later: Express's `req.socket`, the BZFlag handler, the UDP link's match.
// An IPv4 client is written as itself, the way a dual-stack socket's own
// peer is after `peerAddress` strips it.
function setSocketPeer(socket, address, port) {
  Object.defineProperty(socket, 'remoteAddress', { value: address, configurable: true });
  Object.defineProperty(socket, 'remotePort', { value: port, configurable: true });
  Object.defineProperty(socket, 'remoteFamily', { value: address.includes(':') ? 'IPv6' : 'IPv4', configurable: true });
}

module.exports = { parseProxyHeader, setSocketPeer };
