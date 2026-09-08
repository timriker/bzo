/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Holds the flag flight math against BZFlag's own numbers, and holds the two
// copies of the pair against each other. The server computes a flight once and
// the client integrates it every frame, so a divergence here is a flag that
// lands somewhere other than where it is drawn.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  BASE_TOP_TOLERANCE,
  getBaseTeamAtPoint,
  getBaseTopY,
  isOnBaseTop,
  isOverFlatTop,
} from '../public/collision.mjs';
import {
  getTeamColorIndex,
  getTeamFromColorIndex,
  isColorTeamIndex,
} from '../public/teams.mjs';
import {
  BZFLAG_TANK_RADIUS,
  GM_AD_LIFE,
  GM_ACTIVATION_TIME,
  GM_TURN_ANGLE,
  LOCK_ON_ANGLE,
  TARGETING_ANGLE,
  pickTargetInSights,
  steerGuidedShot,
  FLAG_ALTITUDE,
  FLAG_EFFECT_TIME,
  NARROW_FACTOR,
  OBESE_FACTOR,
  TINY_FACTOR,
  RADAR_JAM_DECAY_FLOOR,
  RADAR_JAM_DECAY_MIN,
  SEER_REVEAL_ALPHA,
  blanksTheView,
  cloaksTheTank,
  fakesTeamColor,
  getNextRadarJamDecay,
  getTankAlphaTarget,
  getVisibleTankAlpha,
  hidesFromRadar,
  getTankDimensionEase,
  hidesTeamColors,
  jamsTheRadar,
  seesThroughDisguises,
  getTankDimensionScale,
  getTankHitRadiusScale,
  usesNarrowHitBox,
  FLAG_CLEARANCE,
  FLAG_ENDURANCE,
  FLAG_GRAB_RADIUS,
  FLAG_POLE_SIZE,
  FLAG_RADIUS,
  FLAG_STATUS,
  FLAG_TYPES,
  IDENTIFY_RANGE,
  MAX_FLAG_GRABS,
  DEFAULT_WINGS_JUMP_COUNT,
  DEFAULT_WINGS_SLIDE_TIME,
  ANTIDOTE_CTF_WORLD_FRACTION,
  BASE_SIZE,
  SHAKE_DROP_GRACE_SECONDS,
  SHAKE_TIMEOUT_MAX_SECONDS,
  SHAKE_TIMEOUT_MIN_SECONDS,
  SHAKE_WINS_MAX,
  SHAKE_WINS_MIN,
  SUPER_FLAG_COLOR,
  RAPID_FIRE_AD_VEL,
  RAPID_FIRE_AD_RATE,
  MACHINE_GUN_AD_VEL,
  MACHINE_GUN_AD_RATE,
  LASER_AD_VEL,
  LASER_AD_RATE,
  LASER_AD_LIFE,
  SHOCK_AD_LIFE,
  SHOCK_IN_RADIUS,
  SHOCK_OUT_RADIUS,
  SR_RADIUS_MULT,
  VELOCITY_AD,
  ANGULAR_AD,
  AGILITY_AD_VEL,
  AGILITY_TIME_WINDOW,
  AGILITY_VEL_DELTA,
  LINEAR_ACCELERATION_SCALE,
  MOMENTUM_LIN_ACC,
  MOMENTUM_ANG_ACC,
  BOUNCE_DELAY,
  BOUNCY_JUMP_MIN_FACTOR,
  BOUNCY_JUMP_RANGE,
  canJump,
  canShakeFlag,
  computeFlagFlight,
  getAntidoteCoordinate,
  getFlagEndurance,
  normalizeShakeTimeout,
  normalizeShakeWins,
  getFlagFlightHeight,
  getFlagFlightState,
  getFlagHoverHeight,
  getFlagTeamIndex,
  getFlagType,
  getKnownFlagAbbreviation,
  getShotEffects,
  getShockWaveAlpha,
  getShockWaveRadius,
  getTeamFlagAbbreviation,
  getWingsJumpVelocity,
  getWingsSlideVelocity,
  hasAirControl,
  shotRicochets,
  shieldsAgainstShot,
  getMotionEffects,
  getMaxSpeedFactor,
  getMaxAngVelFactor,
  getSpeedFactor,
  applyMotionInput,
  composeAccelerationLimit,
  getAccelerationLimits,
  applyAccelerationLimit,
  getBounceState,
  getBouncyJumpVelocity,
  firesContinuously,
  isBadFlag,
  crushesOnContact,
  killsWholeTeam,
  getRunOverRadius,
  getRunOverSeparation,
  getFlagThrownAltitude,
  SHIELD_FLIGHT,
  isTeamFlag,
  rememberFlagIdentity,
} from '../public/flags.mjs';

const require = createRequire(import.meta.url);
const serverFlags = require('../server/flags.cjs');

const GRAVITY = 9.8;
const EPSILON = 1e-9;
const close = (actual, expected, message, tolerance = 1e-6) => assert.ok(
  Math.abs(actual - expected) < tolerance,
  `${message}: expected ${expected}, got ${actual}`
);

// global.cxx defaults.
assert.equal(FLAG_ALTITUDE, 11.0);
assert.equal(FLAG_RADIUS, 2.5);
assert.equal(FLAG_POLE_SIZE, 0.8);
assert.equal(FLAG_CLEARANCE, 10.0);
assert.equal(MAX_FLAG_GRABS, 4);
assert.equal(BZFLAG_TANK_RADIUS, 4.32);
close(FLAG_GRAB_RADIUS, 6.82, 'grab radius is BZFlag tank radius plus flag radius');

// Flag.cxx:139 -- Useless is an unstable good superflag with no team.
const useless = getFlagType('US');
assert.equal(useless, FLAG_TYPES.US);
assert.equal(useless.name, 'Useless');
assert.equal(useless.endurance, 1);
assert.equal(useless.quality, 0);
assert.equal(isTeamFlag('US'), false);
assert.equal(getFlagTeamIndex('US'), null, 'a superflag has no team');
assert.equal(SUPER_FLAG_COLOR, 0xffffff, 'every superflag is white');
assert.equal(getFlagType('ZZ'), null);
assert.equal(getFlagTeamIndex(null), null, 'a hidden flag has no team either');

// Flag.cxx:136 -- Identify, likewise an unstable good superflag.
const identify = getFlagType('ID');
assert.equal(identify.name, 'Identify');
assert.equal(identify.endurance, 1);
assert.equal(identify.quality, 0);
assert.equal(identify.team, null);
assert.equal(IDENTIFY_RANGE, 50.0);

// Flag.cxx:133 and :149 -- Jumping and Wings, both unstable good superflags.
const jumping = getFlagType('JP');
assert.equal(jumping.name, 'Jumping');
assert.equal(jumping.endurance, 1);
assert.equal(jumping.quality, 0);
assert.equal(jumping.team, null);
const wings = getFlagType('WG');
assert.equal(wings.name, 'Wings');
assert.equal(wings.endurance, 1);
assert.equal(wings.quality, 0);
assert.equal(wings.team, null);
assert.equal(DEFAULT_WINGS_JUMP_COUNT, 1, '_wingsJumpCount');
assert.equal(DEFAULT_WINGS_SLIDE_TIME, 0, '_wingsSlideTime');

// LocalPlayer::doJump. `allowJumping` is the world switch, `airborne` says the
// tank has already left a surface, and `flapsLeft` is the wings count, which a
// surface refills and a jump spends.
{
  const flaps = DEFAULT_WINGS_JUMP_COUNT;
  // A world that allows jumping: any tank may, and only from a surface.
  assert.equal(canJump(null, true, false, flaps), true, 'no flag, jumping on');
  assert.equal(canJump('US', true, false, flaps), true, 'any flag, jumping on');
  assert.equal(canJump(null, true, true, flaps), false, 'no second jump in the air');

  // A world that does not: Jumping is the only way off the ground.
  assert.equal(canJump(null, false, false, flaps), false, 'no flag, jumping off');
  assert.equal(canJump('US', false, false, flaps), false, 'the wrong flag is no help');
  assert.equal(canJump('JP', false, false, flaps), true, 'Jumping is the point of Jumping');
  assert.equal(canJump('JP', false, true, flaps), false, 'Jumping still cannot steer or flap');

  // Wings never asks the world, and is the one flag that answers in mid air --
  // for as many flaps as it has left, and no more.
  assert.equal(canJump('WG', false, false, flaps), true, 'Wings takes off on a no-jump world');
  assert.equal(canJump('WG', false, true, flaps), true, 'Wings flaps in the air');
  assert.equal(canJump('WG', true, true, 0), false, 'a spent Wings has nothing left');
  assert.equal(canJump('WG', false, false, 0), false, 'not even from the ground');
}

// Flag.cxx:175 -- No Jumping, the other end of the jumping switch. Sticky and
// bad, and the one flag that answers no from a surface on a world that says yes.
{
  const noJumping = getFlagType('NJ');
  assert.equal(noJumping.name, 'No Jumping');
  assert.equal(noJumping.endurance, FLAG_ENDURANCE.STICKY);
  assert.equal(noJumping.quality, 1);
  assert.equal(noJumping.team, null);
  const flaps = DEFAULT_WINGS_JUMP_COUNT;
  assert.equal(canJump('NJ', true, false, flaps), false, 'No Jumping outranks the world switch');
  assert.equal(canJump('NJ', false, false, flaps), false, 'and has nothing to take on a world without it');
  assert.equal(canJump('NJ', true, true, flaps), false, 'still nothing in the air');
}

// FlagInfo::addFlag reads endurance off the FlagType rather than deriving it.
assert.equal(getFlagEndurance('NJ'), FLAG_ENDURANCE.STICKY, 'a bad flag is sticky');
assert.equal(getFlagEndurance('US'), FLAG_ENDURANCE.UNSTABLE, 'a good superflag is unstable');
assert.equal(getFlagEndurance('B*'), FLAG_ENDURANCE.NORMAL, 'a team flag is normal');
assert.equal(getFlagEndurance(null), FLAG_ENDURANCE.UNSTABLE, 'an empty slot holds nothing sticky');

