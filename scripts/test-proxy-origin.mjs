#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The `/origin` line a proxied session sends a proxyOrigin bzfs
// (docs/proxy-origin.md): its fields, its signature, and that it fits.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildOriginCommand, isOriginCommand, originAddress, speaksOrigin,
} = require('../server/proxy-origin.cjs');
const { CHAT_TEXT_MAX } = require('../server/bzfs-session.cjs');
const { parseProxies } = require('../server/proxies.cjs');

const key = 'a-shared-secret-of-thirty-two-chars';
const now = Date.UTC(2026, 9, 27, 12, 0, 0);

const line = buildOriginCommand(key, { ip: '203.0.113.7', bzid: 12345, callsign: 'Tim', now });
const [command, ip, bzid, time, mac] = line.split(' ');
assert.equal(command, '/origin');
assert.equal(ip, '203.0.113.7');
assert.equal(bzid, '12345');
assert.equal(time, String(now / 1000));
const expected = crypto.createHmac('sha256', key).update(`203.0.113.7\n12345\n${time}\nTim`).digest('hex');
assert.equal(mac, expected.slice(0, 32), 'the first 32 hex of HMAC-SHA256 over ip, bzid, time, callsign');

assert.equal(buildOriginCommand(key, { ip: '203.0.113.7', bzid: null, callsign: 'Tim', now }).split(' ')[2], '0',
  'no forum login is BZID 0');
assert.equal(originAddress('::ffff:198.51.100.2'), '198.51.100.2', 'a v4-mapped address goes as IPv4');

const widest = buildOriginCommand(key, {
  ip: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', bzid: 99999999, callsign: 'x'.repeat(31), now,
});
assert.ok(widest.length <= CHAT_TEXT_MAX, `the widest line fits a bzfs message: ${widest.length}`);

assert.ok(speaksOrigin(new Map([['_proxyOrigin', '1']])));
assert.ok(!speaksOrigin(new Map()), 'no variable, no /origin');
assert.ok(!speaksOrigin(new Map([['_proxyOrigin', '0']])));

assert.ok(isOriginCommand('/origin 1.2.3.4 0 1 abc'));
assert.ok(isOriginCommand('  /ORIGIN'));
assert.ok(!isOriginCommand('/originality'), 'only the command itself');

const { targets, warnings } = parseProxies({
  'a.example:5154': { address: '127.0.0.1:5154', originKey: key },
  'b.example:5155': { address: '127.0.0.1:5155', originKey: 'short' },
  'c.example:5156': '127.0.0.1:5156',
});
assert.equal(targets['a.example:5154'].originKey, key);
assert.equal(targets['c.example:5156'].originKey, null);
assert.ok(warnings.some((w) => w.key === 'b.example:5155' && /short/.test(w.reason)), 'a short key is warned about');

console.log('proxy origin tests passed');
