/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Upstream's PlayerId space (`Address.h:73-78`), which bzo uses as its own.
// A PlayerId is one byte: players hold 0 through `LastRealPlayer`, and the
// destinations that are not a player live at the top of it.
//
// bzo numbers players the same way for two reasons. A slot number is what the
// scoreboard shows and what an id-taking command names, so it should mean the
// same thing in bzo as in BZFlag; and a proxied player's id is the target's
// own (docs/proxy.md), which only works if both wires agree about which
// numbers a player may hold. bzo's ids are strings of these numbers, since
// they are object keys rather than bytes.

// The highest id a player can hold. Upstream derives it as `FirstTeam` minus
// `NumTeams`, which is 8.
export const LAST_REAL_PLAYER = 243;
// A message to a team: 251 to Rogue, counting down by upstream's team index
// to 244 for Hunter (`FirstTeam - team`, Roster.cxx:120).
export const FIRST_TEAM = 251;
export const ADMIN_PLAYERS = 252;
export const SERVER_PLAYER = 253;
export const ALL_PLAYERS = 254;
// Upstream's "nobody", which bzo has no use for beyond reading one off the
// wire: a flag nobody carries packs its owner as this.
export const NO_PLAYER = 255;

// Whether an id names a player rather than one of the destinations above.
// Takes either spelling, since bzo carries ids as strings and bzfs as bytes.
export function isRealPlayerId(id) {
  const number = Number(id);
  return Number.isInteger(number) && number >= 0 && number <= LAST_REAL_PLAYER;
}

// The destination for a message to the team with upstream's index `team`.
export function teamChannel(team) {
  return FIRST_TEAM - team;
}

// The team index a destination names, or null when it names no team. Takes
// either spelling, as `isRealPlayerId` does.
export function channelTeam(id) {
  const number = Number(id);
  return Number.isInteger(number) && number > LAST_REAL_PLAYER && number <= FIRST_TEAM
    ? FIRST_TEAM - number : null;
}
