/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Ace's driving layer. See `autopilot.mjs` for the pilot as a whole, the view
// he reads and the frame everything is in.

import {
  FLAG_ENDURANCE, getFlagEndurance, getFlagGrabRadius, getFlagTuning, hasAirControl, isBadFlag,
} from './flags.mjs';
import { NAV_CELL, planJump } from './nav.mjs';
import { normalizeAngle } from './motion.mjs';
import { ROUTE_DEST_SLACK, ROUTE_PENDING, surfaceZ } from './autopilot-world.mjs';
import { azimuthTo, distance2D, HALF_PI, pointOf, Roger } from './roger.mjs';

// How close a foe has to be to pull Ace off a capture, and how far it has to
// get before he goes back to it. The gap is what keeps him from flipping
// between the two at one distance.
export const CAPTURE_CHASE_RANGE = 50;
export const CAPTURE_RELEASE_RANGE = 75;
// A teleport leg is driven square to the face: more than `TELEPORT_ALIGN`
// off its centre line, and further out than `TELEPORT_ALIGN_RANGE`, Ace gets
// back onto the line first; then he aims `TELEPORT_THROUGH` past the face.
const TELEPORT_ALIGN = 1.5;
const TELEPORT_ALIGN_RANGE = 3;
const TELEPORT_THROUGH = 5;
// How far off square to a face Ace will come in, to come out facing the way on.
const TELEPORT_ENTRY_MAX = Math.PI / 4;
// How far ahead on a raised leg's line Ace aims (`lineAim`), on a leg at
// least `RAISED_LINE_MIN` long -- a walkway; a short leg between jumps is
// left to its own aim.
const RAISED_LINE_LEAD = 8;
const RAISED_LINE_MIN = 40;
// How far from a lift Oscillation Overthruster is let go of, and how long a
// flag let go of on purpose is left lying.
const OO_SHED_RANGE = 40;
// A teleporter's re-entry block (`TANK_TELEPORT` in teleport.mjs): how long
// after a teleport, and how far out from a face, before Ace drives back into
// it; and how far a frame's move must jump to be a teleport at all.
const TELEPORT_REENTRY_SECONDS = 1.2;
const TELEPORT_REENTRY_CLEAR = 6;
const TELEPORT_JUMP = 8;
// With a one-way turning flag, a correction the wrong way smaller than this
// stick share is dropped rather than turned the long way round.
const ONE_WAY_SLACK = 0.15;
// After a teleport onto a raised level, how long Ace turns to the route on
// the spot rather than drive while more than `TELEPORT_SETTLE_TURN` off it.
const TELEPORT_SETTLE_SECONDS = 3;
const TELEPORT_SETTLE_TURN = 0.15;
const SHED_FORGET_SECONDS = 30;
// A step a tank drives up without a jump: `_maxBumpHeight`'s default.
export const MAX_STEP_UP = 0.33;
// How much of one jump's height a flag may sit above Ace, and still be worth
// jumping for; how square to the flag he must be to jump; how far ahead he
// looks for the edge; and how far past an edge's corner the jump should clear.
export const JUMP_REACH_SHARE = 0.9;
export const JUMP_AIM_TOLERANCE = 0.2;
export const JUMP_LOOKAHEAD = 30;
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
export const JUMP_SPEED_SLACK = 1;
// How close a bearing is, as seconds of turning at full rate, before a route
// stops turning at full rate onto it.
const ROUTE_TURN_SECONDS = 0.3;
// A drive-off taken straight at its landing: how far past the edge the tank's
// centre goes before it tips, and the slowest it drives off at.
const DRIVE_OFF_TIP = 1;
const DRIVE_OFF_SLOWEST = 0.3;
// Nearer the edge than this, it goes over only lined up.
const DRIVE_OFF_LINE_UP = 6;
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
// A tank that rocks -- ahead, back, ahead -- moves and turns enough in each
// half second to pass the check above and never gets anywhere: asked to drive
// `STALL_ASKED` units over `STALL_SECONDS` and still within `STALL_RADIUS` of
// where it began, it is stuck. A tank holding still on purpose asks for no
// distance; an ambush and a dodge rock on purpose.
const STALL_SECONDS = 3;
const STALL_ASKED = 15;
const STALL_RADIUS = 3;
const STALL_EXEMPT = new Set(['ambush', 'dodge', 'unstick']);
// A gap this long between frames is a pilot that was not driving -- paused,
// switched off, a server's bots idle with nobody playing, or a test asking
// twice -- and starts both progress counts again.
const STALL_GAP_SECONDS = 0.5;
const ROUTE_LOOKAHEAD = 16;
// Half a tank's width, plus a little, for the lane check.
const LANE_HALF_WIDTH = 1.6;
// How far the tank moves before the lane to the node it aims at is tested
// again.
const AIM_RECHECK_DISTANCE = 2;
// Just over the bump a tank drives up without noticing.
const AIM_LANE_LIFT = 0.4;
const ROUTE_REPLAN_SECONDS = 3;
const ROUTE_STRAY = 12;
export const UNREACHABLE_SECONDS = 10;
// A jump whose landing a foe can shoot, this far ahead on the route, is gone
// round on the ground instead when that way is no more than
// `SAFE_DETOUR_SHARE` as long plus `SAFE_DETOUR_EXTRA`.
const JUMP_RISK_LOOKAHEAD = 60;
const SAFE_DETOUR_SHARE = 1.5;
const SAFE_DETOUR_EXTRA = 40;
// A flag Ace has had to back off this many times within `STUCK_FLAG_RANGE`
// of, each within `STUCK_FLAG_WINDOW` of the last, is behind or inside
// something the route graph does not know about, and is left alone for
// `STUCK_FLAG_SECONDS`.
const STUCK_FLAG_STRIKES = 2;
const STUCK_FLAG_RANGE = 30;
const STUCK_FLAG_WINDOW = 20;
const STUCK_FLAG_SECONDS = 60;
// How far from a flight's planned landing a tank may come down, on its
// level, and within how long of being in the air, for the flight to count as
// flown.
const LANDED_SLACK = 8;
const LANDED_SECONDS = 0.5;
// A bad flag Ace knows of is looked for this many seconds of driving ahead,
// and passed with this much room past the grab radius.
const BAD_FLAG_LOOKAHEAD_SECONDS = 1;
const BAD_FLAG_MARGIN = 1.5;

