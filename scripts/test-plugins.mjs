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
const { indexPage, servePage } = require('../server/plugin-http.cjs');
const express = require('express');

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
const SAMPLE_META = "meta: { name: 'S', version: '1.0', author: 'a', description: 'd' }";
write(bundled, 'sample', `module.exports = { ${SAMPLE_META}, Init(bz) { bz.Register(bz.bz_eTickEvent); } };`);
write(bundled, 'sampleon', `module.exports = { ${SAMPLE_META}, Init(bz) { bz.Register(bz.bz_eGameEndEvent); } };`);
write(bundled, 'off', `module.exports = { ${META}, Init(bz) { bz.Register(bz.bz_eKillEvent); } };`);
write(bundled, 'replaced', `module.exports = { ${META}, Init(bz) { bz.Register(bz.bz_eKillEvent); } };`);
write(installed, 'replaced', `module.exports = { ${META}, Init(bz) { bz.Register(bz.bz_eCaptureEvent); } };`);
// An installed file nobody named: not started, and not even read.
write(installed, 'unnamed', `module.exports = { ${META}, Init() { throw new Error('ran'); } };
globalThis.unnamedWasRead = true;`);
fs.writeFileSync(path.join(bundled, 'notes.txt'), 'not a plugin');

const lines = [];
const host = createPluginHost({
  dirs: [bundled, installed],
  settings: {
    off: false, counter: { limit: 3 }, sampleon: true, second: true, thrower: true, badinit: true, replaced: true,
  },
  log: (text) => lines.push(text),
});
host.loadAll();

const byId = Object.fromEntries(host.list().map((entry) => [entry.id, entry]));
assert.deepEqual(Object.keys(byId).sort(),
  ['badinit', 'counter', 'nometa', 'off', 'replaced', 'sample', 'sampleon', 'second', 'syntax', 'thrower', 'unnamed']);
assert.equal(byId.counter.state, 'loaded');
assert.equal(byId.off.state, 'off', 'server.json false turns a plugin off');
assert.equal(byId.sample.state, 'off', 'a plugin server.json does not name is off');
assert.equal(byId.sample.meta.name, 'S', 'and a bundled one is still listed with its meta');
assert.equal(byId.unnamed.state, 'off', 'an installed one too');
assert.equal(byId.unnamed.meta, null, 'and is not read, which would run it');
assert.equal(globalThis.unnamedWasRead, undefined);
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

assert.deepEqual(pluginSetting(undefined, 'x'), { enabled: false, config: {} });
assert.deepEqual(pluginSetting({ x: true }, 'x'), { enabled: true, config: {} });
assert.deepEqual(pluginSetting({ ctfOverseer: true }, 'ctfoverseer'), { enabled: true, config: {} },
  'a name in another case still reads');
assert.deepEqual(pluginSetting({ ctfOverseer: true, ctfoverseer: false }, 'ctfoverseer'), { enabled: false, config: {} },
  'its own spelling first');
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
  const tickHost = createPluginHost({ dirs: [tickDir], timers: fakeTimers, settings: { ticker: true } });
  tickHost.loadAll();
  assert.equal(intervals.size, 1, 'a listener starts the tick');
  [...intervals][0].fn();
  assert.equal(require(path.join(tickDir, 'ticker.cjs')).ticks, 1);
  tickHost.unload('ticker');
  assert.equal(intervals.size, 0, 'and the last one leaving stops it');
}