// CmdLineOptions.cxx:1268 -- -st, in seconds, clamped and stored to the tenth.
{
  assert.equal(SHAKE_TIMEOUT_MIN_SECONDS, 0.1);
  assert.equal(SHAKE_TIMEOUT_MAX_SECONDS, 300.0);
  assert.equal(normalizeShakeTimeout(20), 20, 'a plain value survives');
  assert.equal(normalizeShakeTimeout(0.02), 0.1, 'under the minimum takes the minimum');
  assert.equal(normalizeShakeTimeout(1000), 300, 'over the maximum takes the maximum');
  assert.equal(normalizeShakeTimeout(3.14159), 3.1, 'rounded to the tenth both sides send');
  assert.equal(normalizeShakeTimeout(0), 0, 'zero is the switch being off');
  assert.equal(normalizeShakeTimeout(-5), 0, 'and so is anything below it');
  assert.equal(normalizeShakeTimeout(undefined), 0, 'and so is saying nothing');
  assert.equal(normalizeShakeTimeout('20'), 20, 'a map option arrives as text');
}

// The shake clock the client counts down and the server re-asks. Only a sticky
// flag shakes, only when the world has a timeout, and only once it has run.
{
  assert.equal(canShakeFlag('NJ', 20, 25), true, 'a bad flag held past its timeout');
  assert.equal(canShakeFlag('NJ', 20, 5), false, 'and not before');
  assert.equal(canShakeFlag('NJ', 20, 20 - SHAKE_DROP_GRACE_SECONDS), true, 'the grace absorbs clock drift');
  assert.equal(canShakeFlag('NJ', 20, 20 - SHAKE_DROP_GRACE_SECONDS - 0.01), false, 'and no more than that');
  assert.equal(canShakeFlag('NJ', 0, 1e6), false, 'no timeout, no shaking it off');
  assert.equal(canShakeFlag('US', 20, 25), false, 'a good flag is dropped, not shaken');
  assert.equal(canShakeFlag('B*', 20, 25), false, 'and a team flag is never sticky');
  assert.equal(canShakeFlag(null, 20, 25), false, 'nor is nothing at all');
}

// CmdLineOptions.cxx:1288 -- -sw, a whole number of kills, clamped 1..20.
{
  assert.equal(SHAKE_WINS_MIN, 1);
  assert.equal(SHAKE_WINS_MAX, 20);
  assert.equal(normalizeShakeWins(3), 3, 'a plain count survives');
  assert.equal(normalizeShakeWins(50), 20, 'over the maximum takes the maximum');
  assert.equal(normalizeShakeWins(2.7), 2, 'a fraction of a kill is not a kill');
  assert.equal(normalizeShakeWins(0.5), 0, 'and rounds down to the switch being off');
  assert.equal(normalizeShakeWins(0), 0, 'zero is the switch being off');
  assert.equal(normalizeShakeWins(-4), 0, 'and so is anything below it');
  assert.equal(normalizeShakeWins(undefined), 0, 'and so is saying nothing');
  assert.equal(normalizeShakeWins('3'), 3, 'a map option arrives as text');
}

// LocalPlayer::setFlag's antidote square: half the world on a CTF map, and the
// world less a base width otherwise, centred either way.
{
  const worldSize = 800;
  const ctfHalfSpan = ANTIDOTE_CTF_WORLD_FRACTION * worldSize * 0.5;
  assert.equal(getAntidoteCoordinate(worldSize, BASE_SIZE, true, 0.5), 0, 'the middle of the square is the world centre');
  close(getAntidoteCoordinate(worldSize, BASE_SIZE, true, 1), ctfHalfSpan, 'a CTF map keeps to half the world');
  close(getAntidoteCoordinate(worldSize, BASE_SIZE, true, 0), -ctfHalfSpan, 'in both directions');
  const openHalfSpan = (worldSize - BASE_SIZE) * 0.5;
  close(getAntidoteCoordinate(worldSize, BASE_SIZE, false, 1), openHalfSpan, 'without team flags it is the world less a base');
  close(getAntidoteCoordinate(worldSize, BASE_SIZE, false, 0), -openHalfSpan, 'in both directions');
  // Whatever the roll, the answer is inside the world.
  for (let roll = 0; roll <= 1; roll += 0.05) {
    for (const ctf of [true, false]) {
      const value = getAntidoteCoordinate(worldSize, BASE_SIZE, ctf, roll);
      assert.ok(Math.abs(value) <= worldSize / 2, `roll ${roll} stays in the world`);
    }
  }
}

// Only Wings drives off the ground.
assert.equal(hasAirControl('WG'), true);
for (const abbreviation of ['JP', 'US', 'ID', 'B*', null]) {
  assert.equal(hasAirControl(abbreviation), false, `${abbreviation} coasts`);
}

// SegmentedShotStrategy::makeSegments. Ricochet is either the flag or the world.
{
  const ricochet = getFlagType('R');
  assert.equal(ricochet.name, 'Ricochet');
  assert.equal(ricochet.team, null);
  assert.equal(shotRicochets('R', false), true, 'the flag bounces shots on its own');
  assert.equal(shotRicochets(null, true), true, 'the world bounces every shot');
  assert.equal(shotRicochets('US', true), true, 'including one fired with another flag');
  assert.equal(shotRicochets(null, false), false, 'and otherwise nothing bounces');
  assert.equal(shotRicochets('US', false), false);
  assert.equal(shotRicochets('R', true), true, 'the flag adds nothing to a world that already does');
  // makeSegments promotes Stop to Reflect and never touches Through, so a shot
  // that goes through buildings never bounces off one.
  assert.equal(shotRicochets('SB', true), false, 'a super bullet passes through a ricochet world');
  assert.equal(shotRicochets('SB', false), false);
  // GuidedMissileStrategy::checkBuildings has no reflect branch at all, so a
  // missile explodes on the first building it reaches whatever the world says.
  assert.equal(shotRicochets('GM', true), false, 'a guided missile never bounces');
  assert.equal(shotRicochets('GM', false), false);
}

// global.cxx:80, :95, :128 and the SegmentedShotStrategy constructors that read
// them. A shot variant is three multipliers and three rules.
{
  assert.equal(RAPID_FIRE_AD_VEL, 1.5, '_rFireAdVel');
  assert.equal(RAPID_FIRE_AD_RATE, 2.0, '_rFireAdRate');
  assert.equal(MACHINE_GUN_AD_VEL, 1.5, '_mGunAdVel');
  assert.equal(MACHINE_GUN_AD_RATE, 10.0, '_mGunAdRate');
  assert.equal(LASER_AD_VEL, 1000.0, '_laserAdVel');
  assert.equal(LASER_AD_RATE, 0.5, '_laserAdRate');
  assert.equal(LASER_AD_LIFE, 0.1, '_laserAdLife');

  // A flag with nothing to say about shots leaves the world's own shot alone,
  // and so does anything that is not a flag at all.
  for (const abbreviation of ['US', 'ID', 'WG', 'R', 'B*', 'ZZ', null]) {
    const effects = getShotEffects(abbreviation);
    assert.equal(effects.velocityFactor, 1, `${abbreviation} does not change shot speed`);
    assert.equal(effects.rateFactor, 1, `${abbreviation} does not change the rate`);
    assert.equal(effects.lifeFactor, 1, `${abbreviation} does not change the life`);
    assert.equal(effects.beam, false);
    assert.equal(effects.shockwave, false);
    assert.equal(effects.throughBuildings, false);
    assert.equal(effects.hiddenOnRadar, false);
  }

  // _rFireAdLife and _mGunAdLife are declared as the reciprocal of the rate, so
  // the slot frees exactly as fast as the flag fires.
  const rapidFire = getShotEffects('F');
  assert.equal(getFlagType('F').name, 'Rapid Fire');
  close(rapidFire.velocityFactor, 1.5, 'a rapid fire shell is half again as fast');
  close(rapidFire.rateFactor, 2, 'and fired twice as often');
  close(rapidFire.lifeFactor, 0.5, 'for half as long');
  close(rapidFire.lifeFactor * rapidFire.rateFactor, 1, '_rFireAdLife is 1 / _rFireAdRate');
  // Range is speed times life: faster but not as far, which is the help text.
  close(rapidFire.velocityFactor * rapidFire.lifeFactor, 0.75, 'and so does not reach as far');

  const machineGun = getShotEffects('MG');
  assert.equal(getFlagType('MG').name, 'Machine Gun');
  close(machineGun.velocityFactor, 1.5, 'a machine gun shell is half again as fast');
  close(machineGun.rateFactor, 10, 'and fired ten times as often');
  close(machineGun.lifeFactor, 0.1, 'for a tenth as long');
  close(machineGun.lifeFactor * machineGun.rateFactor, 1, '_mGunAdLife is 1 / _mGunAdRate');
  close(machineGun.velocityFactor * machineGun.lifeFactor, 0.15, 'very short range');

  // Laser is the one that breaks the reciprocal: a tenth of the life against
  // half the rate, so it is the shot you wait twice as long for.
  const laser = getShotEffects('L');
  assert.equal(getFlagType('L').name, 'Laser');
  close(laser.velocityFactor, 1000, 'infinite speed, in practice');
  close(laser.rateFactor, 0.5, 'and a long reload');
  close(laser.lifeFactor, 0.1, 'on a shot that is gone in a tenth of the time');
  assert.ok(laser.lifeFactor * laser.rateFactor < 1, 'a laser is not reloaded by its own life');
  assert.equal(laser.beam, true, 'a laser has no travel to interpolate');
  assert.equal(laser.throughBuildings, false);
  assert.equal(laser.hiddenOnRadar, false);
  // Fast enough to cross any bzo world inside one simulation step, which is what
  // makes tracing the whole path at once the honest thing to do.
  assert.ok(laser.velocityFactor * 100 / 60 > 800, 'a laser outruns a simulation step');

  // The two that change a rule rather than a number.
  const superBullet = getShotEffects('SB');
  assert.equal(getFlagType('SB').name, 'Super Bullet');
  assert.equal(superBullet.throughBuildings, true, 'a super bullet shoots through buildings');
  close(superBullet.velocityFactor, 1, 'and is otherwise an ordinary shot');
  close(superBullet.rateFactor, 1);
  close(superBullet.lifeFactor, 1);
  assert.equal(superBullet.beam, false);

  const invisibleBullet = getShotEffects('IB');
  assert.equal(getFlagType('IB').name, 'Invisible Bullet');
  assert.equal(invisibleBullet.hiddenOnRadar, true, 'an invisible bullet is off other radars');
  close(invisibleBullet.velocityFactor, 1, 'and is otherwise an ordinary shot');
  close(invisibleBullet.rateFactor, 1);
  close(invisibleBullet.lifeFactor, 1);
  assert.equal(invisibleBullet.throughBuildings, false);

  // A shock wave keeps the world's reload -- ShockWaveStrategy is the one shot
  // strategy that never calls setReloadTime -- and spends a fifth of a shot's
  // life expanding.
  const shockWave = getShotEffects('SW');
  assert.equal(getFlagType('SW').name, 'Shock Wave');
  assert.equal(shockWave.shockwave, true, 'a shock wave has no path');
  close(shockWave.lifeFactor, SHOCK_AD_LIFE, '_shockAdLife');
  close(shockWave.rateFactor, 1, 'and comes round on the world\'s own reload');
  close(shockWave.velocityFactor, 1, 'nothing travels, so the speed is never read');
  assert.equal(shockWave.beam, false, 'a wave is not a beam: it has a life to spend');
  assert.equal(shockWave.throughBuildings, false);
  assert.equal(shockWave.hiddenOnRadar, false);
  assert.equal(shockWave.fireSound, 'shock', 'SFX_SHOCK');

  // GuidedMissileStrategy's constructor scales the lifetime and nothing else:
  // the world's own speed, the world's own reload, and a heading that is not
  // fixed at the muzzle.
  const guidedMissile = getShotEffects('GM');
  assert.equal(getFlagType('GM').name, 'Guided Missile');
  assert.equal(guidedMissile.guided, true, 'a missile steers');
  close(guidedMissile.lifeFactor, GM_AD_LIFE, '_gmAdLife');
  close(guidedMissile.velocityFactor, 1, 'at the world\'s own shot speed');
  close(guidedMissile.rateFactor, 1, 'and the world\'s own reload');
  close(guidedMissile.activationTime, GM_ACTIVATION_TIME, '_gmActivationTime');
  assert.equal(guidedMissile.beam, false);
  assert.equal(guidedMissile.shockwave, false);
  assert.equal(guidedMissile.throughBuildings, false);
  assert.equal(guidedMissile.hiddenOnRadar, false);
  assert.equal(guidedMissile.fireSound, 'missile', 'SFX_MISSILE');
  // No other flag is inert when it leaves the muzzle.
  for (const abbreviation of ['F', 'MG', 'L', 'SB', 'IB', 'SW', 'US', null]) {
    assert.equal(getShotEffects(abbreviation).activationTime, 0, `${abbreviation} is live at once`);
    assert.equal(getShotEffects(abbreviation).guided, false, `${abbreviation} flies straight`);
  }

  // Every shot variant is an unstable good superflag, as Flag.cxx declares them.
  for (const abbreviation of ['F', 'MG', 'GM', 'L', 'SB', 'IB', 'SW']) {
    const type = getFlagType(abbreviation);
    assert.equal(type.endurance, FLAG_ENDURANCE.UNSTABLE, `${abbreviation} is FlagUnstable`);
    assert.equal(type.quality, 0, `${abbreviation} is a good flag`);
    assert.equal(type.team, null, `${abbreviation} has no team`);
    // Client and server must resolve the same shot, or a shell is drawn in one
    // place and lands in another.
    assert.deepEqual(
      serverFlags.getShotEffects(abbreviation),
      getShotEffects(abbreviation),
      `client/server shot effects diverged for ${abbreviation}`
    );
  }
  assert.deepEqual(serverFlags.getShotEffects(null), getShotEffects(null));
}

