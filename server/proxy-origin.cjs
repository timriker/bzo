/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// `/origin`: the line a proxied session sends a bzfs running the proxyOrigin
// plugin, so the server sees the player's own address and the BZID bzo
// verified, not the proxy's address and nobody. See docs/proxy-origin.md for
// the format both sides build against.

const crypto = require('node:crypto');

// The public BZDB variable the plugin sets to the protocol version it speaks.
const ORIGIN_VAR = '_proxyOrigin';
const ORIGIN_VERSION = 1;
// Hex characters of the HMAC-SHA256 sent: 128 bits, so an IPv6 address still
// leaves the line inside bzfs's 128-byte message.
const ORIGIN_MAC_HEX = 32;

// The address as the plugin should see it: an IPv4 client that reached a
// dual-stack socket is `::ffff:a.b.c.d` there, and the plain form is what an
// operator's bans are written in.
function originAddress(address) {
  const text = String(address || '').trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(text);
  return mapped ? mapped[1] : text;
}

// Whether the target says it understands `/origin`, from its BZDB.
function speaksOrigin(vars) {
  const version = Number(vars?.get?.(ORIGIN_VAR));
  return Number.isInteger(version) && version >= ORIGIN_VERSION;
}

function originMac(key, { ip, bzid, time, callsign }) {
  return crypto.createHmac('sha256', key)
    .update(`${ip}\n${bzid}\n${time}\n${callsign}`)
    .digest('hex')
    .slice(0, ORIGIN_MAC_HEX);
}

// `/origin <ip> <bzid|0> <unixtime> <mac>`. `bzid` is the forum account bzo
// verified for this player itself, or 0.
function buildOriginCommand(key, { ip, bzid, callsign, now = Date.now() }) {
  const fields = {
    ip: originAddress(ip),
    bzid: bzid ? String(bzid) : '0',
    time: Math.floor(now / 1000),
    callsign,
  };
  return `/origin ${fields.ip} ${fields.bzid} ${fields.time} ${originMac(key, fields)}`;
}

// A player's own `/origin` is never passed on: only the proxy speaks for it.
function isOriginCommand(text) {
  return /^\/origin(\s|$)/i.test(String(text || '').trim());
}

module.exports = {
  ORIGIN_VAR,
  ORIGIN_VERSION,
  buildOriginCommand,
  isOriginCommand,
  originAddress,
  originMac,
  speaksOrigin,
};
