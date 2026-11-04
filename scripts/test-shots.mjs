import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  MAX_SHOT_SLOTS,
  normalizeShotSlotCount,
  WORLD_WEAPON_PLAYER_ID,
  WORLD_WEAPON_NAME,
  WORLD_WEAPON_TEAM,
  WORLD_WEAPON_DEFAULT_DELAY,
  WORLD_WEAPON_MIN_DELAY,
  normalizeWorldWeaponDelays,
  SHOT_TAP_SPACING_MS,
  getWorldReloadSeconds,
  getSlotReloadSeconds,
  findFreeShotSlot,
  getShotSlotProgress,
  shockWaveHitsTank,
  shotIsActive,
  getShotTankHit,
  getWorldWeaponDirection,
} from '../public/js/shots.mjs';

import { readFileSync, readdirSync } from 'node:fs';
import { TANK, buildCollisionColliders, getStockMuzzle, traceShotStep } from '../public/js/collision.mjs';
import { shotFromTank } from '../public/js/drive.mjs';
import { traceBeam } from '../public/js/trace.mjs';

const require = createRequire(import.meta.url);
const serverLimits = require('../server/shots.cjs');

assert.equal(MAX_SHOT_SLOTS, 64);
assert.equal(serverLimits.MAX_SHOT_SLOTS, MAX_SHOT_SLOTS);
assert.equal(normalizeShotSlotCount(1), 1);
assert.equal(normalizeShotSlotCount(3), 3);
assert.equal(normalizeShotSlotCount('3'), 3);
assert.equal(normalizeShotSlotCount(MAX_SHOT_SLOTS), MAX_SHOT_SLOTS);
assert.equal(normalizeShotSlotCount(MAX_SHOT_SLOTS + 1), MAX_SHOT_SLOTS);
// `-ms 0` is upstream's "tanks cannot shoot", so zero is a count like any
// other. Only a negative one is clamped, which is upstream's own split.
assert.equal(normalizeShotSlotCount(0), 0);
assert.equal(normalizeShotSlotCount('0'), 0);
assert.equal(normalizeShotSlotCount(-1), 1);
assert.equal(normalizeShotSlotCount(1.5), 1);
assert.equal(normalizeShotSlotCount(Number.POSITIVE_INFINITY), 1);
assert.equal(normalizeShotSlotCount(Number.MAX_SAFE_INTEGER + 1), 1);
// Absence is not a stated zero, even though `Number` turns all of these into
// one: a missing setting still means one shot.
assert.equal(normalizeShotSlotCount(null), 1);
assert.equal(normalizeShotSlotCount(undefined), 1);
assert.equal(normalizeShotSlotCount(''), 1);
assert.equal(normalizeShotSlotCount('   '), 1);
assert.equal(normalizeShotSlotCount(false), 1);

for (const value of [1, 3, '3', MAX_SHOT_SLOTS, MAX_SHOT_SLOTS + 1, 0, '0', -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, null, undefined, '', '   ', false]) {
  assert.equal(
    serverLimits.normalizeShotSlotCount(value),
    normalizeShotSlotCount(value),
    `client/server normalization diverged for ${String(value)}`
  );
}

