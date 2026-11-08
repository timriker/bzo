/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// A game of the server's own bots (`bot-host.mjs`) with no server: shells
// stepped through the world and tested against each bot with the browser's
// `getShotTankHit`, deaths and respawns, and each bot's view built as
// `botSharedView` and `botOwnView` in server.js build it. Offline play
// (`offline-worker.mjs`) runs it on the real clock with a person in it;
// `scripts/arena.mjs` runs it on its own, faster.
//
// Flags by the server's own rules where they are shared (`flag-spawn.mjs`,
// `flag-rules.mjs`, `flag-drop.mjs`): the config's `-s` superflags and `+f`
// flags, picked up by driving over them, dropped where they come to rest,
// and dropped by a tank that dies. Shells fly as plain shells whatever flag
// fired them. A bad flag shakes off after the config's time. No team flags,
// captures or antidotes yet.
//
// `others()` lists tanks the game does not run -- the person offline -- as
// the bots should see them and spawn clear of; their shots go in by `fire`.
// `emit(type, data)` hears what a client would be told: `shotBegin`,
// `shotEnd`, `killed`, `alive` and `moves`.

import * as botHost from './bot-host.mjs';
import { TANK, buildCollisionColliders, traceShotStep } from './collision.mjs';
import {
  BASE_SIZE, canShakeFlag, FLAG_ENDURANCE, FLAG_GRAB_INTERVAL_MS, FLAG_RADIUS, FLAG_STATUS, getFlagEndurance, getFlagTeamIndex,
  getFlagTuning, getShotEffects, shakeTimeoutSeconds, shieldsAgainstShot, stealsFlags,
} from './flags.mjs';
import { FLAG_DROP_TEST_RADIUS, findFlagLandingZ, findFlagRestZ, getColliderTopY, hasFlagClearance } from './flag-drop.mjs';
import { environmentAsk, flagState, mayGrab, takeFlag } from './flag-rules.mjs';
import { findFlagSpawnPosition, planFlagSlots } from './flag-spawn.mjs';
import { getShotTankHit, getWorldReloadSeconds, normalizeShotSlotCount } from './shots.mjs';
import { pickSpawnPosition, teamSpawnZones } from './spawn.mjs';
import { areFoes, getTeamColorIndex } from './teams.mjs';

// The server's own bot tick (`BOT_TICK_SECONDS` in server.js).
export const TICK_SECONDS = 0.05;
// How many kills each view carries, as the server keeps them.
const KILL_FEED = 20;

// A tank's motion as the server gives it to a bot (`getPlayerMotion` in
// server.js): in the air the velocity its move sent, on the ground its speed
// along its heading, which is all a move says there.
export function motionOf(move, azimuth, config) {
  const air = Number(move?.air) === 1 || move?.air === true;
  const speed = (Number(move?.fs) || 0) * config.TANK_SPEED;
  return {
    airborne: air,
    vx: air ? (Number(move.vx) || 0) : Math.cos(azimuth) * speed,
    vy: air ? (Number(move.vy) || 0) : Math.sin(azimuth) * speed,
    vz: air ? (Number(move.vv) || 0) : 0,
  };
}

