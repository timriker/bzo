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
export const FLAG_STATUS = Object.freeze({
  NO_EXIST: 0,
  ON_GROUND: 1,
  ON_TANK: 2,
  IN_AIR: 3,
  COMING: 4,
  GOING: 5,
});

// Flag::FlagEndurance. Whether the flag can be dropped, and what dropping does.
export const FLAG_ENDURANCE = Object.freeze({
  NORMAL: 0,
  UNSTABLE: 1,
  STICKY: 2,
});

// Flag::FlagQuality.
export const FLAG_QUALITY = Object.freeze({
  GOOD: 0,
  BAD: 1,
});

// global.cxx defaults. Locked BZDB variables upstream, so they are constants
// here too.
export const FLAG_ALTITUDE = 11.0;
export const FLAG_RADIUS = 2.5;
export const FLAG_POLE_SIZE = 0.8;
export const FLAG_POLE_WIDTH = 0.025;
// _flagHeight: the clearance a flag needs above its landing spot, not its
// drawn size. DropGeometry tests a cylinder this tall.
export const FLAG_CLEARANCE = 10.0;
// _maxFlagGrabs: how many times a superflag may be picked up before it leaves
// the world instead of landing. FlagInfo.cxx:137 reads it on every grab, so a
// server may change it; this is upstream's global.cxx default. A sticky flag
// ignores it and always gets one grab.
// Player::updateFlagEffect (Player.cxx:733). A flag scales the tank's length and
// width -- never its height, which is why a Tiny tank is short and stubby rather
// than small, and an Obese one is wide rather than tall. `N` Narrow is the one
// that touches width alone, and its factor is a literal upstream rather than a
// BZDB variable.
export const OBESE_FACTOR = 2.5;
export const TINY_FACTOR = 0.4;
export const NARROW_FACTOR = 0.001;
// _flagEffectTime: how long upstream takes to ease the scale from what it was to
// what the new flag asks for. bzo eases the *drawn* tank over this and nothing
// else: the collision and hit sizes are the target from the moment the flag
// changes hands, because a hitbox that disagrees with the server for two thirds
// of a second is worse than a tank that changes size faster than it looks like
// it should.
export const FLAG_EFFECT_TIME = 0.64;
export const MAX_FLAG_GRABS = 4;
// Upstream stores it in an int-valued BZDB var with no range of its own, so the
// only bound worth keeping is the one that makes it mean anything: a flag has to
// survive the grab that picks it up.
export const MAX_FLAG_GRABS_MIN = 1;
export const BASE_SIZE = 60.0;
// _shieldFlight. A Shield flag is thrown this many times higher than any other
// when it leaves a tank (FlagInfo.cxx:174), which is the second half of what the
// flag is worth: the hit costs you the flag, but the flag is still in the air
// while you drive back under it.
export const SHIELD_FLIGHT = 2.7;

// _rFireAdVel, _rFireAdRate, _mGunAdVel, _mGunAdRate, _laserAdVel, _laserAdRate
// and _laserAdLife (global.cxx:80, :95, :128). A shot variant is three
// multipliers on the world's own shot: how fast it flies, how often it may be
// fired, and how long it lives. Rapid Fire and Machine Gun declare their life as
// the string "1.0 / <rate>" rather than as a number, so the reciprocal is the
// rule and not a coincidence -- the shot slot frees exactly as fast as the flag
// fires. Laser is the one that breaks it: a tenth of the life and half the rate,
// which is what makes it the shot you wait for.
export const RAPID_FIRE_AD_VEL = 1.5;
export const RAPID_FIRE_AD_RATE = 2.0;
export const MACHINE_GUN_AD_VEL = 1.5;
export const MACHINE_GUN_AD_RATE = 10.0;
export const LASER_AD_VEL = 1000.0;
export const LASER_AD_RATE = 0.5;
export const LASER_AD_LIFE = 0.1;

