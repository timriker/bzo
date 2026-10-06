/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The autopilots' decisions (`public/autopilot.mjs`) against a hand-built view: an open
// flat world unless a case puts something in it. In upstream's frame: north is
// +y, up is z, the tank faces north (azimuth pi/2) unless a case turns it, and
// a positive rotation turns left.

import assert from 'node:assert/strict';
import { Ace, Roger, createWorldProbes } from '../public/autopilot.mjs';
import { findShotSegmentImpact } from '../public/collision.mjs';

function makeView(overrides = {}) {
  const view = {
    now: 100,
    self: {
      id: 'me',
      x: 0,
      y: 0,
      z: 0,
      azimuth: Math.PI / 2,
      flag: null,
      flagIndex: null,
      flagTeam: null,
      teamColor: 0,
      zoned: false,
      inAir: false,
      canFire: true,
    },
    players: [],
    shots: [],
    flags: [],
    world: {
      allowJumping: true,
      teamFlags: false,
      waterLevel: null,
      shotSpeed: 100,
      maxShots: 1,
      tankHeight: 2.05,
      tankSpeed: 25,
      tankLength: 6,
      jumpVelocity: 19,
      gravity: 9.8,
      lockOnAngle: 0.15,
      shockOutRadius: 60,
    },
    isFoe: () => true,
    myBase: () => null,
    openDistance: () => Infinity,
    isObscured: () => false,
    firstHit: () => null,
    firstBuilding: () => null,
  };
  return {
    ...view,
    ...overrides,
    self: { ...view.self, ...overrides.self },
    world: { ...view.world, ...overrides.world },
  };
}

function enemy(x, y, extra = {}) {
  return {
    id: 'foe', x, y, z: 0, vx: 0, vy: 0, vz: 0, team: 'red',
    alive: true, paused: false, notResponding: false,
    flag: null, flagIndex: null, flagTeam: null, zoned: false, ...extra,
  };
}

// An enemy dead ahead is fired on, and chased at full speed.
{
  const out = new Roger().think(makeView({ players: [enemy(0, 150)] }));
  assert.equal(out.fire, true, 'a foe in the sights is shot');
  assert.equal(out.targetId, 'foe');
  assert.ok(out.speed > 0, 'and driven towards');
  assert.equal(out.shotTargetId, 'foe', 'the shot names who it was fired at');
}

// With a Guided Missile the height gate is off: a foe on a roof is fired on.
{
  const out = new Roger().think(makeView({
    self: { flag: 'GM', flagIndex: 4 },
    players: [enemy(0, 150, { z: 20 })],
  }));
  assert.equal(out.shotTargetId, 'foe');
  const plain = new Roger().think(makeView({ players: [enemy(0, 150, { z: 20 })] }));
  assert.equal(plain.fire, false, 'a normal shot would fly under it');
}

// Ace fires only at a foe the shot can reach, which Roger does not ask: a
// 100-unit shot that lives 3.5 seconds carries about 350 past the muzzle.
{
  const reach = { self: { shotSpeed: 100, shotLifetime: 3.5, muzzleForward: 3 } };
  const near = new Ace().think(makeView({ ...reach, players: [enemy(0, 150)] }));
  assert.equal(near.fire, true, 'a foe in range is shot');
  const far = new Ace().think(makeView({ ...reach, players: [enemy(0, 600)] }));
  assert.equal(far.fire, false, 'a foe out of range is not');
  const roger = new Roger().think(makeView({ ...reach, players: [enemy(0, 600)] }));
  assert.equal(roger.fire, true, 'Roger fires anyway, as upstream does');
}

