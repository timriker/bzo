/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// drive.mjs - One tank's frame: what its controls ask for, turned into where it
// goes. LocalPlayer::doUpdateMotion's whole input-to-motion chain -- the flags'
// clamps and factors, Agility, Burrow, Wings, Bouncy, momentum, coasting through
// the air, jumping, the one collision pass, landing and falling -- with nothing
// in it about drawing, sound, the network or whose tank it is. A browser, a bot
// this server runs and a bot in a practice Worker all drive by it, so a tank
// moves the same way whoever is behind the stick.
//
// The caller holds a `DriveState` (`createDriveState`), says each frame what
// the controls are (`readDriveInput`) and steps it (`stepDrive`). What the step
// did that somebody might want to show, hear or tell the server about comes
// back as events; the state itself is all a host needs to place the tank and
// fill in a move packet (`movePacketFields`).
//
// `tank` is { flag, motionFlag, zoned, unlimitedFlaps }: the flag in hand, the
// one motion is decided by (a driving observer's is Wings), whether a Phantom
// Zone tank is zoned, and whether flaps never run out. `world` is { config,
// colliders, topOf(obs), teleport?(from, to, state) }, `clock` { now, random() }
// in seconds.

const {
  applyAccelerationLimit,
  applyMotionInput,
  BURROW_GRAVITY_FACTOR,
  canJump,
  drivesThroughBuildings,
  getAccelerationLimits,
  getBounceState,
  getBouncyJumpVelocity,
  getBurrowFactors,
  getGroundLimit,
  getMaxAngVelFactor,
  getMaxSpeedFactor,
  getMotionEffects,
  getSpeedFactor,
  getTankDimensionScale,
  getWingsJumpVelocity,
  getWingsSlideVelocity,
  hasAirControl,
  togglesZoneOnTeleport,
} = require('./flags.cjs');
const {
  findMeshHitFaceOriented,
  findTankObstacle,
  getColliderLocalPoint,
  getTankHitNormal,
  getTankLocalAngle,
  isPyramidFlatTop,
  meshFlatTopYsAt,
  movingTankOverlapsHeight,
  pyramidIntersectsTank,
  resolvePhysicsDriverAt,
  testOrigRectTank,
  TANK,
} = require('./collision.cjs');
const { normalizeAngle, resolveTankMotion } = require('./motion.cjs');
const { getMuzzleVelocity } = require('./shots.cjs');

// The occupant height the collision test uses for a tank.
// A change in an airborne tank's horizontal velocity worth a move of its own.
const AIR_VELOCITY_THRESHOLD = 0.35;
// The muzzle a tank model reports when there is no model to ask. The height is
// BZDB_MUZZLEHEIGHT, and also the floor the roaming camera rests on, so an
// observer sits at the eye height of a tank on the ground.
const GROUND_LIMIT_TOLERANCE = 0.01;


// A tank standing where it was put, at rest.
function createDriveState({ x = 0, y = 0, z = 0, rotation = 0 } = {}) {
  return {
    x,
    y,
    z,
    rotation,
    verticalVelocity: 0,
    airVelocityX: 0,
    airVelocityZ: 0,
    // The heading a jump or a fall left with, and null on a surface.
    jumpDirection: null,
    onGround: y <= 0,
    onObstacle: y > 0,
    inAir: false,
    lastObstacle: null,
    insideBuildings: [],
    // doMomentum's velocities, in world units and radians a second.
    lastSpeed: 0,
    lastAngVel: 0,
    // This frame's ceilings: what full stick gives, and how fast either may
    // change (0, no limit).
    topSpeed: 0,
    turnRate: 0,
    linearLimit: 0,
    angularLimit: 0,
    previousSpeedFraction: 0,
    agilityStartedAt: -Infinity,
    jumpForwardSpeed: 0,
    fallForwardSpeed: 0,
    // The direction an airborne tank is travelling, and a grounded one sliding
    // along something, where either differs from its heading.
    slideDirection: undefined,
    groundSlideDirection: null,
    // What the tank did, as a move packet reports it: fractions of the world's
    // tank speed and turn rate.
    forwardSpeed: 0,
    rotationSpeed: 0,
    stuckFrameCount: 0,
    wingsFlapsLeft: 0,
    jumpWasHeld: false,
    wasAirborne: false,
    bounceReadyAt: 0,
  };
}

// The air velocity, and the speed and direction a packet spells it as.
function setAirVelocity(state, vx, vz, config) {
  state.airVelocityX = vx;
  state.airVelocityZ = vz;
  const horizontalSpeed = Math.hypot(vx, vz);
  if (horizontalSpeed > 0.001 && config && config.TANK_SPEED) {
    state.jumpForwardSpeed = horizontalSpeed / config.TANK_SPEED;
    state.fallForwardSpeed = state.jumpForwardSpeed;
    state.slideDirection = Math.atan2(-vx, -vz);
  } else {
    state.jumpForwardSpeed = 0;
    state.fallForwardSpeed = 0;
    state.slideDirection = undefined;
  }
}

