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
const {
  createPluginHost, pluginSetting, EVENT_TYPES, CustomZoneObject, scanCustomMapObjects,
} = require('../server/plugins.cjs');

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
const SAMPLE_META = "meta: { name: 'S', version: '1.0', author: 'a', description: 'd', enabled: false }";
write(bundled, 'sample', `module.exports = { ${SAMPLE_META}, Init(bz) { bz.Register(bz.bz_eTickEvent); } };`);
write(bundled, 'sampleon', `module.exports = { ${SAMPLE_META}, Init(bz) { bz.Register(bz.bz_eGameEndEvent); } };`);
write(bundled, 'off', `module.exports = { ${META}, Init(bz) { bz.Register(bz.bz_eKillEvent); } };`);
write(bundled, 'replaced', `module.exports = { ${META}, Init(bz) { bz.Register(bz.bz_eKillEvent); } };`);
write(installed, 'replaced', `module.exports = { ${META}, Init(bz) { bz.Register(bz.bz_eCaptureEvent); } };`);
fs.writeFileSync(path.join(bundled, 'notes.txt'), 'not a plugin');

const lines = [];
const host = createPluginHost({
  dirs: [bundled, installed],
  settings: { off: false, counter: { limit: 3 }, sampleon: true },
  log: (text) => lines.push(text),
});
host.loadAll();

const byId = Object.fromEntries(host.list().map((entry) => [entry.id, entry]));
assert.deepEqual(Object.keys(byId).sort(),
  ['badinit', 'counter', 'nometa', 'off', 'replaced', 'sample', 'sampleon', 'second', 'syntax', 'thrower']);
assert.equal(byId.counter.state, 'loaded');
assert.equal(byId.off.state, 'off', 'server.json false turns a plugin off');
assert.equal(byId.sample.state, 'off', 'meta.enabled false is off by default');
assert.equal(byId.sample.meta.name, 'S', 'and still listed with its meta');
assert.equal(host.listening('bz_eTickEvent'), false, 'without being started');
assert.equal(byId.sampleon.state, 'loaded', 'until server.json turns it on');
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

// The tick runs only while a plugin listens for it.
{
  const intervals = new Set();
  const fakeTimers = {
    setInterval: (fn) => { const handle = { fn }; intervals.add(handle); return handle; },
    clearInterval: (handle) => intervals.delete(handle),
    setTimeout: () => ({}),
    clearTimeout: () => {},
  };
  const tickDir = path.join(root, 'tick');
  fs.mkdirSync(tickDir);
  write(tickDir, 'ticker', `
module.exports = {
  ${META},
  Init(bz) { this.ticks = 0; bz.Register(bz.bz_eTickEvent); },
  Event(data) { if (data.eventType === 'bz_eTickEvent' && data.eventTime > 0) this.ticks += 1; },
};
`);
  const tickHost = createPluginHost({ dirs: [tickDir], timers: fakeTimers });
  tickHost.loadAll();
  assert.equal(intervals.size, 1, 'a listener starts the tick');
  [...intervals][0].fn();
  assert.equal(require(path.join(tickDir, 'ticker.cjs')).ticks, 1);
  tickHost.unload('ticker');
  assert.equal(intervals.size, 0, 'and the last one leaving stops it');
}

