/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  ALL_PLAYER_TEAMS,
  PLAYER_TEAM,
  PLAYER_TEAMS,
  PLAYER_TEAM_LABELS,
  isRabbitTeam,
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
assert.equal(PLAYER_TEAM_LABELS[PLAYER_TEAM.MAP_VIEWER], 'Map Viewer');
assert.equal(PLAYER_TEAM_LABELS[PLAYER_TEAM.RED], 'Red Team');
assert.equal(normalizePlayerTeam('BLUE'), PLAYER_TEAM.BLUE);
assert.equal(normalizePlayerTeam('unknown'), PLAYER_TEAM.ROGUE);
assert.equal(normalizePlayerTeamSelection('AUTOMATIC'), PLAYER_TEAM.AUTOMATIC);
assert.deepEqual(getPlayerTeamSelections([PLAYER_TEAM.BLUE, PLAYER_TEAM.OBSERVER]), [
  PLAYER_TEAM.AUTOMATIC,
  PLAYER_TEAM.OBSERVER,
  PLAYER_TEAM.BLUE,
]);
// The two teams Rabbit Chase assigns are teams a player may be *on* and never
// teams a player may ask for, which is the whole difference between the lists.
// Map Viewer (issue #68) is the third: never on the wire at all, but
// recognized here so the dialog's own bookkeeping (`normalizePlayerTeam`)
// round-trips its client-only sentinel instead of falling back to rogue.
assert.deepEqual(
  ALL_PLAYER_TEAMS,
  [...PLAYER_TEAMS, PLAYER_TEAM.RABBIT, PLAYER_TEAM.HUNTER, PLAYER_TEAM.MAP_VIEWER],
);
assert.equal(normalizePlayerTeam('RABBIT'), PLAYER_TEAM.RABBIT);
assert.equal(normalizePlayerTeam(' hunter '), PLAYER_TEAM.HUNTER);
assert.equal(isRabbitTeam(PLAYER_TEAM.RABBIT), true);
assert.equal(isRabbitTeam(PLAYER_TEAM.HUNTER), false);
assert.equal(isRabbitTeam(null), false);
// Neither is offered in the entry dialog, whatever a caller passes in.
assert.deepEqual(getPlayerTeamSelections(ALL_PLAYER_TEAMS), [
  PLAYER_TEAM.AUTOMATIC,
  ...PLAYER_TEAMS,
]);

assert.equal(isObserverTeam(PLAYER_TEAM.OBSERVER), true);
assert.equal(isObserverTeam(PLAYER_TEAM.ROGUE), false);
assert.equal(isObserverTeam(PLAYER_TEAM.MAP_VIEWER), false);

// Map Viewer (issue #68) is never a real team -- it normalizes to itself
// (the dialog's own bookkeeping depends on that), but it is not Observer, and
// it is not in PLAYER_TEAMS, the list the server actually recognizes.
assert.equal(normalizePlayerTeam(PLAYER_TEAM.MAP_VIEWER), PLAYER_TEAM.MAP_VIEWER);
assert.equal(PLAYER_TEAMS.includes(PLAYER_TEAM.MAP_VIEWER), false);
assert.equal('MAP_VIEWER' in serverTeams.PLAYER_TEAM, false);

// public/teams.mjs and server/teams.cjs are hand-maintained copies
// of the same normalization rules. Compare the shared surface directly so the
// two cannot drift the way they did before (the client used to skip trimming).
// `MAP_VIEWER` is the one deliberate exception -- see its own comment above --
// so it is left out of the client's copy before this comparison.
const clientPlayerTeam = Object.fromEntries(
  Object.entries(PLAYER_TEAM).filter(([key]) => key !== 'MAP_VIEWER'),
);
assert.deepEqual(serverTeams.PLAYER_TEAM, clientPlayerTeam);
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
// Team::isColorTeam is red through purple, so Rabbit Chase's two teams score for
// nobody either -- half of why a kill never moves a team score there.
assert.equal(isColorTeam(PLAYER_TEAM.RABBIT), false);
assert.equal(isColorTeam(PLAYER_TEAM.HUNTER), false);
assert.equal(serverTeams.isColorTeam(PLAYER_TEAM.HUNTER), false);

