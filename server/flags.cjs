/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Flag types, statuses, world constants, and the flight math. Mirrors BZFlag's
// include/Flag.h, src/common/Flag.cxx and src/bzfs/FlagInfo.cxx.
//
// The server computes a flight once, when the flag is thrown, and the client
// integrates it every frame from the same numbers -- so both sides must agree
// about the arc or a flag lands in one place and is drawn in another.

// Flag::FlagStatus. Where a flag is.
const FLAG_STATUS = Object.freeze({
  NO_EXIST: 0,
  ON_GROUND: 1,
  ON_TANK: 2,
  IN_AIR: 3,
  COMING: 4,
  GOING: 5,
});

// Flag::FlagEndurance. Whether the flag can be dropped, and what dropping does.
const FLAG_ENDURANCE = Object.freeze({
  NORMAL: 0,
  UNSTABLE: 1,
  STICKY: 2,
});

// Flag::FlagQuality.
const FLAG_QUALITY = Object.freeze({
  GOOD: 0,
  BAD: 1,
});

// global.cxx defaults. Locked BZDB variables upstream, so they are constants
// here too.
const FLAG_ALTITUDE = 11.0;
const FLAG_RADIUS = 2.5;
const FLAG_POLE_SIZE = 0.8;
const FLAG_POLE_WIDTH = 0.025;
// _flagHeight: the clearance a flag needs above its landing spot, not its
// drawn size. DropGeometry tests a cylinder this tall.
const FLAG_CLEARANCE = 10.0;
// _maxFlagGrabs: how many times a superflag may be picked up before it leaves
// the world instead of landing. FlagInfo.cxx:137 reads it on every grab, so a
// server may change it; this is upstream's global.cxx default. A sticky flag
// ignores it and always gets one grab.
// Player::updateFlagEffect (Player.cxx:733). A flag scales the tank's length and
// width -- never its height, which is why a Tiny tank is short and stubby rather
// than small, and an Obese one is wide rather than tall. `N` Narrow is the one
// that touches width alone, and its factor is a literal upstream rather than a
// BZDB variable.
const OBESE_FACTOR = 2.5;
const TINY_FACTOR = 0.4;
const NARROW_FACTOR = 0.001;
// _flagEffectTime: how long upstream takes to ease the scale from what it was to
// what the new flag asks for. bzo eases the *drawn* tank over this and nothing
// else: the collision and hit sizes are the target from the moment the flag
// changes hands, because a hitbox that disagrees with the server for two thirds
// of a second is worse than a tank that changes size faster than it looks like
// it should.
const FLAG_EFFECT_TIME = 0.64;
const MAX_FLAG_GRABS = 4;
// Upstream stores it in an int-valued BZDB var with no range of its own, so the
// only bound worth keeping is the one that makes it mean anything: a flag has to
// survive the grab that picks it up.
const MAX_FLAG_GRABS_MIN = 1;
const BASE_SIZE = 60.0;
// _shieldFlight. A Shield flag is thrown this many times higher than any other
// when it leaves a tank (FlagInfo.cxx:174), which is the second half of what the
// flag is worth: the hit costs you the flag, but the flag is still in the air
// while you drive back under it.
const SHIELD_FLIGHT = 2.7;

// _rFireAdVel, _rFireAdRate, _mGunAdVel, _mGunAdRate, _laserAdVel, _laserAdRate
// and _laserAdLife (global.cxx:80, :95, :128). A shot variant is three
// multipliers on the world's own shot: how fast it flies, how often it may be
// fired, and how long it lives. Rapid Fire and Machine Gun declare their life as
// the string "1.0 / <rate>" rather than as a number, so the reciprocal is the
// rule and not a coincidence -- the shot slot frees exactly as fast as the flag
// fires. Laser is the one that breaks it: a tenth of the life and half the rate,
// which is what makes it the shot you wait for.
const RAPID_FIRE_AD_VEL = 1.5;
const RAPID_FIRE_AD_RATE = 2.0;
const MACHINE_GUN_AD_VEL = 1.5;
const MACHINE_GUN_AD_RATE = 10.0;
const LASER_AD_VEL = 1000.0;
const LASER_AD_RATE = 0.5;
const LASER_AD_LIFE = 0.1;

// _shockAdLife, _shockInRadius and _shockOutRadius (global.cxx:132). A shock
// wave is the one shot with no path: it starts as a sphere around the tank that
// fired it and grows to `_shockOutRadius` over a fifth of a shot's life, killing
// everything it reaches on the way and stopping for none of them.
//
// `_shockInRadius` is declared as `_tankLength`, so it is upstream's 6.0 rather
// than anything bzo's smaller tank would give: the wave sweeps a distance
// through the world, as `BZFLAG_TANK_RADIUS` above does, so the figure transfers
// unchanged.
const SHOCK_AD_LIFE = 0.2;
const SHOCK_IN_RADIUS = 6.0;
const SHOCK_OUT_RADIUS = 60.0;

// _gmAdLife, _gmTurnAngle, _gmActivationTime and _lockOnAngle (global.cxx:66,
// :84). A guided missile is the world's own shell at the world's own speed and
// reload -- `GuidedMissileStrategy`'s constructor scales the lifetime and
// nothing else -- with one difference that is the whole flag: its heading is
// recomputed every step toward whichever tank the shooter has locked.
//
// `_gmTurnAngle` is a rate in radians a second, and it is spent on the
// missile's azimuth and its elevation *separately* (GuidedMissleStrategy.cxx:186
// and :195). A missile that has to come around and climb does both at once, and
// neither faster than this.
//
// `_gmActivationTime` gates hits rather than steering: the missile flies and
// turns from the muzzle, but nothing it touches in its first half second is hit
// (GuidedMissleStrategy.cxx:318). That is what stops a shot fired at a tank two
// lengths away from killing the tank that fired it as it comes around.
//
// `_lockOnAngle` is the cone the lock is picked from -- about 8.6 degrees,
// half of `TARGETING_ANGLE`'s 17.5 -- because pointing a missile at a tank is a
// larger claim than naming one.
const GM_AD_LIFE = 0.95;
const GM_TURN_ANGLE = 0.628319;
const GM_ACTIVATION_TIME = 0.5;
const LOCK_ON_ANGLE = 0.15;

// _srRadiusMult (global.cxx:146). Steamroller's reach, as a multiple of the
// roller's own radius on top of the victim's -- so the two tanks have to be
// nearly touching, which is the flag's own help text.
//
// Unlike the shock wave's radii this one is built from a tank rather than from
// the world, so it takes bzo's own tank radius and not BZFlag's: a bzo tank is
// half as wide, and a reach measured in tank radii has to shrink with it or
// Steamroller would kill from twice as far away as it looks.
const SR_RADIUS_MULT = 2.0;

// _velocityAd, _angularAd, _agilityAdVel, _agilityTimeWindow and
// _agilityVelDelta (global.cxx:18, :23, :176). Phase 5's three good flags, all
// of them multipliers on `LocalPlayer::setDesiredSpeed`'s `fracOfMaxSpeed` or
// `setDesiredAngVel`'s `fracOfMaxAngVel` -- so they scale the world's own tank
// speed and turn rate rather than replacing them, and a server that has tuned
// either keeps its tuning.
const VELOCITY_AD = 1.5;
const ANGULAR_AD = 1.5;
// Agility is the one with a clock. A sharp enough change in what the stick is
// asking for buys `_agilityAdVel` for `_agilityTimeWindow` seconds; "sharp
// enough" is a change of `_agilityVelDelta` in the requested fraction, halved
// when the new request is a reverse, because backing up is a smaller number to
// begin with.
const AGILITY_AD_VEL = 2.25;
const AGILITY_TIME_WINDOW = 1.0;
const AGILITY_VEL_DELTA = 0.3;

// Bouncy's two numbers, both literals in `LocalPlayer.cxx` rather than BZDB
// variables. A tank that has just landed waits `BOUNCE_DELAY` before it is
// thrown back up (:884), and each bounce is a random quarter-to-full of the
// world's own jump velocity (:1449) -- which is what makes it a stagger rather
// than a hop, and why it is a bad flag and not a second `JP`.
// -a <vel> <rot> (CmdLineOptions.cxx:602), which upstream itself calls inertia
// (bzfs.cxx:5395). An acceleration *limit* rather than an acceleration: larger
// is freer, and zero -- upstream's default, and bzo's -- means no limit at all,
// which is why a stock BZFlag tank reaches full speed in one frame. It reaches
// every client in the world settings packet, so it is a game style like ricochet
// rather than a client preference, and a map's `options` block may set it
// because upstream runs that block through the same parser as its command line.
//
// The linear figure is scaled by 20 and the angular one is not. That asymmetry
// is upstream's own (LocalPlayer.cxx:1549 against :1558) and is kept, because a
// number a server puts after `-a` has to mean the same thing in both games.
const LINEAR_ACCELERATION_SCALE = 20;