// The bundled ctfoverseer against a stub of the server's API.
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
  assert.equal(off.list().find((entry) => entry.id === 'ctfoverseer').state, 'off', 'off by default');
  assert.equal(vars.size, 0, 'and registers nothing');

  const ctf = createPluginHost({ dirs: [bundledDir], api, settings: { ctfoverseer: true } });
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
    settings: { killall: true, rabbittimer: { time: 10 }, teamflagreset: true, autoflagreset: { minutes: 1 } },
  });
  host.loadAll();
  for (const id of ['killall', 'rabbittimer', 'teamflagreset', 'autoflagreset']) {
    assert.equal(host.list().find((entry) => entry.id === id).state, 'loaded', `${id} loads when asked`);
  }
  const tick = () => host.callEvents('bz_eTickEvent', { eventTime: now });

  // killall: everyone, said by name; admins only, which the server enforces.
  assert.ok(host.commands().some((command) => command.name === '/killall' && command.operator));
  assert.equal(host.slashCommand(2, 254, '/killall'), true);
  assert.deepEqual(killed.map(({ id }) => id), [1, 2, 3, 4]);
  assert.deepEqual(sent.at(-1).params, { player: 'p2' });
  killed.length = 0;

  // rabbittimer: told its time once there are three hunters, killed by the
  // server when it runs out.
  tick();
  assert.equal(sent.at(-1).to, 1);
  assert.deepEqual(sent.at(-1).params, { seconds: 10 });
  host.callEvents('bz_ePlayerDieEvent', { team: 6, killerTeam: 5, eventTime: now });
  now += 10;
  tick();
  assert.deepEqual(killed, [{ id: 1, killer: -2 }], 'the rabbit, by the server');
  assert.equal(sent.at(-1).text, "Time's up! Selecting new rabbit.");

  // autoflagreset: every flag nobody holds but the team flags and empty slots.
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
  const on = createPluginHost({ dirs: [bundledDir], api: stub, settings: { ctfoverseer: true } });
  on.loadAll();
  const msgid = 'You cannot grab the {team} team flag for another ~{seconds} seconds';
  assert.match(on.messages('de')[msgid], /Team \{team\}/, "ctfoverseer's German");

  const l10n = require('../server/l10n.cjs');
  l10n.usePluginMessages((locale) => ({ ...on.messages(locale), Red: 'not bzo\'s' }));
  const catalog = l10n.catalogMessages('de');
  assert.equal(catalog[msgid], on.messages('de')[msgid], 'merged into the catalog a client is sent');
  assert.notEqual(catalog.Red, "not bzo's", "and never over bzo's own");
  l10n.usePluginMessages(() => ({}));
  assert.equal(l10n.catalogMessages('de')[msgid], undefined, 'gone with the plugin');
}

// A translation-only plugin: its msgids, with bzo's own catalogs', match a
// proxied target's finished lines, and a msgid two plugins translate
// differently is logged once.
{
  const l10n = require('../server/l10n.cjs');
  const dir = path.join(root, 'l10n-only');
  fs.mkdirSync(dir);
  write(dir, 'a-welcome', `module.exports = { ${META}, Init() {},
    l10n: { de: { 'Welcome, {player}, to {server} server!': 'Willkommen, {player}, auf {server}!',
                  'Welcome, {player}!': 'Hallo {player}!', 'Game over': 'Spiel aus', '{a}: {b}': 'x' } } };`);
  write(dir, 'b-other', `module.exports = { ${META}, Init() {},
    l10n: { de: { 'Game over': 'Ende' } } };`);
  const lines = [];
  const host = createPluginHost({
    dirs: [dir], log: (line) => lines.push(line), settings: { 'a-welcome': true, 'b-other': true },
  });
  host.loadAll();
  l10n.usePluginMsgids(() => host.msgids());
  const match = l10n.matchServerLine;
  assert.deepEqual(match('Welcome, Tim, to foo.example.com:5154 server!'), {
    msgid: 'Welcome, {player}, to {server} server!',
    params: { player: 'Tim', server: 'foo.example.com:5154' },
  });
  assert.deepEqual(match('Welcome, Tim!'), { msgid: 'Welcome, {player}!', params: { player: 'Tim' } });
  assert.equal(match('Game over'), null, 'a whole fixed line is looked up as it is');
  assert.equal(match('Tim: hello there'), null, 'a template of slots and punctuation matches nothing');
  assert.equal(match('Welcome, (a.b)*!').params.player, '(a.b)*', 'a value is never a pattern');
  assert.deepEqual(match('BZFS Version: 2.4.30'), { msgid: 'BZFS Version: {version}', params: { version: '2.4.30' } },
    "bzo's own catalog");
  assert.equal(match('Tim (abc) left'), null, "only bzo's msgids its server sends, not its interface's");
  assert.equal(host.messages('de')['Game over'], 'Spiel aus', 'the first plugin keeps a shared msgid');
  assert.equal(lines.filter((line) => line.includes('"Game over" is also translated by a-welcome')).length, 1);
  host.unload('a-welcome');
  assert.equal(match('Welcome, Tim!'), null, 'gone with the plugin');
  l10n.usePluginMsgids(() => []);
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

// A custom poll type is handed to the server with a handler that survives
// the plugin throwing, and goes when the plugin does.
{
  const pollDir = path.join(root, 'polls');
  fs.mkdirSync(pollDir);
  const types = new Map();
  const api = Object.freeze({
    bz_registerCustomPollType: (option, parameters, handler) => { types.set(option, handler); return true; },
    bz_removeCustomPollType: (option) => types.delete(option),
  });
  write(pollDir, 'poller', `
module.exports = {
  ${META},
  Init(bz) { bz.bz_registerCustomPollType('Mute', 'callsign', this); },
  PollOpen(player) { if (player.bad) throw new Error('bad'); return true; },
};
`);
  const logged = [];
  const host = createPluginHost({ dirs: [pollDir], api, log: (line) => logged.push(line) });
  host.loadAll();
  host.load('poller');
  assert.equal(types.get('mute').PollOpen({}), true);
  assert.equal(types.get('mute').PollOpen({ bad: true }), undefined, 'a throw stops the poll');
  assert.ok(logged.some((line) => line.includes('PollOpen')));
  types.get('mute').PollClose('mute', '', true);
  host.unload('poller');
  assert.equal(types.size, 0, 'removed with the plugin');
}

// Custom map objects and zones, as upstream's reader and bz_CustomZoneObject
// have them, and flagstay built on both.
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
    settings: { flagstay: true },
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
  assert.equal(host.list().find((entry) => entry.id === 'flagstay').state, 'loaded');
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

// shockwavedeath: a server shockwave where each tank dies.
{
  const bundledDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'plugins');
  const fired = [];
  const host = createPluginHost({
    dirs: [bundledDir],
    settings: { shockwavedeath: true },
    api: { bz_fireServerShot: (...args) => { fired.push(args); return 1; } },
  });
  host.loadAll();
  host.callEvents('bz_ePlayerDieEvent', { playerID: 2, state: { pos: [1, 2, 3] } });
  assert.deepEqual(fired, [['SW', [1, 2, 3], [0, 0, 0]]]);
}