// The game type, against global.h:94. Colour teams and bases are the whole
// question: no teams is OpenFFA, teams without bases is TeamFFA, and teams with
// bases is ClassicCTF.
const { getGameType, teamScoreMovesOnKill } = serverTeams;
assert.equal(getGameType(false, false), 'OpenFFA');
// A base on a map with no colour teams is nobody's base, so it changes nothing.
assert.equal(getGameType(false, true), 'OpenFFA');
assert.equal(getGameType(true, false), 'TeamFFA');
assert.equal(getGameType(true, true), 'ClassicCTF');
// Rabbit Chase is asked first and answers over everything else, which is
// upstream's "Capture the flag incompatible with Rabbit Chase".
assert.equal(getGameType(false, false, true), 'RabbitChase');
assert.equal(getGameType(true, true, true), 'RabbitChase');

// allowTeams (bzfs.cxx:3334). Every type but OpenFFA has sides, and Rabbit
// Chase's are the rabbit against the hunters -- which is why it is asked of the
// type rather than of the colour teams, which Rabbit Chase has none of.
const { allowTeams } = serverTeams;
assert.equal(allowTeams('OpenFFA'), false);
assert.equal(allowTeams('TeamFFA'), true);
assert.equal(allowTeams('ClassicCTF'), true);
assert.equal(allowTeams('RabbitChase'), true);

// bzfs.cxx:3539. Only the free-for-all types score team points for a kill; in
// ClassicCTF a capture is the only thing that moves the team score.
assert.equal(teamScoreMovesOnKill('OpenFFA'), true);
assert.equal(teamScoreMovesOnKill('TeamFFA'), true);
assert.equal(teamScoreMovesOnKill('ClassicCTF'), false);
// bzfs.cxx:3534 skips the block for RabbitChase as well: player scores work as
// usual there and no team score ever moves.
assert.equal(teamScoreMovesOnKill('RabbitChase'), false);

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

// Score::ranking (Score.cxx:42). A win rate discounted for how short the record
// is, which is what decides who becomes the rabbit and what the scoreboard is
// sorted by. Held against upstream's own arithmetic rather than against a table,
// so a transcription slip in either term shows up.
{
  const { getPlayerRanking } = serverTeams;
  const upstream = (wins, losses) => {
    const sum = wins + losses;
    if (sum === 0) return 0.5;
    return (wins / sum) * (1 - (0.5 / Math.sqrt(sum)));
  };
  // No record at all is a flat 0.5 -- the one value the formula never produces,
  // and deliberately generous: it beats every even record, so a player who has
  // just arrived is near the front of the queue rather than the back of it.
  assert.equal(getPlayerRanking(0, 0), 0.5);
  assert.ok(getPlayerRanking(0, 0) > getPlayerRanking(1, 1));
  assert.ok(getPlayerRanking(0, 0) > getPlayerRanking(50, 50));
  // One win is a perfect rate halved by the discount, so it ranks no better than
  // never having played; twenty-five keeps 0.9 of it, and 1.0 is unreachable.
  assert.equal(getPlayerRanking(1, 0), 0.5);
  assert.equal(getPlayerRanking(25, 0), 0.9);
  assert.ok(getPlayerRanking(1000, 0) < 1);
  // The discount multiplies, so it pulls towards zero rather than towards the
  // middle: a rank is always at or below the rate it came from.
  for (const [wins, losses] of [[4, 2], [40, 20], [1, 1], [50, 50]]) {
    assert.ok(
      getPlayerRanking(wins, losses) < wins / (wins + losses),
      `${wins}-${losses} should rank below its own rate`
    );
  }
  // Losing every game ranks at zero however long the record is, so a first death
  // with no wins to divide takes a new player from the front to the back.
  assert.equal(getPlayerRanking(0, 1), 0);
  assert.equal(getPlayerRanking(0, 9), 0);
  for (const [wins, losses] of [[3, 1], [1, 3], [10, 10], [7, 2], [0, 1], [40, 8]]) {
    assert.equal(
      getPlayerRanking(wins, losses),
      upstream(wins, losses),
      `ranking diverged for ${wins}-${losses}`
    );
  }
  // A longer record of the same rate is trusted more, which is the whole point
  // of the penalty term.
  assert.ok(getPlayerRanking(20, 20) > getPlayerRanking(2, 2));
}

