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
import { Ace, Roger, createWorldProbes, findVantagePoints } from '../public/autopilot.mjs';
import { findShotSegmentImpact } from '../public/collision.mjs';
import { buildNavGraph } from '../public/nav.mjs';

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
  assert.equal(pilot.knownFlagTypes.get(7).type, 'B');
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
  // Head on there is no driving clear, and underground no jumping either: no
  // dodge to stand still in.
  const headOn = new Ace().think(makeView({ self: { flag: 'BU', z: -1.32 }, players: [enemy(0, 20, { vy: -20 })] }));
  assert.equal(headOn.jump, false, 'head on, no jump out of the ground');
  assert.notEqual(headOn.intent.mode, 'dodge', 'and no dodge');
  // A tank crossing on a deck above passes over him: not a threat at all.
  const overhead = new Ace().think(makeView({
    self: { flag: 'BU', z: -1.32 }, players: [enemy(-20, 6, { vx: 20, z: 15 })],
  }));
  assert.notEqual(overhead.intent.mode, 'dodge', 'a tank on a deck above is nothing to dodge');
}

// A burrowed foe is under every shell, so the kill is driving over him.
// Close behind -- come down past him from a jump -- Ace backs over him rather
// than spend four seconds turning round; ahead, or far enough behind that the
// turn pays for itself, he drives forward as Roger does.
{
  const burrowed = (x, y) => enemy(x, y, { flag: 'BU', z: -1.32 });
  const behind = new Ace().think(makeView({ players: [burrowed(0, -30)] }));
  assert.equal(behind.intent.reason, 'run-over');
  assert.ok(behind.speed < 0, `backs over him (speed ${behind.speed})`);
  assert.ok(Math.abs(behind.rotation) < 0.1, 'without turning');
  const ahead = new Ace().think(makeView({ players: [burrowed(0, 30)] }));
  assert.notEqual(ahead.intent.reason, 'run-over', 'ahead, the chase as before');
  const far = new Ace().think(makeView({ players: [burrowed(0, -240)] }));
  assert.notEqual(far.intent.reason, 'run-over', 'far behind, the turn pays');
  const standing = new Ace().think(makeView({ players: [enemy(0, -30)] }));
  assert.notEqual(standing.intent.reason, 'run-over', 'a foe above ground is shot, so faced');
}

// A landing shot from a low muzzle -- burrowed, 0.25 up -- has a window of a
// hundredth of a second. Ace picks his speed to land it in the middle of the
// window, not on its edge, where a late track of the foe makes it a miss.
{
  const ace = new Ace();
  const ctx = {
    view: { world: { shotSpeed: 100 } },
    me: { x: 0, y: 0, z: -1.32, azimuth: Math.PI / 2, inAir: false, flag: 'BU', shotSpeed: 100 },
  };
  const plan = { landing: { x: 0, y: 160, z: 0, t: 1.7 }, reach: 160, enter: 1.69 };
  const range = { low: -10, high: 20, top: 20 };
  // At -5.88 the shot takes 1.7 s: touchdown exactly, the window's last instant.
  const shot = ace.landingShotSpeed(ctx, plan, -5.88, range);
  assert.ok(Number.isFinite(shot.speed), 'a shot');
  assert.ok(shot.flight > plan.enter + 0.002 && shot.flight < plan.landing.t - 0.002,
    `inside the window, not on its edge (${shot.flight})`);
}

// Campers. A rogue killed twice by a foe holding a flag to camp with marks
// him: hunted wherever he is. With his flag's shots all but spent he is waited
// out -- unless Ace holds what beats it. In team play the kills are on Ace's
// side and the camper must lead every other tank by three.
{
  const camper = (extra = {}) => enemy(0, 400, { id: 'gm', flag: 'GM', flagIndex: 7, score: 6, ...extra });
  const kills = [
    { killerId: 'gm', victimId: 'me', flag: 'GM', at: 50 },
    { killerId: 'gm', victimId: 'me', flag: 'GM', at: 80 },
  ];
  const rogue = { team: 'rogue', score: 0 };
  const hunted = new Ace().think(makeView({ self: rogue, players: [camper()], kills }));
  assert.equal(hunted.intent.reason, 'camper', `a rogue hunts the camper (${hunted.intent.reason})`);
  assert.equal(hunted.targetId, 'gm');

  const once = new Ace().think(makeView({ self: rogue, players: [camper()], kills: kills.slice(1) }));
  assert.notEqual(once.intent.reason, 'camper', 'one kill is not camping');
  const stale = new Ace().think(makeView({ now: 400, self: rogue, players: [camper()], kills }));
  assert.notEqual(stale.intent.reason, 'camper', 'nor kills long ago');

  // Eight of his ten shots fired since he took the flag: wait him out.
  const fired = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, ownerId: 'gm' }));
  const spent = { self: rogue, players: [camper()], kills, fired, world: { shotLimits: { GM: 10 } } };
  const waiting = new Ace().think(makeView(spent));
  assert.notEqual(waiting.intent.reason, 'camper', 'a spent flag is waited out');
  const stealthy = new Ace().think(makeView({ ...spent, self: { ...rogue, flag: 'ST' } }));
  assert.equal(stealthy.intent.reason, 'camper', 'unless Ace holds Stealth, which no missile locks on');
  // A fresh flag starts the count again.
  const counting = new Ace();
  counting.think(makeView(spent));
  const fresh = counting.think(makeView({ ...spent, now: 100.1, fired: [], players: [camper({ flagIndex: 8 })] }));
  assert.equal(fresh.intent.reason, 'camper', 'a new flag has all its shots');

  // Team play: two of Ace's side killed, and three clear of every other tank.
  const mate = { ...enemy(10, 10, { id: 'mate', team: 'blue', score: 0 }) };
  const teamKills = [
    { killerId: 'gm', victimId: 'mate', flag: 'GM', at: 50 },
    { killerId: 'gm', victimId: 'me', flag: 'GM', at: 80 },
  ];
  const team = (score) => makeView({
    self: { team: 'blue', score: 0 },
    players: [camper({ score }), mate],
    kills: teamKills,
    isFoe: (p) => p.team !== 'blue',
  });
  assert.equal(new Ace().think(team(6)).intent.reason, 'camper', 'clear on score, a camper');
  assert.notEqual(new Ace().think(team(2)).intent.reason, 'camper', 'not clear, not yet');
}

