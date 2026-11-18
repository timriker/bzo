/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Where a tank is `dt` seconds after the move it last sent: upstream's
// `Player::getDeadReckoning` (Player.cxx:1122). The server reads it to judge
// the next move, and a client to draw another tank between moves, so both
// predict the same path.
//
// A move states the tank's own motion -- `fs` and `rs` as fractions of the
// world's speed and turn rate, and in the air its air velocity -- and names
// the physics driver it stands on. The driver's push and spin go on top, as
// upstream adds them back after `calcRelativeMotion` took them out.

import { getGroundLimit, hasAirControl } from './flags.mjs';

// `state` is the move: x, y, z, azimuth, forwardSpeed, rotationSpeed,
// verticalVelocity, jumpAzimuth (set in the air), slideAzimuth, airVelocityX,
// airVelocityY, flagType and paused. `driver` is the physics driver the move
// named, with `linear` [x, y, z] and `angular` [radians a second, x, y].
export function deadReckon(state, dt, config, driver = null) {
  const { x, y, z, azimuth } = state;
  // A paused tank does not move, whatever it was doing when the pause landed.
  if (state.paused || !(dt > 0)) return { x, y, z, azimuth };
  const rotSpeed = config.TANK_ROTATION_SPEED || 1.5;
  const speed = config.TANK_SPEED || 15;
  const rs = state.rotationSpeed || 0;
  const fs = state.forwardSpeed || 0;

  // "no control when falling": the air velocity, or the jump's speed along the
  // direction it left on, and gravity on the way. No driver reaches a tank in
  // the air.
  if (state.jumpAzimuth !== null && state.jumpAzimuth !== undefined) {
    const hasAirVelocity = Number.isFinite(state.airVelocityX) && Number.isFinite(state.airVelocityY);
    const moveAzimuth = state.slideAzimuth !== undefined ? state.slideAzimuth : state.jumpAzimuth;
    const dx = hasAirVelocity ? state.airVelocityX * dt : Math.cos(moveAzimuth) * fs * speed * dt;
    const dy = hasAirVelocity ? state.airVelocityY * dt : Math.sin(moveAzimuth) * fs * speed * dt;
    const gravity = hasAirControl(state.flagType) ? config.WINGS_GRAVITY : config.GRAVITY;
    const vv = state.verticalVelocity || 0;
    return {
      x: x + dx,
      y: y + dy,
      // Never below this tank's own ground, Burrow's included (Player.cxx:1333).
      z: Math.max(getGroundLimit(state.flagType ?? null), z + (vv * dt) + (0.5 * gravity * dt * dt)),
      azimuth: azimuth + (rs * rotSpeed * dt),
    };
  }

  // On the ground: a straight line, or the arc a turning tank drives.
  let px;
  let py;
  let pa = azimuth;
  if (Math.abs(rs) < 0.001) {
    // A tank sliding along something moves along the slide, not its heading.
    const moveAzimuth = state.slideAzimuth !== undefined ? state.slideAzimuth : azimuth;
    px = x + (Math.cos(moveAzimuth) * fs * speed * dt);
    py = y + (Math.sin(moveAzimuth) * fs * speed * dt);
  } else {
    const angularVelocity = rs * rotSpeed;
    const theta = angularVelocity * dt;
    const reach = (fs * speed) / angularVelocity;
    px = x + (reach * (Math.sin(azimuth + theta) - Math.sin(azimuth)));
    py = y - (reach * (Math.cos(azimuth + theta) - Math.cos(azimuth)));
    pa = azimuth + theta;
  }

  // The driver: its spin turns the tank and carries it round the centre, then
  // its push moves it on. Its vertical push makes a tank fall, which is the
  // air branch above.
  if (driver?.angular) {
    const [spin, cx, cy] = driver.angular;
    const angle = spin * dt;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = px - cx;
    const dy = py - cy;
    px = cx + (dx * cos) - (dy * sin);
    py = cy + (dy * cos) + (dx * sin);
    pa += angle;
  }
  if (driver?.linear) {
    px += driver.linear[0] * dt;
    py += driver.linear[1] * dt;
  }
  return { x: px, y: py, z, azimuth: pa };
}

// A velocity and turn rate as upstream's update carries them, the driver's
// push and spin in them, taken down to the tank's own: `calcRelativeMotion`
// (Player.cxx:341). `x`, `y` is where the tank is.
export function relativeMotion(vx, vy, angVel, x, y, driver) {
  let rx = vx;
  let ry = vy;
  let rAngVel = angVel;
  if (driver?.linear) {
    rx -= driver.linear[0];
    ry -= driver.linear[1];
  }
  if (driver?.angular) {
    const [spin, cx, cy] = driver.angular;
    rx += spin * (y - cy);
    ry -= spin * (x - cx);
    rAngVel -= spin;
  }
  return { vx: rx, vy: ry, angVel: rAngVel };
}

// `relativeMotion` run backwards: the tank's own motion with the driver's put
// back in, as upstream's update carries it.
export function absoluteMotion(vx, vy, angVel, x, y, driver) {
  let ax = vx;
  let ay = vy;
  let aAngVel = angVel;
  if (driver?.linear) {
    ax += driver.linear[0];
    ay += driver.linear[1];
  }
  if (driver?.angular) {
    const [spin, cx, cy] = driver.angular;
    ax -= spin * (y - cy);
    ay += spin * (x - cx);
    aAngVel += spin;
  }
  return { vx: ax, vy: ay, angVel: aAngVel };
}
