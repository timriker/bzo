/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// bzflag-native.cjs - One native BZFlag client seated in bzo's game (issue
// #174). bzo talks to it as to a browser, in its own JSON; this turns each of
// those messages into what bzfs would have sent, and the client's own
// messages back into bzo's. The proxy (`bzfs-session.cjs` and server.js's
// `proxy*` helpers) runs the same conversions the other way.

'use strict';

const CALLSIGN_LEN = 32;
const MOTTO_LEN = 128;
const TOKEN_LEN = 22;
const VERSION_LEN = 60;
const NO_PLAYER = 255;
const ALL_PLAYERS = 254;
const SERVER_PLAYER = 253;
const ADMIN_PLAYERS = 252;
// The last id a player may have (`LastRealPlayer`, global.h): ids above it
// are team and broadcast addresses.
const LAST_REAL_PLAYER = 243;
// `TankPlayer`, `ComputerPlayer` (global.h).
const TANK_PLAYER = 0;
const COMPUTER_PLAYER = 1;
// `PlayerState` status bits (PlayerState.h:25).
const STATUS_ALIVE = 1 << 0;
const STATUS_FLAG_ACTIVE = 1 << 4;
const STATUS_FALLING = 1 << 6;
// `BlowedUpReason` (playing.h:128).
const DEATH_REASONS = {
  // The match's end blowing every tank up is the server's word alone,
  // `GotKilledMsg`.
  gameOver: 0, shot: 1, runOver: 2, captured: 3, genocide: 4, selfDestruct: 5, water: 6,
  // `DeathTouch = PhysicsDriverDeath`, 'pd', which carries the driver's index.
  physicsDriver: 0x7064,
};
// `NoTeam` (global.h), as MsgScoreOver packs it for a player's win.
const NO_TEAM = 0xffff;


class Writer {
  constructor(size = 256) {
    this.buf = Buffer.alloc(size);
    this.o = 0;
  }

  ensure(n) {
    if (this.o + n <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(this.buf.length * 2, this.o + n));
    this.buf.copy(next, 0, 0, this.o);
    this.buf = next;
  }

  u8(v) { this.ensure(1); this.buf.writeUInt8((Number(v) || 0) & 0xff, this.o); this.o += 1; return this; }

  u16(v) { this.ensure(2); this.buf.writeUInt16BE((Number(v) || 0) & 0xffff, this.o); this.o += 2; return this; }

  i16(v) { this.ensure(2); this.buf.writeInt16BE(Math.max(-32768, Math.min(32767, Math.round(Number(v) || 0))), this.o); this.o += 2; return this; }

  i32(v) { this.ensure(4); this.buf.writeInt32BE(Math.round(Number(v) || 0) | 0, this.o); this.o += 4; return this; }

  u32(v) { this.ensure(4); this.buf.writeUInt32BE((Number(v) || 0) >>> 0, this.o); this.o += 4; return this; }

  f32(v) { this.ensure(4); this.buf.writeFloatBE(Number.isFinite(Number(v)) ? Number(v) : 0, this.o); this.o += 4; return this; }

  vec3(v) { return this.f32(v[0]).f32(v[1]).f32(v[2]); }

  // A NUL-padded fixed field, one byte short so it always ends in NUL.
  fixed(text, length) {
    this.ensure(length);
    this.buf.fill(0, this.o, this.o + length);
    this.buf.write(String(text ?? ''), this.o, length - 1, 'latin1');
    this.o += length;
    return this;
  }

  // `FlagType::pack`: the abbreviation in two bytes, NUL padded.
  flag(abbv) {
    this.ensure(2);
    this.buf.fill(0, this.o, this.o + 2);
    if (abbv) this.buf.write(String(abbv), this.o, 2, 'latin1');
    this.o += 2;
    return this;
  }

  bytes(b) { this.ensure(b.length); b.copy(this.buf, this.o); this.o += b.length; return this; }

  done() { return this.buf.subarray(0, this.o); }
}

