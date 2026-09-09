/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeServerTeamMode,
  parseBZWTeamMode,
  resolveTeamMode,
  selectPlayerTeam,
  getPlayerTeamColor,
  getInitialPlayerColor,
  PLAYER_TEAM_COLORS,
  TEAM_SHADE_HUE_SPREAD,
} = require('../server/teams.cjs');

assert.deepEqual(normalizeServerTeamMode(false), {
  enabled: false,
  autoTeam: false,
  teams: ['rogue', 'observer'],
  limits: {
    rogue: Number.MAX_SAFE_INTEGER,
    observer: Number.MAX_SAFE_INTEGER,
  },
});
assert.deepEqual(normalizeServerTeamMode({ enabled: true, teams: ['blue', 'red'] }), {
  enabled: true,
  autoTeam: false,
  teams: ['red', 'blue'],
  limits: {
    red: Number.MAX_SAFE_INTEGER,
    blue: Number.MAX_SAFE_INTEGER,
  },
});
assert.deepEqual(normalizeServerTeamMode({ enabled: true, teams: ['invalid', 'blue'] }), {
  enabled: true,
  autoTeam: false,
  teams: ['blue'],
  limits: {
    blue: Number.MAX_SAFE_INTEGER,
  },
});

const mapOverride = parseBZWTeamMode([
  'options',
  '  -c',
  '  -mp 10,0,4,0,2,8',
  'end',
]);
assert.deepEqual(mapOverride, {
  enabled: true,
  teams: ['rogue', 'observer', 'green', 'purple'],
  limits: {
    rogue: 10,
    red: 0,
    green: 4,
    blue: 0,
    purple: 2,
    observer: 8,
  },
});
// `-rabbit [score|killer|random]` in a map's options block. A bare switch is
// `score`, an unrecognised style is `score` as well -- upstream leaves the
// argument unconsumed rather than rejecting it -- and the named styles carry.
assert.equal(parseBZWTeamMode(['options', '-rabbit', 'end']).rabbitSelection, 'score');
assert.equal(parseBZWTeamMode(['options', '-rabbit killer', 'end']).rabbitSelection, 'killer');
assert.equal(parseBZWTeamMode(['options', '-rabbit random', 'end']).rabbitSelection, 'random');
assert.equal(parseBZWTeamMode(['options', '-rabbit nonsense', 'end']).rabbitSelection, 'score');
// Outside an options block it is not an option at all.
assert.equal(parseBZWTeamMode(['-rabbit killer']), null);

assert.deepEqual(parseBZWTeamMode([
  'options',
  '  -mp 10,2,2,0,0,8',
  'end',
]), {
  enabled: true,
  teams: ['rogue', 'observer', 'red', 'green'],
  limits: {
    rogue: 10,
    red: 2,
    green: 2,
    blue: 0,
    purple: 0,
    observer: 8,
  },
});
assert.deepEqual(parseBZWTeamMode([
  'options',
  '  -c',
  '  -autoTeam',
  '  -mp 10,10,10,10,10,10',
  'end',
]), {
  enabled: true,
  autoTeam: true,
  teams: ['rogue', 'observer', 'red', 'blue', 'green', 'purple'],
  limits: {
    rogue: 10,
    red: 10,
    green: 10,
    blue: 10,
    purple: 10,
    observer: 10,
  },
});
assert.deepEqual(parseBZWTeamMode(readFileSync(new URL('../maps/hix.bzw', import.meta.url), 'utf8').split(/\r?\n/)), {
  enabled: true,
  teams: ['rogue', 'observer', 'red', 'blue', 'green', 'purple'],
  limits: {
    rogue: 10,
    red: 10,
    green: 10,
    blue: 10,
    purple: 10,
    observer: 10,
  },
});
assert.deepEqual(resolveTeamMode({ enabled: false }, mapOverride), {
  enabled: true,
  autoTeam: false,
  rabbitSelection: null,
  colorTeamsRefused: false,
  maxRealPlayers: Number.MAX_SAFE_INTEGER,
  teams: ['rogue', 'observer', 'green', 'purple'],
  limits: {
    rogue: 10,
    observer: 8,
    green: 4,
    purple: 2,
  },
});
assert.deepEqual(resolveTeamMode({ enabled: true, teams: ['red', 'blue'] }, { enabled: false }), {
  enabled: false,
  autoTeam: false,
  rabbitSelection: null,
  colorTeamsRefused: false,
  maxRealPlayers: Number.MAX_SAFE_INTEGER,
  teams: ['rogue', 'observer'],
  limits: {
    rogue: Number.MAX_SAFE_INTEGER,
    observer: Number.MAX_SAFE_INTEGER,
  },
});