// BZFlag's tank radius, deliberately not bzo's 2. The grab radius scales with
// the world rather than with the vehicle, as the sound reference distance in
// audio.js does: a bzo tank is half as wide as an upstream one, and building
// the radius from it would mean driving almost dead centre over a flag to take
// it. Tune this one figure if 6.82 plays badly.
export const BZFLAG_TANK_RADIUS = 4.32;
export const FLAG_GRAB_RADIUS = BZFLAG_TANK_RADIUS + FLAG_RADIUS;
// checkEnvironment() only grabs when the tank and the flag are on the same
// level, and rate-limits requests to five a second.
export const FLAG_GRAB_LEVEL_TOLERANCE = 0.1;
export const FLAG_GRAB_INTERVAL_MS = 200;

// bzfs.cxx:86. A vacated superflag slot refills on a halflife distribution.
export const SUPER_FLAG_HALF_LIFE_SECONDS = 10.0;

// _identifyRange. How far the Identify flag reaches when it names the nearest
// flag on the ground (searchFlag, bzfs.cxx:3631).
export const IDENTIFY_RANGE = 50.0;

// -st upstream, the shake timeout: how long a bad flag sticks before it falls
// off on its own. CmdLineOptions.cxx:1268 reads seconds and clamps them to this
// range, then stores tenths of a second, which is the resolution the client is
// told about -- so both sides quantize to a tenth and neither can be a fraction
// of a frame ahead of the other. Zero is the switch being off, which is
// upstream's default: a bad flag is then carried until it kills you.
export const SHAKE_TIMEOUT_MIN_SECONDS = 0.1;
export const SHAKE_TIMEOUT_MAX_SECONDS = 300.0;
// The client runs the countdown and asks the server to take the flag, exactly as
// upstream does (LocalPlayer.cxx:159). The server has to run the same clock or a
// modified client sheds a bad flag the moment it takes one, so it re-asks -- and
// allows this much slack, because the client's countdown is a sum of frame
// deltas and its request still has to cross the network. Lag only ever makes the
// request late, so the slack is for clock drift and nothing else.
export const SHAKE_DROP_GRACE_SECONDS = 0.25;

// -sw upstream, the shake win count: how many kills it takes to shed a bad flag.
// CmdLineOptions.cxx:1288 clamps to this range; zero is the switch being off.
export const SHAKE_WINS_MIN = 1;
export const SHAKE_WINS_MAX = 20;

// -sa upstream, the antidote flag: a yellow flag dropped somewhere in the world
// that shakes a bad flag off when you drive onto it. `LocalPlayer::setFlag`
// (LocalPlayer.cxx:1668) picks the spot inside a square centred on the world,
// smaller on a CTF map so the flag does not land on somebody's base, and rejects
// a spot a tank could not stand in. It tries this many times before it gives up
// and takes what it has, which is upstream's own "if it takes this long, just
// screw it".
export const ANTIDOTE_CTF_WORLD_FRACTION = 0.5;
export const ANTIDOTE_PLACEMENT_ATTEMPTS = 100;
export const ANTIDOTE_FLAG_COLOR = 0xffff00;

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
export const DEFAULT_WINGS_JUMP_COUNT = 1;
// _wingsSlideTime. Zero means a wings tank takes the velocity its stick asks for
// outright; above zero it accelerates towards it over that many seconds, so
// flight carries momentum.
export const DEFAULT_WINGS_SLIDE_TIME = 0.0;
// _wingsJumpVelocity and _wingsGravity have no stock values of their own: they
// are the strings "_jumpVelocity" and "_gravity", so unless a server sets them a
// wings jump rises and falls exactly as an ordinary one does.

// Every superflag is white; only team flags carry a colour (Flag.cxx:409). That
// is what makes hiding a superflag's identity free: an unidentified flag looks
// exactly like an identified one.
export const SUPER_FLAG_COLOR = 0xffffff;
// A flag this client knows to be bad. Upstream has no such colour -- every
// superflag it draws is white, because upstream never lets you know which one
// you are looking at until you have it. bzo does let you know, so the one thing
// worth knowing at a glance gets a colour, and it is orange rather than the
// warning red the pickup alert wears: red is a team here, and a red flag over a
// red tank on a red scoreboard row says nothing. No team is orange.
export const BAD_FLAG_COLOR = 0xffa020;

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

