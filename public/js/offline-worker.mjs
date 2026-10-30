/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Offline play: the page's game connection is a port to this Worker
// (`port-transport.mjs`), which answers it as a server would for a
// free-for-all against bots. The world is the last one the page played online,
// from what `saveOfflineWorld` in `client.js` kept of its `init`, and the map
// itself comes out of the service worker's cache.
//
// It decides as little as a bzfs does. The player's client traces every shot
// and declares its own deaths (`clientTracesShots`), as it does through the
// proxy. The bots are the server's own (`bot-host.mjs`), and each decides its
// own death the same way: the shots this Worker steps through the world, tested
// against the bot with the browser's `getShotTankHit`. No flags.
//
// The page's first message is `{ world }`; after that, strings are game
// messages either way and objects are the port's open and close.

import * as botHost from './bot-host.mjs';
import { DEFAULT_PILOT } from './autopilot.mjs';
import { TANK, buildCollisionColliders, traceShotStep } from './collision.mjs';
import { getFlagTuning, getShotEffects, shakeTimeoutSeconds } from './flags.mjs';
import { ALL_PLAYERS, SERVER_PLAYER } from './player-ids.mjs';
import { getShotTankHit, getWorldReloadSeconds, normalizeShotSlotCount } from './shots.mjs';
import { pickSpawnPosition, teamSpawnZones } from './spawn.mjs';
import { areFoes, getTeamColorIndex } from './teams.mjs';

const PLAYER_ID = '0';
const BOT_COUNT = 3;
// The server's own bot tick (`BOT_TICK_SECONDS` in server.js) and its cap.
const TICK_SECONDS = 0.05;
const MAX_TICK_SECONDS = 0.25;
const TEAMS_THAT_PLAY = ['rogue', 'red', 'green', 'blue', 'purple'];

let world = null;
let config = null;
let colliders = [];
let waterLevel = null;
let spawnZones = [];
let player = null;
let human = null;
let nextShotId = 0;
let nextShotSlot = 0;
let moveBatch = 0;
let lastTickAt = 0;
const bots = new Map();
const shots = new Map();
const pendingMoves = [];
const kills = [];

const send = (message) => self.postMessage(JSON.stringify(message));

function serverMessage(text) {
  send({ type: 'message', src: SERVER_PLAYER, dst: ALL_PLAYERS, msgType: 'server', text, ts: Date.now() });
}

// Where a tank spawns: the server's own search (public/js/spawn.mjs), against
// every other living tank here.
function pickSpawn({ id = null, team = null } = {}) {
  const others = [...bots].filter(([botId, bot]) => botId !== id && bot.record.alive)
    .map(([, bot]) => ({ ...bot.record, flag: null }));
  if (id !== PLAYER_ID && player?.alive && human) {
    others.push({ ...human, team: player.team, flag: null });
  }
  const spot = pickSpawnPosition({
    colliders,
    mapSize: Number(config.MAP_SIZE) || 800,
    waterLevel,
    zones: teamSpawnZones(spawnZones, getTeamColorIndex(team)),
    config,
    tanks: others,
    isFoe: (other) => areFoes(other.team, team, teamsAllowed()),
  });
  return { x: spot.x, y: spot.y, z: spot.z, azimuth: spot.azimuth };
}

function playingTeams() {
  const teams = (world.init.teamMode?.teams || []).filter((team) => TEAMS_THAT_PLAY.includes(team));
  return teams.length > 0 ? teams : ['rogue'];
}

// What `automatic` lands on: rogue where the map allows one, else the first
// team it does.
function pickTeam(asked) {
  if (asked === 'observer' || playingTeams().includes(asked)) return asked;
  return playingTeams()[0];
}

// A free-for-all: each bot on a team of its own where the map has teams, rogue
// where it has rogues.
function pickBotTeam(index) {
  const teams = playingTeams();
  if (teams.includes('rogue')) return 'rogue';
  const others = teams.filter((team) => team !== player.team);
  const from = others.length > 0 ? others : teams;
  return from[index % from.length];
}

const teamsAllowed = () => world.init.teamMode?.enabled !== false;
const shotLifetime = () => getWorldReloadSeconds(config) * getShotEffects(null).lifeFactor;
const maxShots = () => normalizeShotSlotCount(config.SHOT_MAX_ACTIVE);

// --- The world ---------------------------------------------------------------

