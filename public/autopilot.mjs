/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The autopilots. `Roger` (`roger.mjs`) is upstream's own
// (`src/bzflag/AutoPilot.cxx`) and stays that: each frame it decides a turn,
// a speed, a jump and a trigger, which the caller feeds through exactly the
// path a stick would. `Ace` is Roger with bzo's improvements, and is where
// new behaviour goes -- Roger is the reference it is measured against. He is
// built in layers, each a subclass of the one before: driving
// (`ace-driver.mjs`), fighting (`ace-fighter.mjs`), and here what he chooses
// to do with them.
// Nothing here reads the client: everything arrives through a *view* (see
// `docs/bots-plan.md`), so a server-launched bot can drive the same
// decisions from its own world.
//
// Everything is in upstream's frame -- (x, y) on the ground, z up, azimuth
// counter-clockwise from +x -- so it reads line for line against
// AutoPilot.cxx: the view, its probes, the routes `nav` plans, and the intent
// the pilot reports. A positive rotation turns left.

import { canSeeShot, FLAG_ENDURANCE, getFlagEndurance, isBadFlag } from './flags.mjs';
import { normalizeAngle } from './motion.mjs';
import { isRabbitTeam } from './teams.mjs';
import { azimuthTo, distance2D, HALF_PI, HARD_FLAGS, pointOf, predict, Roger } from './roger.mjs';
import {
  canTankJump, JUMP_AIM_TOLERANCE, JUMP_LOOKAHEAD, JUMP_REACH_SHARE, MAX_STEP_UP, UNREACHABLE_SECONDS,
} from './ace-driver.mjs';
import {
  AceFighter, CHASE_DEST_SLACK, RABBIT_CLOSING_SPEED, RABBIT_FLEE_DISTANCE, RABBIT_FLEE_MARGIN, TARGET_MODES,
} from './ace-fighter.mjs';

export { Roger };

// Campers. A foe who kills with a flag to camp with (`CAMP_FLAGS`)
// `CAMPER_KILLS` times within `CAMPER_WINDOW_SECONDS` -- of Ace, as a rogue;
// of Ace's side and `CAMPER_LEAD` clear of every other tank on score, in team
// play -- is camping. What beats his flag: Stealth, which no missile locks on
// (GuidedMissleStrategy.cxx:169), and Cloaking, which a laser passes through.
// His flag is all but spent at `CAMPER_SPENT_SHOTS` shots left or
// `CAMPER_SPENT_SHARE` of its limit, whichever is more. Hunted, he counts as
// nearer by `DOMINANT_WEIGHT`; waited out, as further by
// `CAMPER_WAIT_WEIGHT`. A flag known to beat his counts as nearer by
// `CAMPER_COUNTER_PULL`.
const CAMPER_KILLS = 2;
const CAMPER_WINDOW_SECONDS = 180;
const CAMPER_LEAD = 3;
const CAMPER_COUNTERS = { GM: 'ST', L: 'CL' };
const CAMPER_SPENT_SHOTS = 2;
const CAMPER_SPENT_SHARE = 0.2;
const CAMPER_WAIT_WEIGHT = 3;
const CAMPER_COUNTER_PULL = 0.5;
// The antidote is worth the drive when shaking the flag off takes longer than
// the drive there, with this much to spare.
const ANTIDOTE_DRIVE_FACTOR = 1.5;
const ANTIDOTE_SPARE_SECONDS = 2;
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
// One this far clear is running away with the game: Ace hunts him wherever
// he is, ahead of captures and flags, and he counts as nearer by
// `DOMINANT_WEIGHT` instead.
const DOMINANT_LEAD = 10;
const DOMINANT_WEIGHT = 0.3;
// Ace this far below his foes' average score is losing, and goes after his
// own score -- kills -- rather than captures and flags: a capture gives way
// to any foe he can shoot within `LOSING_FIGHT_RANGE`, a foe past Roger's
// chase range is hunted, and only a flag within `LOSING_FLAG_RANGE` is worth
// the detour.
const LOSING_MARGIN = 3;
const LOSING_FIGHT_RANGE = 150;
const LOSING_FLAG_RANGE = 40;
// How far upstream's pilot chases (AutoPilot.cxx); Ace hunts past it.
const ROGER_CHASE_RANGE = 250;
// Ace's own flag let go of over another team's base comes down where the
// server puts it (bzfs `dropFlag`). Ace does that when such a base is within
// `OVER_BASE_RANGE` of its edge, home is at least `OVER_BASE_MIN_HOME` away,
// the flag would land within `OVER_BASE_LANDING_RANGE` of home, and no foe is
// within `OVER_BASE_FOE_RANGE`.
const OVER_BASE_RANGE = 30;
const OVER_BASE_MIN_HOME = 150;
const OVER_BASE_LANDING_RANGE = 50;
const OVER_BASE_FOE_RANGE = 60;
// Camping. With nobody within `CAMP_CLEAR_RANGE` and nobody running away
// with the score, Ace goes looking for a flag to camp with; holding one, he
// takes the best vantage point he can reach and shoots from there. The spot is
// scored again every `CAMP_RESCORE_SECONDS`, and given up -- for
// `CAMP_SPOT_COOLDOWN` seconds -- after `CAMP_AVOID_LIMIT` dodges there within
// `CAMP_AVOID_WINDOW`, or when a foe with Shock Wave is within reach of it.
const CAMP_FLAGS = new Set(['GM', 'L', 'SB']);
// Identify is kept -- it names the flags Ace passes, and the bad ones are
// then driven round -- and given up only for one of these, known for what it
// is.
const ID_TRADE_FLAGS = new Set([...CAMP_FLAGS, 'SW', 'G', 'ST']);
// How far off a flag on the ground is worth a detour, as Roger's, and how
// much nearer another must be to be gone for instead of the one chosen.
const PICKUP_RANGE = 200;
const PICKUP_SWITCH_SHARE = 0.5;
const CAMP_CLEAR_RANGE = 150;
const CAMP_RESCORE_SECONDS = 3;
const CAMP_SPOT_COOLDOWN = 30;
const CAMP_AVOID_LIMIT = 2;
const CAMP_AVOID_WINDOW = 10;
const CAMP_ARRIVE = 4;
// How long a camp may go without a shot before it is given up, and for how
// long it then is.
const CAMP_IDLE_SECONDS = 8;
// How a spot is scored: each foe it can shoot counts `CAMP_FOE_WEIGHT`, each
// foe that can see it costs `CAMP_EXPOSURE_WEIGHT` -- half that from a spot
// above the foe, which is harder to hit -- each unit above the highest foe is
// worth `CAMP_HEIGHT_WEIGHT` (Guided Missile counts it double), each second of
// driving there costs `CAMP_TRAVEL_WEIGHT`, and with a laser the share of its
// reach the foes are away is worth `CAMP_LASER_RANGE_WEIGHT`.
const CAMP_FOE_WEIGHT = 10;
const CAMP_EXPOSURE_WEIGHT = 3;
const CAMP_ELEVATED_EXPOSURE = 0.5;
const CAMP_HEIGHT_WEIGHT = 0.5;
const CAMP_TRAVEL_WEIGHT = 1;
const CAMP_LASER_RANGE_WEIGHT = 10;
// How many scored spots the intent carries, for the debug overlay.
const CAMP_SHOWN_SPOTS = 12;
// Rabbit Chase: how near a hunter has to be before the rabbit runs from it,
// how far ahead the rabbit aims each time it picks somewhere to run to, how
// far it keeps from the world's edge doing so, and how fast a hunter has to
// be closing on it to count as coming for it rather than passing by.
const RABBIT_FLEE_RANGE = 200;
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
// Where Ace puts his own flag down: within this share of his base's radius
// of its middle, and no less than `HOME_DROP_MIN` across a small one.
const HOME_DROP_SHARE = 0.15;
const HOME_DROP_MIN = 4;
// How near Ace waits to a foe's spawn zone with every foe dead: within a
// shot, short of being in it.
const SPAWN_WATCH_RANGE = 60;