// The bundled ctfOverseer against a stub of the server's API.
{
  const vars = new Map();
  const sent = [];
  const teams = { 1: 1, 2: 2 };
  const api = {
    BZ_SERVER: -2,
    bz_registerCustomBZDBBool: (name, value) => { vars.set(name, value ? '1' : '0'); return true; },
    bz_registerCustomBZDBInt: (name, value) => { vars.set(name, String(value)); return true; },
    bz_getBZDBBool: (name) => vars.get(name) === '1',
    bz_getBZDBDouble: (name) => Number(vars.get(name)),
    bz_getPlayerTeam: (id) => teams[id],
    bz_sendTextMessage: (from, to, text, params) => { sent.push({ to, text, params }); return true; },
  };
  const bundledDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'plugins');
  const off = createPluginHost({ dirs: [bundledDir], api });
  off.loadAll();
  assert.equal(off.list().find((entry) => entry.id === 'ctfOverseer').state, 'off', 'off by default');
  assert.equal(vars.size, 0, 'and registers nothing');

  const ctf = createPluginHost({ dirs: [bundledDir], api, settings: { ctfOverseer: true } });
  ctf.loadAll();
  assert.equal(vars.get('_disallowSelfCap'), '1', "on, with allejo's defaults");
  assert.equal(vars.get('_delayTeamFlagGrab'), '20');
  const capture = (capped, capping) => ctf.callEvents('bz_eAllowCTFCaptureEvent',
    { teamCapped: capped, teamCapping: capping, playerCapping: 1, allow: true, killTeam: true });
  assert.equal(capture(1, 1).allow, false, 'a self capture is refused');
  assert.equal(capture(2, 1).allow, true, 'an enemy flag still captures');
  vars.set('_disallowSelfCap', '0');
  assert.equal(capture(1, 1).allow, true, 'and a world may allow self captures again');

  const grab = (player, type) => ctf.callEvents('bz_eAllowFlagGrab',
    { playerID: player, flagID: 0, flagType: type, allow: true }).allow;
  assert.equal(grab(1, 'G*'), true, 'no capture yet, no wait');
  ctf.callEvents('bz_eCaptureEvent', { teamCapped: 2, teamCapping: 1 });
  assert.equal(grab(1, 'G*'), false, 'an enemy waits after a capture');
  assert.equal(grab(2, 'G*'), true, 'the flag\'s own team does not');
  assert.equal(grab(1, 'SW'), true, 'nor does any other flag');
  assert.equal(sent.length, 2, 'the refusal is said once');
  assert.equal(sent[1].params.team.msgid, 'Green');
  assert.equal(grab(1, 'G*'), false);
  assert.equal(sent.length, 2, 'and not again within five seconds');
}

