/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

const PLAYER_TEAM = Object.freeze({
  AUTOMATIC: 'automatic',
  ROGUE: 'rogue',
  OBSERVER: 'observer',
  RED: 'red',
  BLUE: 'blue',
  GREEN: 'green',
  PURPLE: 'purple',
});

const PLAYER_TEAMS = Object.freeze([
  PLAYER_TEAM.ROGUE,
  PLAYER_TEAM.OBSERVER,
  PLAYER_TEAM.RED,
  PLAYER_TEAM.BLUE,
  PLAYER_TEAM.GREEN,
  PLAYER_TEAM.PURPLE,
]);
const NON_TEAM_MODE_TEAMS = Object.freeze([PLAYER_TEAM.ROGUE, PLAYER_TEAM.OBSERVER]);
// BZFlag's TeamColor numbering (global.h:59). A BZW `base` object names one of
// these in its `color` line, a team flag carries one as its team, and `-mp`
// lists its player counts in this order. bzo's own team order differs, so the
// two are mapped rather than assumed to agree.
const BZFLAG_TEAM_ORDER = Object.freeze([
  PLAYER_TEAM.ROGUE,
  PLAYER_TEAM.RED,
  PLAYER_TEAM.GREEN,
  PLAYER_TEAM.BLUE,
  PLAYER_TEAM.PURPLE,
  PLAYER_TEAM.OBSERVER,
]);
const PLAYER_TEAM_COLORS = Object.freeze({
  [PLAYER_TEAM.ROGUE]: 0xffff00,
  [PLAYER_TEAM.OBSERVER]: 0xffffff,
  [PLAYER_TEAM.RED]: 0xff0000,
  [PLAYER_TEAM.BLUE]: 0x1a33ff,
  [PLAYER_TEAM.GREEN]: 0x00ff00,
  [PLAYER_TEAM.PURPLE]: 0xff00ff,
});

// Team::radarColor (Team.cxx:30). Deliberately not the tank colours: red, green
// and purple are lifted so a team reads against a dark radar, where the tank
// colours sink into it. Upstream uses these for everything it draws on the
// radar, so bzo does too.
const PLAYER_TEAM_RADAR_COLORS = Object.freeze({
  [PLAYER_TEAM.ROGUE]: 0xffff00,
  [PLAYER_TEAM.OBSERVER]: 0xffffff,
  [PLAYER_TEAM.RED]: 0xff2626,
  [PLAYER_TEAM.BLUE]: 0x1440ff,
  [PLAYER_TEAM.GREEN]: 0x33e633,
  [PLAYER_TEAM.PURPLE]: 0xff66ff,
});

function normalizePlayerTeam(team) {
  const normalized = typeof team === 'string' ? team.trim().toLowerCase() : '';
  return PLAYER_TEAMS.includes(normalized) ? normalized : PLAYER_TEAM.ROGUE;
}

function normalizePlayerTeamSelection(team) {
  const normalized = typeof team === 'string' ? team.trim().toLowerCase() : '';
  return normalized === PLAYER_TEAM.AUTOMATIC ? PLAYER_TEAM.AUTOMATIC : normalizePlayerTeam(normalized);
}

function normalizeTeamList(teams, fallback = PLAYER_TEAMS) {
  if (!Array.isArray(teams)) return [...fallback];
  const requested = new Set(teams
    .map((team) => typeof team === 'string' ? team.trim().toLowerCase() : '')
    .filter((team) => PLAYER_TEAMS.includes(team)));
  const normalized = PLAYER_TEAMS.filter((team) => requested.has(team));
  return normalized.length > 0 ? normalized : [...fallback];
}

function normalizeTeamLimits(limits, teams, defaultLimit) {
  return Object.fromEntries(teams.map((team) => {
    const configured = Number(limits?.[team]);
    return [team, Number.isInteger(configured) && configured >= 0 ? configured : defaultLimit];
  }));
}

function normalizeServerTeamMode(value, defaultLimit = Number.MAX_SAFE_INTEGER) {
  if (typeof value === 'boolean') {
    const teams = value ? [...PLAYER_TEAMS] : [...NON_TEAM_MODE_TEAMS];
    return {
      enabled: value,
      autoTeam: false,
      teams,
      limits: normalizeTeamLimits(null, teams, defaultLimit),
    };
  }

  const enabled = value?.enabled === true;
  const teams = enabled
    ? normalizeTeamList(value?.teams)
    : [...NON_TEAM_MODE_TEAMS];
  return {
    enabled,
    autoTeam: enabled && value?.autoTeam === true,
    teams,
    limits: normalizeTeamLimits(value?.limits, teams, defaultLimit),
  };
}