// MsgTeamUpdate's body: a count, then (team, size, wins, losses).
function packTeams(teams) {
  const w = new Writer(1 + (teams.length * 8)).u8(teams.length);
  for (const entry of teams) w.u16(entry.team).u16(entry.size).u16(entry.wins).u16(entry.losses);
  return w.done();
}

// A native client's own `PlayerState`, as the move bzo's browser would have
// sent: the proxy's `proxyOutboundMotion` run backwards. Both speak upstream's
// frame. bzo carries a ground speed as a fraction of the tank's top speed
// along its heading, or along `sd` where the tank is sliding some other way;
// in the air, the velocity itself.
function moveFromBzfs(update, config) {
  const [x, y, z] = update.pos;
  const a = update.azimuth;
  const [vx, vy, vv] = update.velocity;
  const air = (update.status & STATUS_FALLING) !== 0;
  const tankSpeed = Number(config.TANK_SPEED) || 25;
  const along = (vx * Math.cos(a)) + (vy * Math.sin(a));
  const speed = Math.hypot(vx, vy);
  const round2 = (v) => Math.round(v * 100) / 100;
  const move = {
    type: 'm',
    x: round2(x),
    y: round2(y),
    z: round2(z),
    a: round2(a),
    fs: round2(along / tankSpeed),
    rs: round2(update.angVel / (Number(config.TANK_ROTATION_SPEED) || 0.785398)),
    vv: round2(air ? vv : 0),
    vx: round2(air ? vx : 0),
    vy: round2(air ? vy : 0),
    air: air ? 1 : 0,
    // The client's own clock, which bzo only ever differences.
    ct: Math.round(update.timestamp * 1000) / 1000,
  };
  // Sliding off its heading: the direction of travel and the speed along it.
  if (!air && speed > 0.01 && Math.abs(along) < speed * 0.995) {
    move.sd = round2(Math.atan2(vy, vx));
    move.fs = round2(speed / tankSpeed);
  }
  return move;
}

// A native client's `MsgShotBegin` (decoded as `decodeShotBegin` reads one) as
// the `shoot` bzo's browser sends: where it left the muzzle and its whole
// velocity.
function shootFromBzfs(shot) {
  const [x, y, z] = shot.pos;
  const [vx, vy, vz] = shot.velocity;
  return {
    type: 'shoot', x, y, z, vx, vy, vz,
  };
}

// `PlayerInfo::unpackEnter`: type, team, callsign, motto, token, version.
function decodeEnter(payload) {
  const text = (at, length) => payload.toString('latin1', at, at + length).replace(/\0.*$/s, '');
  if (payload.length < 4 + CALLSIGN_LEN + MOTTO_LEN + TOKEN_LEN + VERSION_LEN) return null;
  let at = 4;
  const callsign = text(at, CALLSIGN_LEN); at += CALLSIGN_LEN;
  const motto = text(at, MOTTO_LEN); at += MOTTO_LEN;
  const token = text(at, TOKEN_LEN); at += TOKEN_LEN;
  const version = text(at, VERSION_LEN);
  return {
    type: payload.readUInt16BE(0), team: payload.readInt16BE(2), callsign, motto, token, version,
  };
}

// MsgMessage from a client: to, then the text (the sender is the
// connection).
function decodeClientMessage(payload) {
  if (payload.length < 1) return null;
  return { to: payload.readUInt8(0), text: payload.toString('latin1', 1).replace(/\0.*$/s, '') };
}