// ShockWaveStrategy::update, held against the numbers it grows between.
{
  assert.equal(SHOCK_IN_RADIUS, 6.0, '_shockInRadius is _tankLength');
  assert.equal(SHOCK_OUT_RADIUS, 60.0, '_shockOutRadius');
  assert.equal(SHOCK_AD_LIFE, 0.2, '_shockAdLife');

  // 3.5s of shot life at bzo's defaults, a fifth of which is the wave's.
  const life = 3.5 * SHOCK_AD_LIFE;
  close(getShockWaveRadius(0, life), SHOCK_IN_RADIUS, 'a wave starts a tank length across');
  close(getShockWaveRadius(life / 2, life), 33, 'and grows evenly');
  close(getShockWaveRadius(life, life), SHOCK_OUT_RADIUS, 'to _shockOutRadius when it expires');
  // The strategy expires the shot the moment it is full size, so nothing ever
  // reads a radius past the end -- but the client draws a frame or two after the
  // server has decided, so the answer is held rather than run on.
  close(getShockWaveRadius(life * 10, life), SHOCK_OUT_RADIUS, 'and no further');
  close(getShockWaveRadius(-1, life), SHOCK_IN_RADIUS, 'nor before it was fired');
  close(getShockWaveRadius(1, 0), SHOCK_OUT_RADIUS, 'a wave with no life is already over');

  // The low-quality fade, 0.75 down to 0.25 across the same span.
  close(getShockWaveAlpha(SHOCK_IN_RADIUS), 0.75, 'a new wave is the most solid it gets');
  close(getShockWaveAlpha(33), 0.5, 'and thins evenly');
  close(getShockWaveAlpha(SHOCK_OUT_RADIUS), 0.25, 'to a quarter at full size');
  close(getShockWaveAlpha(SHOCK_OUT_RADIUS * 2), 0.25, 'and no thinner');

  assert.equal(serverFlags.getShockWaveRadius(0.35, life), getShockWaveRadius(0.35, life),
    'client/server disagree about how big a wave is');
}

// Phase 5's three good flags, all of them multipliers on the world's own tank
// speed and turn rate rather than replacements for it.
{
  assert.equal(VELOCITY_AD, 1.5, '_velocityAd');
  assert.equal(ANGULAR_AD, 1.5, '_angularAd');
  assert.equal(AGILITY_AD_VEL, 2.25, '_agilityAdVel');
  assert.equal(AGILITY_TIME_WINDOW, 1.0, '_agilityTimeWindow');
  assert.equal(AGILITY_VEL_DELTA, 0.3, '_agilityVelDelta');
  assert.equal(getFlagType('V').name, 'High Speed');
  assert.equal(getFlagType('QT').name, 'Quick Turn');
  assert.equal(getFlagType('A').name, 'Agility');
  for (const abbreviation of ['V', 'QT', 'A']) {
    const type = getFlagType(abbreviation);
    assert.equal(type.endurance, FLAG_ENDURANCE.UNSTABLE, `${abbreviation} is FlagUnstable`);
    assert.equal(type.quality, 0, `${abbreviation} is a good flag`);
    assert.equal(type.team, null);
    // Motion only: none of the three touches the shot or the tank's size.
    assert.deepEqual(getShotEffects(abbreviation), getShotEffects(null),
      `${abbreviation} leaves the shot alone`);
    assert.deepEqual(getTankDimensionScale(abbreviation), getTankDimensionScale(null),
      `${abbreviation} leaves the tank's size alone`);
  }

  // Each moves exactly one of the two axes.
  close(getMaxSpeedFactor('V'), VELOCITY_AD, 'High Speed drives half again as fast');
  close(getMaxAngVelFactor('V'), 1, 'and turns at the world rate');
  close(getMaxAngVelFactor('QT'), ANGULAR_AD, 'Quick Turn turns half again as fast');
  close(getMaxSpeedFactor('QT'), 1, 'and drives at the world speed');
  close(getMaxSpeedFactor('A'), AGILITY_AD_VEL, 'Agility tops out at the boost');
  close(getMaxAngVelFactor('A'), 1);
  for (const abbreviation of ['SW', 'SR', 'US', 'B*', 'ZZ', null]) {
    close(getMaxSpeedFactor(abbreviation), 1, `${abbreviation} does not change speed`);
    close(getMaxAngVelFactor(abbreviation), 1, `${abbreviation} does not change turning`);
    assert.equal(getMotionEffects(abbreviation).agility, false);
  }

  // `V` and `QT` are constant, so the window arguments are never read.
  assert.deepEqual(getSpeedFactor('V', 0, 1, -Infinity, 0), { factor: VELOCITY_AD, agilityStartedAt: -Infinity });
  assert.deepEqual(getSpeedFactor(null, 0, 1, -Infinity, 0), { factor: 1, agilityStartedAt: -Infinity });

  // Agility's window. A stick that has barely moved earns nothing...
  const idle = getSpeedFactor('A', 0.5, 0.6, -Infinity, 100);
  close(idle.factor, 1, 'a change of 0.1 is not a direction change');
  assert.equal(idle.agilityStartedAt, -Infinity, 'and opens no window');
  // ...a change of more than _agilityVelDelta does, and starts the clock.
  const burst = getSpeedFactor('A', 0.0, 0.4, -Infinity, 100);
  close(burst.factor, AGILITY_AD_VEL, 'a change of 0.4 is');
  assert.equal(burst.agilityStartedAt, 100, 'and the window opens now');
  // Exactly the limit is not "more than" it, which is upstream's own `>`.
  close(getSpeedFactor('A', 0, AGILITY_VEL_DELTA, -Infinity, 100).factor, 1, 'the limit is exclusive');

  // Reversing needs half the change, because a reverse is a smaller number.
  close(getSpeedFactor('A', 0, -0.2, -Infinity, 100).factor, AGILITY_AD_VEL, 'a small reverse counts');
  close(getSpeedFactor('A', 0, -0.1, -Infinity, 100).factor, 1, 'a smaller one does not');

  // Inside the window everything is boosted, and the window does not extend --
  // the start it gives back is the one it was handed.
  const held = getSpeedFactor('A', 1, 1, 100, 100.5);
  close(held.factor, AGILITY_AD_VEL, 'the whole window is boosted');
  assert.equal(held.agilityStartedAt, 100, 'and holding the stick does not extend it');
  // And it closes on time.
  close(getSpeedFactor('A', 1, 1, 100, 100 + AGILITY_TIME_WINDOW).factor, 1, 'the window closes');

  // Deliberately not upstream: the change is measured against the previous
  // *stick*, so a held partial stick settles instead of re-triggering forever.
  // Upstream compares against the previous (possibly boosted) desired speed
  // clamped to [-0.5, 1], which makes half stick outweigh full stick.
  for (let held = 0.4; held <= 0.75; held += 0.05) {
    const settled = getSpeedFactor('A', held, held, -Infinity, 200);
    close(settled.factor, 1, `a held stick of ${held.toFixed(2)} does not re-trigger`);
  }
  // The [-0.5, 1] clamp is upstream's shape and is kept, though a raw stick
  // never reaches it.
  close(getSpeedFactor('A', 2.25, 1, -Infinity, 200).factor, 1, 'a boosted fraction clamps to 1');

  assert.deepEqual(serverFlags.getSpeedFactor('A', 0, 0.4, -Infinity, 100),
    getSpeedFactor('A', 0, 0.4, -Infinity, 100), 'client/server agility diverged');
  assert.equal(serverFlags.getMaxSpeedFactor('V'), getMaxSpeedFactor('V'));
}