// PlayerInfo::canBeRabbit (PlayerInfo.cxx:504) and
// GameKeeper::Player::anointRabbit (GameKeeper.cxx:145).
{
  const { canBeRabbit, anointRabbit, pickNewRabbit, isARabbitKill } = serverTeams;
  const player = (id, extra = {}) => ({
    id, paused: false, observer: false, alive: true, playing: true, ranking: 0.5, ...extra,
  });

  // Paused, observing, or not in the game at all: never the rabbit. A rabbit
  // nobody can shoot is not a rabbit.
  assert.equal(canBeRabbit(player('a')), true);
  assert.equal(canBeRabbit(player('a', { paused: true })), false);
  assert.equal(canBeRabbit(player('a', { observer: true })), false);
  assert.equal(canBeRabbit(player('a', { alive: false })), false, 'the strict pass wants them alive');
  // The relaxing pass settles for a dead player who is still in the game, which
  // is the pass anointRabbit makes.
  assert.equal(canBeRabbit(player('a', { alive: false }), true), true);
  assert.equal(canBeRabbit(player('a', { alive: false, playing: false }), true), false);
  assert.equal(canBeRabbit(player('a', { paused: true }), true), false);
  assert.equal(canBeRabbit(null), false);

  // The best ranking wins among candidates that are equally good.
  assert.equal(anointRabbit([
    player('a', { ranking: 0.2 }),
    player('b', { ranking: 0.8 }),
    player('c', { ranking: 0.5 }),
  ]), 'b');

  // "prefer anyone alive who is not the old rabbit": a good candidate beats
  // every not-good one however badly it ranks.
  assert.equal(anointRabbit([
    player('old', { ranking: 0.99 }),
    player('dead', { alive: false, ranking: 0.99 }),
    player('good', { ranking: 0.01 }),
  ], 'old'), 'good');

  // With nobody good left it settles: a dead player in the game beats nobody at
  // all, and the ranking still decides between them.
  assert.equal(anointRabbit([
    player('dead-low', { alive: false, ranking: 0.1 }),
    player('dead-high', { alive: false, ranking: 0.7 }),
  ], null), 'dead-high');
  // Including settling for the old rabbit, which is how a one-player world
  // keeps a rabbit at all -- upstream's own "no other than old rabbit to choose
  // from".
  assert.equal(anointRabbit([player('old', { alive: false })], 'old'), 'old');
  // And with nobody eligible there is simply no rabbit.
  assert.equal(anointRabbit([player('a', { paused: true }), player('b', { observer: true })]), null);
  assert.equal(anointRabbit([]), null);

  // anointNewRabbit's killer shortcut (bzfs.cxx:2747), which only `-rabbit
  // killer` takes: whoever shot the rabbit gets it if they are still alive.
  const killerCase = [player('killer', { ranking: 0.01 }), player('ace', { ranking: 0.99 })];
  assert.equal(pickNewRabbit({ candidates: killerCase, oldRabbitId: 'old', killerId: 'killer', selection: 'killer' }), 'killer');
  // The other two styles ignore the killer entirely.
  assert.equal(pickNewRabbit({ candidates: killerCase, oldRabbitId: 'old', killerId: 'killer', selection: 'score' }), 'ace');
  // A killer who died in the same exchange does not inherit it: upstream asks
  // the strict canBeRabbit() of them.
  assert.equal(pickNewRabbit({
    candidates: [player('killer', { alive: false }), player('ace', { ranking: 0.99 })],
    oldRabbitId: 'old',
    killerId: 'killer',
    selection: 'killer',
  }), 'ace');
  // Nor does the rabbit inherit its own post by killing itself.
  assert.equal(pickNewRabbit({
    candidates: [player('old'), player('ace', { ranking: 0.9 })],
    oldRabbitId: 'old',
    killerId: 'old',
    selection: 'killer',
  }), 'ace');
  // A killer who has left is not there to take it.
  assert.equal(pickNewRabbit({
    candidates: [player('ace', { ranking: 0.9 })],
    oldRabbitId: 'old',
    killerId: 'gone',
    selection: 'killer',
  }), 'ace');

  // `-rabbit random` is not a fourth code path: Score::setRandomRanking replaces
  // the ranking with a random number and the selection above runs unchanged. So
  // a random ranking still cannot pick an ineligible player, and still prefers a
  // good candidate over the old rabbit.
  for (let trial = 0; trial < 200; trial += 1) {
    const chosen = anointRabbit([
      player('old', { ranking: Math.random() }),
      player('paused', { paused: true, ranking: Math.random() }),
      player('good', { ranking: Math.random() }),
    ], 'old');
    assert.equal(chosen, 'good', 'a random ranking must still respect eligibility');
  }

  // isARabbitKill (PlayerInfo.h:324). Hunters are team mates, so hunter fire is
  // team killing -- except on the rabbit, and except for a deposed rabbit until
  // its next spawn.
  assert.equal(isARabbitKill({ wasRabbit: false }, { team: PLAYER_TEAM.RABBIT }), true);
  assert.equal(isARabbitKill({ wasRabbit: true }, { team: PLAYER_TEAM.HUNTER }), true);
  assert.equal(isARabbitKill({ wasRabbit: false }, { team: PLAYER_TEAM.HUNTER }), false);
  assert.equal(isARabbitKill(null, { team: PLAYER_TEAM.HUNTER }), false);
  assert.equal(isARabbitKill({ wasRabbit: false }, null), false);
}

