import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  MAX_BUMP_HEIGHT,
  TINY_DISTANCE,
  resolveTankMotion,
} from '../public/motion.mjs';
import {
  TANK_HALF_LENGTH,
  TANK_HALF_WIDTH,
  getColliderLocalPoint,
  getObstacleBase,
  getOrigRectNormal,
  getTankLocalAngle,
  testOrigRectTank,
} from '../public/collision.mjs';

// In upstream's frame throughout: +X east, +Y north, +Z up, a heading an
// azimuth counter-clockwise from +X, and an obstacle by `pos` (its base
// centre), `size` (half width, half breadth, height) and `angle`.

const require = createRequire(import.meta.url);
const serverMotion = require('../server/motion.cjs');

// Box slabs, as obstacles the resolver can query.
function makeWorld(obstacles) {
  const blocking = (px, py, pz, az) => obstacles.find((o) => {
    const obsBase = getObstacleBase(o);
    if (pz + 2 <= obsBase) return false;
    if (pz >= obsBase + o.size[2]) return false;
    const local = getColliderLocalPoint(px, py, o);
    return testOrigRectTank(o.size[0], o.size[1], local.x, local.y, getTankLocalAngle(az, o.angle));
  }) || null;

  return {
    hitTest: (fx, fy, fz, fa, tx, ty, tz, ta) => blocking(tx, ty, tz, ta),
    getNormal: (obs, px, py) => {
      const local = getColliderLocalPoint(px, py, obs);
      const n = getOrigRectNormal(obs.size[0], obs.size[1], local.x, local.y);
      // Back out of the obstacle's local frame.
      const c = Math.cos(obs.angle);
      const s = Math.sin(obs.angle);
      return { x: (n.x * c) - (n.y * s), y: (n.x * s) + (n.y * c), z: 0 };
    },
  };
}

// Facing north, +Y.
const base = {
  azimuth: Math.PI / 2, velocityZ: 0, angularVelocity: 0,
  groundLimit: 0, onGround: true,
};

// Upstream only sweeps vertically (BoxBuilding::inMovingBox); horizontal
// tunnelling is prevented by the timestep being small. bzo ticks at 16ms and a
// tank covers 0.4 units in that time, so drive in real ticks, not one jump.
const TICK = 0.016;
function drive(world, start, velocityX, velocityY, ticks) {
  let state = { ...start };
  let lastObstacle = null;
  for (let i = 0; i < ticks; i++) {
    const r = resolveTankMotion({
      ...base, ...world,
      x: state.x, y: state.y, z: state.z,
      velocityX: state.velocityX ?? velocityX,
      velocityY: state.velocityY ?? velocityY,
      timeStep: TICK,
    });
    if (r.obstacle) lastObstacle = r.obstacle;
    // Velocity is re-applied each tick from player input, as the game loop does.
    state = { x: r.x, y: r.y, z: r.z, velocityX, velocityY };
  }
  return { ...state, obstacle: lastObstacle };
}

// A wall dead ahead stops the tank short of it and never tunnels through.
{
  const wall = { type: 'box', pos: [0, 20, 0], size: [20, 1, 10], angle: 0 };
  const world = makeWorld([wall]);
  const r = drive(world, { x: 0, y: 0, z: 0 }, 0, 25, 120);
  assert.ok(r.obstacle, 'never met the wall');
  // Clear of the slab face by the tank's half-length.
  const faceY = 20 - 1;
  assert.ok(r.y < faceY, `ended up inside or past the wall: y=${r.y}`);
  assert.ok(r.y > faceY - TANK_HALF_LENGTH - 0.5, `stopped too early: y=${r.y}`);
}

// Driving at an angle into a wall slides along it instead of sticking.
{
  const wall = { type: 'box', pos: [0, 20, 0], size: [200, 1, 10], angle: 0 };
  const world = makeWorld([wall]);
  const r = drive(world, { x: 0, y: 0, z: 0 }, 18, 18, 200);
  assert.ok(r.x > 20, `no slide along the wall: x=${r.x}`);
  assert.ok(r.y < 20, `slid through the wall: y=${r.y}`);
}

// Open ground consumes the whole timestep with no obstacle reported.
{
  const world = makeWorld([]);
  const r = resolveTankMotion({
    ...base, ...world, x: 0, y: 0, z: 0,
    velocityX: 10, velocityY: -5, timeStep: 0.5,
  });
  assert.equal(r.obstacle, null);
  assert.ok(Math.abs(r.x - 5) < 1e-9, `x=${r.x}`);
  assert.ok(Math.abs(r.y + 2.5) < 1e-9, `y=${r.y}`);
}

// A low ledge is driven over rather than blocking.
{
  const ledge = { type: 'box', pos: [0, 20, 0], size: [20, 2, MAX_BUMP_HEIGHT / 2], angle: 0 };
  const world = makeWorld([ledge]);
  const r = resolveTankMotion({
    ...base, ...world, x: 0, y: 14.9, z: 0,
    velocityX: 0, velocityY: 25, timeStep: TICK,
    isFlatTop: () => true,
    getObstacleTop: (o) => getObstacleBase(o) + o.size[2],
  });
  assert.ok(r.z > 0, `did not climb the low ledge: z=${r.z}`);
}

// The tank is 2.8 wide and 6.0 long, so a 12-unit gap passes it head on.
{
  const world = makeWorld([
    { type: 'box', pos: [-26, 20, 0], size: [20, 1, 10], angle: 0 },
    { type: 'box', pos: [26, 20, 0], size: [20, 1, 10], angle: 0 },
  ]);
  const r = drive(world, { x: 0, y: 0, z: 0 }, 0, 25, 120);
  assert.ok(r.y > 20, `a 12-unit gap should pass a 2.8-wide tank: y=${r.y}`);
}

// bzo's one deviation in this loop: a surface above stops a rise, so a tank that
// jumps into a ceiling starts falling from where it hit instead of staying
// pinned under it until gravity turns the velocity around. The horizontal
// velocity is untouched, which is upstream's behaviour against a flat ceiling
// anyway -- there is nothing for `mag` to cancel.
{
  // The harness clears a tank whose top is at or below the deck's underside, so
  // 3.9 is just under it and one tick of jump velocity crosses.
  const deck = { type: 'box', pos: [0, 0, 6], size: [20, 20, 4], angle: 0 };
  const world = makeWorld([deck]);
  const r = resolveTankMotion({
    ...base, ...world, x: 0, y: 0, z: 3.9,
    velocityX: 12, velocityY: 0, velocityZ: 19, timeStep: TICK,
    getNormal: () => ({ x: 0, y: 0, z: -1 }),
  });
  assert.equal(r.velocityZ, 0, `a ceiling stops the rise, got ${r.velocityZ}`);
  assert.equal(r.velocityX, 12, `and leaves the drive alone, got ${r.velocityX}`);
  assert.ok(r.z < 4.1, `the tank stays under the deck: z=${r.z}`);
  // And the rest of the step is spent travelling under it, not thrown away.
  assert.ok(Math.abs(r.x - 12 * TICK) < 1e-9, `full travel under the deck: x=${r.x}`);
  assert.equal(r.onBuilding, false, 'a ceiling is not something to stand on');
}

assert.equal(typeof serverMotion.resolveTankMotion, 'function');
assert.equal(serverMotion.MAX_BUMP_HEIGHT, MAX_BUMP_HEIGHT);
assert.equal(serverMotion.TINY_DISTANCE, TINY_DISTANCE);
assert.equal(TANK_HALF_LENGTH, 3.0);
assert.equal(TANK_HALF_WIDTH, 1.4);

console.log('tank motion tests passed');