// Ace's driving: routes and the turns and speeds that follow them, flights and
// the jumps that start them, teleporters, and backing out of where he is
// stuck. The first of Ace's layers over Roger; `Ace` (`autopilot.mjs`) is all
// of them.
export class AceDriver extends Roger {
  // Left Turn Only and Right Turn Only refuse the other way, so a turn that
  // way is made the long way round, on the spot -- every pilot decision asks
  // for the short way, and a tank that cannot take it never turns at all. A
  // small correction the wrong way is let go rather than costing a circle.
  oneWayTurn(flag, out) {
    const sign = flag === 'LT' ? 1 : (flag === 'RT' ? -1 : 0);
    if (sign === 0 || out.rotation * sign >= 0) return;
    if (Math.abs(out.rotation) < ONE_WAY_SLACK) {
      out.rotation = 0;
      return;
    }
    out.rotation = sign;
    out.speed = 0;
  }

  // A position that jumped further than a frame's driving is a teleport.
  noteTeleport(view) {
    const at = { x: view.self.x, y: view.self.y, z: view.self.z };
    if (this.lastAt && Math.hypot(at.x - this.lastAt.x, at.y - this.lastAt.y, at.z - this.lastAt.z) > TELEPORT_JUMP) {
      this.lastTeleportAt = view.now;
    }
    this.lastAt = at;
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

  // A flag's type as far as Ace can tell: named, remembered, or else the one
  // type the zone it lies in spawns -- a `zoneflag` slot always comes back
  // as its zone's type, so one lying there most likely is it.
  knownType(flag) {
    const known = flag.type ?? this.knownFlagTypes.get(flag.index)?.type ?? null;
    if (known || !this.flagZones) return known;
    const zone = this.flagZones.find((z) => z.flags.length === 1 && inZone(z, flag));
    return zone ? zone.flags[0] : null;
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

  // How high one jump lifts the tank, if it may jump at all.
  jumpReach(ctx) {
    const { view, me } = ctx;
    const canJump = (view.world.allowJumping || me.flag === 'JP' || me.flag === 'WG') && me.flag !== 'NJ';
    if (!canJump || !(view.world.gravity > 0)) return 0;
    return (view.world.jumpVelocity * view.world.jumpVelocity) / (2 * view.world.gravity);
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
    out.speed = Math.min(HALF_PI - Math.abs(out.rotation), this.arcSpeed(ctx, pointOf(me), pos, out.rotation));
    return true;
  }

  // The fastest Ace can drive and still turn onto `aim`: a tank turning at
  // full stick runs round a circle of its speed over its turn rate, and a
  // point closer in than that circle reaches, off to one side, is driven
  // round rather than onto -- a flag circled instead of picked up. Behind
  // him, it is a turn on the spot.
  arcSpeed(ctx, here, aim, bearing) {
    const off = Math.abs(bearing);
    if (off >= HALF_PI) return 0;
    if (off < 1e-3) return Infinity;
    const d = Math.hypot(aim.x - here.x, aim.y - here.y);
    const top = ctx.me.topSpeed ?? ctx.view.world.tankSpeed ?? 25;
    return (this.turnRate(ctx) * d) / (2 * Math.sin(off) * top);
  }

  // A dodge made at the camping spot is a shot that was really coming: a
  // shot passing below a raised tank is not one the dodge answers.
  // Every jump and drop is planned as a straight coast at the speed it left
  // with. Wings steers in the air, its velocity following the stick and the
  // heading, so whatever Ace asks for there -- braking at a route point,
  // turning toward the next -- would bend that arc and drop him short. He
  // holds the speed he left with and does not turn. A flight planned with
  // flaps (`nav.mjs`) takes each at the top of the arc before it: the first
  // frame he is no longer rising. A flap is a fresh press, so the frame after
  // one lets go; the only other one is a dodge's.
  holdAirStick(self, out) {
    if (!self.inAir) {
      this.airSpeed = out.speed;
      if (!out.jump) this.flapsPlanned = 0;
      this.flapped = false;
      return;
    }
    if (!hasAirControl(self.flag) || this.airSpeed === undefined) return;
    out.speed = this.airSpeed;
    out.rotation = 0;
    if (!this.flapped && this.flapsPlanned > 0 && (self.velocity?.z ?? 0) <= 0) {
      out.jump = true;
      this.flapped = true;
      this.flapsPlanned--;
    } else if (out.intent.mode !== 'dodge') {
      // Nothing else flaps: a route's next takeoff, pressed the frame he
      // comes down, would leave from the air at the speed he flew in with.
      out.jump = false;
      this.flapped = false;
    }
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
    // Waiting on a router: asked again every frame until it answers.
    if (sameDest && current.pending) return this.plan(view, here, there);
    if (sameDest && !current.nodes) {
      return view.now - current.plannedAt < UNREACHABLE_SECONDS ? null : this.plan(view, here, there);
    }
    if (sameDest && view.now - current.plannedAt < ROUTE_REPLAN_SECONDS && !this.strayed(current, here)) {
      return current;
    }
    // Not from the air: a search starts from the node under the tank, which
    // mid-flight is some surface it is only passing over, and the flight it
    // is on already goes where the old route goes.
    if (current?.nodes && me.inAir) return current;
    return this.plan(view, here, there);
  }

  plan(view, here, there) {
    const canJump = canTankJump(view.world, view.self.flag, view.self.z);
    const wings = hasAirControl(view.self.flag);
    const burrowed = view.self.z < 0;
    let nodes = view.findRoute(here, there, { canJump, wings, burrowed });
    if (nodes === ROUTE_PENDING) return this.awaitRoute(view, here, there);
    // Nowhere to go underground -- a raised base, a lift's far end -- is
    // somewhere Burrow keeps him from: it goes, and the tank comes up.
    if (!nodes && burrowed) this.shedBurrow = true;
    // A jump is a second or more Ace cannot steer, and comes down where it
    // was always going to: one whose landing a foe has a level, clear shot
    // at is taken only when the way round on the ground is much longer.
    if (canJump && nodes && this.exposedJump(view, here, nodes)) {
      const ground = view.findRoute(here, there, { canJump: false });
      if (ground && ground !== ROUTE_PENDING && routeLength(here, ground) <= (routeLength(here, nodes) * SAFE_DETOUR_SHARE) + SAFE_DETOUR_EXTRA) {
        nodes = ground;
        this.stats.safer++;
      }
    }
    this.stats.plans++;
    if (!nodes) this.stats.unreachable++;
    this.route = { dest: there, from: here, nodes, at: 0, plannedAt: view.now };
    return nodes ? this.route : null;
  }

  // While a router works a route out, Ace keeps moving: on along the route
  // he has to the same place, or else straight at it, which a wall in the way
  // turns into an unstick -- any motion is better than sitting still.
  awaitRoute(view, here, there) {
    this.stats.waits++;
    const current = this.route;
    if (current?.nodes && !current.pending
      && Math.hypot(current.dest.x - there.x, current.dest.y - there.y) < ROUTE_DEST_SLACK) {
      return current;
    }
    this.route = {
      dest: there, from: here, nodes: [{ x: there.x, y: there.y, z: here.z }], at: 0, plannedAt: view.now, pending: true,
    };
    return this.route;
  }

  // The next jump on `nodes`, within `JUMP_RISK_LOOKAHEAD` of driving, if a
  // live foe could shoot where it lands: within a shot's reach, on the
  // landing's level, and in sight of it -- a Super Bullet sees through.
  exposedJump(view, here, nodes) {
    let travelled = 0;
    let last = here;
    for (const node of nodes) {
      travelled += distance2D(last, node);
      last = node;
      if (travelled > JUMP_RISK_LOOKAHEAD) return false;
      if (!node.jump) continue;
      const reach = view.world.shotSpeed * (view.self.shotLifetime ?? 3.5);
      const tall = view.world.tankHeight;
      return this.remotePlayers(view).some((p) => p.alive && !p.paused && view.isFoe(p)
        && Math.abs(p.z - node.z) < tall
        && distance2D(p, node) <= reach
        && (p.flag === 'SB' || !view.isObscured(
          { x: p.x, y: p.y, z: p.z + 1.5 }, { x: node.x, y: node.y, z: node.z + 1 },
        )));
    }
    return false;
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
      // A flight just come down from, on its landing's level and near it, is
      // flown: short of the planned spot by a few units is still landed, and
      // taking it again from there is a second jump the route never had.
      if ((node.jump || node.flight) && distance <= LANDED_SLACK
        && ctx.view.now - (this.airborneAt ?? -Infinity) <= LANDED_SECONDS) {
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
    // Oscillation Overthruster on top of where a lift goes is a tank inside
    // the floor, so it goes before the way up, with time for the drop to land.
    const lift = nodes.slice(route.at, route.at + 4).find((node) => node.teleport);
    if (lift && me.flag === 'OO' && lift.z > here.z + MAX_STEP_UP
      && Math.hypot(lift.teleport.x - here.x, lift.teleport.y - here.y) < OO_SHED_RANGE) {
      out.dropFlag = true;
      this.noteShed(ctx);
    }
    if (next.teleport && !me.inAir) {
      const after = nodes[route.at + 1];
      const exitHeading = after ? Math.atan2(after.y - next.y, after.x - next.x) : null;
      this.driveThroughTeleporter(ctx, here, next.teleport, exitHeading);
      return true;
    }
    let aim = next;
    if (!next.jump && !next.bridge) {
      if (tuning.follow === 'pursuit') {
        aim = this.pursuitPoint(ctx, here, nodes, route.at, raised);
      } else if (!raised) {
        aim = this.groundAim(ctx, here, nodes, route.at, tuning.groundLookahead);
      } else {
        const prev = route.at > 0 ? nodes[route.at - 1] : route.from;
        // Not into a takeoff, which lines itself up (`lineUpJump`, `fly`).
        const takeoff = nodes[route.at + 1]?.jump || nodes[route.at + 1]?.flight;
        if (prev && !takeoff && Math.abs(prev.z - next.z) <= MAX_STEP_UP
          && Math.hypot(next.x - prev.x, next.y - prev.y) >= RAISED_LINE_MIN) aim = this.lineAim(here, prev, next);
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
    // Out of a teleporter onto a raised level -- a lift's landing, a walkway
    // a tank wide -- the tank faces wherever the face sent it. Turned to the
    // route on the spot first: turning while driving drifts it off the side.
    if (raised && ctx.view.now - this.lastTeleportAt < TELEPORT_SETTLE_SECONDS
      && Math.abs(out.rotation) > TELEPORT_SETTLE_TURN) out.speed = 0;
    // The last node, where the route ends on what it was for: onto it, not
    // round it.
    if (route.at === nodes.length - 1) out.speed = Math.min(out.speed, this.arcSpeed(ctx, here, next, out.rotation));
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

  // On a raised leg, a point a little ahead on the leg's own line rather than
  // its far end: a long walkway's end is so far off that aiming at it barely
  // corrects a tank a few units to one side, and a walkway is not much wider
  // than the tank.
  lineAim(here, from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-3) return to;
    const ux = dx / length;
    const uy = dy / length;
    const t = ((here.x - from.x) * ux) + ((here.y - from.y) * uy);
    const ahead = Math.min(length, Math.max(0, t) + RAISED_LINE_LEAD);
    return { x: from.x + (ux * ahead), y: from.y + (uy * ahead), z: to.z };
  }

  // A teleport leg: onto the line square to the face, then straight through
  // it, the way out being wherever the face sends. `face` is the face's
  // centre and the way into it.
  driveThroughTeleporter(ctx, here, face, exitHeading = null) {
    const { me, out, view } = ctx;
    // The way in: square to the face, or -- where the route goes on from the
    // far side -- at the heading the crossing turns into that way on, so the
    // tank comes out already facing along a lift's walkway. Kept within
    // `TELEPORT_ENTRY_MAX` of square, which is still clean through the face.
    const square = Math.atan2(face.dy, face.dx);
    let heading = square;
    if (exitHeading !== null && Number.isFinite(face.turn)) {
      const wanted = normalizeAngle(exitHeading - face.turn - square);
      heading = square + Math.max(-TELEPORT_ENTRY_MAX, Math.min(TELEPORT_ENTRY_MAX, wanted));
    }
    const way = { dx: Math.cos(heading), dy: Math.sin(heading) };
    const along = ((face.x - here.x) * way.dx) + ((face.y - here.y) * way.dy);
    // Just out of a teleporter, it will not take the tank again until it has
    // gone `TELEPORT_REENTRY_CLEAR` and a moment has passed: driving back in
    // sooner leaves it inside the frame. Back off first.
    if (view.now - this.lastTeleportAt < TELEPORT_REENTRY_SECONDS || along < TELEPORT_REENTRY_CLEAR) {
      if (view.now - this.lastTeleportAt < TELEPORT_REENTRY_SECONDS || this.teleportBackingOff) {
        this.teleportBackingOff = along < TELEPORT_REENTRY_CLEAR + 2;
        const away = this.backOffPoint(ctx, here, face);
        if (!away) {
          // Floor on no side: stand and let the block run down.
          out.speed = 0;
          out.rotation = 0;
          return;
        }
        const bearing = normalizeAngle(azimuthTo(me, away) - me.azimuth);
        out.speed = Math.abs(bearing) > this.tuning.turnInPlace ? 0 : HALF_PI - Math.abs(bearing);
        out.rotation = this.steer(ctx, bearing);
        return;
      }
    }
    this.teleportBackingOff = false;
    const lateral = ((here.x - face.x) * way.dy) - ((here.y - face.y) * way.dx);
    const aim = Math.abs(lateral) > TELEPORT_ALIGN && along > TELEPORT_ALIGN_RANGE
      ? { x: face.x - (way.dx * Math.max(TELEPORT_ALIGN_RANGE, along - TELEPORT_ALIGN_RANGE)),
        y: face.y - (way.dy * Math.max(TELEPORT_ALIGN_RANGE, along - TELEPORT_ALIGN_RANGE)) }
      : { x: face.x + (way.dx * TELEPORT_THROUGH), y: face.y + (way.dy * TELEPORT_THROUGH) };
    const bearing = normalizeAngle(azimuthTo(me, aim) - me.azimuth);
    out.speed = Math.abs(bearing) > this.tuning.turnInPlace ? 0 : HALF_PI - Math.abs(bearing);
    out.rotation = this.steer(ctx, bearing);
  }

  // Somewhere to back off a teleporter's face to, on the floor Ace stands
  // on: straight out from the face, else along it either way. Up on a lift's
  // landing, straight out can be a drop.
  backOffPoint(ctx, here, face) {
    const reach = TELEPORT_REENTRY_CLEAR + 4;
    const ways = [[-face.dx, -face.dy], [face.dy, -face.dx], [-face.dy, face.dx]];
    for (const [ux, uy] of ways) {
      const point = { x: here.x + (ux * reach), y: here.y + (uy * reach) };
      const hit = ctx.view.firstHit({ ...point, z: here.z + 1 }, { ...point, z: here.z - 1 });
      const floor = hit ? hit.z : 0;
      if (Math.abs(floor - here.z) <= MAX_STEP_UP) return point;
    }
    return null;
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
    if (this.checkStall(ctx, top)) return;
    const sample = this.progress;
    const trying = Math.abs(out.rotation) > 0.1 || Math.abs(out.speed) > 0.1;
    const restart = () => {
      this.progress = { t: view.now, last: view.now, x: me.x, y: me.y, azimuth: me.azimuth, asked: 0 };
    };
    if (!sample || !trying || me.inAir || view.now - sample.last > STALL_GAP_SECONDS) {
      restart();
      return;
    }
    sample.last = view.now;
    sample.asked += Math.abs(out.speed) * top * (this.frameSeconds || 0);
    const turned = Math.abs(normalizeAngle(me.azimuth - sample.azimuth));
    const moved = Math.hypot(me.x - sample.x, me.y - sample.y);
    if (turned > UNSTICK_TURN || moved > Math.max(UNSTICK_MOVE, UNSTICK_SHARE * sample.asked)) {
      restart();
      return;
    }
    if (view.now - sample.t <= UNSTICK_SECONDS) return;
    this.unstick(ctx);
  }

  // Rocking in place: see `STALL_SECONDS`.
  checkStall(ctx, top) {
    const { view, me, out } = ctx;
    const drift = this.drift;
    if (!drift || me.inAir || STALL_EXEMPT.has(out.intent.mode)
      || view.now - drift.last > STALL_GAP_SECONDS
      || Math.hypot(me.x - drift.x, me.y - drift.y) > STALL_RADIUS) {
      this.drift = { t: view.now, last: view.now, x: me.x, y: me.y, asked: 0 };
      return false;
    }
    drift.last = view.now;
    drift.asked += Math.abs(out.speed) * top * (this.frameSeconds || 0);
    if (view.now - drift.t < STALL_SECONDS || drift.asked < STALL_ASKED) return false;
    this.unstick(ctx);
    return true;
  }

  unstick(ctx) {
    const { view, me, out } = ctx;
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
    this.drift = null;
    this.stats.unsticks++;
    this.strikeGoalFlag(view.now, me);
    out.speed = UNSTICK_SPEED;
    out.rotation = this.unstickTurn;
    out.intent.mode = 'unstick';
  }

  // A back-off on the way to a flag counts against it; enough of them close
  // together and the flag is given up, as one no route reaches is.
  strikeGoalFlag(now, me) {
    const flag = this.goalFlag;
    if (!flag || distance2D(me, flag) > STUCK_FLAG_RANGE) return;
    const { index } = flag;
    const last = this.flagStrikes.get(index);
    const count = last && now - last.at <= STUCK_FLAG_WINDOW ? last.count + 1 : 1;
    if (count < STUCK_FLAG_STRIKES) {
      this.flagStrikes.set(index, { count, at: now });
      return;
    }
    this.flagStrikes.delete(index);
    this.unreachable.set(index, now + STUCK_FLAG_SECONDS);
    if (this.pickupIndex === index) this.pickupIndex = null;
    this.route = null;
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
  // runs a circle of `topSpeed / turnRate` times its speed, and to come round
  // onto a point `d` off at bearing `b` that circle can be at most
  // `d / (2 sin b)` across. Faster than that, he orbits it and never arrives;
  // past a right angle he turns where he is. The rates are the tank's own, so
  // a flag that slows his turn more than his drive -- Burrow -- widens it.
  arrivalSpeed(ctx, here, aim, rotation) {
    const bearing = Math.abs(rotation);
    if (bearing >= HALF_PI) return 0;
    const turnRadius = (ctx.me.topSpeed || ctx.view.world.tankSpeed || 25) / this.turnRate(ctx);
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
      const from = { x: here.x + ox, y: here.y + oy, z: surfaceZ(here.z) + lift };
      const to = { x: there.x + ox, y: there.y + oy, z: surfaceZ(there.z) + lift };
      if (ctx.view.isObscured(from, to)) return false;
      if (ctx.view.teleporterInWay?.(from, to)) return false;
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
    this.avoidBadFlags(ctx);
    super.avoidDeathFall(ctx);
  }

  // An empty-handed tank takes any flag it drives over, so a bad one Ace
  // knows -- one he or the player he flies for has seen carried, identified
  // or named -- is steered round: lying on his level, ahead of him within a
  // second's driving and close enough to his line to be taken, it turns him
  // away from it. A dodge and an unstick come first.
  avoidBadFlags(ctx) {
    const { view, me, out } = ctx;
    if (me.flag || me.inAir || out.intent.mode === 'dodge' || out.intent.mode === 'unstick') return;
    const speed = out.speed * (me.topSpeed ?? view.world.tankSpeed);
    if (Math.abs(speed) < 0.1) return;
    const heading = speed < 0 ? me.azimuth + Math.PI : me.azimuth;
    const dx = Math.cos(heading);
    const dy = Math.sin(heading);
    const room = getFlagGrabRadius() + BAD_FLAG_MARGIN;
    const reach = (Math.abs(speed) * BAD_FLAG_LOOKAHEAD_SECONDS) + room;
    let nearest = null;
    for (const flag of view.flags) {
      if (!flag.onGround || flag.team !== null) continue;
      const type = this.knownType(flag);
      if (!isBadFlag(type) || Math.abs(flag.z - me.z) > 1) continue;
      const rx = flag.x - me.x;
      const ry = flag.y - me.y;
      const along = (rx * dx) + (ry * dy);
      const across = (dx * ry) - (dy * rx);
      if (along < -room || along > reach || Math.abs(across) >= room) continue;
      if (!nearest || along < nearest.along) nearest = { along, across };
    }
    if (!nearest) return;
    // Away from the side it lies on; dead ahead, whichever way he was turning.
    const side = nearest.across !== 0 ? Math.sign(nearest.across) : -Math.sign(out.rotation || 1);
    out.rotation = -side;
  }

  dropOnTheMove(ctx) {
    const { view, me, out } = ctx;
    // Nothing to drive for with a flag that will not drop (see `think`).
    if (me.flag && getFlagEndurance(me.flag) === FLAG_ENDURANCE.STICKY) {
      out.dropFlag = false;
      this.dropDriveUntil = -Infinity;
      return;
    }
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
    for (const p of this.remotePlayers(view)) {
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
    const speed = this.speedFraction(ctx, planned);
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
    if (flight.jump && atSpeed) {
      out.jump = true;
      this.flapsPlanned = flight.flaps || 0;
    }
    // Not under Wings, whose turn would bend the arc rather than the heading.
    if (leaving && after && flight.air > 0 && !hasAirControl(me.flag)) {
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
    const { me, out } = ctx;
    // Roger has no use for Identify; Ace does.
    if (me.flag !== 'ID') super.dropHardFlags(ctx);
    // Asked for until it is gone: a drop waits for the tank to be moving
    // (`dropOnTheMove`), and the goal that set this is not asked for again.
    if (this.shedBurrow) {
      if (me.flag === 'BU') {
        out.dropFlag = true;
        this.noteShed(ctx);
      } else {
        this.shedBurrow = false;
      }
    }
    if (!this.shedOnTakeoff) return;
    if (me.flag !== 'OO' || (this.shedAirborne && !me.inAir)) {
      this.shedOnTakeoff = false;
      this.shedAirborne = false;
      return;
    }
    if (me.inAir) {
      this.shedAirborne = true;
      out.dropFlag = true;
      this.noteShed(ctx);
    }
  }

  // A flag let go of on purpose is not one to go straight back for.
  noteShed(ctx) {
    if (Number.isInteger(ctx.me.flagIndex)) this.shedFlags.set(ctx.me.flagIndex, ctx.view.now + SHED_FORGET_SECONDS);
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
    const { out } = ctx;
    const plan = planJump(this.jumpParams(ctx), rise, edge);
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

  // At the tank's own top speed: a flag that changes it (High Speed, Thief)
  // changes what a fraction of it drives at, and a jump keeps the speed it
  // leaves with.
  jumpParams(ctx) {
    const { view, me } = ctx;
    return {
      velocity: view.world.jumpVelocity,
      gravity: view.world.gravity,
      tankSpeed: me.topSpeed ?? view.world.tankSpeed,
    };
  }

  // The fraction of the tank's top speed that drives at `planned` units a
  // second. A route's flights are planned at the world's tank speed, so with
  // High Speed or Thief the same fraction leaves half again as fast and lands
  // past the landing. Above 1 the flight is out of this tank's reach.
  speedFraction(ctx, planned) {
    const top = ctx.me.topSpeed ?? ctx.view.world.tankSpeed;
    return top > 0 ? Math.min(1, planned / top) : 0;
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

// Whether a tank may jump at all, as `jumpReach` and the dodge ask it: nobody
// jumps from under the ground (LocalPlayer.cxx:1406), whatever the flag.
export function canTankJump(world, flag, z = 0) {
  return (world.allowJumping || flag === 'JP' || flag === 'WG') && flag !== 'NJ' && !(z < 0);
}

// How far a route drives, from `here` along every node.
function routeLength(here, nodes) {
  let length = 0;
  let last = here;
  for (const node of nodes) {
    length += distance2D(last, node);
    last = node;
  }
  return length;
}

// Whether `pos` is inside a zone's footprint, at any height.
function inZone(zone, pos) {
  const dx = pos.x - zone.x;
  const dy = pos.y - zone.y;
  const cos = Math.cos(-zone.rotation);
  const sin = Math.sin(-zone.rotation);
  return Math.abs((dx * cos) - (dy * sin)) <= zone.halfWidth && Math.abs((dx * sin) + (dy * cos)) <= zone.halfDepth;
}

// The barrel heading that sends a shot along `toward` (an azimuth, upstream's
// frame) from a tank moving at (vx, vy): the shot leaves with the tank's
// velocity plus `base` along the barrel, so the part of the tank's velocity
// across the line has to be cancelled by turning into it. With the shot's
// speed along the line; null where the drift across is more than the shot can
// make up.
export function skewedBarrel(vx, vy, toward, base) {
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
export function segmentDistance2D(from, to, point) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = (dx * dx) + (dy * dy);
  const t = lengthSquared > 0
    ? Math.max(0, Math.min(1, (((point.x - from.x) * dx) + ((point.y - from.y) * dy)) / lengthSquared))
    : 0;
  return Math.hypot(from.x + (dx * t) - point.x, from.y + (dy * t) - point.y);
}