// wwzones: a tank in a zone sets off its weapon, once, and with `repeat`
// again after the interval.
{
  const map = `
wwzone
  position 0 0 0
  size 10 10 5
  zoneweapon SW 1 3 4 0 0 90 0 0
  repeat 2
  playermessage "Boom"
  infomessage
end
`;
  const bundledDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'plugins');
  let now = 100;
  let pos = [50, 50, 0];
  const fired = [];
  const said = [];
  const host = createPluginHost({
    dirs: [bundledDir],
    settings: { wwzones: true },
    api: {
      BZ_SERVER: -2, BZ_ALLUSERS: -1,
      bz_CustomZoneObject: CustomZoneObject,
      bz_customMapObjects: (name) => scanCustomMapObjects(map, name),
      bz_getCurrentTime: () => now,
      bz_getPlayerIndexList: () => [7],
      bz_getPlayerByIndex: () => ({ playerID: 7, callsign: 'tank', spawned: true, lastKnownState: { pos } }),
      bz_vectorFromRotations: (tilt, rotation) => [Math.cos(rotation), Math.sin(rotation), Math.sin(tilt)],
      bz_fireServerShot: (type, origin, vector) => { fired.push({ type, origin, y: Math.round(vector[1]) }); return 1; },
      bz_sendTextMessage: (from, to, text, params) => { said.push({ to, text, params }); return true; },
    },
  });
  host.loadAll();
  const tick = () => host.callEvents('bz_eTickEvent', { eventTime: now });
  tick();
  assert.deepEqual(fired, [], 'nobody in the zone');
  pos = [2, 2, 1];
  tick();
  assert.deepEqual(fired, [], 'arriving arms it, as upstream wasHere does');
  now += 0.1;
  tick();
  assert.deepEqual(fired, [{ type: 'SW', origin: [3, 4, 0], y: 1 }], 'then it fires, pointing at 90 degrees');
  assert.deepEqual(said.map((line) => line.text), ['Boom', '{weapon} triggered by {player}.']);
  now += 1;
  tick();
  assert.equal(fired.length, 1, 'not again inside the repeat interval');
  now += 2;
  tick();
  now += 0.1;
  tick();
  assert.equal(fired.length, 2, 'and again after it');
}

// A plugin's own flag: registered, its shots announced and scored.
{
  const { packCustomFlagType } = require('../server/bzflag-server.cjs');
  const packed = packCustomFlagType({ abbreviation: 'CF', name: 'Custom Flag', help: 'h', quality: 0 });
  assert.equal(packed.subarray(0, 2).toString('latin1'), 'CF');
  assert.deepEqual([...packed.subarray(2, 4)], [0, 0], 'good, and a normal shot');
  assert.equal(packed.readUInt32BE(4), 11);
  assert.equal(packed.subarray(8, 19).toString(), 'Custom Flag');

  const bundledDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'plugins');
  const registered = [];
  const said = [];
  const wins = [];
  const host = createPluginHost({
    dirs: [bundledDir],
    settings: { customflagsample: true },
    api: {
      BZ_SERVER: -2, BZ_ALLUSERS: -1, eGoodFlag: 0,
      bz_RegisterCustomFlag: (...args) => { registered.push(args); return true; },
      bz_getPlayerByIndex: () => ({ callsign: 'tank', currentFlag: 'Custom Flag (+CF)' }),
      bz_getPlayerCallsign: () => 'victim',
      bz_incrementPlayerWins: (id, by) => { wins.push([id, by]); return true; },
      bz_sendTextMessage: (from, to, text, params) => { said.push({ text, params }); return true; },
    },
  });
  host.loadAll();
  assert.equal(registered[0][0], 'CF');
  host.callEvents('bz_eShotFiredEvent', { playerID: 4 });
  assert.deepEqual(wins, [[4, 10]]);
  assert.deepEqual(said.at(-1), { text: 'Shot fired by {player} with Custom Flag!', params: { player: 'tank' } });
  host.callEvents('bz_ePlayerDieEvent', { playerID: 5, flagKilledWith: 'CF' });
  assert.deepEqual(said.at(-1).params, { player: 'victim' });
}

