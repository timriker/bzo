#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The plugin host (server/plugins.cjs): which files load, what a plugin
// registers, and that one that throws is contained.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPluginHost, pluginSetting, EVENT_TYPES } = require('../server/plugins.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bzo-plugins-'));
const bundled = path.join(root, 'bundled');
const installed = path.join(root, 'installed');
fs.mkdirSync(bundled);
fs.mkdirSync(installed);

function write(dir, id, body) {
  fs.writeFileSync(path.join(dir, `${id}.cjs`), body);
}

const META = "meta: { name: 'T', version: '1.0', author: 'a', description: 'd' }";

write(bundled, 'counter', `
let seen = [];
module.exports = {
  ${META},
  Init(bz, config) {
    this.config = config;
    bz.Register(bz.bz_ePlayerJoinEvent);
    bz.bz_registerCustomSlashCommand('count', {
      SlashCommand(playerID, channel, command, message, params) {
        seen.push({ playerID, channel, command, message, params });
        return message !== 'pass';
      },
    }, { help: '<n> - count', operator: true });
  },
  Event(data) { data.count = (data.count || 0) + 1; seen.push(data.eventType); },
  Cleanup() { seen.push('cleanup'); },
  seen: () => seen,
};
`);
write(bundled, 'second', `
module.exports = {
  ${META},
  Init(bz) { bz.Register(bz.bz_ePlayerJoinEvent); },
  Event(data) { data.count += 10; },
};
`);
write(bundled, 'thrower', `
module.exports = {
  ${META},
  Init(bz) { bz.Register(bz.bz_ePlayerJoinEvent); },
  Event() { throw new Error('boom'); },
};
`);
write(bundled, 'badinit', `
module.exports = {
  ${META},
  Init(bz) { bz.Register(bz.bz_eTickEvent); throw new Error('no'); },
};
`);
write(bundled, 'nometa', 'module.exports = { Init() {} };');
write(bundled, 'syntax', 'module.exports = {');
write(bundled, 'off', `module.exports = { ${META}, Init(bz) { bz.Register(bz.bz_eKillEvent); } };`);
write(bundled, 'replaced', `module.exports = { ${META}, Init(bz) { bz.Register(bz.bz_eKillEvent); } };`);
write(installed, 'replaced', `module.exports = { ${META}, Init(bz) { bz.Register(bz.bz_eCaptureEvent); } };`);
fs.writeFileSync(path.join(bundled, 'notes.txt'), 'not a plugin');

const lines = [];
const host = createPluginHost({
  dirs: [bundled, installed],
  settings: { off: false, counter: { limit: 3 } },
  log: (text) => lines.push(text),
});
host.loadAll();

const byId = Object.fromEntries(host.list().map((entry) => [entry.id, entry]));
assert.deepEqual(Object.keys(byId).sort(),
  ['badinit', 'counter', 'nometa', 'off', 'replaced', 'second', 'syntax', 'thrower']);
assert.equal(byId.counter.state, 'loaded');
assert.equal(byId.off.state, 'off', 'server.json false turns a plugin off');
assert.equal(byId.nometa.state, 'failed');
assert.equal(byId.nometa.error, 'has no meta');
assert.equal(byId.syntax.state, 'failed', 'a file that does not parse is left off');
assert.equal(byId.badinit.state, 'failed', 'an Init that throws is left off');
assert.equal(host.listening('bz_eTickEvent'), false, 'and what it registered first is taken away');
assert.equal(byId.replaced.bundled, false, 'the installed file wins over the bundled one');
assert.equal(byId.replaced.replaces, path.join(bundled, 'replaced.cjs'), 'and says which it hides');
assert.ok(lines.some((line) => line.startsWith('replaced: ') && line.includes(' replaces ')));
assert.equal(host.listening('bz_eCaptureEvent'), true);
assert.equal(host.listening('bz_eKillEvent'), false);
assert.equal(byId.counter.meta.license, '', 'license is optional');

const counter = require(byId.counter.file);
assert.deepEqual(counter.config, { limit: 3 }, 'options from server.json reach Init');

// Every listener in load order, on the same data; one that throws is skipped.
const data = host.callEvents('bz_ePlayerJoinEvent', { playerID: 4 });
assert.equal(data.eventType, 'bz_ePlayerJoinEvent');
assert.equal(data.count, 11, 'counter then second, sharing the data');
assert.ok(lines.some((line) => line.startsWith('thrower: bz_ePlayerJoinEvent: Error: boom')));
assert.equal(host.listening('bz_eShotFiredEvent'), false, 'nobody registered');

// Custom slash commands: upstream's arguments, and false passes the line on.
assert.equal(host.slashCommand(3, 254, '/COUNT a  b'), true);
assert.deepEqual(counter.seen().at(-1),
  { playerID: 3, channel: 254, command: 'COUNT', message: 'a  b', params: ['a', 'b'] });
assert.equal(host.slashCommand(3, 254, '/count pass'), false);
assert.equal(host.slashCommand(3, 254, '/nothing'), false);
assert.equal(host.slashCommand(3, 254, '/'), false);

assert.deepEqual(host.commands(),
  [{ name: '/count', help: '<n> - count', operator: true, plugin: 'counter' }]);

// Unload takes its events and commands with it, and Cleanup runs.
assert.equal(host.unload('counter'), true);
assert.equal(counter.seen().at(-1), 'cleanup');
assert.equal(host.slashCommand(3, 254, '/count x'), false);
assert.deepEqual(host.commands(), []);
assert.equal(host.callEvents('bz_ePlayerJoinEvent', { count: 0 }).count, 10);
assert.equal(host.list().find((entry) => entry.id === 'counter').state, 'off');
assert.equal(host.load('counter').state, 'loaded', 'and it loads again');

assert.deepEqual(pluginSetting(undefined, 'x'), { enabled: true, config: {} });
assert.deepEqual(pluginSetting({ x: { enabled: false, a: 1 } }, 'x'), { enabled: false, config: { a: 1 } });
assert.ok(EVENT_TYPES.includes('bz_eAuthenticatonComplete'), "upstream's spelling");
assert.equal(new Set(EVENT_TYPES).size, EVENT_TYPES.length);

fs.rmSync(root, { recursive: true, force: true });
console.log('plugin host tests passed');