// --- World weapons -----------------------------------------------------------
{
  // PlayerId ServerPlayer (Address.h:75), which is what upstream stamps on every
  // shot nobody fired -- 253, and not the 252 next to it, which is the admin
  // channel.
  assert.equal(WORLD_WEAPON_PLAYER_ID, 253);
  assert.equal(serverLimits.WORLD_WEAPON_PLAYER_ID, WORLD_WEAPON_PLAYER_ID);

  // CustomWeapon's defaults and its floor on a delay.
  assert.equal(WORLD_WEAPON_DEFAULT_DELAY, 10);
  assert.equal(WORLD_WEAPON_MIN_DELAY, 0.1);
  assert.deepEqual(normalizeWorldWeaponDelays([]), [10], 'no delay is ten seconds');
  assert.deepEqual(normalizeWorldWeaponDelays(undefined), [10]);
  assert.deepEqual(normalizeWorldWeaponDelays(['6']), [6], 'stated as text in a BZW');
  assert.deepEqual(normalizeWorldWeaponDelays([2, 1, 3]), [2, 1, 3], 'a rhythm, not a rate');
  // Under the floor is dropped, and dropping every entry leaves the default.
  assert.deepEqual(normalizeWorldWeaponDelays([0.05, 4]), [4]);
  assert.deepEqual(normalizeWorldWeaponDelays([0.05]), [10]);
  assert.deepEqual(normalizeWorldWeaponDelays([0.1]), [0.1], 'the floor itself is allowed');
  assert.deepEqual(normalizeWorldWeaponDelays(['x', -3, null]), [10]);

  // WorldPlayer's collective identity: one pseudo-player for every world weapon
  // on the map, on the rogue team, and no name per weapon because a BZW cannot
  // give one.
  assert.equal(WORLD_WEAPON_NAME, 'world weapon');
  assert.equal(WORLD_WEAPON_TEAM, 'rogue');
  assert.equal(serverLimits.WORLD_WEAPON_NAME, WORLD_WEAPON_NAME);
  assert.equal(serverLimits.WORLD_WEAPON_TEAM, WORLD_WEAPON_TEAM);

  // bz_vectorFromRotations, in upstream's axes. A weapon at rotation 0 fires
  // along +x.
  const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-9, `${message}: ${a} != ${b}`);
  const east = getWorldWeaponDirection(0, 0);
  close(east.x, 1, 'rotation 0 is +x');
  close(east.y, 0, 'and nothing across');
  close(east.z, 0, 'and level');

  // +y is north, so rotation 90 fires at +y. That is what aims
  // `fountains.bzw`'s lasers down the length of the map: the one at BZW y -190
  // has rotation 90 and has to fire towards the middle.
  const north = getWorldWeaponDirection(Math.PI / 2, 0);
  close(north.x, 0, 'rotation 90 has nothing along x');
  close(north.y, 1, 'and fires towards +y');
  const south = getWorldWeaponDirection(3 * Math.PI / 2, 0);
  close(south.y, -1, 'rotation 270 fires the other way');
  const west = getWorldWeaponDirection(Math.PI, 0);
  close(west.x, -1, 'rotation 180 is -x');

  // Tilt is the vertical angle, and it is +z.
  const up = getWorldWeaponDirection(0, Math.PI / 2);
  close(up.z, 1, 'straight up');
  close(up.x, 0, 'with nothing left along the ground');
  const half = getWorldWeaponDirection(0, Math.PI / 4);
  close(half.z, Math.SQRT1_2, 'and a unit vector at any tilt');
  close(half.x, Math.SQRT1_2);
  for (const [rotation, tilt] of [[0, 0], [1, 0.3], [2.5, -0.7], [Math.PI, 1.2]]) {
    const dir = getWorldWeaponDirection(rotation, tilt);
    close(Math.hypot(dir.x, dir.y, dir.z), 1, `unit length at ${rotation}/${tilt}`);
    assert.deepEqual(serverLimits.getWorldWeaponDirection(rotation, tilt), dir,
      'client/server weapon aim diverged');
  }
}

