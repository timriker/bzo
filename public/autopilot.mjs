/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The autopilots. `Roger` is upstream's own (`src/bzflag/AutoPilot.cxx`) and
// stays that: each frame it decides a turn, a speed, a jump and a trigger,
// which the caller feeds through exactly the path a stick would. `Ace` is
// Roger with bzo's improvements, and is where new behaviour goes -- Roger is
// the reference it is measured against. Nothing here reads the client:
// everything arrives through a *view* (see `docs/bots-plan.md`), so a
// server-launched bot can drive the same decisions from its own world.
//
// Everything is in upstream's frame -- (x, y) on the ground, z up, azimuth
// counter-clockwise from +x -- so it reads line for line against
// AutoPilot.cxx: the view, its probes, the routes `nav` plans, and the intent
// the pilot reports. A positive rotation turns left.

import {
  canRunOver, getFlagTuning, getRunOverRadius, isBadFlag,
} from './flags.mjs';
import { SHOT_COLLISION_RADIUS, traceShotStep, TANK } from './collision.mjs';
import { buildNavGraph, NAV_CELL, planJump } from './nav.mjs';
import { normalizeAngle } from './motion.mjs';
import { isRabbitTeam } from './teams.mjs';

const HALF_PI = Math.PI / 2;

// A position alone, for an intent: what the pilot reports carries nothing else.
function pointOf(p) {
  return { x: p.x, y: p.y, z: p.z };
}

