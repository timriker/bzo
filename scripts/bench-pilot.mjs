#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// How fast Ace gets around a map: from the centre of every team base to the
// centre of every other, flying his own capture route, with the server bot's
// physics (`server/bots.cjs`) against the map's real obstacles. Each driving
// strategy -- a set of `ACE_TUNING` values -- runs every pair, and the table
// says which arrives, how fast, and how often it fell or jumped on the way.
//
//   node scripts/bench-pilot.mjs                  # hix, every strategy below
//   node scripts/bench-pilot.mjs --map hix.bzw --only default,pursuit --detail 1
//   node scripts/bench-pilot.mjs --tuning '{"raisedFactor":0.7}'
//
// The world is the server's cached conversion (`cache/map-index.json`), so a
// map has to have been served once. Nobody shoots, nobody else drives: this
// measures getting there, and nothing else.

import fs from 'node:fs';
import path from 'node:path';
import { buildTeleporterIndex, createTankTeleporter } from '../public/teleport.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  Ace, ACE_TUNING, createRouter, createWorldProbes,
} from '../public/autopilot.mjs';
import { findShotSegmentImpact, getObstacleBase } from '../public/collision.mjs';

const require = createRequire(import.meta.url);
const { BotDriver } = require('../server/bots.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const mapName = args.get('map') || 'hix.bzw';
const timeLimit = Number(args.get('seconds') || 150);
// `--jumping off` drives as on a server without jumping: routes, and the lifts
// a map has instead, are all a tank has to change level by.
const jumping = args.get('jumping') !== 'off';
const dt = 0.05;

// The strategies compared, each a change from the defaults.
const STRATEGIES = {
  default: {},
  'lookahead 3': { groundLookahead: 3 },
  pursuit: { follow: 'pursuit' },
  arrival: { speed: 'arrival' },
  'pursuit+arrival': { follow: 'pursuit', speed: 'arrival' },
  'raised 0.7': { raisedFactor: 0.7 },
  'raised 1.0': { raisedFactor: 1 },
  curve: { raised: 'curve' },
  'curve 20': { raised: 'curve', cornerLookahead: 20 },
  'curve+pursuit': { raised: 'curve', follow: 'pursuit' },
};

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
const findRoute = createRouter(() => ({
  obstacles,
  mapSize: world.mapSize,
  waterLevel: world.waterLevel?.height ?? null,
  teleporterLinks: world.teleporterGraph?.links || [],
  allowJumping: jumping,
  jump: { velocity: CONFIG.JUMP_VELOCITY, gravity: CONFIG.GRAVITY, tankSpeed: CONFIG.TANK_SPEED },
}));
const teleporterIndex = buildTeleporterIndex(obstacles, world.teleporterGraph?.links || []);
const bases = obstacles.filter((obs) => obs.kind === 'base').sort((a, b) => a.team - b.team);
if (bases.length < 2) {
  console.error(`${mapName} has ${bases.length} team base(s); this needs two or more`);
  process.exit(1);
}

function run(tuning, from, to) {
  let now = 100;
  const pilot = new Ace({ tuning });
  const teleporter = createTankTeleporter(() => teleporterIndex);
  const start = { x: from.pos[0], y: from.pos[1], z: topOf(from) };
  const target = { x: to.pos[0], y: to.pos[1], z: topOf(to) };
  const driver = new BotDriver({
    pilot,
    env: {
      config: () => CONFIG,
      colliders: () => obstacles,
      topOf,
      teleport: (a, b) => teleporter(a, b, now * 1000),
      state: () => ({ alive: true, ...start, azimuth: Math.PI / 2 }),
      view: (self) => ({
        now,
        self: {
          ...self, id: 'me', flag: null, flagIndex: null, flagTeam: null, teamColor: from.team,
          zoned: false, shotSpeed: 100, shotLifetime: 3.5, ricochet: false, canFire: false,
        },
        players: [],
        shots: [],
        flags: [{ index: 0, type: 'X*', team: to.team, onGround: true, ...target }],
        world: {
          allowJumping: jumping, teamFlags: true, waterLevel: null, shotSpeed: 100, maxShots: 1,
          tankHeight: 2.05, tankLength: 6, tankAngVel: CONFIG.TANK_ROTATION_SPEED,
          tankSpeed: CONFIG.TANK_SPEED, jumpVelocity: CONFIG.JUMP_VELOCITY, gravity: CONFIG.GRAVITY,
          lockOnAngle: 0.15, shockOutRadius: 60, shakeTimeout: 0,
        },
        isFoe: () => true,
        myBase: () => ({ ...start, radius: Math.min(from.size[0], from.size[1]) }),
        antidote: null,
        ...probes,
        findRoute,
      }),
      send: () => {},
      act: () => {},
    },
  });
  const phases = { ground: 0, raised: 0, lineup: 0, air: 0, unstick: 0, idle: 0 };
  let jumps = 0;
  let falls = 0;
  // A jump that does not come down on the level it was for: hit the edge and
  // fell back, or fell short.
  let missed = 0;
  let jumpTarget = null;
  let flightAfter = null;
  let flightInfo = null;
  let wasAir = false;
  let travelled = 0;
  let last = { x: start.x, y: start.y };
  for (let t = 0; t < timeLimit; t += dt) {
    now += dt;
    driver.tick(dt);
    const out = driver.lastOut;
    const next = pilot.route?.nodes?.[pilot.route.at];
    if (driver.jumpDirection !== null) phases.air += dt;
    else if (out?.intent?.mode === 'unstick') phases.unstick += dt;
    else if (next?.jump || next?.bridge) phases.lineup += dt;
    else if (Math.abs(out?.speed || 0) < 0.05) {
      phases.idle += dt;
      if (process.env.BENCH_TRACE && Math.round(t / dt) % 10 === 0) {
        console.log(`    idle t=${t.toFixed(1)} at (${driver.x.toFixed(0)},${driver.y.toFixed(0)},${driver.z.toFixed(0)})`
          + ` turn=${out.rotation.toFixed(2)} mode=${out.intent.mode} next=${JSON.stringify(next)}`);
      }
    }
    else if (driver.z > 0.33) phases.raised += dt;
    else phases.ground += dt;
    if (process.env.BENCH_PATH && Math.round(t / dt) % 20 === 0) {
      console.log(`    t=${t.toFixed(0)} (${driver.x.toFixed(0)},${driver.y.toFixed(1)},${driver.z.toFixed(0)})`
        + ` ${out?.intent?.mode} next=${JSON.stringify(next)}`);
    }
    travelled += Math.hypot(driver.x - last.x, driver.y - last.y);
    last = { x: driver.x, y: driver.y };
    const air = driver.jumpDirection !== null;
    if (air && !wasAir) {
      const node = pilot.route?.nodes?.[pilot.route.at];
      flightAfter = node?.flight ? pilot.landingAim(pilot.route.nodes, pilot.route.at)
        : (pilot.route?.nodes?.[pilot.route.at] || null);
      flightInfo = node?.flight ? { t, a: driver.azimuth, w: driver.angVel, air: node.flight.air, jump: node.flight.jump,
        landing: node, from: { x: driver.x, y: driver.y } }
        : { t, a: driver.azimuth, w: driver.angVel, air: 0, jump: driver.vz > 10, unplanned: true,
          landing: node || { x: NaN, y: NaN }, from: { x: driver.x, y: driver.y }, z: driver.z };
      if (driver.vz > 10) {
        jumps++;
        const node = pilot.route?.nodes?.[pilot.route.at];
        jumpTarget = node?.jump ? node.z : null;
      } else falls++;
    }
    if (!air && wasAir && process.env.BENCH_FACING) {
      // How far the landing heading is from the way the route goes on.
      const next = flightAfter;
      flightAfter = null;
      if (next) {
        const want = Math.atan2(next.y - driver.y, next.x - driver.x);
        const off = Math.abs(((driver.azimuth - want + (3 * Math.PI)) % (2 * Math.PI)) - Math.PI);
        if (Math.hypot(next.x - driver.x, next.y - driver.y) > 2) {
          const fi = flightInfo;
          console.log(`    landed facing ${(off * 180 / Math.PI).toFixed(0)} deg off the route,`
            + ` at (${driver.x.toFixed(0)},${driver.y.toFixed(0)})`
            + (fi ? ` | ${fi.unplanned ? 'UNPLANNED ' : ''}${fi.jump ? 'jump' : 'drive-off'} planned air ${fi.air.toFixed(2)} actual ${(t - fi.t).toFixed(2)}`
              + ` a ${fi.a.toFixed(2)}->${driver.azimuth.toFixed(2)} w ${fi.w.toFixed(2)} want ${want.toFixed(2)}`
              + ` landing node (${fi.landing.x},${fi.landing.y}) after (${next.x},${next.y})`
              + ` from (${fi.from.x.toFixed(0)},${fi.from.y.toFixed(0)})` : ''));
        }
      }
    }
    if (!air && wasAir && jumpTarget !== null) {
      if (Math.abs(driver.z - jumpTarget) > 0.5) {
        missed++;
        if (process.env.BENCH_JUMPS) {
          console.log(`    missed jump to z=${jumpTarget} landed z=${driver.z.toFixed(1)} at (${driver.x.toFixed(0)},${driver.y.toFixed(0)})`);
        }
      }
      jumpTarget = null;
    }
    wasAir = air;
    const radius = Math.min(to.size[0], to.size[1]);
    if (Math.hypot(driver.x - target.x, driver.y - target.y) < radius && Math.abs(driver.z - target.z) < 0.5) {
      return { arrived: true, time: t, jumps, falls, missed, travelled, phases };
    }
  }
  return { arrived: false, time: timeLimit, jumps, falls, missed, travelled, phases };
}

const only = args.get('only') ? args.get('only').split(',') : null;
const strategies = args.get('tuning')
  ? { custom: JSON.parse(args.get('tuning')) }
  : Object.fromEntries(Object.entries(STRATEGIES).filter(([name]) => !only || only.includes(name)));

// `--pair 3-2`: one run, from team 3's base to team 2's.
const pairFilter = args.get('pair') ? args.get('pair').split('-').map(Number) : null;
const pairs = [];
for (const from of bases) {
  for (const to of bases) {
    if (from === to) continue;
    if (pairFilter && (from.team !== pairFilter[0] || to.team !== pairFilter[1])) continue;
    pairs.push([from, to]);
  }
}
console.log(`${mapName}: ${pairs.length} base-to-base runs per strategy, ${timeLimit}s limit`);
console.log('strategy           arrived  mean s  worst s  falls  jumps  missed  units');
for (const [name, change] of Object.entries(strategies)) {
  const tuning = { ...ACE_TUNING, ...change };
  const results = pairs.map(([from, to]) => run(tuning, from, to));
  const arrived = results.filter((r) => r.arrived);
  const mean = arrived.length ? arrived.reduce((sum, r) => sum + r.time, 0) / arrived.length : NaN;
  const worst = Math.max(...results.map((r) => r.time));
  const total = (key) => results.reduce((sum, r) => sum + r[key], 0);
  console.log(`${name.padEnd(18)} ${`${arrived.length}/${results.length}`.padStart(7)}`
    + `  ${mean.toFixed(1).padStart(6)}  ${worst.toFixed(1).padStart(7)}`
    + `  ${String(total('falls')).padStart(5)}  ${String(total('jumps')).padStart(5)}`
    + `  ${String(total('missed')).padStart(6)}`
    + `  ${total('travelled').toFixed(0).padStart(5)}`);
  if (args.get('detail')) {
    results.forEach((r, i) => {
      const [from, to] = pairs[i];
      const ph = Object.entries(r.phases).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(' ');
      console.log(`   team ${from.team}->${to.team} ${r.arrived ? 'ok ' : 'NO '}${r.time.toFixed(0).padStart(4)}s`
        + ` falls ${r.falls} jumps ${r.jumps} | ${ph}`);
    });
  }
}
