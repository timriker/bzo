/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  PLAYER_TEAM,
  PLAYER_TEAMS,
  PLAYER_TEAM_LABELS,
  getPlayerTeamColor,
  getPlayerTeamSelections,
  isColorTeam,
  isObserverTeam,
  normalizePlayerTeam,
  normalizePlayerTeamSelection,
} from '../public/teams.mjs';

const require = createRequire(import.meta.url);
const serverTeams = require('../server/teams.cjs');

assert.deepEqual(PLAYER_TEAMS, [
  PLAYER_TEAM.ROGUE,
  PLAYER_TEAM.OBSERVER,
  PLAYER_TEAM.RED,
  PLAYER_TEAM.BLUE,
  PLAYER_TEAM.GREEN,
  PLAYER_TEAM.PURPLE,
]);
assert.equal(PLAYER_TEAM_LABELS[PLAYER_TEAM.ROGUE], 'Rogue');
assert.equal(PLAYER_TEAM_LABELS[PLAYER_TEAM.AUTOMATIC], 'Automatic');
assert.equal(PLAYER_TEAM_LABELS[PLAYER_TEAM.OBSERVER], 'Observer');
assert.equal(PLAYER_TEAM_LABELS[PLAYER_TEAM.RED], 'Red Team');
assert.equal(normalizePlayerTeam('BLUE'), PLAYER_TEAM.BLUE);
assert.equal(normalizePlayerTeam('unknown'), PLAYER_TEAM.ROGUE);
assert.equal(normalizePlayerTeamSelection('AUTOMATIC'), PLAYER_TEAM.AUTOMATIC);
assert.deepEqual(getPlayerTeamSelections([PLAYER_TEAM.BLUE, PLAYER_TEAM.OBSERVER]), [
  PLAYER_TEAM.AUTOMATIC,
  PLAYER_TEAM.OBSERVER,
  PLAYER_TEAM.BLUE,
]);
assert.equal(isObserverTeam(PLAYER_TEAM.OBSERVER), true);
assert.equal(isObserverTeam(PLAYER_TEAM.ROGUE), false);

// public/teams.mjs and server/teams.cjs are hand-maintained copies
// of the same normalization rules. Compare the shared surface directly so the
// two cannot drift the way they did before (the client used to skip trimming).
assert.deepEqual(serverTeams.PLAYER_TEAM, PLAYER_TEAM);
assert.deepEqual(serverTeams.PLAYER_TEAMS, PLAYER_TEAMS);

const normalizationCases = [
  'rogue',
  'BLUE',
  ' red ',
  'Red\n',
  '\tgreen\t',
  'automatic',
  ' AUTOMATIC ',
  'observer',
  'unknown',
  '',
  '   ',
  42,
  null,
  undefined,
  true,
  ['red'],
  { toString: () => 'blue' },
];

for (const value of normalizationCases) {
  const label = typeof value === 'object' && value !== null ? Object.prototype.toString.call(value) : String(value);
  assert.equal(
    serverTeams.normalizePlayerTeam(value),
    normalizePlayerTeam(value),
    `client/server normalizePlayerTeam diverged for ${JSON.stringify(label)}`
  );
  assert.equal(
    serverTeams.normalizePlayerTeamSelection(value),
    normalizePlayerTeamSelection(value),
    `client/server normalizePlayerTeamSelection diverged for ${JSON.stringify(label)}`
  );
}

// Whitespace-padded input must resolve to the real team, not fall back to rogue.
assert.equal(normalizePlayerTeam(' red '), PLAYER_TEAM.RED);
assert.equal(normalizePlayerTeamSelection(' AUTOMATIC '), PLAYER_TEAM.AUTOMATIC);
// Non-strings are rejected rather than coerced.
assert.equal(normalizePlayerTeam({ toString: () => 'blue' }), PLAYER_TEAM.ROGUE);

// Only colour teams keep a team score, and both copies must agree on which
// those are: the server scores kills by it, the client draws rows by it.
for (const team of [...PLAYER_TEAMS, 'automatic', 'unknown', '', null]) {
  assert.equal(
    serverTeams.isColorTeam(team),
    isColorTeam(team),
    `client/server isColorTeam diverged for ${String(team)}`
  );
  assert.equal(
    serverTeams.getPlayerTeamColor(team),
    getPlayerTeamColor(team),
    `client/server getPlayerTeamColor diverged for ${String(team)}`
  );
}

assert.equal(isColorTeam(PLAYER_TEAM.RED), true);
assert.equal(isColorTeam(PLAYER_TEAM.PURPLE), true);
assert.equal(isColorTeam(PLAYER_TEAM.ROGUE), false);
assert.equal(isColorTeam(PLAYER_TEAM.OBSERVER), false);
// An unknown team normalizes to rogue, which scores for nobody.
assert.equal(isColorTeam('unknown'), false);