// compassletters: four letters join the world a BZFlag client is sent, and
// none join bzo's own.
{
  const bundledDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'plugins');
  const host = createPluginHost({ dirs: [bundledDir], settings: { compassletters: true } });
  host.loadAll();
  assert.equal(host.list().find((entry) => entry.id === 'compassletters').state, 'loaded');
  const tree = () => ({ managers: { materials: [], physicsDrivers: [] }, world: { obstacles: { mesh: [] } } });
  const world = { worldSize: 800, wallHeight: 6.15, maxHeight: 40 };
  const bzflag = host.callEvents('bz_eGetWorldEvent', { world: 'bzflag', tree: tree(), ...world });
  assert.equal(bzflag.tree.world.obstacles.mesh.length, 4);
  assert.equal(bzflag.tree.managers.materials.length, 5);
  const top = Math.max(...bzflag.tree.world.obstacles.mesh.flatMap((mesh) => mesh.vertices.map((v) => v[2])));
  assert.ok(top > 45 && top < 45 + 30, 'centred at the tallest obstacle plus 5');
  const bzo = host.callEvents('bz_eGetWorldEvent', { world: 'bzo', tree: tree(), ...world });
  assert.equal(bzo.tree.world.obstacles.mesh.length, 0);
}

// koth: holding the hill for its hold time kills everyone else, and a team
// holds it together under teamplay.
{
  const map = (extra) => `koth
  position 0 0 0
  size 10 10 5
  holdtime 40
${extra}end
`;
  const bundledDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'plugins');
  const run = (extra) => {
    const state = { now: 0, killed: [], said: [], team: [] };
    const tanks = new Map([
      [1, { playerID: 1, callsign: 'king', team: 1, spawned: true, admin: true, lastKnownState: { pos: [0, 0, 0] } }],
      [2, { playerID: 2, callsign: 'mate', team: 1, spawned: true, admin: false, lastKnownState: { pos: [90, 0, 0] } }],
      [3, { playerID: 3, callsign: 'other', team: 2, spawned: true, admin: false, lastKnownState: { pos: [90, 0, 0] } }],
    ]);
    const host = createPluginHost({
      dirs: [bundledDir],
      settings: { koth: true },
      api: {
        BZ_SERVER: -2, BZ_ALLUSERS: -1, eNoTeam: -1, eRogueTeam: 0, eRedTeam: 1, eGreenTeam: 2, eBlueTeam: 3, ePurpleTeam: 4,
        bz_CustomZoneObject: CustomZoneObject,
        bz_customMapObjects: (name) => scanCustomMapObjects(map(extra), name),
        bz_getCurrentTime: () => state.now,
        bz_getTeamCount: (team) => [...tanks.values()].filter((tank) => tank.team === team).length,
        bz_getPlayerIndexList: () => [...tanks.keys()],
        bz_getPlayerByIndex: (id) => tanks.get(id) ?? null,
        bz_killPlayer: (id, _base, killer) => { state.killed.push([id, killer]); return true; },
        bz_sendPlayCustomLocalSound: () => false,
        bz_sendTextMessage: (from, to, text, params) => { state.said.push({ from, to, text, params }); return true; },
        bz_sendTextMessageToTeam: (from, team, text) => { state.team.push({ team, text }); return true; },
      },
    });
    host.loadAll();
    // The hold time is applied as players join, as upstream applies it.
    for (const id of tanks.keys()) host.callEvents('bz_ePlayerJoinEvent', { playerID: id });
    const move = (id, pos) => {
      tanks.get(id).lastKnownState.pos = pos;
      host.callEvents('bz_ePlayerUpdateEvent', { playerID: id, state: { pos } });
    };
    return { host, state, move, tanks };
  };

  const solo = run('');
  solo.move(1, [1, 1, 1]);
  assert.ok(solo.state.said.some((line) => line.text === '{player} has Hill; will be King in {seconds} secs!'
    && line.params.seconds === 40), 'a hold time not a multiple of 30 is announced');
  solo.state.now = 39;
  solo.move(1, [1, 1, 1]);
  assert.deepEqual(solo.state.killed, []);
  solo.state.now = 40;
  solo.move(1, [1, 1, 1]);
  assert.deepEqual(solo.state.killed, [[2, 1], [3, 1]], 'everyone else dies, killed by the king');
  assert.equal(solo.state.said.at(-1).text, 'You are King of the Hill!  You must leave hill to retake it.');
  solo.state.killed.length = 0;
  solo.state.now = 100;
  solo.move(1, [1, 1, 1]);
  assert.deepEqual(solo.state.killed, [], 'the king must leave before taking it again');

  solo.host.callEvents('bz_ePlayerPausedEvent', { playerID: 1, pause: true });
  assert.deepEqual(solo.state.killed, [[1, -2]], 'no pausing on the hill');

  assert.equal(solo.host.slashCommand(3, 0, '/kothtime 90'), true);
  assert.equal(solo.state.said.at(-1).text, 'You must be admin to use the koth commands.');
  solo.host.slashCommand(1, 0, '/kothtime 90');
  assert.deepEqual(solo.state.said.at(-1).params, { seconds: 90 });

  const team = run('  teamplay\n');
  team.move(1, [1, 1, 1]);
  team.move(2, [2, 2, 1]);
  team.state.now = 40;
  team.move(2, [2, 2, 1]);
  assert.deepEqual(team.state.killed, [[3, -2]], 'the other team dies, killed by the server');
  assert.deepEqual(team.state.team, [{ team: 1, text: 'Your team is King of the Hill!  Entire team must leave hill to retake it.' }]);
}

