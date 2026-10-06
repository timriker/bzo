#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The `trace` pair: a shell's step through teleporters, and a beam's whole
// path through teleporters, off buildings and out at the world's edge.

import assert from 'node:assert/strict';
import { buildTeleporterIndex } from '../public/teleport.mjs';
import { traceBeam, traceShotThroughTeleporters } from '../public/trace.mjs';
import { createRequire } from 'node:module';

const { parseBZWMap } = createRequire(import.meta.url)('../server/bzw-parse.cjs');

// Everything here is in upstream's frame: +x east, +y north, +z up. An
// obstacle is `pos` (its base), `size` (half width, half breadth, height) and
// `angle`, as the map importer gives every obstacle.

// Angle 0: the front face, face 0, looks east (+x), as
// `Teleporter::isTeleported` numbers them.
const portal = (teleporterIndex, x, y) => ({
  type: 'box', kind: 'teleporter', name: `tp${teleporterIndex}`, teleporterIndex,
  pos: [x, y, 0], size: [1, 4.5, 20], angle: 0, border: 1.12,
});
const a = portal(0, 0, 0);
const b = portal(1, 100, -50);
// Into A's back face (heading +x) and out of B's front face.
const teleports = buildTeleporterIndex([a, b], [{ sourceFaceId: 1, destFaceId: 2 }]);

// Faces and exits as upstream numbers and turns them, from a map: face 0 (`:f`)
// is the side a teleporter's own +X points to (`Teleporter::isTeleported`),
// and `getPointWRT` puts a shot out of the destination face turned by the
// difference between the two faces' angles. East is +x and south is -y.
{
  const map = parseBZWMap('linked.bzw', { quiet: true, text: [
    'teleporter A', '  position -50 0 0', '  size 0.5 5 10', '  rotation 0', '  border 1', 'end',
    'teleporter B', '  position 50 0 0', '  size 0.5 5 10', '  rotation 90', '  border 1', 'end',
    'link', '  from A:f', '  to B:b', 'end',
  ].join('\n') });
  const index = buildTeleporterIndex(map.obstacles, map.teleporterGraph.links);
  // Into A from the east, its front: out of B's back, which faces south at 90.
  const traced = traceShotThroughTeleporters(index, { x: -45, y: 0, z: 3 }, { x: -1, y: 0, z: 0 }, 6);
  assert.equal(traced.teleports, 1, 'A:f sends to B');
  assert.ok(Math.abs(traced.point.x - 50) < 1e-6 && traced.point.y < -0.5,
    `out of B's south side, at ${JSON.stringify(traced.point)}`);
  assert.ok(Math.abs(traced.direction.x) < 1e-9 && traced.direction.y < -0.999,
    `heading south, ${JSON.stringify(traced.direction)}`);
  // Into A from the west, its back, which has no link: through to A's front.
  const back = traceShotThroughTeleporters(index, { x: -55, y: 0, z: 3 }, { x: 1, y: 0, z: 0 }, 6);
  assert.ok(back.point.x > -50 && back.point.x < -40, `A:b goes out of A:f, at ${JSON.stringify(back.point)}`);
}

// A shell steps through A and comes out of B, blocked from going straight back in.
{
  const traced = traceShotThroughTeleporters(teleports, { x: -5, y: 0, z: 5 }, { x: 1, y: 0, z: 0 }, 10);
  assert.equal(traced.teleports, 1, 'one doorway crossed');
  assert.ok(Math.hypot(traced.point.x - b.pos[0], traced.point.y - b.pos[1]) < 10, `comes out by B, at ${JSON.stringify(traced.point)}`);
  assert.equal(traced.reentryBlockTeleporterIndex, 1, 'B cannot take it straight back');
  assert.equal(traced.frameHit, false);
}

// A shell into A's frame stops there.
{
  const traced = traceShotThroughTeleporters(teleports, { x: -5, y: 0, z: 19.5 }, { x: 1, y: 0, z: 0 }, 10);
  assert.equal(traced.frameHit, true, 'the header is a building');
  assert.equal(traced.teleports, 0);
}

// A beam through A carries on from B, and ends at the world's edge (to within
// findMapEdgeImpactPoint's bisection).
{
  const world = { colliders: [a, b], teleports, mapSize: 400 };
  const traced = traceBeam(world, { x: -5, y: 0, z: 5 }, { x: 1, y: 0, z: 0 }, 1000, { ricochet: false });
  assert.deepEqual(traced.segments.map((s) => s.end), ['teleport', 'out_of_bounds'], JSON.stringify(traced.segments.map((s) => s.end)));
  assert.ok(Math.abs(Math.abs(traced.segments[1].to.x) - 200) < 2 || Math.abs(Math.abs(traced.segments[1].to.y) - 200) < 2,
    `ends on the edge, at ${JSON.stringify(traced.segments[1].to)}`);
}

// A ricocheting beam bounces off a wall and comes back.
{
  const wall = {
    type: 'box', name: 'wall', pos: [50, 100, 0], size: [1, 20, 10], angle: 0,
  };
  const world = { colliders: [wall], teleports: buildTeleporterIndex([]), mapSize: 400 };
  const traced = traceBeam(world, { x: 0, y: 100, z: 5 }, { x: 1, y: 0, z: 0 }, 200, { ricochet: true });
  assert.equal(traced.segments[0].end, 'obstacle');
  assert.equal(traced.bounces, 1);
  assert.ok(traced.segments[1].to.x < 0, 'heads back the way it came');
  const through = traceBeam(world, { x: 0, y: 100, z: 5 }, { x: 1, y: 0, z: 0 }, 200, { throughBuildings: true });
  assert.equal(through.segments[0].end, 'range', 'through buildings it passes the wall');
}

// The first tank hit ends it.
{
  const world = { colliders: [], teleports: buildTeleporterIndex([]), mapSize: 400 };
  const tank = { id: 7 };
  // Fired south (-y), a unit above the ground.
  const traced = traceBeam(world, { x: 0, y: 0, z: 1 }, { x: 0, y: -1, z: 0 }, 100, {
    findHit: (from, to) => (to.y < -30 ? { point: { x: 0, y: -30, z: 1 }, target: tank } : null),
  });
  assert.equal(traced.hit?.target, tank, JSON.stringify(traced));
}

console.log('test-trace: shell and beam traces pass');
