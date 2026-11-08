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
// own death the same way: the shots the shared bot game (`bot-game.mjs`)
// steps through the world, tested against the bot with the browser's
// `getShotTankHit`, and its flags.
//
// The page's first message is `{ world }`; after that, strings are game
// messages either way and objects are the port's open and close.

import { createBotGame, motionOf, TICK_SECONDS } from './bot-game.mjs';
import { DEFAULT_PILOT } from './autopilot.mjs';
import { ALL_PLAYERS, SERVER_PLAYER } from './player-ids.mjs';
import { getTeamColorIndex, isColorTeam } from './teams.mjs';
import { getInitialPlayerColor, getJoinPlayerColor, pickDistinctColor } from './player-colors.mjs';

const PLAYER_ID = '0';
const BOT_COUNT = 3;
// The tick's cap, when the page has been away.
const MAX_TICK_SECONDS = 0.25;
const TEAMS_THAT_PLAY = ['rogue', 'red', 'green', 'blue', 'purple'];

let world = null;
// Ace's level (`ACE_LEVELS`): Practice's choice, or his best.
let level = 'hard';
let config = null;
let game = null;
let player = null;
let human = null;
let nextShotSlot = 0;
let moveBatch = 0;
let lastTickAt = 0;

const send = (message) => self.postMessage(JSON.stringify(message));

const offlineLine = () => `Offline, against bots, on ${world.init.currentMap || 'the last map played'}.`
  + ' Reload to reconnect.';

function serverMessage(text) {
  send({ type: 'message', src: SERVER_PLAYER, dst: ALL_PLAYERS, msgType: 'server', text, ts: Date.now() });
}

function playingTeams() {
  const teams = (world.init.teamMode?.teams || []).filter((team) => TEAMS_THAT_PLAY.includes(team));
  return teams.length > 0 ? teams : ['rogue'];
}

// Rabbit Chase, where the server runs `-rabbit`: everybody hunts until the
// game makes them the rabbit.
const rabbitSelection = () => world.init.teamMode?.rabbitSelection || null;

// What `automatic` lands on: rogue where the map allows one, else the first
// team it does.
function pickTeam(asked) {
  if (rabbitSelection()) return asked === 'observer' ? asked : 'hunter';
  if (ctfTeams.length >= 2) return ctfTeams.includes(asked) || asked === 'observer' ? asked : ctfTeams[0];
  if (asked === 'observer' || playingTeams().includes(asked)) return asked;
  return playingTeams()[0];
}

// Capture the flag where the map has bases for two colour teams or more: the
// colour teams that have one. Empty otherwise, which is a free-for-all.
let ctfTeams = [];

// A free-for-all: each bot on a team of its own where the map has teams, rogue
// where it has rogues. Capture the flag: the player's team gets every other
// bot, and the rest go to the other teams in turn.
function pickBotTeam(index) {
  if (rabbitSelection()) return 'hunter';
  if (ctfTeams.length >= 2) {
    const mine = ctfTeams.includes(player.team) ? player.team : ctfTeams[0];
    const theirs = ctfTeams.filter((team) => team !== mine);
    return index % 2 === 1 ? mine : theirs[Math.floor(index / 2) % theirs.length];
  }
  const teams = playingTeams();
  if (teams.includes('rogue')) return 'rogue';
  const others = teams.filter((team) => team !== player.team);
  const from = others.length > 0 ? others : teams;
  return from[index % from.length];
}

const teamsAllowed = () => world.init.teamMode?.enabled !== false;

// --- The world ---------------------------------------------------------------

