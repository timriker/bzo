#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Where Ace gets stuck on a map: drives between seeded random spots on
// every surface, with the server bot's physics (`server/bots.cjs`) against
// the map's real obstacles, the way `bench-pilot.mjs` drives base to base.
// Each place he had to back off, missed a jump or never arrived is listed,
// grouped by spot, so a corner that catches him shows up as a count.
//
//   node scripts/bench-stuck.mjs                  # hix, 80 runs
//   node scripts/bench-stuck.mjs --map hix.bzw --runs 200 --seed 7
//   node scripts/bench-stuck.mjs --seed 3 --runs 15 --trace 14
//   node scripts/bench-stuck.mjs --flag V          # holding High Speed
//   node scripts/bench-stuck.mjs --flag WG --wings 2  # Wings, one flap
//   node scripts/bench-stuck.mjs --to 396,396,30   # always to one spot
//   node scripts/bench-stuck.mjs --from -315,-315,30 --to -311,-371,0
//
// The world is the server's cached conversion (`cache/map-index.json`), so a
// map has to have been served once. Nobody shoots, nobody else drives.

import fs from 'node:fs';
import path from 'node:path';
import { buildTeleporterIndex, createTankTeleporter } from '../public/teleport.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Ace } from '../public/autopilot.mjs';
import { createAsyncRouter, createRouter, createWorldProbes } from '../public/autopilot-world.mjs';
import { findShotSegmentImpact, findTankObstacle, getObstacleBase } from '../public/collision.mjs';