// Phase 5's bad flags: five input clamps, one that jumps for you and one that
// fires for you. None of them is a multiplier, which is why they waited for the
// table the good three built rather than the other way round.
{
  for (const abbreviation of ['RC', 'FO', 'RO', 'LT', 'RT', 'BY', 'TR']) {
    const type = getFlagType(abbreviation);
    assert.equal(type.endurance, FLAG_ENDURANCE.STICKY, `${abbreviation} is FlagSticky`);
    assert.equal(type.quality, 1, `${abbreviation} is a bad flag`);
    assert.equal(isBadFlag(abbreviation), true);
    // None of them scales the tank; that is what separates them from V and QT.
    close(getMaxSpeedFactor(abbreviation), 1, `${abbreviation} does not change speed`);
    close(getMaxAngVelFactor(abbreviation), 1, `${abbreviation} does not change turning`);
  }
  assert.equal(getFlagType('RC').name, 'ReverseControls');
  assert.equal(getFlagType('RO').name, 'ReverseOnly');
  assert.equal(getFlagType('LT').help, 'Can\'t turn right.');
  assert.equal(getFlagType('RT').help, 'Can\'t turn left.');

  // A flag with nothing to say about the stick passes it straight through.
  for (const abbreviation of ['V', 'SW', 'US', null]) {
    assert.deepEqual(applyMotionInput(abbreviation, 0.7, -0.4), { forward: 0.7, turn: -0.4 });
  }

  // Reverse Controls negates both axes, and nothing else.
  assert.deepEqual(applyMotionInput('RC', 1, 1), { forward: -1, turn: -1 });
  assert.deepEqual(applyMotionInput('RC', -0.5, 0.25), { forward: 0.5, turn: -0.25 });
  assert.deepEqual(applyMotionInput('RC', 0, 0), { forward: -0, turn: -0 });

  // The four "only" flags take one direction away and leave the other alone.
  // Positive forward is forwards; positive turn is left (`TURN_KEYS` maps KeyA
  // to +1), which is why LT clamps the negative side and RT the positive.
  assert.deepEqual(applyMotionInput('FO', 1, 1), { forward: 1, turn: 1 }, 'FO keeps forward');
  assert.deepEqual(applyMotionInput('FO', -1, 1), { forward: 0, turn: 1 }, 'and refuses reverse');
  assert.deepEqual(applyMotionInput('RO', -0.5, 1), { forward: -0.5, turn: 1 }, 'RO keeps reverse');
  assert.deepEqual(applyMotionInput('RO', 1, 1), { forward: 0, turn: 1 }, 'and refuses forward');
  assert.deepEqual(applyMotionInput('LT', 1, 1), { forward: 1, turn: 1 }, 'LT keeps left');
  assert.deepEqual(applyMotionInput('LT', 1, -1), { forward: 1, turn: 0 }, 'and refuses right');
  assert.deepEqual(applyMotionInput('RT', 1, -1), { forward: 1, turn: -1 }, 'RT keeps right');
  assert.deepEqual(applyMotionInput('RT', 1, 1), { forward: 1, turn: 0 }, 'and refuses left');
  // Neither turn flag touches driving, and neither drive flag touches turning.
  assert.deepEqual(applyMotionInput('LT', -1, 1), { forward: -1, turn: 1 });
  assert.deepEqual(applyMotionInput('FO', 1, -1), { forward: 1, turn: -1 });

  // Bouncy jumps on a world that forbids jumping, which is most of the point.
  assert.equal(canJump('BY', false, false, 0), true, 'Bouncy bounces without -j');
  assert.equal(canJump('BY', false, true, 0), false, 'but not while already airborne');
  assert.equal(canJump(null, false, false, 0), false, 'where a plain tank cannot');

  // The bounce clock: landing buys BOUNCE_DELAY, and every frame after it is a
  // jump waiting to happen.
  assert.equal(BOUNCE_DELAY, 0.2);
  const landed = getBounceState('BY', true, true, 0, 100);
  assert.equal(landed.jump, false, 'the frame it lands does not bounce');
  close(landed.bounceReadyAt, 100 + BOUNCE_DELAY, 'it starts the delay instead');
  assert.equal(getBounceState('BY', true, false, 100.2, 100.1).jump, false, 'still waiting');
  assert.equal(getBounceState('BY', true, false, 100.2, 100.3).jump, true, 'and then it bounces');
  // Nothing bounces in mid air, and no other flag bounces at all.
  assert.equal(getBounceState('BY', false, false, 0, 100).jump, false, 'not while airborne');
  assert.equal(getBounceState('JP', true, false, 0, 100).jump, false, 'Jumping does not bounce');
  assert.equal(getBounceState(null, true, false, 0, 100).jump, false);

  // A quarter to a full jump, and never outside that.
  assert.equal(BOUNCY_JUMP_MIN_FACTOR, 0.25);
  assert.equal(BOUNCY_JUMP_RANGE, 0.75);
  close(getBouncyJumpVelocity(19, 0), 4.75, 'the smallest bounce is a quarter of a jump');
  close(getBouncyJumpVelocity(19, 1), 19, 'and the largest is a whole one');
  close(getBouncyJumpVelocity(19, 0.5), 11.875);

  assert.equal(firesContinuously('TR'), true);
  for (const abbreviation of ['MG', 'F', 'V', 'BY', null]) {
    assert.equal(firesContinuously(abbreviation), false, `${abbreviation} waits for the trigger`);
  }
  // Trigger Happy is not a shot variant: it changes who pulls the trigger, not
  // what leaves the barrel.
  assert.deepEqual(getShotEffects('TR'), getShotEffects(null));

  assert.deepEqual(serverFlags.applyMotionInput('RC', 1, -1), applyMotionInput('RC', 1, -1),
    'client/server input clamps diverged');
  assert.deepEqual(serverFlags.getBounceState('BY', true, true, 0, 100),
    getBounceState('BY', true, true, 0, 100), 'client/server bounce clock diverged');
}

// Inertia: the world's `-a` and the `M` flag that composes with it.
{
  assert.equal(LINEAR_ACCELERATION_SCALE, 20, 'upstream scales the linear limit by 20');
  assert.equal(MOMENTUM_LIN_ACC, 1.0, '_momentumLinAcc');
  assert.equal(MOMENTUM_ANG_ACC, 1.0, '_momentumAngAcc');
  assert.equal(getFlagType('M').name, 'Momentum');
  assert.equal(getFlagType('M').endurance, FLAG_ENDURANCE.STICKY);
  assert.equal(isBadFlag('M'), true);

  // No limit is upstream's default, and zero is how it is spelled.
  assert.deepEqual(getAccelerationLimits(null, 0, 0), { linear: 0, angular: 0 },
    'a world with no -a has no inertia');
  assert.deepEqual(getAccelerationLimits(null, undefined, undefined), { linear: 0, angular: 0 });
  // A negative is nobody's answer; upstream clamps it away and so does this.
  assert.deepEqual(getAccelerationLimits(null, -5, -5), { linear: 0, angular: 0 });

  // A world with -a, and no flag: upstream's numbers, linear scaled by 20.
  assert.deepEqual(getAccelerationLimits(null, 1, 1), { linear: 20, angular: 1 });
  assert.deepEqual(getAccelerationLimits(null, 0.5, 2), { linear: 10, angular: 2 });

  // M on a world with no inertia reduces to upstream's own figure exactly.
  assert.deepEqual(getAccelerationLimits('M', 0, 0), { linear: 20, angular: 1 },
    'M on a free world is upstream M');
  // And on a world that has inertia, M is always slower than the world -- which
  // is where bzo parts company with upstream, whose M would be an upgrade here.
  const heavy = getAccelerationLimits('M', 0.5, 0.5);
  close(heavy.linear, 20 / 3, 'M composes rather than replaces');
  assert.ok(heavy.linear < getAccelerationLimits(null, 0.5, 0.5).linear,
    'M is never faster than the world it is held on');
  // Upstream would hand back 20 here, i.e. exactly the world's own limit, and
  // the flag would do nothing at all.
  close(getAccelerationLimits('M', 1, 1).linear, 10, 'M halves a -a 1 1 world');

  // Composition itself: reciprocals add, and zero contributes nothing.
  close(composeAccelerationLimit(0, 1), 1, 'no world limit leaves the flag alone');
  close(composeAccelerationLimit(1, 0), 1, 'no flag limit leaves the world alone');
  close(composeAccelerationLimit(0, 0), 0, 'neither is still neither');
  close(composeAccelerationLimit(2, 2), 1, 'two equal limits halve');
  for (const [w, f] of [[0.25, 1], [1, 4], [3, 0.5]]) {
    const composed = composeAccelerationLimit(w, f);
    assert.ok(composed < w && composed < f, `${w} with ${f} is stricter than both`);
  }

  // The clamp. No limit means the tank gets what it asked for.
  close(applyAccelerationLimit(0, 25, 0, 0.1), 25, 'no limit is instant');
  close(applyAccelerationLimit(0, 25, 20, 0), 25, 'and so is a zero-length step');
  // 20 u/s^2 over a tenth of a second is two units of speed.
  close(applyAccelerationLimit(0, 25, 20, 0.1), 2, 'a limit is units per second squared');
  close(applyAccelerationLimit(10, 25, 20, 0.1), 12, 'measured from where it was');
  // Symmetric, as upstream's is: slowing down is limited exactly as speeding up.
  close(applyAccelerationLimit(25, 0, 20, 0.1), 23, 'stopping is limited too');
  close(applyAccelerationLimit(0, -12.5, 20, 0.1), -2, 'and so is reversing');
  // Asking for less than the limit allows gets exactly what was asked.
  close(applyAccelerationLimit(0, 1, 20, 0.1), 1, 'a small change is not clamped');

  // 0 to full speed at upstream's M, which is the figure to hold on to: 25 units
  // a second against a 20 unit-per-second-squared limit is a second and a
  // quarter.
  let speed = 0;
  let elapsed = 0;
  while (speed < 25 && elapsed < 10) {
    speed = applyAccelerationLimit(speed, 25, 20, 0.01);
    elapsed += 0.01;
  }
  close(elapsed, 1.25, 'M takes 1.25s to reach full speed', 0.02);

  assert.deepEqual(serverFlags.getAccelerationLimits('M', 1, 1), getAccelerationLimits('M', 1, 1),
    'client/server inertia diverged');
}