// `options.teamIndex(team)` names a bzo team by upstream's number;
// `options.send(code, payload)` writes a frame; `options.selfSlot` is the id
// the handshake gave this connection; `options.config()` is the live game
// config, for speeds. `options.scoreOf(id)` is a player's score as the
// server tallies it, which bzo's own clients tally for themselves and a
// BZFlag client is sent, as bzfs sends it.
class NativeTranslator {
  constructor({
    selfSlot, send, teamIndex, config, flagName = () => '', guidedShots = () => [],
    addressOf = () => null, selfIsAdmin = () => false, scoreOf = () => null,
  }) {
    this.selfSlot = selfSlot;
    this.write = send;
    this.teamIndex = teamIndex;
    this.config = config;
    this.flagName = flagName;
    // A shooter's guided missiles in the air, as bzo's server has them now.
    this.guidedShots = guidedShots;
    // A player's address, and whether this client may be told it.
    this.addressOf = addressOf;
    this.selfIsAdmin = selfIsAdmin;
    this.scoreOf = scoreOf;
    // The last flag MsgNearFlag named, so an unchanged answer is not repeated.
    this.lastNearFlag = null;
    this.selfBzoId = null;
    this.players = new Map();
    this.shots = new Map();
    this.shotCounter = 0;
    // The client's own id for the shot it just fired, while bzo answers it:
    // bzo names the shot its own way, and the client knows it only by this.
    this.ownShotPending = null;
    // Whether the client has said it died (its own MsgKilled) since bzo last
    // told it where it is alive.
    this.clientDead = false;
    this.orders = new Map();
    // Flag index to the bzo id holding it zoned. Zoning is on bzo's flag and
    // on the holder's `FlagActive` in bzfs's, so every flag record that passes
    // through here keeps this current.
    this.zonedFlags = new Map();
    this.accepted = false;
    this.pending = null;
    this.startedAt = Date.now();
  }

  // A bzo player's id as a bzfs one: the same number, since bzo numbers its
  // players in upstream's PlayerId space (server/player-ids.cjs).
  slotFor(bzoId) {
    const id = Number(bzoId);
    return Number.isInteger(id) && id >= 0 && id <= LAST_REAL_PLAYER ? id : NO_PLAYER;
  }

  // An id bzo sent that names no player: the server, or nobody.
  sourceSlot(bzoId) {
    if (bzoId === SERVER_PLAYER || bzoId === String(SERVER_PLAYER)) return SERVER_PLAYER;
    if (bzoId === ALL_PLAYERS || bzoId === String(ALL_PLAYERS)) return ALL_PLAYERS;
    if (bzoId === ADMIN_PLAYERS || bzoId === String(ADMIN_PLAYERS)) return ADMIN_PLAYERS;
    return this.slotFor(bzoId);
  }

  timestamp() {
    return (Date.now() - this.startedAt) / 1000;
  }

  addPlayer(record) {
    const w = new Writer(180)
      .u8(this.slotFor(record.id))
      .u16(record.bot ? COMPUTER_PLAYER : TANK_PLAYER)
      .u16(this.teamIndex(record.team))
      .u16(record.wins)
      .u16(record.losses)
      .u16(record.tks)
      .fixed(record.name, CALLSIGN_LEN)
      .fixed(record.motto, MOTTO_LEN);
    this.write('ap', w.done());
    this.players.set(String(record.id), record);
    this.playerInfo(record);
    // `sendIPUpdate(-1, playerIndex)` (bzfs.cxx:2430): an arrival's address,
    // to whoever holds `playerList`. Alone, which the client reads as that
    // player joining (playing.cxx:3364); the roster at this client's own
    // arrival goes as one list instead (`accept`).
    if (this.accepted && !this.accepting) this.adminInfo([record.id]);
    // A server bot is always the machine driving; a person's autopilot is as
    // they last set it (`sendAutopilotStatus`, bzfs.cxx:2399).
    if (record.bot || record.autopilot) this.autopilot(record.id, true);
  }

  // MsgGMUpdate (`GuidedMissileStrategy::sendUpdate`): one missile as it is
  // now -- who, which shot, where, how fast -- and what it is locked on. A
  // BZFlag client steers a missile itself toward that target from there, as
  // its own does; bzo's server steers it the same way.
  missileUpdate(shot, targetBzoId) {
    const known = this.shots.get(shot.id);
    if (!known) return;
    const speed = Number(shot.speed) || 0;
    this.write('gm', new Writer(32)
      .u8(known.shooter)
      .u16(known.id)
      .vec3([shot.x, shot.y, shot.z])
      .vec3([shot.dirX * speed, shot.dirY * speed, shot.dirZ * speed])
      .f32(0)
      .i16(this.teamIndex(shot.team))
      .u8(targetBzoId === null || targetBzoId === undefined ? NO_PLAYER : this.slotFor(targetBzoId))
      .done());
  }

