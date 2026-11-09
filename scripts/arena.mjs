#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Bots against bots, faster than real time: two sides on a map's first two
// team colours, each with its own pilot and tuning, playing team deathmatch
// on a clock of the script's own. The game is offline play's, shared with it
// (public/js/bot-game.mjs) -- the server's bot brain, shells stepped through
// the world, hits by the browser's own test -- with nobody in it. `--flags`
// superflags lie about the map, of every type but team flags.
//
//   node scripts/arena.mjs                                  # hix, Ace v Ace, 10 minutes
//   node scripts/arena.mjs --map hix.bzw --minutes 30 --size 4
//   node scripts/arena.mjs --a ace --b roger
//   node scripts/arena.mjs --tuning-b '{"raisedFactor":0.7}' --games 5
//   node scripts/arena.mjs --level-a easy --level-b normal   # practice levels
//   node scripts/arena.mjs --level-a easy --scale yes        # skill follows the score
//   node scripts/arena.mjs --flags 30                        # with superflags
//   node scripts/arena.mjs --ctf yes                         # capture the flag
//   node scripts/arena.mjs --map import-1vs1.catay.be_5157.bzw --ctf yes
//   node scripts/arena.mjs --map import-bmbz.org_5174.bzw    # rabbit chase, as it runs
//   node scripts/arena.mjs --rabbit killer                   # rabbit chase anywhere
//
// The world is what practice gets for the map from the running server
// (`/api/practice/<map>`, `--server`, http://localhost:5154 by default): any
// map it holds, bzfs imports included, with the shots, jumping, ricochet and
// flags it plays by. With no server answering, the server's cached conversion
// (data/cache/map-index.json) of a map it has served, by bzo's defaults.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBotGame, motionOf, TICK_SECONDS } from '../public/js/bot-game.mjs';
import { FLAG_ABBREVIATIONS, isTeamFlag } from '../public/js/flags.mjs';
import { getTeamFromColorIndex } from '../public/js/teams.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const mapName = args.get('map') || 'hix.bzw';
const minutes = Number(args.get('minutes') || 10);
const size = Number(args.get('size') || 3);
const games = Number(args.get('games') || 1);
const sides = ['a', 'b'].map((key) => ({
  key,
  pilot: args.get(key) || 'ace',
  tuning: args.get(`tuning-${key}`) ? JSON.parse(args.get(`tuning-${key}`)) : undefined,
  level: args.get(`level-${key}`) || undefined,
}));
// `--why yes`: each team kill told, with where the shot came from.
const why = args.get('why') === 'yes';
// `--scale yes`: skill moves with the score, as in play. Off by default, so a
// comparison is of each side at its level.
const scale = args.get('scale') === 'yes';
// `--ctf yes`: each side's team flag on its base, and captures.
const ctf = args.get('ctf') === 'yes';

const server = args.get('server') || 'http://localhost:5154';

// The practice answer for the map and its world, or null with no server.
async function fetchPractice() {
  try {
    const response = await fetch(`${server}/api/practice/${encodeURIComponent(mapName)}`);
    if (!response.ok) throw new Error(`${mapName}: HTTP ${response.status} from ${server}`);
    const practice = await response.json();
    const world = await fetch(new URL(practice.init.world.url, server));
    if (!world.ok) throw new Error(`${mapName}: world HTTP ${world.status}`);
    return { practice, file: await world.json() };
  } catch (error) {
    if (error.cause?.code !== 'ECONNREFUSED') throw error;
    return null;
  }
}

function readCached() {
  const index = JSON.parse(fs.readFileSync(path.join(root, 'data/cache/map-index.json'), 'utf8'));
  if (!index[mapName]) {
    console.error(`${mapName} is not in data/cache/map-index.json, and no server at ${server}`);
    process.exit(1);
  }
  return { practice: null, file: JSON.parse(fs.readFileSync(path.join(root, `data/cache/maps/${index[mapName].hash}.json`), 'utf8')) };
}

const { practice, file } = (await fetchPractice()) || readCached();
const mapConfig = practice?.init.config || {};
// `--rabbit score|killer|random`, or the server's own `-rabbit`: everybody a
// hunter but the rabbit, and each side's time and kills as the rabbit told.
const rabbit = args.has('rabbit') ? (args.get('rabbit') === 'no' ? null : args.get('rabbit'))
  : practice?.init.teamMode?.rabbitSelection || null;

