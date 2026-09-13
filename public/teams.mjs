/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// `MAP_VIEWER` (issue #68) exists only here, on the client: it is never a
// real team on the wire. Selecting it in the entry dialog sends a plain
// `observer` join, plus a `viewMap` field naming the chosen map -- same team
// limit, same team chat, same white scoreboard colour as any other observer,
// since upstream's `TeamColor`/`-mp` has no seventh slot for a bzo-only
// concept and bzo does not invent one either. It is in `ALL_PLAYER_TEAMS`
// below (so the normalizer round-trips it for the dialog's own bookkeeping)
// but deliberately left out of `PLAYER_TEAMS`, which is the list the server
// actually recognizes as an askable team.
export const PLAYER_TEAM = Object.freeze({
  AUTOMATIC: 'automatic',
  ROGUE: 'rogue',
  OBSERVER: 'observer',
  MAP_VIEWER: 'mapviewer',
  RED: 'red',
  BLUE: 'blue',
  GREEN: 'green',
  PURPLE: 'purple',
  RABBIT: 'rabbit',
  HUNTER: 'hunter',
});

// The teams a player may *ask* to join, which is what the entry dialog offers.
// Rabbit and hunter are missing on purpose: Rabbit Chase assigns both, so the
// server never sends either in `teamMode.teams` for the dialog to read. See
// ALL_PLAYER_TEAMS for the teams a player may be *on*.
export const PLAYER_TEAMS = Object.freeze([
  PLAYER_TEAM.ROGUE,
  PLAYER_TEAM.OBSERVER,
  PLAYER_TEAM.RED,
  PLAYER_TEAM.BLUE,
  PLAYER_TEAM.GREEN,
  PLAYER_TEAM.PURPLE,
]);
// Every team a player may be on, which is upstream's whole TeamColor enum bar
// the two pseudo-teams (`NumTeams` is 8, `global.h:59`) -- plus Map Viewer,
// client-only as described above.
export const ALL_PLAYER_TEAMS = Object.freeze([
  ...PLAYER_TEAMS,
  PLAYER_TEAM.RABBIT,
  PLAYER_TEAM.HUNTER,
  PLAYER_TEAM.MAP_VIEWER,
]);

// BZFlag's TeamColor numbering (global.h:59). A BZW `base` object names one of
// these in its `color` line, a team flag carries one as its team, and `-mp`
// lists its player counts in this order. bzo's own team order differs, so the
// two are mapped rather than assumed to agree.
export const BZFLAG_TEAM_ORDER = Object.freeze([
  PLAYER_TEAM.ROGUE,
  PLAYER_TEAM.RED,
  PLAYER_TEAM.GREEN,
  PLAYER_TEAM.BLUE,
  PLAYER_TEAM.PURPLE,
  PLAYER_TEAM.OBSERVER,
  PLAYER_TEAM.RABBIT,
  PLAYER_TEAM.HUNTER,
]);
export const PLAYER_TEAM_COLORS = Object.freeze({
  [PLAYER_TEAM.ROGUE]: 0xffff00,
  [PLAYER_TEAM.OBSERVER]: 0xffffff,
  // No upstream color to take: Map Viewer is bzo-only. Observer's white, for
  // the same reason Observer has it -- there is no tank to tell apart from
  // another's, so nothing needs a hue of its own.
  [PLAYER_TEAM.MAP_VIEWER]: 0xffffff,
  [PLAYER_TEAM.RED]: 0xff0000,
  [PLAYER_TEAM.BLUE]: 0x1a33ff,
  [PLAYER_TEAM.GREEN]: 0x00ff00,
  [PLAYER_TEAM.PURPLE]: 0xff00ff,
  // Team::tankColor's last two rows (Team.cxx:27): rabbit light grey, hunter
  // orange. Only the rabbit's is painted -- hunters keep the per-player colour
  // every bzo player has, since one colour for the crowd is what hunter orange
  // was for. See getEffectiveTankColor in client.js.
  [PLAYER_TEAM.RABBIT]: 0xcccccc,
  [PLAYER_TEAM.HUNTER]: 0xff8000,
});

export const PLAYER_TEAM_LABELS = Object.freeze({
  [PLAYER_TEAM.AUTOMATIC]: 'Automatic',
  [PLAYER_TEAM.ROGUE]: 'Rogue',
  [PLAYER_TEAM.OBSERVER]: 'Observer',
  [PLAYER_TEAM.MAP_VIEWER]: 'Map Viewer',
  [PLAYER_TEAM.RED]: 'Red Team',
  [PLAYER_TEAM.BLUE]: 'Blue Team',
  [PLAYER_TEAM.GREEN]: 'Green Team',
  [PLAYER_TEAM.PURPLE]: 'Purple Team',
  [PLAYER_TEAM.RABBIT]: 'Rabbit',
  [PLAYER_TEAM.HUNTER]: 'Hunter',
});