// Team scoring, against bzfs.cxx:3540.
const { getTeamScoreDeltasForKill } = serverTeams;
const RED = PLAYER_TEAM.RED;
const BLUE = PLAYER_TEAM.BLUE;
const ROGUE = PLAYER_TEAM.ROGUE;

// A kill across teams: one win for the killer's team, one loss for the victim's.
assert.deepEqual(getTeamScoreDeltasForKill(RED, BLUE), [
  { team: RED, wins: 1, losses: 0 },
  { team: BLUE, wins: 0, losses: 1 },
]);

// Killing a team mate costs the team two and wins nothing.
assert.deepEqual(getTeamScoreDeltasForKill(RED, RED), [{ team: RED, wins: 0, losses: 2 }]);

// Killing yourself costs one.
assert.deepEqual(getTeamScoreDeltasForKill(RED, RED, true), [{ team: RED, wins: 0, losses: 1 }]);

// A rogue killer wins for nobody; the victim's team still loses.
assert.deepEqual(getTeamScoreDeltasForKill(ROGUE, BLUE), [{ team: BLUE, wins: 0, losses: 1 }]);

// A rogue victim costs nobody; the killer's team still wins.
assert.deepEqual(getTeamScoreDeltasForKill(RED, ROGUE), [{ team: RED, wins: 1, losses: 0 }]);

// Rogue on rogue, and a rogue's own destruction, score nothing at all.
assert.deepEqual(getTeamScoreDeltasForKill(ROGUE, ROGUE), []);
assert.deepEqual(getTeamScoreDeltasForKill(ROGUE, ROGUE, true), []);

// An unknown killer -- a shot whose owner has left -- still costs the victim.
assert.deepEqual(getTeamScoreDeltasForKill(undefined, BLUE), [{ team: BLUE, wins: 0, losses: 1 }]);

// Observers are not a colour team either way.
assert.deepEqual(getTeamScoreDeltasForKill(PLAYER_TEAM.OBSERVER, PLAYER_TEAM.OBSERVER), []);

// Capture scoring, against bzfs.cxx:4010.
const { getTeamScoreDeltasForCapture } = serverTeams;

// Taking an enemy flag home: a win for the capper, a loss for the flag's team.
assert.deepEqual(getTeamScoreDeltasForCapture(RED, BLUE), [
  { team: RED, wins: 1, losses: 0 },
  { team: BLUE, wins: 0, losses: 1 },
]);

// Carrying your own flag onto an enemy base wins nobody anything. The capper is
// on the team that just lost it, so `cappingTeam` is null.
assert.deepEqual(getTeamScoreDeltasForCapture(null, RED), [{ team: RED, wins: 0, losses: 1 }]);
// The same holds if a caller names the capping team anyway.
assert.deepEqual(getTeamScoreDeltasForCapture(RED, RED), [{ team: RED, wins: 0, losses: 1 }]);

// Rogues cannot capture and have no flag to lose.
assert.deepEqual(getTeamScoreDeltasForCapture(ROGUE, BLUE), [{ team: BLUE, wins: 0, losses: 1 }]);
assert.deepEqual(getTeamScoreDeltasForCapture(RED, ROGUE), [{ team: RED, wins: 1, losses: 0 }]);
assert.deepEqual(getTeamScoreDeltasForCapture(ROGUE, ROGUE), []);

// The client and the server must agree about both rules.
const { getTeamScoreDeltasForCapture: clientCaptureRule } = await import('../public/teams.mjs');
for (const capping of [RED, BLUE, ROGUE, PLAYER_TEAM.OBSERVER, null, undefined]) {
  for (const capped of [RED, BLUE, ROGUE, PLAYER_TEAM.OBSERVER]) {
    assert.deepEqual(
      getTeamScoreDeltasForCapture(capping, capped),
      clientCaptureRule(capping, capped),
      `capture rule diverged for ${String(capping)} capping ${capped}`
    );
  }
}

// areFoes (bzfs.cxx:3042). Who may legitimately kill whom, which is what the
// `-noTeamKills` switch and the team-kill score both ask.
{
  const { areFoes } = serverTeams;
  const PURPLE = PLAYER_TEAM.PURPLE;

  // With teams, your own team is not fair game.
  assert.equal(areFoes(RED, BLUE, true), true, 'different teams are foes');
  assert.equal(areFoes(RED, RED, true), false, 'the same team is not');
  assert.equal(areFoes(PURPLE, PURPLE, true), false);

  // "Rogue is excepted", in the words of upstream's own -noTeamKills help: every
  // rogue is every other rogue's foe, because rogue is a name rather than a side.
  assert.equal(areFoes(ROGUE, ROGUE, true), true, 'rogues are always foes');
  assert.equal(areFoes(ROGUE, RED, true), true);

  // And on a world with no teams at all, everybody is fair game.
  assert.equal(areFoes(RED, RED, false), true, 'no teams means no team kills');
  assert.equal(areFoes(ROGUE, ROGUE, false), true);
}

console.log('player team tests passed');