// _momentumLinAcc and _momentumAngAcc (global.cxx:92). Upstream *replaces* the
// world's limit with these while `M` is held, which has two odd consequences: on
// a world running `-a 1 1` the flag does nothing at all, and on anything
// heavier than that it is an upgrade.
//
// bzo composes the two instead, by adding their reciprocals the way two
// constraints on one quantity combine. On a world with no limit that reduces to
// upstream's own figure exactly; on a world that has one, `M` is always slower
// than the world and never faster. See `composeAccelerationLimit`.
const MOMENTUM_LIN_ACC = 1.0;
const MOMENTUM_ANG_ACC = 1.0;

const BOUNCE_DELAY = 0.2;
const BOUNCY_JUMP_MIN_FACTOR = 0.25;
const BOUNCY_JUMP_RANGE = 0.75;

// BZFlag's tank radius, deliberately not bzo's 2. The grab radius scales with
// the world rather than with the vehicle, as the sound reference distance in
// audio.js does: a bzo tank is half as wide as an upstream one, and building
// the radius from it would mean driving almost dead centre over a flag to take
// it. Tune this one figure if 6.82 plays badly.
const BZFLAG_TANK_RADIUS = 4.32;
const FLAG_GRAB_RADIUS = BZFLAG_TANK_RADIUS + FLAG_RADIUS;
// checkEnvironment() only grabs when the tank and the flag are on the same
// level, and rate-limits requests to five a second.
const FLAG_GRAB_LEVEL_TOLERANCE = 0.1;
const FLAG_GRAB_INTERVAL_MS = 200;

// bzfs.cxx:86. A vacated superflag slot refills on a halflife distribution.
const SUPER_FLAG_HALF_LIFE_SECONDS = 10.0;

// _identifyRange. How far the Identify flag reaches when it names the nearest
// flag on the ground (searchFlag, bzfs.cxx:3631).
const IDENTIFY_RANGE = 50.0;

// -st upstream, the shake timeout: how long a bad flag sticks before it falls
// off on its own. CmdLineOptions.cxx:1268 reads seconds and clamps them to this
// range, then stores tenths of a second, which is the resolution the client is
// told about -- so both sides quantize to a tenth and neither can be a fraction
// of a frame ahead of the other. Zero is the switch being off, which is
// upstream's default: a bad flag is then carried until it kills you.
const SHAKE_TIMEOUT_MIN_SECONDS = 0.1;
const SHAKE_TIMEOUT_MAX_SECONDS = 300.0;
// The client runs the countdown and asks the server to take the flag, exactly as
// upstream does (LocalPlayer.cxx:159). The server has to run the same clock or a
// modified client sheds a bad flag the moment it takes one, so it re-asks -- and
// allows this much slack, because the client's countdown is a sum of frame
// deltas and its request still has to cross the network. Lag only ever makes the
// request late, so the slack is for clock drift and nothing else.
const SHAKE_DROP_GRACE_SECONDS = 0.25;

// -sw upstream, the shake win count: how many kills it takes to shed a bad flag.
// CmdLineOptions.cxx:1288 clamps to this range; zero is the switch being off.
const SHAKE_WINS_MIN = 1;
const SHAKE_WINS_MAX = 20;

// -sa upstream, the antidote flag: a yellow flag dropped somewhere in the world
// that shakes a bad flag off when you drive onto it. `LocalPlayer::setFlag`
// (LocalPlayer.cxx:1668) picks the spot inside a square centred on the world,
// smaller on a CTF map so the flag does not land on somebody's base, and rejects
// a spot a tank could not stand in. It tries this many times before it gives up
// and takes what it has, which is upstream's own "if it takes this long, just
// screw it".
const ANTIDOTE_CTF_WORLD_FRACTION = 0.5;
const ANTIDOTE_PLACEMENT_ATTEMPTS = 100;
const ANTIDOTE_FLAG_COLOR = 0xffff00;

// Wings' four BZDB variables. All are Locked upstream, which means a server may
// set them and a client may not, so they are world configuration and reach the
// client with the rest of it -- they are not constants the way _flagRadius is.
// These are only the stock values.
//
// _wingsJumpCount is how many times a tank may leave a surface before it has to
// touch one again, refilled every tick it spends on the ground or on a building
// (LocalPlayer.cxx:328) and spent by the take-off as well as by each flap. At
// the stock 1 that is one jump and no flaps, which is why Wings is worth
// carrying for its air control rather than for its altitude; a server that wants
// tanks to actually fly raises it.
const DEFAULT_WINGS_JUMP_COUNT = 1;
// _wingsSlideTime. Zero means a wings tank takes the velocity its stick asks for
// outright; above zero it accelerates towards it over that many seconds, so
// flight carries momentum.
const DEFAULT_WINGS_SLIDE_TIME = 0.0;
// _wingsJumpVelocity and _wingsGravity have no stock values of their own: they
// are the strings "_jumpVelocity" and "_gravity", so unless a server sets them a
// wings jump rises and falls exactly as an ordinary one does.

// Every superflag is white; only team flags carry a colour (Flag.cxx:409). That
// is what makes hiding a superflag's identity free: an unidentified flag looks
// exactly like an identified one.
const SUPER_FLAG_COLOR = 0xffffff;
// A flag this client knows to be bad. Upstream has no such colour -- every
// superflag it draws is white, because upstream never lets you know which one
// you are looking at until you have it. bzo does let you know, so the one thing
// worth knowing at a glance gets a colour, and it is orange rather than the
// warning red the pickup alert wears: red is a team here, and a red flag over a
// red tank on a red scoreboard row says nothing. No team is orange.
const BAD_FLAG_COLOR = 0xffa020;

// Flag.cxx builds one FlagType per flag. This table is the whole of what bzo
// knows about flags: an abbreviation it does not carry is not a flag the server
// can hand out, is not offered by `superFlags.allowed`, and is not documented in
// the help panel, which is generated from here.
//
// Rows keep upstream's declaration order. `team` is a BZFlag colour index for a
// team flag and null for a superflag; resolve it to a colour through the `teams`
// pair, which is where team identity lives.
const TEAM_FLAG_HELP = "If it's yours, prevent other teams from taking it."
  + " If it's not take it to your base to capture it!";

