/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Roger: upstream's autopilot (`src/bzflag/AutoPilot.cxx`), decision for
// decision, quirks included. He is the reference `Ace` (`autopilot.mjs`) is
// measured against and extends, so improvements go there, not here. The
// small geometry he works in is exported for Ace to share.

import { canSeeTank, seenOnRadar } from './flags.mjs';
import { normalizeAngle } from './motion.mjs';

export const HALF_PI = Math.PI / 2;

// A position alone, for an intent: what the pilot reports carries nothing else.
export function pointOf(p) {
  return { x: p.x, y: p.y, z: p.z };
}

export function distance2D(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function azimuthTo(a, b) {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

// TargetingUtils::getTargetAngleDifference: the angle between a heading and the
// line to a target, in radians.
export function angleDifference(src, azimuth, target) {
  const d = distance2D(src, target);
  if (d === 0) return 0;
  const tx = (target.x - src.x) / d;
  const ty = (target.y - src.y) / d;
  const dot = (tx * Math.cos(azimuth)) + (ty * Math.sin(azimuth));
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

// "toss in some lag adjustment/future prediction - 300 millis".
export function predict(p) {
  const z = p.z + (0.3 * p.vz);
  return {
    x: p.x + (0.3 * p.vx),
    y: p.y + (0.3 * p.vy),
    z: z < 0 ? 0 : z,
  };
}

// dropHardFlags: flags Roger cannot use.
export const HARD_FLAGS = new Set(['US', 'MG', 'ID']);

function createStats() {
  return {
    modes: {}, shots: 0, jumps: 0, falls: 0, plans: 0, unreachable: 0, waits: 0, unsticks: 0, held: 0, kept: 0, safer: 0,
    switches: 0, pairs: {}, targets: {},
  };
}

// The pair of modes that traded places most, once it has done so often enough
// to be a tank going nowhere, and where each was headed.
const FLIP_REPORT_MIN = 10;

function flipReport(stats) {
  const top = Object.entries(stats.pairs).sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] < FLIP_REPORT_MIN) return '';
  const where = top[0].split('/').map((mode) => `${mode} ${stats.targets[mode] ? `to ${stats.targets[mode]}` : 'untargeted'}`);
  return ` (${top[0]} ${top[1]}: ${where.join(', ')})`;
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
    this.lastMode = null;
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
    const mode = out.intent.mode;
    stats.modes[mode] = (stats.modes[mode] || 0) + 1;
    // Which modes trade places, and where each was headed: two decisions
    // taking turns frame by frame leave the tank where it is.
    if (this.lastMode && mode !== this.lastMode) {
      stats.switches++;
      const pair = [this.lastMode, mode].sort().join('/');
      stats.pairs[pair] = (stats.pairs[pair] || 0) + 1;
    }
    this.lastMode = mode;
    const target = out.intent.target;
    if (target && Number.isFinite(target.x)) stats.targets[mode] = `${Math.round(target.x)},${Math.round(target.y)}`;
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
      + `, switches ${stats.switches}${flipReport(stats)}`
      + (this.extraReport ? this.extraReport(stats) : '');
    this.stats = createStats();
    return report;
  }

  // The tanks this one can see at all (`canSeeTank`), once per view. Kills,
  // scores and who fired a shot are on the scoreboard and in the shots, so
  // those read `view.players` whole.
  remotePlayers(view) {
    if (this.seenView !== view) {
      this.seenView = view;
      this.seenPlayers = view.players.filter((p) => canSeeTank(view.self.flag, p.flag));
    }
    return this.seenPlayers;
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
      // is chased whenever it is in plain sight; that is kept, and holds for
      // any tank off this one's radar, a jammed one's included.
      if (seenOnRadar(me.flag, p.flag) || !obscured) {
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