// Phase 6's damage rules: the two flags that change what a hit does without
// changing what a shot is.
{
  assert.equal(SR_RADIUS_MULT, 2.0, '_srRadiusMult');
  assert.equal(getFlagType('SR').name, 'Steamroller');
  assert.equal(getFlagType('G').name, 'Genocide');
  for (const abbreviation of ['SR', 'G']) {
    const type = getFlagType(abbreviation);
    assert.equal(type.endurance, FLAG_ENDURANCE.UNSTABLE, `${abbreviation} is FlagUnstable`);
    assert.equal(type.quality, 0, `${abbreviation} is a good flag`);
    assert.equal(type.team, null);
    // Neither touches the shot itself -- that is the whole point of the phase.
    assert.deepEqual(getShotEffects(abbreviation), getShotEffects(null),
      `${abbreviation} leaves the world's own shot alone`);
  }

  assert.equal(crushesOnContact('SR'), true);
  assert.equal(killsWholeTeam('G'), true);
  for (const abbreviation of ['SW', 'SH', 'US', 'L', 'B*', null]) {
    assert.equal(crushesOnContact(abbreviation), false, `${abbreviation} does not squash`);
    assert.equal(killsWholeTeam(abbreviation), false, `${abbreviation} kills one tank`);
  }

  // The reach is the victim's radius plus _srRadiusMult of the roller's, both
  // scaled by what their flags do to their size. bzo's tank radius, not
  // BZFlag's: a reach measured in tank radii shrinks with the tank.
  const R = 2;
  close(getRunOverRadius(null, 'SR', R), R + (2 * R), 'plain tank, plain roller');
  // A Tiny victim is a smaller target, and a Tiny roller has a shorter reach.
  close(getRunOverRadius('T', 'SR', R), (R * TINY_FACTOR) + (2 * R), 'Tiny is harder to run over');
  // Obesity cuts both ways, which is upstream reading both radii off the same
  // dimension scale.
  close(getRunOverRadius('O', 'SR', R), (R * OBESE_FACTOR) + (2 * R), 'Obesity is easier to run over');

  // The separation weighs the vertical double, so a tank overhead is twice as
  // far as the same gap along the ground.
  close(getRunOverSeparation(3, 0, 4), 5, 'flat ground is the plain distance');
  close(getRunOverSeparation(0, 3, 0), 6, 'and height counts double');
  close(getRunOverSeparation(0, 0, 0), 0);
  // Which is what stops a roller squashing somebody through a roof: a tank one
  // storey up is out of reach even standing on your head.
  const reach = getRunOverRadius(null, 'SR', R);
  assert.ok(getRunOverSeparation(0, 0, 0) < reach, 'standing on somebody squashes them');
  assert.ok(getRunOverSeparation(0, 3.05, 0) >= reach, 'a storey up is out of reach');
  assert.ok(getRunOverSeparation(5.9, 0, 0) < reach, 'and the reach along the ground is nearly two tanks');
  assert.ok(getRunOverSeparation(6.1, 0, 0) >= reach);

  assert.equal(serverFlags.getRunOverRadius('T', 'SR', R), getRunOverRadius('T', 'SR', R),
    'client/server run-over radius diverged');
  assert.equal(serverFlags.getRunOverSeparation(1, 2, 3), getRunOverSeparation(1, 2, 3),
    'client/server run-over separation diverged');
}

// A flap on the way up is worth taking only while you are climbing slower than
// it would launch you; on the way down it is spent cancelling the fall.
{
  const flapVelocity = 19;
  close(getWingsJumpVelocity(flapVelocity, 0), 19, 'a flap from a standstill');
  close(getWingsJumpVelocity(flapVelocity, -5), 14, 'a flap while falling only slows it');
  close(getWingsJumpVelocity(flapVelocity, -25), -6, 'a late flap does not stop a long fall');
  close(getWingsJumpVelocity(flapVelocity, 4), 19, 'a flap while climbing slowly relaunches');
  close(getWingsJumpVelocity(flapVelocity, 30), 30, 'a flap while climbing faster is wasted');
}

// LocalPlayer::doSlideMotion. Forward in bzo is (-sin, -cos), so a tank at
// heading 0 accelerates towards -z.
{
  const maxSpeed = 25;
  const slideTime = 2;
  const dt = 0.5;
  // From a standstill, a quarter of the slide time buys a quarter of the ask.
  const first = getWingsSlideVelocity(0, 0, 0, maxSpeed, maxSpeed, slideTime, dt);
  close(first.x, 0, 'no sideways component at heading 0');
  close(first.z, -maxSpeed * (dt / slideTime), 'a slide builds up over slideTime');

  // Asking for the same thing repeatedly converges on maxSpeed and stops there.
  let velocity = { x: 0, z: 0 };
  for (let step = 0; step < 20; step += 1) {
    velocity = getWingsSlideVelocity(velocity.x, velocity.z, 0, maxSpeed, maxSpeed, slideTime, dt);
  }
  close(Math.hypot(velocity.x, velocity.z), maxSpeed, 'a slide is held at maxSpeed');

  // A tank thrown over the limit is bled back towards it rather than snapped.
  const over = getWingsSlideVelocity(0, -100, 0, maxSpeed, maxSpeed, slideTime, dt);
  close(Math.hypot(over.x, over.z), 100 - (maxSpeed * (dt / slideTime)), 'over the limit bleeds off');

  // Turning the stick off leaves the velocity alone, which is what momentum is.
  const coasting = getWingsSlideVelocity(3, -4, 0, 0, maxSpeed, slideTime, dt);
  close(coasting.x, 3, 'no ask, no change in x');
  close(coasting.z, -4, 'no ask, no change in z');
}

// The table is the list of flags bzo implements, and every one of them needs a
// name and a help string because the help panel is generated from it.
for (const [abbreviation, type] of Object.entries(FLAG_TYPES)) {
  assert.equal(type.abbreviation, abbreviation, `${abbreviation} agrees with its key`);
  assert.ok(type.name.length > 0, `${abbreviation} has a name`);
  assert.ok(type.help.length > 0, `${abbreviation} has help text`);
  // Every bad flag upstream is sticky and every team flag is normal.
  if (type.quality === 1) assert.equal(type.endurance, 2, `${abbreviation} is sticky`);
  if (type.team !== null) assert.equal(type.endurance, 0, `${abbreviation} is FlagNormal`);
}

// rememberFlagIdentity -- what a client is allowed to remember about a slot.
// bzfs hides a superflag's type whenever nobody is carrying it, so the label a
// player sees comes from this memory rather than from the flag state.
{
  const known = new Map();
  const remember = (index, type, status) => rememberFlagIdentity(known, index, type, status);
  const label = (index, type = null) => getKnownFlagAbbreviation(known, { index, type });

  // A flag flies in and lands without anyone touching it: hidden throughout.
  remember(3, null, FLAG_STATUS.COMING);
  remember(3, null, FLAG_STATUS.ON_GROUND);
  assert.equal(label(3), null, 'a flag nobody has touched has no identity');

  // Identify names it, and it stays named while it sits there.
  remember(3, 'ID', FLAG_STATUS.ON_GROUND);
  assert.equal(label(3), 'ID', 'an identified flag is remembered');

  // The slot empties and refills. Its next flag is a fresh roll, so keeping the
  // old answer would label a new flag as the one that stood there before it.
  remember(3, null, FLAG_STATUS.NO_EXIST);
  assert.equal(label(3), null, 'a vanished flag is forgotten');
  remember(3, null, FLAG_STATUS.COMING);
  remember(3, null, FLAG_STATUS.ON_GROUND);
  assert.equal(label(3), null, 'the slot\'s next flag is not the last one');

  // A grab reveals a flag to everyone; the drop hides it again on the wire.
  remember(7, null, FLAG_STATUS.ON_GROUND);
  assert.equal(label(7), null, 'unheld and unknown');
  remember(7, 'US', FLAG_STATUS.ON_TANK);
  assert.equal(label(7, 'US'), 'US', 'a carried flag names itself');
  remember(7, 'US', FLAG_STATUS.IN_AIR);
  remember(7, null, FLAG_STATUS.ON_GROUND);
  assert.equal(label(7), 'US', 'a flag dropped back into the world stays identified');

  // A team flag is never hidden, so it answers with no memory needed, and a
  // flag that is still in flight has an identity worth keeping.
  remember(0, 'B*', FLAG_STATUS.ON_GROUND);
  assert.equal(label(0, 'B*'), 'B*', 'a team flag labels itself');
  remember(0, 'B*', FLAG_STATUS.NO_EXIST);
  assert.equal(label(0), null, 'a retired team flag is forgotten');
  remember(0, 'B*', FLAG_STATUS.ON_GROUND);
  assert.equal(label(0), 'B*', 'and re-learned when its team comes back');

  assert.equal(getKnownFlagAbbreviation(known, null), null, 'no flag, no label');
}