const FLAG_TYPES = Object.freeze({
  'R*': Object.freeze({
    abbreviation: 'R*',
    name: 'Red Team',
    endurance: FLAG_ENDURANCE.NORMAL,
    quality: FLAG_QUALITY.GOOD,
    team: 1,
    help: TEAM_FLAG_HELP,
  }),
  'G*': Object.freeze({
    abbreviation: 'G*',
    name: 'Green Team',
    endurance: FLAG_ENDURANCE.NORMAL,
    quality: FLAG_QUALITY.GOOD,
    team: 2,
    help: TEAM_FLAG_HELP,
  }),
  'B*': Object.freeze({
    abbreviation: 'B*',
    name: 'Blue Team',
    endurance: FLAG_ENDURANCE.NORMAL,
    quality: FLAG_QUALITY.GOOD,
    team: 3,
    help: TEAM_FLAG_HELP,
  }),
  'P*': Object.freeze({
    abbreviation: 'P*',
    name: 'Purple Team',
    endurance: FLAG_ENDURANCE.NORMAL,
    quality: FLAG_QUALITY.GOOD,
    team: 4,
    help: TEAM_FLAG_HELP,
  }),
  F: Object.freeze({
    abbreviation: 'F',
    name: 'Rapid Fire',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'Shoots more often.  Shells go faster but not as far.',
  }),
  MG: Object.freeze({
    abbreviation: 'MG',
    name: 'Machine Gun',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'Very fast reload and very short range.',
  }),
  GM: Object.freeze({
    abbreviation: 'GM',
    name: 'Guided Missile',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'Shots track a target.  Lock on with right button.  Can lock on or'
      + ' retarget after firing.',
  }),
  L: Object.freeze({
    abbreviation: 'L',
    name: 'Laser',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'Shoots a laser.  Infinite speed and range but long reload time.',
  }),
  R: Object.freeze({
    abbreviation: 'R',
    name: 'Ricochet',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'Shots bounce off walls.  Don\'t shoot yourself!',
  }),
  SB: Object.freeze({
    abbreviation: 'SB',
    name: 'Super Bullet',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'Shoots through buildings.  Can kill Phantom Zone.',
  }),
  IB: Object.freeze({
    abbreviation: 'IB',
    name: 'Invisible Bullet',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'Your shots don\'t appear on other radars.  Can still see them out window.',
  }),
  SW: Object.freeze({
    abbreviation: 'SW',
    name: 'Shock Wave',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'Firing destroys all tanks nearby.  Don\'t kill teammates!'
      + '  Can kill tanks on/in buildings.',
  }),
  SH: Object.freeze({
    abbreviation: 'SH',
    name: 'Shield',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'Getting hit only drops flag.  Flag flies an extra-long time.',
  }),
  V: Object.freeze({
    abbreviation: 'V',
    name: 'High Speed',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'Tank moves faster.  Outrun bad guys.',
  }),
  QT: Object.freeze({
    abbreviation: 'QT',
    name: 'Quick Turn',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'Tank turns faster.  Good for dodging.',
  }),
  A: Object.freeze({
    abbreviation: 'A',
    name: 'Agility',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'Tank is quick and nimble making it easier to dodge.',
  }),
  SR: Object.freeze({
    abbreviation: 'SR',
    name: 'Steamroller',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'Destroys tanks you touch but you have to get really close.',
  }),
  G: Object.freeze({
    abbreviation: 'G',
    name: 'Genocide',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'Killing one tank kills that tank\'s whole team.',
  }),
  JP: Object.freeze({
    abbreviation: 'JP',
    name: 'Jumping',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'Tank can jump.  Use Tab key.  Can\'t steer in the air.',
  }),
  ID: Object.freeze({
    abbreviation: 'ID',
    name: 'Identify',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'Identifies type of nearest flag.',
  }),
  US: Object.freeze({
    abbreviation: 'US',
    name: 'Useless',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'You have found the useless flag. Use it wisely.',
  }),
  WG: Object.freeze({
    abbreviation: 'WG',
    name: 'Wings',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'Tank can drive in air.',
  }),
  T: Object.freeze({
    abbreviation: 'T',
    name: 'Tiny',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'Tank is small and can get through small openings.  Very hard to hit.',
  }),
  N: Object.freeze({
    abbreviation: 'N',
    name: 'Narrow',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'Tank is super thin.  Very hard to hit from front but is normal size'
      + ' from side.  Can get through small openings.',
  }),
  RC: Object.freeze({
    abbreviation: 'RC',
    name: 'ReverseControls',
    endurance: FLAG_ENDURANCE.STICKY,
    quality: FLAG_QUALITY.BAD,
    team: null,
    help: 'Tank driving controls are reversed.',
  }),
  FO: Object.freeze({
    abbreviation: 'FO',
    name: 'Forward Only',
    endurance: FLAG_ENDURANCE.STICKY,
    quality: FLAG_QUALITY.BAD,
    team: null,
    help: 'Can\'t drive in reverse.',
  }),
  RO: Object.freeze({
    abbreviation: 'RO',
    name: 'ReverseOnly',
    endurance: FLAG_ENDURANCE.STICKY,
    quality: FLAG_QUALITY.BAD,
    team: null,
    help: 'Can\'t drive forward.',
  }),
  LT: Object.freeze({
    abbreviation: 'LT',
    name: 'Left Turn Only',
    endurance: FLAG_ENDURANCE.STICKY,
    quality: FLAG_QUALITY.BAD,
    team: null,
    help: 'Can\'t turn right.',
  }),
  RT: Object.freeze({
    abbreviation: 'RT',
    name: 'Right Turn Only',
    endurance: FLAG_ENDURANCE.STICKY,
    quality: FLAG_QUALITY.BAD,
    team: null,
    help: 'Can\'t turn left.',
  }),
  BY: Object.freeze({
    abbreviation: 'BY',
    name: 'Bouncy',
    endurance: FLAG_ENDURANCE.STICKY,
    quality: FLAG_QUALITY.BAD,
    team: null,
    help: 'Tank can\'t stop bouncing.',
  }),
  TR: Object.freeze({
    abbreviation: 'TR',
    name: 'Trigger Happy',
    endurance: FLAG_ENDURANCE.STICKY,
    quality: FLAG_QUALITY.BAD,
    team: null,
    help: 'Tank can\'t stop firing.',
  }),
  M: Object.freeze({
    abbreviation: 'M',
    name: 'Momentum',
    endurance: FLAG_ENDURANCE.STICKY,
    quality: FLAG_QUALITY.BAD,
    team: null,
    help: 'Tank has inertia.  Acceleration is limited.',
  }),
  NJ: Object.freeze({
    abbreviation: 'NJ',
    name: 'No Jumping',
    endurance: FLAG_ENDURANCE.STICKY,
    quality: FLAG_QUALITY.BAD,
    team: null,
    help: 'Tank can\'t jump.',
  }),
  O: Object.freeze({
    abbreviation: 'O',
    name: 'Obesity',
    endurance: FLAG_ENDURANCE.STICKY,
    quality: FLAG_QUALITY.BAD,
    team: null,
    help: 'Tank becomes very large.  Can\'t fit through teleporters.',
  }),
  CB: Object.freeze({
    abbreviation: 'CB',
    name: 'Colorblindness',
    endurance: FLAG_ENDURANCE.STICKY,
    quality: FLAG_QUALITY.BAD,
    team: null,
    help: 'Can\'t tell team colors.  Don\'t shoot teammates!',
  }),
  B: Object.freeze({
    abbreviation: 'B',
    name: 'Blindness',
    endurance: FLAG_ENDURANCE.STICKY,
    quality: FLAG_QUALITY.BAD,
    team: null,
    help: 'Can\'t see out window.  Radar still works.',
  }),
  ST: Object.freeze({
    abbreviation: 'ST',
    name: 'Stealth',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'Tank is invisible on radar.  Shots are still visible.  Sneak up'
      + ' behind enemies!',
  }),
  CL: Object.freeze({
    abbreviation: 'CL',
    name: 'Cloaking',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'Tank is invisible out window.  Shots are still visible.  Sneak up'
      + ' behind enemies!',
  }),
  MQ: Object.freeze({
    abbreviation: 'MQ',
    name: 'Masquerade',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'In opponent\'s hud, you appear as a teammate.',
  }),
  SE: Object.freeze({
    abbreviation: 'SE',
    name: 'Seer',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'See stealthed, cloaked and masquerading tanks as normal.',
  }),
  JM: Object.freeze({
    abbreviation: 'JM',
    name: 'Jamming',
    endurance: FLAG_ENDURANCE.STICKY,
    quality: FLAG_QUALITY.BAD,
    team: null,
    help: 'Radar doesn\'t work.  Can still see.',
  }),
});

const FLAG_ABBREVIATIONS = Object.freeze(Object.keys(FLAG_TYPES));

function getFlagType(abbreviation) {
  return FLAG_TYPES[abbreviation] || null;
}

function isTeamFlag(abbreviation) {
  return getFlagTeamIndex(abbreviation) !== null;
}

// FlagInfo::addFlag, which reads the endurance off the FlagType rather than
// deriving it: upstream declares every bad flag FlagSticky and every good
// superflag FlagUnstable, and the table carries both fields, so ask the table.
// A slot with nothing in it yet is unstable, which is what an empty superflag
// slot is worth.
function getFlagEndurance(abbreviation) {
  const type = getFlagType(abbreviation);
  return type ? type.endurance : FLAG_ENDURANCE.UNSTABLE;
}

// LocalPlayer::doJump. Who may leave a surface, and who may do it again without
// touching one first. Wings never consults the world switch -- a flap is a flap,
// whatever the map says about jumping -- and it is the only flag that answers
// true while the tank is already in the air. No Jumping is the other end of the
// same switch: it refuses on a world that allows jumping, which is the whole of
// what the flag does, and upstream forbids it on a world that does not.
function canJump(abbreviation, allowJumping, airborne, flapsLeft) {
  if (abbreviation === 'WG') return flapsLeft > 0;
  if (airborne) return false;
  if (abbreviation === 'NJ') return false;
  // "else if ((flag != Flags::Bouncy) && ..." (LocalPlayer.cxx:1425). Bouncy is
  // out of the gate entirely: it bounces on a world that forbids jumping, which
  // is most of what makes it a punishment rather than a second `JP`.
  if (abbreviation === 'BY') return true;
  return allowJumping || abbreviation === 'JP';
}

// CmdLineOptions.cxx:1268. Seconds in, seconds out, clamped and rounded to the
// tenth upstream sends on the wire. Anything that is not a positive number is
// the switch being off.
function normalizeShakeTimeout(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const clamped = Math.min(SHAKE_TIMEOUT_MAX_SECONDS, Math.max(SHAKE_TIMEOUT_MIN_SECONDS, value));
  return Math.round(clamped * 10) / 10;
}

// CmdLineOptions.cxx:1288. A whole number of kills, clamped, and zero for off.
function normalizeShakeWins(count) {
  const value = Math.floor(Number(count));
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(SHAKE_WINS_MAX, Math.max(SHAKE_WINS_MIN, value));
}

// _maxFlagGrabs, from `server.json`'s `maxFlagGrabs` or a map's
// `-set _maxFlagGrabs`. Upstream evaluates the variable as an int, so a
// fractional value truncates; anything that is not a usable count falls back to
// the default rather than to zero, because zero would take a flag out of the
// world on the grab that found it.
// Player::updateFlagEffect's dimension targets, as scale factors on the tank's
// own length and width. Upstream sets both from one factor for `T` and `O` and
// touches only the width for `N`, so this returns the pair rather than a single
// number. Every other flag, and no flag at all, is the tank's own size.
function getTankDimensionScale(abbreviation) {
  switch (abbreviation) {
    case 'O': return { length: OBESE_FACTOR, width: OBESE_FACTOR };
    case 'T': return { length: TINY_FACTOR, width: TINY_FACTOR };
    case 'N': return { length: 1, width: NARROW_FACTOR };
    default: return { length: 1, width: 1 };
  }
}