function airVelocityFor(rotation, normalizedSpeed, config) {
  const speed = config?.TANK_SPEED || 15;
  return {
    x: -Math.sin(rotation) * normalizedSpeed * speed,
    z: -Math.cos(rotation) * normalizedSpeed * speed,
  };
}

// "below the ground: however I got there, creep up" (LocalPlayer.cxx:376). A
// tank below its own ground limit is lifted out rather than left there, which is
// what happens to a burrowed tank the moment it loses the flag: the limit
// springs back to zero and this walks it up to the surface. A floor on the
// velocity rather than a teleport, so the tank rises visibly.
function applyGroundLimitCreep(verticalVelocity, y, groundLimit) {
  if (!(y < groundLimit)) return verticalVelocity;
  return Math.max(verticalVelocity, (-y / 2) + 0.5);
}

// A tank under the floor it is allowed to rest on. That happens exactly once:
// when a burrowed tank loses the flag, the limit springs back to zero with the
// tank still down at `_burrowDepth`. It keeps its steering there -- upstream's
// `location` is still `OnGround` at a negative z -- and it must not be snapped
// to the surface, because the creep is what lifts it out.
function isBelowGroundLimit(y, groundLimit) {
  return y < groundLimit - GROUND_LIMIT_TOLERANCE;
}

// Obstacle::isFlatTop for what a tank stands on: a box's or an arc's top, an
// inverted pyramid's, or a mesh face that faces straight up. An upright
// pyramid's sides and a tetra's never are, and a mesh is flat where the tank
// stands on one of its level faces.
function standsOnFlatTop(obs, x, y, z) {
  if (!obs) return true;
  if (obs.type === 'pyramid') return isPyramidFlatTop(obs);
  if (obs.type === 'tetra') return false;
  if (obs.type === 'mesh') return meshFlatTopYsAt(obs, x, z).some((top) => Math.abs(top - y) < 0.05);
  return true;
}

// LocalPlayer::doJump's vertical component. Wings has its own; Bouncy's bounce
// is a random quarter-to-full of the world's, so no two are the same height.
function jumpVelocityFor(tank, airControl, verticalVelocity, config, clock) {
  if (airControl) return getWingsJumpVelocity(config.WINGS_JUMP_VELOCITY, verticalVelocity);
  if (getMotionEffects(tank.flag ?? null).bouncy) {
    return getBouncyJumpVelocity(config.JUMP_VELOCITY, clock.random());
  }
  return config.JUMP_VELOCITY;
}

// The gravity the tank falls under: Wings' own, or four times the world's for
// a burrowing tank below ground level (LocalPlayer.cxx:332), so the descent
// into the hole takes a fraction of a second.
function gravityFor(tank, airControl, y, config) {
  if (airControl) return config.WINGS_GRAVITY;
  if (y < 0 && tank.flag === 'BU') return config.GRAVITY * BURROW_GRAVITY_FACTOR;
  return config.GRAVITY;
}

// A physics driver's push, read off whatever the tank landed on last frame --
// upstream's timing too (`LocalPlayer.cxx:397-429`). The vertical component
// always applies; the horizontal only while resting on the driving surface.
function isDrivenUpward(obstacle, x, y, z) {
  const driver = resolvePhysicsDriverAt(obstacle, x, y, z);
  return !!(driver?.linear && driver.linear[1] > 0);
}

// LocalPlayer::collectInsideBuildings (LocalPlayer.cxx:966): every obstacle the
// tank box overlaps where the frame left it. Upstream asks each one `inBox` and
// takes all of them rather than the first -- a tank crossing a corner is inside
// two buildings. The world border and teleporters are not buildings: both expel
// a phased tank, so it can never be in one.
function findInsideBuildings(colliders, topOf, x, y, z, rotation, tankScale) {
  const found = [];
  for (const obs of colliders) {
    if (obs.driveThrough) continue;
    if (obs.collisionKind === 'boundary' || obs.kind === 'teleporter') continue;
    if (!movingTankOverlapsHeight(obs.baseY || 0, topOf(obs), y, y, 2, 0.15)) continue;
    if (obs.type === 'pyramid') {
      if (!pyramidIntersectsTank(obs, x, y, z, rotation, 2, 0, tankScale)) continue;
    } else if (obs.type === 'mesh') {
      // `< 0` and not a truth test: face zero is a real face (issue #153).
      if (findMeshHitFaceOriented(obs, x, y, z, rotation,
        TANK.halfWidth * (tankScale ? tankScale.width : 1),
        TANK.halfLength * (tankScale ? tankScale.length : 1), 2) < 0) continue;
    } else {
      const local = getColliderLocalPoint(x, z, obs);
      if (!testOrigRectTank(
        obs.w / 2, obs.d / 2, local.x, local.z,
        getTankLocalAngle(rotation, obs.rotation), 0, tankScale,
      )) continue;
    }
    found.push(obs);
  }
  return found;
}

