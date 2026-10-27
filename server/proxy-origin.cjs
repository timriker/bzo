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
const net = require('node:net');

// The public BZDB variable the plugin sets to the protocol version it speaks.
const ORIGIN_VAR = '_proxyOrigin';
const ORIGIN_VERSION = 1;
// Hex characters of the HMAC-SHA256 sent: its first 128 bits, which leave room
// for any IPv6 address in bzfs's 127-byte message.
const ORIGIN_MAC_HEX = 32;

// The address as the plugin should see it, in as few characters as it takes.
// An IPv4 client that reached a dual-stack socket is `::ffff:a.b.c.d` there,
// and the plain form is what an operator's bans are written in. An IPv6 one
// is written compressed and lowercase -- an `X-Forwarded-For` can carry it
// with leading zeros -- with any zone id dropped.
function originAddress(address) {
  const text = String(address || '').trim().replace(/^\[(.*)\]$/, '$1').replace(/%.*$/, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(text);
  if (mapped) return mapped[1];
  if (!net.isIPv6(text)) return text;
  const shortest = new URL(`http://[${text}]/`).hostname.slice(1, -1);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(shortest);
  if (!mappedHex) return shortest;
  const word = (hex) => parseInt(hex, 16);
  return [word(mappedHex[1]) >> 8, word(mappedHex[1]) & 255, word(mappedHex[2]) >> 8, word(mappedHex[2]) & 255].join('.');
}

// Whether the target says it understands `/origin`, from its BZDB.
function speaksOrigin(vars) {
  const version = Number(vars?.get?.(ORIGIN_VAR));
  return Number.isInteger(version) && version >= ORIGIN_VERSION;
}

// The first 32 lowercase hex characters of the HMAC-SHA256 of the three
// fields as sent, one space apart.
function originMac(key, fields) {
  return crypto.createHmac('sha256', key).update(fields).digest('hex').slice(0, ORIGIN_MAC_HEX);
}

// `/origin <ip> <bzid|0> <unixtime> <mac>`. `bzid` is the forum account bzo
// verified for this player itself, or 0.
function buildOriginCommand(key, { ip, bzid, now = Date.now() }) {
  const fields = `${originAddress(ip)} ${bzid ? String(bzid) : '0'} ${Math.floor(now / 1000)}`;
  return `/origin ${fields} ${originMac(key, fields)}`;
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