async function loadWorld() {
  const response = await fetch(world.init.world.url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const file = await response.json();
  ctfTeams = playingTeams().filter((team) => isColorTeam(team)
    && (file.obstacles || []).some((obs) => obs.kind === 'base' && obs.team === getTeamColorIndex(team)));
  if (ctfTeams.length < 2) ctfTeams = [];
  game = createBotGame({
    teamFlags: ctfTeams,
    rabbitSelection: rabbitSelection(),
    onRabbit: (newId, oldId) => {
      if (oldId === PLAYER_ID) player = { ...player, team: 'hunter' };
      if (newId === PLAYER_ID) player = { ...player, team: 'rabbit' };
    },
    onTeamCaptured: (team, killerId) => {
      if (player.team === team && player.alive && human) die({ type: 'killed', killerId, captured: true });
    },
    config,
    world: {
      obstacles: file.obstacles || [],
      mapSize: Number.isFinite(file.mapSize) ? file.mapSize : config.MAP_SIZE,
      noWalls: file.noWalls === true,
      wallHeight: config.WALL_HEIGHT,
      waterLevel: file.waterLevel?.height > 0 ? file.waterLevel.height : null,
      teleporterLinks: file.teleporterGraph?.links || [],
      safetyZones: file.safetyZones || [],
      flagZones: file.flagZones || [],
      spawnZones: file.spawnZones || [],
    },
    now: () => Date.now(),
    teamsAllowed: teamsAllowed(),
    others: () => (human && player.alive ? [{
      ...humanView(Date.now()), team: player.team, alive: true, score: player.wins - player.losses,
      wins: player.wins, losses: player.losses,
    }] : []),
    emit: (type, data) => {
      if (type === 'moves') {
        send({ type: 'pmBatch', n: ++moveBatch, moves: data });
        return;
      }
      if (type === 'killed' && data.shooterId === PLAYER_ID && data.victimId !== PLAYER_ID) player.wins += 1;
      send(data);
    },
    onError: (id, message) => console.error(`offline bot ${id}: ${message}`),
  });
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
    motd: offlineLine(),
  });
}

function join(message) {
  const team = pickTeam(message.team);
  const playing = team !== 'observer';
  player = {
    ...player,
    name: typeof message.name === 'string' && message.name ? message.name : player.name,
    team,
    color: getJoinPlayerColor(colorTeams(), team, player.team ?? null, colorPick(PLAYER_ID)) ?? player.color,
    alive: playing,
    // Before the map is in, somewhere to stand until it is (`loadWorld`).
    ...(playing ? (game ? game.pickSpawn(PLAYER_ID, team) : { x: 0, y: 0, z: 0, azimuth: 0 }) : {}),
  };
  human = playing ? { x: player.x, y: player.y, z: player.z, azimuth: player.azimuth, at: Date.now() } : null;
  send({ type: 'playerJoined', player });
  serverMessage(offlineLine());
  // The bots spawn clear of each other once the world is there to check.
  if (game && game.bots.size === 0) addBots();
}

// Each tank's colour by the server's rule: a shade of its team's in capture
// the flag, else one of its own off the whole wheel.
const colorTeams = () => ({ enabled: ctfTeams.length >= 2 });
function colorPick(id) {
  const others = [player, ...(game ? [...game.bots.values()].map((bot) => bot.record) : [])];
  return (team) => pickDistinctColor(team, others.filter((other) => other && other.id !== id));
}