function parseBZWTeamMode(lines) {
  let inOptions = false;
  let touched = false;
  let hasExplicitMode = false;
  const override = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (!inOptions && line === 'options') {
      inOptions = true;
      continue;
    }
    if (!inOptions) continue;
    if (line === 'end') {
      inOptions = false;
      continue;
    }

    const [option, value] = line.split(/\s+/, 2);
    if (option === '-c') {
      override.enabled = true;
      hasExplicitMode = true;
      touched = true;
    } else if (option === '-offa') {
      override.enabled = false;
      hasExplicitMode = true;
      touched = true;
    } else if (option === '-autoTeam') {
      override.autoTeam = true;
      touched = true;
    } else if (option === '-mp' && value?.includes(',')) {
      const counts = value.split(',').map((count) => Number.parseInt(count, 10));
      const enabledSet = new Set(BZFLAG_TEAM_ORDER.filter((team, index) => counts[index] > 0));
      override.teams = PLAYER_TEAMS.filter((team) => enabledSet.has(team));
      override.limits = Object.fromEntries(BZFLAG_TEAM_ORDER.map((team, index) => [
        team,
        Number.isInteger(counts[index]) && counts[index] >= 0 ? counts[index] : 0,
      ]));
      touched = true;
    }
  }

  if (!hasExplicitMode && override.teams?.some((team) => (
    team !== PLAYER_TEAM.ROGUE && team !== PLAYER_TEAM.OBSERVER
  ))) {
    override.enabled = true;
  }

  return touched ? override : null;
}

function resolveTeamMode(serverValue, mapOverride = null, defaultLimit = Number.MAX_SAFE_INTEGER) {
  const serverMode = normalizeServerTeamMode(serverValue, defaultLimit);
  const enabled = typeof mapOverride?.enabled === 'boolean'
    ? mapOverride.enabled
    : serverMode.enabled;
  if (!enabled) {
    const teams = [...NON_TEAM_MODE_TEAMS];
    return {
      enabled: false,
      autoTeam: false,
      teams,
      limits: normalizeTeamLimits(serverMode.limits, teams, defaultLimit),
    };
  }

  const teams = mapOverride?.teams
    ? normalizeTeamList(mapOverride.teams, serverMode.teams)
    : serverMode.teams;
  return {
    enabled: true,
    autoTeam: mapOverride?.autoTeam ?? serverMode.autoTeam,
    teams,
    limits: normalizeTeamLimits(mapOverride?.limits ?? serverMode.limits, teams, defaultLimit),
  };
}