// The server's defaults for what a bot game reads, under the map's own, under
// what the command line says.
const config = {
  MAP_SIZE: Number.isFinite(file.mapSize) ? file.mapSize : 800,
  TANK_SPEED: 25,
  TANK_ROTATION_SPEED: Math.PI / 4,
  REVERSE_SPEED_RATIO: 0.5,
  LINEAR_ACCELERATION: 0,
  ANGULAR_ACCELERATION: 0,
  SHOT_SPEED: 100,
  SHOT_RANGE: 350,
  SHOT_MAX_ACTIVE: 3,
  SHOT_RADIUS: 0.5,
  RESPAWN_DELAY: 5000,
  JUMP_VELOCITY: 19,
  GRAVITY: -9.8,
  ALLOW_JUMPING: true,
  MAX_BUMP_HEIGHT: 0.33,
  WALL_HEIGHT: 6.15,
  NO_TEAM_KILLS: false,
  ALL_SHOTS_RICOCHET: false,
  SUPER_FLAG_COUNT: 0,
  // Upstream's `-st` as most servers set it: a bad flag shakes off in 10s.
  FLAG_SHAKE_TIMEOUT: 100,
  SUPER_FLAG_POOL: FLAG_ABBREVIATIONS.filter((type) => !isTeamFlag(type)),
  ...mapConfig,
  ...(args.has('shots') ? { SHOT_MAX_ACTIVE: Number(args.get('shots')) } : {}),
  ...(args.has('jumping') ? { ALLOW_JUMPING: args.get('jumping') !== 'off' } : {}),
  ...(args.has('flags') ? { SUPER_FLAG_COUNT: Number(args.get('flags')) } : {}),
};
const shared = {
  obstacles: file.obstacles || [],
  mapSize: config.MAP_SIZE,
  noWalls: file.noWalls === true,
  wallHeight: config.WALL_HEIGHT,
  waterLevel: file.waterLevel?.height > 0 ? file.waterLevel.height : null,
  teleporterLinks: file.teleporterGraph?.links || [],
  safetyZones: file.safetyZones || [],
  flagZones: file.flagZones || [],
  spawnZones: file.spawnZones || [],
};
const colours = [...new Set(shared.obstacles.filter((obs) => obs.kind === 'base').map((obs) => obs.team))].sort();
const teams = colours.length >= 2 ? colours.slice(0, 2).map(getTeamFromColorIndex) : ['red', 'blue'];

let now = 0;
const zero = { kills: 0, deaths: 0, teamKills: 0, shots: 0, captures: 0, rabbits: 0, rabbitSeconds: 0, rabbitKills: 0 };

function play(game) {
  const score = Object.fromEntries(sides.map((side) => [side.key, { ...zero }]));
  const sideOf = new Map();
  let holder = null;
  let rabbitSince = 0;
  const arena = createBotGame({
    config,
    world: shared,
    now: () => now,
    teamFlags: ctf ? teams : [],
    rabbitSelection: rabbit,
    emit: (type, data, shot) => {
      if (type === 'shotBegin') score[sideOf.get(data.playerId)].shots++;
      if (type === 'captureFlag') score[sideOf.get(data.playerId)].captures++;
      if (type === 'newRabbit') {
        if (holder !== null) score[sideOf.get(holder)].rabbitSeconds += (now - rabbitSince) / 1000;
        holder = data.playerId;
        if (holder !== null) score[sideOf.get(holder)].rabbits++;
        rabbitSince = now;
      }
      // A capture kills the team that lost its flag and scores nobody.
      if (type !== 'killed' || data.captured) return;
      const victim = arena.bots.get(data.victimId);
      const killer = arena.bots.get(data.shooterId);
      score[sideOf.get(data.victimId)].deaths++;
      if (!killer || data.shooterId === data.victimId) return;
      // The rabbit's team is still rabbit here: the new one is anointed after.
      if (killer.record.team === 'rabbit') score[sideOf.get(data.shooterId)].rabbitKills++;
      if (killer.record.team !== victim.record.team) {
        score[sideOf.get(data.shooterId)].kills++;
        return;
      }
      // A deposed rabbit's shells are excused, as upstream excuses them.
      if (killer.record.wasRabbit) return;
      score[sideOf.get(data.shooterId)].teamKills++;
      if (why) tellTeamKill(arena, data, shot, victim);
    },
    onError: (id, message) => console.error(`bot ${id}: ${message}`),
  });
  sides.forEach((side, s) => {
    for (let n = 0; n < size; n++) {
      const id = `${game}-${side.key}${n}`;
      sideOf.set(id, side.key);
      const record = arena.addBot(id, { name: `${side.pilot}-${side.key}${n}`, team: rabbit ? 'hunter' : teams[s] }, {
        pilotId: side.pilot, options: { tuning: side.tuning, level: side.level, scale },
      });
      if (typeof record === 'string') throw new Error(record);
    }
  });
  // Where every tank was at each shot, for `--why`.
  const end = minutes * 60000;
  for (now = 0; now < end; now += TICK_SECONDS * 1000) {
    if (why) {
      for (const shot of arena.shots.values()) {
        if (shot.tanks) continue;
        shot.tanks = Object.fromEntries([...arena.bots].map(([id, bot]) => [id, {
          ...bot.record, ...motionOf(bot.motion, bot.record.azimuth, config),
        }]));
      }
    }
    arena.tick(TICK_SECONDS);
  }
  if (holder !== null) score[sideOf.get(holder)].rabbitSeconds += (now - rabbitSince) / 1000;
  arena.removeBots();
  return score;
}