// --- Shot slots as a clock ---------------------------------------------------
{
  // `_reloadTime` defaults to `_shotRange / _shotSpeed` (global.cxx:127), and a
  // map that states its own replaces the whole basis.
  assert.equal(getWorldReloadSeconds({ SHOT_RANGE: 350, SHOT_SPEED: 100 }), 3.5);
  assert.equal(getWorldReloadSeconds({ SHOT_DISTANCE: 350, SHOT_SPEED: 100 }), 3.5,
    'SHOT_DISTANCE is the same number under the client/radar name');
  assert.equal(
    getWorldReloadSeconds({ SHOT_RANGE: 350, SHOT_SPEED: 100, SHOT_LIFETIME: 7000 }), 7,
    "a map's own _reloadTime replaces the derived basis");
  assert.equal(getWorldReloadSeconds({}), 3.5, 'upstream defaults when nothing is stated');
  assert.equal(serverLimits.getWorldReloadSeconds({ SHOT_RANGE: 350, SHOT_SPEED: 100 }), 3.5);

  // `setReloadTime(reload / adRate)`. Rapid Fire's slots come back twice as
  // fast, Laser's half as fast -- `_laserAdRate` is 0.5, which is a *slower*
  // reload, and getting that backwards is the whole reason this is a test.
  assert.equal(getSlotReloadSeconds(3.5, 2), 1.75, 'F reloads twice as fast');
  assert.equal(getSlotReloadSeconds(3.5, 0.5), 7, 'L reloads half as fast');
  assert.equal(getSlotReloadSeconds(3.5, 1), 3.5, 'an ordinary shot is the world reload');
  assert.equal(getSlotReloadSeconds(3.5, 0), 3.5, 'a rate of zero is no scaling, not a divide by zero');
  assert.equal(serverLimits.getSlotReloadSeconds(3.5, 12), getSlotReloadSeconds(3.5, 12),
    'client/server slot reload diverged');

  // An untouched slot is free, and slots are handed out lowest first.
  assert.equal(findFreeShotSlot([], 3, 1000), 0);
  assert.equal(findFreeShotSlot([2000], 3, 1000), 1, 'slot 0 is still reloading');
  assert.equal(findFreeShotSlot([2000, 2000, 2000], 3, 1000), -1, 'every slot is busy');
  assert.equal(findFreeShotSlot([2000, 2000, 2000], 3, 2000), 0,
    'a slot is free the instant its reload is up, not a tick later');
  assert.equal(findFreeShotSlot([500], 3, 1000), 0, 'a reload already past frees the slot');
  assert.equal(findFreeShotSlot([9e9, 9e9], 0, 1000), -1, '-ms 0 has no slot to find');
  assert.equal(serverLimits.findFreeShotSlot([2000], 3, 1000), 1,
    'client/server slot search diverged');

  // The shell is not the slot. Firing fills the slot for a full reload, and
  // nothing that happens to the shell afterwards shortens it -- which is the
  // behaviour issue #141 is about: upstream reaps a slot on `isReloaded()` and
  // never on `isExpired()`, and bzfs's `removeShot` leaves `expireTime` alone.
  const slots = [];
  slots[0] = 1000 + (getSlotReloadSeconds(3.5, 1) * 1000);
  assert.equal(findFreeShotSlot(slots, 1, 1200), -1,
    'a shot that stopped early does not hand its slot back');
  assert.equal(findFreeShotSlot(slots, 1, 4500), 0, 'the slot comes back on its own reload');

  // The bars beside the control box: full when free, and filling across the
  // slot's own reload rather than the shell's flight.
  assert.equal(getShotSlotProgress([], 0, 3500, 1000), 1, 'a slot never fired reads full');
  assert.equal(getShotSlotProgress([4500], 0, 3500, 1000), 0, 'just fired reads empty');
  assert.equal(getShotSlotProgress([4500], 0, 3500, 2750), 0.5, 'half way through the reload');
  assert.equal(getShotSlotProgress([4500], 0, 3500, 4500), 1, 'and full again when it is up');
  assert.equal(getShotSlotProgress([4500], 0, 0, 1000), 1, 'no reload to wait out');

  // bzo's own floor on the tap path, which upstream has no equivalent of --
  // its BZDB table carries `_reloadTime` and the per-flag rates and nothing
  // about the trigger. Client-side only, so it is deliberately absent from the
  // server copy.
  assert.equal(SHOT_TAP_SPACING_MS, 100);
  assert.equal(serverLimits.SHOT_TAP_SPACING_MS, undefined,
    'the tap floor is input ergonomics and is never enforced on the wire');
}