// holdtheflag: only its team plays, a capture scores the capper and resets
// the flags, and the match end names the winner.
{
  const bundledDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'plugins');
  const said = [];
  const kicked = [];
  const resets = [];
  const host = createPluginHost({
    dirs: [bundledDir],
    settings: { holdtheflag: { team: 'red' } },
    api: {
      BZ_SERVER: -2, BZ_ALLUSERS: -1, eNoTeam: -1, eRogueTeam: 0, eRedTeam: 1, eGreenTeam: 2, eBlueTeam: 3,
      ePurpleTeam: 4, eRabbitTeam: 5, eHunterTeam: 6, eObservers: 7, eAdministrators: 8,
      bz_getPlayerIndexList: () => [],
      bz_getPlayerByIndex: () => null,
      bz_debugMessage: () => {},
      bz_hasPerm: (id, perm) => id === 1 && perm === 'COUNTDOWN',
      bz_resetFlags: (onlyUnused) => { resets.push(onlyUnused); },
      bz_kickUser: (id, reason, notify) => { kicked.push({ id, reason, notify }); return true; },
      bz_sendTextMessage: (from, to, text, params) => { said.push({ to, text, params }); return true; },
    },
  });
  host.loadAll();
  const join = (id, team, callsign) => host.callEvents('bz_ePlayerJoinEvent', { playerID: id, record: { team, callsign } });
  join(1, 1, 'alpha');
  join(2, 1, 'beta');
  join(3, 2, 'green');
  join(4, 7, 'watcher');
  assert.deepEqual(kicked, [{ id: 3, reason: 'HTF mode enabled, you must join the Red team to play', notify: true }]);
  host.callEvents('bz_eGameStartEvent', {});
  host.callEvents('bz_eCaptureEvent', { playerCapping: 2 });
  host.callEvents('bz_eCaptureEvent', { playerCapping: 1 });
  host.callEvents('bz_eCaptureEvent', { playerCapping: 2 });
  assert.deepEqual(resets, [false, false, false], 'every flag back on each capture');
  said.length = 0;
  host.callEvents('bz_eGameEndEvent', {});
  assert.deepEqual(said.map((line) => line.params?.player?.trim() ?? line.text), [
    '**** HTF  Scoreboard ****', 'beta', 'alpha', 'HTF MATCH has ended.', 'beta',
  ]);
  assert.equal(said[1].params.mark, '*', 'the last capper is marked');
  assert.equal(said.at(-1).text, '{player} is the WINNER !');
  host.slashCommand(2, 0, '/htf reset');
  assert.equal(said.at(-1).text, 'you need "{permission}" permission to do /htf {command}');
  host.slashCommand(1, 0, '/htf reset');
  assert.deepEqual(said.at(-1).params, { player: 'alpha' });
}