// The upstream ports, against a stub of the server: every bundled plugin is
// off until server.json names it.
{
  const bundledDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'plugins');
  const idle = createPluginHost({ dirs: [bundledDir] });
  idle.loadAll();
  assert.deepEqual(idle.list().filter((entry) => entry.state !== 'off').map((entry) => entry.id), [],
    'no bundled plugin runs unless asked');

  let now = 1000;
  const sent = [];
  const killed = [];
  const team = new Map([[1, 5], [2, 6], [3, 6], [4, 6]]); // a rabbit and three hunters
  const flagTypes = ['R*', 'SW', 'G*', null];
  const flagOwners = [-1, 4, -1, -1];
  const resets = [];
  const api = {
    BZ_SERVER: -2, BZ_ALLUSERS: -1, eRabbitTeam: 5, eHunterTeam: 6,
    bz_getCurrentTime: () => now,
    bz_getPlayerIndexList: () => [...team.keys()],
    bz_getPlayerTeam: (id) => team.get(id) ?? -1,
    bz_getPlayerCallsign: (id) => `p${id}`,
    bz_getTeamCount: (t) => [...team.values()].filter((value) => value === t).length,
    bz_killPlayer: (id, base, killer) => { killed.push({ id, killer }); return true; },
    bz_sendTextMessage: (from, to, text, params) => { sent.push({ to, text, params }); return true; },
    bz_getPlayerFlag: (id) => flagTypes[flagOwners.indexOf(id)] ?? null,
    bz_getNumFlags: () => flagTypes.length,
    bz_getFlagName: (index) => flagTypes[index] ?? '',
    bz_flagPlayer: (index) => flagOwners[index],
    bz_resetFlag: (index) => { resets.push(index); return true; },
  };
  const host = createPluginHost({
    dirs: [bundledDir], api,
    settings: { killall: true, rabbitTimer: { time: 10 }, teamflagreset: true, autoFlagReset: { minutes: 1 } },
  });
  host.loadAll();
  for (const id of ['killall', 'rabbitTimer', 'teamflagreset', 'autoFlagReset']) {
    assert.equal(host.list().find((entry) => entry.id === id).state, 'loaded', `${id} loads when asked`);
  }
  const tick = () => host.callEvents('bz_eTickEvent', { eventTime: now });

  // killall: everyone, said by name; admins only, which the server enforces.
  assert.ok(host.commands().some((command) => command.name === '/killall' && command.operator));
  assert.equal(host.slashCommand(2, 254, '/killall'), true);
  assert.deepEqual(killed.map(({ id }) => id), [1, 2, 3, 4]);
  assert.deepEqual(sent.at(-1).params, { player: 'p2' });
  killed.length = 0;

  // rabbitTimer: told its time once there are three hunters, killed by the
  // server when it runs out.
  tick();
  assert.equal(sent.at(-1).to, 1);
  assert.deepEqual(sent.at(-1).params, { seconds: 10 });
  host.callEvents('bz_ePlayerDieEvent', { team: 6, killerTeam: 5, eventTime: now });
  now += 10;
  tick();
  assert.deepEqual(killed, [{ id: 1, killer: -2 }], 'the rabbit, by the server');
  assert.equal(sent.at(-1).text, "Time's up! Selecting new rabbit.");

  // autoFlagReset: every flag nobody holds but the team flags and empty slots.
  now += 60;
  tick();
  assert.deepEqual(resets, [], 'not before its first period has passed');
  now += 60;
  tick();
  assert.deepEqual(resets, [], 'the only superflag is held');
  flagOwners[1] = -1;
  now += 60;
  tick();
  assert.deepEqual(resets, [1]);
  resets.length = 0;

  // teamflagreset: a team flag held, then left past the idle time, goes home.
  assert.equal(host.slashCommand(2, 254, '/tfrtime 200'), true);
  assert.match(sent.at(-1).text, /invalid/);
  team.set(2, 1);
  team.set(3, 2);
  flagOwners[0] = 2;
  tick();
  flagOwners[0] = -1;
  now += 5 * 60 + 1;
  tick();
  assert.ok(resets.includes(0), 'the red flag goes home');
  assert.deepEqual(sent.at(-1).params, { team: { msgid: 'Red' } });
}

// A plugin's translations are there while it runs, under bzo's own.
{
  const bundledDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'plugins');
  const stub = { bz_registerCustomBZDBBool: () => true, bz_registerCustomBZDBInt: () => true };
  const off = createPluginHost({ dirs: [bundledDir], api: stub });
  off.loadAll();
  assert.deepEqual(off.messages('de'), {}, 'nothing while no plugin with strings runs');
  const on = createPluginHost({ dirs: [bundledDir], api: stub, settings: { ctfOverseer: true } });
  on.loadAll();
  const msgid = 'You cannot grab the {team} team flag for another ~{seconds} seconds';
  assert.match(on.messages('de')[msgid], /Team \{team\}/, "ctfOverseer's German");

  const l10n = require('../server/l10n.cjs');
  l10n.usePluginMessages((locale) => ({ ...on.messages(locale), Red: 'not bzo\'s' }));
  const catalog = l10n.catalogMessages('de');
  assert.equal(catalog[msgid], on.messages('de')[msgid], 'merged into the catalog a client is sent');
  assert.notEqual(catalog.Red, "not bzo's", "and never over bzo's own");
  l10n.usePluginMessages(() => ({}));
  assert.equal(l10n.catalogMessages('de')[msgid], undefined, 'gone with the plugin');
}

// /loadplugin's path: a file added after boot is found, loads with the
// options given, and its BZDB variables go when it is unloaded.
{
  const lateDir = path.join(root, 'late');
  fs.mkdirSync(lateDir);
  const removed = [];
  // Frozen, as the server's is.
  const api = Object.freeze({
    bz_registerCustomBZDBInt: () => true,
    bz_removeCustomBZDBVariable: (name) => { removed.push(name); return true; },
  });
  const host = createPluginHost({ dirs: [lateDir], api });
  host.loadAll();
  assert.deepEqual(host.list(), []);
  write(lateDir, 'late', `
module.exports = {
  ${META},
  Init(bz, config) { this.config = config; bz.bz_registerCustomBZDBInt('_late', 1); },
};
`);
  assert.deepEqual(host.discover(), ['late']);
  assert.deepEqual(host.discover(), [], 'found once');
  assert.equal(host.load('late', { config: { n: 2 } }).state, 'loaded');
  assert.deepEqual(require(path.join(lateDir, 'late.cjs')).config, { n: 2 });
  assert.equal(host.unload('late'), true);
  assert.deepEqual(removed, ['_late']);
}