// handleInputEvents: what the controls ask of the tank this frame, after the
// flags have had their say. `controls` is { forward, turn, up } from whatever
// drives the tank -- keys, a stick, a pilot -- or null when nothing is reading
// them (chat has the keyboard). A tank coasting through the air reads nothing
// at all: it keeps the speed and turn it left with.
function readDriveInput(state, controls, tank, world, clock) {
  const { config } = world;
  const airControl = hasAirControl(tank.motionFlag ?? null);
  const inside = state.insideBuildings.length > 0;
  let forward = 0;
  let rotation = 0;
  let jumpTriggered = false;
  if (state.inAir && !airControl) {
    forward = state.jumpForwardSpeed || 0;
    rotation = state.rotationSpeed || 0;
    // A coasting tank does not read the sticks at all, so the jump control goes
    // unsampled and has to be treated as released. Landing therefore re-arms
    // it, which is what makes holding jump bounce a tank down a building.
    state.jumpWasHeld = false;
  } else if (controls) {
    // The input clamps -- reversed controls, and the flags that take one
    // direction away -- belong on the raw stick, because that is where upstream
    // negates and clamps; everything after should see what the tank was asked.
    const clamped = applyMotionInput(tank.motionFlag ?? null, controls.forward || 0, controls.turn || 0, inside);
    forward = clamped.forward;
    rotation = clamped.turn;
    if (controls.up && !state.jumpWasHeld
      && canJump(tank.motionFlag ?? null, config.ALLOW_JUMPING, state.jumpDirection !== null,
        state.wingsFlapsLeft, inside)) {
      jumpTriggered = true;
      // Every jump spends a flap. Only Wings ever holds more than the one a
      // surface just put back.
      state.wingsFlapsLeft--;
    }
    state.jumpWasHeld = Boolean(controls.up);
  } else {
    state.jumpWasHeld = false;
  }
  // Bouncy takes the decision off the player: a tank on a surface is thrown
  // back up once its landing delay expires, and `canJump` lets it through even
  // where nothing else may jump.
  if (!jumpTriggered) {
    const bounce = getBounceState(
      tank.motionFlag ?? null, !state.inAir, state.wasAirborne, state.bounceReadyAt ?? 0, clock.now);
    state.bounceReadyAt = bounce.bounceReadyAt;
    if (bounce.jump && canJump(tank.motionFlag ?? null, config.ALLOW_JUMPING, false, state.wingsFlapsLeft, inside)) {
      jumpTriggered = true;
      state.wingsFlapsLeft--;
    }
  }
  state.wasAirborne = state.inAir;
  const reverse = Number.isFinite(config.REVERSE_SPEED_RATIO) ? config.REVERSE_SPEED_RATIO : 0.5;
  forward = Math.max(-reverse, Math.min(1, forward));
  rotation = Math.max(-1, Math.min(1, rotation));
  return { forward, rotation, jumpTriggered, phasedReverse: forward < 0 };
}

// The collision pass, against the world as this tank meets it: its flag's size,
// whether it phases through buildings, and the physics driver it stands on.
function resolveStep(state, velocityX, velocityY, velocityZ, angularVelocity, dt, tank, world, intended, groundLimit) {
  const { config } = world;
  const onSupport = state.onGround || state.onObstacle;
  const driver = resolvePhysicsDriverAt(state.lastObstacle, state.x, state.y, state.z);
  if (driver && driver.linear) {
    velocityY += driver.linear[1];
    if (onSupport) {
      velocityX += driver.linear[0];
      velocityZ += driver.linear[2];
    }
  }
  const tankScale = getTankDimensionScale(tank.flag ?? null);
  const phased = drivesThroughBuildings(tank.flag ?? null, tank.zoned === true);
  return resolveTankMotion({
    x: state.x,
    y: state.y,
    z: state.z,
    azimuth: state.rotation,
    velocityX,
    velocityY,
    velocityZ,
    angularVelocity,
    timeStep: dt,
    groundLimit,
    // Resting on a building is resting, for the purpose of climbing the next
    // low ledge.
    onGround: onSupport,
    // World::hitBuilding, with the step's own start height as `fromY`, so the
    // occupant's vertical extent covers the span it crossed -- what stops a
    // fast fall passing through a roof.
    hitTest: (fromX, fromY, fromZ, fromAz, toX, toY, toZ, toAz) => findTankObstacle(world.colliders, toX, toY, toZ, {
      rotation: toAz,
      fromY,
      fromX,
      fromZ,
      radius: TANK.collisionHeight,
      tankScale,
      phased,
      reversingOnGround: phased && intended.phasedReverse && toY <= 0,
    }),
    getNormal: (obs, px, py, pz, paz, hitX, hitY, hitZ, hitAz, fromX, fromZ, fromAz, toX, toZ, toAz) => (
      getTankHitNormal(obs, px, py, pz, paz, hitY, TANK.collisionHeight, {
        fromX, fromZ, fromAz, toX, toZ, toAz, hitX, hitZ,
        halfWidth: TANK.halfWidth * (tankScale ? tankScale.width : 1),
        halfLength: TANK.halfLength * (tankScale ? tankScale.length : 1),
      })),
    isFlatTop: (obs) => {
      if (!obs || obs.collisionKind === 'boundary') return false;
      if (obs.type === 'pyramid') return isPyramidFlatTop(obs);
      return true;
    },
    getObstacleTop: (obs) => world.topOf(obs),
    maxBumpHeight: config.MAX_BUMP_HEIGHT,
    stuckFrameCount: state.stuckFrameCount || 0,
  });
}

