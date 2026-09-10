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
  getOrigRectNormal,
  getTankLocalAngle,
  testOrigRectTank,
} from '../public/collision.mjs';

const require = createRequire(import.meta.url);
const serverMotion = require('../server/motion.cjs');

// A single axis-aligned wall slab, as an obstacle the resolver can query.
function makeWorld(obstacles) {
  const blocking = (px, py, pz, az) => obstacles.find((o) => {
    if (py + 2 <= (o.baseY || 0)) return false;
    if (py >= (o.baseY || 0) + o.h) return false;
    const dx = px - o.x;
    const dz = pz - o.z;
    const c = Math.cos(o.rotation);
    const s = Math.sin(o.rotation);
    const localX = dx * c - dz * s;
    const localZ = dx * s + dz * c;
    return testOrigRectTank(o.w / 2, o.d / 2, localX, localZ, getTankLocalAngle(az, o.rotation));
  }) || null;

  return {
    hitTest: (fx, fy, fz, fa, tx, ty, tz, ta) => blocking(tx, ty, tz, ta),
    getNormal: (obs, px, py, pz) => {
      const dx = px - obs.x;
      const dz = pz - obs.z;
      const c = Math.cos(obs.rotation);
      const s = Math.sin(obs.rotation);
      const n = getOrigRectNormal(obs.w / 2, obs.d / 2, dx * c - dz * s, dx * s + dz * c);
      return { x: n.x, y: 0, z: n.z };
    },
  };
}

const base = {
  azimuth: 0, velocityY: 0, angularVelocity: 0,
  groundLimit: 0, onGround: true,
};

// Upstream only sweeps vertically (BoxBuilding::inMovingBox); horizontal
// tunnelling is prevented by the timestep being small. bzo ticks at 16ms and a
// tank covers 0.4 units in that time, so drive in real ticks, not one jump.
const TICK = 0.016;
function drive(world, start, velocityX, velocityZ, ticks) {
  let state = { ...start };
  let lastObstacle = null;
  for (let i = 0; i < ticks; i++) {
    const r = resolveTankMotion({
      ...base, ...world,
      x: state.x, y: state.y, z: state.z,
      velocityX: state.velocityX ?? velocityX,
      velocityZ: state.velocityZ ?? velocityZ,
      timeStep: TICK,
    });
    if (r.obstacle) lastObstacle = r.obstacle;
    // Velocity is re-applied each tick from player input, as the game loop does.
    state = { x: r.x, y: r.y, z: r.z, velocityX, velocityZ };
  }
  return { ...state, obstacle: lastObstacle };
}

// A wall dead ahead stops the tank short of it and never tunnels through.
{
  const wall = { x: 0, z: -20, w: 40, d: 2, h: 10, baseY: 0, rotation: 0 };
  const world = makeWorld([wall]);
  const r = drive(world, { x: 0, y: 0, z: 0 }, 0, -25, 120);
  assert.ok(r.obstacle, 'never met the wall');
  // Clear of the slab face by the tank's half-length.
  const faceZ = -20 + 1;
  assert.ok(r.z > faceZ, `ended up inside or past the wall: z=${r.z}`);
  assert.ok(r.z < faceZ + TANK_HALF_LENGTH + 0.5, `stopped too early: z=${r.z}`);
}

// Driving at an angle into a wall slides along it instead of sticking.
{
  const wall = { x: 0, z: -20, w: 400, d: 2, h: 10, baseY: 0, rotation: 0 };
  const world = makeWorld([wall]);
  const r = drive(world, { x: 0, y: 0, z: 0 }, 18, -18, 200);
  assert.ok(r.x > 20, `no slide along the wall: x=${r.x}`);
  assert.ok(r.z > -20, `slid through the wall: z=${r.z}`);
}

// Open ground consumes the whole timestep with no obstacle reported.
{
  const world = makeWorld([]);
  const r = resolveTankMotion({
    ...base, ...world, x: 0, y: 0, z: 0,
    velocityX: 10, velocityZ: 5, timeStep: 0.5,
  });
  assert.equal(r.obstacle, null);
  assert.ok(Math.abs(r.x - 5) < 1e-9, `x=${r.x}`);
  assert.ok(Math.abs(r.z - 2.5) < 1e-9, `z=${r.z}`);
}

// A low ledge is driven over rather than blocking.
{
  const ledge = { x: 0, z: -20, w: 40, d: 4, h: MAX_BUMP_HEIGHT / 2, baseY: 0, rotation: 0 };
  const world = makeWorld([ledge]);
  const r = resolveTankMotion({
    ...base, ...world, x: 0, y: 0, z: -14.9,
    velocityX: 0, velocityZ: -25, timeStep: TICK,
    isFlatTop: () => true,
    getObstacleTop: (o) => (o.baseY || 0) + o.h,
  });
  assert.ok(r.y > 0, `did not climb the low ledge: y=${r.y}`);
}

// The tank is 2.8 wide and 6.0 long, so a 12-unit gap passes it head on.
{
  const world = makeWorld([
    { x: -26, z: -20, w: 40, d: 2, h: 10, baseY: 0, rotation: 0 },
    { x: 26, z: -20, w: 40, d: 2, h: 10, baseY: 0, rotation: 0 },
  ]);
  const r = drive(world, { x: 0, y: 0, z: 0 }, 0, -25, 120);
  assert.ok(r.z < -20, `a 12-unit gap should pass a 2.8-wide tank: z=${r.z}`);
}

// bzo's one deviation in this loop: a surface above stops a rise, so a tank that
// jumps into a ceiling starts falling from where it hit instead of staying
// pinned under it until gravity turns the velocity around. The horizontal
// velocity is untouched, which is upstream's behaviour against a flat ceiling
// anyway -- there is nothing for `mag` to cancel.
{
  // The harness clears a tank whose top is at or below the deck's underside, so
  // 3.9 is just under it and one tick of jump velocity crosses.
  const deck = { x: 0, z: 0, w: 40, d: 40, h: 4, baseY: 6, rotation: 0 };
  const world = makeWorld([deck]);
  const r = resolveTankMotion({
    ...base, ...world, x: 0, y: 3.9, z: 0,
    velocityX: 12, velocityY: 19, velocityZ: 0, timeStep: TICK,
    getNormal: () => ({ x: 0, y: -1, z: 0 }),
  });
  assert.equal(r.velocityY, 0, `a ceiling stops the rise, got ${r.velocityY}`);
  assert.equal(r.velocityX, 12, `and leaves the drive alone, got ${r.velocityX}`);
  assert.ok(r.y < 4.1, `the tank stays under the deck: y=${r.y}`);
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
