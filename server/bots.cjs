/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Bots this server runs itself (docs/bots-plan.md, step 2): upstream's
// `bz_ServerSidePlayerHandler` with one of `public/autopilot.mjs`'s pilots as
// its brain. A bot is a client in every way the server can see -- it joins,
// moves and shoots through the same messages a browser sends, on a socket that
// never leaves the process -- so validation, broadcast, scoring and the list
// treat it as any other player. What lives here is only what a browser does
// for itself: drive the tank and say so.

const {
  createDriveState,
  movePacketFields,
  packetVelocity,
  readDriveInput,
  shotFromTank,
  stepDrive,
} = require('./drive.cjs');
const { TANK } = require('./collision.cjs');
const { getFiredShotFlag, getShotEffects, getTankDimensionScale } = require('./flags.cjs');

// The fill rule: bots make up the playing roster to `fill`, and there are none
// once the people do. Returns how many to add (positive) or take away
// (negative).
function planBotFill({ fill, humans, bots }) {
  const wanted = Math.max(0, Math.floor(fill || 0) - humans);
  return wanted - bots;
}

// The team a bot leaves when the roster has one too many: the biggest, so a
// person joining a team leaves the game as even as it was.
function pickBotToRemove(bots, teamSizes) {
  let best = null;
  for (const bot of bots) {
    const size = teamSizes.get(bot.team) || 0;
    if (!best || size > best.size) best = { bot, size };
  }
  return best ? best.bot : null;
}

// How often a bot reports a move with nothing new in it, as a client's own
// heartbeat does.
const HEARTBEAT_SECONDS = 1;
// The smallest change in a reported speed worth a packet, as a client's
// VELOCITY_THRESHOLD.
const VELOCITY_THRESHOLD = 0.01;

const round = (value, places) => Number(value.toFixed(places));

// One bot's tank. It drives by the shared `drive` step (public/drive.mjs), the
// one a browser's tank drives by, so a bot carrying Burrow goes underground and
// one carrying Agility gets the burst exactly as a person's tank does; what is
// here is only what a client does around that step -- ask its pilot, say where
// it went, fire. `env` is the server it lives in:
//   config()        GAME_CONFIG
//   colliders()     every solid a tank meets, world walls included
//   topOf(obs)      an obstacle's top
//   state()         { alive, x, y, z, azimuth } off the server's player
//   flag()          { type, zoned } of the flag the bot holds, or null
//   view(self)      the pilot's view, given the bot's own idea of itself
//   send(message)   a message as though the bot's client had sent it
//   act(self)       the per-frame checks a client makes: grab, capture
//   teleport?(from, to, state) a teleporter crossed on the way, as `drive` asks
class BotDriver {
  constructor({ pilot, env }) {
    this.pilot = pilot;
    this.env = env;
    this.alive = false;
    this.clock = 0;
    this.lastSentAt = -Infinity;
    this.lastSent = null;
    this.lastDropAt = -Infinity;
    this.drive = createDriveState();
  }

  // The tank's state, read as the old driver's fields were.
  get x() { return this.drive.x; }
  get y() { return this.drive.y; }
  get z() { return this.drive.z; }
  get azimuth() { return this.drive.azimuth; }
  get vz() { return this.drive.verticalVelocity; }
  get angVel() { return this.drive.lastAngVel; }
  get speed() { return this.drive.lastSpeed; }
  get jumpDirection() { return this.drive.jumpDirection; }

  // Where the server put the tank, which is where every life starts.
  respawn(state) {
    this.drive = createDriveState({ x: state.x, y: state.y, z: state.z, azimuth: state.azimuth });
    this.lastSent = null;
  }

  tankFor() {
    const flag = this.env.flag ? this.env.flag() : null;
    return { flag: flag?.type ?? null, motionFlag: flag?.type ?? null, zoned: flag?.zoned === true };
  }

  worldFor(config) {
    return { config, colliders: this.env.colliders(), topOf: this.env.topOf, teleport: this.env.teleport };
  }