// What beats a camper's flag is gone for ahead of a nearer flag.
{
  const kills = [
    { killerId: 'gm', victimId: 'me', flag: 'GM', at: 50 },
    { killerId: 'gm', victimId: 'me', flag: 'GM', at: 80 },
  ];
  const ace = new Ace();
  ace.knownFlagTypes.set(2, { type: 'ST' });
  const out = ace.think(makeView({
    self: { team: 'rogue', score: 0 },
    players: [enemy(0, 600, { id: 'gm', flag: 'GM', flagIndex: 7, score: 6, alive: false })],
    kills,
    flags: [
      { index: 1, type: null, team: null, onGround: true, x: 30, y: 0, z: 0 },
      { index: 2, type: null, team: null, onGround: true, x: -50, y: 0, z: 0 },
    ],
  }));
  assert.equal(out.intent.target?.x, -50, `Stealth over a nearer unknown (${JSON.stringify(out.intent.target)})`);
}

// Reversed Controls: what Ace asks for is negated before the tank reads it,
// so he asks for the opposite, and the tank does what he meant.
{
  const view = (flag) => makeView({ self: { flag }, players: [enemy(40, 150)] });
  const plain = new Ace().think(view(null));
  const reversed = new Ace().think(view('RC'));
  assert.ok(plain.speed > 0, 'a foe ahead is driven at');
  assert.equal(reversed.speed, -plain.speed, 'reversed, the stick goes the other way');
  assert.equal(reversed.rotation, -plain.rotation);
}

// A foe circling at speed is tracked, not trailed. Driving after one going
// round a sixty-unit circle at full speed, Roger's stick -- the angle as a
// share of a turn -- leaves Ace over a third of a radian behind and shooting
// now and then; the sights stay on where the shot meets him, and it goes.
{
  const ace = new Ace();
  const rate = Math.PI / 4;
  const radius = 60;
  let x = 0;
  let y = -radius - 45;
  let azimuth = 0.6;
  let lastShot = -Infinity;
  let shots = 0;
  const offs = [];
  for (let frame = 0; frame < 300; frame++) {
    const t = frame / 30;
    const a = (-Math.PI / 2) + ((25 / radius) * t);
    const foe = enemy(radius * Math.cos(a), radius * Math.sin(a), { vx: -25 * Math.sin(a), vy: 25 * Math.cos(a) });
    const out = ace.think(makeView({
      now: 100 + t,
      self: { x, y, azimuth, turnRate: rate, shotSpeed: 100, shotLifetime: 3.5, canFire: t - lastShot > 0.7 },
      players: [foe],
      world: { maxShots: 5 },
    }));
    if (out.fire) lastShot = t;
    const speed = Math.max(-0.5, Math.min(1, out.speed)) * 25;
    azimuth += Math.max(-1, Math.min(1, out.rotation)) * rate / 30;
    x += Math.cos(azimuth) * speed / 30;
    y += Math.sin(azimuth) * speed / 30;
    if (frame < 60) continue;
    const lead = Math.hypot(foe.x - x, foe.y - y) / 100;
    const aim = Math.atan2(foe.y + (foe.vy * lead) - y, foe.x + (foe.vx * lead) - x);
    offs.push(Math.abs(Math.atan2(Math.sin(aim - azimuth), Math.cos(aim - azimuth))));
    if (out.fire) shots++;
  }
  offs.sort((p, q) => p - q);
  assert.ok(offs[offs.length >> 1] < 0.15, `the sights on him, ${offs[offs.length >> 1].toFixed(2)} off`);
  assert.ok(shots > 15, `and shooting (${shots})`);
}

// A dodge before a jump, always: a shot coming straight down his heading,
// which no speed along it escapes, is turned out of; a jump is only for a
// shot nothing on the ground clears in time -- even with its shooter loaded
// and watching where he comes down, since the shot is certain.
{
  const view = (y) => makeView({
    shots: [{ ownerId: 'foe', ownerZoned: false, flag: null, x: 0, y, z: 1.5, vx: 0, vy: -100, vz: 0 }],
    players: [enemy(0, y + 50)],
    fired: [{ id: 's1', ownerId: 'foe' }],
    world: { maxShots: 3 },
  });
  const far = new Ace().think(view(100));
  assert.equal(far.intent.mode, 'dodge');
  assert.equal(far.jump, false, 'a shot a second away is driven out of');
  assert.notEqual(far.rotation, 0, 'by turning off its line');
  const near = new Ace().think(view(12));
  assert.equal(near.jump, true, 'one with no time to drive clear is jumped');
}

// A jump he cannot avoid is turned on the way up, so that coming down his
// sights are on the shooter as his muzzle falls to the shooter's height --
// and he fires then, from the air, before the landing the shooter waits for.
{
  const foe = enemy(60, 0);
  const self = { muzzleHeight: 1.57, muzzleForward: 3, shotSpeed: 100, shotLifetime: 3.5, turnRate: Math.PI / 4 };
  const shot = { ownerId: 'foe', ownerZoned: false, flag: null, x: 12, y: 0, z: 1.5, vx: -100, vy: 0, vz: 0 };
  const ace = new Ace();
  const takeoff = ace.think(makeView({ self, players: [foe], shots: [shot], world: { maxShots: 5 } }));
  assert.equal(takeoff.jump, true);
  assert.ok(takeoff.rotation < 0, 'turning right, toward the shooter');
  let azimuth = Math.PI / 2;
  let z = 0;
  let vz = 19;
  let firedAt = null;
  for (let frame = 1; frame < 300 && firedAt === null; frame++) {
    const dt = 1 / 60;
    azimuth += takeoff.rotation * (Math.PI / 4) * dt;
    z += vz * dt;
    vz -= 9.8 * dt;
    if (z <= 0) break;
    const out = ace.think(makeView({
      now: 100 + (frame * dt),
      self: { ...self, azimuth, z, inAir: true, velocity: { x: 0, y: 0, z: vz } },
      players: [foe],
      world: { maxShots: 5 },
    }));
    if (out.fire) firedAt = { z, off: Math.abs(Math.atan2(Math.sin(azimuth), Math.cos(azimuth))) };
  }
  assert.ok(firedAt, 'a shot from the air before the landing');
  assert.ok(firedAt.off < 0.05, `on him (${firedAt?.off})`);
}

// A bad flag cannot be dropped -- only shaken off by its countdown, a kill or
// an antidote -- so Ace never asks to, even beside a flag he would rather have.
{
  const view = (flag) => makeView({
    self: { flag, speed: 25 },
    flags: [{ index: 1, type: 'GM', team: null, onGround: true, x: 0, y: 5, z: 0 }],
  });
  assert.equal(new Ace().think(view('V')).dropFlag, true, 'a good flag goes for a Guided Missile');
  const stuck = new Ace().think(view('RT'));
  assert.equal(stuck.dropFlag, false, 'Right Turn Only does not');
  const still = new Ace().think(makeView({
    self: { flag: 'RT', speed: 0 },
    flags: [{ index: 1, type: 'GM', team: null, onGround: true, x: 0, y: 5, z: 0 }],
  }));
  assert.equal(still.dropFlag, false, 'nor drives off to drop it at speed');
}