// CmdLineOptions.cxx:1586. Rabbit Chase is the last word on the game type: the
// colour teams go, whatever the config or the map asked for, and only observer
// stays askable. The rabbit's limit is one and the hunters inherit the rogue
// limit, which is upstream's shape exactly.
assert.deepEqual(resolveTeamMode(
  { enabled: true, teams: ['red', 'blue', 'rogue', 'observer'], limits: { red: 9, blue: 9, rogue: 7, observer: 3 } },
  null,
  16,
  'killer',
), {
  enabled: false,
  autoTeam: false,
  rabbitSelection: 'killer',
  colorTeamsRefused: true,
  maxRealPlayers: 16,
  teams: ['observer', 'hunter'],
  limits: { observer: 3, rabbit: 1, hunter: 7 },
});
// And a map's `-rabbit` reaches the same place, over a config that said nothing.
assert.deepEqual(
  resolveTeamMode({ enabled: false }, { rabbitSelection: 'random' }, 16).rabbitSelection,
  'random',
);
// A switch only ever turns something on: the map's style wins over the config's,
// and a config that already had it on is not turned off by a map that is silent.
assert.equal(resolveTeamMode({ enabled: false }, { rabbitSelection: 'killer' }, 16, 'score').rabbitSelection, 'killer');
assert.equal(resolveTeamMode({ enabled: false }, null, 16, 'score').rabbitSelection, 'score');
assert.equal(resolveTeamMode({ enabled: false }, null, 16, false).rabbitSelection, null);
// Nothing was refused when the config never asked for colour teams.
assert.equal(resolveTeamMode({ enabled: false }, null, 16, 'score').colorTeamsRefused, false);

const manualTeams = resolveTeamMode({
  enabled: true,
  teams: ['red', 'green', 'blue', 'purple', 'observer'],
  limits: { red: 10, green: 10, blue: 10, purple: 10, observer: 10 },
});
const teamCounts = { red: 5, green: 5, blue: 0, purple: 5, observer: 0 };
assert.equal(selectPlayerTeam('red', manualTeams, teamCounts), 'red');
assert.equal(selectPlayerTeam('automatic', manualTeams, teamCounts), 'blue');
assert.equal(selectPlayerTeam('red', { ...manualTeams, autoTeam: true }, teamCounts), 'blue');
assert.equal(selectPlayerTeam('red', { ...manualTeams, autoTeam: true }, {
  red: 5,
  green: 4,
  blue: 0,
  purple: 5,
}), 'green');
assert.equal(selectPlayerTeam('red', manualTeams, { ...teamCounts, red: 10 }), null);
assert.equal(getPlayerTeamColor('rogue'), 0xffff00);
assert.equal(getPlayerTeamColor('observer'), 0xffffff);
assert.equal(getPlayerTeamColor('blue'), 0x1a33ff);
// The second team on a map is weighed by how far its base is from the first, so
// two players are more often across the map than beside each other. Bases at the
// compass points: red north, green east, blue south, purple west, so blue is the
// far team from red and green and purple are the neighbours.
const compassBases = {
  red: { x: 0, z: -100 },
  green: { x: 100, z: 0 },
  blue: { x: 0, z: 100 },
  purple: { x: -100, z: 0 },
};
const autoTeams = {
  enabled: true,
  autoTeam: true,
  teams: ['rogue', 'observer', 'red', 'green', 'blue', 'purple'],
  limits: { rogue: 10, observer: 10, red: 10, green: 10, blue: 10, purple: 10 },
};
const oneOnRed = { red: 1, green: 0, blue: 0, purple: 0 };
// Squared distance from red: blue 200^2 = 40000, green and purple 100^2+100^2 =
// 20000 each. So blue takes half the range and the neighbours a quarter apiece.
const secondTeamFor = (roll) => selectPlayerTeam(
  'automatic', autoTeams, oneOnRed, {}, compassBases, () => roll);