// Team::radarColor (Team.cxx:30). Deliberately not the tank colours: red, green
// and purple are lifted so a team reads against a dark radar, where the tank
// colours sink into it. Upstream uses these for everything it draws on the
// radar, so bzo does too.
export const PLAYER_TEAM_RADAR_COLORS = Object.freeze({
  [PLAYER_TEAM.ROGUE]: 0xffff00,
  [PLAYER_TEAM.OBSERVER]: 0xffffff,
  [PLAYER_TEAM.MAP_VIEWER]: 0xffffff,
  [PLAYER_TEAM.RED]: 0xff2626,
  [PLAYER_TEAM.BLUE]: 0x1440ff,
  [PLAYER_TEAM.GREEN]: 0x33e633,
  [PLAYER_TEAM.PURPLE]: 0xff66ff,
  // The rabbit reads white on the radar rather than grey, which is upstream's
  // own choice (Team.cxx:38) and the same reasoning as the other four: the
  // radar's colours are lifted so a team reads against a dark panel.
  [PLAYER_TEAM.RABBIT]: 0xffffff,
  [PLAYER_TEAM.HUNTER]: 0xff8000,
});

export function normalizePlayerTeam(team) {
  const normalized = typeof team === 'string' ? team.trim().toLowerCase() : '';
  return ALL_PLAYER_TEAMS.includes(normalized) ? normalized : PLAYER_TEAM.ROGUE;
}

export function isRabbitTeam(team) {
  return normalizePlayerTeam(team) === PLAYER_TEAM.RABBIT;
}

export function normalizePlayerTeamSelection(team) {
  const normalized = typeof team === 'string' ? team.trim().toLowerCase() : '';
  return normalized === PLAYER_TEAM.AUTOMATIC ? PLAYER_TEAM.AUTOMATIC : normalizePlayerTeam(normalized);
}

export function getPlayerTeamSelections(availableTeams) {
  return [PLAYER_TEAM.AUTOMATIC, ...PLAYER_TEAMS.filter((team) => availableTeams.includes(team))];
}

export function isObserverTeam(team) {
  return normalizePlayerTeam(team) === PLAYER_TEAM.OBSERVER;
}

// Team::isColorTeam upstream, which is red through purple and nothing else.
// Every other team carries no team score: a rogue kill feeds nobody's tally and
// neither does dying as one, and the same goes for the rabbit and the hunters.
export function isColorTeam(team) {
  return isColorTeamIndex(getTeamColorIndex(normalizePlayerTeam(team)));
}

// null rather than rogue for anything that is not a team, so a caller cannot
// mistake an unknown name for team zero.
export function getTeamColorIndex(team) {
  const normalized = typeof team === 'string' ? team.trim().toLowerCase() : '';
  const index = BZFLAG_TEAM_ORDER.indexOf(normalized);
  return index >= 0 ? index : null;
}

export function getTeamFromColorIndex(colorIndex) {
  return BZFLAG_TEAM_ORDER[colorIndex] || null;
}

// Team::isColorTeam by index: red, green, blue and purple are the teams that
// hold bases and flags.
export function isColorTeamIndex(colorIndex) {
  return Number.isInteger(colorIndex) && colorIndex >= 1 && colorIndex <= 4;
}

// bzfs.cxx:4010. A capture wins one for the capping team and loses one for the
// team whose flag it was. Carrying your own flag onto an enemy base wins nobody
// anything -- the capper is on the team that just lost it -- so `cappingTeam` is
// null for that case.
//
// Returned rather than applied so the rule can be tested against upstream's
// without a server around it, as the kill rule above is.
export function getTeamScoreDeltasForCapture(cappingTeam, cappedTeam) {
  const deltas = [];
  if (cappingTeam && cappingTeam !== cappedTeam && isColorTeam(cappingTeam)) {
    deltas.push({ team: cappingTeam, wins: 1, losses: 0 });
  }
  if (isColorTeam(cappedTeam)) deltas.push({ team: cappedTeam, wins: 0, losses: 1 });
  return deltas;
}

// Score::ranking (Score.cxx:42), and `rabbitRank` in the client's own Player.cxx
// -- upstream keeps the same formula twice for the same reason bzo keeps it in
// this pair: the server picks the rabbit with it and the client sorts the
// scoreboard by it, so a board that disagreed would stop predicting who is next.
//
// A win *rate* rather than a win count, discounted for how short the record is:
// the second factor is 0.5 after one game, 0.75 after four and 0.9 after
// twenty-five, so a rank always sits below the rate it came from and creeps up
// towards it. No record at all is a flat 0.5, which is the one value the formula
// does not produce -- and which beats every even record, 1-1 ranking 0.32.
export function getPlayerRanking(wins, losses) {
  const sum = wins + losses;
  if (sum === 0) return 0.5;
  return (wins / sum) * (1 - (0.5 / Math.sqrt(sum)));
}

export function getPlayerTeamRadarColor(team) {
  return PLAYER_TEAM_RADAR_COLORS[normalizePlayerTeam(team)];
}

export function getPlayerTeamColor(team) {
  return PLAYER_TEAM_COLORS[normalizePlayerTeam(team)];
}