// A lunge: Ace holding still, a still foe 415 away -- base to base on HiX --
// past a standing shot's 350 but inside one fired at full speed. He drives
// forward, fires on the next frame with the move saying so, and stops.
{
  const pilot = new Ace();
  const frame = (now, speed) => {
    const view = makeView({
      now,
      self: { shotSpeed: 100, shotLifetime: 3.5, muzzleForward: 4.42, topSpeed: 25, velocity: { x: 0, y: speed, z: 0 } },
      players: [enemy(0, 415)],
      firstHit: () => ({ z: 0 }),
    });
    const ctx = {
      view,
      me: { ...view.self, azimuth: Math.PI / 2, vx: 0, vy: speed, vz: 0 },
      out: { rotation: 0, speed: 0, fire: false, intent: {} },
    };
    pilot.fireAtTank(ctx);
    return ctx.out;
  };
  const start = frame(100, 0);
  assert.equal(start.fire, false, 'a standing shot falls short');
  assert.equal(start.speed, 1, 'so he drives forward');
  const shot = frame(100.02, 25);
  assert.equal(shot.fire, true, 'and fires once the speed carries it');
  assert.equal(shot.speed, 1, 'still moving, as the move it goes with says');
  assert.equal(frame(100.04, 25).speed, 0, 'then stops');
  const moving = new Ace();
  const ctx = {
    view: makeView({ now: 100, self: { shotSpeed: 100, shotLifetime: 3.5 }, players: [enemy(0, 415, { vy: 10 })] }),
    out: { rotation: 0, speed: 0, fire: false, intent: {} },
  };
  ctx.me = { ...ctx.view.self, azimuth: Math.PI / 2, vx: 0, vy: 0, vz: 0 };
  moving.fireAtTank(ctx);
  assert.equal(ctx.out.speed, 0, 'not at a foe on the move');
}

// An enemy off to the west turns the tank left, and is not fired on.
{
  const out = new Roger().think(makeView({ players: [enemy(-100, 0)] }));
  assert.ok(out.rotation > 0, 'west of a north-facing tank is a left turn');
  assert.equal(out.fire, false);
}

// Behind a wall nobody is shot.
{
  const out = new Roger().think(makeView({
    players: [enemy(0, 150)],
    isObscured: () => true,
  }));
  assert.equal(out.fire, false, 'an obscured foe is not fired on');
}

// A teammate is neither chased nor shot.
{
  const out = new Roger().think(makeView({
    players: [enemy(0, 150)],
    isFoe: () => false,
  }));
  assert.equal(out.fire, false);
  assert.equal(out.targetId, null);
}

// A wall close ahead backs the tank off, towards the more open side.
{
  const out = new Roger({ random: () => 0 }).think(makeView({
    openDistance: (_pos, azimuth) => {
      const off = azimuth - (Math.PI / 2);
      return Math.abs(off) < 0.1 ? 2 : (off > 0 ? 50 : 10);
    },
  }));
  assert.equal(out.speed, -0.5, 'stuck on a wall reverses');
  assert.equal(out.rotation, 1, 'towards the open left');
}

// Flags Roger cannot use are dropped.
for (const flag of ['US', 'MG', 'ID']) {
  const out = new Roger().think(makeView({ self: { flag, flagIndex: 3 } }));
  assert.equal(out.dropFlag, true, `${flag} is dropped`);
}

// ...and once dropped, a flag whose type is hidden on the ground is still known
// to Ace by the slot it came from, so it does not drive back over it. Roger,
// as upstream's does, drives straight back to it.
{
  const pilot = new Ace();
  pilot.think(makeView({ self: { flag: 'US', flagIndex: 3 } }));
  const ground = { index: 3, type: null, team: null, onGround: true, x: 0, y: 20, z: 0 };
  const out = pilot.think(makeView({ now: 200, self: { azimuth: Math.PI }, flags: [ground] }));
  assert.ok(Math.abs(out.rotation) < 1, 'navigates rather than turning to the flag');
  const fresh = new Ace().think(makeView({
    self: { azimuth: Math.PI },
    flags: [ground],
  }));
  assert.ok(fresh.rotation < -1, 'a pilot that never saw it drives to it');
  const roger = new Roger();
  roger.think(makeView({ self: { flag: 'US', flagIndex: 3 } }));
  const back = roger.think(makeView({ now: 200, self: { azimuth: Math.PI }, flags: [ground] }));
  assert.ok(back.rotation < -1, 'Roger forgets');
}