// Phase 13, per-viewer visibility. Four flags that only ever disagree with each
// other, so they are read as a set rather than one at a time: `ST` hides a tank
// from the radar, `CL` hides it from the window, `MQ` makes it wear the viewer's
// own colours, and `SE` defeats all three.
//
// The asking side matters. `ST`, `CL` and `MQ` are read off the tank being
// *looked at*; `SE` is read off the tank doing the looking. That split is why
// upstream passes `seerView` down into every draw call rather than testing a
// flag where the tank is drawn.
function hidesFromRadar(abbreviation) {
  return abbreviation === 'ST';
}

function cloaksTheTank(abbreviation) {
  return abbreviation === 'CL';
}

function fakesTeamColor(abbreviation) {
  return abbreviation === 'MQ';
}

function seesThroughDisguises(abbreviation) {
  return abbreviation === 'SE';
}

// Player::updateFlagEffect's alpha target (Player.cxx:769), eased over the same
// _flagEffectTime the dimensions use: a cloaking tank fades out rather than
// blinking out, and fades back when the flag goes. Nothing else changes alpha.
function getTankAlphaTarget(abbreviation) {
  return cloaksTheTank(abbreviation) ? 0 : 1;
}

// What a viewer holding `SE` sees a cloaked tank at. Upstream restores
// `teleAlpha` (Player.cxx:912), which is 1 for a tank that is not mid-teleport,
// so Seer sees a cloaked tank solid rather than faint -- "as normal", in the
// flag's own words, not "as a ghost".
const SEER_REVEAL_ALPHA = 1;

// Whether a tank is drawn at all, and how solid. `alpha` is the eased value, so
// a tank part-way into its cloak is part-way transparent; only a fully faded one
// disappears, which is upstream's `cloaked && !seerView` test (Player.cxx:899).
function getVisibleTankAlpha(abbreviation, alpha, viewerFlag) {
  if (seesThroughDisguises(viewerFlag)) return SEER_REVEAL_ALPHA;
  if (cloaksTheTank(abbreviation) && alpha <= 0) return 0;
  return alpha;
}

// The three flags that change nothing about the world and everything about what
// the carrier can see of it. Upstream honours all three entirely on the carrier's
// own client -- there is no packet and no server rule -- so bzo does too, and a
// modified client that ignored them would only be cheating itself out of a
// penalty it is carrying.
//
// `B` Blindness blanks the view and leaves the radar (SceneRenderer::setBlank,
// playing.cxx:6212). `JM` Jamming does the reverse, replacing the radar with
// noise (RadarRenderer::setJammed, playing.cxx:1464). `CB` Colorblindness paints
// every *other* tank, its shots and its blip in the rogue colour
// (RadarRenderer.cxx:133 and playing.cxx:6168), so teams cannot be read off
// anything in the world.
function blanksTheView(abbreviation) {
  return abbreviation === 'B';
}

function jamsTheRadar(abbreviation) {
  return abbreviation === 'JM';
}

function hidesTeamColors(abbreviation) {
  return abbreviation === 'CB';
}

// RadarRenderer::render (RadarRenderer.cxx:433). A jammed radar is noise on most
// frames and the real thing on a few, and `decay` is the chance of a good one.
// It starts at 0.01 and the noise branch leaves it there, so roughly one frame in
// a hundred breaks through; that frame sets decay to 1, which guarantees a second
// good frame, and it then halves per frame until noise takes over again. The
// result is a readable burst every second or two rather than an even flicker.
const RADAR_JAM_DECAY_MIN = 0.01;
const RADAR_JAM_DECAY_FLOOR = 0.015;

// Returns the decay to carry into the next frame, given this frame's roll.
function getNextRadarJamDecay(decay, showedNoise) {
  if (showedNoise) return decay > RADAR_JAM_DECAY_FLOOR ? decay * 0.5 : decay;
  return decay <= RADAR_JAM_DECAY_FLOOR ? 1.0 : decay * 0.5;
}

// Player::getRadius (Player.cxx:204), carrying upstream's own note: "this
// encompasses everything but Narrow -- the Obese, Tiny, and Thief flags adjust
// the radius, but Narrow does not." The hit sphere follows the *length* scale,
// which is exactly the axis Narrow leaves alone, so a narrow tank keeps a
// full-size sphere and would be no harder to hit at all. That is why
// SegmentedShotStrategy::checkHit gives Narrow a shape of its own.
function getTankHitRadiusScale(abbreviation) {
  return getTankDimensionScale(abbreviation).length;
}

// SegmentedShotStrategy::checkHit (SegmentedShotStrategy.cxx:262). A shot meets
// a sphere around every tank but a narrow one, which gets an oriented box --
// and the box is only as wide as the shell, never as wide as the tank, in
// upstream's own words: "width of box is shell radius so you can actually hit
// narrow tank head on". At the tank's real narrow width the box would be
// unhittable from the front rather than hard to hit, which is a different flag.
function usesNarrowHitBox(abbreviation) {
  return abbreviation === 'N';
}

// The eased scale a tank is *drawn* at, `elapsed` seconds after its flag last
// changed. Upstream's rate is `(target - scale) / FlagEffectTime`, which takes
// exactly FlagEffectTime to arrive whatever it started from, so the ease is a
// straight interpolation from the scale in hand to the one the flag asks for.
function getTankDimensionEase(fromScale, targetScale, elapsedSeconds) {
  if (!(elapsedSeconds >= 0)) return targetScale;
  if (elapsedSeconds >= FLAG_EFFECT_TIME) return targetScale;
  const t = elapsedSeconds / FLAG_EFFECT_TIME;
  return fromScale + ((targetScale - fromScale) * t);
}

function normalizeFlagGrabs(count) {
  const value = Math.floor(Number(count));
  if (!Number.isFinite(value)) return MAX_FLAG_GRABS;
  return Math.max(MAX_FLAG_GRABS_MIN, value);
}

// LocalPlayer::setFlag's antidote square. Upstream picks x and y inside it and
// leaves z at 0, so this answers one coordinate and is called twice. `random` is
// passed in rather than called here so the pair stays pure and the test can pin
// it.
function getAntidoteCoordinate(worldSize, baseSize, ctf, random) {
  const span = ctf
    ? ANTIDOTE_CTF_WORLD_FRACTION * worldSize
    : worldSize - baseSize;
  return span * (random - 0.5);
}

// Whether a sticky flag has been held long enough to fall off. The client counts
// down from the timeout and sends the drop; this is what the server asks of the
// request before it agrees, and what the client asks before it bothers to send.
function canShakeFlag(abbreviation, shakeTimeout, heldSeconds) {
  if (getFlagEndurance(abbreviation) !== FLAG_ENDURANCE.STICKY) return false;
  const timeout = normalizeShakeTimeout(shakeTimeout);
  if (timeout === 0) return false;
  return heldSeconds >= timeout - SHAKE_DROP_GRACE_SECONDS;
}

// LocalPlayer::doUpdateMotion. Wings is the one flag that drives and steers off
// the ground; every other tank keeps the velocity it took off with until it
// lands.
function hasAirControl(abbreviation) {
  return abbreviation === 'WG';
}

// SegmentedShotStrategy's constructors, and bzfs's GetShotLifetime
// (GameKeeper.cxx:401): what the firing flag does to the shot. The three factors
// scale the world's `_shotSpeed`, its reload interval and its shot lifetime; the
// three booleans are the rules that are not numbers.
//
// `beam` is a shot with no travel left to simulate. At `_laserAdVel` 1000 the
// shell is 1666 units downrange after one simulation step -- further than any
// bzo world is wide -- so the whole path is traced when the trigger is pulled
// and the shot is a stationary line for the rest of its life, which is also how
// upstream draws its laser: along the segment list makeSegments built at once.
//
// `throughBuildings` is upstream's `Through` obstacle effect, and it is why Super
// Bullet does not bounce even where the world bounces everything -- makeSegments
// promotes `Stop` to `Reflect` and never touches `Through`.
//
// `hiddenOnRadar` keeps a shot off every radar but its owner's
// (RadarRenderer.cxx:664, against :585, which draws your own shots whatever they
// are).
//
// `shockwave` is a shot with no path at all rather than one already at the end of
// it. It never leaves the tank that fired it; what travels is its radius. Nothing
// stops it -- `ShockWaveStrategy::isStoppedByHit` returns false -- so it kills
// every tank it swells past instead of the first one, and it asks nothing about
// the geometry in between.
//
// `guided` is a shot whose heading is not fixed at the muzzle: every simulation
// step turns it toward whatever its shooter has locked, at `GM_TURN_ANGLE`. It
// is the one variant whose path both ends have to integrate rather than
// extrapolate, which is why `steerGuidedShot` below is shared rather than the
// server's alone.
//
// `activationTime` is how long a shot flies before it may hit anything. Only a
// guided missile has one, and `_gmActivationTime` is why: a missile turning back
// toward a target beside its shooter would otherwise kill the shooter.
//
// `fireSound` is the sample the shot is announced with. Upstream switches on the
// flag rather than playing SFX_FIRE for everything (playing.cxx:2956), and Laser
// is the first flag bzo has that takes a sound of its own.
const DEFAULT_SHOT_EFFECTS = Object.freeze({
  velocityFactor: 1,
  rateFactor: 1,
  lifeFactor: 1,
  beam: false,
  shockwave: false,
  guided: false,
  activationTime: 0,
  throughBuildings: false,
  hiddenOnRadar: false,
  fireSound: 'fire',
});