// Upstream picks evenly among the teams that tie (autoTeamSelect, bzfs.cxx:1902),
// which leaves the second player on an empty map more likely to be founded
// beside the first than across from them: two of the three remaining teams are
// neighbours, so the far one comes up a third of the time.
//
// bzo weighs that one case by how far apart the two bases are, squared. On a map
// with its bases at the compass points the far team is exactly twice as likely
// as either neighbour -- 50/25/25 rather than 33/33/33 -- and the exponent is
// the only thing to turn if that is not enough.
//
// Only that case. Once two teams are populated there is no single team across
// the map, and a player joining teams that already exist is picked as before.
// Distance never overrides the balancing above it either: this only reorders
// candidates that already tie on size and on score. Whichever team has no base
// on the map, or a map with no bases at all, falls back to the even pick.
function pickByBaseDistance(candidates, teamCounts, basePositions, random) {
  if (!basePositions) return null;
  const populated = BZFLAG_TEAM_ORDER.slice(1, 5).filter((team) => (teamCounts[team] || 0) > 0);
  if (populated.length !== 1) return null;
  if (candidates.some((team) => (teamCounts[team] || 0) > 0)) return null;

  const from = basePositions[populated[0]];
  if (!from) return null;
  const weights = candidates.map((team) => {
    const to = basePositions[team];
    if (!to) return 0;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    return (dx * dx) + (dz * dz);
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) return null;

  let roll = random() * total;
  for (let index = 0; index < candidates.length; index += 1) {
    roll -= weights[index];
    if (roll < 0) return candidates[index];
  }
  return candidates[candidates.length - 1];
}

// `basePositions` is one point per colour team, `{ red: { x, z }, ... }`, and is
// only consulted for the second team on the map. `random` follows it so the
// tests can drive both.
function selectPlayerTeam(requestedTeam, teamMode, teamCounts = {}, teamScores = {}, basePositions = null, random = Math.random) {
  const requested = normalizePlayerTeamSelection(requestedTeam);
  const automatic = requested === PLAYER_TEAM.AUTOMATIC;
  if (!automatic && !teamMode.teams.includes(requested)) return null;
  const hasRoom = (team) => (teamCounts[team] || 0) < teamMode.limits[team];

  if (!automatic && (requested === PLAYER_TEAM.OBSERVER || requested === PLAYER_TEAM.ROGUE || !teamMode.autoTeam)) {
    return hasRoom(requested) ? requested : null;
  }

  let candidates = BZFLAG_TEAM_ORDER.slice(1, 5)
    .filter((team) => teamMode.teams.includes(team))
    .sort((left, right) => (teamCounts[right] || 0) - (teamCounts[left] || 0));
  if (candidates.length === 0) return hasRoom(PLAYER_TEAM.ROGUE) ? PLAYER_TEAM.ROGUE : null;

  const largestCount = teamCounts[candidates[0]] || 0;
  if (largestCount > 0) {
    candidates = candidates.filter(hasRoom);
    if (candidates.length === 0) return hasRoom(PLAYER_TEAM.ROGUE) ? PLAYER_TEAM.ROGUE : null;

    const smallestCount = teamCounts[candidates[candidates.length - 1]] || 0;
    if (smallestCount < largestCount) {
      if (largestCount === 1 && candidates.length >= 2 && (teamCounts[candidates[1]] || 0) === 1) {
        candidates = candidates.filter((team) => (teamCounts[team] || 0) > 0);
      } else {
        candidates = candidates.filter((team) => (teamCounts[team] || 0) !== largestCount);
        if ((teamCounts[candidates[0]] || 0) > 0) {
          candidates = candidates.filter((team) => (teamCounts[team] || 0) > 0);
          const smallestExistingCount = teamCounts[candidates[candidates.length - 1]] || 0;
          candidates = candidates.filter((team) => (teamCounts[team] || 0) === smallestExistingCount);
        }
      }
    }
  }

  if (candidates.includes(requested)) return requested;
  const lowestScore = Math.min(...candidates.map((team) => teamScores[team] || 0));
  candidates = candidates.filter((team) => (teamScores[team] || 0) === lowestScore);
  return pickByBaseDistance(candidates, teamCounts, basePositions, random)
    || candidates[Math.floor(random() * candidates.length)];
}

function isObserverTeam(team) {
  return normalizePlayerTeam(team) === PLAYER_TEAM.OBSERVER;
}

// Team::isColorTeam upstream. Rogues and observers carry no team score: a
// rogue kill feeds nobody's tally, and neither does dying as one.
function isColorTeam(team) {
  const normalized = normalizePlayerTeam(team);
  return normalized !== PLAYER_TEAM.ROGUE && normalized !== PLAYER_TEAM.OBSERVER;
}

// bzfs.cxx:3540. A kill across teams wins one for the killer's team and loses
// one for the victim's. A kill inside a team only loses: two for killing a team
// mate, one for killing yourself. Rogues and observers score for nobody, so a
// rogue's kill feeds no tally and a rogue's death costs none.
//
// Returned rather than applied so the rule can be tested against upstream's
// without a server around it.
// areFoes (bzfs.cxx:3042). Who may legitimately kill whom. Everyone is a foe on
// a world with no teams, and a rogue is everyone's foe even on one that has
// them -- which is why upstream's own `-noTeamKills` help says "Rogue is
// excepted".
//
// Server-only. Upstream asks this on both ends -- each client refuses a
// teammate's shot in `LocalPlayer::checkHit` and bzfs asks again to score the
// team kill -- but bzo's server is the only thing that decides a hit, so there
// is one copy and it lives here.
function areFoes(teamA, teamB, teamsAllowed) {
  if (!teamsAllowed) return true;
  return teamA !== teamB || teamA === PLAYER_TEAM.ROGUE;
}

// GameType (global.h:94), by the two questions bzo already asks about a world.
// Upstream picks the type with a switch and derives nothing; bzo has no switch
// for it, so `-c`/`-offa` decide whether there are colour teams and the map
// decides whether there are bases, which between them say the same thing.
// `RabbitChase`, upstream's fourth, is not implemented -- see
// docs/game-modes-plan.md.
//
// Server-only: the type decides scoring and spawning, which are the server's.
function getGameType(teamsEnabled, hasBases) {
  if (!teamsEnabled) return 'OpenFFA';
  return hasBases ? 'ClassicCTF' : 'TeamFFA';
}

// bzfs.cxx:3539. A kill moves the team score in the two free-for-all types and
// not in ClassicCTF, where a capture is the only thing that moves it -- which is
// what makes a capture worth crossing the map for. In OpenFFA there are no
// colour teams to score anyway, so the deltas come back empty and the gate is
// upstream's belt to that braces.
function teamScoreMovesOnKill(gameType) {
  return gameType === 'TeamFFA' || gameType === 'OpenFFA';
}

function getTeamScoreDeltasForKill(killerTeam, victimTeam, selfKill = false) {
  const deltas = [];
  if (killerTeam && killerTeam === victimTeam) {
    if (isColorTeam(victimTeam)) deltas.push({ team: victimTeam, wins: 0, losses: selfKill ? 1 : 2 });
    return deltas;
  }
  if (isColorTeam(killerTeam)) deltas.push({ team: killerTeam, wins: 1, losses: 0 });
  if (isColorTeam(victimTeam)) deltas.push({ team: victimTeam, wins: 0, losses: 1 });
  return deltas;
}

// null rather than rogue for anything that is not a team, so a caller cannot
// mistake an unknown name for team zero.
function getTeamColorIndex(team) {
  const normalized = typeof team === 'string' ? team.trim().toLowerCase() : '';
  const index = BZFLAG_TEAM_ORDER.indexOf(normalized);
  return index >= 0 ? index : null;
}

function getTeamFromColorIndex(colorIndex) {
  return BZFLAG_TEAM_ORDER[colorIndex] || null;
}

// Team::isColorTeam by index: red, green, blue and purple are the teams that
// hold bases and flags.
function isColorTeamIndex(colorIndex) {
  return Number.isInteger(colorIndex) && colorIndex >= 1 && colorIndex <= 4;
}

// bzfs.cxx:4010. A capture wins one for the capping team and loses one for the
// team whose flag it was. Carrying your own flag onto an enemy base wins nobody
// anything -- the capper is on the team that just lost it -- so `cappingTeam` is
// null for that case.
//
// Returned rather than applied so the rule can be tested against upstream's
// without a server around it, as the kill rule above is.
function getTeamScoreDeltasForCapture(cappingTeam, cappedTeam) {
  const deltas = [];
  if (cappingTeam && cappingTeam !== cappedTeam && isColorTeam(cappingTeam)) {
    deltas.push({ team: cappingTeam, wins: 1, losses: 0 });
  }
  if (isColorTeam(cappedTeam)) deltas.push({ team: cappedTeam, wins: 0, losses: 1 });
  return deltas;
}

// How far a team mate's shade may sit from the team colour, for
// getInitialPlayerColor below. The hue spread is bounded by the closest pair of
// team colours -- red at 0 and purple at 300, 60 degrees apart -- so ten degrees
// either side leaves 40 of clearance and no red is ever within reach of a
// purple. `check:team-shade-bands` asserts that against the table above rather
// than trusting this comment. Most of the separation comes from lightness for
// that reason, and because the team colours are already fully saturated and can
// only move down.
const TEAM_SHADE_HUE_SPREAD = 10;
const TEAM_SHADE_HUE_STEP = 5;
const TEAM_SHADE_SAT_SPREAD = 12;
const TEAM_SHADE_LIGHT_SPREAD = 14;
// Below this there is no hue to shade: observer's white would only go grey.
const TEAM_SHADE_MIN_SATURATION = 15;

function getPlayerTeamRadarColor(team) {
  return PLAYER_TEAM_RADAR_COLORS[normalizePlayerTeam(team)];
}

function getPlayerTeamColor(team) {
  return PLAYER_TEAM_COLORS[normalizePlayerTeam(team)];
}

// Upstream gives every tank on a team the one team colour (Team::getTankColor,
// Team.cxx:30) and has nothing per player -- do not go looking for it there.
// bzo shades team mates apart inside a band around that colour, for the same
// reason it gives every player a distinct colour outside team mode: so a player
// can tell two team mates apart at a range where the labels are unreadable. The
// team is still what the colour says first; the band is narrow enough that no
// shade of one team reads as another.
function getInitialPlayerColor(teamMode, team, pickDistinctColor) {
  return pickDistinctColor(teamMode.enabled ? team : null);
}

module.exports = {
  PLAYER_TEAM_COLORS,
  TEAM_SHADE_HUE_SPREAD,
  TEAM_SHADE_HUE_STEP,
  TEAM_SHADE_SAT_SPREAD,
  TEAM_SHADE_LIGHT_SPREAD,
  TEAM_SHADE_MIN_SATURATION,
  PLAYER_TEAM,
  PLAYER_TEAMS,
  BZFLAG_TEAM_ORDER,
  getTeamColorIndex,
  getTeamFromColorIndex,
  isColorTeamIndex,
  NON_TEAM_MODE_TEAMS,
  normalizePlayerTeam,
  normalizePlayerTeamSelection,
  normalizeServerTeamMode,
  parseBZWTeamMode,
  resolveTeamMode,
  selectPlayerTeam,
  getPlayerTeamColor,
  getPlayerTeamRadarColor,
  getInitialPlayerColor,
  isColorTeam,
  isObserverTeam,
  areFoes,
  getGameType,
  teamScoreMovesOnKill,
  getTeamScoreDeltasForKill,
  getTeamScoreDeltasForCapture,
};