function noDriveEvents() {
  return {
    landed: null,
    jumpStarted: null,
    fallStarted: false,
    teleport: null,
    zoneToggle: null,
    teleported: false,
    drivenUpward: false,
    burrowEntered: false,
    forceSend: false,
    moved: 0,
  };
}

// A dead tank's frame: it stays where it died, whatever the controls say.
// Upstream's `location == Dead` sets `dt` to zero (LocalPlayer.cxx:282), so
// nothing moves it and its radar marker holds still until the respawn. The
// speeds go to zero rather than being kept as upstream keeps them, because
// bzo's server extrapolates a move packet's speeds and a frozen tank that
// claims to be driving reads as drift.
function holdDrive(state) {
  state.lastSpeed = 0;
  state.lastAngVel = 0;
  state.forwardSpeed = 0;
  state.rotationSpeed = 0;
  state.verticalVelocity = 0;
  state.airVelocityX = 0;
  state.airVelocityZ = 0;
  return noDriveEvents();
}

// handleMotion: one frame of the tank's motion. Returns what happened in it:
//   landed      { impactSpeed, obstacle, x, y, z } the frame it came down
//   jumpStarted { flap } the frame it left the ground under its own power
//   fallStarted the frame it went over an edge
//   teleport    the crossing a teleporter made, `world.teleport`'s own answer
//               plus where and how the tank met it
//   zoneToggle  a Phantom Zone tank's crossing, which flips the zone instead
//   drivenUpward, burrowEntered, forceSend, moved, teleported
function stepDrive(state, intended, tank, world, clock, dt) {
  const { config } = world;
  const events = noDriveEvents();

  // A tank that came down onto something last frame lands now, before anything
  // else touches its height or velocity.
  if (state.jumpDirection !== null && (state.onGround || state.onObstacle)) {
    events.forceSend = true;
    events.landed = {
      impactSpeed: Math.abs(state.verticalVelocity || 0),
      obstacle: state.lastObstacle,
      x: state.x,
      y: state.y,
      z: state.z,
    };
    state.jumpDirection = null;
    state.verticalVelocity = 0;
    setAirVelocity(state, 0, 0, config);
  }

  const old = { x: state.x, y: state.y, z: state.z, rotation: state.rotation };

  // The three good movement flags land here and nowhere else, because
  // `setDesiredSpeed` and `setDesiredAngVel` are the only places upstream
  // applies them: they scale the world's own tank speed and turn rate. Agility
  // carries a clock, so `getSpeedFactor` is handed the window it last opened.
  const motionFlag = tank.motionFlag ?? null;
  const airControl = hasAirControl(motionFlag);
  const agility = getSpeedFactor(
    motionFlag, state.previousSpeedFraction || 0, intended.forward, state.agilityStartedAt ?? -Infinity, clock.now);
  state.agilityStartedAt = agility.agilityStartedAt;
  state.previousSpeedFraction = intended.forward;
  // Burrow's handicaps, read off where the tank is rather than off the flag:
  // holding the flag above ground costs nothing.
  const burrow = getBurrowFactors(motionFlag, state.y);
  const speedFactor = agility.factor * burrow.speed;
  const angVelFactor = getMaxAngVelFactor(motionFlag) * burrow.angVel;
  const priorAirVelocityX = state.airVelocityX || 0;
  const priorAirVelocityZ = state.airVelocityZ || 0;

  // doMomentum (LocalPlayer.cxx:1537): the world's acceleration limit composed
  // with `M`, applied to the velocity rather than to the stick. With `-a 0 0`,
  // upstream's default, there is no limit. Wings drives in the air on the same
  // terms as on the ground, so it takes the same limits with it.
  let forwardInput = intended.forward;
  let rotationInput = intended.rotation;
  const tankSpeedNow = config.TANK_SPEED * speedFactor;
  const tankAngVelNow = config.TANK_ROTATION_SPEED * angVelFactor;
  state.topSpeed = tankSpeedNow;
  state.turnRate = tankAngVelNow;
  if (!state.inAir || airControl) {
    const limits = getAccelerationLimits(motionFlag, config.LINEAR_ACCELERATION, config.ANGULAR_ACCELERATION);
    state.linearLimit = limits.linear;
    state.angularLimit = limits.angular;
    state.lastSpeed = applyAccelerationLimit(state.lastSpeed, intended.forward * tankSpeedNow, limits.linear, dt);
    state.lastAngVel = applyAccelerationLimit(state.lastAngVel, intended.rotation * tankAngVelNow, limits.angular, dt);
    forwardInput = tankSpeedNow > 0 ? state.lastSpeed / tankSpeedNow : 0;
    rotationInput = tankAngVelNow > 0 ? state.lastAngVel / tankAngVelNow : 0;
  } else {
    state.lastSpeed = intended.forward * tankSpeedNow;
    state.lastAngVel = intended.rotation * tankAngVelNow;
  }

  // Upstream's velocity, in world units per second: the resolver integrates it
  // over the timestep itself, because the timestep is what it searches.
  const coasting = state.inAir && state.jumpDirection !== null && !airControl;
  const sliding = state.inAir && airControl && config.WINGS_SLIDE_TIME > 0;
  let velocityX;
  let velocityZ;
  if (coasting) {
    // "can't control motion in air" (LocalPlayer.cxx:341): the velocity the
    // step that left the surface gave the tank, carried straight through.
    velocityX = priorAirVelocityX;
    velocityZ = priorAirVelocityZ;
  } else if (sliding) {
    // _wingsSlideTime above zero: the stick adds to the velocity the tank
    // already has, so flight carries momentum.
    const slid = getWingsSlideVelocity(priorAirVelocityX, priorAirVelocityZ, state.rotation,
      forwardInput * config.TANK_SPEED, config.TANK_SPEED, config.WINGS_SLIDE_TIME, dt);
    velocityX = slid.x;
    velocityZ = slid.z;
  } else {
    velocityX = -Math.sin(state.rotation) * forwardInput * tankSpeedNow;
    velocityZ = -Math.cos(state.rotation) * forwardInput * tankSpeedNow;
    // doFriction (LocalPlayer.cxx:1564), on the ground only, as upstream calls
    // it from the full-control branch: `_friction` -- `_momentumFriction` while
    // carrying `M` -- caps how fast the tank's velocity may change at 20 units
    // a second a second per unit of it. 0, upstream's default, is no cap.
    const friction = motionFlag === 'M' ? config.MOMENTUM_FRICTION : config.FRICTION;
    if (friction > 0 && dt > 0 && !state.inAir
      && Number.isFinite(state.lastVelocityX) && Number.isFinite(state.lastVelocityZ)) {
      const deltaX = velocityX - state.lastVelocityX;
      const deltaZ = velocityZ - state.lastVelocityZ;
      const accel = Math.hypot(deltaX, deltaZ) / dt;
      const limit = 20 * friction;
      if (accel > limit) {
        const ratio = limit / accel;
        velocityX = state.lastVelocityX + (deltaX * ratio);
        velocityZ = state.lastVelocityZ + (deltaZ * ratio);
      }
    }
  }

  const groundLimit = getGroundLimit(tank.flag ?? null);
  const wasInAir = state.inAir;
  if (!intended.jumpTriggered && state.y <= groundLimit && !isBelowGroundLimit(state.y, groundLimit)) {
    state.verticalVelocity = 0;
    state.y = groundLimit;
  }
  // Gravity in the full-control branch too whenever the tank is above its own
  // floor (LocalPlayer.cxx:334), which is what makes a Burrow tank sink into
  // the ground it stands on. Only a tank resting on the ground can sink: one on
  // a building is held up by the building.
  const sinking = state.onGround && state.y > groundLimit;
  if (state.inAir || state.onObstacle || sinking) {
    state.verticalVelocity -= gravityFor(tank, airControl, state.y, config) * dt;
  }
  if (state.y < groundLimit) {
    state.verticalVelocity = applyGroundLimitCreep(state.verticalVelocity, state.y, groundLimit);
  } else if (state.onGround && !intended.jumpTriggered && state.verticalVelocity > 0) {
    state.verticalVelocity = 0;
  }

  // `readDriveInput` already asked canJump, which refuses a second jump in mid
  // air -- and grants one to Wings, which may flap there.
  const jumpStarted = intended.jumpTriggered;
  // `_noClimb`, on unless the world turns it off: a jump from a slope goes
  // straight up rather than up it (LocalPlayer.cxx:386).
  const climbBlocked = jumpStarted && config.NO_CLIMB !== false && state.onObstacle
    && !standsOnFlatTop(state.lastObstacle, state.x, state.y, state.z);
  if (jumpStarted) {
    state.verticalVelocity = jumpVelocityFor(tank, airControl, state.verticalVelocity || 0, config, clock);
    if (climbBlocked) {
      velocityX = 0;
      velocityZ = 0;
    }
    const launchSpeed = climbBlocked ? 0 : forwardInput;
    state.jumpForwardSpeed = launchSpeed;
    state.fallForwardSpeed = launchSpeed;
    state.slideDirection = undefined;
    events.forceSend = true;
    events.jumpStarted = { flap: airControl };
  }

  // The velocity this step drives with, for the next step's friction.
  state.lastVelocityX = velocityX;
  state.lastVelocityZ = velocityZ;

  // One pass: position, height and heading come back resolved together.
  const step = resolveStep(state, velocityX, state.verticalVelocity || 0, velocityZ,
    rotationInput * tankAngVelNow, dt, tank, world, intended, groundLimit);
  state.stuckFrameCount = step.stuckFrameCount;
  let result = {
    x: step.x,
    y: step.y,
    z: step.z,
    // Whatever the resolver took away from the step, which the slide reporting
    // keys off.
    altered: Math.abs((step.x - state.x) - (velocityX * dt)) > 1e-6
      || Math.abs((step.z - state.z) - (velocityZ * dt)) > 1e-6,
    trajectoryDeltaX: step.velocityX * dt,
    trajectoryDeltaZ: step.velocityZ * dt,
  };
  state.verticalVelocity = step.velocityY;

  // A teleporter crossed on the way, where the world has teleporters to cross.
  // A Phantom Zone tank does not teleport: the crossing flips its zone and it
  // stays where it is (LocalPlayer.cxx:729).
  let rotateDelta = 0;
  const sourceRotation = normalizeAngle(step.azimuth);
  const crossing = world.teleport
    ? world.teleport({ x: old.x, y: old.y, z: old.z }, { x: result.x, y: result.y, z: result.z }, state)
    : null;
  if (crossing?.applied) {
    if (togglesZoneOnTeleport(tank.flag ?? null)) {
      events.zoneToggle = { ...crossing, x: result.x, y: result.y, z: result.z, rotation: sourceRotation };
    } else {
      events.teleported = true;
      rotateDelta = crossing.rotateDelta || 0;
      events.teleport = {
        ...crossing,
        source: { x: result.x, y: result.y, z: result.z },
        sourceRotation,
        verticalVelocity: state.verticalVelocity || 0,
        airVelocityX: state.airVelocityX || 0,
        airVelocityZ: state.airVelocityZ || 0,
        jumpDirection: state.jumpDirection,
      };
      result = { ...result, x: crossing.state.x, y: crossing.state.y, z: crossing.state.z, altered: true };
      events.forceSend = true;
    }
  }

  // "pick new location if we haven't already done so" (LocalPlayer.cxx:667):
  // the resolver reports a surface met with an upward normal, upstream's
  // OnBuilding, and the rest is the height.
  const nextOnObstacle = step.onBuilding;
  const nextOnGround = !nextOnObstacle && step.y <= groundLimit;
  const nextInAir = !nextOnObstacle && !nextOnGround;

  // `justLanded` (LocalPlayer.cxx:794): the frame the tank stops being in the air.
  if (wasInAir && !nextInAir) {
    events.forceSend = true;
    events.landed = {
      impactSpeed: Math.abs(step.velocityY || 0), obstacle: step.obstacle || null, x: step.x, y: step.y, z: step.z,
    };
    state.jumpDirection = null;
    state.verticalVelocity = 0;
    setAirVelocity(state, 0, 0, config);
  }
  // And the frame it starts: the direction and velocity are taken from the step
  // that left the surface rather than frozen off a stick fraction.
  const fallStarted = nextInAir && !wasInAir && !jumpStarted;
  if (fallStarted) {
    events.forceSend = true;
    events.fallStarted = true;
    state.jumpDirection = state.rotation;
    setAirVelocity(state, step.velocityX, step.velocityZ, config);
    const carried = config.TANK_SPEED > 0 ? Math.hypot(step.velocityX, step.velocityZ) / config.TANK_SPEED : 0;
    state.jumpForwardSpeed = carried;
    state.fallForwardSpeed = carried;
  }
  state.onObstacle = nextOnObstacle;
  state.onGround = nextOnGround;
  state.inAir = nextInAir;
  state.lastObstacle = step.obstacle || null;
  if (!state.inAir) state.wingsFlapsLeft = tank.unlimitedFlaps ? Infinity : config.WINGS_JUMP_COUNT;

  state.x = result.x;
  state.y = result.y;
  state.z = result.z;
  // The heading the pass resolved, which is upstream's own: its search runs
  // over the azimuth too and leaves the turn out where the step hit something.
  state.rotation = normalizeAngle(step.azimuth);
  if (events.teleported) {
    state.rotation = normalizeAngle(state.rotation + rotateDelta);
    if (state.jumpDirection !== null) state.jumpDirection = normalizeAngle(state.jumpDirection + rotateDelta);
    const c = Math.cos(rotateDelta);
    const s = Math.sin(rotateDelta);
    const ax = state.airVelocityX || 0;
    const az = state.airVelocityZ || 0;
    setAirVelocity(state, (c * ax) - (s * az), (s * ax) + (c * az), config);
    state.slideDirection = undefined;
  }
  if (jumpStarted) {
    state.jumpDirection = state.rotation;
    // The stick is a fraction of this tank's own maximum; the air velocity is a
    // fraction of the world's, so the boost comes with it.
    const v = airVelocityFor(state.jumpDirection, (climbBlocked ? 0 : forwardInput) * speedFactor, config);
    setAirVelocity(state, v.x, v.z, config);
  }

  const tankScale = getTankDimensionScale(tank.flag ?? null);
  state.insideBuildings = drivesThroughBuildings(tank.flag ?? null, tank.zoned === true)
    ? findInsideBuildings(world.colliders, world.topOf, state.x, state.y, state.z, state.rotation, tankScale)
    : [];

  events.drivenUpward = isDrivenUpward(state.lastObstacle, state.x, state.y, state.z);
  events.burrowEntered = old.y >= 0 && state.y < 0;

  const actualDeltaX = state.x - old.x;
  const actualDeltaZ = state.z - old.z;
  events.moved = Math.hypot(actualDeltaX, actualDeltaZ);
  const trajectoryDeltaX = Number.isFinite(result.trajectoryDeltaX) ? result.trajectoryDeltaX : actualDeltaX;
  const trajectoryDeltaZ = Number.isFinite(result.trajectoryDeltaZ) ? result.trajectoryDeltaZ : actualDeltaZ;

  // Where the step slid the tank off its own heading -- off its jump's, in the
  // air -- the direction it actually went, for the packet.
  let slideDirection = null;
  if (result.altered && !events.teleported) {
    const distance = Math.hypot(trajectoryDeltaX, trajectoryDeltaZ);
    if (distance > 0.001) {
      const actual = Math.atan2(-trajectoryDeltaX, -trajectoryDeltaZ);
      const expected = state.inAir && state.jumpDirection !== null ? state.jumpDirection : state.rotation;
      if (Math.abs(normalizeAngle(actual - expected)) > 0.01) slideDirection = actual;
    }
  }
  state.groundSlideDirection = slideDirection;

  if ((state.inAir || jumpStarted || fallStarted) && dt > 0) {
    if (events.teleported) {
      // The rotated airborne velocity carries through a teleport: the portal's
      // displacement is not travel.
    } else if (airControl && !jumpStarted) {
      // Wings changes its horizontal velocity every frame, so what others
      // extrapolate from is this frame's actual travel.
      setAirVelocity(state, actualDeltaX / dt, actualDeltaZ / dt, config);
    } else if (result.altered) {
      const newX = trajectoryDeltaX / dt;
      const newZ = trajectoryDeltaZ / dt;
      setAirVelocity(state, newX, newZ, config);
      if (Math.hypot(newX - priorAirVelocityX, newZ - priorAirVelocityZ) > AIR_VELOCITY_THRESHOLD) {
        events.forceSend = true;
      }
    } else if (jumpStarted) {
      const v = airVelocityFor(state.jumpDirection, (climbBlocked ? 0 : intended.forward) * speedFactor, config);
      setAirVelocity(state, v.x, v.z, config);
    }
  }

  // What the tank did, as a packet reports it. Speed is measured while the
  // sticks are connected -- on the ground, or with Wings -- and in the air is
  // the speed it is coasting at. The turn is measured by where the frame
  // started: the step a tank takes off on is still steered from the ground,
  // and is the turn it keeps the whole flight.
  if (dt > 0) {
    let forwardSpeed = 0;
    if (!state.inAir || airControl) {
      const distance = Math.hypot(actualDeltaX, actualDeltaZ);
      if (distance > 0.001) {
        const actualSpeed = distance / dt;
        if (slideDirection !== null) {
          forwardSpeed = actualSpeed / config.TANK_SPEED;
        } else {
          const dot = ((actualDeltaX * -Math.sin(state.rotation)) + (actualDeltaZ * -Math.cos(state.rotation))) / distance;
          forwardSpeed = (dot * actualSpeed) / config.TANK_SPEED;
        }
        // A fraction of the world's base speed, so a boosted tank reports more
        // than 1 and the bound widens with the flag.
        const maxFS = getMaxSpeedFactor(motionFlag);
        forwardSpeed = Math.max(-maxFS, Math.min(maxFS, forwardSpeed));
      }
    } else {
      const airSpeed = Math.hypot(state.airVelocityX || 0, state.airVelocityZ || 0);
      forwardSpeed = config.TANK_SPEED > 0 ? airSpeed / config.TANK_SPEED : 0;
    }
    state.forwardSpeed = forwardSpeed;
    if (!wasInAir || airControl) {
      // The short way round: a heading crossing +/-PI otherwise reads as a turn
      // of nearly a full circle the other way.
      const turned = normalizeAngle(state.rotation - old.rotation);
      const maxRS = getMaxAngVelFactor(motionFlag);
      state.rotationSpeed = Math.max(-maxRS, Math.min(maxRS, (turned / dt) / config.TANK_ROTATION_SPEED));
    }
  }
  return events;
}