// keepaway: the listed flags in turn; keeping one for the hold time kills
// everyone else and names the next.
{
  const map = `keepaway
  keepawayflags GM XX L
  holdtime 40
end
`;
  const bundledDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'plugins');
  let now = 0;
  const killed = [];
  const said = [];
  const removed = [];
  const held = new Map();
  const tanks = new Map([
    [1, { playerID: 1, callsign: 'keeper', team: 1, spawned: true, admin: true }],
    [2, { playerID: 2, callsign: 'chaser', team: 2, spawned: true, admin: false }],
  ]);
  const host = createPluginHost({
    dirs: [bundledDir],
    settings: { keepaway: true },
    api: {
      BZ_SERVER: -2, BZ_ALLUSERS: -1, eNoTeam: -1, eRogueTeam: 0, eRedTeam: 1, eGreenTeam: 2, eBlueTeam: 3, ePurpleTeam: 4,
      bz_customMapObjects: (name) => scanCustomMapObjects(map, name),
      bz_getCurrentTime: () => now,
      bz_getTeamCount: (team) => [...tanks.values()].filter((tank) => tank.team === team).length,
      bz_getPlayerIndexList: () => [...tanks.keys()],
      bz_getPlayerByIndex: (id) => tanks.get(id) ?? null,
      bz_getPlayerFlag: (id) => held.get(id) ?? null,
      bz_removePlayerFlag: (id) => { removed.push(id); held.delete(id); return true; },
      bz_killPlayer: (id, _base, killer) => { killed.push([id, killer]); return true; },
      bz_resetFlags: () => {},
      bz_sendPlayCustomLocalSound: () => false,
      bz_sendTextMessage: (from, to, text, params) => { said.push({ to, text, params }); return true; },
      bz_sendTextMessageToTeam: () => true,
    },
  });
  host.loadAll();
  for (const id of tanks.keys()) host.callEvents('bz_ePlayerJoinEvent', { playerID: id, record: tanks.get(id) });
  assert.deepEqual(said.at(-1).params, { flag: 'Guided Missile (GM)', seconds: 40 }, 'the first flag, told on joining');
  const update = () => host.callEvents('bz_ePlayerUpdateEvent', { playerID: 1, state: { pos: [0, 0, 0] } });
  update();
  assert.equal(said.at(-1).text, 'Keep Away flag: {flag} is free; find it and keep it!');
  held.set(1, 'GM');
  update();
  assert.equal(said.at(-1).text, '{player} has {flag} flag; {seconds} secs left!');
  now = 40;
  update();
  assert.deepEqual(killed, [[2, 1]], 'the other tank dies, killed by the keeper');
  assert.deepEqual(removed, [1], 'the kept flag is given up');
  host.slashCommand(2, 0, '/kaf');
  assert.deepEqual(said.at(-1).params, { flag: 'Laser (L)' }, 'XX is no flag, so L is next');
  host.slashCommand(1, 0, '/kaf+');
  assert.deepEqual(said.at(-1).params, { flag: 'Guided Missile (GM)' }, 'and the list goes round');
}

