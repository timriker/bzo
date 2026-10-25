/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Ace's fighting layer. See `autopilot.mjs` for the pilot as a whole, the
// view he reads and the frame everything is in.

import {
  canRunOver, canSeeShot, firesContinuously, getRunOverRadius, getRunOverSeparation, getTankHitRadiusScale,
  usesNarrowHitBox,
} from './flags.mjs';
import { SHOT_COLLISION_RADIUS, TANK } from './collision.mjs';
import { normalizeAngle } from './motion.mjs';
import { angleDifference, azimuthTo, distance2D, pointOf, predict } from './roger.mjs';
import {
  AceDriver, canTankJump, CAPTURE_CHASE_RANGE, CAPTURE_RELEASE_RANGE, JUMP_SPEED_SLACK, segmentDistance2D,
  skewedBarrel,
} from './ace-driver.mjs';

// A landing shot's plan aimed `early` seconds sooner: the same spot, the
// window moved.
function shiftPlan(plan, early) {
  return { ...plan, enter: plan.enter - early, landing: { ...plan.landing, t: plan.landing.t - early } };
}
// Bank shots at a landing (`bankPlans`): the sweep's step round Ace, how near
// a sampled path must pass to be refined, how finely, how near the refined
// one must pass, how many bounces are tried and how many paths are kept, and
// how far Ace may move before they are looked for again.
const BANK_SWEEP_STEP = Math.PI / 90;
const BANK_COARSE_MISS = 6;
const BANK_REFINE_STEPS = 8;
const BANK_MAX_BOUNCES = 2;
const BANK_KEEP = 3;
// How long one frame may spend on the sweep, in ms: the Jetson's browser is
// short of CPU before any of it.
const BANK_BUDGET_MS = 3;
const BANK_RECHECK_DISTANCE = 2;
// How far inside a landing shot's window, in seconds, Ace aims its arrival
// when he can choose: at most half the window.
const LANDING_SHOT_MARGIN = 0.03;
// How far behind the real foe a landing shot's plan starts, in seconds, on
// top of the round trip: a foe's move is dated when it arrives, and the hit
// is judged where the foe really is. Measured from a client on the server's
// own machine, whose shots came 0.07 late.
const LANDING_SHOT_BIAS = 0.07;
// How far outside a Shock Wave a team mate has to be for it to go: he moves
// between the look-ahead and the wave reaching him.
const SHOCK_WAVE_TEAM_MARGIN = 10;
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
// Trigger Happy: how far ahead the heading of its next shot is judged, in
// seconds, the steps the headings round him are tried in, and the least time
// a turn to one is spread over.
const TRIGGER_HAPPY_LEAD = 1;
const TRIGGER_HAPPY_STEP = Math.PI / 18;
const TRIGGER_HAPPY_STEP_SECONDS = 0.1;
// Dodging: how far past a hit a shot must pass to count as missing, how far
// ahead a shot is worth worrying about, and how much time a move out of its
// way must leave to spare.
const DODGE_CLEARANCE = 1;
const DODGE_HORIZON_SECONDS = 3;
const DODGE_MARGIN_SECONDS = 0.1;
const DODGE_DEAD_ON = 0.5;
// The dodge's search (`dodgePath`): the speeds and turns tried, as shares of
// full stick, how finely each path is driven out, and what a unit of turn
// costs against a unit of speed when choosing between clear ones.
const DODGE_SPEEDS = [1, 0.5, 0, -0.5];
const DODGE_TURNS = [0, -0.5, 0.5, -1, 1];
const DODGE_STEP_SECONDS = 0.05;
const DODGE_TURN_COST = 0.5;
// The room a dodge leaves past where a shot would hit, and how many times
// within a step a shot is tested.
const DODGE_HIT_MARGIN = 0.8;
const DODGE_HIT_STEPS = 5;
// Burrowed: how far ahead a tank about to drive over him is looked for, and
// the room past its reach he wants.
const SQUASH_HORIZON_SECONDS = 1.5;
const SQUASH_MARGIN = 1;
// Nearer a burrowed foe than this Ace drives over him rather than jumping.
const SQUASH_JUMP_MIN = 15;
// How far round Ace turns on the spot to line a squash jump up.
const SQUASH_JUMP_TURN = Math.PI / 4;
// A team behind on score keeps to its captures: only a foe this much nearer
// than `CAPTURE_CHASE_RANGE` turns Ace from one.
const BEHIND_CHASE_SHARE = 0.6;
// A Shock Wave holder this much past the wave's own radius can drive into
// range before Ace could leave.
const CAMP_SW_MARGIN = 1.5;
// A laser outreaches every other shot, so its holder keeps just outside the
// furthest a foe's shot carries -- a lunge's, with the foe's full speed in it
// -- plus `LASER_STANDOFF_MARGIN`: backing off inside it, closing in when
// `LASER_STANDOFF_SLACK` past it and with no spot to hold.
const LASER_STANDOFF_MARGIN = 20;
const LASER_STANDOFF_SLACK = 60;
// The modes in which Ace is going after a tank.
// How soon Ace means to have his sights back on a foe he is tracking: the
// angle off over this, as a turn rate, is the stick.
const TRACK_TURN_SECONDS = 0.25;
// The fastest a tank backs up, as a share of its top speed: upstream's
// `setDesiredSpeed` clamp (LocalPlayer.cxx:1096).
const REVERSE_SPEED_SHARE = 0.5;
export const TARGET_MODES = new Set(['chase', 'hunt', 'fight', 'ambush', 'lunge', 'camp']);
export const CHASE_DEST_SLACK = 40;
// Shots Ace keeps back on a server that allows several: a quarter of them,
// rounded up, so five slots fire three and keep two and two slots fire one. A
// single slot keeps none -- there is nothing to keep. The kept ones are spent
// on a foe this close, which is a fight now rather than a chance at range, and
// on a landing shot (`mayUseShot`).
const SHOT_RESERVE_FRACTION = 0.25;
const SHOT_RESERVE_SPEND_RANGE = 60;
export const RABBIT_FLEE_DISTANCE = 150;
export const RABBIT_FLEE_MARGIN = 20;
export const RABBIT_CLOSING_SPEED = 1;
// Intercepting a foe in the air: how finely its flight is searched for the
// stretches its body is at the muzzle's height, and the longest piece one is
// cut into -- a quarter-second at tank speed is more drift than a hit allows.
const INTERCEPT_STEP = 0.02;
const INTERCEPT_PIECE_SECONDS = 0.08;
// How much of a tank's hit radius a shot from the air may pass from its
// centre and still be taken.
const AIR_SHOT_SHARE = 0.6;
// How far past a foe's body a level shot's height may be and still be taken:
// a tank on a gentle slope or a step's edge sits that little off level.
const LEVEL_SHOT_SLACK = 0.1;