// --- who a shot may hit -------------------------------------------------
//
// `LocalPlayer::checkHit`'s rules, which both ends now answer with this one
// function: bzo's server asks it of every tank, and a proxied browser asks it
// of its own, because bzfs takes the victim's word for a death.
{
  const shooter = { playerId: '7', flag: null, steals: false, bounces: 0, team: 'red' };
  // A tank at the origin facing north (+y), and a shot crossing it along +x
  // from well outside, a unit above the ground (+z).
  const victim = {
    id: '3',
    team: 'green',
    paused: false,
    alive: true,
    position: {
      x: 0, y: 0, z: 0, azimuth: Math.PI / 2,
    },
    flagType: null,
    zoned: false,
  };
  const from = { x: -10, y: 0, z: 1 };
  const to = { x: 10, y: 0, z: 1 };

  assert.ok(getShotTankHit(shooter, from, to, victim), 'a shot across a tank hits it');
  assert.equal(getShotTankHit(shooter, from, { x: -6, y: 0, z: 1 }, victim), null,
    'a shot that stops short of the tank does not');

  // The states that are not a tank to hit.
  assert.equal(getShotTankHit(shooter, from, to, { ...victim, alive: false }), null,
    'a dead tank cannot be hit');
  assert.equal(getShotTankHit(shooter, from, to, { ...victim, paused: true }), null,
    'a paused tank cannot be hit');
  assert.equal(getShotTankHit(shooter, from, to, { ...victim, team: 'observer' }), null,
    'an observer has no tank to hit');

  // "Don't shoot yourself!" -- but only before it has bounced.
  const own = { ...victim, id: shooter.playerId };
  assert.equal(getShotTankHit(shooter, from, to, own), null,
    'your own shot cannot hit you before it bounces');
  assert.ok(getShotTankHit({ ...shooter, bounces: 1 }, from, to, own),
    'and can once it has');

  // `-noTeamKills`, and rogue excepted from it.
  const mate = { ...victim, team: 'red' };
  assert.ok(getShotTankHit(shooter, from, to, mate, { noTeamKills: false }),
    'a team mate is shootable where team kills are allowed');
  assert.equal(getShotTankHit(shooter, from, to, mate, { noTeamKills: true }), null,
    'and immune where they are not');
  assert.ok(getShotTankHit({ ...shooter, team: 'rogue' }, from, to,
    { ...victim, team: 'rogue' }, { noTeamKills: true }),
    'rogue is excepted, which is upstream\'s own -noTeamKills help text');
  assert.ok(getShotTankHit(shooter, from, to, mate, { noTeamKills: true, teamsAllowed: false }),
    'and a world with no teams has no team kills to refuse');

  // A thief takes from a tank carrying something and passes through one that
  // is not.
  const thief = { ...shooter, flag: 'TH', steals: true };
  assert.equal(getShotTankHit(thief, from, to, victim), null,
    'a thief passes through a tank with nothing to take');
  assert.ok(getShotTankHit(thief, from, to, { ...victim, flagType: 'GM' }),
    'and stops at one carrying a flag');
  assert.ok(getShotTankHit(thief, from, to, { ...mate, flagType: 'GM' }, { noTeamKills: true }),
    'a thief can still rob a team mate, which no team-kill rule refuses');

  // "laser can't hit a cloaked tank", and the phantom pair.
  assert.equal(getShotTankHit({ ...shooter, flag: 'L' }, from, to,
    { ...victim, flagType: 'CL' }), null, 'a laser cannot hit a cloaked tank');
  assert.ok(getShotTankHit({ ...shooter, flag: 'L' }, from, to, victim),
    'but hits an uncloaked one');
  assert.equal(getShotTankHit(shooter, from, to, { ...victim, zoned: true }), null,
    'an ordinary bullet passes through a zoned tank');
  assert.ok(getShotTankHit({ ...shooter, flag: 'SB' }, from, to, { ...victim, zoned: true }),
    'a super bullet reaches it');

  // The height gate: a shot over the roof of the tank misses it.
  assert.equal(getShotTankHit(shooter, { x: -10, y: 0, z: 9 }, { x: 10, y: 0, z: 9 }, victim),
    null, 'a shot above the tank misses');
  // Inside the sphere but over the tank's box: a muzzle-height shell passes a
  // tank at `_burrowDepth`, and a burrowed tank's own low shot still reaches it.
  const burrowed = { ...victim, flagType: 'BU', position: { ...victim.position, z: -1.32 } };
  assert.equal(getShotTankHit(shooter, { x: -10, y: 0, z: 1.57 }, { x: 10, y: 0, z: 1.57 }, burrowed),
    null, 'a level shell passes over a burrowed tank');
  assert.ok(getShotTankHit(shooter, { x: -10, y: 0, z: 0.25 }, { x: 10, y: 0, z: 0.25 }, burrowed),
    'a burrowed shooter hits a burrowed tank');

  // A guided missile is inert until its activation time is up, which is what
  // stops it killing its own shooter as it turns back.
  assert.equal(shotIsActive({ activationTime: 0.5, createdAt: 1000 }, 1200), false,
    'a missile is not active before its activation time');
  assert.ok(shotIsActive({ activationTime: 0.5, createdAt: 1000 }, 1600),
    'and is after it');
  assert.ok(shotIsActive({ activationTime: 0, createdAt: 1000 }, 1000),
    'an ordinary shot has no activation time to wait out');

  // The client and server copies answer alike, which is the whole point of the
  // pair.
  assert.deepEqual(
    serverLimits.getShotTankHit(shooter, from, to, victim),
    getShotTankHit(shooter, from, to, victim),
    'client and server disagree about a hit',
  );
}