const SHOT_EFFECTS = Object.freeze({
  F: Object.freeze({
    ...DEFAULT_SHOT_EFFECTS,
    velocityFactor: RAPID_FIRE_AD_VEL,
    rateFactor: RAPID_FIRE_AD_RATE,
    lifeFactor: 1 / RAPID_FIRE_AD_RATE,
  }),
  MG: Object.freeze({
    ...DEFAULT_SHOT_EFFECTS,
    velocityFactor: MACHINE_GUN_AD_VEL,
    rateFactor: MACHINE_GUN_AD_RATE,
    lifeFactor: 1 / MACHINE_GUN_AD_RATE,
  }),
  L: Object.freeze({
    ...DEFAULT_SHOT_EFFECTS,
    velocityFactor: LASER_AD_VEL,
    rateFactor: LASER_AD_RATE,
    lifeFactor: LASER_AD_LIFE,
    beam: true,
    fireSound: 'laser',
  }),
  // GuidedMissileStrategy's constructor scales the lifetime and touches nothing
  // else: it never calls `setReloadTime`, and it leaves the shell at the world's
  // own speed. Everything that makes the flag is in the heading.
  GM: Object.freeze({
    ...DEFAULT_SHOT_EFFECTS,
    lifeFactor: GM_AD_LIFE,
    guided: true,
    activationTime: GM_ACTIVATION_TIME,
    fireSound: 'missile',
  }),
  SB: Object.freeze({
    ...DEFAULT_SHOT_EFFECTS,
    throughBuildings: true,
  }),
  IB: Object.freeze({
    ...DEFAULT_SHOT_EFFECTS,
    hiddenOnRadar: true,
  }),
  // ShockWaveStrategy's constructor shortens the shot and leaves the reload
  // alone: unlike every other variant it never calls `setReloadTime`, so a shock
  // wave comes round on the world's own interval however briefly each one lives.
  SW: Object.freeze({
    ...DEFAULT_SHOT_EFFECTS,
    lifeFactor: SHOCK_AD_LIFE,
    shockwave: true,
    fireSound: 'shock',
  }),
});

function getShotEffects(abbreviation) {
  return SHOT_EFFECTS[abbreviation] || DEFAULT_SHOT_EFFECTS;
}

// ShockWaveStrategy::update. The radius is a straight lerp from `_shockInRadius`
// to `_shockOutRadius` across the shot's whole life -- which is already the
// shortened one, because the constructor scales `lifetime` before anything reads
// it -- and the strategy expires the shot the moment the wave is full size. Both
// ends run this: the server to decide who it reached, the client to decide how
// big to draw it.
function getShockWaveRadius(elapsed, lifetimeSeconds) {
  if (!(lifetimeSeconds > 0)) return SHOCK_OUT_RADIUS;
  const t = Math.min(1, Math.max(0, elapsed / lifetimeSeconds));
  return SHOCK_IN_RADIUS + ((SHOCK_OUT_RADIUS - SHOCK_IN_RADIUS) * t);
}

// The same function's fade, 0.75 down to 0.25 as the wave grows.
//
// This is upstream's *low* quality shock wave, and deliberately so. Its default
// one inverts the colour of everything inside the sphere with `glLogicOp` and
// draws the team-coloured surface over the inversion (SphereSceneNode.cxx:386),
// and WebGL has no logic op to invert with -- so the variant bzo can actually
// draw is the one upstream falls back to, a plain translucent sphere that fades
// as it swells. See "Fewer options than BZFlag": bzo picks one of upstream's own
// variants rather than inventing a third.
function getShockWaveAlpha(radius) {
  const span = SHOCK_OUT_RADIUS - SHOCK_IN_RADIUS;
  const frac = Math.min(1, Math.max(0, (radius - SHOCK_IN_RADIUS) / span));
  return 0.75 - (0.5 * frac);
}

// GuidedMissileStrategy::update (GuidedMissleStrategy.cxx:170). One simulation
// step of a missile's heading: decompose the direction it is flying into an
// azimuth and an elevation, turn each of them toward the aim point by at most
// `turnAngle * seconds`, and compose a direction back out. Both ends run it --
// the server to decide where the missile is, each client to draw it there --
// which is why it is here and not in `server.js`.
//
// The angles are bzo's, not upstream's: at azimuth 0 a tank and its shots face
// -Z, and a positive azimuth turns left, exactly as `playerRotation` does. The
// arithmetic is upstream's unchanged.
//
// `to` is the aim point rather than the target's position, because "right
// between the eyes" is the caller's question: upstream adds the target's own
// muzzle height, and a bzo tank has as many muzzle heights as it has models.
// A null `to` is a missile with nothing locked, which flies straight.
function steerGuidedShot(direction, from, to, turnAngle, seconds) {
  const length = Math.hypot(direction.x, direction.y ?? 0, direction.z);
  if (!(length > 0)) return { x: 0, y: 0, z: -1 };
  const dir = {
    x: direction.x / length,
    y: (direction.y ?? 0) / length,
    z: direction.z / length,
  };
  if (!to || !(turnAngle > 0) || !(seconds > 0)) return dir;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const ground = Math.hypot(dx, dz);

  const maxDelta = turnAngle * seconds;
  // A target directly overhead has no bearing to turn toward, so the missile
  // keeps the one it has and climbs. Upstream's atan2f(0, 0) answers zero here,
  // which would swing the missile to due north instead.
  const azimuth = ground > 1e-6
    ? turnTowardAngle(Math.atan2(-dir.x, -dir.z), Math.atan2(-dx, -dz), maxDelta)
    : Math.atan2(-dir.x, -dir.z);
  const elevation = turnTowardAngle(
    Math.atan2(dir.y, Math.hypot(dir.x, dir.z)),
    Math.atan2(dy, ground),
    maxDelta,
  );

  const cosElevation = Math.cos(elevation);
  return {
    x: -Math.sin(azimuth) * cosElevation,
    y: Math.sin(elevation),
    z: -Math.cos(azimuth) * cosElevation,
  };
}

// limitAngle() (GuidedMissleStrategy.cxx:27), and the three-branch turn each of
// the two angles takes: snap to the target when it is within reach this step,
// otherwise move the whole step toward it.
function limitAngle(angle) {
  if (angle < -Math.PI) return angle + (2 * Math.PI);
  if (angle >= Math.PI) return angle - (2 * Math.PI);
  return angle;
}

function turnTowardAngle(current, desired, maxDelta) {
  const delta = limitAngle(desired - current);
  if (Math.abs(delta) <= maxDelta) return limitAngle(desired);
  return limitAngle(current + (delta > 0 ? maxDelta : -maxDelta));
}

// _targetingAngle (global.cxx:158), compared against |sin| of the angle off
// forward -- about 17.5 degrees.
const TARGETING_ANGLE = 0.3;

// setTarget() (playing.cxx:4390): whoever is centred in the sights. It answers
// two questions with one cone -- an observer naming the tank it is looking at,
// at `TARGETING_ANGLE`, and a tank locking a guided missile onto one, at the
// tighter `LOCK_ON_ANGLE` -- so both ends need it and the caller brings the
// angle. The nearest candidate inside the cone wins, and anything behind the
// eye is ignored.
//
// Candidates are `{id, x, z}`; who is eligible is the caller's question too,
// because the two callers disagree about it: a lock refuses a stealthed or
// paused tank where a look does not.
function pickTargetInSights(eye, forward, candidates, sineLimit) {
  const length = Math.hypot(forward.x, forward.z);
  if (!(length > 0) || !Array.isArray(candidates)) return null;
  const fx = forward.x / length;
  const fz = forward.z / length;

  let bestId = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const dx = candidate.x - eye.x;
    const dz = candidate.z - eye.z;
    // The camera frame: distance along the heading, and offset across it.
    const ahead = (dx * fx) + (dz * fz);
    if (ahead < 0) continue;
    const lateral = (dx * fz) - (dz * fx);
    const distance = Math.hypot(ahead, lateral);
    if (distance <= 0) continue;
    if (Math.abs(lateral) / distance >= sineLimit) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestId = candidate.id;
    }
  }
  return bestId;
}