// `world` is what `bot-host.setWorld` takes; `now()` the clock in ms.
export function createBotGame({
  config, world, now, teamsAllowed = true, others = () => [], emit = () => {}, onError = () => {},
}) {
  const colliders = buildCollisionColliders(world.obstacles, world.mapSize, world.noWalls, world.wallHeight);
  const bots = new Map();
  const shots = new Map();
  const kills = [];
  const pendingMoves = [];
  let nextShotId = 0;
  const shotLifetime = (flagType = null) => getWorldReloadSeconds(config) * getShotEffects(flagType).lifeFactor;
  const maxShots = () => normalizeShotSlotCount(config.SHOT_MAX_ACTIVE);
  const respawnDelay = () => {
    const delay = Number(config.RESPAWN_DELAY);
    return Number.isFinite(delay) ? delay : 5000;
  };

  // --- Flags ---
  const flags = [];
  const floorZ = world.waterLevel > 0 ? world.waterLevel : 0;
  const flagHeight = Number(config.FLAG_HEIGHT) || 0;
  const maxHeight = Math.max(0, ...colliders.filter((obs) => obs.collisionKind !== 'boundary').map(getColliderTopY));
  const flagOf = (id) => flags.find((flag) => flag.owner === id && flag.status === FLAG_STATUS.ON_TANK) || null;
  // Somewhere new for a flag on the ground, as the server spawns one.
  function placeFlag(flag) {
    const spot = findFlagSpawnPosition(flag, {
      mapSize: Number(config.MAP_SIZE) || 800,
      baseSize: BASE_SIZE,
      maxHeight,
      flagsOnBuildings: config.FLAGS_ON_BUILDINGS === true || floorZ > 0,
      landingZ: (x, y, z) => findFlagLandingZ(colliders, floorZ, x, y, z),
      clearance: (x, y, z) => hasFlagClearance(colliders, x, y, z, FLAG_DROP_TEST_RADIUS, flagHeight),
    }) || { x: 0, y: 0, z: floorZ };
    flag.position = spot;
    flag.owner = null;
    flag.status = FLAG_STATUS.ON_GROUND;
  }
  {
    const forbidden = config.FORBIDDEN_FLAGS || [];
    const pool = (config.SUPER_FLAG_POOL || []).filter((type) => !forbidden.includes(type));
    const { slots } = planFlagSlots({
      requiredCounts: config.REQUIRED_FLAGS || {},
      forbidden,
      superCount: pool.length > 0 ? Number(config.SUPER_FLAG_COUNT) || 0 : 0,
    });
    for (const slot of slots) {
      if (!slot.type) slot.type = pool[Math.floor(Math.random() * pool.length)];
      placeFlag(slot);
      flags.push(slot);
    }
  }
  const announceFlags = () => emit('flagUpdate', { type: 'flagUpdate', flags: flags.map((flag) => flagState(flag, now())) });

  // `id` takes a flag it is on (`grabFlag`): by the shared rules, from where
  // it is now.
  function grab(id, index, tank, alive = true) {
    const flag = flags[index];
    if (!flag) return false;
    if (!mayGrab({ observer: false, alive, paused: false, holding: Boolean(flagOf(id)), flag })) return false;
    if (Math.abs(tank.z - flag.position.z) < 1
      && Math.hypot(tank.x - flag.position.x, tank.y - flag.position.y) > (Number(config.TANK_SPEED) || 25) + TANK.radius + FLAG_RADIUS) {
      return false;
    }
    takeFlag(flag, id, now());
    emit('grabFlag', { type: 'grabFlag', playerId: id, flag: flagState(flag, now()) });
    return true;
  }

  // `id` lets go of its flag where `at` is: on whatever it comes to rest on,
  // or somewhere new when nothing will hold it. A sticky flag stays unless
  // the tank is dying (`forced`) or has held it long enough to shake it off
  // (`canShakeFlag`, the server's own test).
  function drop(id, at, forced = false) {
    const flag = flagOf(id);
    if (!flag) return false;
    const held = (now() - flag.grabbedAt) / 1000;
    if (!forced && getFlagEndurance(flag.type) === FLAG_ENDURANCE.STICKY
      && !canShakeFlag(flag.type, config.FLAG_SHAKE_TIMEOUT, held)) return false;
    const rest = findFlagRestZ(colliders, floorZ, at.x, at.y, at.z, flagHeight);
    if (rest === null) placeFlag(flag);
    else {
      flag.position = { x: at.x, y: at.y, z: rest };
      flag.owner = null;
      flag.status = FLAG_STATUS.ON_GROUND;
    }
    emit('dropFlag', { type: 'dropFlag', playerId: id, flag: flagState(flag, now()) });
    announceFlags();
    return true;
  }

  botHost.setClock(now);
  botHost.setConfig(config);
  botHost.setWorld(world);
  botHost.onError(onError);

  // Where a tank spawns: the server's own search, clear of every other
  // living tank.
  function pickSpawn(id, team) {
    const tanks = [...bots].filter(([other, bot]) => other !== id && bot.record.alive)
      .map(([, bot]) => ({ ...bot.record, flag: null }))
      .concat(others().filter((tank) => tank.id !== id && tank.alive).map((tank) => ({ ...tank, flag: null })));
    const spot = pickSpawnPosition({
      colliders,
      mapSize: Number(config.MAP_SIZE) || 800,
      waterLevel: world.waterLevel,
      zones: teamSpawnZones(world.spawnZones || [], getTeamColorIndex(team)),
      config,
      tanks,
      isFoe: (other) => areFoes(other.team, team, teamsAllowed),
    });
    return { x: spot.x, y: spot.y, z: spot.z, azimuth: spot.azimuth };
  }

  // A bot, joined and spawned: `record` its name, team and the rest a
  // player record carries; `options` its pilot's (Ace's `tuning`).
  function addBot(id, record, { pilotId, options } = {}) {
    const error = botHost.addBot({ id, pilotId, options });
    if (error) return error;
    const full = { ...record, id, bot: true, alive: true, wins: 0, losses: 0, tks: 0, ...pickSpawn(id, record.team) };
    bots.set(id, { record: full, motion: null, slotFreeAt: [], respawnAt: null, grabAt: 0 });
    return full;
  }

  function removeBots() {
    for (const id of bots.keys()) botHost.removeBot(id);
    bots.clear();
    shots.clear();
  }

  // A shell from `ownerId`, as a move's `shoot` describes it.
  function fire(ownerId, team, message, shotSlot = 0, flagType = null) {
    const vx = Number(message.vx) || 0;
    const vy = Number(message.vy) || 0;
    const vz = Number(message.vz) || 0;
    const speed = Math.hypot(vx, vy, vz);
    if (speed === 0) return null;
    const id = String(++nextShotId);
    const ricochet = config.ALL_SHOTS_RICOCHET === true;
    const shot = {
      id,
      ownerId,
      team,
      x: Number(message.x) || 0,
      y: Number(message.y) || 0,
      z: Number(message.z) || 0,
      dirX: vx / speed,
      dirY: vy / speed,
      dirZ: vz / speed,
      speed,
      ricochet,
      bounces: 0,
      // `_muzzleFront`, for the first step's wall test (`traceShotStep`).
      backtrack: TANK.muzzleFront,
      flag: flagType,
      firedAt: now(),
      endsAt: now() + (shotLifetime(flagType) * 1000),
    };
    shots.set(id, shot);
    emit('shotBegin', {
      type: 'shotBegin', id, playerId: ownerId, shotSlot, x: shot.x, y: shot.y, z: shot.z, vx, vy, vz,
      flag: flagType, ricochet, team, target: null, createdAt: now(),
    });
    return shot;
  }

  // A death's feed entry and score, for any tank: a team kill counts against
  // the killer as upstream's does.
  function noteKill(killerId, victimId) {
    kills.push({ killerId, victimId, at: now() / 1000 });
    if (kills.length > KILL_FEED) kills.shift();
    const killer = bots.get(killerId);
    if (!killer || killerId === victimId) return;
    killer.record.wins += 1;
  }

  function killBot(id, killerId, shot) {
    const bot = bots.get(id);
    drop(id, bot.record, true);
    bot.record = { ...bot.record, alive: false, losses: bot.record.losses + 1 };
    bot.respawnAt = now() + respawnDelay();
    noteKill(killerId, id);
    emit('killed', {
      type: 'killed',
      victimId: id,
      shooterId: killerId,
      projectileId: shot?.id ?? null,
      reason: 'shot',
      deathMessage: null,
      phydrv: null,
      victimFlag: null,
      shooterFlag: null,
      suicide: killerId === id,
    }, shot);
  }

  // Each shell one step on, through the world as `traceShotStep` bounces it,
  // and against every bot it passes: a bot's own client, were it a browser,
  // would find the same hit and declare the same death.
  function stepShots(dt) {
    const at = now();
    const rules = {
      noTeamKills: config.NO_TEAM_KILLS === true,
      teamsAllowed,
      shotRadius: Number(config.SHOT_RADIUS) || 0.5,
    };
    for (const shot of [...shots.values()]) {
      if (at >= shot.endsAt) {
        shots.delete(shot.id);
        continue;
      }
      const from = { x: shot.x, y: shot.y, z: shot.z };
      const step = traceShotStep({
        obstacles: colliders,
        x: shot.x,
        y: shot.y,
        z: shot.z,
        dirX: shot.dirX,
        dirY: shot.dirY,
        dirZ: shot.dirZ,
        distance: shot.speed * dt,
        radius: rules.shotRadius,
        ricochet: shot.ricochet,
        backtrack: shot.backtrack,
      });
      shot.backtrack = 0;
      const to = { x: step.x, y: step.y, z: step.z };
      for (const [id, bot] of bots) {
        if (!bot.record.alive) continue;
        const held = flagOf(id)?.type ?? null;
        const hit = getShotTankHit(
          { playerId: shot.ownerId, flag: shot.flag, steals: stealsFlags(shot.flag), bounces: shot.bounces, team: shot.team },
          from,
          to,
          { id, team: bot.record.team, alive: true, paused: false, position: bot.record, flagType: held, zoned: false },
          rules,
        );
        if (!hit) continue;
        shots.delete(shot.id);
        emit('shotEnd', { type: 'shotEnd', id: shot.id, reason: 1, ...hit.point });
        // Shield takes the hit and is gone; Thief takes the flag and
        // nothing else.
        if (stealsFlags(shot.flag)) {
          const stolen = flagOf(id);
          if (stolen && !flagOf(shot.ownerId)) {
            takeFlag(stolen, shot.ownerId, now());
            emit('grabFlag', { type: 'grabFlag', playerId: shot.ownerId, flag: flagState(stolen, now()) });
          }
        } else if (shieldsAgainstShot(held)) {
          drop(id, bot.record, true);
        } else {
          killBot(id, shot.ownerId, shot);
        }
        break;
      }
      if (!shots.has(shot.id)) continue;
      if (step.obstacle || step.ground) {
        shots.delete(shot.id);
        continue;
      }
      Object.assign(shot, to, {
        dirX: step.dirX, dirY: step.dirY, dirZ: step.dirZ, bounces: shot.bounces + step.bounces,
      });
    }
  }

  // `botSharedView` in server.js, for a game with no flags in it.
  function sharedView() {
    const at = now();
    const players = others().map((tank) => ({
      paused: false, notResponding: false, flag: null, flagIndex: null, flagTeam: null, zoned: false, ...tank,
    }));
    for (const [id, bot] of bots) {
      players.push({
        id,
        x: bot.record.x,
        y: bot.record.y,
        z: bot.record.z,
        ...motionOf(bot.motion, bot.record.azimuth, config),
        gravity: config.GRAVITY,
        team: bot.record.team,
        alive: bot.record.alive,
        paused: false,
        notResponding: false,
        ...(() => {
          const flag = flagOf(id);
          return { flag: flag?.type ?? null, flagIndex: flag?.index ?? null, flagTeam: getFlagTeamIndex(flag?.type ?? null) };
        })(),
        zoned: false,
        score: bot.record.wins - bot.record.losses,
      });
    }
    const flying = [...shots.values()];
    return {
      now: at / 1000,
      players,
      shots: flying.map((shot) => ({
        ownerId: shot.ownerId,
        ownerZoned: false,
        flag: null,
        x: shot.x,
        y: shot.y,
        z: shot.z,
        vx: shot.dirX * shot.speed,
        vy: shot.dirY * shot.speed,
        vz: shot.dirZ * shot.speed,
        bounces: shot.bounces,
      })),
      fired: flying.map((shot) => ({ id: shot.id, ownerId: shot.ownerId })),
      kills,
      flags: flags.map((flag) => {
        const state = flagState(flag, at);
        return {
          index: flag.index, type: state.type, team: getFlagTeamIndex(flag.type),
          onGround: flag.status === FLAG_STATUS.ON_GROUND, ...flag.position,
        };
      }),
      teamsAllowed,
      teamScores: {},
      world: {
        allowJumping: config.ALLOW_JUMPING === true,
        teamFlags: false,
        waterLevel: null,
        shotSpeed: config.SHOT_SPEED,
        maxShots: maxShots(),
        tankHeight: TANK.height,
        tankLength: TANK.halfLength * 2,
        tankAngVel: config.TANK_ROTATION_SPEED,
        tankSpeed: config.TANK_SPEED,
        shakeTimeout: shakeTimeoutSeconds(config.FLAG_SHAKE_TIMEOUT),
        jumpVelocity: config.JUMP_VELOCITY,
        gravity: config.GRAVITY,
        lockOnAngle: getFlagTuning().lockOnAngle,
        shotLimits: config.SHOT_LIMITS || {},
        mapSize: config.MAP_SIZE,
        shockOutRadius: getShotEffects('SW').shockOutRadius,
        noTeamKills: config.NO_TEAM_KILLS === true,
      },
    };
  }

  // `botOwnView` in server.js.
  function ownView(id, bot) {
    const at = now();
    bot.slotFreeAt = bot.slotFreeAt.filter((free) => free > at);
    const r = bot.record;
    const held = flagOf(id);
    return {
      id,
      state: { alive: r.alive, x: r.x, y: r.y, z: r.z, azimuth: r.azimuth },
      flag: held ? { type: held.type, zoned: false, index: held.index } : null,
      antidote: null,
      identified: null,
      self: {
        id,
        flag: held?.type ?? null,
        flagIndex: held?.index ?? null,
        flagTeam: getFlagTeamIndex(held?.type ?? null),
        teamColor: getTeamColorIndex(r.team),
        team: r.team,
        score: r.wins - r.losses,
        zoned: false,
        shotSpeed: config.SHOT_SPEED * getShotEffects(held?.type ?? null).velocityFactor,
        shotLifetime: shotLifetime(held?.type ?? null),
        ricochet: config.ALL_SHOTS_RICOCHET === true,
        canFire: bot.slotFreeAt.length < maxShots(),
        freeShots: maxShots() - bot.slotFreeAt.length,
      },
    };
  }

  // What a bot's client sent this tick, as the server takes it from a browser.
  function applyBotMessage(id, bot, message, result) {
    if (message.type === 'm') {
      bot.motion = message;
      bot.record = { ...bot.record, x: message.x, y: message.y, z: message.z, azimuth: message.a };
      const pm = {
        id, x: message.x, y: message.y, z: message.z, a: message.a,
        fs: message.fs, rs: message.rs, vv: message.vv, vx: message.vx ?? 0, vy: message.vy ?? 0,
      };
      if (message.sd !== undefined) pm.sd = message.sd;
      pendingMoves.push(pm);
    } else if (message.type === 'shoot' && bot.record.alive) {
      if (bot.slotFreeAt.length >= maxShots()) return;
      const slot = bot.slotFreeAt.length % maxShots();
      const held = flagOf(id)?.type ?? null;
      bot.slotFreeAt.push(now() + (shotLifetime(held) * 1000));
      const shot = fire(id, bot.record.team, message, slot, held);
      // Why it was fired, for whoever is looking into a shot after.
      if (shot) Object.assign(shot, { aimedAt: result.targetId ?? null, mode: result.mode });
    } else if (message.type === 'dropFlag' && bot.record.alive) {
      drop(id, bot.record);
    }
  }

  // One tick of `dt` seconds: shells on, the dead back after their wait, and
  // every bot's turn.
  function tick(dt) {
    const at = now();
    stepShots(dt);
    for (const [id, bot] of bots) {
      if (bot.record.alive || bot.respawnAt === null || at < bot.respawnAt) continue;
      bot.respawnAt = null;
      bot.record = { ...bot.record, alive: true, ...pickSpawn(id, bot.record.team) };
      bot.slotFreeAt = [];
      emit('alive', { type: 'alive', player: bot.record });
    }
    if (bots.size === 0) return;
    const results = botHost.tick({
      dt,
      shared: sharedView(),
      bots: [...bots].map(([id, bot]) => ownView(id, bot)),
      followId: null,
    });
    for (const result of results) {
      const bot = bots.get(result.id);
      if (!bot) continue;
      for (const message of [...result.pre, ...result.post]) applyBotMessage(result.id, bot, message, result);
      // The check a client makes for its own tank: driving over a flag.
      if (bot.record.alive && at - bot.grabAt >= FLAG_GRAB_INTERVAL_MS) {
        const ask = environmentAsk({
          self: { ...bot.record, inAir: Number(bot.motion?.air) === 1 },
          myTeam: getTeamColorIndex(bot.record.team),
          carriedType: flagOf(result.id)?.type ?? null,
          flags,
          baseTeamAt: () => null,
        });
        if (ask?.grab) {
          bot.grabAt = at;
          grab(result.id, ask.grab.index, bot.record);
        }
      }
    }
    if (pendingMoves.length > 0) emit('moves', pendingMoves.splice(0));
  }

  return {
    bots, shots, flags, colliders, addBot, removeBots, pickSpawn, fire, noteKill, tick, shotLifetime, maxShots,
    respawnDelay, grab, drop, flagOf, announceFlags,
  };
}