// --- and who a shock wave may hit ----------------------------------------
//
// Its own rule, because it is a sphere rather than a segment and because
// upstream says it "can kill anything inside the radius, be it behind or in a
// building or even zoned".
{
  const wave = { playerId: '7', team: 'red', x: 0, y: 0, z: 0, radius: 10 };
  const victim = { id: '3', team: 'green', paused: false, alive: true, position: { x: 5, y: 0, z: 0 } };

  assert.ok(shockWaveHitsTank(wave, victim), 'a tank inside the wave is caught');
  assert.equal(shockWaveHitsTank(wave, { ...victim, position: { x: 15, y: 0, z: 0 } }), false,
    'and one outside it is not');
  assert.equal(shockWaveHitsTank(wave, { ...victim, id: wave.playerId }), false,
    'my own shock wave cannot kill me');
  assert.equal(shockWaveHitsTank(wave, { ...victim, alive: false }), false, 'nor a dead tank');
  assert.equal(shockWaveHitsTank(wave, { ...victim, paused: true }), false, 'nor a paused one');
  assert.equal(shockWaveHitsTank(wave, { ...victim, team: 'observer' }), false, 'nor an observer');
  assert.equal(shockWaveHitsTank(wave, { ...victim, team: 'red' }, { noTeamKills: true }), false,
    'friendly fire governs a wave like any other shot');

  const serverShots = require('../server/shots.cjs');
  assert.equal(serverShots.shockWaveHitsTank(wave, victim), shockWaveHitsTank(wave, victim),
    'client and server disagree about a shock wave');
}

// `-sl <flag> <count>` (CmdLineOptions.cxx:1221): below 1 is 1, a count that
// does not start with a digit is refused, and an unknown flag is ignored.
{
  const { normalizeShotLimit } = require('../server/shots.cjs');
  assert.equal(normalizeShotLimit(5), 5);
  assert.equal(normalizeShotLimit('3'), 3);
  assert.equal(normalizeShotLimit(0), 1, 'upstream raises 0 to 1');
  assert.equal(normalizeShotLimit('abc'), null);
  assert.equal(normalizeShotLimit(undefined), null);
  const { parseBZWServerOptions } = require('../server/bzw-parse.cjs');
  const { shotLimits } = parseBZWServerOptions([
    'options', '-sl GM 5', '-sl l 2', '-sl GM 7', '-sl XX 3', '-sl SW x', 'end',
  ]);
  assert.deepEqual(shotLimits, { GM: 7, L: 2 }, 'a later line for a flag replaces the earlier one');
}