function addBots() {
  for (let index = 0; index < BOT_COUNT; index++) {
    const id = String(index + 1);
    const team = pickBotTeam(index);
    const record = game.addBot(id, {
      ...player, name: `Ace${id}`, motto: 'Ace', team, clientType: 's',
      color: getInitialPlayerColor(colorTeams(), team, colorPick(id)),
    }, { pilotId: DEFAULT_PILOT, options: { level } });
    if (typeof record === 'string') {
      console.error(`offline bot ${id}: ${record}`);
      continue;
    }
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

// A death the client declared, or a self-destruct it asked for: the tank goes
// down, and comes back after the server's own respawn delay. A shell that
// stopped in it is spent.
function die(message) {
  if (!player.alive || message.reason === 'shielded') return;
  const selfDestruct = message.type === 'selfDestruct';
  const killerId = selfDestruct ? PLAYER_ID : (message.killerId ?? null);
  if (human) game?.drop(PLAYER_ID, humanView(Date.now()), true);
  player = { ...player, alive: false, losses: player.losses + 1 };
  if (typeof message.shotId === 'string' && game?.shots.has(message.shotId) && message.stoppedByHit !== false) {
    game.shots.delete(message.shotId);
  }
  send({
    type: 'killed',
    victimId: PLAYER_ID,
    shooterId: killerId,
    projectileId: message.shotId ?? null,
    reason: selfDestruct ? 'selfDestruct' : (message.reason || 'shot'),
    ...(message.captured ? { captured: true } : {}),
    deathMessage: message.deathMessage ?? null,
    phydrv: message.phydrv ?? null,
    victimFlag: null,
    shooterFlag: null,
    suicide: killerId === PLAYER_ID,
  });
  game?.noteKill(killerId, PLAYER_ID);
  setTimeout(() => {
    player = { ...player, alive: true, ...game.pickSpawn(PLAYER_ID, player.team) };
    human = { x: player.x, y: player.y, z: player.z, azimuth: player.azimuth, at: Date.now() };
    send({ type: 'alive', player });
  }, game ? game.respawnDelay() : 5000);
}

// --- The bots' tick --------------------------------------------------------------

// Where the player is now, by what they last said, as the server extrapolates.
function humanView(now) {
  const elapsed = (now - human.at) / 1000;
  const motion = motionOf(human, human.azimuth, config);
  return {
    id: PLAYER_ID,
    x: human.x + (motion.vx * elapsed),
    y: human.y + (motion.vy * elapsed),
    z: human.z,
    ...motion,
    gravity: config.GRAVITY,
  };
}

function tick() {
  const now = Date.now();
  const dt = lastTickAt ? Math.min((now - lastTickAt) / 1000, MAX_TICK_SECONDS) : TICK_SECONDS;
  lastTickAt = now;
  game.tick(dt);
}

self.onmessage = ({ data }) => {
  if (!world) {
    world = data.world;
    if (typeof data.level === 'string') level = data.level;
    open();
    loadWorld().then(() => {
      // Joined while the map loaded: on a team of the game it turned out to
      // be, and spawned properly now that it is here.
      if (human && player.alive) {
        if (ctfTeams.length >= 2 && !ctfTeams.includes(player.team)) {
          player = {
            ...player,
            team: ctfTeams[0],
            color: getJoinPlayerColor(colorTeams(), ctfTeams[0], player.team, colorPick(PLAYER_ID)) ?? player.color,
          };
          send({ type: 'playerUpdated', player });
        }
        player = { ...player, ...game.pickSpawn(PLAYER_ID, player.team) };
        human = { x: player.x, y: player.y, z: player.z, azimuth: player.azimuth, at: Date.now() };
        send({ type: 'alive', player });
      }
      game.announceFlags();
      if (ctfTeams.length >= 2) game.announceTeams();
      if (human && game.bots.size === 0) addBots();
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
  else if (message.type === 'shoot' && player.alive && game) {
    const slot = nextShotSlot;
    nextShotSlot = (nextShotSlot + 1) % game.maxShots();
    game.fire(PLAYER_ID, player.team, message, slot, game.flagOf(PLAYER_ID)?.type ?? null);
  } else if (message.type === 'grabFlag' && player.alive && game && human) {
    game.grab(PLAYER_ID, Number(message.index), humanView(Date.now()));
  } else if (message.type === 'dropFlag' && player.alive && game && human) {
    game.drop(PLAYER_ID, humanView(Date.now()));
  } else if (message.type === 'captureFlag' && player.alive && game) {
    game.capture(PLAYER_ID, player.team, Number(message.team));
  } else if (message.type === 'killed' || message.type === 'selfDestruct') die(message);
};