// SegmentedShotStrategy::makeSegments. A shot that would stop at a wall
// reflects off it instead when the world says every shot ricochets, and the
// Ricochet flag makes one that reflects whatever the world says. With the world
// switch on the flag has nothing left to offer, which is why the server forbids
// it there. A shot that goes through buildings never meets one to bounce off.
//
// A guided missile never bounces either, on any world: the ricochet switch is
// read by `makeSegments`, and `GuidedMissileStrategy::checkBuildings` has no
// path through it -- the missile explodes on the first building it reaches.
function shotRicochets(abbreviation, allShotsRicochet) {
  const effects = getShotEffects(abbreviation);
  if (effects.throughBuildings || effects.guided) return false;
  return allShotsRicochet === true || abbreviation === 'R';
}

// LocalPlayer::setDesiredSpeed (LocalPlayer.cxx:1100) and setDesiredAngVel
// (:1147): what the firing flag does to a shot, `getShotEffects` above does for
// shots, and this does for the tank itself. Two multipliers on the world's own
// tank speed and turn rate, and one boolean for the rule that is not a number.
//
// bzo reports `fs` and `rs` as fractions of the world's *base* speed and turn
// rate, so a boosted tank sends a fraction above 1 and the server extrapolates
// it at face value with no flag state to keep. That is what `getMaxSpeedFactor`
// below is for: the server needs the bound, not the instant.
const DEFAULT_MOTION_EFFECTS = Object.freeze({
  speedFactor: 1,
  angVelFactor: 1,
  agility: false,
  reverseControls: false,
  forwardOnly: false,
  reverseOnly: false,
  leftTurnOnly: false,
  rightTurnOnly: false,
  bouncy: false,
  triggerHappy: false,
  momentum: false,
});

const MOTION_EFFECTS = Object.freeze({
  V: Object.freeze({ ...DEFAULT_MOTION_EFFECTS, speedFactor: VELOCITY_AD }),
  QT: Object.freeze({ ...DEFAULT_MOTION_EFFECTS, angVelFactor: ANGULAR_AD }),
  A: Object.freeze({ ...DEFAULT_MOTION_EFFECTS, agility: true }),
  RC: Object.freeze({ ...DEFAULT_MOTION_EFFECTS, reverseControls: true }),
  FO: Object.freeze({ ...DEFAULT_MOTION_EFFECTS, forwardOnly: true }),
  RO: Object.freeze({ ...DEFAULT_MOTION_EFFECTS, reverseOnly: true }),
  LT: Object.freeze({ ...DEFAULT_MOTION_EFFECTS, leftTurnOnly: true }),
  RT: Object.freeze({ ...DEFAULT_MOTION_EFFECTS, rightTurnOnly: true }),
  M: Object.freeze({ ...DEFAULT_MOTION_EFFECTS, momentum: true }),
  BY: Object.freeze({ ...DEFAULT_MOTION_EFFECTS, bouncy: true }),
  TR: Object.freeze({ ...DEFAULT_MOTION_EFFECTS, triggerHappy: true }),
});

function getMotionEffects(abbreviation) {
  return MOTION_EFFECTS[abbreviation] || DEFAULT_MOTION_EFFECTS;
}

// The fastest a flag can ever move a tank, and the quickest it can ever turn
// one. The client asks what its speed is *now*; the server asks only how far the
// answer could go, because the bound is all a hit test and a drift threshold
// need and a bound costs no state. Agility's boost is the whole of its top
// speed -- outside the window it is an ordinary tank.
function getMaxSpeedFactor(abbreviation) {
  const effects = getMotionEffects(abbreviation);
  return effects.agility ? AGILITY_AD_VEL : effects.speedFactor;
}

function getMaxAngVelFactor(abbreviation) {
  return getMotionEffects(abbreviation).angVelFactor;
}

// Two acceleration limits acting on the same tank, composed. A limit is a
// ceiling on how fast a velocity may change, so two of them acting together are
// two constraints on one quantity: their reciprocals add, as they do for springs
// in series or resistors in parallel. Zero means "no limit", so it contributes
// nothing to the sum and the other limit stands alone.
//
// That is the one place bzo does not copy upstream here, and it is deliberate.
// Upstream substitutes -- `linearAcc = M ? _momentumLinAcc : world` -- so `M` is
// a handicap only on a world with less inertia than the flag carries. Composing
// makes it a handicap everywhere, which is what a bad flag is for, and on a
// world with no inertia at all it gives upstream's number unchanged.
function composeAccelerationLimit(worldLimit, flagLimit) {
  const world = Number.isFinite(worldLimit) && worldLimit > 0 ? worldLimit : 0;
  if (!(flagLimit > 0)) return world;
  if (world <= 0) return flagLimit;
  return 1 / ((1 / world) + (1 / flagLimit));
}

// What may actually limit this tank, in real units: units per second squared and
// radians per second squared. Zero is no limit, and is what both ends read as
// "the tank reaches whatever it was asked for this frame".
function getAccelerationLimits(abbreviation, worldLinear, worldAngular) {
  const momentum = getMotionEffects(abbreviation).momentum;
  const linear = composeAccelerationLimit(worldLinear, momentum ? MOMENTUM_LIN_ACC : 0);
  const angular = composeAccelerationLimit(worldAngular, momentum ? MOMENTUM_ANG_ACC : 0);
  return {
    linear: linear > 0 ? linear * LINEAR_ACCELERATION_SCALE : 0,
    angular,
  };
}

// doMomentum's clamp itself (LocalPlayer.cxx:1546): how far a velocity may move
// towards what the stick asked for, over one step. Both ends run this -- the
// client to drive the tank and the server to check it -- which is the whole
// point of it being here.
function applyAccelerationLimit(previous, desired, limit, seconds) {
  if (!(limit > 0) || !(seconds > 0)) return desired;
  const step = limit * seconds;
  if (desired > previous + step) return previous + step;
  if (desired < previous - step) return previous - step;
  return desired;
}

// The five flags that clamp the stick rather than scaling the tank, in the order
// upstream applies them: `ReverseControls` is negated where the input is
// gathered (playing.cxx:983 for the keyboard, :1021 for the mouse), and the four
// "only" flags are clamped afterwards in `setDesiredSpeed` (:1111) and
// `setDesiredAngVel` (:1157). A tank carries one flag, so the two stages never
// actually meet -- the order is upstream's and kept because it is free to keep.
//
// Signs are bzo's own and happen to agree with upstream's: positive forward is
// forwards, and positive turn is left (`TURN_KEYS` maps `KeyA` to +1), which is
// why `LT` clamps the negative side and `RT` the positive.
//
// Client-side, as upstream has it. The server does not re-derive these: `fs` and
// `rs` are measured from the resolved displacement, so a tank sliding along a
// wall legitimately reports a sign it never asked for, and a server clamp would
// rubber-band an honest `FO` tank scraping backwards off a corner.
function applyMotionInput(abbreviation, forward, turn) {
  const effects = getMotionEffects(abbreviation);
  let clampedForward = effects.reverseControls ? -forward : forward;
  let clampedTurn = effects.reverseControls ? -turn : turn;
  if (effects.forwardOnly && clampedForward < 0) clampedForward = 0;
  if (effects.reverseOnly && clampedForward > 0) clampedForward = 0;
  if (effects.leftTurnOnly && clampedTurn < 0) clampedTurn = 0;
  if (effects.rightTurnOnly && clampedTurn > 0) clampedTurn = 0;
  return { forward: clampedForward, turn: clampedTurn };
}

// doUpdateMotion's bounce (LocalPlayer.cxx:877). A Bouncy tank on a surface is
// thrown back up the moment its landing delay expires, and the delay is set by
// the landing itself -- so the frame it arrives buys `BOUNCE_DELAY` and every
// frame after that is a jump waiting to happen.
//
// Takes and returns `bounceReadyAt` for the same reason `getSpeedFactor` takes
// and returns `agilityStartedAt`: the rule stays here and the caller only
// remembers the answer.
function getBounceState(abbreviation, grounded, wasAirborne, bounceReadyAt, now) {
  if (!getMotionEffects(abbreviation).bouncy || !grounded) return { jump: false, bounceReadyAt };
  if (wasAirborne) return { jump: false, bounceReadyAt: now + BOUNCE_DELAY };
  return { jump: now > bounceReadyAt, bounceReadyAt };
}

// doJump's Bouncy branch (LocalPlayer.cxx:1447): a random quarter-to-full of the
// world's jump velocity, so no two bounces are the same height. `random` is
// passed in rather than drawn here, to keep this pure and testable.
function getBouncyJumpVelocity(jumpVelocity, random) {
  return (BOUNCY_JUMP_MIN_FACTOR + (random * BOUNCY_JUMP_RANGE)) * jumpVelocity;
}

// playing.cxx:7345. Trigger Happy fires every frame whether or not the trigger
// is held, and `firingStatus` is Ready however long the reload has left
// (LocalPlayer.cxx:847) -- so a free shot slot is the only thing it waits for,
// which is the same rule the server already holds every shot to.
function firesContinuously(abbreviation) {
  return getMotionEffects(abbreviation).triggerHappy;
}

