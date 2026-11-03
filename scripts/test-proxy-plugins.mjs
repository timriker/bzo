#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// What upstream's own plugins, running in a real bzfs, send a proxied player
// (docs/plugins-plan.md, "Behind the proxy"): each case starts a private bzfs
// with the plugin's `.so` and joins it through `BzfsSession`, the proxy's own
// connection. Skipped where bzfs or its plugins are not installed.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BzfsSession } = require('../server/bzfs-session.cjs');

const PLUGIN_DIR = '/usr/lib/bzflag-server';
const RED = 1;
const GREEN = 2;
const SERVER_PLAYER = 253;
const NO_TEAM = 0xffff;

try {
  execFileSync('bzfs', ['-version'], { stdio: 'ignore' });
} catch {
  console.log('test-proxy-plugins: bzfs is not installed, skipped');
  process.exit(0);
}
if (!fs.existsSync(`${PLUGIN_DIR}/HoldTheFlag.so`)) {
  console.log(`test-proxy-plugins: no plugins in ${PLUGIN_DIR}, skipped`);
  process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// A bzfs on its own port, ready once it accepts a connection.
async function startBzfs(args) {
  const port = await freePort();
  const child = spawn('bzfs', ['-p', String(port), '-passwd', 'secret', ...args], { stdio: 'ignore' });
  for (let tries = 0; tries < 50; tries += 1) {
    const up = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => { socket.destroy(); resolve(true); });
      socket.on('error', () => resolve(false));
    });
    if (up) return { port, stop: () => child.kill() };
    await sleep(100);
  }
  child.kill();
  throw new Error('bzfs did not start');
}

function join(port, callsign, team) {
  const session = new BzfsSession({ host: '127.0.0.1', port, callsign, team, version: '2.4.30' });
  const seen = { messages: [], killed: [], scoreOver: [], flagTypes: [], closed: null };
  session.on('message', (message) => seen.messages.push(message.text));
  session.on('killed', (death) => seen.killed.push(death));
  session.on('scoreOver', (over) => seen.scoreOver.push(over));
  session.on('flagType', (type) => seen.flagTypes.push(type.abbreviation));
  seen.shots = [];
  seen.grabs = [];
  session.on('shotBegin', (shot) => seen.shots.push(shot));
  session.on('grab', (grab) => seen.grabs.push(grab));
  session.on('close', (error) => { seen.closed = error ?? {}; });
  return { session, seen };
}

async function say(session, ...lines) {
  for (const line of lines) {
    session.sendChat(254, line);
    await sleep(400);
  }
}

// HoldTheFlag kicks a player on the wrong team as they join: the reason
// first, then MsgSuperKill, which the proxy turns into a kick.
{
  const bzfs = await startBzfs(['-c', '-loadplugin', `${PLUGIN_DIR}/HoldTheFlag.so,team=green`]);
  try {
    const { session } = join(bzfs.port, 'wrongteam', RED);
    const error = await session.connect().then(() => null, (failure) => failure);
    assert.equal(error?.superKill, true, 'dropped as it joined');
    assert.ok(session.state.messages.some((text) => text.startsWith('You have been kicked from the server for: HTF')),
      'the reason came first');
  } finally {
    bzfs.stop();
  }
}

// killall: everyone dies, killed by the server; then an admin's /kick and
// /gameover.
{
  const bzfs = await startBzfs(['-loadplugin', `${PLUGIN_DIR}/killall.so`]);
  try {
    const admin = join(bzfs.port, 'admin', RED);
    const victim = join(bzfs.port, 'victim', GREEN);
    await admin.session.connect();
    await victim.session.connect();
    admin.session.sendAlive();
    victim.session.sendAlive();
    await sleep(500);
    await say(admin.session, '/password secret', '/killall');
    assert.ok(victim.seen.killed.some((death) => death.victim === victim.session.playerId && death.killer === SERVER_PLAYER),
      'killed by the server');
    await say(admin.session, '/gameover');
    assert.deepEqual(victim.seen.scoreOver, [{ player: admin.session.playerId, team: NO_TEAM }], 'the game is over');
    await say(admin.session, '/kick victim testing');
    assert.equal(victim.seen.closed?.superKill, true, 'kicked, not a lost link');
    assert.ok(victim.seen.messages.includes('Reason given: testing'));
    admin.session.close();
  } finally {
    bzfs.stop();
  }
}

// customflagsample: a flag registered while a player is in is announced.
{
  const bzfs = await startBzfs([]);
  try {
    const admin = join(bzfs.port, 'admin', RED);
    await admin.session.connect();
    await say(admin.session, '/password secret', `/loadplugin ${PLUGIN_DIR}/customflagsample.so`);
    assert.deepEqual(admin.seen.flagTypes, ['CF']);
    admin.session.close();
  } finally {
    bzfs.stop();
  }
}

// shockwaveDeath: a death sets off a shock wave fired by the server, which
// the proxy forwards like any other shot.
{
  const bzfs = await startBzfs(['-loadplugin', `${PLUGIN_DIR}/killall.so`,
    '-loadplugin', `${PLUGIN_DIR}/shockwaveDeath.so`]);
  try {
    const admin = join(bzfs.port, 'admin', RED);
    const victim = join(bzfs.port, 'victim', GREEN);
    await admin.session.connect();
    await victim.session.connect();
    admin.session.sendAlive();
    victim.session.sendAlive();
    await sleep(500);
    await say(admin.session, '/password secret', '/killall');
    assert.ok(victim.seen.shots.some((shot) => shot.player === SERVER_PLAYER && shot.flag === 'SW'),
      'a server shock wave');
    admin.session.close();
    victim.session.close();
  } finally {
    bzfs.stop();
  }
}

// fairCTF: with uneven teams a team flag cannot be grabbed, and the player is
// told why; with even ones it can.
async function grabTeamFlag(players) {
  const bzfs = await startBzfs(['-c', '-loadplugin', `${PLUGIN_DIR}/fairCTF.so`]);
  try {
    const joined = [];
    for (const [index, team] of players.entries()) {
      const player = join(bzfs.port, `p${index}`, team);
      await player.session.connect();
      player.session.sendAlive();
      joined.push(player);
    }
    await sleep(500);
    const [grabber] = joined;
    const flag = grabber.session.state.flags.find((candidate) => candidate?.type === 'G*');
    grabber.session.sendPlayerUpdate({ pos: flag.position });
    await sleep(200);
    grabber.session.sendGrabFlag(flag.index);
    await sleep(500);
    for (const player of joined) player.session.close();
    return grabber.seen;
  } finally {
    bzfs.stop();
  }
}
{
  const refused = await grabTeamFlag([RED, RED, GREEN]);
  assert.equal(refused.grabs.length, 0, 'uneven: no grab');
  assert.ok(refused.messages.includes('CTF play is currently disabled.'), 'and told why');
  const allowed = await grabTeamFlag([RED, GREEN]);
  assert.equal(allowed.grabs.length, 1, 'even: grabbed');
}

console.log('test-proxy-plugins: ok');
process.exit(0);