// A flag seen in someone else's hands is remembered too.
{
  const pilot = new Ace();
  pilot.think(makeView({ players: [enemy(500, -500, { alive: false, flag: 'B', flagIndex: 7 })] }));
  assert.equal(pilot.knownFlagTypes.get(7), 'B');
  assert.equal(pilot.wantsGroundFlag({ index: 7, type: null }), false, 'a bad flag is not wanted');
}

// teachAutoPilot: a flag that keeps dying is no longer worth holding.
{
  const pilot = new Roger();
  pilot.teach('V', 1);
  pilot.teach('QT', -1);
  assert.equal(pilot.isFlagUseful('V'), true);
  assert.equal(pilot.isFlagUseful('QT'), false);
  assert.equal(pilot.isFlagUseful('SB'), true, 'an untried flag is worth a go');
}

// A shot coming straight at the tank is jumped where jumping is allowed.
{
  const shot = { ownerId: 'foe', ownerZoned: false, flag: null, x: 0, y: 10, z: 1, vx: 0, vy: -100, vz: 0 };
  const out = new Roger().think(makeView({ shots: [shot] }));
  assert.equal(out.jump, true);
  const grounded = new Roger().think(makeView({ shots: [shot], world: { allowJumping: false } }));
  assert.equal(grounded.jump, false);
  assert.ok(Math.abs(grounded.rotation) > 1, 'and dodged sideways where it is not');
}

// Burrowed, a tank on the ground's shell flies over him, so Ace neither jumps
// nor dodges it -- that would lift him out of the one place it cannot reach.
// A tank about to drive over him is the threat, and he drives out of its way.
{
  const shell = { ownerId: 'foe', ownerZoned: false, flag: null, x: 0, y: 10, z: 1.57, vx: 0, vy: -100, vz: 0 };
  const under = new Ace().think(makeView({ self: { flag: 'BU', z: -1.32 }, shots: [shell] }));
  assert.equal(under.jump, false, 'no jump out of the ground');
  assert.notEqual(under.intent.mode, 'dodge', 'and nothing to dodge');
  const above = new Ace().think(makeView({ shots: [shell] }));
  assert.equal(above.intent.mode, 'dodge', 'unburrowed, the same shell is dodged');
  // Crossing in front of him, he backs or drives out of its line.
  const crossing = enemy(-20, 6, { vx: 20 });
  const aside = new Ace().think(makeView({ self: { flag: 'BU', z: -1.32 }, players: [crossing] }));
  assert.equal(aside.intent.mode, 'dodge', 'a tank about to drive over him is got out of the way of');
  assert.equal(aside.jump, false, 'by driving, where driving does it');
  // Head on there is no driving clear, and a jump beats being flattened.
  const headOn = new Ace().think(makeView({ self: { flag: 'BU', z: -1.32 }, players: [enemy(0, 20, { vy: -20 })] }));
  assert.equal(headOn.jump, true, 'head on, he jumps');
}

// Water below the edge of a roof stops Ace. Roger's look-ahead has nothing to
// say when it meets nothing.
{
  const view = makeView({ self: { z: 10 }, world: { waterLevel: 1 } });
  assert.equal(new Ace().think(view).speed, 0, 'does not drive off into the water');
  assert.ok(new Roger().think(view).speed > 0);
}

// Carrying its own team's flag: Roger drops it by upstream's x comparison, Ace
// only on the base.
{
  const base = { x: 100, y: 0, z: 0, radius: 15 };
  const view = makeView({
    self: { x: 50, flag: 'G*', flagIndex: 1, flagTeam: 2, teamColor: 2 },
    myBase: () => base,
  });
  assert.equal(new Roger().think(view).dropFlag, true, 'west of its base is home to Roger');
  assert.equal(new Ace().think(view).dropFlag, false, 'Ace drives home first');
  // On the base he drops it -- but on the move, never standing: a flag let go
  // under a standing tank is picked straight back up.
  const onBase = (now, speed) => makeView({
    now,
    self: { x: 95, flag: 'G*', flagIndex: 1, flagTeam: 2, teamColor: 2, speed },
    myBase: () => base,
  });
  const ace = new Ace();
  const standing = ace.think(onBase(100, 0));
  assert.equal(standing.dropFlag, false, 'not from a standstill');
  assert.equal(standing.speed, 1, 'he gets moving first');
  // Roger's wander holds its last move for a second before it asks again.
  const moving = ace.think(onBase(101.1, 25));
  assert.equal(moving.dropFlag, true, 'then lets go');
  // Turning no more than a little as he lets go.
  const turning = {
    view: makeView({ now: 200 }),
    me: { flag: 'G*', speed: 25, inAir: false },
    out: { speed: 0, rotation: 1, dropFlag: true },
  };
  new Ace().dropOnTheMove(turning);
  assert.equal(turning.out.dropFlag, true);
  assert.ok(Math.abs(turning.out.rotation) <= 0.3 && turning.out.speed === 1);
  const after = ace.think(onBase(101.6, 25));
  assert.equal(after.speed, 1, 'and keeps going, leaving it behind');
}

