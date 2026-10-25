/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// bzdb.mjs - The world's variables as upstream's BZDB holds them: names to
// raw strings, read the way `BZDB.eval`, `BZDB.isTrue` and `parseColorString`
// read them, and turned into the config bzo's shared code runs on
// (`worldConfig`). The server and every browser run this one copy over the
// same strings -- a map's `-set` lines, the server's `/set`s, or a bzfs
// target's own table -- as an upstream client keeps its own BZDB.

import { BZDB_DEFAULTS } from './bzdb-defaults.mjs';
import { COLOR_NAMES } from './color-names.mjs';
import { normalizeFlagGrabs } from './flags.mjs';

// StateDatabase::set's `isTrue`: any value but these, empty included, is on.
// `-disableBots` publishes `_disableBots` as "true", which a number test reads
// as off.
const BZDB_FALSE_VALUES = new Set(['0', 'off', 'false', 'no', 'disable']);
export function bzdbIsTrue(value) {
  return typeof value === 'string' && !BZDB_FALSE_VALUES.has(value.toLowerCase());
}

// BZDB holds expressions, not just numbers. On a stock server `_reloadTime` is
// `_shotRange / _shotSpeed`, `_muzzleFront` is `_tankRadius + 0.1` and
// `_tankRadius` is `0.72 * _tankLength` (`global.cxx`), and a live target
// sends all 168 entries exactly as written. Upstream reads them through
// `BZDB.eval` (`StateDatabase::evaluate`) and compares a shot against the
// result, so a proxied shot has to arrive at the same number -- parsing the
// string as a float would give NaN for a good part of the table and every
// shot built on one would be dropped without a word.
//
// Arithmetic only: four operators, parentheses and a sign, which is all the
// stock table uses. Never `eval`, because these values come off the wire from
// a machine this one does not own. A name that resolves to nothing, or to a
// cycle, is NaN rather than a guess.
const BZDB_TOKENS = /\d+\.?\d*(?:[eE][-+]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|[-+*/()]|\s+/g;

function tokenizeBzdb(text) {
  const tokens = [];
  let consumed = 0;
  for (const match of text.matchAll(BZDB_TOKENS)) {
    // A gap means something the grammar does not cover, so the whole value is
    // refused rather than silently read as the part that did parse.
    if (match.index !== consumed) return null;
    consumed = match.index + match[0].length;
    if (match[0].trim() !== '') tokens.push(match[0]);
  }
  return consumed === text.length ? tokens : null;
}

function parseBzdb(tokens, resolve) {
  let at = 0;
  const peek = () => tokens[at];
  const expression = () => {
    let value = term();
    while (peek() === '+' || peek() === '-') {
      const operator = tokens[at]; at += 1;
      const right = term();
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  };
  const term = () => {
    let value = signed();
    while (peek() === '*' || peek() === '/') {
      const operator = tokens[at]; at += 1;
      const right = signed();
      value = operator === '*' ? value * right : value / right;
    }
    return value;
  };
  const signed = () => {
    if (peek() === '-') { at += 1; return -signed(); }
    if (peek() === '+') { at += 1; return signed(); }
    return atom();
  };
  const atom = () => {
    const token = tokens[at]; at += 1;
    if (token === undefined) return NaN;
    if (token === '(') {
      const value = expression();
      if (tokens[at] !== ')') return NaN;
      at += 1;
      return value;
    }
    if (/^[A-Za-z_]/.test(token)) return resolve(token);
    return Number(token);
  };
  const value = expression();
  // Trailing tokens mean the value was not one expression, so it is no answer.
  return at === tokens.length ? value : NaN;
}

export function evalBzdb(vars, name, seen = new Set()) {
  if (seen.has(name)) return NaN;
  const raw = (vars && vars.get(name) !== undefined) ? vars.get(name) : BZDB_DEFAULTS[name];
  if (raw === undefined || String(raw).trim() === '') return NaN;
  const direct = Number(raw);
  if (Number.isFinite(direct)) return direct;
  const tokens = tokenizeBzdb(String(raw));
  if (tokens === null) return NaN;
  const outer = new Set(seen).add(name);
  return parseBzdb(tokens, (reference) => evalBzdb(vars, reference, outer));
}

// parseColorString (ParseColor.cxx): a colour as a map or a BZDB variable
// writes one -- three or four numbers, or a name from upstream's X11 table,
// optionally followed by an alpha (`red 0.5`). Returns [r, g, b, a], each
// unclamped as upstream leaves them, or null where upstream's parse fails.

export function parseColorString(text) {
  const str = String(text ?? '').trimStart();
  if (!str || str[0] === '#') return null;
  if (/^[0-9.+-]/.test(str)) {
    const values = str.split(/\s+/).slice(0, 4).map(Number);
    let count = 0;
    while (count < values.length && Number.isFinite(values[count])) count++;
    if (count < 3) return null;
    return [values[0], values[1], values[2], count > 3 ? values[3] : 1];
  }
  const lower = str.toLowerCase();
  for (const [name, rgb] of COLOR_NAMES) {
    const key = name.toLowerCase();
    const end = lower[key.length];
    if (lower.startsWith(key) && (end === undefined || /\s/.test(end))) {
      const alpha = Number.parseFloat(str.slice(key.length));
      return [...rgb, Number.isFinite(alpha) ? alpha : 1];
    }
  }
  return null;
}

// SceneRenderer::render's `_mirror` (SceneRenderer.cxx:742): anything but
// "none" is a mirror, its colour the tint laid over the reflection. A colour
// that will not parse is black at half, and a fully opaque one "probably a
// mistake", so half too. Null is no mirror.
export function parseMirror(text) {
  const value = String(text ?? '');
  if (value === 'none') return null;
  const color = parseColorString(value);
  if (!color) return [0, 0, 0, 0.5];
  return [color[0], color[1], color[2], color[3] === 1 ? 0.5 : color[3]];
}

export function parseFogMode(text) {
  const mode = String(text || '').trim().toLowerCase();
  if (mode === 'none' || mode === 'linear' || mode === 'exp2') return mode;
  return 'exp';
}

// The world variables bzo reads, each mapped onto the config field that holds
// it. Every one of these is
// `StateDatabase::Locked` upstream (`globalDBItems`, src/common/global.cxx),
// so the server owns the value and the client is told it -- which is exactly
// bzo's own arrangement, and why a map may state them at all.
//
// `-j` and `+r` are not here either -- bzo forces jumping and ricochet on
// (see "The options block" in docs/bzw.md), so a map cannot turn them off.
export const BZDB_CONFIG_VARS = new Map([
  // The superflag and step rules: a grab count upstream reads as an int, a
  // flap count, and a step height. Zero is a real answer for the last two.
  ['_maxFlagGrabs', { key: 'MAX_FLAG_GRABS', transform: normalizeFlagGrabs, allowZero: true }],
  ['_wingsJumpCount', { key: 'WINGS_JUMP_COUNT', transform: Math.round, allowZero: true }],
  ['_maxBumpHeight', { key: 'MAX_BUMP_HEIGHT', allowZero: true }],
  // Flags on the field: how high one is thrown or flies in from, and its pole.
  ['_flagAltitude', { key: 'FLAG_ALTITUDE' }],
  ['_flagPoleSize', { key: 'FLAG_POLE_SIZE' }],
  // The server's rules. Seconds upstream, milliseconds here for the two times.
  ['_pauseDropTime', { key: 'PAUSE_DROP_TIME', transform: (n) => n * 1000, allowZero: true }],
  ['_speedChecksLogOnly', { key: 'SPEED_CHECKS_LOG_ONLY', parse: bzdbIsTrue }],
  // Updates a second at most; 0 is no limit (Player.cxx:1268).
  ['_updateThrottleRate', { key: 'UPDATE_THROTTLE_RATE', allowZero: true }],
  ['_forbidMarkers', { key: 'FORBID_MARKERS', parse: bzdbIsTrue }],
  // SpawnPolicy's: tank radii to keep from a tank facing the spot, from a
  // Steamroller or Burrow, the share of a Shock Wave's reach, and how long the
  // search may take.
  ['_spawnSafeRadMod', { key: 'SPAWN_SAFE_RAD_MOD', allowZero: true }],
  ['_spawnSafeSRMod', { key: 'SPAWN_SAFE_SR_MOD', allowZero: true }],
  ['_spawnSafeSWMod', { key: 'SPAWN_SAFE_SW_MOD', allowZero: true }],
  ['_spawnMaxCompTime', { key: 'SPAWN_MAX_COMP_TIME', transform: (n) => n * 1000, allowZero: true }],
  ['_tankSpeed', { key: 'TANK_SPEED' }],
  ['_tankAngVel', { key: 'TANK_ROTATION_SPEED' }],
  // Upstream states gravity as a negative acceleration and bzo keeps the
  // magnitude, so a map's `-9.81` and its `9.81` mean the same thing here.
  ['_gravity', { key: 'GRAVITY', transform: Math.abs }],
  ['_jumpVelocity', { key: 'JUMP_VELOCITY' }],
  ['_shotSpeed', { key: 'SHOT_SPEED' }],
  ['_shotRange', { key: 'SHOT_RANGE' }],
  ['_shotRadius', { key: 'SHOT_RADIUS' }],
  ['_shotsKeepVerticalVelocity', { key: 'SHOTS_KEEP_VERTICAL_VELOCITY', transform: (n) => n !== 0 }],
  // Seconds upstream, milliseconds here. A dead tank waits this long to spawn
  // again (`setSpawnDelay`, bzfs.cxx:3371); 0 is no wait, which 18 of the
  // public servers ask for.
  ['_explodeTime', { key: 'RESPAWN_DELAY', transform: (n) => n * 1000, allowZero: true }],
  // The same units, and its default is `_explodeTime`, so it follows that.
  ['_rejoinTime', { key: 'REJOIN_TIME', transform: (n) => n * 1000, allowZero: true, derived: true }],
  // Seconds upstream, milliseconds here, and it is the *basis* a reload is
  // derived from rather than the reload itself -- see `deriveShotReloadTime`.
  ['_reloadTime', { key: 'SHOT_LIFETIME', transform: (n) => n * 1000 }],
  ['_mGunAdVel', { key: 'MGUN_AD_VEL' }],
  ['_mGunAdRate', { key: 'MGUN_AD_RATE' }],
  ['_mGunAdLife', { key: 'MGUN_AD_LIFE' }],
  ['_laserAdVel', { key: 'LASER_AD_VEL' }],
  ['_laserAdRate', { key: 'LASER_AD_RATE' }],
  ['_laserAdLife', { key: 'LASER_AD_LIFE' }],
  ['_shockAdLife', { key: 'SHOCK_AD_LIFE' }],
  // A wave may start from nothing. Upstream's default is `_tankLength`.
  ['_shockInRadius', { key: 'SHOCK_IN_RADIUS', allowZero: true, derived: true }],
  ['_shockOutRadius', { key: 'SHOCK_OUT_RADIUS' }],
  ['_gmAdLife', { key: 'GM_AD_LIFE' }],
  ['_gmTurnAngle', { key: 'GM_TURN_ANGLE' }],
  // A missile that may hit the moment it leaves the barrel.
  ['_gmActivationTime', { key: 'GM_ACTIVATION_TIME', allowZero: true }],
  // How long the modelled missile is drawn.
  ['_gmSize', { key: 'GM_SIZE' }],
  // The cone a missile's lock is picked from, radians.
  ['_lockOnAngle', { key: 'LOCK_ON_ANGLE' }],
  // Dead reckoning: how far a heading may drift from the last move's
  // prediction before the client sends another.
  ['_angleTolerance', { key: 'ANGLE_TOLERANCE' }],
  // A grip on the ground: a cap on how fast a tank's velocity may change.
  ['_friction', { key: 'FRICTION', allowZero: true }],
  ['_momentumFriction', { key: 'MOMENTUM_FRICTION', allowZero: true }],
  ['_disableSpeedChecks', { key: 'DISABLE_SPEED_CHECKS', parse: bzdbIsTrue }],
  ['_hideTeamFlagsOnRadar', { key: 'HIDE_TEAM_FLAGS_ON_RADAR', parse: bzdbIsTrue }],
  ['_hideFlagsOnRadar', { key: 'HIDE_FLAGS_ON_RADAR', parse: bzdbIsTrue }],
  ['_forbidHunting', { key: 'FORBID_HUNTING', parse: bzdbIsTrue }],
  // No robots or autopilot, as `-disableBots` publishes it.
  ['_disableBots', { key: 'DISABLE_BOTS', parse: bzdbIsTrue }],
  ['_drawSky', { key: 'DRAW_SKY', parse: bzdbIsTrue }],
  ['_fogNoSky', { key: 'FOG_NO_SKY', parse: bzdbIsTrue }],
  // Always on in bzo -- a browser has no place of its own -- so read and kept.
  ['_syncLocation', { key: 'SYNC_LOCATION', parse: bzdbIsTrue }],
  ['_drawGroundLights', { key: 'DRAW_GROUND_LIGHTS', parse: bzdbIsTrue }],
  // How long a player may go unheard before it is marked not responding.
  ['_notRespondingTime', { key: 'NOT_RESPONDING_TIME' }],
  // How long a player's score waits for them to come back (allejo's
  // ScoreRestorer plugin, which many servers run).
  ['_scoreSaveTime', { key: 'SCORE_SAVE_TIME', allowZero: true }],
  // allejo's ctfOverseer plugin: no capturing a team's own flag, and a
  // captured team flag out of enemy reach for this many seconds.
  ['_disallowSelfCap', { key: 'DISALLOW_SELF_CAP', parse: bzdbIsTrue }],
  ['_delayTeamFlagGrab', { key: 'DELAY_TEAM_FLAG_GRAB', any: true }],
  // The width of a world the server generates (server/world-generator.cjs),
  // as upstream's generators read it. A map file's own `world size` wins.
  ['_worldSize', { key: 'WORLD_SIZE' }],
  // Read and kept, with nothing to steer. bzfs kicks a client that reports
  // more shot ends than this; a bzo client never reports one, the server
  // ending every shot itself.
  ['_endShotDetection', { key: 'END_SHOT_DETECTION' }],
  // Depth and leaf size of upstream's collision and cull octrees. bzo builds
  // neither, so these tune nothing.
  ['_coldetDepth', { key: 'COLDET_DEPTH' }],
  ['_coldetElements', { key: 'COLDET_ELEMENTS' }],
  ['_cullDepth', { key: 'CULL_DEPTH' }],
  // How far Identify reaches for the nearest flag on the ground.
  ['_identifyRange', { key: 'IDENTIFY_RANGE' }],
  ['_burrowSpeedAd', { key: 'BURROW_SPEED_AD' }],
  ['_burrowAngularAd', { key: 'BURROW_ANGULAR_AD' }],
  ['_rFireAdVel', { key: 'RFIRE_AD_VEL' }],
  ['_rFireAdRate', { key: 'RFIRE_AD_RATE' }],
  ['_rFireAdLife', { key: 'RFIRE_AD_LIFE' }],
  ['_thiefAdShotVel', { key: 'THIEF_AD_SHOT_VEL' }],
  ['_thiefAdRate', { key: 'THIEF_AD_RATE' }],
  ['_thiefAdLife', { key: 'THIEF_AD_LIFE' }],
  ['_thiefVelAd', { key: 'THIEF_VEL_AD' }],
  ['_thiefTinyFactor', { key: 'THIEF_TINY_FACTOR' }],
  // No wait to fire again after a theft is a real setting.
  ['_thiefDropTime', { key: 'THIEF_DROP_TIME', allowZero: true }],
  ['_velocityAd', { key: 'VELOCITY_AD' }],
  ['_angularAd', { key: 'ANGULAR_AD' }],
  ['_tinyFactor', { key: 'TINY_FACTOR' }],
  ['_obeseFactor', { key: 'OBESE_FACTOR' }],
  ['_narrowFactor', { key: 'NARROW_FACTOR' }],
  ['_agilityAdVel', { key: 'AGILITY_AD_VEL' }],
  ['_agilityTimeWindow', { key: 'AGILITY_TIME_WINDOW' }],
  ['_agilityVelDelta', { key: 'AGILITY_VEL_DELTA' }],
  ['_srRadiusMult', { key: 'SR_RADIUS_MULT' }],
  // A size or fade that happens at once.
  ['_flagEffectTime', { key: 'FLAG_EFFECT_TIME', allowZero: true }],
  // A landing that does not squash at all.
  ['_squishFactor', { key: 'SQUISH_FACTOR', allowZero: true }],
  ['_squishTime', { key: 'SQUISH_TIME' }],
  // A switch, read as BZDB.isTrue reads one.
  ['_noClimb', { key: 'NO_CLIMB', parse: bzdbIsTrue }],
  ['_drawMountains', { key: 'DRAW_MOUNTAINS', parse: bzdbIsTrue }],
  ['_drawClouds', { key: 'DRAW_CLOUDS', parse: bzdbIsTrue }],
  ['_drawCelestial', { key: 'DRAW_CELESTIAL', parse: bzdbIsTrue }],
  ['_drawGround', { key: 'DRAW_GROUND', parse: bzdbIsTrue }],
  ['_noShadows', { key: 'NO_SHADOWS', parse: bzdbIsTrue }],
  ['_trackFade', { key: 'TRACK_FADE', allowZero: true }],
  ['_radarLimit', { key: 'RADAR_LIMIT', any: true }],
  // Fog, as SceneRenderer::setupBackgroundMaterials reads it: any mode but
  // `none` is fog, and one that is not `linear` or `exp2` is `exp`
  // (SceneRenderer.cxx:1101). A colour that will not parse is upstream's 0.1
  // grey.
  ['_fogMode', { key: 'FOG_MODE', parse: parseFogMode }],
  ['_fogDensity', { key: 'FOG_DENSITY' }],
  ['_fogStart', { key: 'FOG_START', allowZero: true }],
  ['_fogEnd', { key: 'FOG_END' }],
  ['_fogColor', { key: 'FOG_COLOR', parse: (text) => (parseColorString(text) || [0.1, 0.1, 0.1]).slice(0, 3) }],
  ['_mirror', { key: 'MIRROR', parse: parseMirror }],
  ['_skyColor', { key: 'SKY_COLOR', parse: (text) => parseColorString(text)?.slice(0, 3) ?? null }],
  ['_syncTime', { key: 'SYNC_TIME', any: true }],
  ['_latitude', { key: 'LATITUDE', any: true }],
  ['_longitude', { key: 'LONGITUDE', any: true }],
  ['_tankLength', { key: 'TANK_LENGTH' }],
  ['_tankWidth', { key: 'TANK_WIDTH' }],
  ['_tankHeight', { key: 'TANK_HEIGHT' }],
  ['_tankRadius', { key: 'TANK_RADIUS', derived: true }],
  ['_muzzleHeight', { key: 'MUZZLE_HEIGHT' }],
  ['_muzzleFront', { key: 'MUZZLE_FRONT', derived: true }],
  ['_tankExplosionSize', { key: 'TANK_EXPLOSION_SIZE', derived: true }],
  ['_boxBase', { key: 'BOX_BASE' }],
  ['_boxHeight', { key: 'BOX_HEIGHT', derived: true }],
  ['_pyrBase', { key: 'PYR_BASE', derived: true }],
  ['_pyrHeight', { key: 'PYR_HEIGHT', derived: true }],
  // Wings' own. Upstream defaults the first two to the strings "_jumpVelocity"
  // and "_gravity"; a map that states a number pins it, as server.json does.
  ['_wingsJumpVelocity', { key: 'WINGS_JUMP_VELOCITY' }],
  ['_wingsGravity', { key: 'WINGS_GRAVITY', transform: Math.abs }],
  // Gliding with no slide at all is upstream's default.
  ['_wingsSlideTime', { key: 'WINGS_SLIDE_TIME', allowZero: true }],
  // A wall 0 high is a real choice -- 37 of the public servers make it -- so
  // zero is kept rather than read as unset.
  ['_wallHeight', { key: 'WALL_HEIGHT', allowZero: true, derived: true }],
]);

// What a world's BZDB says about the config: every physics variable it
// states, and those whose upstream default is a formula over ones it does --
// `_tankRadius` is `0.72 * _tankLength` -- so a world that changes one moves the
// rest with it. `vars` is the world's BZDB as names to raw strings: a map's
// `-set` lines, the server's own `/set`s, or a bzfs's whole table.
export function gameplayFromBzdb(vars) {
  const gameplay = {};
  const evalVar = (name) => evalBzdb(vars, name);
  const defaults = new Map();
  for (const [name, { key, transform, allowZero, parse, derived, any }] of BZDB_CONFIG_VARS) {
    let stated = vars.has(name);
    if (!stated && derived) {
      const value = evalVar(name);
      const fallback = evalBzdb(defaults, name);
      stated = Number.isFinite(value) && Number.isFinite(fallback) && Math.abs(value - fallback) > 1e-9;
    }
    if (!stated) continue;
    if (parse) {
      gameplay[key] = parse(String(vars.get(name) ?? BZDB_DEFAULTS[name] ?? ''));
      continue;
    }
    const num = evalVar(name);
    if (!Number.isFinite(num)) continue;
    const applied = transform ? transform(num) : num;
    // A switch is stated either way; a quantity only when positive, unless
    // it is one -- a longitude -- that may be anything.
    if (typeof applied === 'boolean' || applied > 0 || (allowZero && applied === 0) || any) {
      gameplay[key] = applied;
    }
  }
  return gameplay;
}

// The config a world plays by: `base` -- bzo's own defaults and the server's
// settings, with the game options upstream sends apart from BZDB (`-ms`,
// `-a`, jumping, ricochet) -- with the world's BZDB laid over it, and what
// those imply. A base that leaves `SHOT_RELOAD_TIME`, `WINGS_JUMP_VELOCITY` or
// `WINGS_GRAVITY` null has them derived, as upstream derives them; one that
// states them has pinned them.
export function worldConfig(base, vars) {
  const config = { ...base, ...gameplayFromBzdb(vars || new Map()) };
  config.SHOT_DISTANCE = config.SHOT_RANGE;
  // Wings' two are upstream's aliases, "_jumpVelocity" and "_gravity".
  if (!Number.isFinite(config.WINGS_JUMP_VELOCITY)) config.WINGS_JUMP_VELOCITY = config.JUMP_VELOCITY;
  if (!Number.isFinite(config.WINGS_GRAVITY)) config.WINGS_GRAVITY = config.GRAVITY;
  // A slot comes back after the shot basis over the shots allowed: `_reloadTime`
  // when the world states one, upstream's `_shotRange / _shotSpeed` when it does
  // not (ShotPath.cxx:48). No slots is no reload at all.
  if (config.SHOT_MAX_ACTIVE === 0) {
    config.SHOT_RELOAD_TIME = 0;
  } else if (!Number.isFinite(base.SHOT_RELOAD_TIME)) {
    const lifetimeMs = Number.isFinite(config.SHOT_LIFETIME) && config.SHOT_LIFETIME > 0
      ? config.SHOT_LIFETIME
      : (config.SHOT_RANGE / config.SHOT_SPEED) * 1000;
    config.SHOT_RELOAD_TIME = lifetimeMs / config.SHOT_MAX_ACTIVE;
  }
  config.SHOT_COOLDOWN = config.SHOT_RELOAD_TIME;
  return config;
}

// A BZDB as JSON carries it, names to strings, back into the Map the readers
// here take.
export function bzdbFromObject(object) {
  return new Map(Object.entries(object || {}).map(([name, value]) => [name, String(value)]));
}