// A team kill, as `--why` tells it: who fired at whom, from where, and where
// the victim was then.
function tellTeamKill(arena, data, shot, victim) {
  const at = (p) => `${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(1)}`;
  const then = shot?.tanks?.[data.victimId];
  const from = shot?.tanks?.[data.shooterId];
  console.log(`  team kill at ${(now / 1000).toFixed(1)}s: ${data.shooterId} shot ${data.victimId};`
    + ` fired ${((now - shot.firedAt) / 1000).toFixed(2)}s before${from ? ` from ${at(from)}` : ''}`
    + ` at ${shot.aimedAt ?? 'nobody'}, ${shot.bounces} bounce(s); victim at ${at(victim.record)}`
    + `${shot.mode ? `, shooter was ${from?.team ?? ''} ${shot.mode}` : ''}`);
  if (then) {
    console.log(`    when fired the victim was ${then.team} at ${at(then)}${then.airborne ? ' in the air' : ''}, moving`
      + ` ${then.vx.toFixed(1)},${then.vy.toFixed(1)}; shot heading ${Math.atan2(shot.dirY, shot.dirX).toFixed(2)}`);
  }
}

const label = (side) => `${side.pilot}${side.level ? ` ${side.level}` : ''}`
  + `${side.tuning ? ` ${JSON.stringify(side.tuning)}` : ''}`;
console.log(`${practice ? 'from the server' : 'from the cache'}: ${config.SHOT_MAX_ACTIVE} shots,`
  + ` jumping ${config.ALLOW_JUMPING ? 'on' : 'off'}, ricochet ${config.ALL_SHOTS_RICOCHET ? 'on' : 'off'},`
  + ` ${config.SUPER_FLAG_COUNT} superflags`);
console.log(`${mapName}: ${rabbit ? `rabbit chase (${rabbit}),` : ''} ${rabbit ? 'a' : teams[0]} ${label(sides[0])}`
  + ` v ${rabbit ? 'b' : teams[1]} ${label(sides[1])}, ${size} a side, ${games} game(s) of ${minutes} minutes`);
const total = Object.fromEntries(sides.map((side) => [side.key, { ...zero }]));
const started = Date.now();
for (let game = 1; game <= games; game++) {
  const score = play(game);
  for (const side of sides) for (const key of Object.keys(total[side.key])) total[side.key][key] += score[side.key][key];
  console.log(`game ${game}: ${sides.map((side) => `${side.key} ${score[side.key].kills}-${score[side.key].deaths}`).join(', ')}`);
}
const seconds = (Date.now() - started) / 1000;
for (const side of sides) {
  const t = total[side.key];
  console.log(`${side.key} ${label(side)}: kills ${t.kills}, deaths ${t.deaths}, k/d ${(t.kills / Math.max(1, t.deaths)).toFixed(2)},`
    + ` team kills ${t.teamKills}, shots ${t.shots}${ctf ? `, captures ${t.captures}` : ''}`
    + (rabbit ? `, rabbit ${t.rabbits} times for ${t.rabbitSeconds.toFixed(0)}s with ${t.rabbitKills} kills` : ''));
}
console.log(`${(games * minutes).toFixed(0)} game minutes in ${seconds.toFixed(0)}s, ${((games * minutes * 60) / seconds).toFixed(1)}x real time`);