// Flag.cxx:89 -- the four team flags, in BZFlag's TeamColor order, all normal
// endurance so they can always be dropped and never vanish on their own.
const TEAM_FLAGS = [['R*', 'red', 1], ['G*', 'green', 2], ['B*', 'blue', 3], ['P*', 'purple', 4]];
for (const [abbreviation, team, colorIndex] of TEAM_FLAGS) {
  const type = getFlagType(abbreviation);
  assert.ok(type, `${abbreviation} is a known flag`);
  assert.equal(type.endurance, 0, `${abbreviation} is FlagNormal`);
  assert.equal(type.team, colorIndex);
  assert.equal(isTeamFlag(abbreviation), true);
  assert.equal(getFlagTeamIndex(abbreviation), colorIndex);
  assert.equal(getTeamFlagAbbreviation(colorIndex), abbreviation);
  // The colour index a base carries and the one a team flag carries must resolve
  // to the same bzo team, or a map's bases and its flags disagree.
  assert.equal(getTeamFromColorIndex(colorIndex), team);
  assert.equal(getTeamColorIndex(team), colorIndex);
  assert.equal(isColorTeamIndex(colorIndex), true);
}
assert.equal(getTeamFlagAbbreviation(0), null, 'rogue has no team flag');
assert.equal(getTeamFlagAbbreviation(5), null, 'observers have no team flag');
assert.equal(getTeamColorIndex('bogus'), null, 'an unknown name is not team zero');
assert.equal(isColorTeamIndex(0), false);
assert.equal(isColorTeamIndex(5), false);
assert.equal(isColorTeamIndex(null), false);

// World::whoseBase -- a base is captured from its top surface. hix.bzw puts its
// bases at z 26 with height 4, rotated 45 degrees, 70 units across.
const redBase = { kind: 'base', team: 1, x: 0, z: -340, baseY: 26, h: 4, w: 70, d: 70, rotation: Math.PI / 4 };
const blueBase = { kind: 'base', team: 3, x: 0, z: 340, baseY: 26, h: 4, w: 70, d: 70, rotation: 0 };
const bases = [redBase, blueBase];

close(getBaseTopY(redBase), 30, 'base top is its floor plus its height');
assert.equal(isOnBaseTop(redBase, 0, 30, -340), true, 'dead centre on the top counts');
assert.equal(isOnBaseTop(redBase, 0, 26, -340), false, 'standing at its foot does not');
assert.equal(isOnBaseTop(redBase, 0, 30 + (BASE_TOP_TOLERANCE / 2), -340), true, 'within the epsilon counts');
assert.equal(isOnBaseTop(redBase, 0, 31, -340), false, 'hovering above it does not');
assert.equal(isOnBaseTop(blueBase, 34, 30, 340), true, 'inside the footprint counts');
assert.equal(isOnBaseTop(blueBase, 36, 30, 340), false, 'outside the footprint does not');
assert.equal(getBaseTeamAtPoint(bases, 0, 30, -340), 1, 'the red base answers red');
assert.equal(getBaseTeamAtPoint(bases, 0, 30, 340), 3, 'the blue base answers blue');
assert.equal(getBaseTeamAtPoint(bases, 0, 30, 0), null, 'open ground answers nobody');
assert.equal(getBaseTeamAtPoint([{ ...redBase, kind: 'box' }], 0, 30, -340), null, 'a box is not a base');

// A drop looks for a flat top under the point, with no radius at all.
assert.equal(isOverFlatTop(blueBase, 0, 340), true);
assert.equal(isOverFlatTop(blueBase, 40, 340), false);
assert.equal(
  isOverFlatTop({ type: 'pyramid', x: 0, z: 0, baseY: 0, h: 10, w: 10, d: 10, rotation: 0 }, 0, 0),
  false,
  'a pointed pyramid is no place to land'
);

// FlagInfo::addFlag -- flightTime is 2 * sqrt(-2 * flagAltitude / gravity).
const flight = computeFlagFlight(FLAG_ALTITUDE, GRAVITY);
close(flight.flightEnd, 2 * Math.sqrt(2 * FLAG_ALTITUDE / GRAVITY), 'flight duration');
close(flight.flightEnd, 2.996597, 'flight duration at bzo gravity');
close(flight.initialVelocity, GRAVITY * Math.sqrt(2 * FLAG_ALTITUDE / GRAVITY), 'launch velocity');

// The parabola leaves the ground, reaches exactly the thrown altitude at the
// halfway point, and comes back to zero at the end.
close(getFlagFlightHeight(0, flight.initialVelocity, GRAVITY), 0, 'height at launch');
close(
  getFlagFlightHeight(flight.flightEnd / 2, flight.initialVelocity, GRAVITY),
  FLAG_ALTITUDE,
  'apex height'
);
close(getFlagFlightHeight(flight.flightEnd, flight.initialVelocity, GRAVITY), 0, 'height at landing');
// The hover height is that same apex, which is what keeps a Coming flag's fall
// continuous with the hover it falls out of.
close(
  getFlagHoverHeight(flight.flightEnd, flight.initialVelocity, GRAVITY),
  FLAG_ALTITUDE,
  'hover height equals apex'
);

// Flag.cxx:123 and FlagInfo.cxx:174. Shield is the one flag that answers a shot
// with a dropped flag rather than a death, and the flag it drops is thrown
// _shieldFlight times higher than any other -- which buys sqrt(_shieldFlight)
// times the flight, not _shieldFlight times it.
{
  const shield = getFlagType('SH');
  assert.equal(shield.name, 'Shield');
  assert.equal(shield.endurance, FLAG_ENDURANCE.UNSTABLE);
  assert.equal(shield.quality, 0);
  assert.equal(shield.team, null);
  assert.equal(SHIELD_FLIGHT, 2.7);

  assert.equal(shieldsAgainstShot('SH'), true);
  for (const abbreviation of ['R', 'US', 'ID', 'WG', 'B*', null]) {
    assert.equal(shieldsAgainstShot(abbreviation), false, `${abbreviation} does not stop a shot`);
  }

  close(getFlagThrownAltitude('SH'), 29.7, 'a shield flag is thrown 2.7 * _flagAltitude');
  for (const abbreviation of ['R', 'US', 'B*', null]) {
    close(
      getFlagThrownAltitude(abbreviation),
      FLAG_ALTITUDE,
      `${abbreviation} is thrown _flagAltitude high`
    );
  }

  const shieldFlight = computeFlagFlight(getFlagThrownAltitude('SH'), GRAVITY);
  close(shieldFlight.flightEnd, 2 * Math.sqrt(2 * 29.7 / GRAVITY), 'shield flight duration');
  close(shieldFlight.flightEnd, 4.923911, 'shield flight duration at bzo gravity');
  close(
    shieldFlight.flightEnd / flight.flightEnd,
    Math.sqrt(SHIELD_FLIGHT),
    'the extra altitude buys sqrt(_shieldFlight) times the flight'
  );
  close(
    getFlagFlightHeight(shieldFlight.flightEnd / 2, shieldFlight.initialVelocity, GRAVITY),
    29.7,
    'shield apex is the altitude it was thrown to'
  );
}

// A dropped flag: launched from a tank on a building, landing on the ground
// well to one side.
const thrown = {
  status: FLAG_STATUS.IN_AIR,
  position: { x: 0, y: 0, z: 0 },
  launchPosition: { x: 10, y: 30, z: -5 },
  landingPosition: { x: 10, y: 0, z: -5 },
  flightEnd: flight.flightEnd,
  initialVelocity: flight.initialVelocity,
};

const atLaunch = getFlagFlightState(thrown, 0, GRAVITY);
close(atLaunch.x, 10, 'launch x');
close(atLaunch.y, 30, 'launch altitude');
close(atLaunch.z, -5, 'launch z');
assert.equal(atLaunch.landed, false);

const atApex = getFlagFlightState(thrown, flight.flightEnd / 2, GRAVITY);
close(atApex.y, 15 + FLAG_ALTITUDE, 'apex is halfway down the lerp plus the throw');

const atLanding = getFlagFlightState(thrown, flight.flightEnd, GRAVITY);
close(atLanding.x, 10, 'landing x');
close(atLanding.y, 0, 'landing altitude');
close(atLanding.z, -5, 'landing z');
assert.equal(atLanding.landed, true, 'the flight ends exactly at flightEnd');

// Altitude never dips below the lerp between the two ends: the flag is thrown
// up, not down.
for (let step = 0; step <= 60; step += 1) {
  const elapsed = (step / 60) * flight.flightEnd;
  const state = getFlagFlightState(thrown, elapsed, GRAVITY);
  const t = elapsed / flight.flightEnd;
  const lerped = ((1 - t) * 30) + (t * 0);
  assert.ok(state.y >= lerped - EPSILON, `altitude dipped below the lerp at t=${t}`);
}

// A spawning flag: hovers at the apex over its landing spot for the first half,
// fading in over the first quarter, then falls.
const coming = {
  status: FLAG_STATUS.COMING,
  position: { x: -20, y: 0, z: 40 },
  launchPosition: { x: -20, y: 0, z: 40 },
  landingPosition: { x: -20, y: 0, z: 40 },
  flightEnd: flight.flightEnd,
  initialVelocity: flight.initialVelocity,
};
const quarter = flight.flightEnd / 4;