// chathistory, timelimit, timedctf and fairctf against a stub server.
{
  const bundledDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'plugins');
  const TEAMS = {
    BZ_SERVER: -2, BZ_ALLUSERS: -1, eNoTeam: -1, eRogueTeam: 0, eRedTeam: 1, eGreenTeam: 2, eBlueTeam: 3,
    ePurpleTeam: 4, eObservers: 7, eAdministrators: 8,
  };
  const stub = (id, api) => {
    const state = { said: [], team: [] };
    const host = createPluginHost({
      dirs: [bundledDir],
      settings: { [id]: api.config ?? true },
      api: {
        ...TEAMS,
        bz_sendTextMessage: (from, to, text, params) => { state.said.push({ from, to, text, params }); return true; },
        bz_sendTextMessageToTeam: (from, team, text, params) => { state.team.push({ team, text, params }); return true; },
        bz_sendPlayCustomLocalSound: () => false,
        ...api,
      },
    });
    host.loadAll();
    return { host, state };
  };

  // chathistory: admins read back what a callsign said, oldest first.
  {
    const { host, state } = stub('chathistory', {
      config: { lines: 2 },
      bz_getAdmin: (id) => id === 1,
      bz_getPlayerByIndex: (id) => ({ playerID: id, callsign: id === 1 ? 'Admin' : 'Talker' }),
    });
    for (const message of ['one', 'two', 'three']) host.callEvents('bz_eRawChatMessageEvent', { from: 2, message });
    host.slashCommand(2, 0, '/last 5 talker');
    assert.equal(state.said.at(-1).text, 'You must be admin to use the ChatHistory plugin');
    host.slashCommand(1, 0, '/last 5 TALKER');
    assert.deepEqual(state.said.slice(-3).map((line) => line.params.message ?? line.params.count), [2, 'two', 'three']);
  }

  // timelimit: the next match's length, back to the server's own after it.
  {
    let limit = 600;
    const { host, state } = stub('timelimit', {
      config: { times: '10,15' },
      bz_getTimeLimit: () => limit,
      bz_setTimeLimit: (seconds) => { limit = seconds; return true; },
      bz_isTimeManualStart: () => true,
      bz_isCountDownActive: () => false,
      bz_isCountDownInProgress: () => false,
      bz_getPlayerCount: () => 2,
      bz_hasPerm: () => true,
      bz_getPlayerByIndex: () => ({ callsign: 'op' }),
    });
    host.slashCommand(1, 0, '/timelimit 12');
    assert.equal(limit, 600, 'not in the list');
    assert.deepEqual(state.said.slice(-2).map((line) => line.params?.minutes), [10, 15]);
    host.slashCommand(1, 0, '/timelimit 15');
    assert.equal(limit, 900);
    host.callEvents('bz_eGameEndEvent', {});
    assert.equal(limit, 600, 'back after the match');
  }

  // timedctf: a team that does not capture in time dies.
  {
    let now = 0;
    const killed = [];
    const tanks = [{ playerID: 1, team: 1 }, { playerID: 2, team: 2 }];
    const { host, state } = stub('timedctf', {
      config: { minutes: 1 },
      bz_getCurrentTime: () => now,
      bz_getTeamCount: (team) => tanks.filter((tank) => tank.team === team).length,
      bz_getPlayerIndexList: () => tanks.map((tank) => tank.playerID),
      bz_getPlayerByIndex: (id) => tanks.find((tank) => tank.playerID === id) ?? null,
      bz_killPlayer: (id) => { killed.push(id); return true; },
    });
    host.callEvents('bz_eTickEvent', {});
    assert.equal(state.said.at(-1).text, 'Timed CTF now in progress - capture a flag in less than {minutes} minute(s)!');
    now = 30;
    host.callEvents('bz_eCaptureEvent', { teamCapping: 1 });
    assert.equal(state.team.at(-1).params.team, 'red');
    now = 61;
    host.callEvents('bz_eTickEvent', {});
    assert.deepEqual(killed, [], 'a warning due first takes the tick, as upstream');
    now = 62;
    host.callEvents('bz_eTickEvent', {});
    assert.deepEqual(killed, [2], 'green never captured');
    assert.deepEqual(state.said.at(-1).params, { team: 'GREEN' });
  }

  // fairctf: uneven teams refuse team flags, and a held one goes after the delay.
  {
    let now = 0;
    const counts = { 1: 1, 2: 0 };
    const removed = [];
    const { host, state } = stub('fairctf', {
      config: { dropDelay: 3 },
      bz_getCurrentTime: () => now,
      bz_getTeamCount: (team) => counts[team] ?? 0,
      bz_getPlayerIndexList: () => [1],
      bz_getPlayerFlag: () => 'G*',
      bz_getFlagName: () => 'R*',
      bz_getPlayerByIndex: () => ({ callsign: 'red', currentFlag: 'Green Team (+G*)' }),
      bz_removePlayerFlag: (id) => { removed.push(id); return true; },
      bz_hasPerm: () => true,
    });
    counts[2] = 4;
    host.callEvents('bz_ePlayerJoinEvent', { playerID: 2 });
    assert.equal(state.said.at(-1).text, 'Currently-held team flags will be dropped in {seconds} seconds.');
    const grab = host.callEvents('bz_eAllowFlagGrab', { playerID: 1, flagID: 0, allow: true });
    assert.equal(grab.allow, false);
    now = 3;
    host.callEvents('bz_eTickEvent', {});
    assert.deepEqual(removed, [1]);
    host.slashCommand(1, 0, '/ctf on');
    assert.equal(state.team.at(-1).team, 8, 'the admins hear who changed it');
    assert.equal(host.callEvents('bz_eAllowFlagGrab', { playerID: 1, flagID: 0, allow: true }).allow, true);
  }
}

// mapchange: a new game on a listed map, never during a match.
{
  const bundledDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'plugins');
  const said = [];
  const changes = [];
  const kicked = [];
  const host = createPluginHost({
    dirs: [bundledDir],
    settings: { mapchange: { maps: 'HiX hix.bzw, bzo bzo.bzw, Gone gone.bzw' } },
    api: {
      BZ_SERVER: -2, BZ_ALLUSERS: -1,
      bz_getPlayerByIndex: (id) => ({ playerID: id, callsign: id === 1 ? 'op' : 'pleb' }),
      bz_hasPerm: (id, perm) => id === 1 && perm === 'MAPCHANGE',
      bz_changeMap: (file, by) => { changes.push([file, by]); return file === 'gone.bzw' ? 'Map file not found' : true; },
      bz_kickUser: (id) => { kicked.push(id); return true; },
      bz_sendTextMessage: (from, to, text, params) => { said.push({ to, text, params }); return true; },
    },
  });
  host.loadAll();
  host.slashCommand(2, 0, '/maplist');
  assert.deepEqual(said.slice(-3).map((line) => line.params.name), ['HiX', 'bzo', 'Gone']);
  host.slashCommand(2, 0, '/mapchange hix');
  assert.equal(said.at(-1).text, 'Sorry, you are not allowed to change configurations on this server');
  host.slashCommand(1, 0, '/mapchange hix');
  assert.deepEqual(changes, [['hix.bzw', '"op" via /mapchange']]);
  assert.deepEqual(said.at(-1).params, { name: 'HiX', player: 'op' });
  host.slashCommand(1, 0, '/mapchange gone');
  assert.deepEqual(said.at(-1).params, { name: 'Gone', error: 'Map file not found' }, 'nothing announced when it fails');
  host.callEvents('bz_eGameStartEvent', {});
  host.slashCommand(1, 0, '/mapchange hix');
  assert.deepEqual(kicked, [1], 'not during a match');
}