// setDesiredSpeed's agility branch, which is the only motion rule with a clock.
// While the window is open everything is boosted and the window does not extend;
// outside it, a change of more than `_agilityVelDelta` in the requested fraction
// opens a new one.
//
// **The change is measured against the previous stick, and that is deliberately
// not what upstream does.** Upstream measures against the previous
// `desiredSpeed` fraction -- which may itself already be boosted -- and clamps
// that to [-0.5, 1] before comparing. Hold a partial stick somewhere around 0.4
// to 0.7 and the clamp invents a change that never happened: 0.5 boosts to
// 1.125, clamps to 1.0, and next frame |0.5 - 1.0| clears the 0.3 limit, so the
// boost re-triggers for as long as the stick is held. An upstream Agility tank
// holding half forward sits at 28 units a second indefinitely -- faster than
// anybody at full throttle -- without ever moving the stick.
//
// That is a bug rather than a rule: Agility rewards *changing* direction, and
// holding still is not changing. It is invisible upstream because a keyboard
// stick is only ever 0 or +/-1, where both readings agree exactly. bzo has
// analog input everywhere -- touch, gamepad, XR -- so half stick would outweigh
// full stick for most of its players, which is the wrong way round.
//
// The [-0.5, 1] clamp below is kept because it is upstream's shape and costs
// nothing; with a raw stick going in, it never bites.
//
// Returns the factor and the window's start, so the caller carries no rule of
// its own -- give it back the `agilityStartedAt` it gets, and the state machine
// is this function.
function getSpeedFactor(abbreviation, previousFraction, requestedFraction, agilityStartedAt, now) {
  const effects = getMotionEffects(abbreviation);
  if (!effects.agility) return { factor: effects.speedFactor, agilityStartedAt };
  if ((now - agilityStartedAt) < AGILITY_TIME_WINDOW) {
    return { factor: AGILITY_AD_VEL, agilityStartedAt };
  }
  const oldFraction = Math.max(-0.5, Math.min(1, previousFraction));
  // "if (fracOfMaxSpeed < 0.0f) limit /= 2.0f" -- a reverse is half the change.
  const limit = requestedFraction < 0 ? AGILITY_VEL_DELTA / 2 : AGILITY_VEL_DELTA;
  if (Math.abs(requestedFraction - oldFraction) > limit) {
    return { factor: AGILITY_AD_VEL, agilityStartedAt: now };
  }
  return { factor: 1, agilityStartedAt };
}

// checkEnvironment's squish loop (playing.cxx:4198): the flag that kills by
// touch rather than by shot. It is the only rule in the game that runs off
// nothing but where two tanks are, which is why it needs a sweep of its own
// rather than a hook on something that was already happening.
//
// `BU` Burrow is upstream's other half of the same loop -- a burrowed tank is
// squashed by anyone alive, flag or no flag -- and arrives with that flag.
function crushesOnContact(abbreviation) {
  return abbreviation === 'SR';
}

// The reach, in upstream's own terms: the victim's radius plus `_srRadiusMult`
// of the roller's. Each is scaled by whatever the tank's flag does to its size,
// because upstream reads both off `Player::getRadius`, which is the length
// scale on the tank radius -- so a Tiny tank is harder to run over and easier
// to run over things with.
function getRunOverRadius(victimFlag, rollerFlag, tankRadius) {
  return (tankRadius * getTankHitRadiusScale(victimFlag))
    + (SR_RADIUS_MULT * tankRadius * getTankHitRadiusScale(rollerFlag));
}

// And the distance it is compared against, which is not the plain one: upstream
// weighs the vertical separation double, so a tank a storey above you is twice
// as far away as the same gap along the ground and cannot be squashed through a
// roof. (Upstream calls the result `distSquared` and compares it to an unsquared
// radius; the name is wrong and the comparison is right.)
function getRunOverSeparation(dx, dy, dz) {
  return Math.hypot(dx, dz, dy * 2);
}

// playing.cxx:2658. Killing one tank kills every tank on its team. Upstream
// gates it on `World::allowTeams()` -- "geno only works in team games :)" -- and
// on the dead tank's team not being rogue, since rogues are a team only in name.
function killsWholeTeam(abbreviation) {
  return abbreviation === 'G';
}

// gotBlowedUp (playing.cxx:3919). Shield is the one flag that answers a shot
// with something other than a death: the tank lives and gives up the flag
// instead. Only a shot -- upstream tests the reason as well as the flag, so
// being run over, caught by a capture or genocided kills a shielded tank like
// anyone else.
function shieldsAgainstShot(abbreviation) {
  return abbreviation === 'SH';
}

// LocalPlayer::doJump's vertical component. A flap relaunches a tank that is on
// its way up only if it is climbing slower than the flap would, and a falling
// one is slowed rather than relaunched -- so flapping late in a dive costs you
// most of what the flap was worth.
function getWingsJumpVelocity(wingsJumpVelocity, verticalVelocity) {
  if (verticalVelocity < 0) return wingsJumpVelocity + verticalVelocity;
  return Math.max(wingsJumpVelocity, verticalVelocity);
}

// LocalPlayer::doSlideMotion, which a wings tank flies through when
// _wingsSlideTime is above zero. The stick adds to the velocity rather than
// replacing it, and the result is held at maxSpeed -- a tank already over that,
// from a flap taken at speed, is bled back towards it over the same slide time
// rather than snapped to it. Heading is bzo's, where forward is (-sin, -cos).
function getWingsSlideVelocity(
  velocityX, velocityZ, heading, desiredSpeed, maxSpeed, slideTime, deltaTime
) {
  const scale = deltaTime / slideTime;
  const speedAdjustment = desiredSpeed * scale;
  let x = velocityX - (Math.sin(heading) * speedAdjustment);
  let z = velocityZ - (Math.cos(heading) * speedAdjustment);
  const newSpeed = Math.hypot(x, z);
  if (newSpeed > maxSpeed) {
    const oldSpeed = Math.hypot(velocityX, velocityZ);
    const adjustedSpeed = oldSpeed > maxSpeed
      ? Math.max(0, oldSpeed - (maxSpeed * scale))
      : maxSpeed;
    const speedScale = adjustedSpeed / newSpeed;
    x *= speedScale;
    z *= speedScale;
  }
  return { x, z };
}

// The BZFlag colour index of a team flag, or null for a superflag or for a flag
// whose identity is still hidden.
function getFlagTeamIndex(abbreviation) {
  const type = getFlagType(abbreviation);
  return type && type.team ? type.team : null;
}

// What a client has learned about a slot's identity. bzfs reveals a superflag's
// type only while somebody is carrying it, so `flag.type` drops back to null
// the moment it is dropped -- but the flag is the same flag, and a player who
// saw what it was still knows. Identify feeds this too.
//
// `known` is a Map from flag index to abbreviation. The index is a *slot*, not a
// flag, so a slot that empties or takes a flag flying in has to be forgotten:
// its next identity is a fresh roll, and keeping the old one would label a new
// Useless as the Identify that stood there before it.
function rememberFlagIdentity(known, index, type, status) {
  if (status === FLAG_STATUS.NO_EXIST || status === FLAG_STATUS.COMING) {
    known.delete(index);
    return;
  }
  if (type) known.set(index, type);
}

// The abbreviation to label a flag with, or null for one this client has no
// business knowing. A carried flag names itself; anything else is whatever was
// learned while its identity was visible. A team flag is never hidden, so it
// always answers.
function getKnownFlagAbbreviation(known, flag) {
  if (!flag) return null;
  return flag.type || known.get(flag.index) || null;
}

// Whether a flag is one of the penalties. The quality is on the table already;
// this is the question the colours and the alerts actually ask of it.
function isBadFlag(abbreviation) {
  return getFlagType(abbreviation)?.quality === FLAG_QUALITY.BAD;
}

function getTeamFlagAbbreviation(colorIndex) {
  for (const type of Object.values(FLAG_TYPES)) {
    if (type.team === colorIndex) return type.abbreviation;
  }
  return null;
}

// FlagInfo::dropFlag's thrownAltitude. Every flag is thrown _flagAltitude high
// except Shield, which goes _shieldFlight times that and so stays up
// sqrt(_shieldFlight) ~ 1.64 times as long. A flag flying *in* never asks this:
// addFlag settles its arc before it picks a type (FlagInfo.cxx:116), so a Shield
// arrives like anything else and only leaves differently.
function getFlagThrownAltitude(abbreviation) {
  return abbreviation === 'SH' ? SHIELD_FLIGHT * FLAG_ALTITUDE : FLAG_ALTITUDE;
}

// FlagInfo::addFlag and FlagInfo::dropFlag both derive the flight from one
// thrown altitude. Upstream's downTime repeats upTime rather than using the
// landing altitude (FlagInfo.cxx:170), so the flight always lasts
// 2 * sqrt(2 * altitude / gravity) however far the flag has to fall; the height
// curve below is a lerp between the two altitudes plus this parabola, so it
// still arrives in the right place. `gravity` is bzo's positive magnitude where
// upstream's is negative.
function computeFlagFlight(thrownAltitude, gravity) {
  const upTime = Math.sqrt(2 * thrownAltitude / gravity);
  return {
    flightEnd: 2 * upTime,
    initialVelocity: gravity * upTime,
  };
}

