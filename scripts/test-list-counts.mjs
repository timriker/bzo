#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Who the server lists count (server/list-counts.cjs): people at the controls
// as players, bots and autopilot beside them, and the rabbit and hunters as
// rogues.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listCounts, bzflagTeamCounts } = require('../server/list-counts.cjs');
const { BZFLAG_MP_TEAM_ORDER } = require('../server/teams.cjs');

const tank = (team, extra = {}) => ({ joined: true, team, ...extra });
const players = [
  tank('red'),
  tank('red', { autopilot: true }),
  tank('blue', { bot: true }),
  tank('rabbit'),
  tank('hunter'),
  tank('hunter', { autopilot: true }),
  tank('observer'),
  { joined: false, team: 'green' },
];
const slot = (team) => BZFLAG_MP_TEAM_ORDER.indexOf(team);

// bzo's own list.
{
  const counts = listCounts(players, BZFLAG_MP_TEAM_ORDER);
  assert.equal(counts.players, 3, 'people at the controls: the red, the rabbit and a hunter');
  assert.equal(counts.autopilot, 2, 'the red and the hunter on autopilot');
  assert.equal(counts.bots, 1);
  assert.equal(counts.teamCounts[slot('rogue')], 3, 'the rabbit and both hunters are rogues');
  assert.equal(counts.teamCounts[slot('red')], 2, 'every red tank, autopilot included');
  assert.equal(counts.teamCounts[slot('blue')], 1, 'bots in the team counts');
  assert.equal(counts.teamCounts[slot('observer')], 1);
  assert.equal(counts.teamCounts[slot('green')], 0, 'nobody who has not joined');
}

// The BZFlag list: humans at the controls only, or every tank for the ping.
{
  const counts = bzflagTeamCounts(players, BZFLAG_MP_TEAM_ORDER);
  assert.equal(counts[slot('red')], 1, 'autopilot is not a player on the BZFlag list');
  assert.equal(counts[slot('blue')], 0, 'nor is a bot');
  assert.equal(counts[slot('rogue')], 2, 'the rabbit and the hunter at the controls');
  const ping = bzflagTeamCounts(players, BZFLAG_MP_TEAM_ORDER, { withBots: true });
  assert.equal(ping[slot('red')], 2);
  assert.equal(ping[slot('blue')], 1);
  assert.equal(ping[slot('rogue')], 3);
}

console.log('list count tests passed');
