/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

import { getSegmentTankHitFraction, TANK } from './collision.mjs';
import {
  cloaksTheTank,
  getTankHitRadiusScale,
  shotPassesThroughTank,
  usesNarrowHitBox,
} from './flags.mjs';
import { areFoes, isObserverTeam } from './teams.mjs';

// Keep client-side allocations bounded even when the server configuration
// arrives through an untrusted WebSocket payload.
export const MAX_SHOT_SLOTS = 64;

// Zero survives: `-ms 0` means "tanks cannot shoot" upstream
// (`CmdLineOptions.cxx:897-909`, which warns and then honours it), and it is
// only a *negative* or unparseable count that upstream turns into one shot.
// Everything that can fire asks this first, so a world with no slots refuses
// every shot by arithmetic rather than by a switch of its own.
//
// Which means absence has to be told from a stated zero before the number is
// taken: `Number(null)`, `Number(false)` and `Number('')` are all 0, and none
// of them is a world saying it has no shooting.
export function normalizeShotSlotCount(value) {
  if (value === null || typeof value === 'boolean') {
    return 1;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return 1;
  }
  const parsedValue = Number(value);
  if (!Number.isSafeInteger(parsedValue) || parsedValue < 0) {
    return 1;
  }
  if (parsedValue > MAX_SHOT_SLOTS) {
    return MAX_SHOT_SLOTS;
  }
  return parsedValue;
}

// PlayerId `ServerPlayer` (Address.h:75), the id upstream gives every shot
// nobody fired: a world weapon's, and a death by drowning or a death physics
// driver. It is one of five reserved ids -- 255 NoPlayer, 254 AllPlayers, 253
// ServerPlayer, 252 AdminPlayers, 251 and down for the teams -- and it is a
// number where a bzo player id is the decimal *string* of its player number, so
// the two can never be equal however many players join. A shot carrying it has
// no entry in the roster on purpose, which is what every path that looks a
// shooter up has to tolerate.
export const WORLD_WEAPON_PLAYER_ID = 253;

// GuidedMissileStrategy::update times out only the shooter's own missile
// (`!isRemote`, GuidedMissleStrategy.cxx:128), and the shooter's `expire` is
// what ends it everywhere else (`sendEndShot`, :464). A world weapon has no
// shooter to do either, so its missile flies until it hits the ground, a
// building or the world's edge. The cap is bzo's: long enough to cross the
// world twice, so a missile aimed at the sky is still dropped. Null for any
// other shot, which keeps its ordinary life.
export function getWorldMissileLifetimeSeconds(playerId, guided, mapSize, speed) {
  if (!guided || String(playerId) !== String(WORLD_WEAPON_PLAYER_ID)) return null;
  if (!(mapSize > 0) || !(speed > 0)) return null;
  return (2 * mapSize) / speed;
}

// bz_vectorFromRotations (bzfsAPI.cxx:1845), which is how a world weapon's aim
// becomes a direction:
//
//   (cos(tilt) * cos(rot), cos(tilt) * sin(rot), sin(tilt))
//
// `rotation` and `tilt` are radians here; the BZW file states both in degrees
// and `WorldFileLocation::read` and `CustomWeapon::read` convert.
export function getWorldWeaponDirection(rotation, tilt) {
  const tiltFactor = Math.cos(tilt);
  return {
    x: tiltFactor * Math.cos(rotation),
    y: tiltFactor * Math.sin(rotation),
    z: Math.sin(tilt),
  };
}

// FiringInfo (ShotPath.cxx:29) and LocalPlayer::fireShot (LocalPlayer.cxx:1250):
// a shot leaves with its tank's own velocity plus the world's shot speed along
// the barrel, and keeps a vertical part only on a server that sets
// `_shotsKeepVerticalVelocity` -- the tank's climb or fall otherwise stays with
// the tank. This is the velocity `shoot` carries, before any flag has scaled
// it, as upstream's MsgShotBegin carries it.
export function getMuzzleVelocity(direction, tankVelocity, shotSpeed, keepVertical) {
  return {
    x: tankVelocity.x + (shotSpeed * direction.x),
    y: tankVelocity.y + (shotSpeed * direction.y),
    z: keepVertical ? tankVelocity.z + (shotSpeed * direction.z) : 0,
  };
}

