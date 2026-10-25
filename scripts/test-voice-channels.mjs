#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The voice-channels module, as the client imports it and as the server
// requires it. The client offers the channels and the server enforces them,
// so a disagreement means a player is shown a room the server will not put
// them in.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as client from '../public/js/voice-channels.mjs';

const require = createRequire(import.meta.url);
const server = require('../public/js/voice-channels.mjs');

const NEARBY_RADIUS = 60;

assert.deepEqual(
  client.VOICE_CHANNELS.map((channel) => channel.id),
  ['all', 'nearby', 'team'],
);
client.VOICE_CHANNELS.forEach((channel) => {
  assert.ok(channel.label, `${channel.id} has no label`);
  assert.ok(channel.hint, `${channel.id} has no hint`);
});
// All rather than Nearby, so a fresh multi-device test session can hear
// everyone without an extra step.
assert.equal(client.DEFAULT_VOICE_CHANNEL, client.VOICE_CHANNEL_ALL);

// Anything unrecognized lands on the default rather than on nothing, so an
// older or newer client still has a voice.
for (const value of ['all', 'ALL', ' Team ', 'nearby', 'global', '', null, undefined, 7, {}]) {
  const expected = ['all', 'nearby', 'team'].includes(String(value).trim().toLowerCase())
    ? String(value).trim().toLowerCase()
    : client.DEFAULT_VOICE_CHANNEL;
  assert.equal(client.normalizeVoiceChannel(value), expected, `client normalize ${String(value)}`);
  assert.equal(server.normalizeVoiceChannel(value), expected, `server normalize ${String(value)}`);
}

assert.equal(client.voiceChannelUsesDistance('nearby'), true);
assert.equal(client.voiceChannelUsesDistance('all'), false);
assert.equal(client.voiceChannelUsesDistance('team'), false);

const near = { team: 'rogue', voiceChannel: 'nearby' };
const CASES = [
  // [description, source, target, planarDistance, expected]
  ['nearby pairs two players within the radius', near, { ...near }, 10, true],
  ['nearby drops a player past the radius', near, { ...near }, 61, false],
  ['nearby takes the radius as inclusive', near, { ...near }, NEARBY_RADIUS, true],
  ['nearby crosses teams', near, { ...near, team: 'red' }, 10, true],
  ['nearby refuses a peer with no position', near, { ...near }, Infinity, false],
  ['all ignores distance',
    { team: 'rogue', voiceChannel: 'all' }, { team: 'red', voiceChannel: 'all' }, 9999, true],
  ['all ignores a missing position',
    { team: 'rogue', voiceChannel: 'all' }, { team: 'red', voiceChannel: 'all' }, Infinity, true],
  ['team pairs a team across the map',
    { team: 'red', voiceChannel: 'team' }, { team: 'red', voiceChannel: 'team' }, 9999, true],
  ['team refuses another team standing right there',
    { team: 'red', voiceChannel: 'team' }, { team: 'blue', voiceChannel: 'team' }, 1, false],
  ['team treats rogue as a team',
    { team: 'rogue', voiceChannel: 'team' }, { team: 'rogue', voiceChannel: 'team' }, 9999, true],
  ['team treats observer as a team',
    { team: 'observer', voiceChannel: 'team' }, { team: 'observer', voiceChannel: 'team' }, 9999, true],
  ['a channel is a room: two rooms never connect',
    { team: 'rogue', voiceChannel: 'all' }, { team: 'rogue', voiceChannel: 'nearby' }, 1, false],
  ['an unset channel defaults to nearby on both ends',
    { team: 'rogue' }, { team: 'rogue' }, 10, true],
];

for (const [description, source, target, distance, expected] of CASES) {
  for (const [side, impl] of [['client', client], ['server', server]]) {
    assert.equal(
      impl.areVoicePeers(source, target, distance, NEARBY_RADIUS),
      expected,
      `${side}: ${description}`,
    );
    // The rule has to read the same from either end, or one player opens a
    // connection the other will not answer.
    assert.equal(
      impl.areVoicePeers(target, source, distance, NEARBY_RADIUS),
      expected,
      `${side}: ${description} (reversed)`,
    );
  }
}

console.log('voice channel tests passed');
