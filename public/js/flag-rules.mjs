/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Picking a flag up, for the server and for practice (docs/practice-plan.md,
// step 2): what a tank's client asks for (`checkEnvironment`), whether the
// game lets it (`grabFlag` in bzfs), and what taking it changes. Logging,
// plugin events and the cheat check stay with whoever calls.

import {
  FLAG_GRAB_LEVEL_TOLERANCE, FLAG_STATUS, getFlagGrabRadius, getFlagTeamIndex,
} from './flags.mjs';

// checkEnvironment's two checks, as a client makes them for its own tank:
// carrying a team flag onto a base whose team makes it a capture (another
// team's flag onto your base, or your own onto theirs), or driving over a
// flag on the ground. `{ capture: baseTeam }`, `{ grab: flag }` or null.
// `carriedType` is the held flag's type; `baseTeamAt(x, y, z)` the base under
// a point, or null.
export function environmentAsk({ self, myTeam, carriedType, flags, baseTeamAt }) {
  if (carriedType) {
    const flagTeam = getFlagTeamIndex(carriedType);
    if (flagTeam === null) return null;
    const baseTeam = baseTeamAt(self.x, self.y, self.z);
    if (baseTeam === null) return null;
    if ((flagTeam === myTeam) === (baseTeam === myTeam)) return null;
    return { capture: baseTeam };
  }
  if (self.inAir) return null;
  const radius = getFlagGrabRadius();
  for (const flag of flags) {
    if (flag.status !== FLAG_STATUS.ON_GROUND) continue;
    if (Math.abs(self.z - flag.position.z) >= FLAG_GRAB_LEVEL_TOLERANCE) continue;
    if (Math.hypot(self.x - flag.position.x, self.y - flag.position.y) >= radius) continue;
    return { grab: flag };
  }
  return null;
}

// Whether a tank may take a flag: playing, alive, holding nothing, and --
// with `checkPos`, upstream's own argument, off for an operator handing a flag
// out -- the flag on the ground. Where the tank is against the flag is the
// caller's check (`grabOutOfReach`), since what to do about it differs.
export function mayGrab({ observer, alive, paused, holding, flag, checkPos = true }) {
  if (observer || !alive || paused || holding) return false;
  return !checkPos || flag.status === FLAG_STATUS.ON_GROUND;
}

// How far off a grab is, when it is further than a tank could have come from
// it: the gap, or null when it is within reach. A tank on another level is
// never judged, as upstream's same-level test leaves it alone.
export function grabOutOfReach(tank, flag, tankSpeed, tankRadius, flagRadius) {
  if (Math.abs(tank.z - flag.position.z) >= FLAG_GRAB_LEVEL_TOLERANCE) return null;
  const gap = Math.hypot(tank.x - flag.position.x, tank.y - flag.position.y);
  return gap > tankSpeed + tankRadius + flagRadius ? gap : null;
}

// A flag as every client is told it: a superflag nobody holds hides its type,
// as bzfs hides it (bzfs.cxx:361), and a flight says how far through it is.
export function flagState(flag, now) {
  const hidden = flag.owner === null && flag.team === null;
  const flightTime = flag.flightStartedAt === 0
    ? 0
    : Math.min(flag.flightEnd, (now - flag.flightStartedAt) / 1000);
  return {
    index: flag.index,
    type: hidden ? null : flag.type,
    status: flag.status,
    owner: flag.owner,
    position: { ...flag.position },
    launchPosition: { ...flag.launchPosition },
    landingPosition: { ...flag.landingPosition },
    flightTime,
    flightEnd: flag.flightEnd,
    initialVelocity: flag.initialVelocity,
    // Phantom Zone's `PlayerState::FlagActive`. Sent as the state it is
    // rather than as a toggle, so a client that predicted its own crossing
    // converges on this instead of flipping a second time.
    zoned: flag.zoned === true,
  };
}

// The flag in `ownerId`'s hands from `now` (`FlagInfo::grab`): its flight
// over, its shake clock and shot count started again, and switched off until
// a teleporter turns Phantom Zone on.
export function takeFlag(flag, ownerId, now) {
  flag.owner = ownerId;
  flag.status = FLAG_STATUS.ON_TANK;
  flag.flightStartedAt = 0;
  flag.grabbedAt = now;
  flag.zoned = false;
  flag.shots = 0;
}