// What a shot's strategy makes of that velocity, which every screen flying the
// shot decides for itself upstream as well. The segmented shots -- an ordinary
// shell, Rapid Fire, Machine Gun, Laser, Thief -- scale the whole of it by the
// flag's factor (SegmentedShotStrategy.cxx:641), so a moving tank's shell is
// faster forward and slower backward; a Guided Missile takes only its heading
// and flies at the world's shot speed (GuidedMissleStrategy.cxx:75); a shock
// wave does not move. `null` for a velocity with no heading to take.
export function getShotFlight(velocity, effects, shotSpeed) {
  const length = Math.hypot(velocity.x, velocity.y, velocity.z);
  if (effects.shockwave) {
    return length > 1e-6
      ? { x: velocity.x / length, y: velocity.y / length, z: velocity.z / length, speed: 0 }
      : { x: 0, y: 0, z: 0, speed: 0 };
  }
  if (!(length > 1e-6)) return null;
  return {
    x: velocity.x / length,
    y: velocity.y / length,
    z: velocity.z / length,
    speed: effects.guided ? shotSpeed : length * effects.velocityFactor,
  };
}

// CustomWeapon's defaults (CustomWeapon.cxx:32) and its floor on a delay: a
// weapon with no `initdelay` waits ten seconds for its first shot and one with
// no `delay` fires every ten after that. `minWeaponDelay` is upstream's own
// guard against a weapon asked to fire faster than the server ticks -- it skips
// such an entry with a message rather than accepting it.
export const WORLD_WEAPON_DEFAULT_DELAY = 10;
export const WORLD_WEAPON_MIN_DELAY = 0.1;