// Web pages: upstream's VDir at /plugins/<name>/, its Request and Response,
// eWaitForIt asked again, and the page gone with its plugin.
{
  const dir = path.join(root, 'web');
  fs.mkdirSync(dir);
  write(dir, 'stats', `module.exports = {
    meta: { name: 'Stats', version: '1.0', author: 'a', description: 'd' },
    Init(bz) {
      let polls = 0;
      bz.bzhttp_RegisterVDir(this, {
        VDirName: () => 'stats',
        VDirDescription: () => 'Scores & <more>',
        GeneratePage(request, response) {
          if (request.Resource.endsWith('/missing')) return bz.eNoPage;
          if (request.Resource.endsWith('/throw')) throw new Error('boom');
          if (request.Resource.endsWith('/slow') && ++polls < 3) return bz.eWaitForIt;
          if (request.Resource.endsWith('/go')) {
            response.ReturnCode = bz.e302Found;
            response.RedirectLocation = '/elsewhere';
            return bz.ePageDone;
          }
          response.ReturnCode = bz.e200OK;
          response.DocumentType = bz.eJSON;
          response.ForceNoCache = true;
          response.AddHeader('X-Plugin', 'stats');
          response.AddBodyData(JSON.stringify({
            type: request.RequestType, resource: request.Resource, who: request.GetParamater('who'),
            form: request.GetParamater('team'), header: request.GetHeader('X-TEST'), polls,
          }));
          return bz.ePageDone;
        },
      });
      module.exports.twice = bz.bzhttp_RegisterVDir({ VDirName: () => 'STATS', GeneratePage: () => 2 });
    },
  };`);
  const host = createPluginHost({ dirs: [dir], log: () => {}, settings: { stats: true } });
  host.loadAll();
  assert.equal(host.list()[0].state, 'loaded', host.list()[0].error);
  assert.equal(require(path.join(dir, 'stats.cjs')).twice, false, 'one page set per name, in any case');
  const errors = [];
  const app = express();
  app.use('/plugins', express.raw({ type: () => true }), (req, res) => {
    const [, name = '', ...rest] = req.path.split('/');
    if (!name) { res.type('html').send(indexPage(host.webPages(), 'here')); return; }
    const page = host.webPage(name);
    if (!page || rest.length === 0) { res.status(404).end(); return; }
    servePage(page.vdir, page.name, req, res, { body: req.body, address: '1.2.3.4', report: (e) => errors.push(e) });
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/plugins`;
  try {
    const index = await (await fetch(`${base}/`)).text();
    assert.ok(index.includes('<a href="/plugins/stats/">stats</a>&nbsp;Scores &#38; &#60;more&#62;'), index);

    const got = await fetch(`${base}/STATS/x?who=me`, { headers: { 'X-Test': 'yes' } });
    assert.equal(got.status, 200);
    assert.match(got.headers.get('content-type'), /^application\/json/);
    assert.equal(got.headers.get('cache-control'), 'no-cache');
    assert.equal(got.headers.get('x-plugin'), 'stats');
    assert.deepEqual(await got.json(), {
      type: 1, resource: '/plugins/STATS/x', who: 'me', form: null, header: 'yes', polls: 0,
    });

    const posted = await (await fetch(`${base}/stats/x`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'team=red',
    })).json();
    assert.equal(posted.type, 3);
    assert.equal(posted.form, 'red', 'a form POST joins the parameters');

    assert.equal((await fetch(`${base}/stats/missing`)).status, 404);
    assert.equal((await fetch(`${base}/stats/throw`)).status, 500);
    assert.equal(errors.length, 1);
    const go = await fetch(`${base}/stats/go`, { redirect: 'manual' });
    assert.equal(go.status, 302);
    assert.equal(go.headers.get('location'), '/elsewhere');
    assert.equal((await (await fetch(`${base}/stats/slow`)).json()).polls, 3, 'eWaitForIt asks again');

    host.unload('stats');
    assert.equal(host.webPage('stats'), null, 'its pages go with it');
    assert.ok((await (await fetch(`${base}/`)).text()).includes('No HTTP Services'));
  } finally {
    server.close();
  }
}

fs.rmSync(root, { recursive: true, force: true });
console.log('plugin host tests passed');