// A move packet's motion, as the tank's state spells it -- the speeds rounded to
// what goes on the wire. `jumpStarted` sends the jump's own speed rather than
// the frame's measured one, and `stopped` a dead stick's zero.
function movePacketFields(state, { jumpStarted = false, stopped = false } = {}) {
  const airborne = state.jumpDirection !== null;
  const fields = {
    x: Number(state.x.toFixed(2)),
    y: Number(state.y.toFixed(2)),
    z: Number(state.z.toFixed(2)),
    r: Number(state.rotation.toFixed(2)),
    fs: stopped ? 0 : Number((jumpStarted ? state.jumpForwardSpeed || 0 : state.forwardSpeed).toFixed(2)),
    rs: stopped ? 0 : Number(state.rotationSpeed.toFixed(2)),
    vv: Number((state.verticalVelocity || 0).toFixed(2)),
    vx: Number((airborne ? state.airVelocityX || 0 : 0).toFixed(2)),
    vz: Number((airborne ? state.airVelocityZ || 0 : 0).toFixed(2)),
    // Upstream's `PlayerState::Falling`: in the air, or in a building
    // (`LocalPlayer.cxx:819-823`). Only a proxied connection reads it -- a bzfs
    // skips the vertical part of its shot-origin check for a falling tank, so
    // a shot fired mid-jump is dropped without it.
    air: (state.onGround || state.onObstacle) ? 0 : 1,
  };
  const slide = airborne ? state.slideDirection : state.groundSlideDirection;
  if (slide !== null && slide !== undefined) fields.d = Number(slide.toFixed(2));
  return fields;
}

