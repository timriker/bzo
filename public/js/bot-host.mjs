/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Bots and the world they drive in, for whichever host runs them: the
// server's bot thread (`server/bot-worker.cjs`) and offline play
// (`offline-worker.mjs`). One host per module instance, since each runs in a
// worker of its own.
//
// What a bot sees comes in as one snapshot of the game a tick, the part every
// bot shares and the part that is each bot's own; what it does comes back as
// the messages its client would send, in order, split where the host makes a
// client's per-frame checks (`act`) so they land where they always did. The
// world itself -- obstacles, colliders, routes -- is held here, once for every
// bot.
//
//   setWorld({ obstacles, mapSize, noWalls, wallHeight, waterLevel, teleporterLinks, ...zones })
//   setConfig(GAME_CONFIG)
//   addBot({ id, pilotId })   -> an error message, or null
//   removeBot(id)
//   tick({ dt, shared, bots: [own], followId }) -> [{ id, pre, self, post, mode, targetId, intent?, report? }]
//   halt({ bots: [own] })     -> the same, each tank stopped where it is
//   onError(fn)               fn(id, message) for a bot whose tick threw

import * as autopilot from './autopilot.mjs';
import * as pilotWorld from './autopilot-world.mjs';
import { BotDriver } from './bot-driver.mjs';
import {
  buildCollisionColliders,
  configureTankDimensions,
  findShotSegmentImpact,
  getBaseTeamAtPoint,
  getObstacleBase,
} from './collision.mjs';
import { configureFlagEffects } from './flags.mjs';
import { areFoes } from './teams.mjs';
import { buildTeleporterIndex, createTankTeleporter } from './teleport.mjs';

let world = null;
let config = null;
let colliders = [];
let router = null;
let probes = null;
const bots = new Map();
let reportError = () => {};

export function onError(fn) {
  reportError = fn;
}

export function setConfig(next) {
  config = next;
  configureFlagEffects(config);
  configureTankDimensions(config);
}

export function removeBot(id) {
  bots.delete(id);
}

// The same rule `getColliderTopY` in server.js answers by: a mesh's top is its
// bounds, everything else its base plus its height.
function topOf(obs) {
  if (obs?.type === 'mesh' && obs.bounds) return obs.bounds.maxZ;
  const height = obs?.size?.[2];
  return getObstacleBase(obs || {}) + (Number.isFinite(height) ? height : 0);
}

export function setWorld(next) {
  world = next;
  colliders = buildCollisionColliders(world.obstacles, world.mapSize, world.noWalls, world.wallHeight);
  router = null;
  probes = null;
  bases = null;
  baseObstacles = null;
  vantages = null;
  teleporterIndex = null;
}

// The world's teleporters and where each face sends, for every bot's own
// crossing of them.
let teleporterIndex = null;
function getTeleporterIndex() {
  if (!teleporterIndex) teleporterIndex = buildTeleporterIndex(world.obstacles, world.teleporterLinks || []);
  return teleporterIndex;
}

let vantages = null;
function getVantages() {
  if (!vantages) vantages = pilotWorld.findVantagePoints(world.obstacles, topOf);
  return vantages;
}

// The bases alone, so a bot asking every tick where it stands walks four
// obstacles rather than the map.
let baseObstacles = null;
function getBaseObstacles() {
  if (!baseObstacles) baseObstacles = world.obstacles.filter((obs) => obs.kind === 'base');
  return baseObstacles;
}

let bases = null;
function getBases() {
  if (!bases) bases = pilotWorld.teamBasesOf(world.obstacles, topOf);
  return bases;
}

function getRouter() {
  if (!router) {
    router = pilotWorld.createRouter(() => ({
      obstacles: world.obstacles,
      mapSize: world.mapSize,
      waterLevel: world.waterLevel,
      teleporterLinks: world.teleporterLinks || [],
      // The jump itself always, for a tank whose flag lets it jump where the
      // world does not; whether this one may is the pilot's to say.
      allowJumping: config.ALLOW_JUMPING === true,
      jump: { velocity: config.JUMP_VELOCITY, gravity: config.GRAVITY, tankSpeed: config.TANK_SPEED },
      wings: { velocity: config.WINGS_JUMP_VELOCITY, gravity: config.WINGS_GRAVITY, count: config.WINGS_JUMP_COUNT },
    }));
  }
  return router;
}

function getProbes() {
  if (!probes) {
    probes = pilotWorld.createWorldProbes({
      obstacles: () => world.obstacles,
      colliders: () => colliders,
      mapSize: () => world.mapSize,
      findImpact: findShotSegmentImpact,
      topOf,
      teleports: getTeleporterIndex,
    });
  }
  return probes;
}