  // MsgAdminInfo (`packAdminInfo`, GameKeeper.cxx:201): a count, then for each
  // player a size, its id and its address -- IPv4 only, a type byte and four,
  // which is all upstream packs or reads, so an IPv6 player is left out.
  adminInfo(bzoIds) {
    if (!this.selfIsAdmin()) return;
    const entries = [];
    for (const id of bzoIds) {
      const raw = String(this.addressOf(String(id)) || '').replace(/^::ffff:/i, '');
      const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw);
      if (octets) entries.push({ slot: this.slotFor(id), octets: octets.slice(1).map(Number) });
    }
    if (entries.length === 0) return;
    const w = new Writer(1 + (entries.length * 7)).u8(entries.length);
    for (const { slot, octets } of entries) {
      w.u8(5).u8(slot).u8(4);
      for (const octet of octets) w.u8(octet);
    }
    this.write('ai', w.done());
  }

  // MsgTeamUpdate: each team's size, wins and losses.
  teamUpdate(teams) {
    this.write('tu', packTeams(teams.map((entry) => ({ ...entry, team: this.teamIndex(entry.team) }))));
  }

  // MsgAutoPilot: who, and whether the autopilot has the controls -- the
  // scoreboard's `[auto]`.
  autopilot(bzoId, on) {
    this.write('au', new Writer(2).u8(this.slotFor(bzoId)).u8(on ? 1 : 0).done());
  }

  // MsgPlayerInfo: what the scoreboard draws as `-`, `+` and `@`
  // (`PlayerAttribute`, Protocol.h:53). bzo learns nothing about a callsign
  // it did not verify, so verified means registered too.
  playerInfo(record) {
    const properties = (record.verified ? 1 | 2 : 0) | (record.admin ? 4 : 0);
    this.write('pb', new Writer(3).u8(1).u8(this.slotFor(record.id)).u8(properties).done());
  }

  removePlayer(bzoId) {
    const key = String(bzoId);
    if (!this.players.has(key)) return;
    this.write('rp', new Writer(1).u8(this.slotFor(key)).done());
    this.players.delete(key);
    this.orders.delete(key);
  }

  // `PlayerState::pack`, the full form, from bzo's own move fields.
  playerUpdate(move) {
    const a = Number(move.a) || 0;
    const config = this.config();
    const alive = this.players.get(String(move.id))?.alive !== false;
    let status = alive ? STATUS_ALIVE : 0;
    if (Number(move.vv)) status |= STATUS_FALLING;
    // Phantom Zone's zoning, as upstream's client sends it (LocalPlayer.cxx:729).
    if ([...this.zonedFlags.values()].includes(String(move.id))) status |= STATUS_FLAG_ACTIVE;
    // `PlayerState::pack` counts every update, and a client drops one that is
    // not newer than the last it took (playing.cxx:3488).
    const key = String(move.id);
    const order = (this.orders.get(key) || 0) + 1;
    this.orders.set(key, order);
    const w = new Writer(48)
      .f32(this.timestamp())
      .u8(this.slotFor(move.id))
      .i32(order)
      .i16(status)
      .vec3([Number(move.x) || 0, Number(move.y) || 0, Number(move.z) || 0])
      .vec3([Number(move.vx) || 0, Number(move.vy) || 0, Number(move.vv) || 0])
      .f32(a)
      .f32((Number(move.rs) || 0) * (config.TANK_ROTATION_SPEED || 0));
    this.write('pu', w.done());
  }

  score(record) {
    this.scores([record]);
  }

  // MsgScore (`sendPlayerScores`, bzfs.cxx:602): a count, then each player's
  // slot, wins, losses and team kills.
  scores(records) {
    const w = new Writer(1 + (records.length * 7)).u8(records.length);
    for (const record of records) {
      w.u8(this.slotFor(record.id)).u16(record.wins || 0).u16(record.losses || 0).u16(record.tks || 0);
    }
    this.write('sc', w.done());
  }

  alive(record) {
    this.players.set(String(record.id), { ...record, alive: true });
    if (String(record.id) === this.selfBzoId) this.clientDead = false;
    this.write('al', new Writer(17)
      .u8(this.slotFor(record.id))
      .vec3([record.x, record.y, record.z])
      .f32(record.azimuth)
      .done());
  }

  // `FlagInfo::pack`: index, then `Flag::pack`.
  flagBody(w, flag) {
    if (flag.zoned === true && flag.owner !== null && flag.owner !== undefined) {
      this.zonedFlags.set(flag.index, String(flag.owner));
    } else {
      this.zonedFlags.delete(flag.index);
    }
    const pos = (p) => (p ? [p.x, p.y, p.z] : [0, 0, 0]);
    // A superflag nobody holds goes out as `PZ`, as bzfs's `fakePack` sends
    // it (Flag.cxx:265): a flag, of a type the client is not told.
    return w.u16(flag.index)
      .flag(flag.type || 'PZ')
      .u16(flag.status)
      .u16(0)
      .u8(flag.owner === null || flag.owner === undefined ? NO_PLAYER : this.slotFor(flag.owner))
      .vec3(pos(flag.position))
      .vec3(pos(flag.launchPosition))
      .vec3(pos(flag.landingPosition))
      .f32(flag.flightTime)
      .f32(flag.flightEnd)
      .f32(flag.initialVelocity);
  }

  flagUpdate(flags) {
    // A message holds what fits in one packet; bzfs splits the same way.
    for (let start = 0; start < flags.length; start += 16) {
      const chunk = flags.slice(start, start + 16);
      const w = new Writer(2 + (chunk.length * 57)).u16(chunk.length);
      for (const flag of chunk) this.flagBody(w, flag);
      this.write('fu', w.done());
    }
  }

  // bzo's id for a shot, as `(slot, counter << 8 | shotSlot)`.
  shotId(projectileId, shotSlot, shooter) {
    let shot = this.shots.get(projectileId);
    if (shot === undefined) {
      this.shotCounter = (this.shotCounter + 1) & 0xff;
      shot = { id: ((this.shotCounter << 8) | ((Number(shotSlot) || 0) & 0xff)) & 0xffff, shooter };
      this.shots.set(projectileId, shot);
    }
    return shot.id;
  }

  // The burst bzfs sends after MsgEnter (`addPlayer`, bzfs.cxx:2355).
  // The game as it stands, for a recording rather than a client: what
  // `accept` tells an arrival, less the arrival itself -- no MsgAccept, no
  // record of its own, no addresses. A recorder calls this at the start of
  // what it saves and at each snapshot (`server/bzo-recorder.cjs`), as bzfs
  // writes its state packets (`Record::sendStates`).
  writeState(init) {
    this.accepted = true;
    this.accepting = true;
    this.writeVars(init.bzdb);
    this.flagUpdate(init.flags || []);
    for (const record of init.players || []) {
      if (record.joined === false) continue;
      this.addPlayer(record);
      if (record.alive) this.alive(record);
    }
    this.accepting = false;
    if (Array.isArray(init.teamScores) && init.teamScores.length > 0) this.teamUpdate(init.teamScores);
    if (init.rabbitId !== null && init.rabbitId !== undefined) {
      this.write('nR', new Writer(1).u8(this.slotFor(init.rabbitId)).done());
    }
  }

  // MsgSetVar, twenty to a message as bzfs batches them.
  writeVars(bzdb) {
    const vars = Object.entries(bzdb || {});
    for (let start = 0; start < vars.length; start += 20) {
      const chunk = vars.slice(start, start + 20);
      const w = new Writer(512).u16(chunk.length);
      for (const [name, value] of chunk) {
        const nameBytes = Buffer.from(String(name), 'latin1').subarray(0, 255);
        const valueBytes = Buffer.from(String(value), 'latin1').subarray(0, 255);
        w.u8(nameBytes.length).bytes(nameBytes).u8(valueBytes.length).bytes(valueBytes);
      }
      this.write('sv', w.done());
    }
  }

  accept(init, self) {
    this.selfBzoId = String(self.id);
    this.accepted = true;
    this.accepting = true;
    this.write('ac', new Writer(1).u8(this.selfSlot).done());
    this.writeVars(init.bzdb);
    this.flagUpdate(init.flags || []);
    for (const record of init.players || []) {
      if (String(record.id) === this.selfBzoId) continue;
      if (record.joined === false) continue;
      this.addPlayer(record);
      if (record.alive) this.alive(record);
    }
    this.addPlayer(self);
    // `sendIPUpdate(playerIndex, -1)`: everyone's, in one list, to an
    // arriving admin.
    this.adminInfo([...this.players.keys()]);
    this.accepting = false;
    // bzo spawns a player as it joins; the client starts its tank where
    // MsgAlive says (playing.cxx:2370), asked for or not.
    if (self.alive) this.alive(self);
    // `sendTeamUpdate` to an arrival (bzfs.cxx:2385).
    if (Array.isArray(init.teamScores) && init.teamScores.length > 0) this.teamUpdate(init.teamScores);
    if (init.rabbitId !== null && init.rabbitId !== undefined) {
      this.write('nR', new Writer(1).u8(this.slotFor(init.rabbitId)).done());
    }
  }

  // One of bzo's own messages to this player, as bzfs would have said it.
  handle(message) {
    switch (message.type) {
      case 'init':
        this.pending = message;
        break;
      case 'playerJoined':
        if (!this.accepted) {
          // Our own join is what bzo answers MsgEnter with.
          if (this.pending && this.isSelf(message.player)) this.accept(this.pending, message.player);
          break;
        }
        if (!this.isSelf(message.player)) this.addPlayer(message.player);
        break;
      case 'playerLeft':
        if (this.accepted) this.removePlayer(message.id);
        break;
      case 'matchStart':
        // resetPlayerScores (bzfs.cxx:695): everybody back to nothing.
        if (this.accepted) {
          this.scores([...new Set([this.selfBzoId, ...this.players.keys()])]
            .filter((id) => id !== null).map((id) => ({ id })));
        }
        break;
      case 'playerUpdated':
        if (this.accepted && message.player) {
          this.score(message.player);
          this.playerInfo(message.player);
        }
        break;
      case 'alive':
        if (this.accepted && message.player) this.alive(message.player);
        break;
      case 'pm':
        if (this.accepted && String(message.id) !== this.selfBzoId) this.playerUpdate(message);
        break;
      case 'pt':
        // A teleport (MsgTeleport, `sendTeleport` bzfs.cxx:4339), then where
        // it came out.
        if (!this.accepted || String(message.id) === this.selfBzoId) break;
        this.write('tp', new Writer(5).u8(this.slotFor(message.id))
          .u16(Number.isInteger(message.fromFaceId) ? message.fromFaceId : 0)
          .u16(Number.isInteger(message.toFaceId) ? message.toFaceId : 0).done());
        this.playerUpdate(message);
        break;
      case 'pmBatch':
        if (!this.accepted) break;
        for (const move of message.moves || []) {
          if (String(move.id) !== this.selfBzoId) this.playerUpdate(move);
        }
        break;
      case 'killed': {
        if (!this.accepted) break;
        const victim = this.players.get(String(message.victimId));
        if (victim) victim.alive = false;
        const reason = DEATH_REASONS[message.reason] ?? DEATH_REASONS.shot;
        const w = new Writer(14)
          .u8(this.slotFor(message.victimId))
          .u8(message.shooterId === null || message.shooterId === undefined
            ? SERVER_PLAYER : this.slotFor(message.shooterId))
          .i16(reason)
          .i16(message.projectileId ? this.shots.get(message.projectileId)?.id ?? -1 : -1)
          .flag(message.shooterFlag);
        if (reason === DEATH_REASONS.physicsDriver) w.i32(Number.isInteger(message.phydrv) ? message.phydrv : -1);
        this.write('kl', w.done());
        // bzfs follows MsgKilled with the killer's and victim's scores
        // (bzfs.cxx:3487), which a BZFlag client does not tally itself.
        const ids = [...new Set([message.shooterId, message.victimId]
          .filter((id) => id !== null && id !== undefined).map(String))];
        const records = ids.map((id) => {
          const score = this.scoreOf(id);
          return score ? { id, ...score } : null;
        }).filter(Boolean);
        if (records.length) this.scores(records);
        break;
      }
      case 'shotBegin': {
        if (!this.accepted) break;
        // Its own shot, already flying on its screen: only the name is new.
        if (String(message.playerId) === this.selfBzoId) {
          if (this.ownShotPending !== null) {
            this.shots.set(message.id, { id: this.ownShotPending, shooter: this.selfSlot });
          }
          break;
        }
        const config = this.config();
        // `_reloadTime`, upstream's default being `_shotRange / _shotSpeed`.
        const lifetime = (Number(config.SHOT_LIFETIME) / 1000)
          || ((Number(config.SHOT_RANGE) || 350) / (Number(config.SHOT_SPEED) || 100));
        this.write('sb', new Writer(48)
          .f32(this.timestamp())
          .u8(this.slotFor(message.playerId))
          .u16(this.shotId(message.id, message.shotSlot, this.slotFor(message.playerId)))
          .vec3([message.x, message.y, message.z])
          // The fired velocity, which `shotBegin` carries as MsgShotBegin does;
          // the client's strategy applies the flag.
          .vec3([Number(message.vx) || 0, Number(message.vy) || 0, Number(message.vz) || 0])
          .f32(0)
          .i16(this.teamIndex(message.team))
          .flag(message.flag)
          .f32(lifetime)
          .done());
        // A missile fired already locked: the receiver learns its target the
        // way bzfs relays it, from the shooter's first MsgGMUpdate.
        // A missile flies as it was fired, so its fired velocity is its
        // velocity.
        if (message.target !== null && message.target !== undefined) {
          const vx = Number(message.vx) || 0;
          const vy = Number(message.vy) || 0;
          const vz = Number(message.vz) || 0;
          const speed = Math.hypot(vx, vy, vz);
          this.missileUpdate({
            id: message.id,
            x: message.x,
            y: message.y,
            z: message.z,
            dirX: speed ? vx / speed : 0,
            dirY: speed ? vy / speed : 0,
            dirZ: speed ? vz / speed : 0,
            speed,
            team: message.team,
          }, message.target);
        }
        break;
      }
      case 'shotEnd': {
        if (!this.accepted) break;
        const shot = this.shots.get(message.id);
        if (shot === undefined) break;
        this.write('se', new Writer(5).u8(shot.shooter).u16(shot.id).u16(message.reason).done());
        this.shots.delete(message.id);
        break;
      }
      case 'message': {
        if (!this.accepted) break;
        const text = String(message.text ?? '');
        const w = new Writer(text.length + 4)
          .u8(this.sourceSlot(message.src))
          .u8(this.sourceSlot(message.dst))
          .u8(message.msgType === 'action' ? 1 : 0);
        w.bytes(Buffer.from(`${text.slice(0, 120)}\0`, 'latin1'));
        this.write('mg', w.done());
        break;
      }
      case 'flagUpdate':
        if (this.accepted) this.flagUpdate(message.flags || []);
        break;
      case 'grabFlag':
      case 'dropFlag': {
        if (!this.accepted || !message.flag) break;
        const w = new Writer(60).u8(this.slotFor(message.playerId));
        this.flagBody(w, message.flag);
        this.write(message.type === 'grabFlag' ? 'gf' : 'df', w.done());
        break;
      }
      case 'transferFlag': {
        if (!this.accepted || !message.flag) break;
        const w = new Writer(60).u8(this.slotFor(message.fromId)).u8(this.slotFor(message.toId));
        this.flagBody(w, message.flag);
        this.write('tf', w.done());
        break;
      }
      case 'captureFlag':
        if (this.accepted) {
          this.write('cf', new Writer(5)
            .u8(this.slotFor(message.playerId)).u16(message.index).u16(message.team).done());
        }
        break;
      case 'nearFlag': {
        // `sendClosestFlagMessage` (bzfs.cxx:512): where, and the flag's name.
        if (!this.accepted || !message.position) break;
        const key = `${message.index}:${message.flagType}`;
        if (key === this.lastNearFlag) break;
        this.lastNearFlag = key;
        const name = Buffer.from(String(this.flagName(message.flagType)), 'latin1');
        const w = new Writer(16 + name.length)
          .vec3([message.position.x, message.position.y, message.position.z])
          .u32(name.length)
          .bytes(name);
        this.write('Nf', w.done());
        break;
      }
      case 'gmUpdate':
        // A shooter's lock moved; every missile it has in the air turns.
        if (!this.accepted || String(message.playerId) === this.selfBzoId) break;
        for (const shot of this.guidedShots(String(message.playerId))) {
          this.missileUpdate(shot, message.targetId);
        }
        break;
      case 'positionCorrection':
        // An operator's `/mv`. Upstream has no message that moves a client's
        // own tank but the one that spawns it, MsgAlive, which the client
        // takes as "start here" (playing.cxx:2370).
        if (this.accepted && message.moved === true) {
          this.write('al', new Writer(17)
            .u8(this.selfSlot)
            .vec3([message.x, message.y, message.z])
            .f32(message.a)

            .done());
        }
        break;
      case 'teamUpdate':
        if (this.accepted && Array.isArray(message.teams)) this.teamUpdate(message.teams);
        break;
      case 'scoreOver':
        // MsgScoreOver (bzfs.cxx:3319, :3520): who reached the limit, and
        // the team, or `NoTeam` where a player's own score did.
        if (this.accepted) {
          this.write('so', new Writer(3)
            .u8(message.playerId === null || message.playerId === undefined ? NO_PLAYER : this.slotFor(message.playerId))
            .u16(message.team ? this.teamIndex(message.team) : NO_TEAM)
            .done());
        }
        break;
      case 'playerPaused':
      case 'playerUnpaused':
        // MsgPause (`pausePlayer`, bzfs.cxx:2778): who, and whether. Its own
        // pause is the client's to have started.
        if (this.accepted && String(message.playerId) !== this.selfBzoId) {
          this.write('pa', new Writer(2)
            .u8(this.slotFor(message.playerId)).u8(message.type === 'playerPaused' ? 1 : 0).done());
        }
        break;
      case 'autopilot':
        if (this.accepted && String(message.playerId) !== this.selfBzoId) {
          this.autopilot(message.playerId, message.on === true);
        }
        break;
      case 'newRabbit':
        if (this.accepted) this.write('nR', new Writer(1).u8(this.slotFor(message.playerId)).done());
        break;
      case 'teleport':
        if (this.accepted) {
          this.write('tp', new Writer(5).u8(this.slotFor(message.playerId)).u16(0).u16(0).done());
        }
        break;
      case 'timeUpdate':
        if (this.accepted && message.timeLeft !== null && message.timeLeft !== undefined) {
          this.write('to', new Writer(4).i32(message.timeLeft).done());
        }
        break;
      case 'setVar':
        if (this.accepted) {
          const nameBytes = Buffer.from(String(message.name), 'latin1').subarray(0, 255);
          const valueBytes = Buffer.from(String(message.value ?? ''), 'latin1').subarray(0, 255);
          this.write('sv', new Writer(4 + nameBytes.length + valueBytes.length)
            .u16(1).u8(nameBytes.length).bytes(nameBytes).u8(valueBytes.length).bytes(valueBytes).done());
        }
        break;
      default:
        break;
    }
  }

  // `init` names this connection's own bzo player before it has joined.
  isSelf(record) {
    return Boolean(record && this.pending?.player && String(record.id) === String(this.pending.player.id));
  }
}

module.exports = {
  NativeTranslator,
  moveFromBzfs,
  shootFromBzfs,
  decodeEnter,
  decodeClientMessage,
  ALL_PLAYERS,
  SERVER_PLAYER,
};