// Ace's fighting: planning and taking shots -- landing shots, banks, lunges --
// the chase, the ambush and the close fight, and getting out of the way of
// shots. Over `AceDriver`; `Ace` (`autopilot.mjs`) chooses what to do with it.
export class AceFighter extends AceDriver {
  // Trigger Happy fires whenever a slot is free, so the check `fireAtTank`
  // makes cannot hold a shot that would come back: instead the barrel is
  // kept off such a heading. Where the turn he is making has it when the
  // next shot goes, he turns instead for the nearest heading whose shot
  // does not return -- the one he can reach soonest.
  aimTriggerHappy(view, out) {
    const self = view.self;
    if (!firesContinuously(self.flag) || !self.ricochet || self.inAir) return;
    // A dodge is out of a shot already coming, which comes first.
    if (out.intent.mode === 'dodge') return;
    const ctx = { view, me: self, out };
    const rate = this.turnRate(ctx);
    const lead = Math.min(TRIGGER_HAPPY_LEAD, Math.max(0, self.nextShotIn ?? 0));
    const trace = this.lastTrace;
    const unsafe = (turn) => this.shotEndangersSelf(ctx, self.azimuth + turn);
    const planned = out.rotation * rate * lead;
    if (!unsafe(planned)) {
      this.lastTrace = trace;
      return;
    }
    let turn = null;
    for (let step = TRIGGER_HAPPY_STEP; step <= Math.PI + 1e-9 && turn === null; step += TRIGGER_HAPPY_STEP) {
      // The way he is already turning first.
      const first = out.rotation < 0 ? -1 : 1;
      if (!unsafe(first * step)) turn = first * step;
      else if (!unsafe(-first * step)) turn = -first * step;
    }
    this.lastTrace = trace;
    if (turn === null) return;
    out.rotation = Math.max(-1, Math.min(1, turn / (rate * Math.max(lead, TRIGGER_HAPPY_STEP_SECONDS))));
    out.intent.reason = 'trigger-happy';
  }