// Carrying a team flag, Ace heads home rather than after a foe -- but still
// shoots one in its sights. Roger chases.
{
  const base = { x: 0, y: -200, z: 0, radius: 15 };
  const view = makeView({
    self: { flag: 'R*', flagIndex: 0, flagTeam: 1, teamColor: 2 },
    players: [enemy(0, 150)],
    myBase: () => base,
  });
  const ace = new Ace().think(view);
  assert.equal(ace.targetId, null, 'Ace does not chase');
  assert.equal(ace.fire, true, 'but still fires');
  assert.ok(Math.abs(ace.rotation) > 1, 'and turns for home, behind it');
  assert.equal(new Roger().think(view).targetId, 'foe', 'Roger chases');
}

// A jumper, frame by frame: Ace fires once, at the moment that puts the shot on
// the spot as the tank comes down through the muzzle's height. His own speed is
// part of the shot's, so he backs off to fire a near one sooner, while it is
// still high, and drives at a far one to reach it before touchdown. Roger, whose
// trigger skips a tank out of his height band, waits until it is nearly down.
{
  const g = 9.8;
  const jumpVelocity = 19;
  const muzzleHeight = 1.57;
  const shotSpeed = 100;
  const tankSpeed = 25;
  const frame = 1 / 30;
  const run = (pilot, north) => {
    const fires = [];
    // Up to just past the landing: a shot that hit would have ended it there.
    for (let t = 0; t < 4.3; t += frame) {
      const z = Math.max(0, (jumpVelocity * t) - (0.5 * g * t * t));
      const airborne = z > 0 || t === 0;
      const view = makeView({
        now: 100 + t,
        self: { muzzleHeight, muzzleForward: 3, shotSpeed },
        world: { tankAngVel: Math.PI / 4 },
        players: [enemy(0, north, {
          z, airborne, gravity: g, vz: airborne ? jumpVelocity - (g * t) : 0,
        })],
      });
      const out = pilot.think(view);
      if (out.fire) fires.push({ t, speed: out.speed * tankSpeed });
    }
    return fires;
  };
  const landsAt = (2 * jumpVelocity) / g;
  const enterAt = (jumpVelocity + Math.sqrt((jumpVelocity ** 2) - (2 * g * muzzleHeight))) / g;
  const check = (north, label) => {
    const fires = run(new Ace(), north);
    assert.equal(fires.length, 1, `${label}: one shot for one jump, got ${fires.length}`);
    const [{ t, speed }] = fires;
    const arrival = t + ((north - 3 - 2) / (shotSpeed + speed));
    assert.ok(arrival >= enterAt - frame && arrival <= landsAt + 0.05,
      `${label}: shot arrives at ${arrival.toFixed(3)}s, tank is in its path from ${enterAt.toFixed(3)} to ${landsAt.toFixed(3)}`);
    return fires[0];
  };
  const near = check(120, 'near');
  assert.ok(near.speed < 0, `backs off to fire a near jumper sooner (speed ${near.speed})`);
  const standing = landsAt - ((120 - 3 - 2) / shotSpeed);
  assert.ok(near.t < standing - 0.1, `fires at ${near.t.toFixed(2)}s, not ${standing.toFixed(2)}s`);
  const far = check(430, 'far');
  assert.ok(far.speed > 0, `drives at a far jumper to reach it in time (speed ${far.speed})`);
  const roger = run(new Roger(), 120);
  assert.ok(roger.length === 0 || roger[0].t > near.t, 'Roger fires later, if at all');
}