// `rabbit` in server.json and `-rabbit` in a map, normalized to upstream's three
// RabbitSelection values (CmdLineOptions.cxx:1106).
{
  const { normalizeRabbitSelection, resolveRabbitSelection } = serverTeams;
  assert.equal(normalizeRabbitSelection(undefined), null);
  assert.equal(normalizeRabbitSelection(null), null);
  assert.equal(normalizeRabbitSelection(false), null);
  assert.equal(normalizeRabbitSelection('false'), null);
  // A bare switch is `score`, and so is a style upstream would not recognise --
  // it leaves the argument unconsumed rather than rejecting the switch.
  assert.equal(normalizeRabbitSelection(true), 'score');
  assert.equal(normalizeRabbitSelection(''), 'score');
  assert.equal(normalizeRabbitSelection('nonsense'), 'score');
  assert.equal(normalizeRabbitSelection(' KILLER '), 'killer');
  assert.equal(normalizeRabbitSelection('random'), 'random');
  // A map switch only ever turns something on, so the map wins where it speaks
  // and the config stands where it does not.
  assert.equal(resolveRabbitSelection('score', 'random'), 'random');
  assert.equal(resolveRabbitSelection('score', undefined), 'score');
  assert.equal(resolveRabbitSelection(false, 'killer'), 'killer');
  assert.equal(resolveRabbitSelection(false, undefined), null);
}

// What colour a join hands out. Observer is upstream's flat white on every
// server (Team::getTankColor); every other team is a shade in its band with
// colour teams on, and with them off the colour a player already has stands --
// changing it mid-match would undo the only thing a distinct colour is for.
{
  const { getInitialPlayerColor, getJoinPlayerColor, getPlayerTeamColor: serverTeamColor } = serverTeams;
  const WHITE = serverTeamColor(PLAYER_TEAM.OBSERVER);
  const teams = { enabled: true };
  const noTeams = { enabled: false };
  // The pick is injected, so what it was asked for is what these assert on.
  const asked = [];
  const pick = (team) => { asked.push(team); return 0xabcdef; };

  assert.equal(getJoinPlayerColor(teams, PLAYER_TEAM.OBSERVER, null, pick), WHITE);
  assert.equal(getJoinPlayerColor(noTeams, PLAYER_TEAM.OBSERVER, null, pick), WHITE);
  // ...which is the bug this pins: a world with no colour teams -- OpenFFA, and
  // Rabbit Chase, where observer is the only team anyone can ask for -- used to
  // leave an observer wearing the colour the constructor gave it off the wheel.
  assert.equal(getJoinPlayerColor(noTeams, PLAYER_TEAM.OBSERVER, PLAYER_TEAM.HUNTER, pick), WHITE);
  assert.deepEqual(asked, [], 'observer never asks for a distinct colour');

  // With colour teams on, a shade inside the team's own band.
  assert.equal(getJoinPlayerColor(teams, PLAYER_TEAM.RED, null, pick), 0xabcdef);
  assert.deepEqual(asked, [PLAYER_TEAM.RED]);

  // With them off, the colour already in hand stands.
  asked.length = 0;
  assert.equal(getJoinPlayerColor(noTeams, PLAYER_TEAM.ROGUE, null, pick), null);
  assert.equal(getJoinPlayerColor(noTeams, PLAYER_TEAM.HUNTER, PLAYER_TEAM.HUNTER, pick), null);
  assert.deepEqual(asked, [], 'a rejoin keeps its colour rather than churning it');

  // Except coming back from observer, where the white it wore is nobody's: it
  // takes a fresh colour off the whole wheel, which `null` is the request for.
  assert.equal(getJoinPlayerColor(noTeams, PLAYER_TEAM.HUNTER, PLAYER_TEAM.OBSERVER, pick), 0xabcdef);
  assert.deepEqual(asked, [null]);

  // The constructor's rule agrees about observer, so the two cannot disagree if
  // a first join ever reaches it.
  assert.equal(getInitialPlayerColor(noTeams, PLAYER_TEAM.OBSERVER, pick), WHITE);
  assert.equal(getInitialPlayerColor(teams, PLAYER_TEAM.OBSERVER, pick), WHITE);
}

console.log('player team tests passed');