// The parabola a thrown flag follows, relative to the interpolated altitude.
function getFlagFlightHeight(elapsed, initialVelocity, gravity) {
  return elapsed * (initialVelocity - 0.5 * gravity * elapsed);
}

// Where a Coming or Going flag hangs while it fades. Equals the thrown altitude
// exactly, which is what the apex of the parabola above reaches.
function getFlagHoverHeight(flightEnd, initialVelocity, gravity) {
  return 0.5 * flightEnd * (initialVelocity - 0.25 * gravity * flightEnd);
}

function lerp(from, to, t) {
  return ((1 - t) * from) + (t * to);
}

// World::updateFlag. Returns where the flag is now, how opaque it is, and how
// big its warp is, for a flag `elapsed` seconds into its current status. A
// status that does not move returns its stored position untouched.
//
// `landed` reports that the flight is over: the client uses it to settle the
// flag, the server to decide when to send the next update.
function getFlagFlightState(flag, elapsed, gravity) {
  const position = flag.position;
  const landing = flag.landingPosition;
  const launch = flag.launchPosition;
  const flightEnd = flag.flightEnd;
  const done = elapsed >= flightEnd;

  if (flag.status === FLAG_STATUS.IN_AIR) {
    if (done) {
      return { x: landing.x, y: landing.y, z: landing.z, alpha: 1, warp: 0, landed: true };
    }
    const t = elapsed / flightEnd;
    return {
      x: lerp(launch.x, landing.x, t),
      y: lerp(launch.y, landing.y, t) + getFlagFlightHeight(elapsed, flag.initialVelocity, gravity),
      z: lerp(launch.z, landing.z, t),
      alpha: 1,
      warp: 0,
      landed: false,
    };
  }

  // A Coming or Going flag never travels: it hovers over its landing spot and
  // rises or falls through the second or first half of the flight. Upstream
  // settles a Coming flag at z = 0 rather than at its landing altitude
  // (World.cxx:772); bzo uses the landing altitude, which is the same point
  // wherever a flag can currently spawn and stays right if that changes.
  const hover = getFlagHoverHeight(flightEnd, flag.initialVelocity, gravity);
  const quarter = 0.25 * flightEnd;
  const half = 0.5 * flightEnd;

  if (flag.status === FLAG_STATUS.COMING) {
    if (done) {
      return { x: landing.x, y: landing.y, z: landing.z, alpha: 1, warp: 0, landed: true };
    }
    if (elapsed >= half) {
      // Falling out of the hover.
      const y = landing.y + getFlagFlightHeight(elapsed, flag.initialVelocity, gravity);
      return { x: landing.x, y, z: landing.z, alpha: 1, warp: 0, landed: false };
    }
    // Hovering: the cloth fades in over the first quarter while the warp grows,
    // then the warp shrinks away over the second.
    const y = landing.y + hover;
    if (elapsed >= quarter) {
      const t = (elapsed - quarter) / quarter;
      return { x: landing.x, y, z: landing.z, alpha: 1, warp: 1 - t, landed: false };
    }
    const t = elapsed / quarter;
    return { x: landing.x, y, z: landing.z, alpha: t, warp: t, landed: false };
  }

  if (flag.status === FLAG_STATUS.GOING) {
    if (done) {
      return { x: landing.x, y: landing.y, z: landing.z, alpha: 0, warp: 0, landed: true };
    }
    if (elapsed < half) {
      // Rising into the hover.
      const y = landing.y + getFlagFlightHeight(elapsed, flag.initialVelocity, gravity);
      return { x: landing.x, y, z: landing.z, alpha: 1, warp: 0, landed: false };
    }
    // Hovering: the warp grows over the third quarter, then the cloth fades out
    // with it over the fourth.
    const y = landing.y + hover;
    if (elapsed < (3 * quarter)) {
      const t = ((3 * quarter) - elapsed) / quarter;
      return { x: landing.x, y, z: landing.z, alpha: 1, warp: 1 - t, landed: false };
    }
    const t = (flightEnd - elapsed) / quarter;
    return { x: landing.x, y, z: landing.z, alpha: t, warp: t, landed: false };
  }

  return { x: position.x, y: position.y, z: position.z, alpha: 1, warp: 0, landed: false };
}
module.exports = {
  FLAG_STATUS,
  FLAG_ENDURANCE,
  FLAG_QUALITY,
  FLAG_ALTITUDE,
  FLAG_RADIUS,
  FLAG_POLE_SIZE,
  FLAG_POLE_WIDTH,
  FLAG_CLEARANCE,
  FLAG_EFFECT_TIME,
  RADAR_JAM_DECAY_FLOOR,
  SEER_REVEAL_ALPHA,
  RADAR_JAM_DECAY_MIN,
  MAX_FLAG_GRABS,
  MAX_FLAG_GRABS_MIN,
  NARROW_FACTOR,
  OBESE_FACTOR,
  TINY_FACTOR,
  BASE_SIZE,
  SHIELD_FLIGHT,
  RAPID_FIRE_AD_VEL,
  RAPID_FIRE_AD_RATE,
  MACHINE_GUN_AD_VEL,
  MACHINE_GUN_AD_RATE,
  LASER_AD_VEL,
  LASER_AD_RATE,
  LASER_AD_LIFE,
  SHOCK_AD_LIFE,
  SHOCK_IN_RADIUS,
  SHOCK_OUT_RADIUS,
  SR_RADIUS_MULT,
  VELOCITY_AD,
  ANGULAR_AD,
  AGILITY_AD_VEL,
  AGILITY_TIME_WINDOW,
  AGILITY_VEL_DELTA,
  LINEAR_ACCELERATION_SCALE,
  MOMENTUM_LIN_ACC,
  MOMENTUM_ANG_ACC,
  BOUNCE_DELAY,
  BOUNCY_JUMP_MIN_FACTOR,
  BOUNCY_JUMP_RANGE,
  BZFLAG_TANK_RADIUS,
  FLAG_GRAB_RADIUS,
  FLAG_GRAB_LEVEL_TOLERANCE,
  FLAG_GRAB_INTERVAL_MS,
  SUPER_FLAG_HALF_LIFE_SECONDS,
  IDENTIFY_RANGE,
  SHAKE_TIMEOUT_MIN_SECONDS,
  SHAKE_TIMEOUT_MAX_SECONDS,
  SHAKE_DROP_GRACE_SECONDS,
  SHAKE_WINS_MIN,
  SHAKE_WINS_MAX,
  ANTIDOTE_CTF_WORLD_FRACTION,
  ANTIDOTE_PLACEMENT_ATTEMPTS,
  ANTIDOTE_FLAG_COLOR,
  DEFAULT_WINGS_JUMP_COUNT,
  DEFAULT_WINGS_SLIDE_TIME,
  SUPER_FLAG_COLOR,
  BAD_FLAG_COLOR,
  FLAG_TYPES,
  FLAG_ABBREVIATIONS,
  getFlagType,
  isTeamFlag,
  getFlagEndurance,
  canJump,
  normalizeShakeTimeout,
  blanksTheView,
  cloaksTheTank,
  fakesTeamColor,
  getNextRadarJamDecay,
  getTankAlphaTarget,
  getTankDimensionEase,
  getTankDimensionScale,
  getTankHitRadiusScale,
  normalizeFlagGrabs,
  normalizeShakeWins,
  getAntidoteCoordinate,
  canShakeFlag,
  hasAirControl,
  getWingsJumpVelocity,
  getWingsSlideVelocity,
  getFlagTeamIndex,
  getKnownFlagAbbreviation,
  getVisibleTankAlpha,
  hidesFromRadar,
  hidesTeamColors,
  isBadFlag,
  jamsTheRadar,
  seesThroughDisguises,
  usesNarrowHitBox,
  getTeamFlagAbbreviation,
  rememberFlagIdentity,
  computeFlagFlight,
  getFlagFlightHeight,
  getFlagHoverHeight,
  getFlagFlightState,
  getShotEffects,
  getShockWaveRadius,
  getShockWaveAlpha,
  shotRicochets,
  shieldsAgainstShot,
  getMotionEffects,
  getMaxSpeedFactor,
  getMaxAngVelFactor,
  getSpeedFactor,
  composeAccelerationLimit,
  getAccelerationLimits,
  applyAccelerationLimit,
  applyMotionInput,
  getBounceState,
  getBouncyJumpVelocity,
  firesContinuously,
  crushesOnContact,
  killsWholeTeam,
  getRunOverRadius,
  getRunOverSeparation,
  getFlagThrownAltitude,
  GM_AD_LIFE,
  GM_TURN_ANGLE,
  GM_ACTIVATION_TIME,
  LOCK_ON_ANGLE,
  steerGuidedShot,
  TARGETING_ANGLE,
  pickTargetInSights,
};