// In the air his velocity is the one he left with: the shot bends off the
// barrel by however much of it is across the line, and he turns into it.
{
  const ace = new Ace();
  const ctx = {
    view: makeView({ self: { shotSpeed: 100 } }),
    me: { x: 0, y: 0, z: 5, inAir: true, vx: 0, vy: 20, flag: null, shotSpeed: 100 },
  };
  const shot = ace.shotToward(ctx, { x: 100, y: 0 }, 0);
  const vx = Math.cos(shot.azimuth) * 100;
  const vy = 20 + (Math.sin(shot.azimuth) * 100);
  assert.ok(Math.abs(vy) < 1e-9 && vx > 0, 'the shot itself flies straight at the point');
  assert.ok(Math.abs(shot.speed - vx) < 1e-9);
}

// A ricochet that comes straight back: a wall square across Ace's sights, the
// foe beyond its edge in plain view. With ricochet on, the shot would bounce
// off the wall into him, so he holds fire; Roger shoots and finds out.
{
  const wall = {
    type: 'box', name: 'wall', pos: [0, 20, 0], size: [30, 1, 10], angle: 0,
  };
  const probes = createWorldProbes({
    obstacles: () => [wall],
    colliders: () => [wall],
    mapSize: () => 800,
    findImpact: findShotSegmentImpact,
    topOf: (obs) => obs.pos[2] + obs.size[2],
  });
  const view = (ricochet) => makeView({
    self: { muzzleHeight: 1.57, muzzleForward: 3, shotSpeed: 100, shotLifetime: 3.5, ricochet },
    players: [enemy(0, 150)],
    ...probes,
    isObscured: () => false,
  });
  assert.equal(new Ace().think(view(true)).fire, false, 'Ace holds a shot that would come back');
  assert.equal(new Ace().think(view(false)).fire, true, 'without ricochet it cannot come back');
  assert.equal(new Roger().think(view(true)).fire, true, 'Roger fires anyway');
}

// A foe near a capture is fought where it stands, from 50 until it is past 75
// -- the gap keeps Ace from flipping between the two -- and only one he could
// shoot: a foe behind a wall is no reason to stop.
{
  const redFlag = { index: 0, type: 'R*', team: 1, onGround: true, x: 300, y: 0, z: 0 };
  const view = (north, extra = {}) => makeView({
    self: { teamColor: 2 },
    players: [enemy(0, north)],
    flags: [redFlag],
    world: { teamFlags: true },
    myBase: () => ({ x: -300, y: 0, z: 0, radius: 15 }),
    ...extra,
  });
  const ace = new Ace();
  assert.equal(ace.think(view(40)).intent.mode, 'fight');
  assert.equal(ace.think(view(60)).intent.mode, 'fight', 'kept until it is past 75');
  assert.equal(ace.think(view(80)).intent.mode, 'capture');
  assert.equal(ace.think(view(60)).intent.mode, 'capture', 'and not taken up again short of 50');
  assert.equal(new Ace().think(view(40, { isObscured: () => true })).intent.mode, 'capture');
}

// Grinding: asked for full speed, covering a unit and a half a second -- a
// tank against a wall it meets at a slant. Ace measures that as stuck and
// backs off, then drives on at a new heading; nothing near him is a wall to
// his look-ahead, so only the measurement can tell.
{
  const ace = new Ace();
  const modes = [];
  for (let i = 0; i < 40; i++) {
    const out = ace.think(makeView({ now: 100 + (i / 30), self: { x: i * 0.05 } }));
    modes.push(out.intent.mode);
    if (out.intent.mode === 'unstick') assert.ok(out.speed < 0 || out.speed === 1);
  }
  assert.ok(modes.includes('unstick'), `grinding is caught: ${[...new Set(modes)]}`);
  assert.equal(ace.stats.unsticks, 1);
  // Driving freely is not.
  const free = new Ace();
  for (let i = 0; i < 40; i++) {
    free.think(makeView({ now: 100 + (i / 30), self: { x: i * (25 / 30) } }));
  }
  assert.equal(free.stats.unsticks, 0);
}