  // Whether Ace's team trails another team on score.
  teamBehind(ctx) {
    const scores = ctx.view.teamScores;
    const mine = scores?.[ctx.me.team];
    if (!Number.isFinite(mine)) return false;
    return Object.entries(scores).some(([team, score]) => team !== ctx.me.team && score > mine);
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

  // Whether a level shot from the muzzle has a wall between it and a landing:
  // asked at the muzzle's height, since along the ground a ray only grazes
  // the foot of a wall it would hit.
  landingHidden(ctx, landing) {
    const { me } = ctx;
    const z = me.z + (me.muzzleHeight ?? TANK.muzzleHeight);
    return this.isObscured(ctx, { x: me.x, y: me.y, z }, { x: landing.x, y: landing.y, z });
  }

  // Landing shots off walls: with ricochet on, the headings from which a shot
  // fired now passes through the landing after one or two bounces, at the
  // muzzle's height. Swept every `BANK_SWEEP_STEP` round him with the shot's
  // own trace, no further than it could fly before the touchdown, and each
  // near pass refined to the heading that goes through the middle. Each is a
  // plan in the shape of a direct one: its point lies along the first leg as
  // far as the whole path, so the aim, the speed and the timing are worked
  // out as for any other; only the line of sight is not asked. Found once a
  // jump, and again only if Ace moves.
  bankPlans(ctx, p, direct, landsAt) {
    const { view, me } = ctx;
    if (!me.ricochet || me.inAir || typeof view.traceLegs !== 'function') return [];
    const key = p.id;
    let cached = this.bankCache.get(key);
    if (!cached || Math.abs(cached.landsAt - landsAt) >= 0.5
      || Math.hypot(cached.x - me.x, cached.y - me.y) >= BANK_RECHECK_DISTANCE) {
      cached = { landsAt, x: me.x, y: me.y, sweep: { samples: [] }, found: null };
      this.bankCache.set(key, cached);
    }
    if (!cached.found) cached.found = this.findBanks(ctx, direct.landing, cached.sweep);
    const found = cached.found || [];
    const muzzleZ = me.z + me.muzzleHeight;
    return found.map(({ azimuth, along, bounces }) => {
      const distance = along + me.muzzleForward;
      return {
        landing: {
          x: me.x + (Math.cos(azimuth) * distance),
          y: me.y + (Math.sin(azimuth) * distance),
          z: muzzleZ,
          t: direct.landing.t,
        },
        reach: Math.max(0, along - TANK.radius),
        enter: direct.enter,
        distance,
        landsAt,
        level: true,
        bank: bounces,
      };
    });
  }

  // The sweep and the refinement behind `bankPlans`, as many headings each
  // call as fit in `BANK_BUDGET_MS`, so no one frame pays for all of it:
  // `state` carries the sweep from call to call, and the paths come back once
  // it is done -- null until then.
  findBanks(ctx, landing, state = { samples: [] }) {
    const { view, me } = ctx;
    if (typeof view.traceLegs !== 'function') return [];
    const muzzleZ = me.z + me.muzzleHeight;
    const tall = view.world.tankHeight;
    const speed = (me.shotSpeed ?? view.world.shotSpeed) + (me.topSpeed ?? view.world.tankSpeed);
    const range = speed * Math.min(me.shotLifetime ?? Infinity, landing.t + 0.1);
    // How near a heading's path comes to the landing after its first bounce
    // and before its third, and how far along the path that is.
    const pass = (azimuth) => {
      const dir = { x: Math.cos(azimuth), y: Math.sin(azimuth), z: 0 };
      const muzzle = { x: me.x + (dir.x * me.muzzleForward), y: me.y + (dir.y * me.muzzleForward), z: muzzleZ };
      let along = 0;
      let best = null;
      view.traceLegs(muzzle, dir, range, BANK_MAX_BOUNCES).forEach(({ from, to }, bounces) => {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const length = Math.hypot(dx, dy);
        if (bounces >= 1 && length > 1e-6) {
          const u = Math.max(0, Math.min(1, (((landing.x - from.x) * dx) + ((landing.y - from.y) * dy)) / (length * length)));
          const z = from.z + ((to.z - from.z) * u);
          const miss = Math.hypot(from.x + (dx * u) - landing.x, from.y + (dy * u) - landing.y);
          if (z >= landing.z && z <= landing.z + tall && (!best || miss < best.miss)) {
            best = { miss, along: along + (length * u), bounces };
          }
        }
        along += length;
      });
      return best;
    };
    const step = BANK_SWEEP_STEP;
    const total = Math.round((2 * Math.PI) / step);
    const { samples } = state;
    const startedAt = performance.now();
    for (let n = 0; samples.length < total && (n === 0 || performance.now() - startedAt < BANK_BUDGET_MS); n++) {
      const a = -Math.PI + (samples.length * step);
      samples.push({ a, r: pass(a) });
    }
    if (samples.length < total) return null;
    // The near passes, each the nearest of its neighbours: one refined a call.
    if (!state.candidates) {
      state.found = [];
      state.candidates = samples.filter((sample, i) => {
        const { r } = sample;
        if (!r || r.miss > BANK_COARSE_MISS) return false;
        const before = samples[(i + samples.length - 1) % samples.length].r;
        const after = samples[(i + 1) % samples.length].r;
        return !((before && before.miss < r.miss) || (after && after.miss <= r.miss));
      });
    }
    const sample = state.candidates.shift();
    if (sample) {
      // Ternary search on the miss across the neighbouring samples.
      let lo = sample.a - step;
      let hi = sample.a + step;
      for (let k = 0; k < BANK_REFINE_STEPS; k++) {
        const m1 = lo + ((hi - lo) / 3);
        const m2 = hi - ((hi - lo) / 3);
        if ((pass(m1)?.miss ?? Infinity) < (pass(m2)?.miss ?? Infinity)) hi = m2;
        else lo = m1;
      }
      const azimuth = (lo + hi) / 2;
      const best = pass(azimuth);
      if (best && best.miss < TANK.radius / 2) state.found.push({ azimuth, along: best.along, bounces: best.bounces });
      if (state.candidates.length) return null;
    }
    return state.found.sort((a, b) => a.along - b.along).slice(0, BANK_KEEP);
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
  //
  // The foe in the view is as it was a round trip and a little ago
  // (`LANDING_SHOT_BIAS`), so it is flown on that far first: a plan for where
  // it was is a shot that arrives after it has landed and driven off.
  planShots(ctx, seen) {
    const { view, me } = ctx;
    const p = this.landingLead(ctx, seen);
    if (!p) return [];
    const landing = this.predictLanding(ctx, p);
    if (!landing) return [];
    const landsAt = view.now + landing.t;
    const plans = [];
    const atLanding = this.planLandingShot(ctx, p);
    if (atLanding) plans.push({ ...atLanding, landsAt, level: true });
    // A landing out of sight may still be reached off a wall or two.
    if (atLanding && this.landingHidden(ctx, atLanding.landing)) {
      plans.push(...this.bankPlans(ctx, p, atLanding, landsAt));
    }
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

  // An airborne foe as it is now rather than as the view last heard of it:
  // on along its arc by the round trip, `LANDING_SHOT_BIAS` and a slow frame.
  // Null when it is down by then.
  landingLead(ctx, p) {
    // A frame slower than the 60 a second the bias was measured at is that
    // much older again by the time the shot goes.
    const lead = Math.max(0, ctx.view.self.lag ?? 0) + LANDING_SHOT_BIAS
      + Math.max(0, (this.frameSeconds || 0) - (1 / 60));
    if (!p.airborne || !(p.gravity > 0)) return p;
    const first = this.predictLanding(ctx, p);
    if (!first || first.t <= lead) return null;
    return {
      ...p,
      x: p.x + (p.vx * lead),
      y: p.y + (p.vy * lead),
      z: p.z + (p.vz * lead) - (0.5 * p.gravity * lead * lead),
      vz: p.vz - (p.gravity * lead),
    };
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
    // Where the speed is his to choose, it is chosen inside the window by a
    // margin, not on its edge: the foe's track arrives late and its touchdown
    // is a guess, and from a low muzzle -- a burrowed tank's, 0.25 up -- the
    // window is a hundredth of a second, so its edge is a miss.
    const margin = Math.min(LANDING_SHOT_MARGIN, Math.max(0, latest - plan.enter) / 2);
    const early = plan.enter + margin;
    const last = latest - margin;
    const want = Math.max(range.low, Math.min(range.high, preferred));
    const atWant = flightAt(want);
    if (fixed) {
      if (fits(atWant)) return atWant;
      return { late: !atWant || atWant.flight > latest, early: !!atWant && atWant.flight < plan.enter };
    }
    if (atWant && atWant.flight >= early && atWant.flight <= last) return atWant;
    // Shot speed is the tank's plus a constant, so the speeds that fit are one
    // interval: the slowest shot that is not late to the fastest not early.
    const scale = ctx.me.shotSpeed / ctx.view.world.shotSpeed;
    const base = ctx.view.world.shotSpeed;
    const slowest = (plan.reach / last) / scale - base;
    const fastest = early > 0 ? (plan.reach / early) / scale - base : Infinity;
    const low = Math.max(range.low, slowest);
    const high = Math.min(range.high, fastest);
    if (low > high) return { late: range.high < slowest, early: range.low > fastest };
    const chosen = flightAt(Math.max(low, Math.min(high, want)));
    return fits(chosen) ? chosen : { late: false, early: false };
  }

  // Roger chases in a straight line, which a wall between him and the foe
  // turns into driving at the wall. Ace takes the route there instead while
  // the foe is out of sight, and Roger's straight chase again once it is in
  // it. The route is kept until the foe has moved `CHASE_DEST_SLACK`, so a
  // moving foe is not a new search every frame.
  chaseAround(ctx, target) {
    const { view, me } = ctx;
    if (typeof view.findRoute !== 'function') return false;
    const foe = target;
    // In sight and on a level a shot reaches, Roger's straight chase does;
    // on another level, the way up or down is a route too.
    const otherLevel = Math.abs(foe.z - me.z) >= 2 * view.world.tankHeight;
    if (!otherLevel
      && !this.isObscured(ctx, { x: me.x, y: me.y, z: me.z + 1 }, { x: foe.x, y: foe.y, z: foe.z + 1 })) return false;
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

  // Roger turns by the angle to the foe as a share of full stick, so a foe
  // crossing in front is chased a step behind for as long as he keeps moving:
  // 0.3 radians off is three tenths of a turn, slower than a tank at speed
  // fifty units away sweeps across the sights. In sight and in reach, Ace
  // steers at where a shot would meet him, hard while off it, and turns with
  // the foe's own sweep on top, so the sights stay on him and the shot goes.
  trackFoe(ctx, foe) {
    const { view, me, out } = ctx;
    if (Math.abs(foe.z - me.z) >= 2 * view.world.tankHeight) return;
    const d = distance2D(me, foe);
    const shotSpeed = me.shotSpeed ?? view.world.shotSpeed;
    if (!(d > 0) || !(shotSpeed > 0) || d > shotSpeed * (me.shotLifetime ?? Infinity)) return;
    if (this.isObscured(ctx, { x: me.x, y: me.y, z: me.z + 1 }, { x: foe.x, y: foe.y, z: foe.z + 1 })) return;
    // The shot keeps Ace's own velocity, so the lead is the foe's against his.
    const rvx = (foe.vx ?? 0) - (me.vx ?? 0);
    const rvy = (foe.vy ?? 0) - (me.vy ?? 0);
    const t = d / shotSpeed;
    const bearing = normalizeAngle(azimuthTo(me, { x: foe.x + (rvx * t), y: foe.y + (rvy * t) }) - me.azimuth);
    const rx = foe.x - me.x;
    const ry = foe.y - me.y;
    const sweep = ((rx * rvy) - (ry * rvx)) / (d * d);
    const rate = this.turnRate(ctx);
    out.rotation = Math.max(-1, Math.min(1, (bearing / (rate * TRACK_TURN_SECONDS)) + (sweep / rate)));
  }

  // A burrowed foe is under every shell Ace fires, so the kill is driving
  // over him (`canRunOver`), and driving over him backwards does it as well
  // as forwards. Behind him -- come down past him from a jump, say -- backing
  // up can be sooner than turning round: reverse is half speed (upstream's
  // -0.5 clamp), and a half turn is four seconds. Whichever arrives first is
  // taken; forwards is Roger's chase, as it was.
  runOver(ctx, target) {
    const { view, me, out } = ctx;
    if (target.flag !== 'BU' || !(target.z < 0)) return false;
    if (!canRunOver(me.flag ?? null, 'BU', me.z, me.zoned === true)) return false;
    const distance = distance2D(me, target);
    if (distance > SQUASH_JUMP_MIN && this.takeSquashJump(ctx, target)) return true;
    const top = me.topSpeed ?? view.world.tankSpeed;
    const rate = this.turnRate(ctx);
    if (!(top > 0) || !(rate > 0)) return false;
    const ahead = normalizeAngle(azimuthTo(me, target) - me.azimuth);
    const behind = normalizeAngle(ahead + Math.PI);
    const forward = (Math.abs(ahead) / rate) + (distance / top);
    const reverse = (Math.abs(behind) / rate) + (distance / (REVERSE_SPEED_SHARE * top));
    if (reverse >= forward) return false;
    out.rotation = this.steer(ctx, behind);
    out.speed = -REVERSE_SPEED_SHARE * Math.max(0, Math.cos(behind));
    out.intent.reason = 'run-over';
    return true;
  }

  // A jump that comes down on a burrowed foe squashes him, and all the way
  // there Ace is over every shot he can fire, which skims the floor. The arc
  // is a jump from where Ace stands to the ground the foe is under, so its
  // time is fixed, and the speed it leaves with is the one that covers the
  // distance to where the foe will be by then -- within one jump's reach, and
  // lined up closely enough that the miss across is inside the run-over
  // reach. `aligned` false is a jump in reach that wants turning to first.
  // Null when no jump does it.
  squashJump(ctx, foe) {
    const { view, me } = ctx;
    if (!foe || foe.flag !== 'BU' || !(foe.z < 0)) return null;
    if (me.inAir || !canTankJump(view.world, me.flag, me.z)) return null;
    if (!canRunOver(me.flag ?? null, 'BU', 0, me.zoned === true)) return null;
    const v = view.world.jumpVelocity;
    const g = view.world.gravity;
    if (!(v > 0) || !(g > 0)) return null;
    const t = (v + Math.sqrt((v * v) + (2 * g * Math.max(0, me.z)))) / g;
    const at = { x: foe.x + ((foe.vx ?? 0) * t), y: foe.y + ((foe.vy ?? 0) * t), z: 0 };
    const distance = distance2D(me, at);
    const speed = distance / t;
    if (speed > (me.topSpeed ?? view.world.tankSpeed)) return null;
    const bearing = normalizeAngle(azimuthTo(me, at) - me.azimuth);
    // Inside the reach with room to spare: the separation counts the foe's
    // depth double (`getRunOverSeparation`).
    const reach = getRunOverRadius('BU', me.flag ?? null, TANK.radius);
    const depth = 2 * Math.abs(foe.z);
    const across = Math.sqrt(Math.max(0, (reach * reach) - (depth * depth))) / 2;
    const aligned = Math.cos(bearing) > 0 && distance * Math.abs(Math.sin(bearing)) < across;
    return { speed, t, at, bearing, aligned };
  }

  // The squash jump, taken: lined up, at its speed, and up once the tank is
  // going that fast. False when there is none to take.
  takeSquashJump(ctx, foe) {
    const { me, out } = ctx;
    const jump = this.squashJump(ctx, foe);
    // Not worth a slow turn on the spot: the ground has its own ways over him.
    if (!jump || Math.abs(jump.bearing) > SQUASH_JUMP_TURN) return false;
    this.aimAt(ctx, normalizeAngle(me.azimuth + jump.bearing));
    out.speed = jump.aligned ? this.speedFraction(ctx, jump.speed) : 0;
    out.jump = jump.aligned
      && (!(me.accel > 0) || Math.abs((me.speed ?? jump.speed) - jump.speed) <= JUMP_SPEED_SLACK);
    out.intent.reason = 'squash';
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
  // Holding a Shock Wave the way Ace faces does not matter, only how far the
  // foe is: he drives at it, round what is in the way, with no aiming and no
  // lining up, and `fireShockWave` sets it off once it is inside.
  closeWithShockWave(ctx, foe, mode) {
    ctx.out.targetId = foe.id;
    ctx.out.intent.target = { ...pointOf(foe), id: foe.id };
    return this.goTo(ctx, pointOf(foe), mode);
  }

  // A Shock Wave is a sphere about where it went off, growing to
  // `shockOutRadius` and killing everything inside, building or no, team mate
  // or no (ShockWaveStrategy::checkHit). It goes when a foe will be inside it
  // -- upstream's 0.3 seconds ahead, in three dimensions as the hit is, where
  // upstream measures across the ground -- and never while a team mate is
  // inside it or near the edge, where team kills count: every team mate on
  // the roster, in the air or out of sight too, since the wave finds him
  // whether Ace sees him or not.
  fireShockWave(ctx) {
    const { view, me, out } = ctx;
    if (!me.canFire || view.now - this.lastShot < 1 / view.world.maxShots) return;
    const radius = view.world.shockOutRadius;
    if (!(radius > 0)) return;
    const pos = { x: me.x, y: me.y, z: me.z < 0 ? 0 : me.z };
    const reach = (p) => {
      const at = predict(p);
      return Math.hypot(at.x - pos.x, at.y - pos.y, at.z - pos.z);
    };
    if (!view.world.noTeamKills && view.players.some((p) => p.alive && !p.paused && !view.isFoe(p)
      && reach(p) <= radius + SHOCK_WAVE_TEAM_MARGIN)) return;
    const target = this.remotePlayers(view).find((p) => p.alive && !p.paused && !p.notResponding
      && view.isFoe(p) && reach(p) <= radius);
    if (!target) return;
    out.fire = true;
    out.shotTargetId = target.id;
    this.lastShot = view.now;
  }

  fightClose(ctx, foe) {
    const { out } = ctx;
    out.targetId = foe.id;
    out.intent.target = { ...pointOf(foe), id: foe.id };
    out.intent.mode = 'fight';
    if (ctx.me.flag === 'SW') return this.closeWithShockWave(ctx, foe, 'fight');
    this.aimAt(ctx, azimuthTo(ctx.me, predict(foe)));
    out.speed = 0;
    return true;
  }

  // The foe in the air whose landing Ace can still put a shot into, nearest
  // first, at any distance a shot carries: it is the surest kill there is.
  // Too late once he has turned to it is too late for good -- the shot is
  // faster than the tank, so driving closer loses more time than it saves --
  // and a foe already shot at is left to that shot. `level` keeps to foes
  // coming down on Ace's own level, a shot into where they land, rather
  // than one met on the way past at another.
  ambushTarget(ctx, { level = false } = {}) {
    const { view, me } = ctx;
    // A Shock Wave has no landing to aim at: it reaches every way at once.
    if (me.flag === 'SW') return null;
    const top = me.topSpeed ?? view.world.tankSpeed;
    const full = { low: -0.5 * top, high: top, top };
    let best = null;
    for (const p of this.remotePlayers(view)) {
      if (!p.airborne || !p.alive || p.paused || !view.isFoe(p)) continue;
      if (p.zoned && !me.zoned) continue;
      for (const plan of this.planShots(ctx, p)) {
        if (level && !plan.level) continue;
        if (this.landingShotsSpent(p, plan.landsAt) >= this.shotsToKill(p)) break;
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
        if (!plan.bank && this.landingHidden(ctx, plan.landing)) continue;
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
  shotVelocity(ctx, azimuth = ctx.view.self.azimuth) {
    const { view, me, out } = ctx;
    const self = view.self;
    const base = view.world.shotSpeed;
    const dirX = Math.cos(azimuth);
    const dirY = Math.sin(azimuth);
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

  // Whether the shot about to be fired, or one fired facing `azimuth`, comes
  // back to where Ace is. Only a ricochet can, and only once it has had time
  // to turn round.
  shotEndangersSelf(ctx, azimuth = ctx.view.self.azimuth) {
    const { view } = ctx;
    const self = view.self;
    this.lastTrace = null;
    if (!self.ricochet || typeof view.traceShot !== 'function') return false;
    const dirX = Math.cos(azimuth);
    const dirY = Math.sin(azimuth);
    const muzzle = {
      x: self.x + (dirX * self.muzzleForward),
      y: self.y + (dirY * self.muzzleForward),
      z: self.z + self.muzzleHeight,
    };
    const reach = TANK.radius + SELF_HIT_MARGIN;
    const shot = this.shotVelocity(ctx, azimuth);
    const segments = view.traceShot(muzzle, shot.dir, shot.speed, self.shotLifetime, true);
    this.lastTrace = segments;
    // The first leg leaves from the muzzle, so it is beside him by
    // definition; every bounce after it counts, however soon -- fired into a
    // wall at point blank, the shot is back in a hundredth of a second. A
    // leg is judged by its lowest end: one that bounces up off a slope
    // passes through him on its way up. One wholly below him is on another
    // level -- out of a teleporter's lower end, under him in plan.
    for (const segment of segments.slice(1)) {
      if (Math.min(segment.from.z, segment.to.z) > self.z + view.world.tankHeight + 1) continue;
      if (Math.max(segment.from.z, segment.to.z) < self.z - 1) continue;
      if (segmentDistance2D(segment.from, segment.to, self) < reach) return true;
    }
    return false;
  }

  // A Shield takes a hit for its holder -- the flag goes and the tank lives
  // (`gotBlowedUp`, playing.cxx:3918) -- so a foe holding one is worth two:
  // the second follows the first into the same landing.
  shotsToKill(p) {
    return p.flag === 'SH' ? 2 : 1;
  }

  // The shots already fired at the landing at `landsAt`.
  landingShotsSpent(p, landsAt) {
    const entry = this.landingShots.get(p.id);
    return entry && Math.abs(entry.landsAt - landsAt) < 0.5 ? entry.count : 0;
  }

  // Roger's trigger for every foe on the ground; for a foe in the air, timed
  // shots at its landing -- as many as `shotsToKill` -- and nothing else.
  chooseShot(ctx) {
    const { view, me, out } = ctx;
    if (me.flag === 'SW') {
      this.fireShockWave(ctx);
      return;
    }
    const players = this.remotePlayers(view);
    for (const p of players) {
      if (!p.airborne || !p.alive || p.paused || !view.isFoe(p)) continue;
      if (!me.canFire) continue;
      for (const planned of this.planShots(ctx, p)) {
        // How far the shot's arrival may be off, from the network's jitter
        // and a frame's wait: a touchdown window narrower than that -- a
        // burrowed muzzle's hundredth of a second -- gets two shots, one aimed
        // half of it early and one half of it late, so one of them lands in
        // it. (A piece of a pass through the muzzle's height is short only by
        // cutting; the next piece carries on where it stops.)
        const spread = Math.max(0, ctx.view.self.jitter ?? 0) + (this.frameSeconds || 0);
        const paired = (planned.level || planned.bank) && planned.landing.t - planned.enter < spread;
        const spent = this.landingShotsSpent(p, planned.landsAt);
        if (spent >= this.shotsToKill(p) * (paired ? 2 : 1)) break;
        const plan = paired ? shiftPlan(planned, (spent % 2 === 0 ? 1 : -1) * (spread / 2)) : planned;
        // Late is a miss; early waits for a later frame. A dodge has already
        // picked the speed, and the shot has to make do with it.
        const range = this.speedRange(ctx);
        const preferred = out.speed * range.top;
        const shot = this.landingShotSpeed(ctx, plan, preferred,
          out.intent.mode === 'dodge' ? { ...range, low: preferred, high: preferred } : range);
        if (!Number.isFinite(shot.flight)) continue;
        const miss = plan.distance * Math.abs(Math.sin(normalizeAngle(shot.azimuth - me.azimuth)));
        if (miss > TANK.radius / 2) continue;
        if (!plan.bank && this.landingHidden(ctx, plan.landing)) continue;
        out.fire = true;
        out.shotTargetId = p.id;
        this.landingShotChosen = true;
        if (!me.inAir) out.speed = shot.speed / range.top;
        this.landingShots.set(p.id, {
          landsAt: plan.landsAt, count: this.landingShotsSpent(p, plan.landsAt) + 1,
        });
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
    // A tank with a landing shot already on its way is left to it. A shot
    // goes out level at the muzzle's height, so only a foe whose body that
    // height is inside is worth one: Roger's two tank heights either way
    // would put most of them over its head or under its tracks.
    // And from the air there is one pass through that height, so the shot goes
    // only when its line runs through the foe, not merely near the heading
    // Roger's trigger takes: a tenth of a radian is several units at range.
    const muzzle = me.z + (me.muzzleHeight ?? 1.57);
    // On the ground too: Roger's two tank heights either way is a shot over
    // or under a foe on a step or a slope -- a Super Bullet through the
    // building between most of all. A Guided Missile climbs to its target and
    // a Shock Wave is a sphere, so neither is held to its own height.
    const levelShot = me.flag !== 'GM' && me.flag !== 'SW';
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
    const free = view.self.freeShots;
    const keep = Math.min(2, (view.world.maxShots ?? 1) - 1);
    const floorShotSpare = !Number.isFinite(free) || free - 1 >= keep;
    const grounded = {
      ...view,
      players: this.remotePlayers(view).filter((p) => !p.airborne
        && !(view.now <= (this.landingShots.get(p.id)?.landsAt ?? -Infinity) + 0.5
          && this.landingShotsSpent(p, this.landingShots.get(p.id).landsAt) >= this.shotsToKill(p))
        && inRange(p)
        // From under the ground the shot skims the floor, and a foe who can
        // jump may hop it once he sees it coming. It goes all the same, from
        // one slot: the rest are kept for the pair a landing shot takes
        // (`chooseShot`), which meets him as he comes down.
        && !(me.z < 0 && canTankJump(view.world, p.flag, p.z) && !floorShotSpare)
        && (levelShot === false || (muzzle >= p.z - LEVEL_SHOT_SLACK
          && muzzle <= p.z + view.world.tankHeight + LEVEL_SHOT_SLACK))
        && (!me.inAir || onLine(p))),
    };
    super.fireAtTank({ ...ctx, view: grounded });
  }

  // Staying alive comes first, and driving out of a shot's way before
  // jumping over it: a dodge keeps him in control, where a tank in the air
  // cannot steer and comes down three seconds later where any foe can wait
  // for it. A shot is a threat only where it meets the path he is on, so one
  // he is already driving clear of is left alone. Otherwise every speed and
  // turn he could put on (`dodgePath`) is driven out against every shot in
  // sight, and the clear one nearest what he is doing is taken. A jump only
  // when none is clear -- however the landing looks, since the shot is
  // certain and the landing is not -- and only where it is above the shot
  // before it arrives; and otherwise Roger's dodge.
  avoidBullet(ctx) {
    const { view, me, out } = ctx;
    const top = me.topSpeed ?? view.world.tankSpeed;
    const heading = { x: Math.cos(me.azimuth), y: Math.sin(me.azimuth) };
    const along = me.inAir ? 0 : ((me.vx ?? 0) * heading.x) + ((me.vy ?? 0) * heading.y);
    const shot = this.soonestHit(ctx, { x: heading.x * along, y: heading.y * along });
    const squash = this.squashThreat(ctx);
    if (!shot && !squash) return false;
    // A burrowed foe's shot skims the floor: the jump over it is the one that
    // comes down on him, when there is one lined up.
    const shooter = shot && this.remotePlayers(view).find((p) => p.id === shot.ownerId);
    const onto = shooter ? this.squashJump(ctx, shooter) : null;
    if (onto?.aligned && this.canJumpClear(ctx, shot)) {
      out.jump = true;
      out.speed = this.speedFraction(ctx, onto.speed);
      out.rotation = 0;
      out.targetId = shooter.id;
      out.intent.reason = 'squash';
      return true;
    }
    if (shot && !me.inAir && top > 0) {
      const path = this.dodgePath(ctx, top, along / top);
      if (path) {
        out.speed = path.speed;
        out.rotation = path.turn;
        return true;
      }
    }
    // Underground nothing but another burrowed tank's shot reaches him, and
    // nothing lifts him out: he drives clear of a tank coming over him, or
    // takes it.
    if (squash && (!shot || squash.time < shot.time)) {
      let lateral = (heading.x * squash.away.x) + (heading.y * squash.away.y);
      // Dead on, neither side is nearer, so take the one ahead: forward is
      // twice reverse.
      if (squash.miss < DODGE_DEAD_ON && lateral < 0) lateral = -lateral;
      const needed = squash.clearance - squash.miss;
      const forwardRate = view.world.tankSpeed * lateral;
      const reverseRate = -0.5 * view.world.tankSpeed * lateral;
      const [speed, rate] = forwardRate >= reverseRate ? [1, forwardRate] : [-0.5, reverseRate];
      if (rate > 0 && needed / rate < squash.time - DODGE_MARGIN_SECONDS) {
        const travel = (needed / rate) * Math.abs(speed) * view.world.tankSpeed;
        const way = speed > 0 ? me.azimuth : me.azimuth + Math.PI;
        if (this.openDistance(ctx, me, way) > travel + 2) {
          out.speed = speed;
          out.rotation = 0;
          return true;
        }
      }
      // Head on, forward is into it and reverse is too slow, and there is no
      // jumping underground (LocalPlayer.cxx:1406): he gets on with the
      // fight, which is a shot at the tank coming.
      return false;
    }
    if (me.flag === 'BU' && me.z < 0) return false;
    if (this.canJumpClear(ctx, shot)) {
      // Straight up, turning: a tank keeps through the air the turn it left
      // with, so the one put on now brings his sights onto the shooter as his
      // muzzle comes down to the shooter's height -- the moment a shot from
      // the air can hit him, and `fireAtTank` takes it then, before the
      // landing he is waiting for; and again on the ground.
      out.jump = true;
      out.speed = 0;
      out.rotation = this.jumpTurnToward(ctx, shot.ownerId) ?? 0;
      return true;
    }
    return super.avoidBullet(ctx);
  }

  // The turn to leave the ground with, as a share of full stick, that faces
  // where a shot fired on the way down meets the foe `id`: when the muzzle
  // falls to the top of his body, aimed ahead of him by the shot's flight.
  // Null when there is no such foe or the jump never comes down that low.
  jumpTurnToward(ctx, id) {
    const { view, me } = ctx;
    if (id === undefined || id === null) return null;
    const foe = this.remotePlayers(view).find((p) => p.id === id);
    if (!foe || !foe.alive || foe.paused) return null;
    const g = view.world.gravity;
    const v = view.world.jumpVelocity;
    const rate = this.turnRate(ctx);
    if (!(g > 0) || !(rate > 0)) return null;
    const drop = (me.z + (me.muzzleHeight ?? TANK.muzzleHeight)) - (foe.z + view.world.tankHeight);
    const disc = (v * v) + (2 * g * drop);
    if (disc < 0) return null;
    const t = (v + Math.sqrt(disc)) / g;
    const shotSpeed = me.shotSpeed ?? view.world.shotSpeed;
    const ahead = { x: foe.x + ((foe.vx ?? 0) * t), y: foe.y + ((foe.vy ?? 0) * t) };
    const flight = shotSpeed > 0 ? distance2D(me, ahead) / shotSpeed : 0;
    const aim = { x: ahead.x + ((foe.vx ?? 0) * flight), y: ahead.y + ((foe.vy ?? 0) * flight) };
    const turn = normalizeAngle(azimuthTo(me, aim) - me.azimuth);
    return Math.max(-1, Math.min(1, turn / (rate * t)));
  }

  // The dodge: of every speed and turn Ace could hold (`DODGE_SPEEDS` by
  // `DODGE_TURNS`), the one nearest what he is doing whose path -- driven out
  // every `DODGE_STEP_SECONDS` to just past the last shot that could reach
  // him -- no shot in sight hits, and that runs into nothing. A hit is the
  // one a shot really makes (`getSegmentTankHitFraction`): within 0.99 of
  // the tank's radius of its middle, half its height up -- a sphere, so a
  // level shell's reach across is less than the radius by its height off
  // the middle -- or, holding Narrow, within the shell's radius of a box the
  // tank's length long; with `DODGE_HIT_MARGIN` of room either way, which is
  // all a dodge needs where the old test asked for a unit more. Null when
  // there is none.
  dodgePath(ctx, top, current) {
    const { view, me } = ctx;
    const narrow = usesNarrowHitBox(me.flag ?? null);
    const radius = 0.99 * TANK.radius * getTankHitRadiusScale(me.flag ?? null);
    const middle = me.z + (TANK.hitHeight / 2);
    const shots = [];
    let horizon = 0;
    for (const shot of view.shots) {
      if (shot.ownerId !== me.id && !canSeeShot(me.flag, shot.flag)) continue;
      if (shot.ownerZoned && !me.zoned) continue;
      if (shot.flag === 'L' && me.flag === 'CL') continue;
      if (shot.flag !== 'GM' && (shot.z < me.z - SHOT_COLLISION_RADIUS
        || shot.z > me.z + view.world.tankHeight + SHOT_COLLISION_RADIUS)) continue;
      const speed2 = (shot.vx * shot.vx) + (shot.vy * shot.vy);
      if (speed2 < 1e-6) continue;
      // When it is nearest where he stands, as a bound on how long to look.
      const t = (((me.x - shot.x) * shot.vx) + ((me.y - shot.y) * shot.vy)) / speed2;
      if (t + DODGE_MARGIN_SECONDS < 0) continue;
      const dz = shot.z - middle;
      const reach = narrow ? null : Math.sqrt(Math.max(0, (radius * radius) - (dz * dz))) + DODGE_HIT_MARGIN;
      shots.push({ ...shot, reach });
      horizon = Math.max(horizon, t + DODGE_MARGIN_SECONDS);
    }
    horizon = Math.min(DODGE_HORIZON_SECONDS, Math.max(horizon, DODGE_STEP_SECONDS * 4));
    const rate = this.turnRate(ctx);
    const turning = rate > 0 ? (me.angVel ?? 0) / rate : 0;
    const z = me.z + 1;
    let best = null;
    for (const speed of DODGE_SPEEDS) {
      for (const turn of DODGE_TURNS) {
        let x = me.x;
        let y = me.y;
        let azimuth = me.azimuth;
        let clear = true;
        let margin = Infinity;
        let from = { x, y, z };
        for (let t = DODGE_STEP_SECONDS; t <= horizon + 1e-9 && clear; t += DODGE_STEP_SECONDS) {
          // A shot crosses more than a tank's width in one step, so each is
          // tested at `DODGE_HIT_SECONDS` through it.
          for (let k = 1; k <= DODGE_HIT_STEPS && clear; k++) {
            const dt = (DODGE_STEP_SECONDS * k) / DODGE_HIT_STEPS;
            const a = azimuth + (turn * rate * dt);
            const px = x + (Math.cos(a) * speed * top * dt);
            const py = y + (Math.sin(a) * speed * top * dt);
            const at = t - DODGE_STEP_SECONDS + dt;
            const c = Math.cos(a);
            const sn = Math.sin(a);
            for (const shot of shots) {
              const rx = shot.x + (shot.vx * at) - px;
              const ry = shot.y + (shot.vy * at) - py;
              if (shot.reach !== null) {
                const miss = Math.hypot(rx, ry) - shot.reach;
                margin = Math.min(margin, miss);
                if (miss < 0) clear = false;
              } else {
                const lengthwise = Math.abs((rx * c) + (ry * sn)) - (TANK.halfLength + DODGE_HIT_MARGIN);
                const sideways = Math.abs((ry * c) - (rx * sn)) - (SHOT_COLLISION_RADIUS + DODGE_HIT_MARGIN);
                margin = Math.min(margin, Math.max(lengthwise, sideways));
                if (lengthwise < 0 && sideways < 0) clear = false;
              }
            }
          }
          azimuth += turn * rate * DODGE_STEP_SECONDS;
          x += Math.cos(azimuth) * speed * top * DODGE_STEP_SECONDS;
          y += Math.sin(azimuth) * speed * top * DODGE_STEP_SECONDS;
          // Walls, every half second of the path and at its end.
          if (clear && speed !== 0 && (t % 0.5 < DODGE_STEP_SECONDS || t + DODGE_STEP_SECONDS > horizon)) {
            const to = { x, y, z };
            if (this.isObscured(ctx, from, to)) clear = false;
            from = to;
          }
        }
        if (!clear) continue;
        const cost = Math.abs(speed - current) + (DODGE_TURN_COST * Math.abs(turn - turning));
        if (!best || cost < best.cost || (cost === best.cost && margin > best.margin)) {
          best = { speed, turn, cost, margin };
        }
      }
    }
    return best;
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
      // The kill's own distance, with the height between them counted double
      // (`getRunOverSeparation`): a tank crossing on a deck above passes over
      // him and nothing more.
      if (getRunOverSeparation(mx, my, me.z - p.z) >= clearance) continue;
      if (best && time >= best.time) continue;
      const length = Math.sqrt(speed2);
      const away = miss > 1e-6 ? { x: mx / miss, y: my / miss } : { x: -p.vy / length, y: p.vx / length };
      best = { time, miss, away, clearance };
    }
    return best;
  }

  // Of the shots Ace can see, the one that will hit him soonest if he stays
  // put: when it passes closest, by how much, and which way is away from it.
  // His own are in the view once they have bounced, and count like any
  // other: Roger, as upstream's does, never looks at his own.
  // `own` is the velocity Ace keeps meanwhile: still, by default.
  soonestHit(ctx, own = { x: 0, y: 0 }) {
    const { view, me } = ctx;
    const clearance = TANK.radius + SHOT_COLLISION_RADIUS + DODGE_CLEARANCE;
    let best = null;
    for (const shot of view.shots) {
      if (shot.ownerId !== me.id && !canSeeShot(me.flag, shot.flag)) continue;
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
      // Both moving: the shot as he sees it from his own path.
      const rvx = vx - own.x;
      const rvy = vy - own.y;
      const rv2 = (rvx * rvx) + (rvy * rvy);
      if (rv2 < 1e-6) continue;
      const rx = me.x - pos.x;
      const ry = me.y - pos.y;
      const time = ((rx * rvx) + (ry * rvy)) / rv2;
      if (time <= 0 || time > DODGE_HORIZON_SECONDS) continue;
      const mx = rx - (rvx * time);
      const my = ry - (rvy * time);
      const miss = Math.hypot(mx, my);
      if (miss >= clearance) continue;
      if (best && time >= best.time) continue;
      const length = Math.sqrt(rv2);
      // Dead on, either side is away; take the left of the shot.
      const away = miss > 1e-6 ? { x: mx / miss, y: my / miss } : { x: -rvy / length, y: rvx / length };
      best = { time, miss, away, clearance, height: pos.z - me.z, ownerId: shot.ownerId };
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

  // Sight as a shot has it, muzzle to muzzle (`chooseShot`): from the ground,
  // a line clear at the tank's feet can still meet something at its barrel.
  withMuzzleSight(ctx, fn) {
    const lift = this.sightLift;
    this.sightLift = ctx.me.muzzleHeight ?? 1.57;
    try {
      return fn();
    } finally {
      this.sightLift = lift;
    }
  }

  // How far a foe's shot carries: the world's range, plus the foe's own speed
  // for the shot's life, which a lunge puts into it.
  foeShotReach(ctx) {
    const { world } = ctx.view;
    const range = world.shotRange ?? 350;
    const speed = world.shotSpeed || 100;
    return range + ((world.tankSpeed || 25) * (range / speed));
  }

  // A laser holder's speed, facing the foe it shoots: back off from a foe
  // inside a shot's reach, close in on one well beyond it when there is no
  // spot being held, and otherwise stand.
  laserStandoffSpeed(ctx, holdingSpot) {
    const { view, me } = ctx;
    const nearest = Math.min(...this.remotePlayers(view)
      .filter((p) => p.alive && !p.paused && view.isFoe(p)).map((p) => distance2D(me, p)));
    const standoff = this.foeShotReach(ctx) + LASER_STANDOFF_MARGIN;
    if (nearest < standoff) return -0.6;
    if (!holdingSpot && nearest > standoff + LASER_STANDOFF_SLACK) return 0.6;
    return 0;
  }

  // A foe with Shock Wave that is, or could soon be, close enough to hit the
  // spot.
  swThreat(ctx, spot) {
    const { view } = ctx;
    const radius = (view.world.shockOutRadius || 0) * CAMP_SW_MARGIN;
    return this.remotePlayers(view).some((p) => p.alive && view.isFoe(p) && p.flag === 'SW'
      && Math.hypot(p.x - spot.x, p.y - spot.y, p.z - spot.z) < radius);
  }
}