// Custom map objects and zones, as upstream's reader and bz_CustomZoneObject
// have them, and flagStay built on both.
{
  const map = `
box
  position 0 0 0
end
# a zone
FlagStayZone
  position 100 0 0
  size 10 20 5   # comment
  flag gm
  message "Keep it in the armoury"
end
flagstayzone
  position -50 -50 0
  radius 8
  height 4
end
`;
  const blocks = scanCustomMapObjects(map, 'FLAGSTAYZONE');
  assert.equal(blocks.length, 2, 'every block of the name, in any case');
  assert.equal(blocks[0].name, 'FLAGSTAYZONE');
  assert.deepEqual(blocks[0].data.slice(0, 2), ['position 100 0 0', 'size 10 20 5']);
  assert.deepEqual(scanCustomMapObjects(map, 'nosuch'), []);

  const box = new CustomZoneObject();
  box.handleDefaultOptions(blocks[0]);
  assert.equal(box.box, true);
  assert.ok(box.pointInZone([109, 19, 4]), 'inside the box');
  assert.ok(!box.pointInZone([111, 0, 1]), 'past its half width');
  assert.ok(!box.pointInZone([100, 0, 6]), 'above it');
  const cylinder = new CustomZoneObject();
  cylinder.handleDefaultOptions(blocks[1]);
  assert.equal(cylinder.box, false);
  assert.ok(cylinder.pointInZone([-50, -43, 0]));
  assert.ok(!cylinder.pointInZone([-50, -41, 0]));
  const turned = new CustomZoneObject();
  turned.handleDefaultOptions({ data: ['position 0 0 0', 'size 10 2 5', 'rotation 90'] });
  assert.ok(turned.pointInZone([0, 9, 1]) && !turned.pointInZone([9, 0, 1]), 'a quarter turn swaps its sides');

  const bundledDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'plugins');
  const zapped = [];
  const said = [];
  let held = 'GM';
  const host = createPluginHost({
    dirs: [bundledDir],
    settings: { flagStay: true },
    api: {
      BZ_SERVER: -2,
      bz_CustomZoneObject: CustomZoneObject,
      bz_customMapObjects: (name) => scanCustomMapObjects(map, name),
      bz_getPlayerFlag: () => held,
      bz_removePlayerFlag: (id) => { zapped.push(id); return true; },
      bz_sendTextMessage: (from, to, text) => { said.push({ to, text }); return true; },
    },
  });
  host.loadAll();
  assert.equal(host.list().find((entry) => entry.id === 'flagStay').state, 'loaded');
  const move = (pos) => host.callEvents('bz_ePlayerUpdateEvent', { playerID: 3, state: { pos } });
  host.callEvents('bz_eFlagGrabbedEvent', { playerID: 3, flagType: 'SW', pos: [100, 0, 0] });
  move([200, 0, 0]);
  assert.deepEqual(zapped, [], 'a flag the zone does not name leaves freely');
  host.callEvents('bz_eFlagGrabbedEvent', { playerID: 3, flagType: 'GM', pos: [100, 0, 0] });
  move([105, 5, 0]);
  assert.deepEqual(zapped, [], 'and one it names may move within it');
  move([120, 0, 0]);
  assert.deepEqual(zapped, [3], 'but not out of it');
  assert.deepEqual(said, [{ to: 3, text: 'Keep it in the armoury' }]);
  held = null;
}

fs.rmSync(root, { recursive: true, force: true });
console.log('plugin host tests passed');