// Roger with bzo's improvements. Each override is one of Roger's decisions
// answered differently; everything else is Roger's.
export class Ace extends AceFighter {
  constructor(options = {}) {
    super(options);
    this.tuning = { ...ACE_TUNING, ...options.tuning };
    // What each flag slot is, as far as this pilot has seen: what it carried,
    // and what it saw anyone else carry. A superflag on the ground arrives with
    // its type hidden, so this is how a pilot that dropped a flag knows not to
    // drive straight back over it.
    this.knownFlagTypes = new Map();
    // Campers: the kills each foe made with a flag to camp with, newest last,
    // and the shots each has fired with the flag he holds now.
    this.campKills = new Map();
    this.seenKills = new Set();
    this.flagShots = new Map();
    this.camper = null;
    // Bank shots found for each foe's jump (`bankPlans`).
    this.bankCache = new Map();
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
    this.shedBurrow = false;
    this.drift = null;
    this.dropDriveUntil = -Infinity;
    this.lastTrace = null;
    this.extraReport = (stats) => `, routes ${stats.plans} (${stats.unreachable} none`
      + `${stats.safer ? `, ${stats.safer} round a covered jump` : ''}`
      + `${stats.waits ? `, ${stats.waits} frames waiting` : ''}),`
      + ` unsticks ${stats.unsticks}, held shots ${stats.held}, kept shots ${stats.kept}`;
    // The landing each airborne foe has been shot at for, as a clock time, and
    // how many shots it has had, so a jump costs the shots it takes to kill
    // (`shotsToKill`) and no more.
    this.landingShots = new Map();
    // The foe Ace has stopped a capture to fight, until it is out of reach.
    this.fightId = null;
    this.lastThinkAt = null;
    // Who has fired a shot that came near Ace, and until when that counts.
    this.shotAtBy = new Map();
    // The spot Ace is camping at, when it was scored, the dodges he has made
    // there, and the spots given up and until when.
    this.camp = null;
    this.badSpots = new Map();
    this.campOffUntil = -Infinity;
    this.campIdleSince = null;
    // When a shot last actually went out: Roger's `lastShot` moves for a shot
    // considered and then held.
    this.lastFiredAt = -Infinity;
    // When Ace last came out of a teleporter, and where he was last frame.
    this.lastTeleportAt = -Infinity;
    // The flag on the ground being fetched; the flag any mode is driving to
    // this frame, and the back-offs on the way to each, as a count and the
    // time of the last.
    this.pickupIndex = null;
    this.goalFlag = null;
    this.flagStrikes = new Map();
    this.lastAt = null;
    this.teleportBackingOff = false;
    // Flags let go of on purpose -- Oscillation Overthruster before a way up
    // -- and until when they are left where they fell.
    this.shedFlags = new Map();
  }