// Holding Oscillation Overthruster, a jump onto a building goes into it
// rather than onto it, so Ace jumps and lets the flag go once he is off the
// ground -- it falls back where he left, a level below where he lands.
{
  const ace = new Ace();
  const ctx = {
    view: makeView({}),
    me: { flag: 'OO', x: 0, y: 0, z: 0, inAir: false },
    out: { speed: 0, rotation: 0, jump: false, dropFlag: false },
  };
  ace.takeJump(ctx, 8, 14);
  assert.equal(ctx.out.jump, true, 'the jump is taken with the flag');
  assert.equal(ctx.out.dropFlag, false, 'and the flag kept on the ground');
  const air = { ...ctx, me: { ...ctx.me, inAir: true }, out: { dropFlag: false } };
  ace.dropHardFlags(air);
  assert.equal(air.out.dropFlag, true, 'then dropped in the air');
  const landed = { ...ctx, me: { ...ctx.me, inAir: false }, out: { dropFlag: false } };
  ace.dropHardFlags(landed);
  assert.equal(landed.out.dropFlag, false);
  assert.equal(ace.shedOnTakeoff, false, 'and forgotten on landing');
}

// Holding Agility, a jump of more than its threshold in asked-for speed sets
// off a burst the jump would leave with, so Ace steps his speed up instead and
// holds the jump until he is there.
{
  const ace = new Ace();
  const out = { speed: 1, rotation: 0, jump: true, intent: { mode: 'capture' } };
  ace.paceAgility(makeView({ now: 100, self: { flag: 'A' } }), out);
  assert.ok(out.speed > 0 && out.speed < 0.3, `a step, not a leap (${out.speed})`);
  assert.equal(out.jump, false, 'and no jump yet');
  const plain = { speed: 1, rotation: 0, jump: true, intent: { mode: 'capture' } };
  new Ace().paceAgility(makeView({ now: 100, self: { flag: null } }), plain);
  assert.equal(plain.speed, 1);
  assert.equal(plain.jump, true, 'without it nothing changes');
}

// A foe jumping up past a platform Ace stands on is caught on the way up: he
// fires so the level shot meets it as its body rises through his muzzle's
// height, before its apex, rather than waiting for it to land.
{
  const ace = new Ace();
  ace.checkProgress = () => {};
  const apex = 19 / 9.8;
  let firedAt = null;
  for (let t = 0; t < 3 && firedAt === null; t += 1 / 20) {
    const h = (19 * t) - (4.9 * t * t);
    const out = ace.think(makeView({
      now: 100 + t,
      self: { z: 30, azimuth: -Math.PI / 2, muzzleHeight: 1.57, muzzleForward: 3, shotSpeed: 100, speed: 0, topSpeed: 25 },
      world: { maxShots: 5, tankAngVel: Math.PI / 4 },
      players: [enemy(0, -67, { z: 15 + h, airborne: true, gravity: 9.8, vz: 19 - (9.8 * t) })],
    }));
    if (out.fire) firedAt = t;
  }
  assert.ok(firedAt !== null && firedAt < apex, `fires on the way up (${firedAt?.toFixed(2)}s, apex ${apex.toFixed(2)}s)`);
}

// Capture the flag: holding a good superflag, with a foe 100 away and the red
// flag far off to the east, Ace goes for the flag and Roger for the foe. In
// reach of it, Ace lets go of the superflag to make room.
{
  const redFlag = { index: 0, type: 'R*', team: 1, onGround: true, x: 300, y: 0, z: 0 };
  const view = (x, speed = 0) => makeView({
    self: { x, flag: 'V', flagIndex: 9, teamColor: 2, speed },
    players: [enemy(x, 100)],
    flags: [redFlag],
    world: { teamFlags: true },
    myBase: () => ({ x: -300, y: 0, z: 0, radius: 15 }),
  });
  const ace = new Ace().think(view(0));
  assert.equal(ace.targetId, null, 'Ace leaves the foe');
  assert.ok(ace.rotation < -1, 'and turns east for the flag');
  assert.equal(new Roger().think(view(0)).targetId, 'foe', 'Roger chases');
  assert.equal(new Ace().think(view(295, 25)).dropFlag, true, 'drops V to take the flag, on the move');
}