const require = createRequire(import.meta.url);
const { BotDriver } = require('../server/bots.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const mapName = args.get('map') || 'hix.bzw';
const timeLimit = Number(args.get('seconds') || 90);
// `--jumping off` drives as on a server without jumping: routes, and the lifts
// a map has instead, are all a tank has to change level by.
const jumping = args.get('jumping') !== 'off';
// `--flag V` drives holding that flag, for one that changes how the tank moves.
const heldFlag = args.get('flag') ? args.get('flag').toUpperCase() : null;
// `--to x,y,z` sends every run to that one spot, for a place `spot` does not
// reach or a flag that is hard to get to.
const fixedTo = args.get('to') ? (([x, y, z]) => ({ x, y, z: z || 0 }))(args.get('to').split(',').map(Number)) : null;
// `--flags x,y,z;x,y,z` lays more flags of unknown type beside the target, for
// a choice between flags that a lone one never offers.
const extraFlags = (args.get('flags') || '').split(';').filter(Boolean)
  .map((spec, i) => (([x, y, z]) => ({ index: i + 1, type: null, team: null, onGround: true, x, y, z: z || 0 }))(spec.split(',').map(Number)));
// `--from x,y,z` starts every run there, for a place a live game caught him.
const fixedFrom = args.get('from') ? (([x, y, z]) => ({ x, y, z: z || 0 }))(args.get('from').split(',').map(Number)) : null;
const dt = 0.05;

const index = JSON.parse(fs.readFileSync(path.join(root, 'cache/map-index.json'), 'utf8'));
const entry = index[mapName];
if (!entry) {
  console.error(`${mapName} is not in cache/map-index.json; serve it once first`);
  process.exit(1);
}
const world = JSON.parse(fs.readFileSync(path.join(root, `cache/maps/${entry.hash}.json`), 'utf8'));
const obstacles = world.obstacles;
const topOf = (obs) => ((obs.type === 'mesh' && obs.bounds) ? obs.bounds.maxZ : getObstacleBase(obs) + (obs.size?.[2] || 0));
const CONFIG = {
  TANK_SPEED: 25,
  TANK_ROTATION_SPEED: Math.PI / 4,
  GRAVITY: 9.8,
  JUMP_VELOCITY: 19,
  ALLOW_JUMPING: jumping,
  MAX_BUMP_HEIGHT: 0.33,
  // `_wingsJumpCount`: the take-off and each flap. Stock is 1; `--wings 2`
  // gives one flap, as bz.rikers.org's server.json does.
  WINGS_JUMP_COUNT: Number(args.get('wings') || 1),
  WINGS_JUMP_VELOCITY: 19,
  WINGS_GRAVITY: 9.8,
  // BZFlag's `-a <linear> <angular>`, off unless BENCH_ACCEL says otherwise.
  LINEAR_ACCELERATION: Number((process.env.BENCH_ACCEL || '0 0').split(' ')[0]) || 0,
  ANGULAR_ACCELERATION: Number((process.env.BENCH_ACCEL || '0 0').split(' ')[1]) || 0,
};
const probes = createWorldProbes({
  obstacles: () => obstacles,
  colliders: () => obstacles,
  mapSize: () => world.mapSize,
  findImpact: findShotSegmentImpact,
  topOf,
});
// One router for every run, so the graph and each base's field are built once.
const routerWorld = {
  obstacles,
  mapSize: world.mapSize,
  waterLevel: world.waterLevel?.height ?? null,
  teleporterLinks: world.teleporterGraph?.links || [],
  allowJumping: jumping,
  jump: { velocity: CONFIG.JUMP_VELOCITY, gravity: CONFIG.GRAVITY, tankSpeed: CONFIG.TANK_SPEED },
  wings: { velocity: CONFIG.WINGS_JUMP_VELOCITY, gravity: CONFIG.WINGS_GRAVITY, count: CONFIG.WINGS_JUMP_COUNT },
};
const findRoute = createRouter(() => routerWorld);
// `--route-frames N`: routes answered N frames after they are asked, through
// the browser's `createAsyncRouter`, as a worker answers a client's autopilot.
// 0 answers at once, as a server bot's router does.
const routeFrames = Number(args.get('route-frames') || 0);
const routeQueue = [];
const asyncRoute = routeFrames > 0 ? createAsyncRouter(() => routerWorld, (message) => {
  if (message.type === 'route') routeQueue.push({ message, due: routeFrames });
}) : null;
function answerRoutes() {
  for (const entry of routeQueue) entry.due--;
  while (routeQueue.length && routeQueue[0].due <= 0) {
    const { message } = routeQueue.shift();
    asyncRoute.receive({ id: message.id, nodes: findRoute(message.from, message.to, message.options) });
  }
}
const teleporterIndex = buildTeleporterIndex(obstacles, world.teleporterGraph?.links || []);

// A seeded spot on whatever surface is uppermost at a random point.
let seed = Number(args.get('seed') || 1);
const random = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const half = (world.mapSize || 800) / 2 - 10;
function spot() {
  for (;;) {
    const x = (random() * 2 - 1) * half;
    const y = (random() * 2 - 1) * half;
    const hit = probes.firstHit({ x, y, z: 200 }, { x, y, z: -0.1 });
    const z = hit ? Math.max(0, hit.z) : 0;
    // Room for a tank whichever way it faces, as a spawn would have.
    if ([0, 1, 2, 3].some((k) => findTankObstacle(obstacles, x, y, z + 0.01, { azimuth: k * Math.PI / 4 }))) continue;
    if (findRoute({ x: 0, y: 0, z: 0 }, { x, y, z })) return { x, y, z };
  }
}

function run(from, to, trace = false) {
  let now = 100;
  const pilot = new Ace();
  // The flag held, until the pilot drops it.
  let held = heldFlag;
  const teleporter = createTankTeleporter(() => teleporterIndex);
  const driver = new BotDriver({
    pilot,
    env: {
      config: () => CONFIG,
      flag: () => (held ? { type: held, zoned: false } : null),
      colliders: () => obstacles,
      topOf,
      teleport: (a, b) => teleporter(a, b, now * 1000),
      state: () => ({ alive: true, ...from, azimuth: random() * Math.PI * 2 }),
      view: (self) => ({
        now,
        self: {
          ...self, id: 'me', flag: held, flagIndex: null, flagTeam: null, teamColor: 0,
          zoned: false, shotSpeed: 100, shotLifetime: 3.5, ricochet: false, canFire: false,
        },
        players: [],
        shots: [],
        flags: [{ index: 0, type: null, team: null, onGround: true, ...to }, ...extraFlags],
        world: {
          allowJumping: jumping, teamFlags: false, waterLevel: null, shotSpeed: 100, maxShots: 1,
          tankHeight: 2.05, tankLength: 6, tankAngVel: CONFIG.TANK_ROTATION_SPEED,
          tankSpeed: CONFIG.TANK_SPEED, jumpVelocity: CONFIG.JUMP_VELOCITY, gravity: CONFIG.GRAVITY,
          lockOnAngle: 0.15, shockOutRadius: 60, shakeTimeout: 0,
        },
        isFoe: () => true,
        myBase: () => null,
        antidote: null,
        ...probes,
        findRoute: asyncRoute || findRoute,
      }),
      send: (message) => {
        if (message.type === 'dropFlag') held = null;
      },
      act: () => {},
    },
  });
  const events = [];
  let wasAir = false;
  let wasUnstick = false;
  let jumpTarget = null;
  for (let t = 0; t < timeLimit; t += dt) {
    now += dt;
    if (asyncRoute) answerRoutes();
    driver.tick(dt);
    const out = driver.lastOut;
    const at = { x: driver.x, y: driver.y, z: driver.z };
    const unstick = out?.intent?.mode === 'unstick';
    if (unstick && !wasUnstick) events.push({ kind: 'unstick', ...at, mode: pilot.lastMode });
    wasUnstick = unstick;
    if (!unstick) pilot.lastMode = out?.intent?.mode;
    if (trace && Math.round(t / dt) % 10 === 0) {
      const next = pilot.route?.nodes?.[pilot.route.at];
      console.log(`    t=${t.toFixed(1)} (${driver.x.toFixed(1)},${driver.y.toFixed(1)},${driver.z.toFixed(1)})`
        + ` az ${driver.azimuth.toFixed(2)} ${out?.intent?.mode} speed ${out?.speed?.toFixed(2)} turn ${out?.rotation?.toFixed(2)}`
        + (next ? ` next (${next.x},${next.y},${next.z})${next.jump ? ' jump' : ''}${next.flight ? ' flight' : ''}` : ''));
    }
    const air = driver.jumpDirection !== null;
    if (air && !wasAir && driver.vz > 10) {
      const node = pilot.route?.nodes?.[pilot.route.at];
      jumpTarget = node?.jump ? { z: node.z, from: at } : null;
    }
    if (!air && wasAir && jumpTarget) {
      if (Math.abs(driver.z - jumpTarget.z) > 0.5) events.push({ kind: 'missed jump', ...jumpTarget.from, to: jumpTarget.z });
      jumpTarget = null;
    }
    wasAir = air;
    // A burrowed tank is on the ground below it, at the burrow depth.
    if (Math.hypot(driver.x - to.x, driver.y - to.y) < 3 && Math.abs(Math.max(driver.z, 0) - to.z) < 0.5) {
      return { arrived: true, time: t, events };
    }
  }
  events.push({ kind: 'never arrived', x: driver.x, y: driver.y, z: driver.z });
  return { arrived: false, time: timeLimit, events };
}

const runs = Number(args.get('runs') || 80);
const all = [];
let arrived = 0;
let time = 0;
const baseSeed = seed;
for (let i = 0; i < runs; i++) {
  // Each run its own seed, so a change to Ace leaves every other trip as it
  // was and two runs of this compare trip for trip.
  seed = (baseSeed * 7919) + i;
  const from = fixedFrom || spot();
  const to = fixedTo || spot();
  // `--trace <run>`: that run's drive, every half second.
  const result = run(from, to, String(i) === args.get('trace'));
  if (result.arrived) arrived++;
  time += result.time;
  for (const event of result.events) all.push({ ...event, run: i, from, to });
}
console.log(`${mapName}: ${arrived}/${runs} arrived, ${(time / runs).toFixed(1)} s a run`);
const groups = new Map();
for (const e of all) {
  const key = `${e.kind} at (${Math.round(e.x / 10) * 10},${Math.round(e.y / 10) * 10},${Math.round(e.z)})`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(e);
}
for (const [key, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  const e = list[0];
  const why = e.kind === 'unstick' ? ` while ${[...new Set(list.map((x) => x.mode))].join('/')}` : '';
  console.log(`${String(list.length).padStart(4)}  ${key}${why}  e.g. run ${e.run}`
    + ` (${e.from.x.toFixed(0)},${e.from.y.toFixed(0)},${e.from.z.toFixed(0)})`
    + ` -> (${e.to.x.toFixed(0)},${e.to.y.toFixed(0)},${e.to.z.toFixed(0)})`);
}
