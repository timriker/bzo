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
const { classifyOpening } = require('../server/bzflag-server.cjs');
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

console.log('test-port-mux: ok');
