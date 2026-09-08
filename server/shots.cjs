/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

const MAX_SHOT_SLOTS = 64;

function normalizeShotSlotCount(value) {
  const parsedValue = Number(value);
  if (!Number.isSafeInteger(parsedValue) || parsedValue < 1) {
    return 1;
  }
  if (parsedValue > MAX_SHOT_SLOTS) {
    return MAX_SHOT_SLOTS;
  }
  return parsedValue;
}

// PlayerId `ServerPlayer` (include/global.h), the id upstream gives every shot
// nobody fired: a world weapon's, and a death by drowning or a death physics
// driver. bzo allocates player ids from 1 and caps a server well below this, so
// it can never collide with a real player -- and a shot carrying it has no
// entry in the roster on purpose, which is what every path that looks a shooter
// up has to tolerate.
const WORLD_WEAPON_PLAYER_ID = 252;

// bz_vectorFromRotations (bzfsAPI.cxx:1845), which is how a world weapon's aim
// becomes a direction, converted to bzo's axes.
//
// Upstream builds it in BZFlag's frame:
//
//   (cos(tilt) * cos(rot), cos(tilt) * sin(rot), sin(tilt))
//
// and bzo is that frame relabelled -- bzo(x, y, z) = bzf(x, z, -y) -- so the
// second and third components swap and the new z takes the sign. `rotation` and
// `tilt` are radians here; the BZW file states both in degrees and
// `WorldFileLocation::read` and `CustomWeapon::read` convert.
function getWorldWeaponDirection(rotation, tilt) {
  const tiltFactor = Math.cos(tilt);
  return {
    x: tiltFactor * Math.cos(rotation),
    y: Math.sin(tilt),
    z: -tiltFactor * Math.sin(rotation),
  };
}

// CustomWeapon's defaults (CustomWeapon.cxx:32) and its floor on a delay: a
// weapon with no `initdelay` waits ten seconds for its first shot and one with
// no `delay` fires every ten after that. `minWeaponDelay` is upstream's own
// guard against a weapon asked to fire faster than the server ticks -- it skips
// such an entry with a message rather than accepting it.
const WORLD_WEAPON_DEFAULT_DELAY = 10;
const WORLD_WEAPON_MIN_DELAY = 0.1;

// The delay list a weapon actually cycles, from what the map asked for.
// Upstream keeps a vector and steps through it a shot at a time, wrapping at the
// end (WorldWeapons.cxx:181), so a map may give a rhythm rather than a rate. An
// entry under the floor is dropped; if that leaves nothing, the default stands.
function normalizeWorldWeaponDelays(delays) {
  const kept = (Array.isArray(delays) ? delays : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= WORLD_WEAPON_MIN_DELAY);
  return kept.length > 0 ? kept : [WORLD_WEAPON_DEFAULT_DELAY];
}

// WorldPlayer (WorldPlayer.cxx:17), which is the *only* identity a world weapon
// has: upstream keeps one pseudo-player for every world weapon on the map --
// `Player(ServerPlayer, RogueTeam, "world weapon", "", ComputerPlayer)` -- and
// its shots are drawn and put on the radar as that player's.
//
// It is a collective, not a name per weapon: `CustomWeapon::read` reads no
// `name`, and a weapon is not an obstacle, so there is nothing in the map to
// name one by. It is also not on the scoreboard, because it is not in
// `remotePlayers`, and bzo keeps it out of the roster for the same reason.
const WORLD_WEAPON_NAME = 'world weapon';
const WORLD_WEAPON_TEAM = 'rogue';

module.exports = {
  MAX_SHOT_SLOTS,
  normalizeShotSlotCount,
  WORLD_WEAPON_PLAYER_ID,
  WORLD_WEAPON_NAME,
  WORLD_WEAPON_TEAM,
  getWorldWeaponDirection,
  WORLD_WEAPON_DEFAULT_DELAY,
  WORLD_WEAPON_MIN_DELAY,
  normalizeWorldWeaponDelays,
};
