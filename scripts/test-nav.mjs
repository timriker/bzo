/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The route graph (`public/nav.mjs`) on small built worlds: what it walks,
// what it jumps, and what it leaves alone.

import assert from 'node:assert/strict';
import { buildNavGraph } from '../public/nav.mjs';

const JUMP = { velocity: 19, gravity: 9.8, tankSpeed: 25 };
// A box `w` across in x and `d` in y, standing `h` tall on `base`.
const box = (name, x, y, w, d, h, base = 0) => ({
  type: 'box',
  name,
  pos: [x, y, base],
  size: [w / 2, d / 2, h],
  angle: 0,
  bounds: {
    minX: x - (w / 2), maxX: x + (w / 2), minY: y - (d / 2), maxY: y + (d / 2), minZ: base, maxZ: base + h,
  },
});

// Flat ground: a route goes straight there, on the ground, with no jump.
{
  const nav = buildNavGraph({ obstacles: [], mapSize: 200, jump: JUMP });
  const route = nav.findRoute({ x: -60, y: 0, z: 0 }, { x: 60, y: 0, z: 0 });
  assert.ok(route && route.length > 20);
  assert.ok(route.every((node) => node.z === 0 && !node.jump));
}

// A wall in the way is gone round.
{
  const nav = buildNavGraph({ obstacles: [box('wall', 0, 0, 4, 120, 20)], mapSize: 200, jump: null });
  const route = nav.findRoute({ x: -40, y: 0, z: 0 }, { x: 40, y: 0, z: 0 });
  assert.ok(route, 'there is a way round');
  assert.ok(route.some((node) => Math.abs(node.y) > 60), 'and it goes round the end');
}

// A platform one jump reaches is jumped onto; one too high is not reached.
{
  const low = buildNavGraph({ obstacles: [box('deck', 0, 0, 40, 40, 10)], mapSize: 200, jump: JUMP });
  const up = low.findRoute({ x: -80, y: 0, z: 0 }, { x: 0, y: 0, z: 10 });
  assert.ok(up, 'a 10-high deck is reached');
  assert.equal(up.filter((node) => node.jump).length, 1, 'with one jump');
  assert.equal(up.at(-1).z, 10);
  const down = low.findRoute({ x: 0, y: 0, z: 10 }, { x: -80, y: 0, z: 0 });
  assert.ok(down && down.every((node) => !node.jump), 'and left by driving off it');

  const high = buildNavGraph({ obstacles: [box('tower', 0, 0, 40, 40, 30)], mapSize: 200, jump: JUMP });
  assert.equal(high.findRoute({ x: -80, y: 0, z: 0 }, { x: 0, y: 0, z: 30 }), null, 'a 30-high tower is not');

  const grounded = buildNavGraph({ obstacles: [box('deck', 0, 0, 40, 40, 10)], mapSize: 200, jump: null });
  assert.equal(grounded.findRoute({ x: -80, y: 0, z: 0 }, { x: 0, y: 0, z: 10 }), null, 'nor anything, with no jumping');
}

// Two steps up: a jump to a ledge, and another from the ledge.
{
  const nav = buildNavGraph({
    obstacles: [box('ledge', 0, 0, 80, 80, 12), box('top', 0, 0, 30, 30, 12, 12)],
    mapSize: 300,
    jump: JUMP,
  });
  const route = nav.findRoute({ x: -120, y: 0, z: 0 }, { x: 0, y: 0, z: 24 });
  assert.ok(route, 'the top is reached');
  assert.equal(route.filter((node) => node.jump).length, 2);
}

// A step no taller than a bump is driven up.
{
  const nav = buildNavGraph({ obstacles: [box('kerb', 0, 0, 40, 40, 0.3)], mapSize: 200, jump: null });
  const route = nav.findRoute({ x: -60, y: 0, z: 0 }, { x: 0, y: 0, z: 0.3 });
  assert.ok(route && route.every((node) => !node.jump));
}

// A gap narrower than a tank, between a walkway and a deck at the same height,
// is driven across rather than dropped into. A wide one is not.
{
  const narrow = buildNavGraph({
    obstacles: [box('walk', -30, 0, 52, 8, 2, 20), box('deck', 26, 0, 52, 52, 2, 20)],
    mapSize: 200,
    jump: null,
  });
  const across = narrow.findRoute({ x: -50, y: 0, z: 22 }, { x: 30, y: 0, z: 22 });
  assert.ok(across, 'the deck is reached from the walkway');
  assert.ok(across.every((node) => node.z === 22), 'without leaving the level');
  assert.ok(across.some((node) => node.bridge), 'by a bridge');

  const wide = buildNavGraph({
    obstacles: [box('walk', -34, 0, 52, 8, 2, 20), box('deck', 32, 0, 52, 52, 2, 20)],
    mapSize: 200,
    jump: null,
  });
  assert.equal(wide.findRoute({ x: -50, y: 0, z: 22 }, { x: 30, y: 0, z: 22 }), null, 'a gap wider than a tank is not');
}

// Round the end of a thin wall a route keeps a tank's half length clear of
// it, not the standing circle: a tank turning round a corner it shaves catches
// it and wedges, as on hix's support ribs.
{
  const nav = buildNavGraph({ obstacles: [box('rib', 0, 0, 2, 40, 5)], mapSize: 200, jump: null });
  const route = nav.findRoute({ x: -20, y: 0, z: 0 }, { x: 20, y: 0, z: 0 });
  assert.ok(route, 'there is a way round');
  const tip = Math.min(...route.map((node) => Math.hypot(node.x, Math.max(0, Math.abs(node.y) - 20))));
  assert.ok(tip >= 3, `the route passes ${tip.toFixed(1)} from the end, not shaving it`);
}

// A slow jump climbs a couple of metres between two steps across, so a floor
// slab hanging just above the takeoff has to be met by the time step, not
// stepped over: eroah's low boxes sit under one, and a jump from beneath it
// hits it and falls back.
{
  const deck = box('deck', 20, 0, 16, 40, 4);
  const slab = box('slab', -12, 0, 24, 40, 1, 3);
  const nav = buildNavGraph({ obstacles: [deck, slab], mapSize: 200, jump: JUMP });
  const route = nav.findRoute({ x: -12, y: 0, z: 0 }, { x: 20, y: 0, z: 4 });
  assert.ok(route, 'the deck is reachable');
  const at = route.findIndex((node) => node.jump);
  const takeoff = route[at - 1];
  const under = (node) => node.x > -24 && node.x < 0 && Math.abs(node.y) < 20;
  assert.ok(takeoff && !under(takeoff),
    `the jump leaves from clear of the slab, not from (${takeoff?.x}, ${takeoff?.y}) under it`);
}

console.log('nav tests passed');