assert.equal(secondTeamFor(0.10), 'green');
assert.equal(secondTeamFor(0.30), 'blue');
assert.equal(secondTeamFor(0.60), 'blue');
assert.equal(secondTeamFor(0.90), 'purple');
// Half the rolls land on the far team, a quarter on each neighbour.
const spread = { green: 0, blue: 0, purple: 0 };
for (let i = 0; i < 1000; i += 1) spread[secondTeamFor((i + 0.5) / 1000)] += 1;
assert.equal(spread.blue, 500, `far team got ${spread.blue} of 1000, want 500`);
assert.equal(spread.green, 250, `near team got ${spread.green} of 1000, want 250`);
assert.equal(spread.purple, 250, `near team got ${spread.purple} of 1000, want 250`);

// Only for the second team. With two already populated there is no single team
// across the map and the pick is even again. The candidates are blue then
// purple, so an even pick takes purple at 0.6 while the weighting would take
// blue -- it is heavier and holds the range up to 0.667.
const twoPopulated = { red: 2, green: 2, blue: 0, purple: 0 };
assert.equal(
  selectPlayerTeam('automatic', autoTeams, twoPopulated, {}, compassBases, () => 0.6),
  'purple');
// And with no bases to weigh, an even pick as before.
assert.equal(
  selectPlayerTeam('automatic', autoTeams, oneOnRed, {}, null, () => 0.9),
  'purple');

// Both modes go through the picker; what differs is the argument. In team mode
// it is the team, so the picker can shade inside that team's band. Outside it is
// null, so the picker has the whole wheel to work with.
const pickedTeams = [];
const pickDistinctColor = (team) => {
  pickedTeams.push(team);
  return team ? 0x111111 : 0xabcdef;
};
assert.equal(getInitialPlayerColor({ enabled: true }, 'blue', pickDistinctColor), 0x111111);
assert.deepEqual(pickedTeams, ['blue']);
assert.equal(getInitialPlayerColor({ enabled: false }, 'rogue', pickDistinctColor), 0xabcdef);
assert.deepEqual(pickedTeams, ['blue', null]);

// The shade bands must never let one team's colour reach another's. This is the
// property the band width is chosen for, so it is asserted against the colour
// table rather than left to the comment beside the constant.
const hueOf = (color) => {
  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const span = max - min;
  if (span === 0) return null; // observer's white has no hue to shade
  let hue;
  if (max === r) hue = ((g - b) / span) % 6;
  else if (max === g) hue = ((b - r) / span) + 2;
  else hue = ((r - g) / span) + 4;
  hue *= 60;
  return (hue + 360) % 360;
};
const hueGap = (left, right) => {
  const gap = Math.abs(left - right) % 360;
  return gap > 180 ? 360 - gap : gap;
};
const shadedHues = Object.values(PLAYER_TEAM_COLORS).map(hueOf).filter((hue) => hue !== null);
for (const left of shadedHues) {
  for (const right of shadedHues) {
    if (left === right) continue;
    assert.ok(
      hueGap(left, right) > 2 * TEAM_SHADE_HUE_SPREAD,
      `team hues ${left} and ${right} are ${hueGap(left, right)} apart, which two `
      + `${TEAM_SHADE_HUE_SPREAD} degree bands would overlap`
    );
  }
}

