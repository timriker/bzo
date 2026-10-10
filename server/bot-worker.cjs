/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Every server bot's pilot and tank, off the server's own thread: a pilot
// planning a route across a big map takes tens of milliseconds, and the game
// on that thread stops for as long. The server starts this when it has a bot
// and ends it when it has none (`server.js`, "Server bots").
//
// What a bot sees comes in as one snapshot of the game a tick, the part every
// bot shares and the part that is each bot's own; what it does goes back as the
// messages its client would send, in order, split where the server makes a
// client's per-frame checks (`act`) so they land where they always did. The
// world itself -- obstacles, colliders, routes -- is held here, once for every
// bot.
//
// In:  world   { obstacles, mapSize, noWalls, wallHeight, waterLevel }
//      config  GAME_CONFIG, whenever it changes
//      add     { id, pilotId }       remove  { id }
//      tick    { dt, shared, bots: [own], followId, report }
//      halt    { bots: [own] } stop every tank where it is, and say so: sent
//              once a second while nobody is connected, as each bot's
//              heartbeat
// Out: results { bots: [{ id, pre, self, post, mode, targetId, intent?, report? }] }
//      error   { id, message }

const { parentPort } = require('worker_threads');
const { BotDriver } = require('./bots.cjs');
const {
  buildCollisionColliders,
  configureTankDimensions,
  findShotSegmentImpact,
  getObstacleBase,
} = require('./collision.cjs');
const { configureFlagEffects } = require('./flags.cjs');
const { areFoes } = require('./teams.cjs');

let autopilot = null;
let world = null;
let config = null;
let colliders = [];
let router = null;
let probes = null;
const bots = new Map();
const waiting = [];

// The same rule `getColliderTopY` in server.js answers by: a mesh's top is its
// bounds, everything else its base plus its height.
function topOf(obs) {
  if (obs?.type === 'mesh' && obs.bounds) return obs.bounds.maxZ;
  const height = obs?.size?.[2];
  return getObstacleBase(obs || {}) + (Number.isFinite(height) ? height : 0);
}

function setWorld(next) {
  world = next;
  colliders = buildCollisionColliders(world.obstacles, world.mapSize, world.noWalls, world.wallHeight);
  router = null;
  probes = null;
}

function getRouter() {
  if (!router) {
    router = autopilot.createRouter(() => ({
      obstacles: world.obstacles,
      mapSize: world.mapSize,
      waterLevel: world.waterLevel,
      jump: config.ALLOW_JUMPING
        ? { velocity: config.JUMP_VELOCITY, gravity: config.GRAVITY, tankSpeed: config.TANK_SPEED }
        : null,
    }));
  }
  return router;
}

function getProbes() {
  if (!probes) {
    probes = autopilot.createWorldProbes({
      obstacles: () => world.obstacles,
      colliders: () => colliders,
      mapSize: () => world.mapSize,
      findImpact: findShotSegmentImpact,
      topOf,
    });
  }
  return probes;
}

// The pilot's view, as `buildBotView` in server.js once built it in place:
// the shared snapshot less the bot itself and its own shots, with its own
// state laid over the tank's.
function buildView(bot, self, shared) {
  const own = bot.own;
  return {
    now: shared.now,
    self: { ...self, ...own.self },
    players: shared.players.filter((player) => player.id !== bot.id),
    shots: shared.shots.filter((shot) => shot.ownerId !== bot.id),
    flags: shared.flags,
    teamScores: shared.teamScores || {},
    world: shared.world,
    isFoe: (player) => areFoes(player.team, own.self.team, shared.teamsAllowed),
    myBase: () => {
      const base = world.obstacles.find((obs) => obs.kind === 'base' && obs.team === own.self.teamColor);
      if (!base) return null;
      return { x: base.pos[0], y: base.pos[1], z: topOf(base), radius: Math.min(base.size[0], base.size[1]) };
    },
    ...getProbes(),
    findRoute: getRouter(),
    antidote: own.antidote,
  };
}

function addBot({ id, pilotId }) {
  const entry = autopilot.AUTOPILOTS.find((candidate) => candidate.id === pilotId);
  if (!entry) {
    parentPort.postMessage({ type: 'error', id, message: `no pilot "${pilotId}"` });
    return;
  }
  const bot = { id, own: null, shared: null, sends: null, reportAt: 0 };
  bot.driver = new BotDriver({
    pilot: new entry.Pilot(),
    env: {
      config: () => config,
      colliders: () => colliders,
      topOf,
      state: () => bot.own.state,
      flag: () => bot.own.flag,
      view: (self) => buildView(bot, self, bot.shared),
      send: (message) => bot.sends.push(message),
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
}

// How often a pilot's own account of itself is asked for, which the server
// logs beside the kills and deaths it scored.
const REPORT_MS = 10000;

function tick({ dt, shared, bots: owns, followId }) {
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
      parentPort.postMessage({ type: 'error', id: bot.id, message: error.stack || error.message });
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
  parentPort.postMessage({ type: 'results', bots: out });
}

function halt({ bots: owns }) {
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
  parentPort.postMessage({ type: 'results', bots: out });
}

function handle(message) {
  switch (message.type) {
    case 'world': setWorld(message.world); break;
    case 'config':
      config = message.config;
      configureFlagEffects(config);
      configureTankDimensions(config);
      break;
    case 'add': addBot(message); break;
    case 'remove': bots.delete(message.id); break;
    case 'tick': tick(message); break;
    case 'halt': halt(message); break;
    default: break;
  }
}

parentPort.on('message', (message) => {
  if (autopilot) handle(message);
  else waiting.push(message);
});

import('../public/autopilot.mjs').then((module) => {
  autopilot = module;
  for (const message of waiting.splice(0)) handle(message);
}).catch((error) => {
  parentPort.postMessage({ type: 'error', id: null, message: `pilots did not load: ${error.message}` });
});