  // Ace sees everything the view holds -- every tank, every shot, wherever
  // it is. How fair a bot should play is a separate question, for later.
  think(view) {
    this.frameSeconds = this.lastThinkAt === null ? 0 : Math.max(0, view.now - this.lastThinkAt);
    this.lastThinkAt = view.now;
    this.goalFlag = null;
    if (view.self.inAir) this.airborneAt = view.now;
    this.flagZones = view.flagZones || null;
    this.noteFlagTypes(view);
    this.winning = this.isWinning(view);
    this.viewBases = view.bases;
    this.teamColor = view.self.teamColor;
    this.noteShooters(view);
    this.noteCampers(view);
    this.noteTeleport(view);
    this.heldFlag = view.self.flag;
    // Reverse Only drives backwards and nothing else: everything is decided
    // as if the tank faced the other way, and the speed it asks for then
    // drives it backwards along that. Its barrel still points the real way,
    // so it holds its fire rather than aim behind it.
    const reversed = view.self.flag === 'RO';
    const out = super.think(reversed
      ? { ...view, self: { ...view.self, azimuth: normalizeAngle(view.self.azimuth + Math.PI) } }
      : view);
    if (reversed) {
      out.speed = out.speed > 0 ? -out.speed : 0;
      out.fire = false;
      out.shotTargetId = null;
    }
    this.holdAirStick(view.self, out);
    if (out.fire) this.lastFiredAt = view.now;
    // A reason is why a tank was picked, so only while Ace is after one.
    if (!TARGET_MODES.has(out.intent.mode)) out.intent.reason = null;
    this.aimTriggerHappy(view, out);
    this.noteCampDodge(view, out);
    // Roger's chase jumps a building in the way without asking whether the
    // tank may jump.
    if (out.jump && !canTankJump(view.world, view.self.flag, view.self.z)) out.jump = false;
    this.oneWayTurn(view.self.flag, out);
    // Reversed Controls negates both sticks before the tank reads them
    // (`applyMotionInput`), so Ace asks for the opposite of what he wants.
    if (view.self.flag === 'RC') {
      out.speed = -out.speed;
      out.rotation = -out.rotation;
    }
    // A sticky flag does not answer the drop control (cmdDrop): only its shake
    // countdown, a kill or an antidote takes it off, and the countdown drops it
    // by itself. Asking anyway is refused every time.
    if (out.dropFlag && view.self.flag && getFlagEndurance(view.self.flag) === FLAG_ENDURANCE.STICKY) {
      out.dropFlag = false;
    }
    // A team flag is only ever let go of at home: Ace's own on his base,
    // where it is returned, or any one in a world with no base to take it to.
    // An enemy one is captured by reaching the base, not by dropping it.
    if (out.dropFlag && view.self.flagTeam !== null) {
      const base = view.myBase();
      const own = view.self.flagTeam === view.self.teamColor;
      const home = base && own && this.isHome(view.self, base);
      const overEnemy = own && (view.bases || []).some((b) => b.team !== view.self.teamColor && isOverBase(b, view.self));
      if (base && !home && !overEnemy) out.dropFlag = false;
    }
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
      if (!canSeeShot(me.flag, shot.flag)) continue;
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

  // Kills made with a flag to camp with, from the kill feed, and every shot
  // each foe has fired since he took the flag he holds: what a player keeps
  // count of. A flag changes hands, and the count starts again.
  noteCampers(view) {
    const me = view.self;
    for (const kill of view.kills || []) {
      const key = `${kill.at}:${kill.killerId}:${kill.victimId}`;
      if (this.seenKills.has(key)) continue;
      this.seenKills.add(key);
      if (!CAMP_FLAGS.has(kill.flag) || String(kill.killerId) === String(me.id)) continue;
      const onMe = String(kill.victimId) === String(me.id);
      const victim = view.players.find((p) => String(p.id) === String(kill.victimId));
      const onSide = onMe || (victim ? !view.isFoe(victim) : false);
      const list = this.campKills.get(String(kill.killerId)) || [];
      list.push({ at: kill.at, onMe, onSide });
      this.campKills.set(String(kill.killerId), list);
    }
    for (const [id, list] of this.campKills) {
      const kept = list.filter((k) => k.at > view.now - CAMPER_WINDOW_SECONDS);
      if (kept.length) this.campKills.set(id, kept);
      else this.campKills.delete(id);
    }
    if (this.seenKills.size > 500) this.seenKills.clear();
    for (const shot of view.fired || []) {
      const owner = view.players.find((p) => p.id === shot.ownerId);
      if (!owner || owner.flagIndex === null || owner.flagIndex === undefined) continue;
      let count = this.flagShots.get(owner.id);
      if (!count || count.flagIndex !== owner.flagIndex) {
        count = { flagIndex: owner.flagIndex, ids: new Set() };
        this.flagShots.set(owner.id, count);
      }
      count.ids.add(shot.id);
    }
    this.camper = this.findCamper(view);
  }

  // The foe camping on Ace, or null: one who has killed him
  // `CAMPER_KILLS` times lately with a flag to camp with, as a rogue -- with
  // no team's flags to weigh it against, that is enough -- and in team play
  // one who has killed that many of Ace's side and leads every other tank by
  // `CAMPER_LEAD`. With it, what he holds, what beats it, and whether its
  // shots are all but spent (`shotLimits`, counted as they are fired).
  findCamper(view) {
    const me = view.self;
    const rogue = me.team === 'rogue';
    let best = null;
    // Dead between kills he is still the camper: the flag that beats his is
    // as worth having while he waits to spawn.
    for (const p of view.players) {
      if (!view.isFoe(p)) continue;
      const kills = this.campKills.get(String(p.id));
      if (!kills) continue;
      const count = kills.filter((k) => (rogue ? k.onMe : k.onSide)).length;
      if (count < CAMPER_KILLS) continue;
      if (!rogue) {
        const others = [view.self, ...view.players.filter((q) => q !== p)]
          .map((q) => q.score).filter(Number.isFinite);
        if (!Number.isFinite(p.score) || (others.length && p.score - Math.max(...others) < CAMPER_LEAD)) continue;
      }
      if (best && count <= best.count) continue;
      const holding = CAMP_FLAGS.has(p.flag);
      const limit = holding ? view.world.shotLimits?.[p.flag] : undefined;
      const shots = this.flagShots.get(p.id);
      const used = shots && shots.flagIndex === p.flagIndex ? shots.ids.size : 0;
      const left = Number.isFinite(limit) ? Math.max(0, limit - used) : Infinity;
      const spent = left <= Math.max(CAMPER_SPENT_SHOTS, CAMPER_SPENT_SHARE * limit);
      best = { id: p.id, count, flag: holding ? p.flag : null, counter: CAMPER_COUNTERS[p.flag] ?? null, left, spent };
    }
    return best;
  }

  // Against a camper: hunt him while his flag has shots to spare or Ace holds
  // what beats it; with it all but spent, keep clear and let it run out --
  // he is an ordinary tank once it drops, and hunted then.
  camperStance(me) {
    const camper = this.camper;
    if (!camper) return null;
    if (camper.flag && camper.spent && me.flag !== camper.counter) return 'wait';
    return 'hunt';
  }

  // A foe that shot at Ace lately and is close to him or to where he is going.
  isRetaliationTarget(ctx, p) {
    if (!((this.shotAtBy.get(p.id) ?? -Infinity) > ctx.view.now)) return false;
    if (distance2D(ctx.me, p) < RETALIATE_RANGE) return true;
    const nodes = this.route?.nodes;
    if (!nodes) return false;
    return nodes.slice(this.route.at).some((node) => distance2D(node, p) < RETALIATE_RANGE);
  }

  // The foe whose score is `LEADER_LEAD` clear of every other tank's, if
  // any, and by how much.
  scoreLead(ctx) {
    const { view } = ctx;
    const scored = view.players.filter((p) => Number.isFinite(p.score));
    if (Number.isFinite(view.self.score)) scored.push(view.self);
    if (scored.length < 2) return null;
    scored.sort((a, b) => b.score - a.score);
    const [top, next] = scored;
    const lead = top.score - next.score;
    if (top === view.self || !view.isFoe(top) || lead < LEADER_LEAD) return null;
    return { top, lead };
  }

  scoreLeader(ctx) {
    return this.scoreLead(ctx)?.top ?? null;
  }

  // The leader, when `DOMINANT_LEAD` clear and in the game.
  dominantFoe(ctx) {
    const lead = this.scoreLead(ctx);
    if (!lead || lead.lead < DOMINANT_LEAD) return null;
    const foe = this.remotePlayers(ctx.view).find((p) => p.id === lead.top.id);
    return foe && foe.alive && !foe.paused ? foe : null;
  }

  // Ahead of every foe on score, and his team, where there are teams, ahead
  // of every other team.
  isWinning(view) {
    if (!Number.isFinite(view.self.score)) return false;
    const foes = view.players.filter((p) => Number.isFinite(p.score) && view.isFoe(p));
    if (foes.length === 0 || foes.some((p) => p.score >= view.self.score)) return false;
    const scores = view.teamScores || {};
    const mine = scores[view.self.team];
    return !Number.isFinite(mine)
      || Object.entries(scores).every(([team, score]) => team === view.self.team || score < mine);
  }

  // Whether Ace's own score is `LOSING_MARGIN` under his foes' average.
  isLosing(ctx) {
    const { view } = ctx;
    if (!Number.isFinite(view.self.score)) return false;
    const foes = view.players.filter((p) => Number.isFinite(p.score) && view.isFoe(p));
    if (foes.length === 0) return false;
    const average = foes.reduce((sum, p) => sum + p.score, 0) / foes.length;
    return view.self.score <= average - LOSING_MARGIN;
  }

  // A foe Ace could shoot now -- in sight, on his level -- within `range`.
  foeInSight(ctx, range) {
    const { view, me } = ctx;
    return this.remotePlayers(view).some((p) => p.alive && !p.paused && view.isFoe(p)
      && !(p.zoned && !me.zoned)
      && Math.abs(p.z - me.z) < 2 * view.world.tankHeight
      && distance2D(me, p) < range
      && !this.isObscured(ctx, { x: me.x, y: me.y, z: me.z + 1 }, { x: p.x, y: p.y, z: p.z + 1 }));
  }

  // A superflag on the ground within `range` that Ace, empty-handed, would
  // pick up.
  flagWithin(ctx, range) {
    const { view, me } = ctx;
    if (me.flag) return false;
    return view.flags.some((flag) => flag.onGround && flag.team === null && this.wantsGroundFlag(flag)
      && !((this.unreachable.get(flag.index) ?? -Infinity) > view.now)
      && distance2D(me, flag) < range);
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
    if (this.camper && p.id === this.camper.id) {
      return this.camperStance(ctx.me) === 'wait' ? CAMPER_WAIT_WEIGHT : DOMINANT_WEIGHT;
    }
    if (this.isRetaliationTarget(ctx, p)) weight *= RETALIATE_WEIGHT;
    if (p.id === ctx.leaderId) weight *= ctx.leaderLead >= DOMINANT_LEAD ? DOMINANT_WEIGHT : LEADER_WEIGHT;
    return weight;
  }

  findBestTarget(ctx, players) {
    if (this.isRabbit(ctx)) return this.rabbitTarget(ctx, players);
    const lead = this.scoreLead(ctx);
    ctx.leaderId = lead?.top.id ?? null;
    ctx.leaderLead = lead?.lead ?? 0;
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

  // What each flag slot is, from every type the view shows: a flag carried,
  // and one on the ground the view names -- Identify's answer, or what the
  // player Ace flies for has learned. A slot keeps its type while the flag
  // lies where it was last seen, or comes down after being seen carried; one
  // that turns up anywhere else has gone and come back as something new.
  noteFlagTypes(view) {
    const carried = (index, type) => {
      if (type && Number.isInteger(index)) this.knownFlagTypes.set(index, { type, at: null });
    };
    carried(view.self.flagIndex, view.self.flag);
    for (const player of view.players) carried(player.flagIndex, player.flag);
    for (const flag of view.flags) {
      if (!flag.onGround || flag.team !== null) continue;
      if (flag.type) {
        this.knownFlagTypes.set(flag.index, { type: flag.type, at: pointOf(flag) });
        continue;
      }
      const known = this.knownFlagTypes.get(flag.index);
      if (!known) continue;
      if (!known.at) known.at = pointOf(flag);
      else if (distance2D(known.at, flag) > 1) this.knownFlagTypes.delete(flag.index);
    }
  }

  // A type this pilot has learned is one it can refuse. Holding a flag to camp
  // with, he wants no other; holding Identify, only one worth trading it for.
  wantsGroundFlag(flag) {
    if (CAMP_FLAGS.has(this.heldFlag)) return false;
    if ((this.shedFlags.get(flag.index) ?? -Infinity) > this.lastThinkAt) return false;
    const type = this.knownType(flag);
    // What beats a camper's flag is worth having, whatever it has done for Ace
    // before, and worth trading Identify for.
    if (type && type === this.camper?.counter) return true;
    if (this.heldFlag === 'ID') return ID_TRADE_FLAGS.has(type);
    if (!type) return true;
    // Identify is worth going for only with nothing better to do: ahead of
    // every foe, and the team ahead of every other.
    if (type === 'ID') return this.winning;
    if (isBadFlag(type) || HARD_FLAGS.has(type)) return false;
    return this.isFlagUseful(type);
  }

  // A team flag goes home before anything is chased: Roger chases first, and a
  // chase that ends on an enemy base captures his own flag there, which kills
  // him and his team. Shooting is a separate step and still happens. And a foe
  // in the air is met where it will land rather than chased where it is.
  chasePlayer(ctx) {
    // A foe coming down on Ace's level within a shot's reach is a free kill,
    // and comes before everything but a dodge: flags, captures and a team
    // flag on its way home wait the second it takes.
    const landing = ctx.me.canFire ? this.ambushTarget(ctx, { level: true }) : null;
    if (landing) return this.ambush(ctx, landing);
    // Carrying a team flag, Ace stops only for a foe close enough to fight,
    // and otherwise takes it home.
    if (ctx.me.flagTeam !== null) {
      const foe = this.closeFoe(ctx);
      return foe ? this.fightClose(ctx, foe) : false;
    }
    if (this.antidoteTarget(ctx)) return false;
    // Whoever has Ace's flag comes before anything else, however far off.
    const carrier = this.ourFlagCarrier(ctx);
    if (carrier && distance2D(ctx.me, carrier) > ROGER_CHASE_RANGE) {
      ctx.out.intent.reason = 'ours-carrier';
      return this.huntFar(ctx, carrier);
    }
    // A camper is hunted wherever he is, unless his flag is all but spent.
    const camper = carrier || this.camperStance(ctx.me) !== 'hunt' ? null
      : this.remotePlayers(ctx.view).find((p) => p.id === this.camper.id && p.alive && !p.paused);
    if (camper && distance2D(ctx.me, camper) > ROGER_CHASE_RANGE) {
      ctx.out.intent.reason = 'camper';
      return this.huntFar(ctx, camper);
    }
    // A foe running away with the game is hunted wherever he is.
    const dominant = carrier ? null : this.dominantFoe(ctx);
    if (dominant && distance2D(ctx.me, dominant) > ROGER_CHASE_RANGE) {
      ctx.out.intent.reason = 'leader';
      return this.huntFar(ctx, dominant);
    }
    const losing = this.isLosing(ctx);
    // Holding a flag to camp with and with nobody near, the camp comes first.
    if (!carrier && CAMP_FLAGS.has(ctx.me.flag) && this.campClear(ctx)) return false;
    // A capture to make wins over a chase, except a foe close enough to be a
    // threat rather than a detour -- which he stands and fights. Losing, or
    // with a foe running away with the game, the chase wins.
    if (!carrier && !dominant && this.captureTarget(ctx)
      && !(losing && this.foeInSight(ctx, LOSING_FIGHT_RANGE))) {
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
      // Losing, Ace hunts the foe Roger chose and found too far, rather than
      // going after flags.
      const far = losing && !this.flagWithin(ctx, LOSING_FLAG_RANGE)
        ? this.remotePlayers(ctx.view).find((p) => p.id === ctx.out.targetId) : null;
      if (far && !far.airborne) {
        ctx.out.intent.reason = 'losing';
        return this.huntFar(ctx, far);
      }
    }
    const target = this.remotePlayers(ctx.view).find((p) => p.id === ctx.out.targetId);
    if (chased && target && ctx.me.flag === 'SW') return this.closeWithShockWave(ctx, target, 'chase');
    if (chased && target && !target.airborne) {
      if (this.chaseAround(ctx, target) || this.runOver(ctx, target)) return true;
      this.trackFoe(ctx, target);
      return chased;
    }
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
  // standing on, so he hardly ever makes a capture. Every capture is made on
  // the carrier's own base (playing.cxx:4110), so a tank without one -- a
  // rogue -- has none to make, and plays for kills instead.
  captureTarget(ctx) {
    const { view, me } = ctx;
    if (!view.world.teamFlags || me.flagTeam !== null) return null;
    if (me.flag && isBadFlag(me.flag)) return null;
    const base = view.myBase();
    if (!base) return null;
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

  lookForFlag(ctx) {
    // A team flag in hand goes home before any other flag is looked at.
    if (ctx.me.flagTeam !== null) return false;
    const antidote = this.antidoteTarget(ctx);
    if (antidote) return this.goTo(ctx, antidote, 'antidote');
    const target = this.captureTarget(ctx);
    if (!target) return CAMP_FLAGS.has(ctx.me.flag) ? false : this.pickUpFlag(ctx);
    const { me, out } = ctx;
    out.intent.mode = target.returning ? 'return' : 'capture';
    this.goalFlag = target.flag;
    out.intent.target = { ...target.pos, flag: target.flag.type ?? null };
    // One flag at a time: whatever is held goes when the team flag is in reach.
    if (target.dist < 10 && me.flag) out.dropFlag = true;
    if (typeof ctx.view.findRoute === 'function') {
      const route = this.routeTo(ctx, target.pos);
      if (route && this.followRoute(ctx, route)) return true;
      if (!route) {
        this.unreachable.set(target.flag.index, ctx.view.now + UNREACHABLE_SECONDS);
        return CAMP_FLAGS.has(me.flag) ? false : this.pickUpFlag(ctx);
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

  // A flag worth picking up nearby, on whatever level Ace can reach it.
  // Roger looks only at his own level, and with nothing there drives straight
  // at a team flag anywhere -- at a raised base, that is a wall. Team flags
  // are `captureTarget`'s.
  // Only empty-handed, or holding Identify: a good flag in hand is kept rather
  // than traded for the next one passed -- a bad one is shed on its own,
  // camping trades up for its own flags (`huntFlag`), and Identify for what
  // `wantsGroundFlag` allows. The flag chosen stays chosen while it
  // lies there, unless another is much nearer: a nearest-flag pick made
  // afresh each frame flips as the tank changes level, and a route up a lift
  // and back down again is the result.
  groundFlagTarget(ctx) {
    const { view, me } = ctx;
    if (me.flag && me.flag !== 'ID') return null;
    let best = null;
    let kept = null;
    for (const flag of view.flags) {
      if (!flag.onGround || flag.team !== null || !this.wantsGroundFlag(flag)) continue;
      if ((this.unreachable.get(flag.index) ?? -Infinity) > view.now) continue;
      let d = distance2D(me, flag);
      if (d >= PICKUP_RANGE) continue;
      if (this.isObscured(ctx, me, pointOf(flag))) d *= 1.25;
      if (this.camper?.counter && this.knownType(flag) === this.camper.counter) d *= CAMPER_COUNTER_PULL;
      if (flag.index === this.pickupIndex) kept = { flag, d };
      if (!best || d < best.d) best = { flag, d };
    }
    const chosen = kept && !(best.d < kept.d * PICKUP_SWITCH_SHARE) ? kept : best;
    this.pickupIndex = chosen?.flag.index ?? null;
    return chosen?.flag ?? null;
  }

  pickUpFlag(ctx) {
    const flag = this.groundFlagTarget(ctx);
    if (!flag) return false;
    const { me, out, view } = ctx;
    const pos = pointOf(flag);
    if (typeof view.findRoute === 'function' && !this.routeTo(ctx, pos)) {
      this.unreachable.set(flag.index, view.now + UNREACHABLE_SECONDS);
      return false;
    }
    if (me.flag && distance2D(me, pos) < 10) out.dropFlag = true;
    this.goalFlag = flag;
    this.goTo(ctx, pos, 'flag');
    out.intent.target = { ...pos, flag: flag.type ?? null };
    return true;
  }

  // Quiet enough to camp: nobody within `CAMP_CLEAR_RANGE`, nobody carrying
  // Ace's flag, and no foe running away with the score.
  campClear(ctx) {
    const { view, me } = ctx;
    if (this.ourFlagCarrier(ctx) || this.scoreLeader(ctx)) return false;
    return !this.remotePlayers(view).some((p) => p.alive && !p.paused && view.isFoe(p)
      && distance2D(me, p) < CAMP_CLEAR_RANGE);
  }

  // The nearest flag on the ground that might be one to camp with: any whose
  // type Ace has not seen yet, and any he knows is.
  campFlagTarget(ctx) {
    const { view, me } = ctx;
    let best = null;
    for (const flag of view.flags) {
      if (!flag.onGround || flag.team !== null) continue;
      if ((this.unreachable.get(flag.index) ?? -Infinity) > view.now) continue;
      const type = this.knownType(flag);
      if (type !== null && !CAMP_FLAGS.has(type)) continue;
      if (type === null && me.flag === 'ID') continue;
      const d = distance2D(me, flag);
      if (!best || d < best.d) best = { flag, d };
    }
    return best?.flag ?? null;
  }

  // To a flag that may be one to camp with, letting go of whatever else is
  // held once it is in reach.
  huntFlag(ctx, flag) {
    const { me, out } = ctx;
    if (me.flag && distance2D(me, flag) < 10) out.dropFlag = true;
    const pos = pointOf(flag);
    if (typeof ctx.view.findRoute === 'function' && !this.routeTo(ctx, pos)) {
      this.unreachable.set(flag.index, ctx.view.now + UNREACHABLE_SECONDS);
    }
    this.goalFlag = flag;
    return this.goTo(ctx, pos, 'hunt-flag');
  }

  // Holding a flag to camp with: to the best spot, then shooting from it.
  campAt(ctx) {
    const { view, me, out } = ctx;
    const now = view.now;
    for (const [key, until] of this.badSpots) if (until <= now) this.badSpots.delete(key);
    const flag = me.flag;
    if (!this.camp || this.camp.flag !== flag || now - this.camp.scoredAt >= CAMP_RESCORE_SECONDS) {
      const avoids = this.camp?.flag === flag ? this.camp.avoids : [];
      const scored = this.scoreVantages(ctx);
      const keep = this.camp?.spot && scored.find((s) => s.key === this.camp.spot.key);
      // The spot held unless another now scores clearly better.
      const spot = keep && scored[0] && scored[0].score < keep.score + CAMP_FOE_WEIGHT ? keep : (scored[0] ?? null);
      this.camp = { flag, spot, scored: scored.slice(0, CAMP_SHOWN_SPOTS), scoredAt: now, avoids: spot === keep ? avoids : [] };
    }
    const { spot } = this.camp;
    if (spot && this.swThreat(ctx, spot)) {
      this.abandonSpot(now);
      return this.campAt(ctx);
    }
    out.intent.reason = flag.toLowerCase();
    out.intent.vantages = this.camp.scored.map((s) => ({ x: s.x, y: s.y, z: s.z, score: s.score, chosen: s === spot }));
    if (spot && !(distance2D(me, spot) < CAMP_ARRIVE && Math.abs(me.z - spot.z) < 1)) {
      const route = typeof view.findRoute === 'function' ? this.routeTo(ctx, pointOf(spot)) : null;
      if (route === null && typeof view.findRoute === 'function') {
        this.abandonSpot(now);
        return this.campAt(ctx);
      }
      return this.goTo(ctx, pointOf(spot), 'camp');
    }
    // At the spot, or with none worth driving to: shoot from here. With no
    // spot and nobody to shoot, there is no camp to make.
    const target = this.campTarget(ctx);
    if (!spot && !target) return false;
    // Held without a shot for `CAMP_IDLE_SECONDS`, the camp is not working:
    // given up for as long, and Ace goes about the rest.
    if (now < this.campOffUntil) return false;
    // Kept on the pilot, not the camp: the camp is scored afresh every few
    // seconds, and a clock kept in it never ran long enough to matter.
    if (now - this.lastFiredAt < CAMP_IDLE_SECONDS) {
      this.campIdleSince = null;
    } else {
      this.campIdleSince ??= now;
      if (now - this.campIdleSince > CAMP_IDLE_SECONDS) {
        this.campOffUntil = now + CAMP_IDLE_SECONDS;
        this.campIdleSince = null;
        this.camp = null;
        return false;
      }
    }
    out.intent.mode = 'camp';
    out.speed = 0;
    if (!target) return true;
    out.targetId = target.id;
    out.intent.target = { ...pointOf(target), id: target.id };
    this.aimAt(ctx, azimuthTo(me, predict(target)));
    if (flag === 'L') out.speed = this.laserStandoffSpeed(ctx, Boolean(spot));
    return true;
  }

  // Every vantage point scored for the flag held, best first.
  scoreVantages(ctx) {
    return this.withMuzzleSight(ctx, () => this.scoreVantagesSighted(ctx));
  }

  scoreVantagesSighted(ctx) {
    const { view, me } = ctx;
    const foes = this.remotePlayers(view).filter((p) => p.alive && !p.paused && view.isFoe(p));
    if (foes.length === 0) return [];
    const reach = (me.shotSpeed ?? view.world.shotSpeed) * (me.shotLifetime ?? 3.5);
    const topFoe = Math.max(...foes.map((p) => p.z));
    const speed = view.world.tankSpeed || 25;
    const out = [];
    for (const v of view.vantages || []) {
      const key = `${v.x},${v.y},${v.z}`;
      if (this.badSpots.has(key)) continue;
      const eye = { x: v.x, y: v.y, z: v.z };
      let shootable = 0;
      let exposure = 0;
      let away = 0;
      for (const p of foes) {
        const d = Math.hypot(p.x - v.x, p.y - v.y, p.z - v.z);
        const seen = !this.isObscured(ctx, eye, p);
        if (seen) exposure += p.z + view.world.tankHeight < v.z ? CAMP_ELEVATED_EXPOSURE : 1;
        const level = me.flag === 'GM' || Math.abs(p.z - v.z) < 2 * view.world.tankHeight;
        if (d <= reach && level && (seen || me.flag === 'SB')) {
          shootable++;
          away += Math.min(1, d / reach);
        }
      }
      if (shootable === 0) continue;
      const height = Math.max(0, v.z - topFoe) * (me.flag === 'GM' ? 2 : 1);
      let score = (shootable * CAMP_FOE_WEIGHT) - (exposure * CAMP_EXPOSURE_WEIGHT)
        + (height * CAMP_HEIGHT_WEIGHT) - ((distance2D(me, v) / speed) * CAMP_TRAVEL_WEIGHT);
      if (me.flag === 'L') score += (away / shootable) * CAMP_LASER_RANGE_WEIGHT;
      out.push({ ...v, key, score });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  // Whom to shoot from the spot: with a laser the farthest foe in the clear,
  // which nobody else can reach; otherwise the nearest.
  campTarget(ctx) {
    return this.withMuzzleSight(ctx, () => this.campTargetSighted(ctx));
  }

  campTargetSighted(ctx) {
    const { view, me } = ctx;
    const reach = (me.shotSpeed ?? view.world.shotSpeed) * (me.shotLifetime ?? 3.5);
    let best = null;
    for (const p of this.remotePlayers(view)) {
      if (!p.alive || p.paused || !view.isFoe(p)) continue;
      const d = Math.hypot(p.x - me.x, p.y - me.y, p.z - me.z);
      if (d > reach) continue;
      // A shot flies level; only a Guided Missile climbs or dives to a foe.
      if (me.flag !== 'GM' && Math.abs(p.z - me.z) >= 2 * view.world.tankHeight) continue;
      if (me.flag !== 'SB' && this.isObscured(ctx, me, p)) continue;
      const better = me.flag === 'L' ? (!best || d > best.d) : (!best || d < best.d);
      if (better) best = { p, d };
    }
    return best?.p ?? null;
  }

  abandonSpot(now) {
    if (this.camp?.spot) this.badSpots.set(this.camp.spot.key, now + CAMP_SPOT_COOLDOWN);
    this.camp = null;
  }

  noteCampDodge(view, out) {
    const spot = this.camp?.spot;
    if (!spot || out.intent.mode !== 'dodge') return;
    if (distance2D(view.self, spot) > CAMP_ARRIVE * 2) return;
    const avoids = this.camp.avoids.filter((t) => view.now - t < CAMP_AVOID_WINDOW);
    if (avoids.length === 0 || view.now - avoids[avoids.length - 1] > 1) avoids.push(view.now);
    this.camp.avoids = avoids;
    if (avoids.length >= CAMP_AVOID_LIMIT) this.abandonSpot(view.now);
  }

  // Where Ace's own flag comes down if let go of over another team's base,
  // by the server's rule: the nearest of his team's safety zones, else the
  // world's centre, else his own base when an enemy base covers the centre.
  // A centre under water would send it home too; Ace does not count on that.
  overBaseLanding(ctx, from) {
    const { view, me } = ctx;
    let best = null;
    for (const zone of view.safetyZones || []) {
      if (!zone.teams.includes(me.teamColor)) continue;
      const d = Math.hypot(zone.x - from.x, zone.y - from.y, zone.z - from.z);
      if (!best || d < best.d) best = { d, pos: { x: zone.x, y: zone.y, z: zone.z } };
    }
    if (best) return best.pos;
    const centre = { x: 0, y: 0, z: 0 };
    const covered = (view.bases || []).some((b) => b.team !== me.teamColor && isOverBase(b, { ...centre, z: b.z }));
    return covered ? view.myBase() : centre;
  }

  // The enemy base to let Ace's own flag go over, when that sets it down
  // near home for a short drive rather than a long carry.
  dropOverBaseTarget(ctx) {
    const { view, me } = ctx;
    if (me.flagTeam === null || me.flagTeam !== me.teamColor) return null;
    const home = view.myBase();
    if (!home || distance2D(me, home) < OVER_BASE_MIN_HOME) return null;
    let base = null;
    let best = Infinity;
    const reach = Math.max(MAX_STEP_UP, this.jumpReach(ctx));
    for (const b of view.bases || []) {
      if (b.team === me.teamColor) continue;
      // Near it across, and up to its top from here: under a raised base is
      // not near it at all.
      if (b.z - me.z > reach) continue;
      const edge = distance2D(me, b) - Math.min(b.halfWidth, b.halfDepth);
      if (edge < OVER_BASE_RANGE && edge < best) {
        base = b;
        best = edge;
      }
    }
    if (!base) return null;
    const landing = this.overBaseLanding(ctx, base);
    if (!landing || distance2D(landing, home) > OVER_BASE_LANDING_RANGE) return null;
    const threat = this.remotePlayers(view).some((p) => p.alive && !p.paused && view.isFoe(p)
      && distance2D(me, p) < OVER_BASE_FOE_RANGE);
    return threat ? null : base;
  }

  // Carrying a team flag home, by the route there rather than straight at it.
  navigate(ctx) {
    const { view, me } = ctx;
    const overBase = this.dropOverBaseTarget(ctx);
    if (overBase) {
      if (isOverBase(overBase, me)) {
        ctx.out.intent.mode = 'drop-over';
        ctx.out.intent.target = pointOf(overBase);
        ctx.out.dropFlag = true;
        ctx.out.speed = 1;
        return true;
      }
      return this.goTo(ctx, { x: overBase.x, y: overBase.y, z: overBase.z }, 'drop-over');
    }
    if (me.flagTeam !== null && typeof view.findRoute === 'function') {
      const base = view.myBase();
      const pos = { x: me.x, y: me.y, z: me.z };
      // His own flag goes down near the middle of his base, driven over at
      // speed: not at the edge he came in by, where it would be the first
      // thing an enemy reaches and where he would leave it again.
      if (base && me.flagTeam === me.teamColor) {
        const centre = pointOf(base);
        const range = Math.max(HOME_DROP_MIN, (base.radius || 0) * HOME_DROP_SHARE);
        if (this.isHome(pos, base) && distance2D(me, centre) <= range) {
          ctx.out.intent.mode = 'home';
          ctx.out.intent.target = centre;
          ctx.out.rotation = normalizeAngle(azimuthTo(me, centre) - me.azimuth);
          ctx.out.speed = 1;
          ctx.out.dropFlag = true;
          return true;
        }
        return this.goTo(ctx, centre, 'home');
      }
      if (base) {
        ctx.out.intent.mode = 'home';
        ctx.out.intent.target = pointOf(base);
        const route = this.routeTo(ctx, pointOf(base));
        if (route && this.followRoute(ctx, route)) return true;
      }
    }
    // Holding what beats a camper's flag, he keeps it rather than trade it for
    // one to camp with himself.
    const countering = this.camper?.counter && me.flag === this.camper.counter;
    if (me.flagTeam === null && !this.isRabbit(ctx) && !countering && this.campClear(ctx)) {
      if (CAMP_FLAGS.has(me.flag) && this.campAt(ctx)) return true;
      const flag = this.campFlagTarget(ctx);
      if (flag) return this.huntFlag(ctx, flag);
    }
    this.camp = null;
    // Nothing nearer to do: the best foe, wherever it is. Wandering is for a
    // world with nobody to find.
    if (me.flagTeam === null && !this.isRabbit(ctx)) {
      const foe = this.findBestTarget(ctx, this.remotePlayers(view));
      if (foe) return this.huntFar(ctx, foe);
      if (this.watchSpawn(ctx)) return true;
    }
    return super.navigate(ctx);
  }

  // No foe to chase and one of them dead: where it comes back is a team
  // spawn zone that is not Ace's, so he waits within a shot of the nearest
  // one, facing it.
  watchSpawn(ctx) {
    const { view, me, out } = ctx;
    if (!this.remotePlayers(view).some((p) => view.isFoe(p) && !p.alive)) return false;
    let best = null;
    for (const zone of view.spawnZones || []) {
      if (zone.teams.includes(me.teamColor)) continue;
      const d = distance2D(me, zone);
      if (!best || d < best.d) best = { zone, d };
    }
    if (!best) return false;
    const { zone } = best;
    out.intent.mode = 'spawn-watch';
    out.intent.target = pointOf(zone);
    if (best.d > SPAWN_WATCH_RANGE) return this.goTo(ctx, zone, 'spawn-watch');
    this.aimAt(ctx, azimuthTo(me, zone));
    out.speed = 0;
    return true;
  }

  // Home is on the base.
  // On one of Ace's own team's bases, by its real footprint where the view
  // has the bases -- a base turned 45 degrees, as on hix, has corners well
  // outside the circle that fits inside it -- and by that circle where not.
  isHome(pos, base) {
    const own = (this.viewBases || []).filter((b) => b.team === this.teamColor);
    if (own.length > 0) return own.some((b) => isOverBase(b, { x: pos.x, y: pos.y, z: pos.z ?? b.z }));
    return distance2D(pos, base) <= base.radius;
  }
}

// Whether `pos` is over a base's footprint, at or above its top.
function isOverBase(base, pos) {
  if (pos.z < base.z - 0.5) return false;
  const dx = pos.x - base.x;
  const dy = pos.y - base.y;
  const cos = Math.cos(-base.rotation);
  const sin = Math.sin(-base.rotation);
  return Math.abs((dx * cos) - (dy * sin)) <= base.halfWidth && Math.abs((dx * sin) + (dy * cos)) <= base.halfDepth;
}

// The pilot used where nobody has chosen one: `9` with the Settings row on
// None, and a server's bots. Ace, the more capable; Roger is the reference.
export const DEFAULT_PILOT = 'ace';

// What the Settings row offers, in order, and the key each is chosen by.
export const AUTOPILOTS = Object.freeze([
  Object.freeze({ id: 'roger', name: 'Roger', Pilot: Roger }),
  Object.freeze({ id: 'ace', name: 'Ace', Pilot: Ace }),
]);