// The delay list a weapon actually cycles, from what the map asked for.
// Upstream keeps a vector and steps through it a shot at a time, wrapping at the
// end (WorldWeapons.cxx:181), so a map may give a rhythm rather than a rate. An
// entry under the floor is dropped; if that leaves nothing, the default stands.
export function normalizeWorldWeaponDelays(delays) {
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
export const WORLD_WEAPON_NAME = 'world weapon';
export const WORLD_WEAPON_TEAM = 'rogue';

// --- Shot slots as a clock ---------------------------------------------------

// The world's `_reloadTime`, in seconds. Upstream declares it
// `_shotRange / _shotSpeed` (global.cxx:127) and a map may state its own, which
// is what `SHOT_LIFETIME` carries. Everything below is a multiple of it, and so
// is a shot's life, so both ends have to read it the same way or they disagree
// about when a slot comes back.
export function getWorldReloadSeconds(config) {
  const lifetimeMs = Number(config?.SHOT_LIFETIME);
  if (Number.isFinite(lifetimeMs) && lifetimeMs > 0) return lifetimeMs / 1000;
  const speed = Number.isFinite(config?.SHOT_SPEED) ? config.SHOT_SPEED : 100;
  const range = Number.isFinite(config?.SHOT_RANGE)
    ? config.SHOT_RANGE
    : (Number.isFinite(config?.SHOT_DISTANCE) ? config.SHOT_DISTANCE : 350);
  return speed > 0 ? range / speed : 10;
}

// How long one slot is out of action after it is fired: `ShotPath::reloadTime`,
// which starts at the world's reload and is divided by the firing flag's rate in
// each segmented strategy's constructor -- `setReloadTime(reload / adRate)`.
//
// **This is the client's rule, not bzfs's, and that is deliberate.** bzfs frees
// a slot on the shot's *life* instead (`GameKeeper::addShot` tests
// `now < shotsInfo[id].expireTime`, and `expireTime` comes from
// `GetShotLifetime`), which for `L`, `SW` and `TH` is far shorter than the
// reload an honest bzflag client waits out. Holding bzo to the client's rule is
// what keeps a bzo player level with a desktop one rather than ahead of them,
// and it means every shot bzo sends is one the target server will accept --
// a shot bzfs refuses is simply dropped, which on a phone would look like a
// trigger that sometimes does nothing.
export function getSlotReloadSeconds(worldReloadSeconds, rateFactor) {
  const rate = Number.isFinite(rateFactor) && rateFactor > 0 ? rateFactor : 1;
  return worldReloadSeconds / rate;
}

// `LocalPlayer::getReloadTime` (LocalPlayer.cxx:1315) walking `shots[]` for an
// empty slot, with the shells replaced by the times their slots come back.
//
// A slot is free once its reload has elapsed since it was *filled*, and nothing
// frees one early: `LocalPlayer` reaps a slot on `isReloaded()` and not on
// `isExpired()`, and bzfs's `removeShot` clears a shot's `running` flag while
// leaving its `expireTime` alone. The slot belongs to the weapon, so a shell
// that stops against a wall a metre away costs exactly what one that flies its
// whole range costs.
//
// Returns the lowest free slot, or -1 when every slot is still reloading.
export function findFreeShotSlot(slotFreeAt, slotCount, now) {
  for (let slot = 0; slot < slotCount; slot++) {
    const freeAt = Number(slotFreeAt?.[slot]);
    if (!Number.isFinite(freeAt) || freeAt <= now) return slot;
  }
  return -1;
}

// How many of the slots are ready to fire now -- a bot keeps some of these
// back on a server that allows several.
export function countFreeShotSlots(slotFreeAt, slotCount, now) {
  let free = 0;
  for (let slot = 0; slot < slotCount; slot++) {
    const freeAt = Number(slotFreeAt?.[slot]);
    if (!Number.isFinite(freeAt) || freeAt <= now) free += 1;
  }
  return free;
}

// How ready a slot is, 0 to 1, for the row of bars beside the control box
// (HUDRenderer.cxx:1988). A slot that was never fired reads full.
export function getShotSlotProgress(slotFreeAt, slot, reloadMs, now) {
  const freeAt = Number(slotFreeAt?.[slot]);
  if (!Number.isFinite(freeAt) || freeAt <= now) return 1;
  if (!(reloadMs > 0)) return 1;
  return Math.max(0, Math.min(1, 1 - ((freeAt - now) / reloadMs)));
}

// The shortest gap bzo puts between two shots fired by two separate pulls of
// the trigger. **Upstream has nothing to copy here.** Its BZDB table
// (global.cxx) has `_reloadTime` and the per-flag `AdRate`/`AdLife` pairs and
// no trigger tuning of any kind, and its own held-trigger behaviour is whatever
// the platform does: `SDL2Display.cxx:544` never checks `event.key.repeat`, so
// a held fire *key* auto-repeats at the operating system's rate while a held
// mouse button fires once.
//
// bzo needs an answer because it has a touch button, an XR trigger and a
// gamepad where upstream has a mouse. This is a floor on the *tap* path only --
// a guard against one press being read twice, or a finger resting on a virtual
// button emptying every slot in three frames. At 100ms it sits at about the
// rate a practised player can click a mouse, so it takes nothing away from a
// deliberate burst and leaves a bzo player no faster than a desktop one.
//
// Client-side only, and deliberately not sent to the server or enforced there:
// a server-side gate this short would compare shots inside the range network
// jitter actually lands in. See the shot slots above for the rule that *is*
// enforced.
export const SHOT_TAP_SPACING_MS = 100;

// GuidedMissileStrategy::checkHit (:318): "GM is not active until activation
// time passes (for any tank)". The tank the rule is really for is the one that
// fired it -- a missile locked onto a target two lengths away comes round
// through its own shooter.
export function shotIsActive(shot, now) {
  if (!(shot.activationTime > 0)) return true;
  return ((now - shot.createdAt) / 1000) >= shot.activationTime;
}

// LocalPlayer::checkHit (LocalPlayer.cxx:1596), as one question about one tank:
// may this shot hit it, and if so where. Upstream asks it on the victim's own
// client because bzfs takes the victim's word for a death; bzo's server asks it
// of every tank because bzo decides hits itself. Both are here so the two can
// never answer differently -- which matters most on a proxied connection, where
// the same client is playing by upstream's rule and bzo's at once.
//
// What a flag *means* arrives resolved: `flagType` is the victim's flag, and
// the caller is whichever side already knows it.
export function getShotTankHit(shot, from, to, tank, rules = {}) {
  const { noTeamKills = false, teamsAllowed = true, shotRadius = 0.5 } = rules;

  // LocalPlayer::checkHit tests a player's own shots too -- "Don't shoot
  // yourself!" is the Ricochet flag's own help text -- but only once one has
  // bounced. Before that a shot leaves the muzzle beyond the hit radius and
  // outruns the tank it came from.
  // "my own shock wave cannot kill me ... or Thief" (LocalPlayer.cxx:1612).
  // Unlike a ricochet, no bounce ever earns a thief its own flag back.
  if (tank.id === shot.playerId && (shot.steals || shot.bounces === 0)) return null;
  if (isObserverTeam(tank.team)) return null; // No tank to hit
  if (tank.paused) return null; // Can't hit paused players
  if (!tank.alive) return null; // Can't hit dead players

  // "-noTeamKills: Players on the same team are immune to each other's shots.
  // Rogue is excepted." Upstream refuses this on the victim's own client
  // (LocalPlayer.cxx:1616). Your own shot still reaches you once it has
  // bounced -- upstream excepts the shooter too (`source != this`), because a
  // ricochet you drove into is nobody's team kill.
  //
  // "Thief can still take a teammate's flag" -- upstream excepts it from the
  // guard by name (LocalPlayer.cxx:1617), because nothing about a theft is a
  // kill and a team mate carrying the flag you want is exactly who you rob.
  if (noTeamKills && !shot.steals && tank.id !== shot.playerId
    && !areFoes(shot.team, tank.team, teamsAllowed)) return null;

  // `ThiefStrategy::isStoppedByHit` returns false: a thief's beam is not spent
  // by a tank, so a tank with nothing to take does not block it. bzo stops it
  // at the first tank it can actually rob instead, which is the one place it
  // does not simply follow upstream -- upstream lets every client along the
  // beam report its own theft, and the thief keeps only the last of them while
  // bzfs zaps the rest. Robbing one tank per shot loses nothing anybody wanted
  // and destroys nothing.
  if (shot.steals && !tank.flagType) return null;

  // LocalPlayer::checkHit (LocalPlayer.cxx:1630): "laser can't hit a cloaked
  // tank". The one per-viewer rule that is not a matter of what somebody can
  // see -- a cloaked tank is genuinely immune to a beam. It is also the reason
  // `CL` is a good flag rather than a cosmetic one.
  if (shot.flag === 'L' && cloaksTheTank(tank.flagType ?? null)) return null;

  // LocalPlayer::checkHit's phantom pair (LocalPlayer.cxx:1622 and :1634): a
  // zoned tank is only reached by a super bullet, a shock wave or another
  // zoned tank's bullet, and a zoned bullet reaches nobody else.
  if (shotPassesThroughTank(shot.flag, tank.zoned)) return null;

  // SegmentedShotStrategy::checkHit's first test (SegmentedShotStrategy.cxx:254):
  // the segment's bounding box must overlap the tank's, whose height is
  // `_tankHeight` up from its feet (BaseLocalPlayer.cxx:110). The sphere below
  // reaches well above and below that, so this is what lets a level shell pass
  // over a tank at `_burrowDepth`.
  if (Math.max(from.z, to.z) < tank.position.z
    || Math.min(from.z, to.z) > tank.position.z + TANK.hitHeight) return null;

  const narrow = usesNarrowHitBox(tank.flagType ?? null);
  const fraction = getSegmentTankHitFraction(from, to, tank.position, {
    narrow,
    radiusScale: getTankHitRadiusScale(tank.flagType ?? null),
    shotRadius,
  });
  if (fraction === null) return null;

  // Narrow's box stands the tank's height; the sphere has its own.
  const z = from.z + ((to.z - from.z) * fraction);
  if (narrow && (z < tank.position.z || z > tank.position.z + TANK.hitHeight)) return null;

  return {
    fraction,
    point: {
      x: from.x + ((to.x - from.x) * fraction),
      y: from.y + ((to.y - from.y) * fraction),
      z,
    },
  };
}

// `ShockWaveStrategy::checkHit` (ShockWaveStrategy.cxx:107), with the guards
// `LocalPlayer::checkHit` puts in front of it. A wave is its own shape of hit
// and gets its own rule rather than a mode of the one above: it is a sphere
// rather than a segment, and upstream's own comment says why the rest of the
// tests do not apply to it -- "a shock wave can kill anything inside the
// radius, be it behind or in a building or even zoned".
//
// `radius` is the wave's current one, which is a function of its age
// (`getShockWaveRadius`) and so is the caller's to compute.
export function shockWaveHitsTank(shot, tank, rules = {}) {
  const { noTeamKills = false, teamsAllowed = true } = rules;

  // "my own shock wave cannot kill me" (LocalPlayer.cxx:1612). Unlike a
  // ricochet there is no bounce that could ever earn it.
  if (tank.id === shot.playerId) return false;
  if (isObserverTeam(tank.team)) return false;
  if (tank.paused) return false;
  if (!tank.alive) return false;
  // Friendly fire, as for any other shot: upstream's team-kill guard is one
  // test in one loop over every shot the shooter owns, and a shock wave is one
  // of them.
  if (noTeamKills && !areFoes(shot.team, tank.team, teamsAllowed)) return false;

  const dx = tank.position.x - shot.x;
  const dy = tank.position.y - shot.y;
  const dz = tank.position.z - shot.z;
  return ((dx * dx) + (dy * dy) + (dz * dz)) <= (shot.radius * shot.radius);
}