// A raised flag: one a jump reaches is jumped for when the edge is in the
// window, one too high is left alone.
{
  const flagAt = (height) => ({ index: 0, type: 'R*', team: 1, onGround: true, x: 0, y: 40, z: height });
  const view = (height, edgeDistance) => makeView({
    self: { teamColor: 2 },
    flags: [flagAt(height)],
    world: { teamFlags: true },
    myBase: () => ({ x: 0, y: -300, z: 0, radius: 15 }),
    firstBuilding: () => ({ isBox: true, top: height, distance: edgeDistance }),
  });
  const near = new Ace().think(view(5, 15));
  assert.equal(near.jump, true, 'jumps for a flag 5 up with the edge 15 ahead');
  assert.equal(new Ace().think(view(5, 2)).jump, false, 'too close to clear the corner');
  const high = new Ace().think(view(30, 15));
  assert.equal(high.jump, false, 'a flag out of reach is not tried');
  assert.ok(Math.abs(high.rotation) > 0 || high.speed !== near.speed, 'and Ace does something else');
}

// The intent: what the pilot is doing, for a client to draw and a log to read.
{
  const chase = new Roger().think(makeView({ players: [enemy(0, 150)] }));
  assert.equal(chase.intent.mode, 'chase');
  assert.equal(chase.intent.target.id, 'foe');
  assert.ok(Math.abs(chase.intent.target.y - 150) < 1e-9, 'the target is where the foe is');
  assert.ok(chase.intent.shot && Math.abs(chase.intent.shot.dir.y - 1) < 1e-9, 'a shot fired north');

  const wander = new Roger().think(makeView());
  assert.equal(wander.intent.mode, 'wander');
  assert.equal(wander.intent.target, null);

  const redFlag = { index: 0, type: 'R*', team: 1, onGround: true, x: 300, y: 0, z: 0 };
  const ace = new Ace();
  const capture = ace.think(makeView({
    self: { teamColor: 2 },
    flags: [redFlag],
    world: { teamFlags: true },
    myBase: () => ({ x: -300, y: 0, z: 0, radius: 15 }),
    findRoute: () => [{ x: 4, y: 0, z: 0, jump: false }, { x: 300, y: 0, z: 0, jump: false }],
  }));
  assert.equal(capture.intent.mode, 'capture');
  assert.equal(capture.intent.target.flag, 'R*');
  assert.equal(capture.intent.route.length, 2, 'the route left to drive');

  const report = ace.takeReport();
  assert.match(report, /^capture 100%; shots 0, jumps 0, falls 0, routes 1 \(0 none\)/);
  assert.match(ace.takeReport(), /^idle;/, 'a report starts the count again');
}

// Staying alive: a shot from the side is driven out of the way, not jumped;
// one too close to drive clear of is jumped; one head-on cannot be driven out
// of and is jumped too.
{
  const fromEast = (distance) => ({
    ownerId: 'foe', ownerZoned: false, flag: null, x: distance, y: 0, z: 1, vx: -100, vy: 0, vz: 0,
  });
  const side = new Ace().think(makeView({ shots: [fromEast(40)] }));
  assert.equal(side.intent.mode, 'dodge');
  assert.equal(side.jump, false, 'a shot from the side is driven out of');
  assert.equal(side.speed, 1, 'forward, which is across its line');

  const close = new Ace().think(makeView({ shots: [fromEast(12)] }));
  assert.equal(close.jump, true, 'too close to drive clear of: jump');

  const headOn = { ownerId: 'foe', ownerZoned: false, flag: null, x: 0, y: 40, z: 1, vx: 0, vy: -100, vz: 0 };
  assert.equal(new Ace().think(makeView({ shots: [headOn] })).jump, true, 'head-on: no way across, so up');

  const wide = { ...fromEast(40), y: 10 };
  assert.notEqual(new Ace().think(makeView({ shots: [wide] })).intent.mode, 'dodge', 'a shot that misses is ignored');
}

