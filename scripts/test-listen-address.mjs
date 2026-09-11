#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The danger in a bind address is silence: a server that binds the wrong thing
// is not broken, it is unreachable, and from the outside that looks like the
// proxy, the firewall or the cloud. So the default has to survive an absent,
// blank or malformed setting, a loopback must never quietly widen to every
// interface, and the one ambiguous spelling has to land somewhere stated.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_HOST, DEFAULT_PORT, describeListenTarget, resolveListenTarget, splitHostPort,
} = require('../server/listen-address.cjs');

// Splitting what an operator wrote. Brackets are what tell an address from an
// address and a port.
const splits = [
  ['', '', ''],
  ['3000', '', '3000'],
  [':3000', '', '3000'],
  ['127.0.0.1', '127.0.0.1', ''],
  ['127.0.0.1:3000', '127.0.0.1', '3000'],
  ['0.0.0.0:8080', '0.0.0.0', '8080'],
  ['localhost:3000', 'localhost', '3000'],
  // Bare IPv6 carries no port: there would be no way to tell where it ended.
  ['::', '::', ''],
  ['::1', '::1', ''],
  ['2603:1020:c01:6::2', '2603:1020:c01:6::2', ''],
  // Bracketed, which is how a port is added to one.
  ['[::]', '::', ''],
  ['[::]:3000', '::', '3000'],
  ['[::1]:3000', '::1', '3000'],
  ['[2603:1020:c01:6::2]:8080', '2603:1020:c01:6::2', '8080'],
  ['  [::1]:3000  ', '::1', '3000'],
];
for (const [input, host, port] of splits) {
  const got = splitHostPort(input);
  assert.deepEqual(got, { host, port }, `splitHostPort(${JSON.stringify(input)})`);
}

// Nothing configured: every interface, both families, on 3000 -- what a
// container needs and what a LAN game needs.
assert.equal(DEFAULT_HOST, '::');
assert.equal(DEFAULT_PORT, 3000);
for (const absent of [undefined, {}, { envListen: '', configListen: '   ' }]) {
  const got = resolveListenTarget(absent);
  assert.equal(got.host, '::');
  assert.equal(got.port, 3000);
  assert.equal(got.note, '');
}

// One setting carrying both halves.
assert.deepEqual(
  { ...resolveListenTarget({ configListen: '127.0.0.1:8080' }), note: undefined },
  { host: '127.0.0.1', port: 8080, note: undefined },
);
assert.equal(resolveListenTarget({ configListen: '[::1]:3001' }).host, '::1');
assert.equal(resolveListenTarget({ configListen: '[::1]:3001' }).port, 3001);
// A host on its own keeps the default port; a port on its own keeps every interface.
assert.equal(resolveListenTarget({ configListen: '::1' }).port, 3000);
assert.equal(resolveListenTarget({ configListen: '3001' }).host, '::');
assert.equal(resolveListenTarget({ configListen: '3001' }).port, 3001);

// The environment wins over the file, as it does for every other setting a
// container is told by its orchestration.
assert.equal(resolveListenTarget({ envListen: '127.0.0.1', configListen: '::1' }).host, '127.0.0.1');
assert.equal(resolveListenTarget({ envPort: '8081', configPort: 9000 }).port, 8081);
// `port` fills in the half `listen` did not name, from either source.
assert.equal(resolveListenTarget({ configListen: '::1', configPort: 9000 }).port, 9000);
assert.equal(resolveListenTarget({ configListen: '::1', envPort: '8081' }).port, 8081);
// A port inside `listen` is more specific than the separate `port` beside it.
assert.equal(resolveListenTarget({ configListen: '::1:', configPort: 9000 }).port, 9000);
assert.equal(resolveListenTarget({ envListen: '[::1]:7000', envPort: '8081' }).port, 7000);

// The ambiguous host. A socket binds one family, so this lands somewhere
// definite and says so rather than leaving the other loopback refusing
// connections for reasons nobody can see.
const local = resolveListenTarget({ configListen: 'localhost' });
assert.equal(local.host, '127.0.0.1');
assert.match(local.note, /::1/, 'the note names the other family');
assert.equal(resolveListenTarget({ configListen: 'LOCALHOST:9001' }).host, '127.0.0.1');
assert.equal(resolveListenTarget({ configListen: 'LOCALHOST:9001' }).port, 9001);

// A loopback is the whole point of the setting: it must never widen to every
// interface, which would expose the port the proxy exists to cover.
for (const loopback of ['127.0.0.1', '::1', 'localhost', '[::1]:3000', '127.0.0.1:3000']) {
  assert.notEqual(resolveListenTarget({ configListen: loopback }).host, '::', loopback);
}

// A port that is not a port is said out loud rather than silently becoming NaN,
// which `listen` would take as "any free port" and nobody would ever find.
for (const bad of ['http', '-1', '70000', '3000.5']) {
  const got = resolveListenTarget({ configPort: bad });
  assert.equal(got.port, 3000, `${bad} falls back`);
  assert.match(got.note, /not a port/);
}

// The startup line is meant to be pasteable.
assert.equal(describeListenTarget('::', 3000), 'http://[::]:3000');
assert.equal(describeListenTarget('::1', 3000), 'http://[::1]:3000');
assert.equal(describeListenTarget('127.0.0.1', 8080), 'http://127.0.0.1:8080');

console.log('listen address tests passed');