// autoTeamSelect (bzfs.cxx:1923): "if we're running rabbit chase, all
// non-observers start as hunters". Nothing is refused for naming the wrong team
// -- a colour team is read as "play" -- and only the hunter limit can turn a
// player away.
{
  const rabbitMode = resolveTeamMode({ enabled: true }, null, 4, 'score');
  assert.equal(selectPlayerTeam('automatic', rabbitMode, {}), 'hunter');
  assert.equal(selectPlayerTeam('rogue', rabbitMode, {}), 'hunter');
  assert.equal(selectPlayerTeam('red', rabbitMode, {}), 'hunter');
  assert.equal(selectPlayerTeam('observer', rabbitMode, {}), 'observer');
  // Nobody may ask for either of the two teams the server assigns; asking is
  // just another way of asking to play.
  assert.equal(selectPlayerTeam('rabbit', rabbitMode, {}), 'hunter');
  assert.equal(selectPlayerTeam('hunter', rabbitMode, {}), 'hunter');
  // A full world hands out observer rather than refusing (bzfs.cxx:1898), and in
  // Rabbit Chase the hunter limit *is* the playing limit, so the two agree: the
  // arrival watches. Only a world with nowhere to watch from turns them away.
  assert.equal(selectPlayerTeam('automatic', rabbitMode, { hunter: 4 }), 'observer');
  assert.equal(selectPlayerTeam('observer', rabbitMode, { hunter: 4 }), 'observer');
  const rabbitNoWatching = resolveTeamMode(
    { enabled: true, limits: { observer: 0 } }, null, 4, 'score');
  assert.equal(selectPlayerTeam('automatic', rabbitNoWatching, { hunter: 4 }), null);
}

// CmdLineOptions.cxx:453. The playing limit caps every playing team's own limit,
// so a per-team number above it is brought down rather than left to promise room
// the game does not have. Observer is outside the cap, as upstream's is.
{
  const capped = resolveTeamMode({
    enabled: true,
    teams: ['rogue', 'observer', 'red', 'blue', 'green', 'purple'],
    limits: { rogue: 20, red: 20, green: 3, blue: 20, purple: 20, observer: 20 },
  }, null, 8);
  assert.equal(capped.maxRealPlayers, 8);
  assert.deepEqual(capped.limits, {
    rogue: 8, red: 8, green: 3, blue: 8, purple: 8, observer: 20,
  });
  // And in Rabbit Chase, where the hunter limit is the rogue limit.
  const cappedRabbit = resolveTeamMode(
    { enabled: false, limits: { rogue: 20, observer: 20 } }, null, 8, 'score');
  assert.deepEqual(cappedRabbit.limits, { observer: 20, rabbit: 1, hunter: 8 });
}

// bzfs.cxx:1898: "if no player are available, join as Observer". The playing
// limit is reached by the tanks between them, whichever teams they are on, and an
// arrival becomes a spectator rather than being refused.
{
  const mode = resolveTeamMode({
    enabled: true,
    teams: ['rogue', 'observer', 'red', 'blue', 'green', 'purple'],
  }, null, 4);
  assert.equal(selectPlayerTeam('automatic', mode, { red: 2, blue: 1 }), 'blue');
  assert.equal(selectPlayerTeam('automatic', mode, { red: 2, blue: 1, green: 1 }), 'observer');
  assert.equal(selectPlayerTeam('red', mode, { red: 2, blue: 1, green: 1 }), 'observer');
  // Observers do not count towards it, so a crowd of them keeps the game joinable.
  assert.equal(
    selectPlayerTeam('automatic', mode, { red: 1, observer: 9 }, {}, null, () => 0), 'green');
  // Nor does an observer's own request ever become something else.
  assert.equal(selectPlayerTeam('observer', mode, { red: 4 }), 'observer');
  // A playing limit with no observer room left refuses, which is what the total
  // limit does on the way in.
  const noWatching = resolveTeamMode({
    enabled: true, teams: ['rogue', 'observer', 'red'], limits: { observer: 0 },
  }, null, 2);
  assert.equal(selectPlayerTeam('automatic', noWatching, { red: 2 }), null);
}

// "not putting in not enabled teams" (bzfs.cxx:1935): a team limited to zero is
// off, and the balancing never founds it -- not even on an empty world, where
// every team ties.
{
  const mode = resolveTeamMode({
    enabled: true,
    teams: ['rogue', 'observer', 'red', 'blue', 'green', 'purple'],
    limits: { red: 0, green: 0, blue: 4, purple: 0, rogue: 4, observer: 4 },
  });
  assert.equal(selectPlayerTeam('automatic', mode, {}), 'blue');
  assert.equal(selectPlayerTeam('red', mode, {}), null);
}

console.log('team mode tests passed');