  self() {
    const config = this.env.config();
    const d = this.drive;
    const inAir = d.jumpDirection !== null;
    return {
      x: d.x,
      y: d.y,
      z: d.z,
      azimuth: d.azimuth,
      inAir,
      muzzleForward: TANK.muzzleForward,
      muzzleHeight: TANK.muzzleHeight,
      // How the tank is moving, which a shot inherits -- as the client's view
      // says it.
      velocity: inAir
        ? { x: d.airVelocityX, y: d.airVelocityY, z: d.verticalVelocity }
        : { x: Math.cos(d.azimuth) * d.lastSpeed, y: Math.sin(d.azimuth) * d.lastSpeed, z: 0 },
      speed: d.lastSpeed,
      topSpeed: d.topSpeed || config.TANK_SPEED,
      accel: d.linearLimit,
      angVel: d.lastAngVel,
      angAccel: d.angularLimit,
      turnRate: d.turnRate || config.TANK_ROTATION_SPEED,
    };
  }

  // One frame, as a browser's: the pilot decides, the shared step drives, and
  // the move goes out before anything that rides on it.
  tick(dt) {
    this.clock += dt;
    const state = this.env.state();
    if (!state.alive) {
      this.alive = false;
      return;
    }
    if (!this.alive) {
      this.alive = true;
      this.respawn(state);
    }
    const config = this.env.config();
    const out = this.pilot.think(this.env.view(this.self()));
    this.lastOut = out;

    if (out.dropFlag && this.clock - this.lastDropAt > 1) {
      this.lastDropAt = this.clock;
      this.env.send({ type: 'dropFlag' });
    }

    const tank = this.tankFor();
    const world = this.worldFor(config);
    const clock = { now: this.clock, random: Math.random };
    const intended = readDriveInput(this.drive, {
      forward: out.speed || 0, turn: out.rotation || 0, up: Boolean(out.jump),
    }, tank, world, clock);
    const events = stepDrive(this.drive, intended, tank, world, clock, dt);
    if (events.teleport) {
      const tp = events.teleport;
      this.env.send({
        type: 'tp',
        fromFaceId: tp.fromFaceId,
        toFaceId: tp.toFaceId,
        x: round(tp.source.x, 2),
        y: round(tp.source.y, 2),
        z: round(tp.source.z, 2),
        a: round(tp.sourceAzimuth, 2),
        vv: round(tp.verticalVelocity, 2),
        vx: round(tp.airVelocityX, 2),
        vy: round(tp.airVelocityY, 2),
        ja: tp.jumpDirection === null ? null : round(tp.jumpDirection, 2),
      });
    }
    this.report(dt, events.forceSend || out.fire, Boolean(events.jumpStarted));

    this.env.act(this.self());
    if (out.fire) this.fire();
  }

  // A move packet, sent as a client sends one: when a speed changed, on a jump
  // or a landing, before a shot, and otherwise as a heartbeat.
  report(dt, force, jumpStarted = false) {
    const packet = {
      type: 'm',
      ...movePacketFields(this.drive, { jumpStarted }),
      dt: round(dt, 3),
      sdt: round(Math.min(this.clock - this.lastSentAt, 60), 3),
      ct: round(this.clock, 3),
    };
    const last = this.lastSent;
    const changed = !last
      || Math.abs(packet.fs - last.fs) > VELOCITY_THRESHOLD
      || Math.abs(packet.rs - last.rs) > VELOCITY_THRESHOLD;
    if (!force && !changed && this.clock - this.lastSentAt < HEARTBEAT_SECONDS) return;
    this.lastSent = packet;
    this.lastSentAt = this.clock;
    this.env.send(packet);
  }

  // A stop, for a bot about to be left idle: whatever the server last heard is
  // what it keeps extrapolating, so the last thing it hears is standing still.
  halt() {
    if (!this.alive || this.drive.jumpDirection !== null) return;
    this.drive.forwardSpeed = 0;
    this.drive.rotationSpeed = 0;
    this.report(0, true);
  }

  // The shot every tank fires (`shotFromTank`), carrying the velocity the
  // server holds for the tank off the move `tick` has just sent.
  fire() {
    const config = this.env.config();
    const tank = this.tankFor();
    const fired = getFiredShotFlag(tank.flag, tank.zoned);
    const fields = this.lastSent || movePacketFields(this.drive);
    this.env.send(shotFromTank({
      x: this.drive.x,
      y: this.drive.y,
      z: this.drive.z,
      azimuth: this.drive.azimuth,
      tankVelocity: packetVelocity(fields, config),
      config,
      shockwave: getShotEffects(fired).shockwave,
      // `Player::getMuzzle`: the barrel's reach grows and shrinks with the tank.
      muzzleForward: TANK.muzzleForward * getTankDimensionScale(tank.flag ?? null).length,
    }));
  }
}

module.exports = {
  planBotFill,
  pickBotToRemove,
  BotDriver,
};
