#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// When the world tracker asks a bzfs what an unregistered player may do
// (`server/bzfs-worlds.cjs`): watching and chat on any visit that is due, spawning only with
// nobody on the server, a month's trust in an answer, a week before an
// unanswered one is tried again, and a silence never over an answer.

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
    return { watch: answer.watch, chat: answer.chat, ...(questions.spawn ? { spawn: answer.spawn, spawnDetail: answer.spawnDetail } : {}) };
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

// The next day: nothing is due, so no visit.
await check(25 * 60 * 60 * 1000);
assert.equal(probes.length, 1, 'answers are trusted');

// A month on, with players on: chat is asked, spawning is not.
status = { ...status, players: 3 };
await check(GUEST_RECHECK_MS + 3600000);
assert.deepEqual(probes.at(-1), { chat: true, spawn: false });

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

Date.now = realNow;
fs.rmSync(dir, { recursive: true, force: true });
console.log('guest check tests passed');