// The pilot's view, as `buildBotView` in server.js once built it in place:
// the shared snapshot less the bot itself and its own shots but those that
// have bounced, the only ones that can hit it, with its own state laid over
// the tank's.
function buildView(bot, self, shared) {
  const own = bot.own;
  return {
    now: shared.now,
    self: { ...self, ...own.self },
    players: shared.players.filter((player) => player.id !== bot.id),
    shots: shared.shots.filter((shot) => shot.ownerId !== bot.id || shot.bounces > 0),
    fired: (shared.fired || []).filter((shot) => shot.ownerId !== bot.id),
    kills: shared.kills || [],
    // The one its Identify names comes with its type.
    flags: own.identified
      ? shared.flags.map((flag) => (flag.index === own.identified.index ? { ...flag, type: own.identified.type } : flag))
      : shared.flags,
    teamScores: shared.teamScores || {},
    world: shared.world,
    isFoe: (player) => areFoes(player.team, own.self.team, shared.teamsAllowed),
    myBase: () => {
      const base = world.obstacles.find((obs) => obs.kind === 'base' && obs.team === own.self.teamColor);
      if (!base) return null;
      return { x: base.pos[0], y: base.pos[1], z: topOf(base), radius: Math.min(base.size[0], base.size[1]) };
    },
    bases: getBases(),
    vantages: getVantages(),
    safetyZones: world.safetyZones || [],
    flagZones: world.flagZones || [],
    spawnZones: world.spawnZones || [],
    ...getProbes(),
    findRoute: getRouter(),
    antidote: own.antidote,
  };
}

export function addBot({ id, pilotId }) {
  const entry = autopilot.AUTOPILOTS.find((candidate) => candidate.id === pilotId);
  if (!entry) return `no pilot "${pilotId}"`;
  const bot = { id, own: null, shared: null, sends: null, reportAt: 0 };
  const teleporter = createTankTeleporter(getTeleporterIndex);
  bot.driver = new BotDriver({
    pilot: new entry.Pilot(),
    env: {
      config: () => config,
      colliders: () => colliders,
      topOf,
      teleport: (from, to) => teleporter(from, to, Date.now()),
      state: () => bot.own.state,
      flag: () => bot.own.flag,
      view: (self) => buildView(bot, self, bot.shared),
      send: (message) => bot.sends.push(message),
      baseAt: (x, y, z) => getBaseTeamAtPoint(getBaseObstacles(), x, y, z),
      // The server makes these checks itself, with the tank where this tick
      // left it: everything sent so far goes before them, the rest after.
      act: (self) => {
        bot.self = self;
        bot.pre = bot.sends;
        bot.sends = [];
      },
    },
  });
  bots.set(id, bot);
  return null;
}

// How often a pilot's own account of itself is asked for, which the server
// logs beside the kills and deaths it scored.
const REPORT_MS = 10000;

export function tick({ dt, shared, bots: owns, followId }) {
  const now = Date.now();
  const out = [];
  for (const own of owns) {
    const bot = bots.get(own.id);
    if (!bot) continue;
    bot.own = own;
    bot.shared = shared;
    bot.sends = [];
    bot.pre = null;
    bot.self = null;
    try {
      bot.driver.tick(dt);
    } catch (error) {
      reportError(bot.id, error.stack || error.message);
    }
    const result = {
      id: bot.id,
      pre: bot.pre ?? bot.sends,
      self: bot.self,
      post: bot.pre ? bot.sends : [],
      mode: bot.driver.lastOut?.intent?.mode ?? null,
      reason: bot.driver.lastOut?.intent?.reason ?? null,
      targetId: bot.driver.lastOut?.targetId ?? null,
    };
    if (bot.id === followId && bot.driver.lastOut) result.intent = bot.driver.lastOut.intent;
    if (now >= bot.reportAt) {
      // The first report covers only the moments since the bot joined, and
      // is not worth a line.
      const report = bot.driver.pilot.takeReport();
      if (bot.reportAt !== 0) result.report = report;
      bot.reportAt = now + REPORT_MS;
    }
    out.push(result);
  }
  return out;
}

export function halt({ bots: owns }) {
  const out = [];
  for (const own of owns) {
    const bot = bots.get(own.id);
    if (!bot) continue;
    bot.own = own;
    bot.sends = [];
    // A bot that has not ticked since it joined -- the server came up with
    // nobody on it -- stands where the server put it.
    if (!bot.driver.alive && own.state.alive) {
      bot.driver.alive = true;
      bot.driver.respawn(own.state);
    } else if (!own.state.alive) {
      bot.driver.alive = false;
    }
    bot.driver.halt();
    out.push({ id: bot.id, pre: bot.sends, self: null, post: [], mode: null, targetId: null });
  }
  return out;
}