// The antidote: carrying a bad flag with no shake-off, Ace goes to it before
// anything else but dodging; with a quick shake-off, he waits it out.
{
  const view = (shakeTimeout) => makeView({
    self: { flag: 'B', flagIndex: 5 },
    players: [enemy(0, 150)],
    world: { shakeTimeout },
    antidote: { x: 100, y: 0, z: 0 },
  });
  const going = new Ace().think(view(0));
  assert.equal(going.intent.mode, 'antidote');
  assert.ok(going.rotation < 0, 'east of a north-facing tank is a right turn');
  assert.equal(new Ace().think(view(2)).intent.mode, 'chase', 'two seconds is sooner than the drive');
  assert.equal(new Ace().think(view(60)).intent.mode, 'antidote', 'a minute is not');
}

// Rabbit Chase. A hunter goes after the rabbit wherever it is, not only inside
// Roger's 250 units.
{
  const out = new Ace().think(makeView({
    self: { team: 'hunter' },
    players: [enemy(0, 600, { team: 'rabbit' })],
  }));
  assert.equal(out.intent.mode, 'hunt', 'a far rabbit is hunted');
  assert.equal(out.targetId, 'foe');
  assert.ok(out.speed > 0, 'and driven towards');
}
// The rabbit runs from a hunter that is near but not coming for it...
{
  const out = new Ace().think(makeView({
    self: { team: 'rabbit' },
    players: [enemy(0, 50, { team: 'hunter' })],
  }));
  assert.equal(out.intent.mode, 'flee', 'a near hunter is run from');
  assert.ok(out.intent.target.y < 0, 'away from it, south when it is north');
}
// ...turns on one that is closing on it...
{
  const out = new Ace().think(makeView({
    self: { team: 'rabbit' },
    players: [enemy(0, 50, { team: 'hunter', vy: -20 })],
  }));
  assert.equal(out.intent.mode, 'chase', 'a hunter coming for the rabbit is fought');
  assert.equal(out.targetId, 'foe');
}
// ...and pays no mind to one far off.
{
  const out = new Ace().think(makeView({
    self: { team: 'rabbit' },
    players: [enemy(0, 400, { team: 'hunter' })],
  }));
  assert.notEqual(out.intent.mode, 'flee', 'a hunter out of range is not run from');
}

// On a server that allows several shots, Ace keeps some back: five slots
// fire three and keep two, spent only on a foe close enough to need them.
{
  const view = (freeShots, north) => makeView({
    self: { freeShots },
    world: { maxShots: 5 },
    players: [enemy(0, north)],
  });
  assert.equal(new Ace().think(view(3, 150)).fire, true, 'a third shot goes');
  assert.equal(new Ace().think(view(2, 150)).fire, false, 'the last two are kept from a far foe');
  assert.equal(new Ace().think(view(2, 40)).fire, true, 'and spent on a close one');
  const single = makeView({ self: { freeShots: 1 }, world: { maxShots: 1 }, players: [enemy(0, 150)] });
  assert.equal(new Ace().think(single).fire, true, 'a single slot has nothing to keep');
}
// A kept shot is spent on a landing shot: a tank coming down cannot dodge.
{
  const pilot = new Ace();
  let fired = 0;
  for (let t = 0; t < 4.3; t += 1 / 30) {
    const z = Math.max(0, (19 * t) - (0.5 * 9.8 * t * t));
    const airborne = z > 0 || t === 0;
    const out = pilot.think(makeView({
      now: 100 + t,
      self: { muzzleHeight: 1.57, muzzleForward: 3, shotSpeed: 100, freeShots: 2 },
      world: { maxShots: 5, tankAngVel: Math.PI / 4 },
      players: [enemy(0, 120, { z, airborne, gravity: 9.8, vz: airborne ? 19 - (9.8 * t) : 0 })],
    }));
    if (out.fire) fired += 1;
  }
  assert.equal(fired, 1, 'the landing shot is fired from the kept ones');
}

console.log('autopilot tests passed');
