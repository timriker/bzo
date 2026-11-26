#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// When the world tracker asks a bzfs what an unregistered player may do
// (`server/bzfs-worlds.cjs`): watching, chat and spawning on a visit made only
// with nobody on the server, a busy server asked again twenty minutes on, a
// month's trust in an answer, a week before an unanswered one is tried again,
// and a silence never over an answer. The world variables ride on the same
// join, and an import of a busy server's new world joins for nothing.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBzfsWorldTracker, GUEST_RECHECK_MS, GUEST_RETRY_MS } = require('../server/bzfs-worlds.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzo-guest-'));
const server = { host: 'example.org', port: 5154, title: 't', info: {} };
let status = { worldHash: 'p'.padEnd(33, '0'), players: 0, observers: 0, full: false };
let answer = { watch: 'yes', chat: 'yes', spawn: 'no', spawnDetail: 'spawning is off for guests' };
const probes = [];
const realNow = Date.now;
let clock = 1e12;
Date.now = () => clock;

const tracker = createBzfsWorldTracker({
  statePath: path.join(dir, 'state.json'),
  queryServerStatus: async () => status,
  importWorld: async () => { throw new Error('no import expected'); },
  probeGuestAccess: async (host, port, questions) => {
    probes.push(questions);
    return {
      watch: answer.watch,
      chat: answer.chat,
      ...(questions.spawn ? { spawn: answer.spawn ?? 'unknown', spawnDetail: answer.spawnDetail } : {}),
      ...(answer.watch === 'yes' ? { variables: [['_gravity', '-20']] } : {}),
    };
  },
  hasPicture: () => true,
  log: () => {},
  logError: () => {},
});
tracker.observe([server]);
// A world already held, so a visit is only for the guest questions.
tracker.noteImport(server.host, server.port, status.worldHash, null, []);
const check = async (advance) => { clock += advance; await tracker.tick() };

// Empty: both questions, in one visit.
await check(25 * 60 * 60 * 1000);
assert.deepEqual(probes.at(-1), { chat: true, spawn: true });
let guest = tracker.recordFor(server.host, server.port).guest;
assert.equal(guest.watch, 'yes', 'the join itself answers watching');
assert.equal(guest.chat, 'yes');
assert.equal(guest.spawn, 'no');
assert.deepEqual(tracker.storedVariables(server.host, server.port), [['_gravity', '-20']],
  'the variables come back on the same join');

// The next day: nothing is due, so no visit.
await check(25 * 60 * 60 * 1000);
assert.equal(probes.length, 1, 'answers are trusted');

// A month on, with players on: no join at all. The server owes one and is
// dialled again in twenty minutes, and joined once it has emptied.
status = { ...status, players: 3 };
const before = probes.length;
await check(GUEST_RECHECK_MS + 3600000);
assert.equal(probes.length, before, 'no join while anybody is on');
assert.equal(tracker.recordFor(server.host, server.port).joinOwed, true);
await check(21 * 60 * 1000);
assert.equal(probes.length, before, 'still busy, still no join');
status = { ...status, players: 0, observers: 1 };
await check(21 * 60 * 1000);
assert.equal(probes.length, before, 'an observer counts as somebody');
status = { ...status, observers: 0 };
await check(21 * 60 * 1000);
assert.deepEqual(probes.at(-1), { chat: true, spawn: true });
assert.equal(tracker.recordFor(server.host, server.port).joinOwed, false);

// A silence keeps the answer it had, and waits its week.
answer = { watch: 'unknown', chat: 'unknown' };
await check(GUEST_RECHECK_MS + 3600000);
guest = tracker.recordFor(server.host, server.port).guest;
assert.equal(guest.chat, 'yes', 'a silence does not overwrite an answer');
assert.equal(guest.watch, 'yes');
const visits = probes.length;
await check(25 * 60 * 60 * 1000);
assert.equal(probes.length, visits, 'and is not retried the next day');

// An admin's real visit is an answer too.
tracker.noteGuest(server.host, server.port, { spawn: 'yes', spawnDetail: '' });
assert.equal(tracker.recordFor(server.host, server.port).guest.spawn, 'yes');
assert.ok(GUEST_RETRY_MS < GUEST_RECHECK_MS);

// A ban is the latest join's answer: kept through a visit that learned
// nothing about it, cleared by a join that was let in.
tracker.noteGuest(server.host, server.port, { watch: 'unknown', watchDetail: 'rejected, code 9', banned: true });
assert.equal(tracker.recordFor(server.host, server.port).guest.banned, true);
tracker.noteGuest(server.host, server.port, { chat: 'yes' });
assert.equal(tracker.recordFor(server.host, server.port).guest.banned, true, 'kept by a visit that did not join');
tracker.noteGuest(server.host, server.port, { watch: 'yes', banned: false });
assert.equal(tracker.recordFor(server.host, server.port).guest.banned, false);