// The tank's velocity as a move packet states it: the air velocity for a tank
// the packet says is in the air, and on the ground `fs` along the slide
// direction or the heading. A shot fired after the move adds its own speed to
// this, and the server checks it against the same numbers off the move it
// accepted, so the two never depend on separate guesses about whether the tank
// is airborne.
function packetVelocity(fields, config) {
  if (fields.air === 1) return { x: fields.vx || 0, y: fields.vv || 0, z: fields.vz || 0 };
  const heading = Number.isFinite(fields.d) ? fields.d : fields.r;
  const speed = (fields.fs || 0) * (config.TANK_SPEED ?? 25);
  return { x: -Math.sin(heading) * speed, y: 0, z: -Math.cos(heading) * speed };
}

// A `shoot` message for a tank: from its muzzle -- under the tank for a shock
// wave, which swells around it rather than leaving a barrel
// (LocalPlayer.cxx:1230) -- with upstream's velocity, or none for a wave.
function shotFromTank({
  x, y, z, rotation, tankVelocity, config, shockwave = false,
  muzzleForward = TANK.muzzleForward, muzzleHeight = TANK.muzzleHeight,
}) {
  const dirX = -Math.sin(rotation);
  const dirZ = -Math.cos(rotation);
  const velocity = shockwave
    ? { x: 0, y: 0, z: 0 }
    : getMuzzleVelocity({ x: dirX, y: 0, z: dirZ }, tankVelocity,
      config.SHOT_SPEED ?? 100, config.SHOTS_KEEP_VERTICAL_VELOCITY === true);
  return {
    type: 'shoot',
    x: shockwave ? x : x + (dirX * muzzleForward),
    y: y + (shockwave ? 0 : muzzleHeight),
    z: shockwave ? z : z + (dirZ * muzzleForward),
    vx: velocity.x,
    vy: velocity.y,
    vz: velocity.z,
  };
}

module.exports = {
  AIR_VELOCITY_THRESHOLD,
  createDriveState,
  setAirVelocity,
  applyGroundLimitCreep,
  isDrivenUpward,
  findInsideBuildings,
  readDriveInput,
  holdDrive,
  stepDrive,
  movePacketFields,
  packetVelocity,
  shotFromTank,
};