// Every tank fires from upstream's stock muzzle (`Player::getMuzzle`,
// Player.cxx:224), whatever model draws it: `_tankRadius + 0.1` ahead and
// `_muzzleHeight` up. A model is how a tank looks, never how it plays.
{
  const close = (a, b) => Math.abs(a - b) < 1e-9;
  const stock = getStockMuzzle();
  assert.ok(close(stock.forward, 4.42), `4.42 ahead, not ${stock.forward}`);
  assert.ok(close(stock.height, 1.57), `1.57 up, not ${stock.height}`);
  // Obesity's length moves it forward; nothing a flag does moves it up.
  assert.ok(close(getStockMuzzle({ lengthScale: 2 }).forward, (2 * 4.32) + 0.1), 'Obesity reaches further');
  // Still growing: a tenth of the rate on top, as upstream adds it.
  assert.ok(close(getStockMuzzle({ lengthScale: 1, lengthRate: 1.5 }).forward, 4.32 + 0.15 + 0.1), 'and further while it grows');
  // A landing's squish lowers it, for as long as the squish lasts.
  assert.ok(close(getStockMuzzle({ heightScale: 0.5 }).height, 0.785), 'squished');

  const shot = shotFromTank({ x: 10, y: 20, z: 13, azimuth: 0, tankVelocity: { x: 0, y: 0, z: 0 }, config: { SHOT_SPEED: 100 } });
  assert.ok(close(shot.x, 10 + 4.42) && close(shot.y, 20) && close(shot.z, 13 + 1.57),
    `a tank on a 13.0 block fires from 14.57, as a BZFlag client does: ${JSON.stringify(shot)}`);
}

// Nothing a model's geometry measures reaches a shot: the barrel a model is
// drawn with sets only the first-person eye.
{
  const sources = [
    ...readdirSync(new URL('../public/js/', import.meta.url)).filter((name) => /\.m?js$/.test(name)).map((name) => `public/js/${name}`),
    'server.js',
  ];
  for (const file of sources) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.ok(!/userData\??\.muzzle(Forward|Height)/.test(text), `${file} reads a model's muzzle`);
  }
  const client = readFileSync(new URL('../public/js/client.js', import.meta.url), 'utf8');
  const myMuzzle = client.slice(client.indexOf('function myMuzzle()'), client.indexOf('\n}\n', client.indexOf('function myMuzzle()')));
  assert.ok(myMuzzle.includes('getStockMuzzle('), 'the local tank fires from the stock muzzle');
}

// Nosed up against a wall, the muzzle pokes through it; the first step's wall
// test starts `_muzzleFront` behind the muzzle (`makeSegments`,
// SegmentedShotStrategy.cxx:417), so the shot meets the wall and not the far
// side of it (issue #83).
{
  const wall = buildCollisionColliders([{ type: 'box', name: 'wall', pos: [3.5, 0, 0], size: [0.25, 20, 10], angle: 0 }], 800, false);
  const muzzle = { x: TANK.muzzleForward, y: 0, z: TANK.muzzleHeight };
  const step = (backtrack) => traceShotStep({
    obstacles: wall, ...muzzle, dirX: 1, dirY: 0, dirZ: 0, distance: 5, radius: 0.5, ricochet: false, backtrack,
  });
  assert.equal(step(0).obstacle, null, 'from the muzzle alone the wall is behind it');
  const met = step(TANK.muzzleFront);
  assert.equal(met.obstacle?.name, 'wall', 'from behind the muzzle the shot meets the wall');
  assert.ok(met.x < 3.5, `and stops on the near face, at ${met.x}`);

  const beam = traceBeam({ colliders: wall, teleports: { teleporters: new Map(), links: new Map() }, mapSize: 800 },
    muzzle, { x: 1, y: 0, z: 0 }, 100, { backtrack: TANK.muzzleFront });
  assert.equal(beam.segments[0].end, 'obstacle', `a laser meets it too: ${JSON.stringify(beam.segments)}`);
}

// A squashed tank's hit sphere sits half its present height up
// (SegmentedShotStrategy.cxx:227), so a shell grazing past its shoulder at
// 4.1 across and 2.0 up hits a tank at full height and misses a squished one.
{
  const tank = (heightScale) => ({ id: 2, team: 'red', alive: true, paused: false, position: { x: 0, y: 0, z: 0 }, heightScale });
  const shot = { playerId: 1, flag: null, steals: false, bounces: 0, team: 'green' };
  const from = { x: -20, y: 4.1, z: 2.0 };
  const to = { x: 20, y: 4.1, z: 2.0 };
  assert.ok(getShotTankHit(shot, from, to, tank(1)), 'a tank at full height is hit');
  assert.equal(getShotTankHit(shot, from, to, tank(0.5)), null, 'a squished one is not');
}

console.log('Shot slot limit tests passed');