// A shot is a threat where it meets the path he is on, not where he stands.
// Driving north at full speed: one crossing 12.5 ahead meets him in half a
// second, so he stops short of it; one crossing where he is now passes
// behind him, so he drives on and does not jump.
{
  const driving = { velocity: { x: 0, y: 25, z: 0 }, speed: 25 };
  const shot = (y) => ({ ownerId: 'foe', ownerZoned: false, flag: null, x: -50, y, z: 1, vx: 100, vy: 0, vz: 0 });
  const ahead = new Ace().think(makeView({ self: driving, shots: [shot(12.5)] }));
  assert.equal(ahead.intent.mode, 'dodge', 'the shot ahead is dodged');
  assert.ok(ahead.speed < 1, `by not driving into it (speed ${ahead.speed})`);
  assert.equal(ahead.jump, false, 'without a jump');
  const behind = new Ace().think(makeView({ self: driving, shots: [shot(0)] }));
  assert.notEqual(behind.intent.mode, 'dodge', 'a shot he is driving clear of is left alone');
  assert.equal(behind.jump, false);
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

// Point blank: burrowed with a wall a hand's breadth past the muzzle, the
// shot is back in a hundredth of a second -- Orin killed himself three times
// so. Every bounce counts, however soon.
{
  const wall = {
    type: 'box', name: 'wall', pos: [0, 4.6, 0], size: [30, 1, 10], angle: 0,
  };
  const probes = createWorldProbes({
    obstacles: () => [wall],
    colliders: () => [wall],
    mapSize: () => 800,
    findImpact: findShotSegmentImpact,
    topOf: (obs) => obs.pos[2] + obs.size[2],
  });
  const out = new Ace().think(makeView({
    self: {
      z: -1.32, flag: 'BU', muzzleHeight: 1.57, muzzleForward: 3, shotSpeed: 100, shotLifetime: 3.5, ricochet: true,
    },
    players: [enemy(0, 150)],
    ...probes,
    isObscured: () => false,
  }));
  assert.equal(out.fire, false, 'a wall at point blank sends it straight back');
}

// A landing behind a wall is shot off another: with ricochet on, Ace finds
// the heading that bounces off the long wall beside it into the touchdown,
// times it, and fires -- no line of sight needed.
{
  const box = (name, x, y, w, d) => ({ type: 'box', name, pos: [x, y, 0], size: [w / 2, d / 2, 10], angle: 0 });
  const obstacles = [box('blocker', 0, 30, 20, 1), box('mirror', 30.5, 30, 1, 120)];
  const probes = createWorldProbes({
    obstacles: () => obstacles,
    colliders: () => obstacles,
    mapSize: () => 800,
    findImpact: findShotSegmentImpact,
    topOf: (obs) => obs.pos[2] + obs.size[2],
  });
  const ace = new Ace();
  let fired = null;
  for (let frame = 0; frame < 60 && !fired; frame++) {
    const t = frame * 0.05;
    const out = ace.think(makeView({
      now: 100 + t,
      self: {
        azimuth: 0.79, muzzleHeight: 1.57, muzzleForward: 3, shotSpeed: 100, shotLifetime: 3.5, ricochet: true,
      },
      players: [enemy(0, 60, { z: 40 - (4.9 * t * t), vz: -9.8 * t, airborne: true, gravity: 9.8 })],
      ...probes,
    }));
    if (out.fire) fired = out;
  }
  assert.ok(fired, 'a bank shot at the landing behind the wall');
  const { dir } = fired.intent.shot;
  assert.ok(Math.abs(Math.atan2(dir.y, dir.x) - Math.atan2(60, 60)) < 0.02, 'off the wall beside it');
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

// A bad flag Ace knows of, lying in his way, is steered round: one the view
// names, as the player's client does once it has seen it, and one he saw
// carried himself. Holding a flag, there is nothing to avoid.
{
  const ahead = (extra) => ({ index: 5, team: null, onGround: true, x: 1, y: 12, z: 0, ...extra });
  const drive = (pilot, flag, self = {}) => pilot.think(makeView({
    self: { x: 0, y: 0, azimuth: Math.PI / 2, ...self }, flags: [flag], players: [enemy(0, 150)],
  }));
  const plain = drive(new Ace(), ahead({ type: null }));
  assert.ok(plain.speed > 0 && Math.abs(plain.rotation) < 0.5, 'an unknown flag is driven over');
  const named = drive(new Ace(), ahead({ type: 'B' }));
  assert.ok(named.rotation > 0.5, `a known Blindness flag on the right is passed on the left (${named.rotation})`);
  const pilot = new Ace();
  pilot.knownFlagTypes.set(5, { type: 'RC', at: null });
  assert.ok(drive(pilot, ahead({ type: null, x: -1 })).rotation < -0.5, 'one he saw carried, on the left, is passed on the right');
  const holding = drive(new Ace(), ahead({ type: 'B' }), { flag: 'V', flagIndex: 9 });
  assert.ok(Math.abs(holding.rotation) < 0.5, 'holding a flag, nothing is taken');
  const behind = drive(new Ace(), ahead({ type: 'B', y: -20 }));
  assert.ok(Math.abs(behind.rotation) < 0.5, 'nor is one behind him in the way');
}

// Identify is kept, and traded only for a flag worth it that it has named;
// a type learnt is forgotten once the flag turns up somewhere new.
{
  const at = (index, extra) => ({ index, team: null, onGround: true, x: 0, y: 30, z: 0, type: null, ...extra });
  const holding = (flags, pilot = new Ace()) => pilot.think(makeView({ self: { flag: 'ID', flagIndex: 9 }, flags }));
  assert.equal(holding([]).dropFlag, false, 'Identify is not dropped');
  assert.ok(!['flag', 'hunt-flag'].includes(holding([at(1)]).intent.mode), 'nor traded for a flag it cannot name');
  const trade = holding([at(1, { type: 'SW' })]);
  assert.equal(trade.intent.mode, 'flag', 'but traded for Shock Wave');
  const pilot = new Ace();
  holding([at(2, { type: 'B' })], pilot);
  assert.equal(pilot.knownType(at(2)), 'B', 'what Identify named is remembered');
  holding([at(2, { x: 200 })], pilot);
  assert.equal(pilot.knownType(at(2)), null, 'until the flag is somewhere new');
  const idFlag = at(3, { type: 'ID' });
  const want = (score) => new Ace().think(makeView({ self: { score }, flags: [idFlag], players: [enemy(0, 600, { score: 2 })] }));
  assert.notEqual(want(0).intent.mode, 'flag', 'Identify is no errand while behind');
  assert.equal(want(5).intent.mode, 'flag', 'and one while ahead');
}

// A level shot leaves at the muzzle's height: a foe on a step above, or
// below, is not shot at, Super Bullet or not; one on Ace's level is.
{
  const at = (z, flag = 'SB') => new Ace().think(makeView({
    self: { flag, muzzleHeight: 1.57, shotSpeed: 100, shotLifetime: 3.5 }, players: [enemy(0, 80, { z })],
  }));
  assert.equal(at(0).fire, true, 'level');
  assert.equal(at(3).fire, false, 'a step above');
  assert.equal(at(-2).fire, false, 'a step below');
  assert.equal(at(3, 'GM').fire, true, 'a Guided Missile climbs to it');
}

// A jump whose landing a foe covers is gone round on the ground, when that
// is not much further; one nobody covers, or with no way round, is jumped.
{
  const jumping = [{ x: 0, y: 20, z: 0 }, { x: 0, y: 40, z: 15, jump: true }, { x: 0, y: 60, z: 15 }];
  const round = [{ x: 40, y: 20, z: 0 }, { x: 40, y: 60, z: 15 }, { x: 0, y: 60, z: 15 }];
  const route = (players, ground = round) => {
    const pilot = new Ace();
    pilot.plan(makeView({
      players,
      findRoute: (from, to, { canJump }) => (canJump ? jumping : ground),
    }), { x: 0, y: 0, z: 0 }, { x: 0, y: 60, z: 15 });
    return pilot.route.nodes;
  };
  assert.equal(route([]), jumping, 'nobody covering it, the jump');
  assert.equal(route([enemy(0, 120, { z: 15 })]), round, 'a foe on the landing\'s level, round');
  assert.equal(route([enemy(0, 120, { z: 0 })]), jumping, 'one on another level cannot shoot it');
  assert.equal(route([enemy(0, 120, { z: 15 })], null), jumping, 'no way round, the jump');
}

// His own flag home: on the edge of his base he drives on to the middle
// rather than put it down where he came in, and puts it down there.
{
  const base = { team: 0, x: 0, y: 340, z: 30, halfWidth: 35, halfDepth: 35, rotation: Math.PI / 4 };
  const home = (x, y) => new Ace().think(makeView({
    world: { teamFlags: true },
    self: { team: 'red', teamColor: 0, flag: 'R*', flagIndex: 0, flagTeam: 0, x, y, z: 30, speed: 25 },
    myBase: () => ({ x: 0, y: 340, z: 30, radius: 35 }),
    bases: [base],
    findRoute: (from, to) => [{ x: to.x, y: to.y, z: to.z }],
  }));
  const edge = home(17.8, 309.8);
  assert.equal(edge.dropFlag, false, 'not at the edge');
  assert.equal(edge.intent.mode, 'home');
  assert.ok(edge.speed > 0, 'driving on in');
  assert.equal(home(2, 338).dropFlag, true, 'in the middle, down it goes');
}

// Down from a jump a few units short of its planned landing, the jump is
// flown: Ace goes on along the route rather than take it a second time.
{
  const nodes = [
    { x: 0, y: 40, z: 15, jump: true, flight: { jump: true, speed: 1, dx: 0, dy: 1, launch: 0, air: 2.8 } },
    { x: 0, y: 70, z: 15 },
  ];
  const flag = { index: 0, type: 'R*', team: 1, onGround: true, x: 0, y: 70, z: 15 };
  const view = (now, self) => makeView({
    now,
    world: { teamFlags: true },
    flags: [flag],
    self: { teamColor: 2, ...self },
    myBase: () => ({ x: 0, y: -300, z: 0, radius: 15 }),
    findRoute: () => nodes,
  });
  const pilot = new Ace();
  pilot.think(view(100, { y: 30, z: 18, inAir: true }));
  const landed = pilot.think(view(100.05, { y: 37, z: 15, inAir: false, azimuth: Math.PI / 2 }));
  assert.equal(landed.jump, false, 'no second jump');
  assert.equal(landed.intent.route?.[0]?.y, 70, 'on to the next node');
}

// Zones: a flag nobody has named, lying in a zone that spawns one type, is
// taken for that type; and with no foe alive Ace waits by the nearest foe
// spawn zone that is not his own team's.
{
  const zone = (x, y, extra) => ({ x, y, z: 0, halfWidth: 10, halfDepth: 10, rotation: 0, ...extra });
  const pilot = new Ace();
  pilot.think(makeView({ flagZones: [zone(0, 100, { flags: ['GM'] })] }));
  assert.equal(pilot.knownType({ index: 1, x: 3, y: 104, type: null }), 'GM', 'in a GM zone, a GM');
  assert.equal(pilot.knownType({ index: 2, x: 50, y: 104, type: null }), null, 'outside it, unknown');

  const spawnZones = [zone(0, 300, { teams: [1] }), zone(0, -100, { teams: [0] })];
  const dead = enemy(0, 300, { alive: false });
  const far = new Ace().think(makeView({ spawnZones, players: [dead] }));
  assert.equal(far.intent.mode, 'spawn-watch', `heads for the foe's spawn (${far.intent.mode})`);
  assert.equal(far.intent.target.y, 300, 'not his own team\'s');
  const near = new Ace().think(makeView({ spawnZones, players: [dead], self: { y: 260 } }));
  assert.equal(near.speed, 0, 'and waits within a shot of it');
  const alive = new Ace().think(makeView({ spawnZones, players: [enemy(0, 300)] }));
  assert.notEqual(alive.intent.mode, 'spawn-watch', 'not while a foe is alive');
}

// A flag inside a building: the tank goes for it, is held short of it and
// backs off, and on the second back-off gives that flag up.
{
  const ace = new Ace();
  const flag = { index: 7, type: null, team: null, onGround: true, x: 0, y: 12, z: 0 };
  const modes = [];
  for (let i = 0; i < 150; i++) {
    const out = ace.think(makeView({ now: 100 + (i / 30), self: { x: 0, y: 0, azimuth: Math.PI / 2 }, flags: [flag] }));
    modes.push(out.intent.mode);
  }
  assert.equal(modes[0], 'flag');
  assert.ok(ace.stats.unsticks >= 2, `backed off: ${[...new Set(modes)]}`);
  assert.ok(ace.unreachable.get(7) > 104, 'and the flag is given up');
  assert.notEqual(modes.at(-1), 'flag', 'for something else');
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

// A foe jumping who will come down on Ace's level within a shot's reach is
// lined up for ahead of a capture; one coming down on a platform above is
// not.
{
  const redFlag = { index: 0, type: 'R*', team: 1, onGround: true, x: 300, y: 0, z: 0 };
  const view = (landsOn) => makeView({
    self: { teamColor: 2, muzzleHeight: 1.57, muzzleForward: 3, shotSpeed: 100, speed: 0, topSpeed: 25 },
    world: { teamFlags: true, tankAngVel: Math.PI / 4, maxShots: 5 },
    flags: [redFlag],
    myBase: () => ({ x: -300, y: 0, z: 0, radius: 15 }),
    firstHit: (from) => (landsOn > 0 && from.z > landsOn ? { ...from, z: landsOn } : null),
    players: [enemy(0, 120, { z: 8, airborne: true, gravity: 9.8, vz: 5, vx: 0, vy: -10 })],
  });
  const level = new Ace().think(view(0));
  assert.equal(level.intent.mode, 'ambush', `a landing on his level comes first (${level.intent.mode})`);
  assert.equal(level.targetId, 'foe');
  const above = new Ace().think(view(9));
  assert.notEqual(above.intent.mode, 'ambush', 'a landing on a platform above does not');
}

// The score decides how much Ace fights. Losing, a foe in sight 100 away
// turns him from a capture, and one past Roger's range is hunted rather than
// a flag; a foe running away with the game is hunted from across the map.
{
  const redFlag = { index: 0, type: 'R*', team: 1, onGround: true, x: 300, y: 0, z: 0 };
  const capture = (myScore) => new Ace().think(makeView({
    self: { teamColor: 2, score: myScore },
    world: { teamFlags: true },
    flags: [redFlag],
    myBase: () => ({ x: -300, y: 0, z: 0, radius: 15 }),
    players: [enemy(0, 100, { score: 2 }), enemy(-300, 300, { id: 'other', score: 0 })],
  }));
  assert.equal(capture(0).intent.mode, 'capture', 'level on score, the capture');
  const behind = capture(-5);
  assert.notEqual(behind.intent.mode, 'capture', 'losing, the foe');
  assert.equal(behind.targetId, 'foe');

  const flag = { index: 4, type: null, team: null, onGround: true, x: -200, y: 0, z: 0 };
  const far = (myScore) => new Ace().think(makeView({
    self: { score: myScore }, flags: [flag], players: [enemy(0, 300, { score: 1 })],
  }));
  assert.ok(['flag', 'hunt-flag'].includes(far(0).intent.mode), 'level on score, a flag while the foe is far');
  const hunting = far(-4);
  assert.equal(hunting.intent.mode, 'hunt', `losing, the far foe (${hunting.intent.mode})`);
  assert.equal(hunting.intent.reason, 'losing');

  const runaway = (leaderScore) => new Ace().think(makeView({
    self: { teamColor: 2, score: 8 },
    world: { teamFlags: true },
    flags: [redFlag],
    myBase: () => ({ x: -300, y: 0, z: 0, radius: 15 }),
    players: [enemy(0, 380, { score: leaderScore }), enemy(30, 30, { id: 'other', score: 1, alive: false })],
  }));
  assert.equal(runaway(14).intent.mode, 'capture', 'a leader not far ahead leaves the capture be');
  const hunted = runaway(20);
  assert.equal(hunted.intent.mode, 'hunt', 'a runaway leader is hunted, capture or no');
  assert.equal(hunted.targetId, 'foe');
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

  // A rogue has no base to capture on, so a team flag is nothing to him.
  const rogue = new Ace().think(makeView({
    self: { teamColor: 0 },
    flags: [redFlag],
    world: { teamFlags: true },
    myBase: () => null,
    findRoute: () => [{ x: 4, y: 0, z: 0, jump: false }, { x: 300, y: 0, z: 0, jump: false }],
  }));
  assert.notEqual(rogue.intent.mode, 'capture', 'a rogue does not go for a team flag');
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
  assert.ok(side.speed > 0, 'forward, which is across its line');

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

// Whom Ace goes for, and why.
{
  const homeFar = { myBase: () => ({ x: 0, y: -300, z: 0, radius: 20 }) };
  const flagWorld = { world: { teamFlags: true }, self: { team: 'blue', teamColor: 0 }, ...homeFar };

  // Whoever has Ace's flag, however far off, before any capture.
  const carrier = enemy(0, 400, { flag: 'B*', flagTeam: 0 });
  const enemyFlag = { index: 1, type: 'R*', team: 1, onGround: true, x: 0, y: 30, z: 0 };
  const hunt = new Ace().think(makeView({ ...flagWorld, players: [carrier], flags: [enemyFlag] }));
  assert.equal(hunt.targetId, 'foe', 'the carrier of our flag is chased past Roger\'s range');
  assert.equal(hunt.intent.reason, 'ours-carrier');

  // Ace's own flag away from home comes before an enemy flag not much nearer.
  const ownFlag = { index: 0, type: 'B*', team: 0, onGround: true, x: 0, y: 100, z: 0 };
  const near = { ...enemyFlag, y: 80 };
  const back = new Ace().think(makeView({ ...flagWorld, ...homeFar, flags: [ownFlag, near] }));
  assert.equal(back.intent.mode, 'return', 'our flag is fetched home first');
  const muchNearer = { ...enemyFlag, y: 30 };
  const grab = new Ace().think(makeView({ ...flagWorld, ...homeFar, flags: [ownFlag, muchNearer] }));
  assert.equal(grab.intent.mode, 'capture', 'unless an enemy flag is much nearer');

  // A foe that just shot at Ace is chased ahead of a nearer one.
  const quiet = enemy(0, 100, { id: 'quiet' });
  const shooter = enemy(0, 140, { id: 'shooter' });
  const pilot = new Ace();
  const incoming = { ownerId: 'shooter', x: 4, y: 130, z: 1, vx: 0, vy: -100, vz: 0 };
  pilot.think(makeView({ players: [quiet, shooter], shots: [incoming] }));
  const after = pilot.think(makeView({ now: 100.1, players: [quiet, shooter] }));
  assert.equal(after.targetId, 'shooter', 'the tank shooting at Ace is shot back at');
  assert.equal(after.intent.reason, 'retaliate', `mode ${after.intent.mode}`);
  const later = pilot.think(makeView({ now: 120, players: [quiet, shooter] }));
  assert.equal(later.targetId, 'quiet', 'and forgotten a while later');

  // A runaway leader counts as nearer.
  const leader = new Ace().think(makeView({
    self: { score: 0 },
    players: [enemy(0, 100, { id: 'low', score: 0 }), enemy(0, 140, { id: 'top', score: 10 })],
  }));
  assert.equal(leader.targetId, 'top', 'a foe far ahead on score is the one to stop');
  assert.equal(leader.intent.reason, 'leader');

  // A team behind keeps to its captures.
  const close = enemy(0, 40);
  const even = new Ace().think(makeView({
    ...flagWorld, flags: [{ ...enemyFlag, y: 200 }], players: [close], teamScores: { blue: 3, red: 3 },
  }));
  assert.equal(even.intent.mode, 'fight', 'a foe this close stops a capture');
  const behind = new Ace().think(makeView({
    ...flagWorld, flags: [{ ...enemyFlag, y: 200 }], players: [close], teamScores: { blue: 0, red: 3 },
  }));
  assert.equal(behind.intent.mode, 'capture', 'unless the team is behind');

  // Nothing near: hunt the foe that is there rather than wander.
  const far = new Ace().think(makeView({ players: [enemy(0, 600)] }));
  assert.equal(far.intent.mode, 'hunt', 'a foe far off is hunted');
  const alone = new Ace().think(makeView());
  assert.equal(alone.intent.mode, 'wander', 'and wandering is for an empty world');
}

// A team flag is kept until home.
{
  const carrying = {
    world: { teamFlags: true },
    self: { team: 'blue', teamColor: 0, flag: 'R*', flagIndex: 1, flagTeam: 1 },
    myBase: () => ({ x: 0, y: -300, z: 0, radius: 20 }),
  };
  const goodFlag = { index: 5, type: 'GM', team: null, onGround: true, x: 0, y: 5, z: 0 };
  const passing = new Ace().think(makeView({ ...carrying, flags: [goodFlag] }));
  assert.equal(passing.dropFlag, false, 'an enemy flag is not dropped for another flag');
  assert.equal(passing.intent.mode, 'home', 'it is carried home');

  const fight = new Ace().think(makeView({ ...carrying, players: [enemy(0, 30)] }));
  assert.equal(fight.intent.mode, 'fight', 'a close foe is fought on the way');
  assert.equal(fight.dropFlag, false, 'without letting go of the flag');

  const ours = { ...carrying, self: { ...carrying.self, flag: 'B*', flagIndex: 0, flagTeam: 0, speed: 25 } };
  const atHome = new Ace().think(makeView({ ...ours, myBase: () => ({ x: 0, y: 0, z: 0, radius: 20 }) }));
  assert.equal(atHome.dropFlag, true, 'our own flag is put down on our base');
}

// Ace's own flag let go of over an enemy base, when it lands near home.
{
  const enemyBase = { team: 1, x: 0, y: 20, z: 0, halfWidth: 10, halfDepth: 10, rotation: 0 };
  const nearHome = { x: 0, y: -290, z: 0, halfWidth: 5, halfDepth: 5, rotation: 0, teams: [0] };
  const holding = (extra = {}) => makeView({
    world: { teamFlags: true },
    self: { team: 'blue', teamColor: 0, flag: 'B*', flagIndex: 0, flagTeam: 0, speed: 25 },
    myBase: () => ({ x: 0, y: -300, z: 0, radius: 20 }),
    bases: [enemyBase, { team: 0, x: 0, y: -300, z: 0, halfWidth: 20, halfDepth: 20, rotation: 0 }],
    safetyZones: [nearHome],
    ...extra,
  });

  const toward = new Ace().think(holding());
  assert.equal(toward.intent.mode, 'drop-over', 'a close enemy base is driven to');
  assert.equal(toward.dropFlag, false, 'not dropped short of it');

  const over = new Ace().think(holding({ self: { team: 'blue', teamColor: 0, flag: 'B*', flagIndex: 0, flagTeam: 0, speed: 25, y: 20 } }));
  assert.equal(over.dropFlag, true, 'and let go of over it');

  const noZone = new Ace().think(holding({ safetyZones: [] }));
  assert.equal(noZone.intent.mode, 'home', 'not when the flag would only land at the centre');

  const guarded = new Ace().think(holding({ players: [enemy(10, 10)] }));
  assert.notEqual(guarded.intent.mode, 'drop-over', 'nor with a foe close by');
}

// Camping: hunting for a flag to camp with, then shooting from a vantage point.
{
  const top = (obs) => obs.pos[2] + obs.size[2];
  const spots = findVantagePoints([
    { type: 'box', pos: [0, 0, 0], size: [10, 10, 10] },
    { type: 'box', pos: [50, 0, 0], size: [2, 2, 20] },
    { type: 'box', kind: 'base', team: 1, pos: [0, 300, 0], size: [20, 20, 5] },
    { type: 'box', pos: [90, 0, 0], size: [10, 10, 1] },
  ], top);
  assert.deepEqual(spots, [{ x: 0, y: 0, z: 10 }], 'a tall, wide top; not a base, a post, or a step');

  const far = enemy(0, 400);
  const unknown = { index: 3, type: null, team: null, onGround: true, x: 0, y: 250, z: 0 };
  const hunt = new Ace().think(makeView({ players: [far], flags: [unknown] }));
  assert.equal(hunt.intent.mode, 'hunt-flag', 'with nobody near, a flag that might be one is fetched');
  const knows = new Ace();
  knows.knownFlagTypes.set(3, { type: 'QT', at: null });
  assert.equal(knows.think(makeView({ players: [far], flags: [unknown] })).intent.mode, 'hunt',
    'a flag known to be no use for camping is left');

  const vantages = [{ x: 0, y: 100, z: 10 }, { x: 100, y: 100, z: 2 }];
  const gm = { self: { flag: 'GM', shotSpeed: 100, shotLifetime: 3.5 }, vantages };
  const going = new Ace().think(makeView({ ...gm, players: [far] }));
  assert.equal(going.intent.mode, 'camp', 'with a Guided Missile, Ace camps');
  assert.deepEqual([going.intent.target.x, going.intent.target.y], [0, 100], 'on the higher spot');
  assert.ok(going.intent.vantages.some((v) => v.chosen), 'and the intent says which spots it weighed');

  const there = new Ace().think(makeView({ ...gm, self: { ...gm.self, y: 100, z: 10 }, players: [far] }));
  assert.equal(there.intent.mode, 'camp');
  assert.equal(there.targetId, 'foe', 'at the spot he turns on a foe in reach');
  assert.equal(there.speed, 0, 'and holds it');

  const close = new Ace().think(makeView({ ...gm, players: [enemy(0, 100)] }));
  assert.notEqual(close.intent.mode, 'camp', 'a foe close by is fought instead');

  // A laser flies level, so its spot is on the foes' level.
  const laser = { self: { flag: 'L', shotSpeed: 1000, shotLifetime: 3.5, y: 100, z: 2 }, vantages: [{ x: 0, y: 100, z: 2 }] };
  const holding = new Ace().think(makeView({ ...laser, players: [enemy(0, 700, { z: 0 })] }));
  assert.equal(holding.intent.mode, 'camp');
  assert.equal(holding.speed, 0, 'a laser holds its spot with the foe beyond a shot\'s reach');
  const backing = new Ace().think(makeView({ ...laser, players: [enemy(0, 400, { z: 0 })] }));
  assert.ok(backing.speed < 0, 'and backs off from one inside a lunge shot\'s reach');
  const open = { self: { flag: 'L', shotSpeed: 1000, shotLifetime: 3.5 }, vantages: [] };
  const closing = new Ace().think(makeView({ ...open, players: [enemy(0, 800)] }));
  assert.equal(closing.intent.mode, 'camp');
  assert.ok(closing.speed > 0, 'with no spot to hold, it closes in to just outside that reach');

  const sw = enemy(0, 160, { id: 'sw', flag: 'SW' });
  const shocked = new Ace().think(makeView({ ...gm, world: { shockOutRadius: 60 }, players: [far, sw] }));
  assert.deepEqual([shocked.intent.target.x, shocked.intent.target.y], [100, 100],
    'a spot within a Shock Wave\'s reach is given up');

  const pilot = new Ace();
  pilot.think(makeView({ ...gm, players: [far] }));
  const spot = pilot.camp.spot;
  pilot.noteCampDodge({ self: { x: 0, y: 100, z: 10 }, now: 101 }, { intent: { mode: 'dodge' } });
  pilot.noteCampDodge({ self: { x: 0, y: 100, z: 10 }, now: 103 }, { intent: { mode: 'dodge' } });
  assert.ok(pilot.badSpots.has(spot.key), 'two dodges at the spot give it up');
}

// A flag on another level is driven to by its route, and a team flag at home
// is not driven at at all.
{
  const raised = { index: 4, type: null, team: null, onGround: true, x: 0, y: 60, z: 30 };
  const up = new Ace().think(makeView({ flags: [raised] }));
  assert.equal(up.intent.mode, 'flag', 'a flag up on a platform is still one to fetch');
  assert.equal(up.intent.target.z, 30);

  const home = { myBase: () => ({ x: 0, y: 60, z: 30, radius: 20 }) };
  const ownAtHome = { index: 0, type: 'R*', team: 0, onGround: true, x: 0, y: 60, z: 30 };
  const idle = new Ace().think(makeView({ ...home, world: { teamFlags: true }, flags: [ownAtHome] }));
  assert.notEqual(idle.intent.mode, 'flag', 'our flag on our raised base is not driven at');

  const nowhere = { findRoute: () => null };
  const blocked = new Ace().think(makeView({ ...nowhere, flags: [raised] }));
  assert.notEqual(blocked.intent.mode, 'flag', 'a flag no route reaches is left');
}

// Jumping as the tank's own flag allows it.
{
  const asked = [];
  const spy = (from, to, options) => { asked.push(options); return null; };
  const far = enemy(0, 600);
  new Ace().think(makeView({ findRoute: spy, players: [far], self: { flag: 'NJ' } }));
  assert.equal(asked.at(-1).canJump, false, 'No Jumping plans routes without jump legs');
  new Ace().think(makeView({ findRoute: spy, players: [far], world: { allowJumping: false }, self: { flag: 'JP' } }));
  assert.equal(asked.at(-1).canJump, true, 'Jumping plans them where the world has none');

  // Roger's chase jumps the building in the way; Ace does only where he may.
  const wall = { firstBuilding: () => ({ top: 3, isBox: true, distance: 30 }), openDistance: () => 0 };
  const ahead = enemy(0, 40);
  const allowed = new Ace().think(makeView({ ...wall, players: [ahead] }));
  assert.equal(allowed.jump, true, 'a building in the chase is jumped');
  const grounded = new Ace().think(makeView({ ...wall, world: { allowJumping: false }, players: [ahead] }));
  assert.equal(grounded.jump, false, 'not where jumping is off');

  // A foe in sight but up out of reach is reached by route.
  let routed = false;
  const route = (from, to) => { routed = true; return [{ x: 0, y: 50, z: 0 }, { x: to.x, y: to.y, z: to.z }]; };
  new Ace().think(makeView({ findRoute: route, players: [enemy(0, 100, { z: 20 })] }));
  assert.ok(routed, 'a foe on a platform is chased by the way up');
}

// A teleporter is a way between levels: a lift up onto a platform no jump
// reaches, as hix's corners are with jumping off.
{
  const tele = (index, x, z, height) => ({
    type: 'box', kind: 'teleporter', teleporterIndex: index, angle: 0, pos: [x, 0, z],
    size: [0.56, 6.72, height], border: 1.12,
    bounds: { minX: x - 2, maxX: x + 2, minY: -8, maxY: 8, minZ: z, maxZ: z + height },
  });
  const platform = {
    type: 'box', pos: [0, 0, 0], size: [20, 20, 10], angle: 0,
    bounds: { minX: -20, maxX: 20, minY: -20, maxY: 20, minZ: 0, maxZ: 10 },
  };
  const obstacles = [platform, tele(0, 40, 0, 8), tele(1, 0, 10, 8)];
  const links = [{ sourceFaceId: 0, destFaceId: 2 }];
  const graph = (teleporterLinks) => buildNavGraph({ obstacles, mapSize: 200, waterLevel: null, jump: null, teleporterLinks });
  const from = { x: 60, y: 0, z: 0 };
  const to = { x: -10, y: 0, z: 10 };
  assert.equal(graph([]).findRoute(from, to), null, 'without the teleporter the platform is out of reach');
  const route = graph(links).findRoute(from, to);
  assert.ok(route && route.some((node) => node.teleport), 'with it, the route goes through');
  const leg = route.find((node) => node.teleport);
  assert.equal(leg.z, 10, 'and comes out on the platform');
  assert.deepEqual([leg.teleport.dx, leg.teleport.dy], [-1, -0], 'driven into the face from in front');
}

// Oscillation Overthruster goes before a lift up, and is not fetched again.
{
  const up = () => [{ x: 0, y: 20, z: 0 }, { x: 0, y: 30, z: 30, teleport: { x: 0, y: 25, dx: 0, dy: 1 } }];
  const level = () => [{ x: 0, y: 20, z: 0 }, { x: 0, y: 30, z: 0, teleport: { x: 0, y: 25, dx: 0, dy: 1 } }];
  const holding = { self: { flag: 'OO', flagIndex: 7, speed: 25 } };
  const pilot = new Ace();
  const lifting = pilot.think(makeView({ ...holding, findRoute: up, players: [enemy(0, 600, { z: 30 })] }));
  assert.equal(lifting.dropFlag, true, 'OO is let go of before a lift up');
  const after = pilot.think(makeView({
    now: 101, flags: [{ index: 7, type: 'OO', team: null, onGround: true, x: 0, y: 10, z: 0 }],
  }));
  assert.notEqual(after.intent.mode, 'flag', 'and left where it fell');
  const flat = new Ace().think(makeView({ ...holding, findRoute: level, players: [enemy(0, 600)] }));
  assert.equal(flat.dropFlag, false, 'but kept through a teleporter on the same level');
}

// What the live games on hix turned up.
{
  // Under a raised enemy base is not near it.
  const raisedBase = { team: 1, x: 0, y: 20, z: 26, halfWidth: 10, halfDepth: 10, rotation: 0 };
  const under = new Ace().think(makeView({
    world: { teamFlags: true, allowJumping: false },
    self: { team: 'blue', teamColor: 0, flag: 'B*', flagIndex: 0, flagTeam: 0, speed: 25 },
    myBase: () => ({ x: 0, y: -300, z: 0, radius: 20 }),
    bases: [raisedBase],
    safetyZones: [{ x: 0, y: -290, z: 0, halfWidth: 5, halfDepth: 5, rotation: 0, teams: [0] }],
  }));
  assert.notEqual(under.intent.mode, 'drop-over', 'a base no jump reaches the top of is not dropped over');

  // Just out of a teleporter, Ace backs off before going back into it.
  const back = () => [{ x: 0, y: 30, z: 0, teleport: { x: 0, y: 3, dx: 0, dy: 1 } }];
  const pilot = new Ace();
  pilot.lastTeleportAt = 100;
  const out = pilot.think(makeView({ now: 100.2, findRoute: back, players: [enemy(0, 600)] }));
  assert.ok(out.speed <= 0, 'not straight back into the face it came out of');
  const later = new Ace().think(makeView({ now: 100.2, findRoute: back, players: [enemy(0, 600)] }));
  assert.ok(later.speed > 0, 'a face it did not just leave is driven into');

  // Level shots: a foe up on a platform is no camp target for a laser on
  // the ground, and a camp that never fires is given up.
  const lofty = new Ace().think(makeView({
    self: { flag: 'L', shotSpeed: 1000, shotLifetime: 3.5 }, vantages: [], players: [enemy(0, 400, { z: 30 })],
  }));
  assert.notEqual(lofty.intent.mode, 'camp', 'no camping on a foe a level shot cannot reach');
  const idle = new Ace();
  idle.fireAtTank = () => {}; // a camp whose shots never go
  const quiet = { self: { flag: 'GM', shotSpeed: 100, shotLifetime: 3.5 }, vantages: [], players: [enemy(0, 300)] };
  const modes = [];
  for (let t = 0; t <= 12; t += 0.5) modes.push(idle.think(makeView({ ...quiet, now: 100 + t })).intent.mode);
  assert.equal(modes[0], 'camp');
  assert.notEqual(modes.at(-1), 'camp', 'a camp with no shot in 8 seconds is given up');

  // A camp shoots from the muzzle: a line clear at the feet but not at the
  // barrel is no target.
  const muzzleBlocked = { isObscured: (from) => from.z > 1 };
  const gm = { self: { flag: 'GM', shotSpeed: 100, shotLifetime: 3.5 }, vantages: [] };
  const blind = new Ace().think(makeView({ ...gm, ...muzzleBlocked, players: [enemy(0, 300)] }));
  assert.notEqual(blind.intent.mode, 'camp', 'no camp on a foe the barrel cannot see');
}

// A good flag in hand is kept, and a chosen flag stays chosen.
{
  const near = { index: 8, type: null, team: null, onGround: true, x: 0, y: 40, z: 0 };
  const holding = new Ace().think(makeView({ self: { flag: 'SH', flagIndex: 3 }, flags: [near], players: [enemy(0, 100)] }));
  assert.notEqual(holding.intent.mode, 'flag', 'no trading a good flag for the next one passed');
  const pilot = new Ace();
  const a = { index: 1, type: null, team: null, onGround: true, x: 0, y: 100, z: 0 };
  const b = { index: 2, type: null, team: null, onGround: true, x: 0, y: -110, z: 0 };
  pilot.think(makeView({ flags: [a, b] }));
  const kept = pilot.think(makeView({ now: 100.1, self: { y: -10 }, flags: [a, b] }));
  assert.equal(kept.intent.target.y, 100, 'the flag chosen is kept while another is only a little nearer');
}

// A flag close by and off to one side is driven onto, not round.
{
  const pilot = new Ace();
  const flag = { index: 9, type: null, team: null, onGround: true, x: 8, y: 4, z: 0 };
  const tank = { x: 0, y: 0, azimuth: Math.PI / 2 };
  const turnRate = Math.PI / 4;
  const dt = 0.05;
  let closest = Infinity;
  for (let i = 0; i < 160 && closest > 1.5; i++) {
    const out = pilot.think(makeView({ now: 100 + (i * dt), self: { ...tank }, flags: [flag] }));
    tank.azimuth += Math.max(-1, Math.min(1, out.rotation)) * turnRate * dt;
    const speed = Math.max(-1, Math.min(1, out.speed)) * 25;
    tank.x += Math.cos(tank.azimuth) * speed * dt;
    tank.y += Math.sin(tank.azimuth) * speed * dt;
    closest = Math.min(closest, Math.hypot(tank.x - flag.x, tank.y - flag.y));
  }
  assert.ok(closest <= 1.5, `reached the flag (closest ${closest.toFixed(1)})`);
}

// Home is the base's footprint, corners and all; and a one-way turn goes the
// long way round.
{
  const turned = { team: 0, x: 0, y: 340, z: 30, halfWidth: 35, halfDepth: 35, rotation: Math.PI / 4 };
  const corner = new Ace().think(makeView({
    world: { teamFlags: true },
    self: { team: 'red', teamColor: 0, flag: 'R*', flagIndex: 0, flagTeam: 0, x: 17.8, y: 309.8, z: 30, speed: 25 },
    myBase: () => ({ x: 0, y: 340, z: 30, radius: 35 }),
    bases: [turned],
  }));
  assert.equal(corner.dropFlag, true, 'our flag is put down on a turned base\'s corner, outside its inner circle');

  const right = enemy(100, 0);
  const lt = new Ace().think(makeView({ self: { flag: 'LT' }, players: [right] }));
  assert.equal(lt.rotation, 1, 'Left Turn Only turns left to face a foe on the right');
  assert.equal(lt.speed, 0, 'on the spot');
  const left = new Ace().think(makeView({ self: { flag: 'LT' }, players: [enemy(-100, 0)] }));
  assert.ok(left.rotation > 0, 'and turns left as usual where left is the way');
}

// Reverse Only backs towards where it is going.
{
  const flag = { index: 9, type: null, team: null, onGround: true, x: 0, y: -60, z: 0 };
  const ro = new Ace().think(makeView({ self: { flag: 'RO', azimuth: Math.PI / 2 }, flags: [flag] }));
  assert.ok(ro.speed < 0, 'a flag behind a Reverse Only tank is backed towards');
  assert.ok(Math.abs(ro.rotation) < 0.2, 'without turning round');
  assert.equal(ro.fire, false);
}

console.log('autopilot tests passed');