close(getFlagFlightState(coming, 0, GRAVITY).alpha, 0, 'a spawning flag starts invisible');
close(getFlagFlightState(coming, 0, GRAVITY).y, FLAG_ALTITUDE, 'a spawning flag starts at the apex');
close(getFlagFlightState(coming, quarter / 2, GRAVITY).alpha, 0.5, 'fades in over the first quarter');
close(getFlagFlightState(coming, quarter, GRAVITY).warp, 1, 'the warp peaks a quarter in');
close(getFlagFlightState(coming, 2 * quarter, GRAVITY).warp, 0, 'the warp is gone by the halfway point');
close(getFlagFlightState(coming, 2 * quarter, GRAVITY).y, FLAG_ALTITUDE, 'the fall starts from the apex');
assert.ok(
  getFlagFlightState(coming, 3 * quarter, GRAVITY).y < FLAG_ALTITUDE,
  'a spawning flag is falling in the second half'
);
const landedComing = getFlagFlightState(coming, flight.flightEnd, GRAVITY);
close(landedComing.y, 0, 'a spawning flag settles at its landing altitude');
assert.equal(landedComing.landed, true);
close(landedComing.alpha, 1, 'a landed flag is opaque');

// A vanishing flag is the reverse: it rises, the warp grows, then both fade.
const going = { ...coming, status: FLAG_STATUS.GOING };
close(getFlagFlightState(going, 0, GRAVITY).y, 0, 'a vanishing flag starts on the ground');
close(getFlagFlightState(going, 0, GRAVITY).alpha, 1, 'a vanishing flag starts opaque');
close(getFlagFlightState(going, 2 * quarter, GRAVITY).y, FLAG_ALTITUDE, 'it rises to the apex');
close(getFlagFlightState(going, 3 * quarter, GRAVITY).warp, 1, 'the warp peaks three quarters in');
close(getFlagFlightState(going, 3.5 * quarter, GRAVITY).alpha, 0.5, 'it fades over the last quarter');
const goneFlag = getFlagFlightState(going, flight.flightEnd, GRAVITY);
close(goneFlag.alpha, 0, 'a vanished flag is invisible');
assert.equal(goneFlag.landed, true);

// A flag on the ground or on a tank does not move.
for (const status of [FLAG_STATUS.ON_GROUND, FLAG_STATUS.ON_TANK, FLAG_STATUS.NO_EXIST]) {
  const still = getFlagFlightState({ ...coming, status }, 99, GRAVITY);
  close(still.x, -20, 'a resting flag keeps its x');
  close(still.y, 0, 'a resting flag keeps its altitude');
  close(still.z, 40, 'a resting flag keeps its z');
  assert.equal(still.landed, false, 'a resting flag is not landing');
}

// Client/server parity across the whole table of inputs.
for (const [name, value] of Object.entries(serverFlags)) {
  if (typeof value === 'number') {
    const clientValue = (await import('../public/flags.mjs'))[name];
    assert.equal(value, clientValue, `${name} diverged between the copies`);
  }
}

for (const abbreviation of ['WG', 'JP', 'US', null]) {
  for (const allowJumping of [false, true]) {
    for (const airborne of [false, true]) {
      for (const flapsLeft of [0, 1]) {
        assert.equal(
          serverFlags.canJump(abbreviation, allowJumping, airborne, flapsLeft),
          canJump(abbreviation, allowJumping, airborne, flapsLeft),
          `client/server canJump diverged for ${abbreviation}/${allowJumping}/${airborne}/${flapsLeft}`
        );
      }
    }
  }
  assert.equal(serverFlags.hasAirControl(abbreviation), hasAirControl(abbreviation));
}

for (const abbreviation of ['R', 'SB', 'L', 'US', null]) {
  for (const allShotsRicochet of [false, true]) {
    assert.equal(
      serverFlags.shotRicochets(abbreviation, allShotsRicochet),
      shotRicochets(abbreviation, allShotsRicochet),
      `client/server shotRicochets diverged for ${abbreviation}/${allShotsRicochet}`
    );
  }
}

for (const verticalVelocity of [-30, -5, 0, 4, 30]) {
  close(
    serverFlags.getWingsJumpVelocity(19, verticalVelocity),
    getWingsJumpVelocity(19, verticalVelocity),
    'client/server wings jump velocity diverged'
  );
}
for (const [vx, vz, speed] of [[0, 0, 25], [0, -100, 25], [3, -4, 0], [10, 10, 12.5]]) {
  assert.deepEqual(
    serverFlags.getWingsSlideVelocity(vx, vz, 0.5, speed, 25, 2, 0.5),
    getWingsSlideVelocity(vx, vz, 0.5, speed, 25, 2, 0.5),
    'client/server wings slide diverged'
  );
}

const parityFlags = [thrown, coming, going];
for (const flag of parityFlags) {
  for (let step = 0; step <= 40; step += 1) {
    const elapsed = (step / 30) * flight.flightEnd;
    const clientState = getFlagFlightState(flag, elapsed, GRAVITY);
    const serverState = serverFlags.getFlagFlightState(flag, elapsed, GRAVITY);
    assert.deepEqual(
      serverState,
      clientState,
      `client/server flight diverged for status ${flag.status} at ${elapsed}s`
    );
  }
}

for (const altitude of [1, 5, FLAG_ALTITUDE, 40]) {
  for (const gravity of [4.9, GRAVITY, 19.6]) {
    assert.deepEqual(
      serverFlags.computeFlagFlight(altitude, gravity),
      computeFlagFlight(altitude, gravity),
      `client/server flight computation diverged for ${altitude}/${gravity}`
    );
  }
}

// Phase 7. Player::updateFlagEffect scales length and width from one factor for
// `T` and `O`, touches only the width for `N`, and never touches height.
assert.deepEqual(getTankDimensionScale('T'), { length: TINY_FACTOR, width: TINY_FACTOR });
assert.deepEqual(getTankDimensionScale('O'), { length: OBESE_FACTOR, width: OBESE_FACTOR });
assert.deepEqual(getTankDimensionScale('N'), { length: 1, width: NARROW_FACTOR });
for (const abbreviation of [null, 'US', 'JP', 'R*']) {
  assert.deepEqual(
    getTankDimensionScale(abbreviation),
    { length: 1, width: 1 },
    `${abbreviation} should not resize a tank`
  );
}

// Player::getRadius reads dimensionsScale[0], the length axis, which is exactly
// the one Narrow leaves alone -- upstream's own comment says so.
assert.equal(getTankHitRadiusScale('T'), TINY_FACTOR);
assert.equal(getTankHitRadiusScale('O'), OBESE_FACTOR);
assert.equal(getTankHitRadiusScale('N'), 1, 'Narrow must not change the hit radius');
assert.equal(usesNarrowHitBox('N'), true);
for (const abbreviation of [null, 'T', 'O', 'US']) {
  assert.equal(usesNarrowHitBox(abbreviation), false, `${abbreviation} uses the sphere`);
}

// The ease is linear and takes exactly _flagEffectTime however far it travels.
assert.equal(getTankDimensionEase(1, OBESE_FACTOR, 0), 1);
assert.equal(getTankDimensionEase(1, OBESE_FACTOR, FLAG_EFFECT_TIME), OBESE_FACTOR);
assert.equal(getTankDimensionEase(1, OBESE_FACTOR, FLAG_EFFECT_TIME * 2), OBESE_FACTOR);
assert.equal(
  getTankDimensionEase(1, OBESE_FACTOR, FLAG_EFFECT_TIME / 2),
  1 + ((OBESE_FACTOR - 1) / 2)
);
assert.equal(getTankDimensionEase(TINY_FACTOR, 1, FLAG_EFFECT_TIME), 1, 'the ease runs both ways');

for (const abbreviation of ['T', 'N', 'O', null]) {
  assert.deepEqual(
    serverFlags.getTankDimensionScale(abbreviation),
    getTankDimensionScale(abbreviation),
    `client/server tank scale diverged for ${abbreviation}`
  );
}

// Phase 4's view flags. Each is one flag and nothing else, so a predicate that
// answered for two of them would be a flag doing another's job.
assert.equal(blanksTheView('B'), true);
assert.equal(jamsTheRadar('JM'), true);
assert.equal(hidesTeamColors('CB'), true);
for (const abbreviation of [null, 'B', 'JM', 'CB', 'US', 'O']) {
  const hits = [blanksTheView, jamsTheRadar, hidesTeamColors]
    .filter((predicate) => predicate(abbreviation)).length;
  assert.ok(hits <= 1, `${abbreviation} answered more than one view effect`);
}
assert.equal(blanksTheView('JM'), false, 'Jamming leaves the view alone');
assert.equal(jamsTheRadar('B'), false, 'Blindness leaves the radar alone');

// The jam cadence: noise holds the decay down, and a good frame sets it to 1 so
// a second good frame is guaranteed before it halves away again.
assert.equal(getNextRadarJamDecay(RADAR_JAM_DECAY_MIN, true), RADAR_JAM_DECAY_MIN);
assert.equal(getNextRadarJamDecay(RADAR_JAM_DECAY_MIN, false), 1.0);
assert.equal(getNextRadarJamDecay(1.0, false), 0.5);
assert.equal(getNextRadarJamDecay(0.5, true), 0.25);
assert.ok(
  getNextRadarJamDecay(1.0, false) > RADAR_JAM_DECAY_FLOOR,
  'the frame after a good one must still be a good one'
);
// It always returns to the floor rather than running away in either direction.
let decay = 1.0;
for (let i = 0; i < 200; i += 1) decay = getNextRadarJamDecay(decay, true);
assert.ok(decay > 0 && decay <= RADAR_JAM_DECAY_FLOOR, `decay settled at ${decay}`);

for (const abbreviation of ['B', 'JM', 'CB', null]) {
  assert.equal(serverFlags.blanksTheView(abbreviation), blanksTheView(abbreviation));
  assert.equal(serverFlags.jamsTheRadar(abbreviation), jamsTheRadar(abbreviation));
  assert.equal(serverFlags.hidesTeamColors(abbreviation), hidesTeamColors(abbreviation));
}

// Phase 13. Four flags that each answer for exactly one thing, so a predicate
// that answered for two would be one flag doing another's job.
assert.equal(hidesFromRadar('ST'), true);
assert.equal(cloaksTheTank('CL'), true);
assert.equal(fakesTeamColor('MQ'), true);
assert.equal(seesThroughDisguises('SE'), true);
for (const abbreviation of [null, 'ST', 'CL', 'MQ', 'SE', 'US', 'CB']) {
  const hits = [hidesFromRadar, cloaksTheTank, fakesTeamColor, seesThroughDisguises]
    .filter((predicate) => predicate(abbreviation)).length;
  assert.ok(hits <= 1, `${abbreviation} answered more than one visibility effect`);
}
// The pair that is often confused: stealth is the radar, cloaking is the window,
// and carrying one must not buy the other.
assert.equal(hidesFromRadar('CL'), false, 'cloaking does not hide from radar');
assert.equal(cloaksTheTank('ST'), false, 'stealth does not hide from the window');