async function loadWorld() {
  const response = await fetch(world.init.world.url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const file = await response.json();
  const shared = {
    obstacles: file.obstacles || [],
    mapSize: Number.isFinite(file.mapSize) ? file.mapSize : config.MAP_SIZE,
    noWalls: file.noWalls === true,
    wallHeight: config.WALL_HEIGHT,
    waterLevel: file.waterLevel?.height > 0 ? file.waterLevel.height : null,
    teleporterLinks: file.teleporterGraph?.links || [],
    safetyZones: file.safetyZones || [],
    flagZones: file.flagZones || [],
    spawnZones: file.spawnZones || [],
  };
  waterLevel = shared.waterLevel;
  spawnZones = shared.spawnZones;
  colliders = buildCollisionColliders(shared.obstacles, shared.mapSize, shared.noWalls, shared.wallHeight);
  botHost.setConfig(config);
  botHost.setWorld(shared);
  botHost.onError((id, message) => console.error(`offline bot ${id}: ${message}`));
}

// --- Players -------------------------------------------------------------------

function open() {
  const { init } = world;
  config = init.config;
  player = {
    ...init.player,
    id: PLAYER_ID,
    alive: false,
    paused: false,
    notResponding: false,
    autopilot: false,
    bot: false,
    wins: 0,
    losses: 0,
    tks: 0,
  };
  self.postMessage({ type: 'open' });
  send({
    ...init,
    type: 'init',
    player,
    players: [],
    flags: [],
    teamScores: [],
    rabbitId: null,
    timeLeft: null,
    gameOver: false,
    clientTracesShots: true,
    liveConfigKeys: [],
    operatorConfig: {},
    proxies: [],
    viewableMaps: [],
    title: `Offline: ${init.currentMap || 'last map'}`,
    motd: 'Offline, against bots, on the last map played. Reload to reconnect.',
  });
}

function join(message) {
  const team = pickTeam(message.team);
  const playing = team !== 'observer';
  player = {
    ...player,
    name: typeof message.name === 'string' && message.name ? message.name : player.name,
    team,
    alive: playing,
    ...(playing ? pickSpawn({ id: PLAYER_ID, team }) : {}),
  };
  human = playing ? { x: player.x, y: player.y, z: player.z, azimuth: player.azimuth, at: Date.now() } : null;
  send({ type: 'playerJoined', player });
  serverMessage('Offline, against bots, on the last map played. Reload to reconnect.');
  // The bots spawn clear of each other once the world is there to check.
  if (bots.size === 0 && colliders.length > 0) addBots();
}

function addBots() {
  for (let index = 0; index < BOT_COUNT; index++) {
    const id = String(index + 1);
    const team = pickBotTeam(index);
    const record = {
      ...player,
      id,
      name: `Ace${id}`,
      motto: 'Ace',
      team,
      bot: true,
      clientType: 's',
      alive: true,
      wins: 0,
      losses: 0,
      tks: 0,
      ...pickSpawn({ id, team }),
    };
    const error = botHost.addBot({ id, pilotId: DEFAULT_PILOT });
    if (error) {
      console.error(`offline bot ${id}: ${error}`);
      continue;
    }
    bots.set(id, { record, motion: null, slotFreeAt: [], respawnAt: null });
    send({ type: 'playerJoined', player: record });
  }
}

// The player's own move, which the bots see. Nothing goes back: there is no
// one else to tell.
function move(message) {
  if (!human) return;
  human = {
    x: Number(message.x) || 0,
    y: Number(message.y) || 0,
    z: Number(message.z) || 0,
    azimuth: Number(message.a) || 0,
    fs: Number(message.fs) || 0,
    vv: Number(message.vv) || 0,
    vx: Number(message.vx) || 0,
    vy: Number(message.vy) || 0,
    air: Number(message.air) === 1,
    at: Date.now(),
  };
}

// --- Shots ---------------------------------------------------------------------

function fire(ownerId, team, message) {
  const vx = Number(message.vx) || 0;
  const vy = Number(message.vy) || 0;
  const vz = Number(message.vz) || 0;
  const speed = Math.hypot(vx, vy, vz);
  if (speed === 0) return;
  const id = String(++nextShotId);
  const ricochet = config.ALL_SHOTS_RICOCHET === true;
  shots.set(id, {
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
    endsAt: Date.now() + (shotLifetime() * 1000),
  });
  let shotSlot;
  if (ownerId === PLAYER_ID) {
    shotSlot = nextShotSlot;
    nextShotSlot = (nextShotSlot + 1) % maxShots();
  } else {
    shotSlot = bots.get(ownerId).slotFreeAt.length % maxShots();
  }
  send({
    type: 'shotBegin',
    id,
    playerId: ownerId,
    shotSlot,
    x: Number(message.x) || 0,
    y: Number(message.y) || 0,
    z: Number(message.z) || 0,
    vx,
    vy,
    vz,
    flag: null,
    ricochet,
    team,
    target: null,
    createdAt: Date.now(),
  });
}

// Each shell one step on, through the world as `traceShotStep` bounces it, and
// against every bot it passes: a bot's own client, were it a browser, would
// find the same hit and declare the same death.
function stepShots(dt, now) {
  const rules = {
    noTeamKills: config.NO_TEAM_KILLS === true,
    teamsAllowed: teamsAllowed(),
    shotRadius: Number(config.SHOT_RADIUS) || 0.5,
  };
  for (const shot of [...shots.values()]) {
    if (now >= shot.endsAt) {
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
    });
    const to = { x: step.x, y: step.y, z: step.z };
    for (const [id, bot] of bots) {
      if (!bot.record.alive) continue;
      const hit = getShotTankHit(
        { playerId: shot.ownerId, flag: null, steals: false, bounces: shot.bounces, team: shot.team },
        from,
        to,
        { id, team: bot.record.team, alive: true, paused: false, position: bot.record, flagType: null, zoned: false },
        rules,
      );
      if (!hit) continue;
      shots.delete(shot.id);
      send({ type: 'shotEnd', id: shot.id, reason: 1, ...hit.point });
      killBot(id, shot.ownerId, shot.id);
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

// --- Deaths --------------------------------------------------------------------

function credit(killerId, victimId) {
  if (killerId === victimId || killerId === null || killerId === undefined) return;
  if (killerId === PLAYER_ID) player.wins += 1;
  else if (bots.has(killerId)) bots.get(killerId).record.wins += 1;
}

function killBot(id, killerId, shotId) {
  const bot = bots.get(id);
  bot.record = { ...bot.record, alive: false, losses: bot.record.losses + 1 };
  bot.respawnAt = Date.now() + respawnDelay();
  credit(killerId, id);
  kills.push({ killerId, victimId: id, at: Date.now() / 1000 });
  if (kills.length > 20) kills.shift();
  send({
    type: 'killed',
    victimId: id,
    shooterId: killerId,
    projectileId: shotId,
    reason: 'shot',
    deathMessage: null,
    phydrv: null,
    victimFlag: null,
    shooterFlag: null,
    suicide: killerId === id,
  });
}

function respawnDelay() {
  const delay = Number(config.RESPAWN_DELAY);
  return Number.isFinite(delay) ? delay : 5000;
}

// A death the client declared, or a self-destruct it asked for: the tank goes
// down, and comes back after the server's own respawn delay. A shell that
// stopped in it is spent.
function die(message) {
  if (!player.alive || message.reason === 'shielded') return;
  const selfDestruct = message.type === 'selfDestruct';
  const killerId = selfDestruct ? PLAYER_ID : (message.killerId ?? null);
  player = { ...player, alive: false, losses: player.losses + 1 };
  credit(killerId, PLAYER_ID);
  if (typeof message.shotId === 'string' && shots.has(message.shotId) && message.stoppedByHit !== false) {
    shots.delete(message.shotId);
  }
  kills.push({ killerId, victimId: PLAYER_ID, at: Date.now() / 1000 });
  send({
    type: 'killed',
    victimId: PLAYER_ID,
    shooterId: killerId,
    projectileId: message.shotId ?? null,
    reason: selfDestruct ? 'selfDestruct' : (message.reason || 'shot'),
    deathMessage: message.deathMessage ?? null,
    phydrv: message.phydrv ?? null,
    victimFlag: null,
    shooterFlag: null,
    suicide: killerId === PLAYER_ID,
  });
  setTimeout(() => {
    player = { ...player, alive: true, ...pickSpawn({ id: PLAYER_ID, team: player.team }) };
    human = { x: player.x, y: player.y, z: player.z, azimuth: player.azimuth, at: Date.now() };
    send({ type: 'alive', player });
  }, respawnDelay());
}

// --- The bots' tick --------------------------------------------------------------

// Where the player is now, by what they last said, as the server extrapolates.
function humanView(now) {
  const elapsed = (now - human.at) / 1000;
  const vx = human.air ? human.vx : Math.cos(human.azimuth) * human.fs * config.TANK_SPEED;
  const vy = human.air ? human.vy : Math.sin(human.azimuth) * human.fs * config.TANK_SPEED;
  return {
    id: PLAYER_ID,
    x: human.x + (vx * elapsed),
    y: human.y + (vy * elapsed),
    z: human.z,
    airborne: human.air === true,
    gravity: config.GRAVITY,
    vx,
    vy,
    vz: human.air ? human.vv : 0,
  };
}

// `botSharedView` in server.js, for a game with no flags in it.
function sharedView(now) {
  const players = [];
  if (human && player.alive) {
    players.push({
      ...humanView(now),
      team: player.team, alive: true, paused: false, notResponding: false,
      flag: null, flagIndex: null, flagTeam: null, zoned: false, score: player.wins - player.losses,
    });
  }
  for (const [id, bot] of bots) {
    const motion = bot.motion || {};
    players.push({
      id,
      x: bot.record.x,
      y: bot.record.y,
      z: bot.record.z,
      airborne: Boolean(motion.air),
      gravity: config.GRAVITY,
      vx: motion.vx ?? 0,
      vy: motion.vy ?? 0,
      vz: motion.vv ?? 0,
      team: bot.record.team,
      alive: bot.record.alive,
      paused: false,
      notResponding: false,
      flag: null,
      flagIndex: null,
      flagTeam: null,
      zoned: false,
      score: bot.record.wins - bot.record.losses,
    });
  }
  const viewShots = [...shots.values()].map((shot) => ({
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
  }));
  return {
    now: now / 1000,
    players,
    shots: viewShots,
    fired: [...shots.values()].map((shot) => ({ id: shot.id, ownerId: shot.ownerId })),
    kills,
    flags: [],
    teamsAllowed: teamsAllowed(),
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
function ownView(id, bot, now) {
  const free = bot.slotFreeAt.filter((at) => at > now).length;
  bot.slotFreeAt = bot.slotFreeAt.filter((at) => at > now);
  const r = bot.record;
  return {
    id,
    state: { alive: r.alive, x: r.x, y: r.y, z: r.z, azimuth: r.azimuth },
    flag: null,
    antidote: null,
    identified: null,
    self: {
      id,
      flag: null,
      flagIndex: null,
      flagTeam: null,
      teamColor: getTeamColorIndex(r.team),
      team: r.team,
      score: r.wins - r.losses,
      zoned: false,
      shotSpeed: config.SHOT_SPEED,
      shotLifetime: shotLifetime(),
      ricochet: config.ALL_SHOTS_RICOCHET === true,
      canFire: free < maxShots(),
      freeShots: maxShots() - free,
    },
  };
}

// What a bot's client sent this tick, as the server takes it from a browser.
function applyBotMessage(id, bot, message, now) {
  if (message.type === 'm') {
    bot.motion = message;
    bot.record = {
      ...bot.record, x: message.x, y: message.y, z: message.z, azimuth: message.a,
    };
    const pm = {
      id, x: message.x, y: message.y, z: message.z, a: message.a,
      fs: message.fs, rs: message.rs, vv: message.vv, vx: message.vx ?? 0, vy: message.vy ?? 0,
    };
    if (message.sd !== undefined) pm.sd = message.sd;
    pendingMoves.push(pm);
  } else if (message.type === 'shoot' && bot.record.alive) {
    if (bot.slotFreeAt.length >= maxShots()) return;
    bot.slotFreeAt.push(now + (shotLifetime() * 1000));
    fire(id, bot.record.team, message);
  }
}

function tick() {
  const now = Date.now();
  const dt = lastTickAt ? Math.min((now - lastTickAt) / 1000, MAX_TICK_SECONDS) : TICK_SECONDS;
  lastTickAt = now;
  stepShots(dt, now);
  for (const bot of bots.values()) {
    if (bot.record.alive || bot.respawnAt === null || now < bot.respawnAt) continue;
    bot.respawnAt = null;
    bot.record = { ...bot.record, alive: true, ...pickSpawn(bot.record) };
    bot.slotFreeAt = [];
    send({ type: 'alive', player: bot.record });
  }
  if (bots.size === 0) return;
  const results = botHost.tick({
    dt,
    shared: sharedView(now),
    bots: [...bots].map(([id, bot]) => ownView(id, bot, now)),
    followId: null,
  });
  for (const result of results) {
    const bot = bots.get(result.id);
    if (!bot) continue;
    for (const message of [...result.pre, ...result.post]) applyBotMessage(result.id, bot, message, now);
  }
  if (pendingMoves.length > 0) {
    send({ type: 'pmBatch', n: ++moveBatch, moves: pendingMoves.splice(0) });
  }
}

self.onmessage = ({ data }) => {
  if (!world) {
    world = data.world;
    open();
    loadWorld().then(() => {
      if (human && bots.size === 0) addBots();
      setInterval(tick, TICK_SECONDS * 1000);
    }).catch((error) => {
      console.error('offline world did not load', error);
      serverMessage('The map did not load, so there are no bots: free drive only.');
    });
    return;
  }
  if (typeof data !== 'string') {
    if (data?.type === 'close') self.close();
    return;
  }
  let message;
  try {
    message = JSON.parse(data);
  } catch {
    return;
  }
  if (message.type === 'joinGame') join(message);
  else if (message.type === 'm') move(message);
  else if (message.type === 'shoot' && player.alive) fire(PLAYER_ID, player.team, message);
  else if (message.type === 'killed' || message.type === 'selfDestruct') die(message);
};
