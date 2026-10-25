/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The world as a pilot asks about it: routes over it (`createRouter`, and
// `createAsyncRouter` for one worked out in a worker), the probes a pilot's
// view carries, and the team bases and vantage points read from it. Nothing
// here decides anything -- `autopilot.mjs` does -- so a route worker loads
// this without either pilot.

import {
  getShotObstacleNormal, reflectShotDirection, SHOT_BOUNCE_CLEARANCE, SHOT_COLLISION_RADIUS, traceShotStep,
} from './collision.mjs';
import { buildNavGraph } from './nav.mjs';
import { getShotTeleporterCrossing, getShotTeleporterFrameHit } from './teleport.mjs';
import { traceShotThroughTeleporters } from './trace.mjs';

// The surface a tank drives on. A burrowed tank is below it, and a probe cast
// from down there passes under every obstacle, all of which start at 0 or
// above: he would see open ground through a wall and drive into it.
export function surfaceZ(z) {
  return Math.max(z, 0);
}

// How near its destination a route counts as the same route.
export const ROUTE_DEST_SLACK = 8;

// The view's four probes, against the solids a shot meets and the world's
// walls -- upstream's walls are obstacles and bzo's are not. Built from
// whichever world the caller holds, so the client and a server-run bot ask the
// same questions the same way. `findImpact` is the `collision` pair's
// `findShotSegmentImpact`; `topOf` an obstacle's top height.
const PROBE_RANGE = 1000;

// `colliders` is every solid a shot bounces off, the world's walls included,
// for `traceShot`.
const TRACE_STEP_SECONDS = 1 / 30;

// How far past a bounce `traceLegs` starts the next leg's trace.
const BANK_LEG_CLEAR = 1;

// Every team base, as a pilot's view carries them: centre, top, half extents
// and rotation, read from the world every client downloads.
export function teamBasesOf(obstacles, topOf) {
  return obstacles.filter((obs) => obs.kind === 'base' && Number.isInteger(obs.team)).map((obs) => ({
    team: obs.team,
    x: obs.pos[0],
    y: obs.pos[1],
    z: topOf(obs),
    halfWidth: obs.size[0],
    halfDepth: obs.size[1],
    rotation: obs.angle || 0,
  }));
}

// The flat tops a tank can stand on and shoot from: every box but a base,
// highest first, as a pilot's view carries them.
export function findVantagePoints(obstacles, topOf, { minHeight = 3, minHalfSize = 3, limit = 200 } = {}) {
  return obstacles
    .filter((obs) => obs.type === 'box' && obs.kind !== 'base' && !obs.driveThrough
      && Array.isArray(obs.size) && Math.min(obs.size[0], obs.size[1]) >= minHalfSize)
    .map((obs) => ({ x: obs.pos[0], y: obs.pos[1], z: topOf(obs) }))
    .filter((spot) => spot.z >= minHeight)
    .sort((a, b) => b.z - a.z)
    .slice(0, limit);
}

export function createWorldProbes({
  obstacles, colliders, mapSize, findImpact, topOf, teleports = () => null,
}) {
  const rayFraction = (from, to) => {
    const impact = findImpact(obstacles(), from, to, 0);
    let fraction = impact ? impact.fraction : 1;
    const half = mapSize() / 2;
    for (const axis of ['x', 'y']) {
      const delta = to[axis] - from[axis];
      if (delta > 0 && to[axis] > half) fraction = Math.min(fraction, (half - from[axis]) / delta);
      if (delta < 0 && to[axis] < -half) fraction = Math.min(fraction, (-half - from[axis]) / delta);
    }
    return { fraction: Math.max(0, fraction), obstacle: impact ? impact.obstacle : null, hit: fraction < 1 };
  };
  const ray = (pos, azimuth, range) => {
    const from = { x: pos.x, y: pos.y, z: surfaceZ(pos.z) + 0.1 };
    const to = {
      x: from.x + (Math.cos(azimuth) * range),
      y: from.y + (Math.sin(azimuth) * range),
      z: from.z,
    };
    return rayFraction(from, to);
  };
  return {
    openDistance: (pos, azimuth) => {
      const hit = ray(pos, azimuth, PROBE_RANGE);
      return hit.hit ? hit.fraction * PROBE_RANGE : Infinity;
    },
    isObscured: (from, to) => rayFraction(from, to).hit,
    // Whether a teleporter is in the way of a drive from one point to the
    // other: sent through its doorway, or into the frame round it. A ray
    // reads both as open air, so a lane that is clear can still be a lift.
    teleporterInWay: (from, to) => obstacles().some((obs) => obs.kind === 'teleporter'
      && (getShotTeleporterCrossing(from, to, obs) !== null || getShotTeleporterFrameHit(from, to, obs) !== null)),
    firstHit: (from, to) => {
      const hit = rayFraction(from, to);
      if (!hit.hit) return null;
      return {
        x: from.x + ((to.x - from.x) * hit.fraction),
        y: from.y + ((to.y - from.y) * hit.fraction),
        z: from.z + ((to.z - from.z) * hit.fraction),
      };
    },
    firstBuilding: (pos, azimuth, range) => {
      if (!(range > 0)) return null;
      const hit = ray(pos, azimuth, range);
      if (!hit.obstacle) return null;
      return {
        isBox: hit.obstacle.type === 'box',
        top: topOf(hit.obstacle),
        distance: hit.fraction * range,
      };
    },
    // Where a shot goes over its life, bounces and all, by the tracer the
    // shot itself is flown with: a list of `{ t0, t1, from, to }`, seconds
    // after firing. Teleporters are not followed.
    // A level shot's path leg by leg, wall to wall: each leg run to its first
    // impact in one test, and the bounce taken from a step across that
    // impact with ricochet on. For searching many headings at once, where
    // stepping a whole shot's life at a time costs a second on hix.
    traceLegs: (from, dir, range, maxBounces) => {
      const solids = colliders();
      const legs = [];
      // Where the leg is drawn from, and where its trace starts: a unit past
      // the bounce, clear of the wall it came off.
      let start = { ...from };
      let point = { ...from };
      let direction = { ...dir };
      let left = range;
      for (let leg = 0; leg <= maxBounces && left > 1e-3; leg++) {
        const stop = traceShotStep({
          obstacles: solids,
          x: point.x,
          y: point.y,
          z: point.z,
          dirX: direction.x,
          dirY: direction.y,
          dirZ: direction.z,
          distance: left,
          radius: SHOT_COLLISION_RADIUS,
          ricochet: false,
        });
        const to = { x: stop.x, y: stop.y, z: stop.z };
        const length = Math.hypot(to.x - point.x, to.y - point.y, to.z - point.z);
        legs.push({ from: start, to });
        left -= length;
        if (!stop.obstacle || left <= 1e-3) break;
        const back = Math.min(length, 0.5);
        const bounce = traceShotStep({
          obstacles: solids,
          x: to.x - (direction.x * back),
          y: to.y - (direction.y * back),
          z: to.z - (direction.z * back),
          dirX: direction.x,
          dirY: direction.y,
          dirZ: direction.z,
          distance: back + BANK_LEG_CLEAR,
          radius: SHOT_COLLISION_RADIUS,
          ricochet: true,
        });
        if (!bounce.bounces) break;
        const norm = Math.hypot(bounce.dirX, bounce.dirY, bounce.dirZ) || 1;
        direction = { x: bounce.dirX / norm, y: bounce.dirY / norm, z: bounce.dirZ / norm };
        start = to;
        point = { x: bounce.x, y: bounce.y, z: bounce.z };
        left -= BANK_LEG_CLEAR;
      }
      return legs;
    },
    // A shell's flight as the server flies it (`server.js`, its step): through
    // the teleporters first, off a teleporter's frame as off any wall, then
    // the step. A step that crossed a portal is measured back from where it
    // came out, so its segment lies on the far side.
    traceShot: (from, dir, speed, lifetime, ricochet) => {
      const solids = colliders();
      const portals = teleports();
      const segments = [];
      let point = { ...from };
      let direction = { ...dir };
      let blockedIndex = null;
      let blockedDistance = 0;
      const distance = speed * TRACE_STEP_SECONDS;
      for (let t = 0; t < lifetime; t += TRACE_STEP_SECONDS) {
        let start = point;
        let length = distance;
        if (portals) {
          const traced = traceShotThroughTeleporters(portals, point, direction, distance, blockedIndex, blockedDistance);
          direction = traced.direction;
          blockedIndex = traced.reentryBlockTeleporterIndex;
          blockedDistance = traced.reentryBlockDistance;
          if (traced.frameHit) {
            const impact = traced.point;
            segments.push({ t0: t, t1: t + TRACE_STEP_SECONDS, from: point, to: impact });
            if (!ricochet) break;
            const normal = getShotObstacleNormal(traced.frameHitObstacle, impact.x, impact.y, impact.z, SHOT_COLLISION_RADIUS);
            direction = reflectShotDirection(direction.x, direction.y, direction.z, normal);
            start = {
              x: impact.x + (normal.x * SHOT_BOUNCE_CLEARANCE),
              y: impact.y + (normal.y * SHOT_BOUNCE_CLEARANCE),
              z: impact.z + (normal.z * SHOT_BOUNCE_CLEARANCE),
            };
            length = traced.frameHitRemaining;
          } else if (traced.teleports > 0) {
            start = {
              x: traced.point.x - (direction.x * distance),
              y: traced.point.y - (direction.y * distance),
              z: traced.point.z - (direction.z * distance),
            };
          }
        }
        const step = traceShotStep({
          obstacles: solids,
          x: start.x,
          y: start.y,
          z: start.z,
          dirX: direction.x,
          dirY: direction.y,
          dirZ: direction.z,
          distance: length,
          radius: SHOT_COLLISION_RADIUS,
          ricochet,
        });
        const to = { x: step.x, y: step.y, z: step.z };
        segments.push({ t0: t, t1: t + TRACE_STEP_SECONDS, from: start, to });
        if ((step.obstacle || step.ground) && (!ricochet || step.bounces === 0)) break;
        point = to;
        direction = { x: step.dirX, y: step.dirY, z: step.dirZ };
      }
      return segments;
    },
  };
}

// The view's `findRoute`, over whichever world the caller holds: the graph is
// built the first time a route is asked for and again only when the world
// changes. `world()` returns { obstacles, mapSize, waterLevel, jump }, where
// `obstacles` is the same array for as long as the world is the same.
// `canJump` is the tank's own: a flag can take jumping away (NJ) or give it
// where the world does not (JP, WG), so a route only has jump legs for a tank
// that can take them. A graph is kept for each, rebuilt when the world or its
// jump changes.
export function createRouter(world) {
  let built = null;
  return (from, to, options = {}) => {
    const current = world();
    // Burrowed, a tank passes under every teleporter's doorway rather than
    // through it (`Teleporter::isTeleported`, Teleporter.cxx:361) and cannot
    // jump: the ground it is on is all it can reach.
    const burrowed = options.burrowed === true;
    const canJump = !burrowed && (options.canJump ?? current.allowJumping !== false);
    const jumpKey = JSON.stringify([current.jump ?? null, current.wings ?? null]);
    if (!built || built.obstacles !== current.obstacles || built.mapSize !== current.mapSize
      || built.jumpKey !== jumpKey) {
      built = { obstacles: current.obstacles, mapSize: current.mapSize, jumpKey, graphs: new Map() };
    }
    // Wings jumps at its own velocity and falls at its own gravity, and every
    // `_wingsJumpCount` past the take-off is a flap a flight can plan on.
    const wings = canJump && options.wings && current.jump && current.wings ? current.wings : null;
    const jump = !canJump ? null : wings
      ? {
        ...current.jump,
        velocity: wings.velocity ?? current.jump.velocity,
        gravity: wings.gravity ?? current.jump.gravity,
        flaps: Math.max(0, (wings.count ?? 1) - 1),
      }
      : (current.jump ?? null);
    const key = burrowed ? 'burrowed' : wings ? 'wings' : jump ? 'jump' : 'ground';
    if (!built.graphs.has(key)) {
      built.graphs.set(key, buildNavGraph({ ...current, jump, teleporterLinks: burrowed ? [] : current.teleporterLinks }));
    }
    const graph = built.graphs.get(key);
    return graph.smoothRoute(graph.findRoute(from, to), from);
  };
}

// What a router run elsewhere answers while the route is still being worked
// out: not "none", which is a route nobody can drive.
export const ROUTE_PENDING = 'pending';

// How far a tank may have come, and its destination moved, since a route was
// asked for and still take that route as the answer.
const ANSWER_FROM_SLACK = 10;
const ANSWER_TO_SLACK = ROUTE_DEST_SLACK;

// `createRouter`'s, with the work done by `post`, a worker: a graph's first
// route builds every move on the map, seconds on a slow device, and a main
// thread that does it freezes the game. The world goes over when it changes,
// a route request one at a time, and `receive` takes each answer. A route is
// answered from the last answer for its graph -- ground, jump or Wings -- that
// started and ended near enough; anything else is `ROUTE_PENDING` and asked.
export function createAsyncRouter(world, post) {
  let sent = null;
  let asking = null;
  let nextId = 0;
  const answers = new Map();
  const near = (a, b, slack) => Math.hypot(a.x - b.x, a.y - b.y) < slack && Math.abs(a.z - b.z) < 1;
  const router = (from, to, options = {}) => {
    const current = world();
    const { obstacles, teleporterLinks, ...rest } = current;
    const shape = JSON.stringify(rest);
    if (!sent || sent.obstacles !== obstacles || sent.teleporterLinks !== teleporterLinks || sent.shape !== shape) {
      sent = { obstacles, teleporterLinks, shape };
      asking = null;
      answers.clear();
      post({ type: 'world', world: current });
    }
    const key = `${options.canJump ?? current.allowJumping !== false}:${Boolean(options.wings)}:${options.burrowed === true}`;
    const answer = answers.get(key);
    if (answer && near(answer.from, from, ANSWER_FROM_SLACK) && near(answer.to, to, ANSWER_TO_SLACK)) {
      return answer.nodes;
    }
    if (!asking) {
      asking = { id: ++nextId, key, from, to };
      post({ type: 'route', id: asking.id, from, to, options });
    }
    return ROUTE_PENDING;
  };
  router.receive = ({ id, nodes }) => {
    if (!asking || id !== asking.id) return;
    answers.set(asking.key, { from: asking.from, to: asking.to, nodes });
    asking = null;
  };
  return router;
}