// Only cloaking moves a tank's alpha, and it moves it all the way.
assert.equal(getTankAlphaTarget('CL'), 0);
for (const abbreviation of [null, 'ST', 'MQ', 'SE', 'US']) {
  assert.equal(getTankAlphaTarget(abbreviation), 1, `${abbreviation} must stay solid`);
}

// getVisibleTankAlpha: mid-cloak is translucent, fully cloaked is gone, and a
// seer sees it solid rather than faint -- "as normal", not "as a ghost".
assert.equal(getVisibleTankAlpha('CL', 0.5, null), 0.5, 'a half-faded cloak is half visible');
assert.equal(getVisibleTankAlpha('CL', 0, null), 0, 'a finished cloak is gone');
assert.equal(getVisibleTankAlpha('CL', 0, 'SE'), SEER_REVEAL_ALPHA);
assert.equal(getVisibleTankAlpha('CL', 0.5, 'SE'), SEER_REVEAL_ALPHA);
assert.equal(SEER_REVEAL_ALPHA, 1, 'a seer sees a cloaked tank solid');
// A seer's own view of an ordinary tank is unchanged, and a stealthed tank is
// solid to everyone -- it was never the window it was hiding from.
assert.equal(getVisibleTankAlpha(null, 1, 'SE'), 1);
assert.equal(getVisibleTankAlpha('ST', 1, null), 1);

for (const theirs of ['ST', 'CL', 'MQ', 'SE', null]) {
  assert.equal(serverFlags.hidesFromRadar(theirs), hidesFromRadar(theirs));
  assert.equal(serverFlags.cloaksTheTank(theirs), cloaksTheTank(theirs));
  assert.equal(serverFlags.fakesTeamColor(theirs), fakesTeamColor(theirs));
  assert.equal(serverFlags.seesThroughDisguises(theirs), seesThroughDisguises(theirs));
  for (const mine of ['SE', null]) {
    assert.equal(
      serverFlags.getVisibleTankAlpha(theirs, 0, mine),
      getVisibleTankAlpha(theirs, 0, mine),
      `client/server visible alpha diverged for ${theirs} seen by ${mine}`
    );
  }
}

// _targetingAngle and _lockOnAngle (global.cxx:158, :84).
{
  assert.equal(TARGETING_ANGLE, 0.3, '_targetingAngle');
  assert.equal(LOCK_ON_ANGLE, 0.15, '_lockOnAngle');
  assert.ok(LOCK_ON_ANGLE < TARGETING_ANGLE, 'a lock is the tighter of the two cones');

  // setTarget() (playing.cxx:4390): the nearest tank inside the cone wins, and
  // anything behind the eye is ignored however close it is. The cone is the
  // caller's, so the same scan serves an observer's identify and a missile's lock.
  const eye = { x: 0, z: 0 };
  const north = { x: 0, z: -1 };
  assert.equal(pickTargetInSights(eye, north, [{ id: 'a', x: 0, z: -50 }], TARGETING_ANGLE), 'a');
  assert.equal(pickTargetInSights(eye, north, [{ id: 'behind', x: 0, z: 50 }], TARGETING_ANGLE), null);
  assert.equal(
    pickTargetInSights(eye, north, [{ id: 'far', x: 0, z: -80 }, { id: 'near', x: 0, z: -20 }], TARGETING_ANGLE),
    'near',
    'the nearest inside the cone wins',
  );
  // A candidate just inside the cone is taken, one just outside is not: at 100
  // ahead the cone half-width is 100 * tan(asin(0.3)).
  const coneHalfWidth = 100 * Math.tan(Math.asin(TARGETING_ANGLE));
  assert.equal(pickTargetInSights(eye, north, [{ id: 'in', x: coneHalfWidth * 0.98, z: -100 }], TARGETING_ANGLE), 'in');
  assert.equal(pickTargetInSights(eye, north, [{ id: 'out', x: coneHalfWidth * 1.02, z: -100 }], TARGETING_ANGLE), null);
  // A nearer tank outside the cone does not beat a further one inside it.
  assert.equal(
    pickTargetInSights(eye, north, [
      { id: 'wide', x: 30, z: -10 },
      { id: 'narrow', x: 0, z: -90 },
    ], TARGETING_ANGLE),
    'narrow',
  );
  // The cone turns with the camera.
  assert.equal(pickTargetInSights(eye, { x: -1, z: 0 }, [{ id: 'west', x: -40, z: 0 }], TARGETING_ANGLE), 'west');
  assert.equal(pickTargetInSights(eye, north, [{ id: 'west', x: -40, z: 0 }], TARGETING_ANGLE), null);
  // Degenerate input is inert rather than throwing.
  assert.equal(pickTargetInSights(eye, { x: 0, z: 0 }, [{ id: 'a', x: 0, z: -5 }], TARGETING_ANGLE), null);
  assert.equal(pickTargetInSights(eye, north, [], TARGETING_ANGLE), null);
  assert.equal(pickTargetInSights(eye, north, null, TARGETING_ANGLE), null);

  // The lock cone is half as wide, so a tank an observer would name is not
  // necessarily one a missile will follow. At 100 ahead: 15.3 units against 30.9.
  const lockHalfWidth = 100 * Math.tan(Math.asin(LOCK_ON_ANGLE));
  const between = [{ id: 'wide', x: (lockHalfWidth + coneHalfWidth) / 2, z: -100 }];
  assert.equal(pickTargetInSights(eye, north, between, TARGETING_ANGLE), 'wide');
  assert.equal(pickTargetInSights(eye, north, between, LOCK_ON_ANGLE), null);
}

// GuidedMissileStrategy::update, the heading half of it. A missile turns at
// _gmTurnAngle a second in azimuth and in elevation, and no faster.
{
  assert.equal(GM_TURN_ANGLE, 0.628319, '_gmTurnAngle');
  const north = { x: 0, y: 0, z: -1 };
  const from = { x: 0, y: 5, z: 0 };

  // Nothing locked: the missile keeps the heading it was fired with, and the
  // direction comes back normalized whatever went in.
  assert.deepEqual(steerGuidedShot(north, from, null, GM_TURN_ANGLE, 1), north);
  const long = steerGuidedShot({ x: 0, y: 0, z: -7 }, from, null, GM_TURN_ANGLE, 1);
  close(Math.hypot(long.x, long.y, long.z), 1, 'a steered direction is a unit vector');

  // A target dead ahead is already the heading, so nothing turns.
  const ahead = steerGuidedShot(north, from, { x: 0, y: 5, z: -100 }, GM_TURN_ANGLE, 1);
  close(ahead.x, 0);
  close(ahead.z, -1);

  // A target off to the left, further than one second of turn: the missile
  // turns exactly _gmTurnAngle and no further. bzo's azimuth 0 faces -Z and
  // turns left as it grows, which is playerRotation's own convention.
  const left = steerGuidedShot(north, from, { x: -100, y: 5, z: 0 }, GM_TURN_ANGLE, 1);
  close(Math.atan2(-left.x, -left.z), GM_TURN_ANGLE, 'one second of turn, to the left');
  const halfStep = steerGuidedShot(north, from, { x: -100, y: 5, z: 0 }, GM_TURN_ANGLE, 0.5);
  close(Math.atan2(-halfStep.x, -halfStep.z), GM_TURN_ANGLE / 2, 'half a second, half the turn');
  const right = steerGuidedShot(north, from, { x: 100, y: 5, z: 0 }, GM_TURN_ANGLE, 1);
  close(Math.atan2(-right.x, -right.z), -GM_TURN_ANGLE, 'and the other way for the other side');

  // Within reach in one step, the missile snaps onto the target rather than
  // overshooting it -- the first branch of upstream's three.
  const near = steerGuidedShot(north, from, { x: -1, y: 5, z: -100 }, GM_TURN_ANGLE, 1);
  close(Math.atan2(-near.x, -near.z), Math.atan2(1, 100), 'a small correction is taken whole');

  // Azimuth and elevation are turned separately, so a target behind and above
  // gets both at once and neither faster than the rate.
  const climbing = steerGuidedShot(north, from, { x: 0, y: 105, z: 100 }, GM_TURN_ANGLE, 1);
  close(Math.asin(climbing.y), GM_TURN_ANGLE, 'a full step of climb');
  close(Math.abs(Math.atan2(-climbing.x, -climbing.z)), GM_TURN_ANGLE, 'and a full step of turn');

  // A target directly overhead has no bearing to steer toward, so the missile
  // holds the one it has and climbs rather than swinging to due north.
  const overhead = steerGuidedShot({ x: 1, y: 0, z: 0 }, from, { x: 0, y: 60, z: 0 }, GM_TURN_ANGLE, 1);
  close(Math.atan2(-overhead.x, -overhead.z), -Math.PI / 2, 'the bearing is kept');
  close(Math.asin(overhead.y), GM_TURN_ANGLE);

  // A direction with nothing in it cannot be turned, so it answers with one
  // that can be drawn rather than with NaN.
  assert.deepEqual(
    steerGuidedShot({ x: 0, y: 0, z: 0 }, from, { x: 10, y: 5, z: 10 }, GM_TURN_ANGLE, 1),
    { x: 0, y: 0, z: -1 },
  );

  // Both ends steer the same missile.
  for (const to of [null, { x: -40, y: 6, z: -30 }, { x: 12, y: 0, z: 90 }]) {
    assert.deepEqual(
      serverFlags.steerGuidedShot(north, from, to, GM_TURN_ANGLE, 1 / 60),
      steerGuidedShot(north, from, to, GM_TURN_ANGLE, 1 / 60),
      'client/server guidance diverged',
    );
  }
}

console.log('Flag flight and type tests passed');