export const FLAG_TYPES = Object.freeze({
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
  SH: Object.freeze({
    abbreviation: 'SH',
    name: 'Shield',
    endurance: FLAG_ENDURANCE.UNSTABLE,
    quality: FLAG_QUALITY.GOOD,
    team: null,
    help: 'Getting hit only drops flag.  Flag flies an extra-long time.',
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
  JM: Object.freeze({
    abbreviation: 'JM',
    name: 'Jamming',
    endurance: FLAG_ENDURANCE.STICKY,
    quality: FLAG_QUALITY.BAD,
    team: null,
    help: 'Radar doesn\'t work.  Can still see.',
  }),
});

export const FLAG_ABBREVIATIONS = Object.freeze(Object.keys(FLAG_TYPES));

export function getFlagType(abbreviation) {
  return FLAG_TYPES[abbreviation] || null;
}

export function isTeamFlag(abbreviation) {
  return getFlagTeamIndex(abbreviation) !== null;
}

// FlagInfo::addFlag, which reads the endurance off the FlagType rather than
// deriving it: upstream declares every bad flag FlagSticky and every good
// superflag FlagUnstable, and the table carries both fields, so ask the table.
// A slot with nothing in it yet is unstable, which is what an empty superflag
// slot is worth.
export function getFlagEndurance(abbreviation) {
  const type = getFlagType(abbreviation);
  return type ? type.endurance : FLAG_ENDURANCE.UNSTABLE;
}

// LocalPlayer::doJump. Who may leave a surface, and who may do it again without
// touching one first. Wings never consults the world switch -- a flap is a flap,
// whatever the map says about jumping -- and it is the only flag that answers
// true while the tank is already in the air. No Jumping is the other end of the
// same switch: it refuses on a world that allows jumping, which is the whole of
// what the flag does, and upstream forbids it on a world that does not.
export function canJump(abbreviation, allowJumping, airborne, flapsLeft) {
  if (abbreviation === 'WG') return flapsLeft > 0;
  if (airborne) return false;
  if (abbreviation === 'NJ') return false;
  return allowJumping || abbreviation === 'JP';
}

// CmdLineOptions.cxx:1268. Seconds in, seconds out, clamped and rounded to the
// tenth upstream sends on the wire. Anything that is not a positive number is
// the switch being off.
export function normalizeShakeTimeout(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const clamped = Math.min(SHAKE_TIMEOUT_MAX_SECONDS, Math.max(SHAKE_TIMEOUT_MIN_SECONDS, value));
  return Math.round(clamped * 10) / 10;
}

// CmdLineOptions.cxx:1288. A whole number of kills, clamped, and zero for off.
export function normalizeShakeWins(count) {
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
export function getTankDimensionScale(abbreviation) {
  switch (abbreviation) {
    case 'O': return { length: OBESE_FACTOR, width: OBESE_FACTOR };
    case 'T': return { length: TINY_FACTOR, width: TINY_FACTOR };
    case 'N': return { length: 1, width: NARROW_FACTOR };
    default: return { length: 1, width: 1 };
  }
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
export function blanksTheView(abbreviation) {
  return abbreviation === 'B';
}

export function jamsTheRadar(abbreviation) {
  return abbreviation === 'JM';
}

export function hidesTeamColors(abbreviation) {
  return abbreviation === 'CB';
}

// RadarRenderer::render (RadarRenderer.cxx:433). A jammed radar is noise on most
// frames and the real thing on a few, and `decay` is the chance of a good one.
// It starts at 0.01 and the noise branch leaves it there, so roughly one frame in
// a hundred breaks through; that frame sets decay to 1, which guarantees a second
// good frame, and it then halves per frame until noise takes over again. The
// result is a readable burst every second or two rather than an even flicker.
export const RADAR_JAM_DECAY_MIN = 0.01;
export const RADAR_JAM_DECAY_FLOOR = 0.015;

// Returns the decay to carry into the next frame, given this frame's roll.
export function getNextRadarJamDecay(decay, showedNoise) {
  if (showedNoise) return decay > RADAR_JAM_DECAY_FLOOR ? decay * 0.5 : decay;
  return decay <= RADAR_JAM_DECAY_FLOOR ? 1.0 : decay * 0.5;
}

// Player::getRadius (Player.cxx:204), carrying upstream's own note: "this
// encompasses everything but Narrow -- the Obese, Tiny, and Thief flags adjust
// the radius, but Narrow does not." The hit sphere follows the *length* scale,
// which is exactly the axis Narrow leaves alone, so a narrow tank keeps a
// full-size sphere and would be no harder to hit at all. That is why
// SegmentedShotStrategy::checkHit gives Narrow a shape of its own.
export function getTankHitRadiusScale(abbreviation) {
  return getTankDimensionScale(abbreviation).length;
}

// SegmentedShotStrategy::checkHit (SegmentedShotStrategy.cxx:262). A shot meets
// a sphere around every tank but a narrow one, which gets an oriented box --
// and the box is only as wide as the shell, never as wide as the tank, in
// upstream's own words: "width of box is shell radius so you can actually hit
// narrow tank head on". At the tank's real narrow width the box would be
// unhittable from the front rather than hard to hit, which is a different flag.
export function usesNarrowHitBox(abbreviation) {
  return abbreviation === 'N';
}

// The eased scale a tank is *drawn* at, `elapsed` seconds after its flag last
// changed. Upstream's rate is `(target - scale) / FlagEffectTime`, which takes
// exactly FlagEffectTime to arrive whatever it started from, so the ease is a
// straight interpolation from the scale in hand to the one the flag asks for.
export function getTankDimensionEase(fromScale, targetScale, elapsedSeconds) {
  if (!(elapsedSeconds >= 0)) return targetScale;
  if (elapsedSeconds >= FLAG_EFFECT_TIME) return targetScale;
  const t = elapsedSeconds / FLAG_EFFECT_TIME;
  return fromScale + ((targetScale - fromScale) * t);
}

export function normalizeFlagGrabs(count) {
  const value = Math.floor(Number(count));
  if (!Number.isFinite(value)) return MAX_FLAG_GRABS;
  return Math.max(MAX_FLAG_GRABS_MIN, value);
}

// LocalPlayer::setFlag's antidote square. Upstream picks x and y inside it and
// leaves z at 0, so this answers one coordinate and is called twice. `random` is
// passed in rather than called here so the pair stays pure and the test can pin
// it.
export function getAntidoteCoordinate(worldSize, baseSize, ctf, random) {
  const span = ctf
    ? ANTIDOTE_CTF_WORLD_FRACTION * worldSize
    : worldSize - baseSize;
  return span * (random - 0.5);
}

// Whether a sticky flag has been held long enough to fall off. The client counts
// down from the timeout and sends the drop; this is what the server asks of the
// request before it agrees, and what the client asks before it bothers to send.
export function canShakeFlag(abbreviation, shakeTimeout, heldSeconds) {
  if (getFlagEndurance(abbreviation) !== FLAG_ENDURANCE.STICKY) return false;
  const timeout = normalizeShakeTimeout(shakeTimeout);
  if (timeout === 0) return false;
  return heldSeconds >= timeout - SHAKE_DROP_GRACE_SECONDS;
}

// LocalPlayer::doUpdateMotion. Wings is the one flag that drives and steers off
// the ground; every other tank keeps the velocity it took off with until it
// lands.
export function hasAirControl(abbreviation) {
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
// `fireSound` is the sample the shot is announced with. Upstream switches on the
// flag rather than playing SFX_FIRE for everything (playing.cxx:2956), and Laser
// is the first flag bzo has that takes a sound of its own.
const DEFAULT_SHOT_EFFECTS = Object.freeze({
  velocityFactor: 1,
  rateFactor: 1,
  lifeFactor: 1,
  beam: false,
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
  SB: Object.freeze({
    ...DEFAULT_SHOT_EFFECTS,
    throughBuildings: true,
  }),
  IB: Object.freeze({
    ...DEFAULT_SHOT_EFFECTS,
    hiddenOnRadar: true,
  }),
});

export function getShotEffects(abbreviation) {
  return SHOT_EFFECTS[abbreviation] || DEFAULT_SHOT_EFFECTS;
}

// SegmentedShotStrategy::makeSegments. A shot that would stop at a wall
// reflects off it instead when the world says every shot ricochets, and the
// Ricochet flag makes one that reflects whatever the world says. With the world
// switch on the flag has nothing left to offer, which is why the server forbids
// it there. A shot that goes through buildings never meets one to bounce off.
export function shotRicochets(abbreviation, allShotsRicochet) {
  if (getShotEffects(abbreviation).throughBuildings) return false;
  return allShotsRicochet === true || abbreviation === 'R';
}

// gotBlowedUp (playing.cxx:3919). Shield is the one flag that answers a shot
// with something other than a death: the tank lives and gives up the flag
// instead. Only a shot -- upstream tests the reason as well as the flag, so
// being run over, caught by a capture or genocided kills a shielded tank like
// anyone else.
export function shieldsAgainstShot(abbreviation) {
  return abbreviation === 'SH';
}

// LocalPlayer::doJump's vertical component. A flap relaunches a tank that is on
// its way up only if it is climbing slower than the flap would, and a falling
// one is slowed rather than relaunched -- so flapping late in a dive costs you
// most of what the flap was worth.
export function getWingsJumpVelocity(wingsJumpVelocity, verticalVelocity) {
  if (verticalVelocity < 0) return wingsJumpVelocity + verticalVelocity;
  return Math.max(wingsJumpVelocity, verticalVelocity);
}

// LocalPlayer::doSlideMotion, which a wings tank flies through when
// _wingsSlideTime is above zero. The stick adds to the velocity rather than
// replacing it, and the result is held at maxSpeed -- a tank already over that,
// from a flap taken at speed, is bled back towards it over the same slide time
// rather than snapped to it. Heading is bzo's, where forward is (-sin, -cos).
export function getWingsSlideVelocity(
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
export function getFlagTeamIndex(abbreviation) {
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
export function rememberFlagIdentity(known, index, type, status) {
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
export function getKnownFlagAbbreviation(known, flag) {
  if (!flag) return null;
  return flag.type || known.get(flag.index) || null;
}

// Whether a flag is one of the penalties. The quality is on the table already;
// this is the question the colours and the alerts actually ask of it.
export function isBadFlag(abbreviation) {
  return getFlagType(abbreviation)?.quality === FLAG_QUALITY.BAD;
}

export function getTeamFlagAbbreviation(colorIndex) {
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
export function getFlagThrownAltitude(abbreviation) {
  return abbreviation === 'SH' ? SHIELD_FLIGHT * FLAG_ALTITUDE : FLAG_ALTITUDE;
}

// FlagInfo::addFlag and FlagInfo::dropFlag both derive the flight from one
// thrown altitude. Upstream's downTime repeats upTime rather than using the
// landing altitude (FlagInfo.cxx:170), so the flight always lasts
// 2 * sqrt(2 * altitude / gravity) however far the flag has to fall; the height
// curve below is a lerp between the two altitudes plus this parabola, so it
// still arrives in the right place. `gravity` is bzo's positive magnitude where
// upstream's is negative.
export function computeFlagFlight(thrownAltitude, gravity) {
  const upTime = Math.sqrt(2 * thrownAltitude / gravity);
  return {
    flightEnd: 2 * upTime,
    initialVelocity: gravity * upTime,
  };
}

// The parabola a thrown flag follows, relative to the interpolated altitude.
export function getFlagFlightHeight(elapsed, initialVelocity, gravity) {
  return elapsed * (initialVelocity - 0.5 * gravity * elapsed);
}

// Where a Coming or Going flag hangs while it fades. Equals the thrown altitude
// exactly, which is what the apex of the parabola above reaches.
export function getFlagHoverHeight(flightEnd, initialVelocity, gravity) {
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
export function getFlagFlightState(flag, elapsed, gravity) {
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