// A server its operator asked bzo to leave alone (`excludeServers`) is never
// dialled, for its world or its guest questions, however overdue.
{
  const excluded = { host: 'leave.example.org', port: 5155, title: 'x', info: {} };
  const dials = [];
  const quiet = createBzfsWorldTracker({
    statePath: path.join(dir, 'excluded.json'),
    queryServerStatus: async (host) => { dials.push(host); return status; },
    importWorld: async (host) => { dials.push(host); },
    probeGuestAccess: async (host) => { dials.push(host); return {}; },
    hasPicture: () => false,
    isExcluded: (host) => host === excluded.host,
    log: () => {},
    logError: () => {},
  });
  quiet.observe([excluded]);
  clock += 40 * 24 * 60 * 60 * 1000;
  await quiet.tick();
  assert.deepEqual(dials, [], 'an excluded server is never dialled');
}

// A server that excludes bzo is not dialled at all for a month -- no hash check,
// no world -- then asked only whether the ban still stands, with one join.
{
  const banning = { host: 'ban.example.org', port: 5156, title: 'b', info: {} };
  const calls = [];
  let stillBanned = true;
  const wary = createBzfsWorldTracker({
    statePath: path.join(dir, 'banned.json'),
    queryServerStatus: async () => { calls.push('dial'); return status; },
    importWorld: async () => { calls.push('import'); },
    probeGuestAccess: async (host, port, questions) => {
      calls.push(`join${questions.spawn ? '+spawn' : ''}`);
      return { watch: stillBanned ? 'unknown' : 'yes', banned: stillBanned };
    },
    hasPicture: () => true,
    log: () => {},
    logError: () => {},
  });
  wary.observe([banning]);
  wary.noteImport(banning.host, banning.port, status.worldHash, null, []);
  wary.noteGuest(banning.host, banning.port, { watch: 'unknown', banned: true });
  clock += 2 * 24 * 60 * 60 * 1000;
  await wary.tick();
  assert.deepEqual(calls, [], 'a fresh ban is not dialled, hash check included');
  clock += GUEST_RECHECK_MS;
  await wary.tick();
  assert.deepEqual(calls, ['join'], 'a month on, one join asks whether the ban stands');
  clock += 2 * 24 * 60 * 60 * 1000;
  await wary.tick();
  assert.deepEqual(calls, ['join'], 'and a ban that stands waits another month');
  stillBanned = false;
  clock += GUEST_RECHECK_MS;
  await wary.tick();
  assert.equal(wary.recordFor(banning.host, banning.port).guest.banned, false, 'a lifted ban is noticed');
  assert.equal(wary.recordFor(banning.host, banning.port).dueNow, true, 'and the server is due again at once');
}

// A busy server's new world comes down without a join, keeping the variables
// already held; the join waits until the server is empty.
{
  const busy = { host: 'busy.example.org', port: 5157, title: 'n', info: {} };
  const imports = [];
  let pictured = false;
  let hash = 'p'.padEnd(33, '1');
  status = { worldHash: hash, players: 2, observers: 0, full: false };
  const joins = [];
  const busyTracker = createBzfsWorldTracker({
    statePath: path.join(dir, 'busy.json'),
    queryServerStatus: async () => ({ ...status, worldHash: hash }),
    importWorld: async (host, port, guest, enter) => {
      imports.push({ guest, enter });
      pictured = true;
      return { safeMapName: 'import-busy.bzw' };
    },
    probeGuestAccess: async () => { joins.push('join'); return { watch: 'yes', chat: 'yes', spawn: 'no', variables: [] }; },
    hasPicture: () => pictured,
    log: () => {},
    logError: () => {},
  });
  busyTracker.observe([busy]);
  await busyTracker.tick();
  assert.deepEqual(imports, [{ guest: null, enter: false }], 'a busy server\'s world, no join');
  assert.equal(busyTracker.recordFor(busy.host, busy.port).joinOwed, true);
  status = { ...status, players: 0 };
  clock += 21 * 60 * 1000;
  await busyTracker.tick();
  assert.deepEqual(joins, ['join'], 'joined once empty');
  assert.deepEqual(busyTracker.storedVariables(busy.host, busy.port), []);
  // A generated world rolled by a restart is no reason to read them again.
  hash = 't'.padEnd(33, '2');
  pictured = false;
  status = { ...status, players: 0 };
  clock += 2 * 60 * 60 * 1000;
  await busyTracker.tick();
  assert.equal(imports.at(-1).enter, false, 'a new generated world joins for nothing');
}

// Robots see nothing: a server with only robots on it is joined.
{
  const bots = { host: 'bots.example.org', port: 5158, title: 'r', info: {} };
  const joins = [];
  const botTracker = createBzfsWorldTracker({
    statePath: path.join(dir, 'bots.json'),
    queryServerStatus: async () => ({ worldHash: 'p'.padEnd(33, '3'), players: 4, observers: 0, humans: 0, full: false }),
    importWorld: async () => { throw new Error('no import expected'); },
    probeGuestAccess: async () => { joins.push('join'); return { watch: 'yes', chat: 'yes', spawn: 'no', variables: [] }; },
    hasPicture: () => true,
    log: () => {},
    logError: () => {},
  });
  botTracker.observe([bots]);
  botTracker.noteImport(bots.host, bots.port, 'p'.padEnd(33, '3'), null, null);
  clock += 25 * 60 * 60 * 1000;
  await botTracker.tick();
  assert.deepEqual(joins, ['join'], 'a server with only robots on it is joined');
}

Date.now = realNow;
fs.rmSync(dir, { recursive: true, force: true });
console.log('guest check tests passed');