function distance2D(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function azimuthTo(a, b) {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

// TargetingUtils::getTargetAngleDifference: the angle between a heading and the
// line to a target, in radians.
function angleDifference(src, azimuth, target) {
  const d = distance2D(src, target);
  if (d === 0) return 0;
  const tx = (target.x - src.x) / d;
  const ty = (target.y - src.y) / d;
  const dot = (tx * Math.cos(azimuth)) + (ty * Math.sin(azimuth));
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

// "toss in some lag adjustment/future prediction - 300 millis".
function predict(p) {
  const z = p.z + (0.3 * p.vz);
  return {
    x: p.x + (0.3 * p.vx),
    y: p.y + (0.3 * p.vy),
    z: z < 0 ? 0 : z,
  };
}

// dropHardFlags: flags Roger cannot use.
const HARD_FLAGS = new Set(['US', 'MG', 'ID']);

function createStats() {
  return {
    modes: {}, shots: 0, jumps: 0, falls: 0, plans: 0, unreachable: 0, unsticks: 0, held: 0, kept: 0,
  };
}

export class Roger {
  constructor({ random = Math.random } = {}) {
    this.random = random;
    // teachAutoPilot's table: per flag, kills minus deaths and how many.
    this.flagSuccess = new Map();
    this.totalSum = 0;
    this.totalCnt = 0;
    this.lastStuckTime = -Infinity;
    this.stuckRot = 0;
    this.stuckSpeed = 0;
    this.lastNavChange = -Infinity;
    this.navRot = 0;
    this.navSpeed = 0;
    this.lastShot = -Infinity;
    this.stats = createStats();
    this.wasInAir = false;
    this.jumpedLast = false;
  }

  // teachAutoPilot: +1 for a kill made with a flag, -1 for dying holding it.
  teach(flagType, adjust) {
    if (!flagType) return;
    const entry = this.flagSuccess.get(flagType);
    if (entry) {
      entry.sum += adjust;
      entry.count++;
    } else {
      this.flagSuccess.set(flagType, { sum: adjust, count: 1 });
    }
    this.totalSum += adjust;
    this.totalCnt++;
  }

  isFlagUseful(flagType) {
    if (!flagType) return false;
    const entry = this.flagSuccess.get(flagType);
    if (!entry) return true;
    const value = entry.count === 0 ? 0 : entry.sum / entry.count;
    const avg = this.totalCnt === 0 ? 0 : this.totalSum / this.totalCnt;
    return value >= avg;
  }

  // Whether a flag on the ground is worth driving to. Roger drives to any of
  // them.
  wantsGroundFlag() {
    return true;
  }

  // Whether a tank carrying its own team's flag is home, so drops it. Upstream
  // compares the base's x with the tank's, truncated, so the test passes over
  // half the map; that is Roger's, and kept.
  isHome(pos, base) {
    return Math.trunc(base.x) + 2 >= Math.trunc(pos.x)
      || (base.x === pos.x && base.y === pos.y);
  }

  // avoidDeathFall's branch for a look-ahead that met nothing. Upstream's reads
  // a collision point the ray never set, so Roger does nothing here.
  edgeAhead() {}

  // doAutoPilot. Returns `{ rotation, speed, jump, fire, dropFlag, targetId,
  // shotTargetId }`, rotation and speed as fractions of the tank's maximum:
  // `targetId` is who is being chased, `shotTargetId` who a shot was fired at.
  think(view) {
    const ctx = {
      view,
      me: {
        ...view.self,
        vx: view.self.velocity?.x ?? 0,
        vy: view.self.velocity?.y ?? 0,
        vz: view.self.velocity?.z ?? 0,
      },
      out: {
        rotation: 0, speed: 0, jump: false, fire: false, dropFlag: false, targetId: null, shotTargetId: null,
        // What the pilot is doing and why, for whoever wants to show it: a
        // client draws it, a server bot reports it, and nothing reads it to
        // decide anything.
        intent: {
          mode: null, reason: null, target: null, route: null, shot: null, landing: null,
        },
      },
    };
    const { intent } = ctx.out;
    this.dropHardFlags(ctx);
    if (this.avoidBullet(ctx)) intent.mode = 'dodge';
    else if (this.stuckOnWall(ctx)) intent.mode = 'unstick';
    else if (this.chasePlayer(ctx)) intent.mode = intent.mode || 'chase';
    else if (this.lookForFlag(ctx)) intent.mode = intent.mode || 'flag';
    else {
      this.navigate(ctx);
      intent.mode = intent.mode || 'wander';
    }
    this.avoidDeathFall(ctx);
    this.checkProgress(ctx);
    this.fireAtTank(ctx);
    if (ctx.out.fire && !intent.shot) intent.shot = this.muzzleRay(ctx);
    this.count(ctx);
    return ctx.out;
  }

  // Where a shot fired now leaves from and goes.
  muzzleRay(ctx) {
    const self = ctx.view.self;
    const dirX = Math.cos(self.azimuth);
    const dirY = Math.sin(self.azimuth);
    return {
      from: {
        x: self.x + (dirX * (self.muzzleForward ?? 3)),
        y: self.y + (dirY * (self.muzzleForward ?? 3)),
        z: self.z + (self.muzzleHeight ?? 1.57),
      },
      dir: { x: dirX, y: dirY, z: 0 },
      segments: null,
    };
  }

  // The counts a report is made of: what the pilot did since the last one.
  count(ctx) {
    const { me, out } = ctx;
    const stats = this.stats;
    stats.modes[out.intent.mode] = (stats.modes[out.intent.mode] || 0) + 1;
    if (out.fire) stats.shots++;
    if (out.jump && !me.inAir) stats.jumps++;
    if (me.inAir && !this.wasInAir && !this.jumpedLast) stats.falls++;
    this.wasInAir = me.inAir;
    this.jumpedLast = out.jump && !me.inAir;
  }

  // What the pilot has been up to since the last report, and a fresh start:
  // the share of frames in each mode, and the counts.
  takeReport() {
    const { stats } = this;
    const frames = Object.values(stats.modes).reduce((sum, n) => sum + n, 0) || 1;
    const modes = Object.entries(stats.modes)
      .sort((a, b) => b[1] - a[1])
      .map(([mode, n]) => `${mode} ${Math.round((100 * n) / frames)}%`)
      .join(', ');
    const report = `${modes || 'idle'}; shots ${stats.shots}, jumps ${stats.jumps}, falls ${stats.falls}`
      + (this.extraReport ? this.extraReport(stats) : '');
    this.stats = createStats();
    return report;
  }

  remotePlayers(view) {
    return view.players;
  }

  openDistance(ctx, pos, azimuth) {
    return ctx.view.openDistance(pos, azimuth);
  }

  isObscured(ctx, from, to) {
    return ctx.view.isObscured(from, to);
  }

  dropHardFlags(ctx) {
    const { me, out } = ctx;
    if (HARD_FLAGS.has(me.flag) || (me.flag === 'PZ' && !me.zoned)) out.dropFlag = true;
  }

  findWorstBullet(ctx) {
    const { view, me } = ctx;
    let minDistance = Infinity;
    let worst = null;
    for (const shot of view.shots) {
      if (shot.ownerId === me.id) continue;
      if (shot.flag === 'IB' && me.flag !== 'SE') continue;
      if (shot.ownerZoned && !me.zoned) continue;
      if (shot.flag === 'L' && me.flag === 'CL') continue;
      const pos = pointOf(shot);
      if (Math.abs(pos.z - me.z) > view.world.tankHeight && shot.flag !== 'GM') continue;
      const dist = distance2D(me, pos);
      if (dist >= minDistance || dist === 0) continue;
      const shotAngle = Math.atan2(shot.vy, shot.vx);
      const dot = (((me.x - pos.x) / dist) * Math.cos(shotAngle))
        + (((me.y - pos.y) / dist) * Math.sin(shotAngle));
      // "pretty wide angle, evasive actions prolly aren't gonna work"
      if (dot <= 0.1) continue;
      minDistance = dist;
      worst = { pos, shotAngle, dot };
    }
    return worst ? { ...worst, distance: minDistance } : null;
  }

  avoidBullet(ctx) {
    const { view, me, out } = ctx;
    if (me.flag === 'N' || me.flag === 'BU') return false; // take our chances
    const shot = this.findWorstBullet(ctx);
    if (!shot || shot.distance > 100) return false;
    const { shotAngle, dot } = shot;
    const canJump = (view.world.allowJumping || me.flag === 'JP' || me.flag === 'WG')
      && me.flag !== 'NJ';
    if (canJump && shot.distance < Math.max(dot, 0.5) * view.world.tankLength * 2.25) {
      out.jump = true;
      return me.flag !== 'WG';
    }
    if (dot <= 0.96) return false;
    const trueX = (me.x - shot.pos.x) / shot.distance;
    const trueY = (me.y - shot.pos.y) / shot.distance;
    const rotation1 = normalizeAngle((shotAngle + HALF_PI) - me.azimuth);
    const rotation2 = normalizeAngle((shotAngle - HALF_PI) - me.azimuth);
    const zCross = (Math.cos(shotAngle) * trueY) - (Math.sin(shotAngle) * trueX);
    const [near, far] = zCross > 0 ? [rotation1, rotation2] : [rotation2, rotation1];
    out.rotation = near;
    if (Math.abs(near) < Math.abs(far)) out.speed = 1;
    else if (dot > 0.98) out.speed = -0.5;
    else out.speed = 0.5;
    return true;
  }

  stuckOnWall(ctx) {
    const { view, me, out } = ctx;
    const stuckPeriod = view.now - this.lastStuckTime;
    if (stuckPeriod < 0.5) {
      out.rotation = this.stuckRot;
      out.speed = this.stuckSpeed;
      return true;
    }
    if (stuckPeriod < 1.0) {
      out.rotation = this.stuckRot;
      out.speed = 1;
      return true;
    }
    const phased = me.flag === 'OO' || me.zoned;
    if (phased || this.openDistance(ctx, me, me.azimuth) >= 5) return false;
    this.lastStuckTime = view.now;
    if (this.random() > 0.8) {
      // "Every once in a while, do something nuts"
      out.speed = (this.random() * 1.5) - 0.5;
      out.rotation = (this.random() * 2) - 1;
    } else {
      const left = this.openDistance(ctx, me, me.azimuth + (Math.PI / 4));
      const right = this.openDistance(ctx, me, me.azimuth - (Math.PI / 4));
      out.rotation = left > right ? 1 : -1;
      out.speed = -0.5;
    }
    this.stuckRot = out.rotation;
    this.stuckSpeed = out.speed;
    return true;
  }

  // Whether what was asked of the tank is happening. Upstream's pilot has no
  // such check -- its wall test above is a look ahead, not a measurement -- so
  // Roger's is empty.
  checkProgress() {}

  findBestTarget(ctx, players) {
    const { view, me } = ctx;
    let target = null;
    let best = Infinity;
    for (const p of players) {
      if (!p.alive || p.paused || p.notResponding || !view.isFoe(p)) continue;
      if (p.zoned && !me.zoned && me.flag !== 'SW' && me.flag !== 'SB') continue;
      if (p.flag === 'CL' && me.flag === 'L') continue;
      // "chase the proposed opponent if they have our flag"
      if (view.world.teamFlags && p.flagTeam !== null && p.flagTeam === me.teamColor) {
        return p;
      }
      let d = distance2D(me, p) * this.targetWeight(ctx, p);
      const obscured = this.isObscured(ctx, me, p);
      if (obscured) d *= 1.25; // demote the priority of obscured enemies
      if (d >= best) continue;
      // Upstream compares a radian angle against 30 here, so a stealthed tank
      // is chased whenever it is in plain sight; that is kept.
      if (p.flag !== 'ST' || me.flag === 'SE' || !obscured) {
        target = p;
        best = d;
      }
    }
    return target;
  }

  // How much nearer than it is a foe counts when choosing whom to chase.
  // Upstream's pilot goes by distance alone.
  targetWeight() {
    return 1;
  }

  chasePlayer(ctx) {
    const { view, me, out } = ctx;
    const target = this.findBestTarget(ctx, this.remotePlayers(view));
    if (!target) return false;
    out.targetId = target.id;
    out.intent.target = { ...pointOf(target), id: target.id };
    const distance = distance2D(me, target);
    if (distance > 250) return false;

    const enemyAzimuth = azimuthTo(me, target);
    out.rotation = normalizeAngle(enemyAzimuth - me.azimuth);

    // "If we are driving relatively towards our target and a building pops up
    // jump over it"
    if (Math.abs(out.rotation) < view.world.lockOnAngle) {
      const d = distance - 5; // "Make sure building is REALLY in front of player"
      const building = view.firstBuilding(me, me.azimuth, d);
      if (building && !me.zoned && me.flag !== 'OO') {
        // "If roger can drive around it, just do that"
        if (this.openDistance(ctx, me, me.azimuth + (Math.PI / 6)) > 2 * d) {
          out.speed = 0.5;
          out.rotation = -0.5;
          return true;
        }
        if (this.openDistance(ctx, me, me.azimuth - (Math.PI / 6)) > 2 * d) {
          out.speed = 0.5;
          out.rotation = 0.5;
          return true;
        }
        // "assuming 20-50 is a good range"
        if (d > 20 && d < 50 && building.isBox) {
          const jumpVel = view.world.jumpVelocity;
          const maxJump = (jumpVel * jumpVel) / (2 * view.world.gravity);
          if (building.top - me.z < maxJump) {
            out.speed = d / 50;
            out.jump = true;
            return true;
          }
        }
      }
    }

    // weave towards the player
    if (distance > view.world.shotSpeed / 2 || !me.canFire) {
      const dot = (Math.cos(me.azimuth) * Math.cos(enemyAzimuth))
        + (Math.sin(me.azimuth) * Math.sin(enemyAzimuth));
      if (dot < 0.866) {
        // "if target is more than 30 degrees away, turn as fast as you can"
        out.rotation *= Math.PI / (2 * Math.abs(out.rotation));
        out.speed = dot;
      } else {
        const period = Math.floor(view.now);
        const absBias = (Math.PI / 20) * (distance / 100);
        out.rotation = normalizeAngle(out.rotation + ((period % 4) < 2 ? absBias : -absBias));
        out.speed = 1;
      }
    } else if (target.flag !== 'BU') {
      out.speed = -0.5;
      if (out.rotation !== 0) out.rotation *= Math.PI / (2 * Math.abs(out.rotation));
    }
    return true;
  }

  lookForFlag(ctx) {
    const { view, me, out } = ctx;
    const pos = { x: me.x, y: me.y, z: Math.max(0, me.z) };
    if (me.flag && this.isFlagUseful(me.flag)) return false;

    let closest = null;
    let minDist = Infinity;
    let teamFlag = null;
    for (const flag of view.flags) {
      if (!flag.onGround) continue;
      if (flag.team !== null) teamFlag = flag;
      else if (!this.wantsGroundFlag(flag)) continue;
      const fpos = pointOf(flag);
      // Upstream's `fpos[2] == pos[2]`: only a flag at the tank's own level.
      if (Math.abs(fpos.z - pos.z) > 0.01) continue;
      let dist = distance2D(pos, fpos);
      if (this.isObscured(ctx, pos, fpos)) dist *= 1.25;
      if (dist < 200 && dist < minDist) {
        minDist = dist;
        closest = flag;
      }
    }
    if (teamFlag && (minDist < 10 || !closest)) closest = teamFlag;
    if (!closest) return false;
    if (minDist < 10 && me.flag) out.dropFlag = true;
    out.intent.target = { x: closest.x, y: closest.y, z: closest.z, flag: closest.type ?? null };
    const flagAzimuth = azimuthTo(pos, closest);
    out.rotation = normalizeAngle(flagAzimuth - me.azimuth);
    out.speed = HALF_PI - Math.abs(out.rotation);
    return true;
  }

  navigate(ctx) {
    const { view, me, out } = ctx;
    if (view.now - this.lastNavChange < 1) {
      out.rotation = this.navRot;
      out.speed = this.navSpeed;
      return true;
    }
    const pos = { x: me.x, y: me.y, z: me.z < 0 ? 0.01 : me.z };
    const left = this.openDistance(ctx, pos, me.azimuth + (Math.PI / 4));
    const center = this.openDistance(ctx, pos, me.azimuth);
    const right = this.openDistance(ctx, pos, me.azimuth - (Math.PI / 4));
    if (left > right) out.rotation = left > center ? 0.75 : 0;
    else out.rotation = right > center ? -0.75 : 0;

    if (me.flagTeam !== null) {
      const base = view.myBase();
      out.intent.mode = 'home';
      if (base) out.intent.target = pointOf(base);
      if (!base) {
        out.dropFlag = true;
      } else if (me.flagTeam === me.teamColor && this.isHome(pos, base)) {
        out.dropFlag = true;
      } else {
        out.rotation = normalizeAngle(azimuthTo(pos, base) - me.azimuth);
        out.speed = HALF_PI - Math.abs(out.rotation);
      }
    } else {
      out.speed = 1;
    }
    if (me.inAir && me.flag === 'WG') out.jump = true;

    this.navRot = out.rotation;
    this.navSpeed = out.speed;
    this.lastNavChange = view.now;
    return true;
  }

  // avoidDeathFall: look ahead and below, and stop short of water.
  avoidDeathFall(ctx) {
    const { view, me, out } = ctx;
    const waterLevel = view.world.waterLevel;
    let azimuth = me.azimuth;
    if (out.speed < 0) azimuth += Math.PI;
    const reach = 8 * view.world.tankHeight;
    const from = { x: me.x, y: me.y, z: me.z + (10 * view.world.tankHeight) };
    const to = {
      x: me.x + (reach * Math.cos(azimuth)),
      y: me.y + (reach * Math.sin(azimuth)),
      z: me.z + 0.01,
    };
    const hit = view.firstHit(from, to);
    if (hit) {
      const ground = Math.max(0, hit.z);
      if (Number.isFinite(waterLevel) && ground < waterLevel) out.speed = 0;
    } else {
      this.edgeAhead(ctx);
    }
  }

  fireAtTank(ctx) {
    const { view, me, out } = ctx;
    if (view.now - this.lastShot < 1 / view.world.maxShots) return;
    const pos = { x: me.x, y: me.y, z: me.z < 0 ? 0.01 : me.z };
    const players = this.remotePlayers(view)
      .filter((p) => p.alive && !p.paused && !p.notResponding);

    if (me.flag === 'SW') {
      let hasTarget = false;
      for (const p of players) {
        if (distance2D(pos, predict(p)) > view.world.shockOutRadius) continue;
        if (!view.isFoe(p)) {
          hasTarget = false;
          break;
        }
        hasTarget = true;
      }
      if (hasTarget) {
        out.fire = true;
        this.lastShot = view.now;
      }
      return;
    }

    const errorLimit = (view.world.maxShots * view.world.lockOnAngle) / 8;
    const closeErrorLimit = errorLimit * 2;
    for (const p of players) {
      if (!view.isFoe(p)) continue;
      if (p.zoned && !me.zoned && me.flag !== 'SB' && me.flag !== 'SW') continue;
      const enemy = predict(p);
      if (me.flag !== 'GM' && Math.abs(pos.z - enemy.z) >= 2 * view.world.tankHeight) continue;
      const dist = distance2D(pos, enemy);
      const diff = angleDifference(pos, me.azimuth, enemy);
      if (diff >= errorLimit
        && !(dist < 2 * view.world.shotSpeed && diff < closeErrorLimit)) continue;
      if (me.flag !== 'SB' && this.isObscured(ctx, pos, enemy)) continue;
      out.fire = true;
      out.shotTargetId = p.id;
      this.lastShot = view.now;
      return;
    }
  }
}

// A lunge (`startLunge`): Ace, holding still, drives forward for a moment so
// that a shot carries the tank's speed to a foe a standing shot falls short of
// -- base to base on HiX. The move the shot goes with states that speed, so it
// is an honest shot, and he stops again once it is away. Only at a foe slower
// than LUNGE_STILL_SPEED, since a shot at that range is three seconds in the
// air; given up if no shot goes within LUNGE_SECONDS; not where the ground
// ahead within LUNGE_CLEARANCE drops away or is blocked.
const LUNGE_STILL_SPEED = 1;
const LUNGE_HOLD_SPEED = 0.05;
const LUNGE_SECONDS = 0.3;
const LUNGE_CLEARANCE = 4;

// How far from Ace a returning ricochet still counts as coming back to him --
// he may have moved a little by then -- and how long a shot is clear of its
// own muzzle.
const SELF_HIT_MARGIN = 2;
// Dodging: how far past a hit a shot must pass to count as missing, how far
// ahead a shot is worth worrying about, and how much time a move out of its
// way must leave to spare.
const DODGE_CLEARANCE = 1;
const DODGE_HORIZON_SECONDS = 3;
const DODGE_MARGIN_SECONDS = 0.1;
const DODGE_DEAD_ON = 0.5;
// Burrowed: how far ahead a tank about to drive over him is looked for, and
// the room past its reach he wants.
const SQUASH_HORIZON_SECONDS = 1.5;
const SQUASH_MARGIN = 1;
// The antidote is worth the drive when shaking the flag off takes longer than
// the drive there, with this much to spare.
const ANTIDOTE_DRIVE_FACTOR = 1.5;
const ANTIDOTE_SPARE_SECONDS = 2;
// How close a foe has to be to pull Ace off a capture, and how far it has to
// get before he goes back to it. The gap is what keeps him from flipping
// between the two at one distance.
const CAPTURE_CHASE_RANGE = 50;
const CAPTURE_RELEASE_RANGE = 75;
// A team behind on score keeps to its captures: only a foe this much nearer
// than `CAPTURE_CHASE_RANGE` turns Ace from one.
const BEHIND_CHASE_SHARE = 0.6;
// Ace's own flag lying away from home is fetched first, unless an enemy flag
// is nearer than this share of the way to it.
const RETURN_PREFERENCE = 0.5;
// A shot that would pass this close to Ace, within this many seconds of
// flight, marks whoever fired it; for this long after, that foe counts as
// nearer by `RETALIATE_WEIGHT` while it is within `RETALIATE_RANGE` of Ace or
// of the route ahead of him.
const RETALIATE_MISS = 8;
const RETALIATE_LOOKAHEAD = 2;
const RETALIATE_SECONDS = 6;
const RETALIATE_RANGE = 150;
const RETALIATE_WEIGHT = 0.5;
// A foe whose score is this far clear of everyone else's counts as nearer
// by `LEADER_WEIGHT`.
const LEADER_LEAD = 5;
const LEADER_WEIGHT = 0.6;
// How far upstream's pilot chases (AutoPilot.cxx); Ace hunts past it.
const ROGER_CHASE_RANGE = 250;
// The modes in which Ace is going after a tank.
const TARGET_MODES = new Set(['chase', 'hunt', 'fight', 'ambush', 'lunge']);
const CHASE_DEST_SLACK = 40;
// Rabbit Chase: how near a hunter has to be before the rabbit runs from it,
// how far ahead the rabbit aims each time it picks somewhere to run to, how
// far it keeps from the world's edge doing so, and how fast a hunter has to
// be closing on it to count as coming for it rather than passing by.
const RABBIT_FLEE_RANGE = 200;
// Shots Ace keeps back on a server that allows several: a quarter of them,
// rounded up, so five slots fire three and keep two and two slots fire one. A
// single slot keeps none -- there is nothing to keep. The kept ones are spent
// on a foe this close, which is a fight now rather than a chance at range, and
// on a landing shot (`mayUseShot`).
const SHOT_RESERVE_FRACTION = 0.25;
const SHOT_RESERVE_SPEND_RANGE = 60;
const RABBIT_FLEE_DISTANCE = 150;
const RABBIT_FLEE_MARGIN = 20;
const RABBIT_CLOSING_SPEED = 1;
// A step a tank drives up without a jump: `_maxBumpHeight`'s default.
const MAX_STEP_UP = 0.33;
// How much of one jump's height a flag may sit above Ace, and still be worth
// jumping for; how square to the flag he must be to jump; how far ahead he
// looks for the edge; and how far past an edge's corner the jump should clear.
const JUMP_REACH_SHARE = 0.9;
const JUMP_AIM_TOLERANCE = 0.2;
const JUMP_LOOKAHEAD = 30;
// Route following that is not a matter of tuning: how square a gap must be
// taken, how a stall is noticed and backed out of, and how many nodes ahead
// the follower looks at once.
const BRIDGE_AIM_TOLERANCE = 0.1;
// A flight is flown from within this of its takeoff, and this square to it.
const FLIGHT_TAKEOFF_SLACK = 3;
const FLIGHT_AIM_TOLERANCE = 0.05;
// How many frames before a drive-off leaves the edge the landing turn goes on.
const FLIGHT_SPIN_FRAMES = 1.5;
// How near the planned speed a jump under an acceleration limit waits to be.
const JUMP_SPEED_SLACK = 1;
// How close a bearing is, as seconds of turning at full rate, before a route
// stops turning at full rate onto it.
const ROUTE_TURN_SECONDS = 0.3;
// A drive-off taken straight at its landing: how far past the edge the tank's
// centre goes before it tips, and the slowest it drives off at.
const DRIVE_OFF_TIP = 1;
const DRIVE_OFF_SLOWEST = 0.3;
// Nearer the edge than this, it goes over only lined up.
const DRIVE_OFF_LINE_UP = 6;
// Intercepting a foe in the air: how finely its flight is searched for the
// stretches its body is at the muzzle's height, and the longest piece one is
// cut into -- a quarter-second at tank speed is more drift than a hit allows.
const INTERCEPT_STEP = 0.02;
const INTERCEPT_PIECE_SECONDS = 0.08;
// How much of a tank's hit radius a shot from the air may pass from its
// centre and still be taken.
const AIR_SHOT_SHARE = 0.6;
// A foe passed sooner than this into a flight is too soon to turn to.
const FOE_PASS_SOONEST = 0.3;
// How much of Agility's threshold a step in speed may use, so rounding never
// tips one over it.
const AGILITY_PACE_SHARE = 0.9;
// How far along the route past a landing its turn is aimed.
const LANDING_AIM_REACH = 16;
// A flag is dropped at no less than this share of top speed, turning no more
// than this, and the tank drives on for this long after.
const DROP_MIN_SPEED_SHARE = 0.5;
const DROP_MAX_TURN = 0.3;
const DROP_DRIVE_SECONDS = 1;
const UNSTICK_SECONDS = 0.5;
const UNSTICK_BACKOFF_SECONDS = 0.6;
// Then forward on the new heading for a moment, as Roger does, which is what
// carries the tank along a wall rather than back square into it.
const UNSTICK_DRIVE_SECONDS = 0.4;
const UNSTICK_SPEED = -0.5;
const UNSTICK_TURN = 0.05;
const UNSTICK_MOVE = 0.3;
// Less than this share of the distance asked for is not getting anywhere,
// however far it comes to: a tank grinding along a wall at full throttle
// covers a unit or two a second where it asked for twenty-five.
const UNSTICK_SHARE = 0.25;
const ROUTE_LOOKAHEAD = 16;
// How Ace drives a route, as numbers a benchmark can vary
// (scripts/bench-pilot.mjs): `follow` is `nodes` -- the next node, or a few
// ahead on the ground -- or `pursuit`, a point `pursuitGround`/`pursuitRaised`
// further along the route than he is; `speed` is `bearing` (slower the more he
// has to turn) or `arrival` (as fast as still lets him turn onto the aim).
// Off the ground he goes `raisedFactor` of the speed, which keeps him on
// walkways a tank's width wide.
export const ACE_TUNING = Object.freeze({
  follow: 'nodes',
  speed: 'bearing',
  groundLookahead: 10,
  pursuitGround: 10,
  pursuitRaised: 5,
  pursuitMin: 2,
  turnInPlace: 1,
  raisedTurn: 0.3,
  raisedSpeed: 0.3,
  raisedFactor: 0.7,
  reachedGround: 3,
  reachedRaised: 1.5,
  // How near a node Ace may pass and still count it behind him.
  passRange: 6,
  // `raised` is `factor` -- a flat `raisedFactor`, and `raisedSpeed` while
  // turning harder than `raisedTurn` -- or `curve`: full speed down a straight,
  // braking for the sharpest bend in the next `cornerLookahead` units, never
  // below `cornerSlowest`.
  raised: 'factor',
  cornerLookahead: 12,
  cornerSlowest: 0.2,
});
// Half a tank's width, plus a little, for the lane check.
const LANE_HALF_WIDTH = 1.6;
// How far the tank moves before the lane to the node it aims at is tested
// again.
const AIM_RECHECK_DISTANCE = 2;
// Just over the bump a tank drives up without noticing.
const AIM_LANE_LIFT = 0.4;
const ROUTE_REPLAN_SECONDS = 3;
const ROUTE_STRAY = 12;
const ROUTE_DEST_SLACK = 8;
const UNREACHABLE_SECONDS = 10;
const SELF_HIT_GRACE_SECONDS = 0.1;

// Roger with bzo's improvements. Each override is one of Roger's decisions
// answered differently; everything else is Roger's.
export class Ace extends Roger {
  constructor(options = {}) {
    super(options);
    this.tuning = { ...ACE_TUNING, ...options.tuning };
    // What each flag slot is, as far as this pilot has seen: what it carried,
    // and what it saw anyone else carry. A superflag on the ground arrives with
    // its type hidden, so this is how a pilot that dropped a flag knows not to
    // drive straight back over it.
    this.knownFlagTypes = new Map();
    // A lunge under way: who it is for and when it began; and whether to stop
    // on the next frame, the shot having gone.
    this.lunge = null;
    this.lungeStop = false;
    // The route being followed, and the flags no route reached lately.
    this.route = null;
    this.unreachable = new Map();
    // Whether a route is getting anywhere, and how long a back-off has left.
    this.progress = null;
    this.unstickUntil = -Infinity;
    this.unstickTurn = 0;
    this.sightLift = 0;
    this.aimCache = null;
    this.shedOnTakeoff = false;
    this.shedAirborne = false;
    this.dropDriveUntil = -Infinity;
    this.lastTrace = null;
    this.extraReport = (stats) => `, routes ${stats.plans} (${stats.unreachable} none),`
      + ` unsticks ${stats.unsticks}, held shots ${stats.held}, kept shots ${stats.kept}`;
    // The landing each airborne foe has been shot at for, as a clock time, so
    // one jump costs one shot.
    this.landingShots = new Map();
    // The foe Ace has stopped a capture to fight, until it is out of reach.
    this.fightId = null;
    this.lastThinkAt = null;
    // Who has fired a shot that came near Ace, and until when that counts.
    this.shotAtBy = new Map();
  }

  // Ace sees everything the view holds -- every tank, every shot, wherever
  // it is. How fair a bot should play is a separate question, for later.
  think(view) {
    this.frameSeconds = this.lastThinkAt === null ? 0 : Math.max(0, view.now - this.lastThinkAt);
    this.lastThinkAt = view.now;
    if (view.self.flag && Number.isInteger(view.self.flagIndex)) {
      this.knownFlagTypes.set(view.self.flagIndex, view.self.flag);
    }
    for (const player of view.players) {
      if (player.flag && Number.isInteger(player.flagIndex)) {
        this.knownFlagTypes.set(player.flagIndex, player.flag);
      }
    }
    this.noteShooters(view);
    const out = super.think(view);
    // A reason is why a tank was picked, so only while Ace is after one.
    if (!TARGET_MODES.has(out.intent.mode)) out.intent.reason = null;
    this.paceAgility(view, out);
    return out;
  }

  // Every foe's shot that would pass within `RETALIATE_MISS` of Ace in the
  // next `RETALIATE_LOOKAHEAD` seconds, as both keep going, marks its owner.
  noteShooters(view) {
    const me = view.self;
    const mvx = me.velocity?.x ?? 0;
    const mvy = me.velocity?.y ?? 0;
    for (const [id, until] of this.shotAtBy) if (until <= view.now) this.shotAtBy.delete(id);
    for (const shot of view.shots) {
      const owner = view.players.find((p) => p.id === shot.ownerId);
      if (!owner || !view.isFoe(owner)) continue;
      const rx = shot.x - me.x;
      const ry = shot.y - me.y;
      const vx = shot.vx - mvx;
      const vy = shot.vy - mvy;
      const v2 = (vx * vx) + (vy * vy);
      const t = v2 > 0 ? Math.max(0, Math.min(RETALIATE_LOOKAHEAD, -((rx * vx) + (ry * vy)) / v2)) : 0;
      if (Math.hypot(rx + (vx * t), ry + (vy * t)) < RETALIATE_MISS) {
        this.shotAtBy.set(owner.id, view.now + RETALIATE_SECONDS);
      }
    }
  }

  // A foe that shot at Ace lately and is close to him or to where he is going.
  isRetaliationTarget(ctx, p) {
    if (!((this.shotAtBy.get(p.id) ?? -Infinity) > ctx.view.now)) return false;
    if (distance2D(ctx.me, p) < RETALIATE_RANGE) return true;
    const nodes = this.route?.nodes;
    if (!nodes) return false;
    return nodes.slice(this.route.at).some((node) => distance2D(node, p) < RETALIATE_RANGE);
  }

  // The foe whose score is `LEADER_LEAD` clear of every other tank's, if any.
  scoreLeader(ctx) {
    const { view } = ctx;
    const scored = view.players.filter((p) => Number.isFinite(p.score));
    if (Number.isFinite(view.self.score)) scored.push(view.self);
    if (scored.length < 2) return null;
    scored.sort((a, b) => b.score - a.score);
    const [top, next] = scored;
    if (top === view.self || !view.isFoe(top) || top.score - next.score < LEADER_LEAD) return null;
    return top;
  }

  // Whether Ace's team trails another team on score.
  teamBehind(ctx) {
    const scores = ctx.view.teamScores;
    const mine = scores?.[ctx.me.team];
    if (!Number.isFinite(mine)) return false;
    return Object.entries(scores).some(([team, score]) => team !== ctx.me.team && score > mine);
  }

  // A foe carrying Ace's own team flag.
  ourFlagCarrier(ctx) {
    const { view, me } = ctx;
    if (!view.world.teamFlags) return null;
    return this.remotePlayers(view).find((p) => p.alive && !p.paused && view.isFoe(p)
      && p.flagTeam !== null && p.flagTeam === me.teamColor) || null;
  }

  targetWeight(ctx, p) {
    let weight = 1;
    if (this.isRetaliationTarget(ctx, p)) weight *= RETALIATE_WEIGHT;
    if (p.id === ctx.leaderId) weight *= LEADER_WEIGHT;
    return weight;
  }

  findBestTarget(ctx, players) {
    if (this.isRabbit(ctx)) return this.rabbitTarget(ctx, players);
    ctx.leaderId = this.scoreLeader(ctx)?.id ?? null;
    const target = super.findBestTarget(ctx, players);
    if (target) ctx.out.intent.reason = this.targetReason(ctx, target);
    return target;
  }

  targetReason(ctx, p) {
    if (ctx.view.world.teamFlags && p.flagTeam !== null && p.flagTeam === ctx.me.teamColor) return 'ours-carrier';
    if (this.isRetaliationTarget(ctx, p)) return 'retaliate';
    if (p.id === ctx.leaderId) return 'leader';
    return 'nearest';
  }

  // Agility multiplies the speed for a second whenever the asked-for speed
  // jumps by more than `AGILITY_VEL_DELTA` at once (`getSpeedFactor`), and a
  // jump leaves at whatever speed the tank has. Lining up from a standstill
  // and then asking for the jump's speed is exactly such a change, so the
  // tank went off at twice and more the speed planned and sailed past the
  // landing. Holding A, Ace changes speed in steps under the threshold --
  // except to dodge, which is what the burst is for -- and does not jump
  // while a burst he set off is still running.
  paceAgility(view, out) {
    const self = view.self;
    const last = this.lastSpeedCommand ?? 0;
    const { agilityVelDelta } = getFlagTuning();
    const limitFor = (speed) => (speed < 0 ? agilityVelDelta / 2 : agilityVelDelta);
    if (self.flag === 'A' && !self.inAir && out.intent.mode !== 'dodge') {
      const limit = limitFor(out.speed) * AGILITY_PACE_SHARE;
      if (Math.abs(out.speed - last) > limit) {
        out.speed = last + (Math.sign(out.speed - last) * limit);
        out.jump = false;
      }
    }
    if (self.flag === 'A' && Math.abs(out.speed - last) > limitFor(out.speed)) {
      this.agilityUntil = view.now + getFlagTuning().agilityTimeWindow;
    }
    if (self.flag === 'A' && out.jump && out.intent.mode !== 'dodge' && view.now < (this.agilityUntil ?? -Infinity)) {
      out.jump = false;
    }
    this.lastSpeedCommand = out.speed;
  }

  // Roger sights from tank bottom to tank bottom. A shot leaves at the
  // muzzle's height, though, and from beside a raised surface a foe stands on
  // the bottoms' line runs through the surface's edge where the shot skims
  // over it -- so while Ace is choosing a shot, both ends are lifted to it.
  isObscured(ctx, from, to) {
    const lift = this.sightLift || 0;
    if (!lift) return super.isObscured(ctx, from, to);
    return super.isObscured(ctx, { ...from, z: from.z + lift }, { ...to, z: to.z + lift });
  }

  // A type this pilot has learned is one it can refuse.
  wantsGroundFlag(flag) {
    const type = flag.type ?? this.knownFlagTypes.get(flag.index) ?? null;
    if (!type) return true;
    if (isBadFlag(type) || HARD_FLAGS.has(type)) return false;
    return this.isFlagUseful(type);
  }

  // Where and when an airborne tank comes down, in upstream's frame: the arc
  // its last move describes, met with whatever surface is under the place it
  // gets to. Asked twice, since the surface decides the time and the time the
  // place.
  predictLanding(ctx, p) {
    if (!p.airborne || !(p.gravity > 0)) return null;
    const g = p.gravity;
    const apex = p.vz > 0 ? p.z + ((p.vz * p.vz) / (2 * g)) : p.z;
    let floor = 0;
    let landing = null;
    for (let pass = 0; pass < 2; pass++) {
      const disc = (p.vz * p.vz) + (2 * g * (p.z - floor));
      if (disc < 0) return null;
      const t = (p.vz + Math.sqrt(disc)) / g;
      landing = { x: p.x + (p.vx * t), y: p.y + (p.vy * t), z: floor, t };
      const hit = ctx.view.firstHit(
        { x: landing.x, y: landing.y, z: apex + 0.5 },
        { x: landing.x, y: landing.y, z: -0.1 },
      );
      const surface = hit ? Math.max(0, hit.z) : 0;
      if (Math.abs(surface - floor) < 0.01) break;
      floor = surface;
    }
    return landing;
  }

  // The shot a jumper lands into: from the muzzle, when its flight time is the
  // time left before the tank's body comes down through the shot's height.
  // Null when no shot can meet this landing.
  planLandingShot(ctx, p) {
    const { view, me } = ctx;
    const landing = this.predictLanding(ctx, p);
    if (!landing) return null;
    const muzzleZ = me.z + me.muzzleHeight;
    // A level shot meets the tank only if it lands with the muzzle's height
    // inside its body.
    if (muzzleZ < landing.z || muzzleZ > landing.z + view.world.tankHeight) return null;
    const g = p.gravity;
    // When the body's underside comes down past the shot's height, on the way
    // down: a tank still rising through it is about to leave. A hop that never
    // gets that high is in the shot's path all along.
    const disc = (p.vz * p.vz) + (2 * g * (p.z - muzzleZ));
    const enter = disc < 0 ? 0 : Math.max(0, (p.vz + Math.sqrt(disc)) / g);
    const reach = Math.max(0, distance2D(me, landing) - me.muzzleForward - TANK.radius);
    return { landing, reach, enter, distance: distance2D(me, landing) };
  }

  // Every chance a level shot fired now has at an airborne foe: where it
  // lands, if it lands with the muzzle's height inside its body, and each
  // stretch of its flight when its body passes through the muzzle's height,
  // rising or falling -- from the ground, a platform beside its jump or the
  // air, since a shot keeps the height it is fired at. Each stretch is cut
  // into pieces short enough that the foe's drift across one stays inside a
  // hit, and each is a point and a window of time in the shape
  // `landingShotSpeed` reads, earliest first: up the way it rose is the
  // soonest kill. `landsAt` is the jump's own landing, which one shot per jump
  // is counted against.
  planShots(ctx, p) {
    const { view, me } = ctx;
    const landing = this.predictLanding(ctx, p);
    if (!landing) return [];
    const landsAt = view.now + landing.t;
    const plans = [];
    const atLanding = this.planLandingShot(ctx, p);
    if (atLanding) plans.push({ ...atLanding, landsAt });
    const muzzleZ = me.z + me.muzzleHeight;
    const tall = view.world.tankHeight;
    const g = p.gravity;
    const piece = (from, to) => {
      for (let a = from; a < to - 1e-6; a += INTERCEPT_PIECE_SECONDS) {
        const b = Math.min(to, a + INTERCEPT_PIECE_SECONDS);
        const mid = (a + b) / 2;
        const point = { x: p.x + (p.vx * mid), y: p.y + (p.vy * mid), z: muzzleZ, t: b };
        const distance = distance2D(me, point);
        plans.push({
          landing: point,
          reach: Math.max(0, distance - me.muzzleForward - TANK.radius),
          enter: a,
          distance,
          landsAt,
        });
      }
    };
    let start = null;
    for (let t = 0; t <= landing.t; t += INTERCEPT_STEP) {
      const z = p.z + (p.vz * t) - (0.5 * g * t * t);
      const inside = muzzleZ >= z && muzzleZ <= z + tall;
      if (inside && start === null) start = t;
      if (!inside && start !== null) {
        piece(start, t);
        start = null;
      }
    }
    if (start !== null) piece(start, landing.t);
    return plans.sort((a, b) => a.enter - b.enter);
  }

  // A shot's speed is its tank's velocity plus the shot speed (FiringInfo,
  // ShotPath.cxx:29), so Ace's own speed is part of his aim. This is a shot
  // fired this frame at `point`: the barrel heading that sends it there, and
  // how fast it goes. On the ground he is moving along his barrel at `speed`,
  // which only changes how fast the shot goes. In the air his velocity is the
  // one he left with, and the part of it across the line bends the shot off
  // his barrel, so the barrel turns into it. A Guided Missile keeps the shot
  // speed whatever the tank does (GuidedMissleStrategy.cxx:75). Null when the
  // drift across the line is more than the shot can make up.
  shotToward(ctx, point, speed) {
    const { view, me } = ctx;
    const base = view.world.shotSpeed;
    const scale = me.flag === 'GM' ? null : (me.shotSpeed / base);
    const toward = azimuthTo(me, point);
    if (!me.inAir) {
      return { azimuth: toward, speed: scale === null ? base : (base + speed) * scale };
    }
    const barrel = skewedBarrel(me.vx, me.vy, toward, base);
    if (!barrel) return null;
    return { azimuth: barrel.azimuth, speed: scale === null ? base : barrel.speed * scale };
  }

  // The speeds Ace can be doing along his barrel by the end of this frame:
  // half speed back to full ahead, and within one frame's acceleration of
  // where he is on a world that limits it.
  speedRange(ctx) {
    const { view, me } = ctx;
    const top = me.topSpeed ?? view.world.tankSpeed;
    let low = -0.5 * top;
    let high = top;
    if (me.accel > 0) {
      const step = me.accel * (this.frameSeconds || 0);
      low = Math.max(low, (me.speed ?? 0) - step);
      high = Math.min(high, (me.speed ?? 0) + step);
    }
    return { low, high, top };
  }

  // Whether the landing shot can go now, and at what speed of Ace's own. It has
  // to arrive while the tank's body is coming down through its height: no
  // sooner than `enter`, no later than touchdown. On the ground the speed is
  // his to pick, so of the ones that make it he takes the one nearest
  // `preferred` -- what he was doing anyway -- and the window opens sooner for
  // it: backing off slows the shot, so a near jumper can be shot at while
  // still high and Ace is free again sooner; driving at it speeds the shot up
  // to reach a far one in time. `late` and `early` say which way he is out
  // when no speed makes it.
  landingShotSpeed(ctx, plan, preferred, range = this.speedRange(ctx)) {
    const fixed = ctx.me.inAir || ctx.me.flag === 'GM';
    // A speed of his own choosing can put the shot there at touchdown exactly;
    // one he cannot change gets a frame's grace.
    const latest = plan.landing.t + (fixed ? 0.05 : 0);
    const flightAt = (speed) => {
      const shot = this.shotToward(ctx, plan.landing, speed);
      if (!shot || !(shot.speed > 0)) return null;
      return { ...shot, flight: plan.reach / shot.speed, speed };
    };
    const fits = (shot) => shot && shot.flight >= plan.enter && shot.flight <= latest;
    const want = Math.max(range.low, Math.min(range.high, preferred));
    const atWant = flightAt(want);
    if (fixed || fits(atWant)) {
      if (fits(atWant)) return atWant;
      return { late: !atWant || atWant.flight > latest, early: !!atWant && atWant.flight < plan.enter };
    }
    // Shot speed is the tank's plus a constant, so the speeds that fit are one
    // interval: the slowest shot that is not late to the fastest not early.
    const scale = ctx.me.shotSpeed / ctx.view.world.shotSpeed;
    const base = ctx.view.world.shotSpeed;
    const slowest = (plan.reach / latest) / scale - base;
    const fastest = plan.enter > 0 ? (plan.reach / plan.enter) / scale - base : Infinity;
    const low = Math.max(range.low, slowest);
    const high = Math.min(range.high, fastest);
    if (low > high) return { late: range.high < slowest, early: range.low > fastest };
    const chosen = flightAt(Math.max(low, Math.min(high, want)));
    return fits(chosen) ? chosen : { late: false, early: false };
  }

  // Turn to a heading in one step where one step reaches it: Roger's own
  // `rotation = difference` closes a gap over seconds, which is no way to aim
  // at a moment.
  aimAt(ctx, azimuth) {
    const { me, out } = ctx;
    const diff = normalizeAngle(azimuth - me.azimuth);
    const step = this.turnRate(ctx) * (this.frameSeconds || 0);
    out.rotation = step > 0 ? Math.max(-1, Math.min(1, diff / step)) : Math.sign(diff);
    return diff;
  }

  // A team flag goes home before anything is chased: Roger chases first, and a
  // chase that ends on an enemy base captures his own flag there, which kills
  // him and his team. Shooting is a separate step and still happens. And a foe
  // in the air is met where it will land rather than chased where it is.
  chasePlayer(ctx) {
    if (ctx.me.flagTeam !== null) return false;
    if (this.antidoteTarget(ctx)) return false;
    // Whoever has Ace's flag comes before anything else, however far off.
    const carrier = this.ourFlagCarrier(ctx);
    if (carrier && distance2D(ctx.me, carrier) > ROGER_CHASE_RANGE) {
      ctx.out.intent.reason = 'ours-carrier';
      return this.huntFar(ctx, carrier);
    }
    // A capture to make wins over a chase, except a foe close enough to be a
    // threat rather than a detour -- which he stands and fights.
    if (!carrier && this.captureTarget(ctx)) {
      const foe = this.closeFoe(ctx);
      return foe ? this.fightClose(ctx, foe) : false;
    }
    this.fightId = null;
    const ambush = this.ambushTarget(ctx);
    if (ambush) return this.ambush(ctx, ambush);
    const chased = super.chasePlayer(ctx);
    if (!chased) {
      // Roger gives up a chase past 250 units, which leaves a hunter in
      // Rabbit Chase waiting for the rabbit to wander near. Ace hunts it
      // wherever it is; the rabbit, with nobody coming for it, runs.
      const quarry = this.rabbitQuarry(ctx);
      if (quarry) return this.huntFar(ctx, quarry);
      if (this.isRabbit(ctx)) return this.flee(ctx);
    }
    const target = ctx.view.players.find((p) => p.id === ctx.out.targetId);
    if (chased && target && !target.airborne) return this.chaseAround(ctx, target) || chased;
    if (!chased || !target?.airborne) return chased;
    // An airborne foe with no landing shot to wait for -- out of reach, or
    // already shot at -- is nothing to do until it lands, so Ace gets on with
    // something else.
    const { out } = ctx;
    out.rotation = 0;
    out.speed = 0;
    out.targetId = null;
    out.intent.target = null;
    return false;
  }

  // Rabbit Chase (`-rabbit`): one rabbit against everyone else, so the rabbit
  // is every hunter's only foe and every tank is the rabbit's.
  isRabbit(ctx) {
    return isRabbitTeam(ctx.me.team);
  }

  rabbitQuarry(ctx) {
    if (this.isRabbit(ctx)) return null;
    return this.remotePlayers(ctx.view).find((p) => isRabbitTeam(p.team) && p.alive && !p.paused
      && ctx.view.isFoe(p)) || null;
  }

  // The rabbit turns only on a tank that is coming for it -- the nearest one
  // closing on it. Anything else it would sooner leave behind than fight.
  rabbitTarget(ctx, players) {
    const { me, view } = ctx;
    let target = null;
    let best = Infinity;
    for (const p of players) {
      if (!p.alive || p.paused || p.notResponding || !view.isFoe(p)) continue;
      const dx = me.x - p.x;
      const dy = me.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d === 0 || d >= best) continue;
      const closing = ((p.vx * dx) + (p.vy * dy)) / d;
      if (closing < RABBIT_CLOSING_SPEED) continue;
      target = p;
      best = d;
    }
    return target;
  }

  // A hunter's chase beyond Roger's range: the route to the rabbit, kept until
  // it moves `CHASE_DEST_SLACK`, so a fleeing rabbit is not a search a frame.
  huntFar(ctx, quarry) {
    const { out } = ctx;
    out.targetId = quarry.id;
    out.intent.target = { ...pointOf(quarry), id: quarry.id };
    out.intent.mode = 'hunt';
    const route = typeof ctx.view.findRoute === 'function'
      ? this.routeTo(ctx, quarry, CHASE_DEST_SLACK) : null;
    if (route && this.followRoute(ctx, route)) return true;
    out.rotation = normalizeAngle(azimuthTo(ctx.me, quarry) - ctx.me.azimuth);
    out.speed = HALF_PI - Math.abs(out.rotation);
    return true;
  }

  // Away from every hunter in range, the nearer ones counting for more, to a
  // point a fair way off and inside the world. Nobody in range, nothing to
  // run from: the rabbit goes about its business.
  flee(ctx) {
    const { me, view, out } = ctx;
    let awayX = 0;
    let awayY = 0;
    for (const p of this.remotePlayers(view)) {
      if (!p.alive || p.paused || !view.isFoe(p)) continue;
      const dx = me.x - p.x;
      const dy = me.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d === 0 || d > RABBIT_FLEE_RANGE) continue;
      awayX += dx / (d * d);
      awayY += dy / (d * d);
    }
    const length = Math.hypot(awayX, awayY);
    if (length === 0) return false;
    const limit = Math.max(0, ((view.world.mapSize || 800) / 2) - RABBIT_FLEE_MARGIN);
    const clamp = (value) => Math.max(-limit, Math.min(limit, value));
    const point = {
      x: clamp(me.x + ((awayX / length) * RABBIT_FLEE_DISTANCE)),
      y: clamp(me.y + ((awayY / length) * RABBIT_FLEE_DISTANCE)),
      z: me.z,
    };
    out.intent.mode = 'flee';
    out.intent.target = point;
    const route = typeof view.findRoute === 'function'
      ? this.routeTo(ctx, point, CHASE_DEST_SLACK) : null;
    if (route && this.followRoute(ctx, route)) return true;
    out.rotation = normalizeAngle(azimuthTo(me, point) - me.azimuth);
    out.speed = HALF_PI - Math.abs(out.rotation);
    return true;
  }

  // Roger chases in a straight line, which a wall between him and the foe
  // turns into driving at the wall. Ace takes the route there instead while
  // the foe is out of sight, and Roger's straight chase again once it is in
  // it. The route is kept until the foe has moved `CHASE_DEST_SLACK`, so a
  // moving foe is not a new search every frame.
  chaseAround(ctx, target) {
    const { view, me } = ctx;
    if (typeof view.findRoute !== 'function') return false;
    const foe = this.remotePlayers({ players: [target] })[0];
    if (!this.isObscured(ctx, { x: me.x, y: me.y, z: me.z + 1 }, { x: foe.x, y: foe.y, z: foe.z + 1 })) return false;
    const route = this.routeTo(ctx, { x: foe.x, y: foe.y, z: foe.z }, CHASE_DEST_SLACK);
    if (!route) return false;
    // Roger's chase may have asked for its jump over the building in the way,
    // at its own rough speed; the route decides whether there is one, and
    // jumps it as planned.
    const rogerJump = ctx.out.jump;
    ctx.out.jump = false;
    if (!this.followRoute(ctx, route)) {
      ctx.out.jump = rogerJump;
      return false;
    }
    ctx.out.intent.mode = 'chase';
    return true;
  }

  // The foe close enough to stop a capture for: one Ace could shoot -- in
  // sight and on his level -- within `CAPTURE_CHASE_RANGE`, or the one he is
  // already fighting until it gets past `CAPTURE_RELEASE_RANGE`. A foe he
  // cannot shoot is only a reason to stall.
  closeFoe(ctx) {
    const { view, me } = ctx;
    const share = this.teamBehind(ctx) ? BEHIND_CHASE_SHARE : 1;
    let nearest = null;
    let kept = null;
    for (const p of this.remotePlayers(view)) {
      if (!p.alive || p.paused || !view.isFoe(p)) continue;
      if (p.zoned && !me.zoned) continue;
      if (Math.abs(p.z - me.z) >= 2 * view.world.tankHeight) continue;
      const d = distance2D(me, p);
      if (d >= CAPTURE_RELEASE_RANGE * share) continue;
      if (this.isObscured(ctx, { x: me.x, y: me.y, z: me.z + 1 }, { x: p.x, y: p.y, z: p.z + 1 })) continue;
      if (p.id === this.fightId) kept = p;
      if (d < CAPTURE_CHASE_RANGE * share && (!nearest || d < nearest.d)) nearest = { p, d };
    }
    const foe = kept ?? nearest?.p ?? null;
    this.fightId = foe ? foe.id : null;
    return foe;
  }

  // Roger backs away from a foe inside half a shot's range, which here would
  // only carry Ace out past the release range and back to the capture that
  // brought him in again. He holds his ground and turns on it instead; a shot
  // coming at him is the dodge's business, which comes first.
  fightClose(ctx, foe) {
    const { out } = ctx;
    out.targetId = foe.id;
    out.intent.target = { ...pointOf(foe), id: foe.id };
    out.intent.mode = 'fight';
    this.aimAt(ctx, azimuthTo(ctx.me, predict(foe)));
    out.speed = 0;
    return true;
  }

  // The foe in the air whose landing Ace can still put a shot into, nearest
  // first, at any distance a shot carries: it is the surest kill there is.
  // Too late once he has turned to it is too late for good -- the shot is
  // faster than the tank, so driving closer loses more time than it saves --
  // and a foe already shot at is left to that shot.
  ambushTarget(ctx) {
    const { view, me } = ctx;
    const top = me.topSpeed ?? view.world.tankSpeed;
    const full = { low: -0.5 * top, high: top, top };
    let best = null;
    for (const p of this.remotePlayers(view)) {
      if (!p.airborne || !p.alive || p.paused || !view.isFoe(p)) continue;
      if (p.zoned && !me.zoned) continue;
      for (const plan of this.planShots(ctx, p)) {
        const shotAt = this.landingShots.get(p.id);
        if (shotAt !== undefined && Math.abs(shotAt - plan.landsAt) < 0.5) break;
        // Judged from when he will be facing it, since turning takes time too.
        const turn = Math.abs(normalizeAngle(azimuthTo(me, plan.landing) - me.azimuth))
          / this.turnRate(ctx);
        if (turn >= plan.landing.t) continue;
        const aimed = {
          ...plan,
          enter: Math.max(0, plan.enter - turn),
          landing: { ...plan.landing, t: plan.landing.t - turn },
        };
        if (this.landingShotSpeed(ctx, aimed, 0, full).late) continue;
        if (plan.reach > (me.shotSpeed + top) * (me.shotLifetime ?? Infinity)) continue;
        if (this.isObscured(ctx, { x: me.x, y: me.y, z: me.z }, plan.landing)) continue;
        // The soonest chance at this foe is the one to line up for.
        if (!best || plan.distance < best.plan.distance) best = { p, plan };
        break;
      }
    }
    return best;
  }

  // Lined up on the landing at whatever speed lets the shot go soonest: the
  // one it fires at, if one fits now (`chooseShot` sets it); full reverse when
  // the shot would still be early, since backing off along the line makes it
  // later without spoiling the aim; full ahead if it would be late.
  ambush(ctx, { p, plan }) {
    const { out } = ctx;
    out.targetId = p.id;
    out.intent.target = { ...pointOf(p), id: p.id };
    out.intent.mode = 'ambush';
    out.intent.landing = pointOf(plan.landing);
    const range = this.speedRange(ctx);
    const now = this.landingShotSpeed(ctx, plan, 0, range);
    const shot = this.shotToward(ctx, plan.landing, Number.isFinite(now.speed) ? now.speed : 0)
      || { azimuth: azimuthTo(ctx.me, plan.landing) };
    this.aimAt(ctx, shot.azimuth);
    if (now.late) out.speed = 1;
    else if (now.early && this.openDistance(ctx, ctx.me, ctx.me.azimuth + Math.PI) > 4) out.speed = -0.5;
    else out.speed = Number.isFinite(now.speed) ? now.speed / range.top : 0;
    return true;
  }

  // Every shot is checked before it leaves: one that would bounce back into
  // Ace is not fired. Roger, as upstream's does, fires and finds out.
  fireAtTank(ctx) {
    const lastShot = this.lastShot;
    const landingShots = new Map(this.landingShots);
    // The lunge's last frame: the shot went with the last one, so stand still.
    if (this.lungeStop) {
      this.lungeStop = false;
      ctx.out.speed = 0;
    }
    const holding = Math.abs(ctx.out.speed) < LUNGE_HOLD_SPEED;
    // Given up when it takes too long, or when anything else -- a dodge, a
    // chase -- wants the tank to move.
    if (this.lunge && (ctx.view.now - this.lunge.at > LUNGE_SECONDS || !holding)) this.lunge = null;
    // Still lunging: keep the speed the shot is waiting on, so the move it goes
    // with says the same.
    if (this.lunge) ctx.out.speed = 1;
    const speed = ctx.out.speed;
    this.landingShotChosen = false;
    this.chooseShot(ctx);
    if (!ctx.out.fire) {
      if (!this.lunge && holding) this.startLunge(ctx);
      return;
    }
    if (this.lunge) {
      this.lunge = null;
      this.lungeStop = true;
    }
    if (!this.mayUseShot(ctx)) {
      ctx.out.fire = false;
      ctx.out.shotTargetId = null;
      ctx.out.speed = speed;
      this.lastShot = lastShot;
      this.landingShots = landingShots;
      this.stats.kept++;
      return;
    }
    const shot = { ...this.muzzleRay(ctx), ...this.shotVelocity(ctx) };
    if (this.shotEndangersSelf(ctx)) {
      ctx.out.fire = false;
      ctx.out.shotTargetId = null;
      ctx.out.speed = speed;
      this.lastShot = lastShot;
      this.landingShots = landingShots;
      this.stats.held++;
      // Shown all the same, as the shot that was not fired and why.
      ctx.out.intent.shot = { ...shot, segments: this.lastTrace, held: true };
      return;
    }
    ctx.out.intent.shot = { ...shot, segments: this.lastTrace };
  }

  // A foe lined up, standing still and in sight, whom a shot fired at full
  // speed forward reaches and one fired now does not: drive forward, and the
  // ordinary trigger fires once the speed is there (`fireAtGrounded`).
  startLunge(ctx) {
    const { view, me, out } = ctx;
    if (me.inAir || !me.canFire || me.flag === 'SW' || me.flag === 'GM') return;
    if (view.now - this.lastShot < 1 / view.world.maxShots) return;
    const base = view.world.shotSpeed;
    const top = me.topSpeed ?? view.world.tankSpeed;
    const factor = (me.shotSpeed ?? base) / base;
    const along = ((me.vx ?? 0) * Math.cos(me.azimuth)) + ((me.vy ?? 0) * Math.sin(me.azimuth));
    const reachAt = (forward) => (me.muzzleForward ?? 0)
      + ((base + forward) * factor * (me.shotLifetime ?? Infinity)) + TANK.radius;
    const errorLimit = (view.world.maxShots * view.world.lockOnAngle) / 8;
    const pos = { x: me.x, y: me.y, z: me.z };
    const target = this.remotePlayers(view).find((p) => {
      if (!view.isFoe(p) || !p.alive || p.paused || p.notResponding) return false;
      if (p.zoned && !me.zoned && me.flag !== 'SB') return false;
      if (Math.hypot(p.vx ?? 0, p.vy ?? 0) >= LUNGE_STILL_SPEED) return false;
      if (Math.abs(me.z - p.z) >= 2 * view.world.tankHeight) return false;
      const dist = distance2D(me, p);
      if (dist <= reachAt(along) || dist > reachAt(top)) return false;
      if (angleDifference(pos, me.azimuth, p) >= errorLimit) return false;
      return me.flag === 'SB' || !this.isObscured(ctx, pos, p);
    });
    if (!target) return;
    if (this.openDistance(ctx, pos, me.azimuth) < LUNGE_CLEARANCE) return;
    const ahead = this.surfaceAt(view,
      me.x + (LUNGE_CLEARANCE * Math.cos(me.azimuth)),
      me.y + (LUNGE_CLEARANCE * Math.sin(me.azimuth)),
      me.z + 1);
    if (Math.abs(ahead - me.z) > 0.5) return;
    this.lunge = { id: target.id, at: view.now };
    out.speed = 1;
    out.targetId = target.id;
    out.intent.mode = 'lunge';
    out.intent.target = { ...pointOf(target), id: target.id };
  }

  // Whether the shot chosen this frame may go: always while more slots are
  // free than Ace keeps back, and from the kept ones only at a foe close
  // enough to need it, or at one coming down where a landing shot meets it --
  // a tank in the air cannot turn aside, so that is the surest shot he has.
  mayUseShot(ctx) {
    const { view, me, out } = ctx;
    if (this.landingShotChosen) return true;
    const free = view.self.freeShots;
    const maxShots = view.world.maxShots;
    if (!Number.isFinite(free) || !(maxShots > 1)) return true;
    const reserve = Math.ceil(maxShots * SHOT_RESERVE_FRACTION);
    if (free > reserve) return true;
    const target = this.remotePlayers(view).find((p) => p.id === out.shotTargetId);
    return Boolean(target) && distance2D(me, target) <= SHOT_RESERVE_SPEND_RANGE;
  }

  // The shot a trigger pulled this frame fires: upstream's velocity -- this
  // frame's own speed along the barrel on the ground, the one he left with in
  // the air -- as its strategy scales it.
  shotVelocity(ctx) {
    const { view, me, out } = ctx;
    const self = view.self;
    const base = view.world.shotSpeed;
    const dirX = Math.cos(self.azimuth);
    const dirY = Math.sin(self.azimuth);
    const range = this.speedRange(ctx);
    const own = me.inAir
      ? { x: self.velocity?.x ?? 0, y: self.velocity?.y ?? 0 }
      : { x: dirX * out.speed * range.top, y: dirY * out.speed * range.top };
    const vx = own.x + (base * dirX);
    const vy = own.y + (base * dirY);
    const length = Math.hypot(vx, vy) || 1;
    return {
      dir: { x: vx / length, y: vy / length, z: 0 },
      speed: me.flag === 'GM' ? base : length * (self.shotSpeed / base),
    };
  }

  // Whether the shot about to be fired comes back to where Ace is. Only a
  // ricochet can, and only once it has had time to turn round.
  shotEndangersSelf(ctx) {
    const { view } = ctx;
    const self = view.self;
    this.lastTrace = null;
    if (!self.ricochet || typeof view.traceShot !== 'function') return false;
    const dirX = Math.cos(self.azimuth);
    const dirY = Math.sin(self.azimuth);
    const muzzle = {
      x: self.x + (dirX * self.muzzleForward),
      y: self.y + (dirY * self.muzzleForward),
      z: self.z + self.muzzleHeight,
    };
    const reach = TANK.radius + SELF_HIT_MARGIN;
    const shot = this.shotVelocity(ctx);
    const segments = view.traceShot(muzzle, shot.dir, shot.speed, self.shotLifetime, true);
    this.lastTrace = segments;
    for (const segment of segments) {
      if (segment.t0 < SELF_HIT_GRACE_SECONDS) continue;
      if (segment.to.z > self.z + view.world.tankHeight + 1) continue;
      if (segmentDistance2D(segment.from, segment.to, self) < reach) return true;
    }
    return false;
  }

  // Roger's trigger for every foe on the ground; one timed shot for a foe in
  // the air, and nothing else at it.
  chooseShot(ctx) {
    const { view, me, out } = ctx;
    const players = this.remotePlayers(view);
    for (const p of players) {
      if (!p.airborne || !p.alive || p.paused || !view.isFoe(p)) continue;
      if (!me.canFire) continue;
      for (const plan of this.planShots(ctx, p)) {
        const shotAt = this.landingShots.get(p.id);
        if (shotAt !== undefined && Math.abs(shotAt - plan.landsAt) < 0.5) break;
        // Late is a miss; early waits for a later frame. A dodge has already
        // picked the speed, and the shot has to make do with it.
        const range = this.speedRange(ctx);
        const preferred = out.speed * range.top;
        const shot = this.landingShotSpeed(ctx, plan, preferred,
          out.intent.mode === 'dodge' ? { ...range, low: preferred, high: preferred } : range);
        if (!Number.isFinite(shot.flight)) continue;
        const miss = plan.distance * Math.abs(Math.sin(normalizeAngle(shot.azimuth - me.azimuth)));
        if (miss > TANK.radius / 2) continue;
        if (this.isObscured(ctx, { x: me.x, y: me.y, z: me.z }, plan.landing)) continue;
        out.fire = true;
        out.shotTargetId = p.id;
        this.landingShotChosen = true;
        if (!me.inAir) out.speed = shot.speed / range.top;
        this.landingShots.set(p.id, plan.landsAt);
        this.lastShot = view.now;
        return;
      }
    }
    // His own shots are sighted muzzle to muzzle (`isObscured`).
    this.sightLift = me.muzzleHeight ?? 1.57;
    try {
      this.fireAtGrounded(ctx);
    } finally {
      this.sightLift = 0;
    }
  }

  fireAtGrounded(ctx) {
    const { view, me } = ctx;
    // A tank with a landing shot already on its way is left to it. From the
    // air a shot goes out level at the muzzle's height, so only a foe whose
    // body that height is inside is worth one: Roger's two tank heights
    // either way would put most of them over its head on the way down.
    // And from the air there is one pass through that height, so the shot goes
    // only when its line runs through the foe, not merely near the heading
    // Roger's trigger takes: a tenth of a radian is several units at range.
    const muzzle = me.z + (me.muzzleHeight ?? 1.57);
    // The line the shot itself takes: barrel plus the tank's own velocity.
    const base = view.world.shotSpeed;
    const sx = (me.vx ?? 0) + (base * Math.cos(me.azimuth));
    const sy = (me.vy ?? 0) + (base * Math.sin(me.azimuth));
    const length = Math.hypot(sx, sy) || 1;
    const ux = sx / length;
    const uy = sy / length;
    const onLine = (p) => {
      const rx = p.x - me.x;
      const ry = p.y - me.y;
      return (rx * ux) + (ry * uy) > 0 && Math.abs((rx * uy) - (ry * ux)) < TANK.radius * AIR_SHOT_SHARE;
    };
    // Roger fires at anything lined up, however far (AutoPilot.cxx:703). Ace
    // fires only at a foe the shot can reach: from the muzzle, as far as it
    // flies in its life -- its flag's speed along this line, a Guided
    // Missile's the world's -- and into the hit sphere. Judged where Roger
    // judges the aim, 0.3 seconds ahead.
    const travel = me.flag === 'GM' ? base : length * ((me.shotSpeed ?? base) / base);
    const reach = (me.muzzleForward ?? 0) + (travel * (me.shotLifetime ?? Infinity)) + TANK.radius;
    const inRange = (p) => me.flag === 'SW' || distance2D(me, {
      x: p.x + (0.3 * (p.vx ?? 0)),
      y: p.y + (0.3 * (p.vy ?? 0)),
    }) <= reach;
    const grounded = {
      ...view,
      players: view.players.filter((p) => !p.airborne
        && !(view.now <= (this.landingShots.get(p.id) ?? -Infinity) + 0.5)
        && inRange(p)
        && (!me.inAir || (muzzle >= p.z && muzzle <= p.z + view.world.tankHeight && onLine(p)))),
    };
    super.fireAtTank({ ...ctx, view: grounded });
  }

  // Staying alive comes first, and moving out of a shot's way before jumping
  // over it: a tank in the air cannot steer, so it is the easiest one to hit
  // next. For the shot that would hit soonest, Ace drives forward or back --
  // whichever clears its line first -- if that clears it in time and the way
  // is open; jumps only if not, and only where the jump is above the shot
  // before it arrives; and otherwise dodges as Roger does.
  avoidBullet(ctx) {
    const { view, me, out } = ctx;
    const shot = this.soonestHit(ctx);
    const squash = this.squashThreat(ctx);
    const threat = squash && (!shot || squash.time < shot.time) ? squash : shot;
    if (!threat) return false;
    // Underground nothing but another burrowed tank's shot reaches him, and
    // a jump would lift him into all of them: he drives out of the way or
    // takes it.
    const burrowed = me.flag === 'BU' && me.z < 0;
    const heading = { x: Math.cos(me.azimuth), y: Math.sin(me.azimuth) };
    let lateral = (heading.x * threat.away.x) + (heading.y * threat.away.y);
    // Dead on, neither side is nearer, so take the one ahead: forward is
    // twice reverse.
    if (threat.miss < DODGE_DEAD_ON && lateral < 0) lateral = -lateral;
    const needed = threat.clearance - threat.miss;
    const forwardRate = view.world.tankSpeed * lateral;
    const reverseRate = -0.5 * view.world.tankSpeed * lateral;
    const [speed, rate] = forwardRate >= reverseRate ? [1, forwardRate] : [-0.5, reverseRate];
    if (rate > 0 && needed / rate < threat.time - DODGE_MARGIN_SECONDS) {
      const travel = (needed / rate) * Math.abs(speed) * view.world.tankSpeed;
      const way = speed > 0 ? me.azimuth : me.azimuth + Math.PI;
      if (this.openDistance(ctx, me, way) > travel + 2) {
        out.speed = speed;
        out.rotation = 0;
        return true;
      }
    }
    // Underground and about to be driven over with no way to drive clear --
    // head on, forward is into it and reverse is too slow -- a jump is the way
    // out: shots may find him up there, the tank certainly would down here.
    if (threat === squash) {
      if (me.inAir || this.jumpReach(ctx) <= 0) return false;
      out.jump = true;
      out.speed = 0;
      return true;
    }
    if (burrowed) return false;
    if (this.canJumpClear(ctx, threat)) {
      out.jump = true;
      out.speed = speed;
      return true;
    }
    return super.avoidBullet(ctx);
  }

  // Burrowed, the one thing that kills him from above ground is being driven
  // over (`canRunOver`): any tank on the ground or above that passes within
  // the run-over reach. The soonest such pass in the next moment, in the
  // shape `soonestHit` gives a shot, or null.
  squashThreat(ctx) {
    const { view, me } = ctx;
    if (me.flag !== 'BU' || !(me.z < 0)) return null;
    let best = null;
    for (const p of this.remotePlayers(view)) {
      if (!p.alive || p.paused) continue;
      if (!canRunOver(p.flag ?? null, 'BU', p.z, p.zoned === true)) continue;
      const clearance = getRunOverRadius('BU', p.flag ?? null, TANK.radius) + SQUASH_MARGIN;
      const rx = me.x - p.x;
      const ry = me.y - p.y;
      const speed2 = (p.vx * p.vx) + (p.vy * p.vy);
      if (speed2 < 1e-6) continue;
      const time = ((rx * p.vx) + (ry * p.vy)) / speed2;
      if (time <= 0 || time > SQUASH_HORIZON_SECONDS) continue;
      const mx = rx - (p.vx * time);
      const my = ry - (p.vy * time);
      const miss = Math.hypot(mx, my);
      if (miss >= clearance) continue;
      if (best && time >= best.time) continue;
      const length = Math.sqrt(speed2);
      const away = miss > 1e-6 ? { x: mx / miss, y: my / miss } : { x: -p.vy / length, y: p.vx / length };
      best = { time, miss, away, clearance };
    }
    return best;
  }

  // Of the shots Ace can see, the one that will hit him soonest if he stays
  // put: when it passes closest, by how much, and which way is away from it.
  soonestHit(ctx) {
    const { view, me } = ctx;
    const clearance = TANK.radius + SHOT_COLLISION_RADIUS + DODGE_CLEARANCE;
    let best = null;
    for (const shot of view.shots) {
      if (shot.ownerId === me.id) continue;
      if (shot.ownerZoned && !me.zoned) continue;
      if (shot.flag === 'L' && me.flag === 'CL') continue;
      const pos = pointOf(shot);
      const { vx, vy } = shot;
      const speed2 = (vx * vx) + (vy * vy);
      if (speed2 < 1e-6) continue;
      // Only a shot at the height of his body: a burrowed tank's body is
      // mostly below the ground, and the shells of a tank on the ground fly
      // over it -- dodging those, by a jump of all things, gives up the one
      // thing Burrow is for.
      if (shot.flag !== 'GM' && (pos.z < me.z - SHOT_COLLISION_RADIUS
        || pos.z > me.z + view.world.tankHeight + SHOT_COLLISION_RADIUS)) continue;
      const rx = me.x - pos.x;
      const ry = me.y - pos.y;
      const time = ((rx * vx) + (ry * vy)) / speed2;
      if (time <= 0 || time > DODGE_HORIZON_SECONDS) continue;
      const mx = rx - (vx * time);
      const my = ry - (vy * time);
      const miss = Math.hypot(mx, my);
      if (miss >= clearance) continue;
      if (best && time >= best.time) continue;
      const length = Math.sqrt(speed2);
      // Dead on, either side is away; take the left of the shot.
      const away = miss > 1e-6 ? { x: mx / miss, y: my / miss } : { x: -vy / length, y: vx / length };
      best = { time, miss, away, clearance, height: pos.z - me.z };
    }
    return best;
  }

  canJumpClear(ctx, threat) {
    const { view, me } = ctx;
    if (me.inAir || this.jumpReach(ctx) <= 0) return false;
    const v = view.world.jumpVelocity;
    const g = view.world.gravity;
    const rise = threat.height + SHOT_COLLISION_RADIUS;
    if (rise <= 0) return true;
    const disc = (v * v) - (2 * g * rise);
    if (disc < 0) return false;
    return (v - Math.sqrt(disc)) / g < threat.time;
  }

  // The antidote, when Ace carries a bad flag the server will let him shed
  // there and its own way out is slow or never: shake-off time longer than
  // the drive, or none at all.
  antidoteTarget(ctx) {
    const { view, me } = ctx;
    const antidote = view.antidote;
    if (!antidote || !me.flag || !isBadFlag(me.flag)) return null;
    const pos = pointOf(antidote);
    const drive = distance2D(me, pos) / (view.world.tankSpeed || 1);
    const timeout = view.world.shakeTimeout || 0;
    if (timeout > 0 && timeout < (drive * ANTIDOTE_DRIVE_FACTOR) + ANTIDOTE_SPARE_SECONDS) return null;
    return pos;
  }

  // The team flag worth fetching: an enemy's on the ground anywhere, or Ace's
  // own lying away from home. Roger only looks at a team flag he is all but
  // standing on, so he hardly ever makes a capture.
  captureTarget(ctx) {
    const { view, me } = ctx;
    if (!view.world.teamFlags || me.flagTeam !== null) return null;
    if (me.flag && isBadFlag(me.flag)) return null;
    const base = view.myBase();
    const reach = this.jumpReach(ctx) * JUMP_REACH_SHARE;
    const routed = typeof view.findRoute === 'function';
    let best = null;
    let ours = null;
    for (const flag of view.flags) {
      if (!flag.onGround || flag.team === null) continue;
      const pos = pointOf(flag);
      // With a route graph a flag is worth going for until no route reaches
      // it. Without one, only where driving straight at it gets there: down,
      // level, or up one jump.
      if (routed) {
        if ((this.unreachable.get(flag.index) ?? -Infinity) > view.now) continue;
      } else if (pos.z - me.z > Math.max(reach, MAX_STEP_UP)) {
        continue;
      }
      if (flag.team === me.teamColor) {
        if (!base || this.isHome(pos, base)) continue;
      }
      const dist = distance2D(me, pos);
      if (flag.team === me.teamColor) {
        if (!ours || dist < ours.dist) ours = { flag, pos, dist };
      } else if (!best || dist < best.dist) {
        best = { flag, pos, dist };
      }
    }
    // Home first: Ace's own flag unless an enemy one is much nearer.
    if (ours && (!best || best.dist >= ours.dist * RETURN_PREFERENCE)) return { ...ours, returning: true };
    return best;
  }

  // How high one jump lifts the tank, if it may jump at all.
  jumpReach(ctx) {
    const { view, me } = ctx;
    const canJump = (view.world.allowJumping || me.flag === 'JP' || me.flag === 'WG') && me.flag !== 'NJ';
    if (!canJump || !(view.world.gravity > 0)) return 0;
    return (view.world.jumpVelocity * view.world.jumpVelocity) / (2 * view.world.gravity);
  }

  lookForFlag(ctx) {
    const antidote = this.antidoteTarget(ctx);
    if (antidote) return this.goTo(ctx, antidote, 'antidote');
    const target = this.captureTarget(ctx);
    if (!target) return super.lookForFlag(ctx);
    const { me, out } = ctx;
    out.intent.mode = target.returning ? 'return' : 'capture';
    out.intent.target = { ...target.pos, flag: target.flag.type ?? null };
    // One flag at a time: whatever is held goes when the team flag is in reach.
    if (target.dist < 10 && me.flag) out.dropFlag = true;
    if (typeof ctx.view.findRoute === 'function') {
      const route = this.routeTo(ctx, target.pos);
      if (route && this.followRoute(ctx, route)) return true;
      if (!route) {
        this.unreachable.set(target.flag.index, ctx.view.now + UNREACHABLE_SECONDS);
        return super.lookForFlag(ctx);
      }
    }
    out.rotation = normalizeAngle(azimuthTo(me, target.pos) - me.azimuth);
    out.speed = HALF_PI - Math.abs(out.rotation);
    // Up onto whatever the flag sits on: at full speed, from where the jump
    // clears the top on the way up and comes down on it before falling past.
    const rise = target.pos.z - me.z;
    if (rise > MAX_STEP_UP && Math.abs(out.rotation) < JUMP_AIM_TOLERANCE && !me.inAir) {
      const edge = ctx.view.firstBuilding(me, me.azimuth, JUMP_LOOKAHEAD);
      if (edge && edge.top - me.z <= this.jumpReach(ctx)) this.takeJump(ctx, edge.top - me.z, edge.distance);
    }
    return true;
  }

  // Somewhere to be, by a route where there is one and straight there where not.
  goTo(ctx, pos, mode) {
    const { out, me } = ctx;
    out.intent.mode = mode;
    out.intent.target = pointOf(pos);
    if (typeof ctx.view.findRoute === 'function') {
      const route = this.routeTo(ctx, pos);
      if (route && this.followRoute(ctx, route)) return true;
    }
    out.rotation = normalizeAngle(azimuthTo(me, pos) - me.azimuth);
    out.speed = HALF_PI - Math.abs(out.rotation);
    return true;
  }

  // Carrying a team flag home, by the route there rather than straight at it.
  navigate(ctx) {
    const { view, me } = ctx;
    if (me.flagTeam !== null && typeof view.findRoute === 'function') {
      const base = view.myBase();
      const pos = { x: me.x, y: me.y, z: me.z };
      const home = base && me.flagTeam === me.teamColor && this.isHome(pos, base);
      if (base && !home) {
        ctx.out.intent.mode = 'home';
        ctx.out.intent.target = pointOf(base);
        const route = this.routeTo(ctx, pointOf(base));
        if (route && this.followRoute(ctx, route)) return true;
      }
    }
    // Nothing nearer to do: the best foe, wherever it is. Wandering is for a
    // world with nobody to find.
    if (me.flagTeam === null && !this.isRabbit(ctx)) {
      const foe = this.findBestTarget(ctx, this.remotePlayers(view));
      if (foe) return this.huntFar(ctx, foe);
    }
    return super.navigate(ctx);
  }

  // The route to `dest`, planned when the destination moves,
  // when Ace has strayed from it, or every few seconds; a destination no route
  // reaches is not asked about again for a while.
  // `slack` is how far the destination may move before it is a new one: a
  // chased tank moves all the time, and every new destination costs a search.
  routeTo(ctx, dest, slack = ROUTE_DEST_SLACK) {
    const { view, me } = ctx;
    const here = pointOf(me);
    const there = pointOf(dest);
    const current = this.route;
    const sameDest = current && Math.hypot(current.dest.x - there.x, current.dest.y - there.y) < slack
      && Math.abs(current.dest.z - there.z) < 1;
    if (sameDest && !current.nodes) {
      return view.now - current.plannedAt < UNREACHABLE_SECONDS ? null : this.plan(view, here, there);
    }
    if (sameDest && view.now - current.plannedAt < ROUTE_REPLAN_SECONDS && !this.strayed(current, here)) {
      return current;
    }
    return this.plan(view, here, there);
  }

  plan(view, here, there) {
    const nodes = view.findRoute(here, there);
    this.stats.plans++;
    if (!nodes) this.stats.unreachable++;
    this.route = { dest: there, from: here, nodes, at: 0, plannedAt: view.now };
    return nodes ? this.route : null;
  }

  // Measured from the last node reached rather than the next, which across a
  // jump is the far side of it.
  strayed(route, here) {
    const nodes = route.nodes;
    if (!nodes?.length) return true;
    const at = Math.min(route.at, nodes.length - 1);
    const last = at > 0 ? nodes[at - 1] : route.from;
    if (!last) return true;
    // Off the leg being driven, not just far from its start: a straightened
    // route's legs run tens of units.
    return segmentDistance2D(last, nodes[at], here) > ROUTE_STRAY;
  }

  // One frame along a route: on to the next node, past the ones on the same
  // level, and up a jump when lined up for it. False once the route is run.
  followRoute(ctx, route) {
    const { me, out } = ctx;
    const here = pointOf(me);
    const nodes = route.nodes;
    // Up off the ground, where an edge is a fall, a node counts only once Ace
    // is on it and the aim does not run ahead to cut a corner.
    const raised = here.z > MAX_STEP_UP;
    const tuning = this.tuning;
    const reached = raised ? tuning.reachedRaised : tuning.reachedGround;
    while (route.at < nodes.length) {
      const node = nodes[route.at];
      if (Math.abs(node.z - here.z) > 1) break;
      const distance = Math.hypot(node.x - here.x, node.y - here.y);
      if (distance <= reached) {
        route.at++;
        continue;
      }
      // Driven past rather than over: beyond the node, in the direction the
      // route goes on from it, and near it. Turning back to touch it is how a
      // tank that turns an eighth of a circle a second spends its life.
      const after = nodes[route.at + 1];
      if (!after || distance > tuning.passRange) break;
      const ahead = ((here.x - node.x) * (after.x - node.x)) + ((here.y - node.y) * (after.y - node.y));
      if (ahead <= 0) break;
      route.at++;
    }
    if (route.at >= nodes.length) return false;
    out.intent.route = nodes.slice(route.at);
    const next = nodes[route.at];
    if (next.flight && !me.inAir) {
      if (next.z > MAX_STEP_UP) this.shedPhasingOnTakeoff(ctx);
      if (!next.flight.jump && this.driveOffDirect(ctx, here, next)) return true;
      this.fly(ctx, here, route.at > 0 ? nodes[route.at - 1] : here, next.flight, next,
        this.landingAim(nodes, route.at));
      return true;
    }
    let aim = next;
    if (!next.jump && !next.bridge) {
      if (tuning.follow === 'pursuit') {
        aim = this.pursuitPoint(ctx, here, nodes, route.at, raised);
      } else if (!raised) {
        aim = this.groundAim(ctx, here, nodes, route.at, tuning.groundLookahead);
      }
    }
    out.rotation = normalizeAngle(azimuthTo(me, aim) - me.azimuth);
    if (tuning.speed === 'arrival') {
      out.speed = this.arrivalSpeed(ctx, here, aim, out.rotation);
    } else {
      // Far off the heading, turn on the spot rather than drive a wide arc --
      // or, past a right angle, backwards away from the route.
      out.speed = Math.abs(out.rotation) > tuning.turnInPlace ? 0 : HALF_PI - Math.abs(out.rotation);
    }
    if (raised && tuning.raised === 'curve') {
      out.speed = Math.min(out.speed, this.cornerSpeed(here, nodes, route.at, out.rotation));
    } else if (raised && Math.abs(out.rotation) > tuning.raisedTurn) {
      out.speed = Math.min(out.speed, tuning.raisedSpeed);
    }
    if (next.jump && !next.flight && !me.inAir) this.lineUpJump(ctx, here, next);
    // A gap is crossed square to it, or a corner of the tank drops into it.
    if (next.bridge && Math.abs(out.rotation) >= BRIDGE_AIM_TOLERANCE) out.speed = 0;
    // Everything above reads `out.rotation` as the bearing off the aim; the
    // tank is steered by it only now. A turn in proportion to the bearing --
    // Roger's -- closes it slowly, which on a long straight leg means curving
    // wide at full speed into whatever is beside the line. Full turn until
    // the bearing is a fraction of a second's turning away, then in
    // proportion to it.
    out.rotation = this.steer(ctx, out.rotation);
    return true;
  }

  // How fast this tank turns at full stick: the world's rate as its flag
  // leaves it -- Burrow, underground, at a little over half -- where the view
  // says, the world's otherwise.
  turnRate(ctx) {
    return ctx.me.turnRate || ctx.view.world.tankAngVel || (Math.PI / 4);
  }

  steer(ctx, bearing) {
    const rate = this.turnRate(ctx);
    return Math.max(-1, Math.min(1, bearing / (rate * ROUTE_TURN_SECONDS)));
  }

  // Roger's wall test fires on a wall within five units ahead, moving or not,
  // and then drives a fixed second of back-and-forward -- which on a route
  // that runs beside a wall throws the route away, and against a corner the
  // forward half drives straight back into it. Ace backs off only when
  // `checkProgress` has measured that he is stuck, in whatever he was doing.
  stuckOnWall(ctx) {
    const { view, out } = ctx;
    if (view.now >= this.unstickUntil + UNSTICK_DRIVE_SECONDS) return false;
    out.speed = view.now < this.unstickUntil ? UNSTICK_SPEED : 1;
    out.rotation = this.unstickTurn;
    return true;
  }

  // A tank asked to turn or to move that does neither is against something:
  // a wall refuses a turn that would swing the tank into it, and one met at a
  // slant lets it grind along at a fraction of the speed asked for. Measured
  // over half a second against what was asked in that time, in every mode, so
  // a chase into a wall is caught as surely as a route that cuts a corner.
  checkProgress(ctx) {
    const { view, me, out } = ctx;
    if (view.now < this.unstickUntil + UNSTICK_DRIVE_SECONDS) return;
    const top = me.topSpeed ?? view.world.tankSpeed;
    const sample = this.progress;
    const trying = Math.abs(out.rotation) > 0.1 || Math.abs(out.speed) > 0.1;
    const restart = () => {
      this.progress = { t: view.now, x: me.x, y: me.y, azimuth: me.azimuth, asked: 0 };
    };
    if (!sample || !trying || me.inAir) {
      restart();
      return;
    }
    sample.asked += Math.abs(out.speed) * top * (this.frameSeconds || 0);
    const turned = Math.abs(normalizeAngle(me.azimuth - sample.azimuth));
    const moved = Math.hypot(me.x - sample.x, me.y - sample.y);
    if (turned > UNSTICK_TURN || moved > Math.max(UNSTICK_MOVE, UNSTICK_SHARE * sample.asked)) {
      restart();
      return;
    }
    if (view.now - sample.t <= UNSTICK_SECONDS) return;
    // Back off turning: the way it was trying to turn, where a wall refused
    // the turn, and otherwise toward the more open side, as Roger chooses.
    if (Math.abs(out.rotation) > 0.2) {
      this.unstickTurn = Math.sign(out.rotation);
    } else {
      const left = this.openDistance(ctx, me, me.azimuth + (Math.PI / 4));
      const right = this.openDistance(ctx, me, me.azimuth - (Math.PI / 4));
      this.unstickTurn = left > right ? 1 : -1;
    }
    this.unstickUntil = view.now + UNSTICK_BACKOFF_SECONDS;
    this.progress = null;
    this.stats.unsticks++;
    out.speed = UNSTICK_SPEED;
    out.rotation = this.unstickTurn;
    out.intent.mode = 'unstick';
  }

  // The nearest point to `here` on the legs ending at nodes `at` onward --
  // leg `k` runs from node `k - 1` to node `k` -- as the leg it is on.
  nearestOnRoute(here, nodes, at) {
    let best = { leg: at, distance: Infinity };
    const end = Math.min(nodes.length, at + ROUTE_LOOKAHEAD);
    for (let k = Math.max(1, at); k < end; k++) {
      const a = nodes[k - 1];
      const b = nodes[k];
      // A jump or a gap is entered from its takeoff node and nowhere else:
      // being level with some point along its leg is not being ready for it.
      if (b.jump || b.bridge) break;
      if (Math.abs(b.z - here.z) > 1 && Math.abs(a.z - here.z) > 1) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lengthSquared = (dx * dx) + (dy * dy) || 1;
      const t = Math.max(0, Math.min(1, (((here.x - a.x) * dx) + ((here.y - a.y) * dy)) / lengthSquared));
      const distance = Math.hypot(a.x + (dx * t) - here.x, a.y + (dy * t) - here.y);
      if (distance < best.distance) best = { leg: k, distance, t };
    }
    return best;
  }

  // Pure pursuit: the point a fixed distance further along the route than
  // where Ace is on it, stopping at anything to be taken square -- a jump, a
  // gap, a change of level. Short up on a walkway, so he stays over it; longer
  // on the ground, shortened while a tank's width to it is not clear.
  pursuitPoint(ctx, here, nodes, at, raised) {
    const level = nodes[at].z;
    const { pursuitGround, pursuitRaised, pursuitMin } = this.tuning;
    for (let lead = raised ? pursuitRaised : pursuitGround; lead >= pursuitMin; lead /= 2) {
      let left = lead;
      let from = here;
      let point = nodes[at];
      for (let k = at; k < nodes.length; k++) {
        const node = nodes[k];
        if (k > at && (node.jump || node.bridge || Math.abs(node.z - level) > MAX_STEP_UP)) break;
        const step = Math.hypot(node.x - from.x, node.y - from.y);
        if (step >= left) {
          const t = left / step;
          point = { x: from.x + ((node.x - from.x) * t), y: from.y + ((node.y - from.y) * t), z: node.z };
          left = 0;
          break;
        }
        left -= step;
        from = node;
        point = node;
      }
      if (raised) return point;
      const dx = point.x - here.x;
      const dy = point.y - here.y;
      const length = Math.hypot(dx, dy);
      if (length < 1e-3 || this.laneClear(ctx, here, point, dx / length, dy / length)) return point;
    }
    return nodes[at];
  }

  // How fast to drive up on a walkway: full speed down a straight one, braking
  // for the sharpest bend in the next stretch of route and for how far his
  // heading is off it now -- a corner taken fast on something a tank wide is a
  // fall.
  cornerSpeed(here, nodes, at, rotation) {
    const { cornerLookahead, cornerSlowest } = this.tuning;
    let sharpest = 0;
    let travelled = 0;
    let from = here;
    let heading = null;
    for (let k = at; k < nodes.length && travelled < cornerLookahead; k++) {
      const node = nodes[k];
      const dx = node.x - from.x;
      const dy = node.y - from.y;
      const step = Math.hypot(dx, dy);
      if (step < 1e-3) continue;
      const direction = Math.atan2(dy, dx);
      if (heading !== null) sharpest = Math.max(sharpest, Math.abs(normalizeAngle(direction - heading)));
      heading = direction;
      travelled += step;
      from = node;
    }
    const bend = Math.max(sharpest, Math.abs(rotation));
    return Math.max(cornerSlowest, 1 - (bend / HALF_PI));
  }

  // The fastest Ace can drive and still turn onto a point: at full turn a tank
  // runs a circle of `tankSpeed / turnRate` times its speed, and to come round
  // onto a point `d` off at bearing `b` that circle can be at most
  // `d / (2 sin b)` across. Faster than that, he orbits it and never arrives;
  // past a right angle he turns where he is.
  arrivalSpeed(ctx, here, aim, rotation) {
    const { world } = ctx.view;
    const bearing = Math.abs(rotation);
    if (bearing >= HALF_PI) return 0;
    const turnRadius = (world.tankSpeed || 25) / (world.tankAngVel || (Math.PI / 4));
    const distance = Math.hypot(aim.x - here.x, aim.y - here.y);
    const sine = Math.sin(bearing);
    if (sine < 1e-3) return 1;
    return Math.min(1, distance / (2 * sine * turnRadius));
  }

  // How far along a ground route to aim: the furthest of the next few nodes on
  // the same level with a tank's width of open drive to it. Aiming past the
  // node ahead is what straightens a route's zigzag, and without the lane test
  // it also aims straight through whatever the route goes round -- a support
  // truss's ribs on hix, which the tank drives into and wedges against. Kept
  // while the tank is on the same leg and has not moved far, since each test
  // is three rays.
  groundAim(ctx, here, nodes, at, lookahead) {
    const cached = this.aimCache;
    if (cached && cached.nodes === nodes && cached.at === at
      && Math.hypot(cached.x - here.x, cached.y - here.y) < AIM_RECHECK_DISTANCE) {
      return nodes[cached.k];
    }
    const next = nodes[at];
    let k = at;
    for (let j = at + 1; j < Math.min(nodes.length, at + lookahead); j++) {
      const node = nodes[j];
      if (node.jump || node.bridge || Math.abs(node.z - next.z) > 0.5) break;
      const length = Math.hypot(node.x - here.x, node.y - here.y) || 1;
      if (!this.laneClear(ctx, here, node, (node.x - here.x) / length, (node.y - here.y) / length,
        AIM_LANE_LIFT)) break;
      k = j;
    }
    this.aimCache = { nodes, at, x: here.x, y: here.y, k };
    return nodes[k];
  }

  // A tank's width of open drive from here to there: the centre line and one
  // either side, `lift` above the surface. Low enough to meet a pyramid's
  // sloping end, which a ray at a tank's middle passes over.
  laneClear(ctx, here, there, ux, uy, lift = 1) {
    for (const side of [0, -LANE_HALF_WIDTH, LANE_HALF_WIDTH]) {
      const ox = uy * side;
      const oy = -ux * side;
      const from = { x: here.x + ox, y: here.y + oy, z: here.z + lift };
      const to = { x: there.x + ox, y: there.y + oy, z: there.z + lift };
      if (ctx.view.isObscured(from, to)) return false;
    }
    return true;
  }

  // A flag let go by a tank standing still or turning on the spot lands under
  // it, and the tank picks it straight back up: Ace home on his own base with
  // his team flag dropped it, sat turning for his next move, and was carrying
  // it again. So a drop waits until he is moving and near enough straight,
  // and he keeps going for a moment after, which leaves the flag behind. In
  // the air a drop falls away below, so that one goes at once. Before the
  // death-fall check, which still has the last word on the speed.
  avoidDeathFall(ctx) {
    this.dropOnTheMove(ctx);
    super.avoidDeathFall(ctx);
  }

  dropOnTheMove(ctx) {
    const { view, me, out } = ctx;
    const turn = (rotation) => Math.max(-DROP_MAX_TURN, Math.min(DROP_MAX_TURN, rotation));
    if (view.now < this.dropDriveUntil) {
      out.speed = 1;
      out.rotation = turn(out.rotation);
      out.dropFlag = Boolean(me.flag);
      return;
    }
    if (!out.dropFlag || !me.flag || me.inAir) return;
    const top = me.topSpeed ?? view.world.tankSpeed;
    out.rotation = turn(out.rotation);
    if (Math.abs(me.speed ?? 0) < DROP_MIN_SPEED_SHARE * top) {
      out.dropFlag = false;
      out.speed = 1;
      return;
    }
    out.speed = 1;
    this.dropDriveUntil = view.now + DROP_DRIVE_SECONDS;
  }

  // A drive-off taken from wherever the tank is rather than from its planned
  // takeoff. The route graph flies its arcs from column centres in eight
  // directions, so following it to the letter means driving to that spot,
  // stopping and turning square to it -- on a base, every time it is left. A
  // drive-off has no takeoff to be square to: the tank leaves the edge at
  // whatever speed it has and comes down where that speed and the drop put
  // it. So if a straight line from here to the landing crosses one clear edge,
  // and some speed brings the tank down on the landing's level, it drives
  // straight at it at that speed; otherwise the planned takeoff it is.
  driveOffDirect(ctx, here, landing) {
    const { view, me, out } = ctx;
    const drop = here.z - landing.z;
    if (drop <= MAX_STEP_UP || !(view.world.gravity > 0)) return false;
    const dx = landing.x - here.x;
    const dy = landing.y - here.y;
    const length = Math.hypot(dx, dy);
    if (length < NAV_CELL) return false;
    const ux = dx / length;
    const uy = dy / length;
    let edge = null;
    for (let s = 1; s < length; s += 1) {
      const z = this.surfaceAt(view, here.x + (ux * s), here.y + (uy * s), here.z);
      if (Math.abs(z - here.z) > MAX_STEP_UP) {
        edge = s;
        break;
      }
    }
    if (edge === null) return false;
    const brink = { x: here.x + (ux * edge), y: here.y + (uy * edge), z: here.z };
    if (!this.laneClear(ctx, here, brink, ux, uy, AIM_LANE_LIFT)) return false;
    const top = me.topSpeed ?? view.world.tankSpeed;
    const fall = Math.sqrt((2 * drop) / view.world.gravity);
    // The tank tips once its centre is past the edge.
    const leave = edge + DRIVE_OFF_TIP;
    const speed = Math.min(top, Math.max(DRIVE_OFF_SLOWEST * top, (length - leave) / fall));
    const reach = leave + (speed * fall);
    const down = { x: here.x + (ux * reach), y: here.y + (uy * reach), z: landing.z };
    if (Math.abs(this.surfaceAt(view, down.x, down.y, here.z) - landing.z) > MAX_STEP_UP) return false;
    const below = { x: brink.x, y: brink.y, z: landing.z };
    if (!this.laneClear(ctx, below, down, ux, uy)) return false;
    const bearing = normalizeAngle(Math.atan2(dy, dx) - me.azimuth);
    out.rotation = this.steer(ctx, bearing);
    // Square to it before going over: a tank keeps the turn it leaves the edge
    // with all the way down.
    const lined = Math.abs(bearing) < FLIGHT_AIM_TOLERANCE;
    if (edge < DRIVE_OFF_LINE_UP && !lined) out.speed = 0;
    else out.speed = Math.abs(bearing) > this.tuning.turnInPlace ? 0 : speed / top;
    if (lined) {
      this.lastFlight = {
        at: view.now, jump: false, air: fall, turn: 0, rotation: out.rotation,
        aim: { x: landing.x, y: landing.y }, landing: pointOf(landing),
      };
    }
    return true;
  }

  // The height of whatever a tank would stand on at (x, y), looking down from
  // just above `fromZ`: the ground where there is nothing.
  surfaceAt(view, x, y, fromZ) {
    const hit = view.firstHit({ x, y, z: fromZ + 0.5 }, { x, y, z: -0.1 });
    return hit ? Math.max(0, hit.z) : 0;
  }

  // When and where in a flight the tank's muzzle is level with the middle of
  // a foe's body: rising, if the foe stands above the takeoff, else falling.
  // Null where the flight never gets there, or gets there too soon to turn.
  foePass(ctx, here, flight, foe) {
    const { view, me } = ctx;
    const g = view.world.gravity;
    if (!(g > 0)) return null;
    const vz = flight.jump ? view.world.jumpVelocity : 0;
    const rise = (foe.z + (view.world.tankHeight / 2) - (me.muzzleHeight ?? 1.57)) - here.z;
    const disc = (vz * vz) - (2 * g * rise);
    if (disc < 0) return null;
    const root = Math.sqrt(disc);
    const up = (vz - root) / g;
    const down = (vz + root) / g;
    const t = up > FOE_PASS_SOONEST ? up : down;
    if (!(t > FOE_PASS_SOONEST) || t > flight.air) return null;
    const travel = flight.speed * view.world.tankSpeed * t;
    return { t, x: here.x + (flight.dx * travel), y: here.y + (flight.dy * travel) };
  }

  // The nearest live foe on the surface a flight comes down on, within
  // `CAPTURE_CHASE_RANGE` of the landing, or null.
  foeAtLanding(ctx, landing) {
    const { view, me } = ctx;
    let best = null;
    for (const p of view.players) {
      if (!p.alive || p.paused || !view.isFoe(p)) continue;
      if (p.zoned && !me.zoned) continue;
      if (Math.abs(p.z - landing.z) > 1) continue;
      const d = Math.hypot(p.x - landing.x, p.y - landing.y);
      if (d < CAPTURE_CHASE_RANGE && (!best || d < best.d)) best = { x: p.x, y: p.y, z: p.z, d };
    }
    return best;
  }

  // Where the route goes on to after a landing, for the turn a flight puts on
  // as it leaves: the furthest node on the landing's level within
  // `LANDING_AIM_REACH` of it. Not the next node, a column on: a tank comes
  // down a few units past the landing node as often as not, and from there a
  // node four units beyond it can be beside or behind -- so the tank turned to
  // face it lands facing the wrong way.
  landingAim(nodes, at) {
    const landing = nodes[at];
    let aim = nodes[at + 1] || null;
    for (let k = at + 1; k < nodes.length; k++) {
      const node = nodes[k];
      if (node.jump || node.flight || node.bridge || Math.abs(node.z - landing.z) > 0.5) break;
      aim = node;
      if (Math.hypot(node.x - landing.x, node.y - landing.y) >= LANDING_AIM_REACH) break;
    }
    return aim;
  }

  // A flight as planned: from its takeoff, square to its heading, at its
  // speed -- a jump leaves at once, a drive-off holds the speed to the edge.
  // The arc was worked out for exactly this, so nothing improvises: off the
  // heading, he turns where he stands.
  //
  // A tank keeps turning through the air at the rate it left with, so the
  // turn for the leg after the landing is put on as it leaves: enough to come
  // down facing it.
  fly(ctx, here, takeoff, flight, landing, after) {
    const { me, out } = ctx;
    // On the flight's line: near it across, and along it no further back than
    // the takeoff -- nor further on than the launch, for a drive-off, which is
    // that stretch of driving.
    const rx = here.x - takeoff.x;
    const ry = here.y - takeoff.y;
    const along = (rx * flight.dx) + (ry * flight.dy);
    const across = Math.abs((rx * flight.dy) - (ry * flight.dx));
    const furthest = flight.jump ? FLIGHT_TAKEOFF_SLACK : flight.launch + FLIGHT_TAKEOFF_SLACK + NAV_CELL;
    // Under an acceleration limit a jump needs a run-up to leave at its speed:
    // the distance that speed takes to reach, behind the takeoff.
    const planned = flight.speed * ctx.view.world.tankSpeed;
    const runup = flight.jump && me.accel > 0 ? (planned * planned) / (2 * me.accel) : 0;
    // A jump overshot by a little is backed straight up to, on its line: turning
    // round to drive back and turning again to face it costs more than either.
    if (flight.jump && across <= FLIGHT_TAKEOFF_SLACK && along > furthest && along < furthest + (2 * NAV_CELL)) {
      this.aimAt(ctx, Math.atan2(flight.dy, flight.dx));
      out.speed = -0.5;
      return;
    }
    if (across > FLIGHT_TAKEOFF_SLACK || along < -(FLIGHT_TAKEOFF_SLACK + runup) || along > furthest) {
      out.rotation = normalizeAngle(azimuthTo(me, takeoff) - me.azimuth);
      out.speed = Math.abs(out.rotation) > this.tuning.turnInPlace ? 0 : HALF_PI - Math.abs(out.rotation);
      return;
    }
    const heading = Math.atan2(flight.dy, flight.dx);
    const speed = flight.speed;
    const off = this.aimAt(ctx, heading);
    const aligned = Math.abs(off) < FLIGHT_AIM_TOLERANCE;
    out.speed = aligned ? speed : 0;
    if (!aligned) return;
    // A jump keeps the speed the tank has, not the one asked for, and under a
    // world's acceleration limit the two differ until it has got there. Short
    // of the speed and too near the takeoff to reach it, back straight off
    // along the line for the run-up.
    const atSpeed = !(me.accel > 0) || Math.abs((me.speed ?? planned) - planned) <= JUMP_SPEED_SLACK;
    if (flight.jump && !atSpeed && along > -runup + FLIGHT_TAKEOFF_SLACK && Math.abs(me.speed ?? 0) < planned / 2) {
      out.speed = this.backingUp || (me.speed ?? 0) <= 0 ? -0.5 : 0;
      this.backingUp = true;
      return;
    }
    if (along <= -runup + FLIGHT_TAKEOFF_SLACK) this.backingUp = false;
    // Leaving now: a jump at once, a drive-off on its last frame of ground.
    const step = flight.speed * ctx.view.world.tankSpeed * (this.frameSeconds || 0.05);
    const leaving = flight.jump || along >= flight.launch - (FLIGHT_SPIN_FRAMES * step);
    if (flight.jump && atSpeed) out.jump = true;
    if (leaving && after && flight.air > 0) {
      const rate = this.turnRate(ctx);
      // A foe on the level being landed on is the reason for the turn: the
      // tank is turned to face it at the moment its muzzle passes through the
      // foe's height -- on the way up, beside the edge, where a level shot
      // skims the top straight at it -- so one shot settles it, and the flag
      // is collected after. Otherwise the turn faces the way on at landing.
      const foe = this.foeAtLanding(ctx, landing);
      const pass = foe ? this.foePass(ctx, here, flight, foe) : null;
      let turn;
      let over;
      if (pass) {
        // The barrel that puts the shot -- the tank's velocity and its own --
        // on the foe from where the tank will be, not the bearing itself.
        const toward = Math.atan2(foe.y - pass.y, foe.x - pass.x);
        const u = flight.speed * ctx.view.world.tankSpeed;
        const barrel = skewedBarrel(flight.dx * u, flight.dy * u, toward, ctx.view.world.shotSpeed);
        turn = normalizeAngle((barrel ? barrel.azimuth : toward) - heading);
        over = pass.t;
      } else {
        turn = normalizeAngle(Math.atan2(after.y - landing.y, after.x - landing.x) - heading);
        over = flight.air;
      }
      // Without Wings the turn through the air is only what the tank leaves
      // the ground with, and under an angular acceleration limit that is as
      // far toward the asked-for rate as one frame's change allows.
      let wanted = turn / over;
      if (me.angAccel > 0) {
        const reach = me.angAccel * (this.frameSeconds || 0.05);
        const current = me.angVel ?? 0;
        wanted = Math.max(current - reach, Math.min(current + reach, wanted));
      }
      out.rotation = Math.max(-1, Math.min(1, wanted / rate));
      // What the flight was meant to do, for whoever wants to check it
      // against what it did (client.js's flight log).
      this.lastFlight = {
        at: ctx.view.now, jump: flight.jump, air: flight.air, turn, rotation: out.rotation,
        aim: { x: after.x, y: after.y }, landing: pointOf(landing),
      };
    }
  }

  // Oscillation Overthruster lets a tank through a building's sides, and
  // with it a building does not push the tank back out (`getHitBuilding`,
  // LocalPlayer.cxx:916): a jump onto a top that meets its side goes into it
  // rather than up onto it, and falls back. So the flag goes at liftoff,
  // which costs no time on the ground: dropped there it falls back to the
  // level the tank left, and the tank lands a level up from it, where it does
  // not pick it straight up again.
  shedPhasingOnTakeoff(ctx) {
    if (ctx.me.flag === 'OO') this.shedOnTakeoff = true;
  }

  dropHardFlags(ctx) {
    super.dropHardFlags(ctx);
    const { me, out } = ctx;
    if (!this.shedOnTakeoff) return;
    if (me.flag !== 'OO' || (this.shedAirborne && !me.inAir)) {
      this.shedOnTakeoff = false;
      this.shedAirborne = false;
      return;
    }
    if (me.inAir) {
      this.shedAirborne = true;
      out.dropFlag = true;
    }
  }

  // A jump is taken square to it and from inside its window: turn to face it,
  // back straight off if too close to clear the corner, drive in if too far,
  // and go at full speed once there.
  lineUpJump(ctx, here, landing) {
    const { out } = ctx;
    if (Math.abs(out.rotation) >= JUMP_AIM_TOLERANCE) {
      out.speed = 0;
      return;
    }
    const edge = Math.hypot(landing.x - here.x, landing.y - here.y) - (NAV_CELL / 2);
    this.takeJump(ctx, landing.z - here.z, edge);
  }

  // Jump onto something `rise` up and `edge` away at the speed that lands it,
  // or back off or drive in until there is one.
  takeJump(ctx, rise, edge) {
    const { view, out } = ctx;
    const plan = planJump(this.jumpParams(view), rise, edge);
    if (!plan) return false;
    if (plan.tooClose) {
      out.speed = -0.5;
    } else if (plan.tooFar) {
      out.speed = 1;
    } else {
      out.speed = plan.speed;
      out.jump = true;
      if (rise > MAX_STEP_UP) this.shedPhasingOnTakeoff(ctx);
    }
    return true;
  }

  jumpParams(view) {
    return { velocity: view.world.jumpVelocity, gravity: view.world.gravity, tankSpeed: view.world.tankSpeed };
  }



  // Home is on the base.
  isHome(pos, base) {
    return distance2D(pos, base) <= base.radius;
  }

  // Off the ground, Roger's look-ahead meets nothing whether or not an edge is
  // there, so this runs on every frame he is up on something: stop short of
  // water below, and otherwise drive at `raisedFactor` of the speed, which on a
  // walkway a tank's width wide is the difference between staying on it and
  // driving off the side.
  edgeAhead(ctx) {
    const { view, me, out } = ctx;
    if (me.z <= 0.01) return;
    // A route knows where the surface is, and its follower brakes for it; and
    // a jump goes at the speed chosen for it.
    if (out.jump || out.intent.route?.[0]?.flight) return;
    if (this.tuning.raised === 'curve' && out.intent.route?.length) return;
    const waterLevel = view.world.waterLevel;
    if (Number.isFinite(waterLevel) && waterLevel > 0) out.speed = 0;
    else out.speed *= this.tuning.raisedFactor;
  }


}

// The view's four probes, against the solids a shot meets and the world's
// walls -- upstream's walls are obstacles and bzo's are not. Built from
// whichever world the caller holds, so the client and a server-run bot ask the
// same questions the same way. `findImpact` is the `collision` pair's
// `findShotSegmentImpact`; `topOf` an obstacle's top height.
const PROBE_RANGE = 1000;

// `colliders` is every solid a shot bounces off, the world's walls included,
// for `traceShot`.
const TRACE_STEP_SECONDS = 1 / 30;

export function createWorldProbes({
  obstacles, colliders, mapSize, findImpact, topOf,
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
    const from = { x: pos.x, y: pos.y, z: pos.z + 0.1 };
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
    traceShot: (from, dir, speed, lifetime, ricochet) => {
      const solids = colliders();
      const segments = [];
      let point = { ...from };
      let direction = { ...dir };
      for (let t = 0; t < lifetime; t += TRACE_STEP_SECONDS) {
        const step = traceShotStep({
          obstacles: solids,
          x: point.x,
          y: point.y,
          z: point.z,
          dirX: direction.x,
          dirY: direction.y,
          dirZ: direction.z,
          distance: speed * TRACE_STEP_SECONDS,
          radius: SHOT_COLLISION_RADIUS,
          ricochet,
        });
        const to = { x: step.x, y: step.y, z: step.z };
        segments.push({ t0: t, t1: t + TRACE_STEP_SECONDS, from: point, to });
        if ((step.obstacle || step.ground) && (!ricochet || step.bounces === 0)) break;
        point = to;
        direction = { x: step.dirX, y: step.dirY, z: step.dirZ };
      }
      return segments;
    },
  };
}

// The barrel heading that sends a shot along `toward` (an azimuth, upstream's
// frame) from a tank moving at (vx, vy): the shot leaves with the tank's
// velocity plus `base` along the barrel, so the part of the tank's velocity
// across the line has to be cancelled by turning into it. With the shot's
// speed along the line; null where the drift across is more than the shot can
// make up.
function skewedBarrel(vx, vy, toward, base) {
  const ux = Math.cos(toward);
  const uy = Math.sin(toward);
  const along = (vx * ux) + (vy * uy);
  const acrossX = vx - (along * ux);
  const acrossY = vy - (along * uy);
  const drift = ((acrossX * acrossX) + (acrossY * acrossY)) / (base * base);
  if (drift >= 1) return null;
  const forward = Math.sqrt(1 - drift);
  return {
    azimuth: Math.atan2((forward * uy) - (acrossY / base), (forward * ux) - (acrossX / base)),
    speed: along + (base * forward),
  };
}

// The nearest a segment comes to a point, on the ground plane.
function segmentDistance2D(from, to, point) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = (dx * dx) + (dy * dy);
  const t = lengthSquared > 0
    ? Math.max(0, Math.min(1, (((point.x - from.x) * dx) + ((point.y - from.y) * dy)) / lengthSquared))
    : 0;
  return Math.hypot(from.x + (dx * t) - point.x, from.y + (dy * t) - point.y);
}

// The view's `findRoute`, over whichever world the caller holds: the graph is
// built the first time a route is asked for and again only when the world
// changes. `world()` returns { obstacles, mapSize, waterLevel, jump }, where
// `obstacles` is the same array for as long as the world is the same.
export function createRouter(world) {
  let built = null;
  return (from, to) => {
    const current = world();
    if (!built || built.obstacles !== current.obstacles || built.mapSize !== current.mapSize) {
      built = { obstacles: current.obstacles, mapSize: current.mapSize, graph: buildNavGraph(current) };
    }
    return built.graph.smoothRoute(built.graph.findRoute(from, to), from);
  };
}

// The pilot used where nobody has chosen one: `9` with the Settings row on
// None, and a server's bots. Ace, the more capable; Roger is the reference.
export const DEFAULT_PILOT = 'ace';

// What the Settings row offers, in order, and the key each is chosen by.
export const AUTOPILOTS = Object.freeze([
  Object.freeze({ id: 'roger', name: 'Roger', Pilot: Roger }),
  Object.freeze({ id: 'ace', name: 'Ace', Pilot: Ace }),
]);
