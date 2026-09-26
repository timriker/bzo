/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// A bzfs connection held open on one browser's behalf -- the live half of the
// proxy, where `remote-world-import.cjs` is the one-shot half. That file
// fetches a world and hangs up; this joins for real, keeps what bzfs tells a
// joining player, and stays on the server. One of these per proxied browser,
// because bzfs allots a `PlayerId` per connection and has no multiplexing.
// See docs/proxy-plan.md.
//
// The wire format is `remote-world-import.cjs`'s, imported rather than
// repeated: same framing, same reader, same `MsgEnter` layout.

const net = require('node:net');
const dgram = require('node:dgram');
const {
  PROTOCOL_VERSION,
  Reader,
  sendFrame,
  createFrameReader,
  buildEnterPayload,
  decodeSetVars,
} = require('./remote-world-import.cjs');

// `CtfTeams` (`global.h`): the teams MsgTeamUpdate can carry, which stops
// before observer -- rogue, red, green, blue, purple.
const CTF_TEAMS = 5;
// `ObserverTeam` (`global.h:59`), which is also where the CTF teams stop: a
// session watches unless it is told to play.
const OBSERVER_TEAM = 5;
const CALLSIGN_LEN = 32;
const MOTTO_LEN = 128;
// `MessageLen`, including the terminating NUL (`global.h:35`). A chat line is
// this wide on the wire whatever it says.
const MESSAGE_LEN = 128;
// The PlayerIds that are not players (`Address.h:73-78`). A team destination
// is `FirstTeam` minus the team's own index, which is why teams count down.
const NO_PLAYER = 255;
const ALL_PLAYERS = 254;
const SERVER_PLAYER_ID = 253;
const ADMIN_PLAYERS = 252;
const FIRST_TEAM = 251;
const LAST_REAL_PLAYER = FIRST_TEAM - 8;
// `MessageType` (`global.h:50`).
const CHAT_MESSAGE = 0;
const ACTION_MESSAGE = 1;

// The codes `ServerLink::send` puts on UDP: shots, player updates, guided
// missile updates, and the link handshake itself.
const UDP_CODES = new Set(['sb', 'se', 'pu', 'ps', 'gm', 'of', 'og']);

// How long the join may take before the browser is told it failed. The same
// list-server round trip the login probe waits on happens inside it.
const JOIN_TIMEOUT_MS = 20000;
// bzfs concludes its answer to `MsgEnter` with the joining player's own
// `MsgAddPlayer` (bzfs.cxx:2426), but sends the rabbit and the match clock
// after that. Rather than guess at which trailers apply to this target, the
// burst is closed a beat after our own record arrives.
const BURST_TRAILER_MS = 250;

function readFixedString(r, length) {
  return r.bytes(length).toString('latin1').replace(/\0.*$/s, '');
}

// MsgAddPlayer: `GameKeeper::Player::packPlayerUpdate` -- id, then
// `PlayerInfo::packUpdate` (type, team), `Score::pack` (wins, losses, tks) and
// `PlayerInfo::packId` (callsign, motto).
function decodeAddPlayer(payload) {
  const r = new Reader(payload);
  return {
    id: r.u8(),
    type: r.u16(),
    team: r.u16(),
    wins: r.u16(),
    losses: r.u16(),
    tks: r.u16(),
    callsign: readFixedString(r, CALLSIGN_LEN),
    motto: readFixedString(r, MOTTO_LEN),
  };
}

// MsgTeamUpdate: a count, then that many (team index, `Team::pack`) pairs --
// so one message carries every team or only the one that just changed.
function decodeTeamUpdate(payload) {
  const r = new Reader(payload);
  const count = r.u8();
  const teams = [];
  for (let i = 0; i < count && r.remaining >= 8; i += 1) {
    teams.push({ team: r.u16(), size: r.u16(), wins: r.u16(), losses: r.u16() });
  }
  return teams;
}

// MsgFlagUpdate: a count, then that many (flag index, `Flag::pack`). A flag
// nobody is carrying and no team owns is packed by `fakePack`, which writes
// the same layout with the type blanked -- bzfs hiding what a superflag is
// until somebody picks it up, exactly as bzo's own `getFlagState` does.
// One `FlagInfo::pack`: the slot's index, then `Flag::pack`. 57 bytes, and
// the same body a grab, a drop and a steal each carry one of.
function readFlag(r) {
  return {
    index: r.u16(),
    type: r.flagAbbv(),
    status: r.u16(),
    endurance: r.u16(),
    owner: r.u8(),
    position: r.vec3(),
    launchPosition: r.vec3(),
    landingPosition: r.vec3(),
    flightTime: r.f32(),
    flightEnd: r.f32(),
    initialVelocity: r.f32(),
  };
}

const FLAG_PACK_LEN = 57;

function decodeFlagUpdate(payload) {
  const r = new Reader(payload);
  const count = r.u16();
  const flags = [];
  for (let i = 0; i < count && r.remaining >= FLAG_PACK_LEN; i += 1) flags.push(readFlag(r));
  return flags;
}

// MsgGrabFlag and MsgDropFlag: who, then the flag as it now stands
// (bzfs.cxx:2689, :3727).
function decodeFlagHolder(payload) {
  const r = new Reader(payload);
  return { id: r.u8(), flag: readFlag(r) };
}

// MsgTransferFlag: from, to, then the flag -- a Steal, which is the one way a
// flag changes hands without a drop (bzfs.cxx:5172).
function decodeFlagTransfer(payload) {
  const r = new Reader(payload);
  return { from: r.u8(), to: r.u8(), flag: readFlag(r) };
}

// MsgShotBegin: `FiringInfo::pack` -- when it was fired, the shot itself
// (`ShotUpdate::pack`: who, which shot, where, how fast, and the shooter's
// team), what flag fired it, and how long it lives.
function decodeShotBegin(payload) {
  const r = new Reader(payload);
  const timeSent = r.f32();
  const player = r.u8();
  // The low byte is the player's own shot slot and the high byte is a counter
  // that makes a reused slot a different shot (`bzfs.cxx:4142`).
  const id = r.u16();
  return {
    timeSent,
    player,
    id,
    slot: id & 0xff,
    pos: r.vec3(),
    velocity: r.vec3(),
    dt: r.f32(),
    team: (r.u16() << 16) >> 16,
    flag: r.flagAbbv(),
    lifetime: r.f32(),
  };
}

// MsgShotEnd: who fired it, which shot, and why it stopped (bzfs.cxx:4327).
// No position -- where it ended is where the receiver had already drawn it.
function decodeShotEnd(payload) {
  const r = new Reader(payload);
  const player = r.u8();
  const id = (r.u16() << 16) >> 16;
  return { player, id: id & 0xffff, reason: r.u16() };
}

// MsgCaptureFlag: who capped, which flag slot, and the team that lost it
// (bzfs.cxx:3979). No flag body -- a captured flag is about to be reset, and
// the `MsgFlagUpdate` for that says where it went.
function decodeCapture(payload) {
  const r = new Reader(payload);
  return { id: r.u8(), index: r.u16(), team: r.u16() };
}

// MsgMessage: from, to, type, then a NUL-terminated string (`sendMessage`,
// bzfs.cxx:1701).
function decodeMessage(payload) {
  const r = new Reader(payload);
  const from = r.u8();
  const to = r.u8();
  const kind = r.u8();
  return { from, to, kind, text: payload.toString('latin1', 3).replace(/\0.*$/s, '') };
}

// `PlayerState`'s status bits (`PlayerState.h:25`). Only the ones bzo has
// something to do with are named; the rest ride along in `status`.
const PLAYER_STATUS = Object.freeze({
  ALIVE: 1 << 0,
  PAUSED: 1 << 1,
  EXPLODING: 1 << 2,
  TELEPORTING: 1 << 3,
  FLAG_ACTIVE: 1 << 4,
  CROSSING_WALL: 1 << 5,
  FALLING: 1 << 6,
  ON_DRIVER: 1 << 7,
  USER_INPUTS: 1 << 8,
  JUMP_JETS: 1 << 9,
  PLAY_SOUND: 1 << 10,
});

// `MsgPlayerUpdateSmall`'s fixed point (`PlayerState.cxx:26-35`). bzo rounds
// to two decimals on the way out and calls that its whole compression story;
// this is upstream's, and it is why a small update is 16 bytes where a full
// one is 32.
const SMALL_SCALE = 32766;
const SMALL_MAX_DIST = 0.02 * SMALL_SCALE;
const SMALL_MAX_VEL = 0.01 * SMALL_SCALE;
const SMALL_MAX_ANG_VEL = 0.001 * SMALL_SCALE;

// MsgPlayerUpdate / MsgPlayerUpdateSmall: a float timestamp, the player id,
// then `PlayerState::pack` -- which is one layout in two encodings, plus four
// optional tails the status bits announce. The tails are read because skipping
// them would mean guessing a length, and `phydrv` and the user's own inputs
// are worth having when the rest of the proxy catches up with them.
function decodePlayerUpdate(payload, small) {
  const r = new Reader(payload);
  const timestamp = r.f32();
  const id = r.u8();
  const order = r.i32();
  // A signed short, and bit 10 is a real flag, so it is read as one.
  const status = (r.u16() << 16) >> 16;
  let pos;
  let velocity;
  let azimuth;
  let angVel;
  if (small) {
    const i16 = () => (r.u16() << 16) >> 16;
    pos = [i16(), i16(), i16()].map((v) => (v * SMALL_MAX_DIST) / SMALL_SCALE);
    velocity = [i16(), i16(), i16()].map((v) => (v * SMALL_MAX_VEL) / SMALL_SCALE);
    azimuth = (i16() * Math.PI) / SMALL_SCALE;
    angVel = (i16() * SMALL_MAX_ANG_VEL) / SMALL_SCALE;
  } else {
    pos = r.vec3();
    velocity = r.vec3();
    azimuth = r.f32();
    angVel = r.f32();
  }
  const update = { timestamp, id, order, status, pos, velocity, azimuth, angVel, phydrv: 0 };
  if (status & PLAYER_STATUS.JUMP_JETS) r.u16();
  if (status & PLAYER_STATUS.ON_DRIVER) update.phydrv = r.i32();
  if (status & PLAYER_STATUS.USER_INPUTS) { r.u16(); r.u16(); }
  return update;
}

// MsgAlive: who, where, and which way they are facing (playing.cxx:2354).
function decodeAlive(payload) {
  const r = new Reader(payload);
  return { id: r.u8(), pos: r.vec3(), azimuth: r.f32() };
}

// MsgKilled: victim, killer, why, which shot, and what the killer was carrying
// (playing.cxx:2451). A physics-driver death carries the driver as well, which
// is the one reason with a tail.
function decodeKilled(payload) {
  const r = new Reader(payload);
  const victim = r.u8();
  const killer = r.u8();
  const reason = (r.u16() << 16) >> 16;
  const shotId = (r.u16() << 16) >> 16;
  const flag = r.flagAbbv();
  return { victim, killer, reason, shotId, flag };
}

// MsgScore: a count, then that many (id, `Score::pack`).
function decodeScores(payload) {
  const r = new Reader(payload);
  const count = r.u8();
  const scores = [];
  for (let i = 0; i < count && r.remaining >= 7; i += 1) {
    scores.push({ id: r.u8(), wins: r.u16(), losses: r.u16(), tks: r.u16() });
  }
  return scores;
}

// MsgPlayerInfo: a count, then that many (id, properties), where the
// properties are `PlayerAttribute` -- registered, verified, admin
// (`Protocol.h:53`). These are the three upstream's own scoreboard draws as
// `-`, `+` and `@`, and the only place a proxy learns them: what a player is
// on the target is the target's to say.
function decodePlayerInfo(payload) {
  const r = new Reader(payload);
  const count = r.u8();
  const info = [];
  for (let i = 0; i < count && r.remaining >= 2; i += 1) {
    const id = r.u8();
    const properties = r.u8();
    info.push({
      id,
      registered: (properties & 1) !== 0,
      verified: (properties & 2) !== 0,
      admin: (properties & 4) !== 0,
    });
  }
  return info;
}

// A live connection to one bzfs. `connect()` resolves with the state bzfs
// describes to a joining player; after that the events carry what changes.
// Nothing here simulates: a session holds what it was told and nothing more.
class BzfsSession {
  constructor({
    host, port, callsign, motto = '', token = '', version,
    team = OBSERVER_TEAM, timeout = JOIN_TIMEOUT_MS,
  }) {
    this.host = host;
    this.port = port;
    this.callsign = callsign;
    this.motto = motto;
    this.token = token;
    this.version = version;
    this.team = team;
    this.timeout = timeout;
    // Ours on the target, handed over in the handshake before anything else.
    // Every player in this session is named by a bzfs id, this one included.
    this.playerId = null;
    this.state = {
      vars: new Map(),
      teams: [],
      flags: [],
      players: new Map(),
      // Where each player is and what they are doing, by bzfs id. Separate
      // from `players`, which is who they are: one is replaced wholesale by
      // `MsgAddPlayer` and the other is written many times a second.
      motion: new Map(),
      // `MsgGameSettings`, raw: `decodeGameSettings` in the importer is the
      // one reader of this layout, and it lives with the rest of the world
      // decoding rather than here.
      gameSettings: null,
      rabbitId: null,
      timeLeft: null,
      messages: [],
    };
    this.socket = null;
    // The unreliable half, once bzfs has confirmed it (`openUdpLink`).
    this.udp = null;
    this.udpOut = false;
    this.closed = false;
    // `PlayerState::order`, which counts this player's own updates so a
    // receiver can drop one that arrived late.
    this.order = 0;
    this.startedAt = Date.now();
    // `ShotUpdate::id`'s high byte, per slot.
    this.shotSalt = new Map();
    this.handlers = new Map();
  }

  on(event, handler) {
    this.handlers.set(event, handler);
    return this;
  }

  emit(event, value) {
    const handler = this.handlers.get(event);
    if (handler) handler(value);
  }

  connect() {
    return new Promise((resolve, reject) => {
      // Upstream bzfs is IPv4 only, the same reason the importer forces the
      // family: a target named by a dual-stack host must not be dialled over
      // v6, and a proxy's target is a private address anyway.
      const socket = net.createConnection({ host: this.host, port: this.port, family: 4 });
      this.socket = socket;
      const { readExact, readFrame } = createFrameReader(socket);
      let settled = false;
      let burstTimer = null;

      const watchdog = setTimeout(() => fail(new Error('timed out joining')), this.timeout);
      const fail = (err) => {
        clearTimeout(watchdog);
        clearTimeout(burstTimer);
        if (!settled) {
          settled = true;
          this.destroy();
          reject(err);
          return;
        }
        this.handleClose(err);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        resolve(this.state);
      };

      socket.on('error', fail);
      socket.on('close', () => fail(new Error('connection closed')));

      socket.on('connect', async () => {
        try {
          socket.write('BZFLAG\r\n\r\n');
          const version = (await readExact(8)).toString('ascii');
          const playerId = (await readExact(1)).readUInt8(0);
          if (version !== PROTOCOL_VERSION) {
            throw new Error(`protocol ${version} (bzo speaks ${PROTOCOL_VERSION})`);
          }
          if (playerId === 0xff) throw new Error('rejected (full, banned, or closed)');
          this.playerId = playerId;
          // Before the join rather than after it: bzfs accepts the link
          // request from a connection that has not entered yet
          // (bzfs.cxx:4664), so by the time this session can shoot the link
          // it would be kicked for lacking is already up.
          this.openUdpLink();

          // MsgWantSettings before joining, the way the world importer asks
          // for it: which game type this is and which of upstream's switches
          // are on -- ricochet above all, since it changes how every shot
          // this session forwards behaves.
          sendFrame(socket, 'ws');
          for (;;) {
            const { code, payload } = await readFrame();
            if (code === 'gs') { this.state.gameSettings = payload; break; }
            if (code === 'sk' || code === 'rj') break;
          }

          sendFrame(socket, 'en', buildEnterPayload({
            callsign: this.callsign,
            motto: this.motto,
            token: this.token,
            team: this.team,
            ...(this.version ? { version: this.version } : {}),
          }));

          for (;;) {
            const { code, payload } = await readFrame();
            if (code === 'rj') {
              const reason = payload.length > 2
                ? payload.toString('latin1', 2).replace(/\0.*$/s, '') : '';
              throw new Error(`refused${reason ? `: ${reason}` : ''}`);
            }
            if (code === 'sk') {
              const reason = payload.length > 0
                ? payload.toString('latin1').replace(/\0.*$/s, '') : '';
              throw new Error(`disconnected by the server${reason ? `: ${reason}` : ''}`);
            }
            this.handleFrame(code, payload);
            // Our own record concludes the answer to `MsgEnter`. What follows
            // it in the same breath -- the rabbit, the clock -- is taken as
            // part of the burst too, then the browser is told.
            if (!settled && code === 'ap' && burstTimer === null
              && this.state.players.has(this.playerId)) {
              burstTimer = setTimeout(succeed, BURST_TRAILER_MS);
            }
          }
        } catch (err) {
          fail(err);
        }
      });
    });
  }

  // Everything bzfs says, in one place, so the burst and the messages that
  // arrive an hour later are read by the same code.
  handleFrame(code, payload) {
    switch (code) {
      case 'sv':
        decodeSetVars(payload, this.state.vars);
        break;
      case 'tu': {
        const teams = decodeTeamUpdate(payload);
        for (const team of teams) {
          if (team.team < CTF_TEAMS) this.state.teams[team.team] = team;
        }
        this.emit('teams', this.state.teams);
        break;
      }
      case 'fu': {
        const flags = decodeFlagUpdate(payload);
        for (const flag of flags) this.state.flags[flag.index] = flag;
        this.emit('flags', flags);
        break;
      }
      case 'gf': {
        const grab = decodeFlagHolder(payload);
        this.state.flags[grab.flag.index] = grab.flag;
        this.emit('grab', grab);
        break;
      }
      case 'df': {
        const drop = decodeFlagHolder(payload);
        this.state.flags[drop.flag.index] = drop.flag;
        this.emit('drop', drop);
        break;
      }
      case 'tf': {
        const transfer = decodeFlagTransfer(payload);
        this.state.flags[transfer.flag.index] = transfer.flag;
        this.emit('transfer', transfer);
        break;
      }
      case 'cf': {
        const capture = decodeCapture(payload);
        this.emit('capture', capture);
        break;
      }
      case 'sb':
        this.emit('shotBegin', decodeShotBegin(payload));
        break;
      case 'se':
        this.emit('shotEnd', decodeShotEnd(payload));
        break;
      case 'ap': {
        const player = decodeAddPlayer(payload);
        this.state.players.set(player.id, player);
        this.emit('player', player);
        break;
      }
      case 'rp': {
        const id = payload.readUInt8(0);
        const player = this.state.players.get(id);
        this.state.players.delete(id);
        this.state.motion.delete(id);
        if (player) this.emit('playerLeft', player);
        break;
      }
      case 'pu':
      case 'ps': {
        const update = decodePlayerUpdate(payload, code === 'ps');
        const previous = this.state.motion.get(update.id);
        // `order` counts a player's own updates, and UDP may deliver them out
        // of sequence, so an older one is dropped rather than applied --
        // upstream's own test (`bzfs.cxx:5299`).
        if (previous && update.order <= previous.order) break;
        const motion = {
          order: update.order,
          status: update.status,
          pos: update.pos,
          velocity: update.velocity,
          azimuth: update.azimuth,
          angVel: update.angVel,
          alive: (update.status & PLAYER_STATUS.ALIVE) !== 0,
          paused: (update.status & PLAYER_STATUS.PAUSED) !== 0,
          falling: (update.status & PLAYER_STATUS.FALLING) !== 0,
          zoned: (update.status & PLAYER_STATUS.FLAG_ACTIVE) !== 0,
          at: Date.now(),
        };
        this.state.motion.set(update.id, motion);
        this.emit('motion', { id: update.id, motion });
        break;
      }
      case 'al': {
        const spawn = decodeAlive(payload);
        // A spawn is a position as much as an event, and the update that
        // would carry it has not arrived yet -- so the state starts here
        // rather than at wherever this player last died.
        this.state.motion.set(spawn.id, {
          order: -1,
          status: PLAYER_STATUS.ALIVE,
          pos: spawn.pos,
          velocity: [0, 0, 0],
          azimuth: spawn.azimuth,
          angVel: 0,
          alive: true,
          paused: false,
          falling: false,
          zoned: false,
          at: Date.now(),
        });
        this.emit('alive', spawn);
        break;
      }
      case 'kl': {
        const death = decodeKilled(payload);
        const motion = this.state.motion.get(death.victim);
        if (motion) motion.alive = false;
        this.emit('killed', death);
        break;
      }
      case 'pa': {
        const id = payload.readUInt8(0);
        const paused = payload.readUInt8(1) !== 0;
        const motion = this.state.motion.get(id);
        if (motion) motion.paused = paused;
        this.emit('pause', { id, paused });
        break;
      }
      case 'sc': {
        const scores = decodeScores(payload);
        for (const score of scores) {
          const player = this.state.players.get(score.id);
          if (!player) continue;
          player.wins = score.wins;
          player.losses = score.losses;
          player.tks = score.tks;
        }
        this.emit('scores', scores);
        break;
      }
      case 'pb': {
        const info = decodePlayerInfo(payload);
        for (const entry of info) {
          const player = this.state.players.get(entry.id);
          if (!player) continue;
          player.registered = entry.registered;
          player.verified = entry.verified;
          player.admin = entry.admin;
        }
        this.emit('info', info);
        break;
      }
      case 'nR':
        this.state.rabbitId = payload.readUInt8(0);
        this.emit('rabbit', this.state.rabbitId);
        break;
      case 'to':
        this.state.timeLeft = payload.readInt32BE(0);
        this.emit('time', this.state.timeLeft);
        break;
      case 'mg': {
        const message = decodeMessage(payload);
        if (message.from === SERVER_PLAYER_ID) this.state.messages.push(message.text);
        this.emit('message', message);
        break;
      }
      // A lag ping is answered rather than watched: bzfs counts the ones that
      // come back and kicks a client that stops answering (`lagKick`,
      // bzfs.cxx:4378). The reply is the same two bytes, as the upstream
      // client sends them (playing.cxx:3547).
      case 'pi':
        this.send('pi', payload);
        break;
      // bzfs heard our datagram and says so over TCP; from here the messages
      // that belong on UDP take it.
      case 'og':
        this.udpOut = true;
        this.emit('udp', true);
        break;
      default:
        break;
    }
    this.emit('frame', { code, payload });
  }

  // MsgMessage as a client sends one: the destination, then the text padded to
  // `MessageLen` (`playing.cxx:2001`). The sender and the message type are
  // bzfs's to fill in -- a client says only who it is for and what it says,
  // which is also why a `/` command is an ordinary chat line to everybody.
  sendChat(dst, text) {
    const payload = Buffer.alloc(1 + MESSAGE_LEN);
    payload.writeUInt8(dst, 0);
    // One byte short of the field, so the NUL upstream reads for is always
    // there. Node stops at the last whole character rather than splitting one.
    payload.write(String(text), 1, MESSAGE_LEN - 1, 'utf8');
    this.send('mg', payload);
  }

  // The UDP half of a bzfs connection: same host and port as the TCP one, and
  // the link is opened by sending `MsgUDPLinkRequest` from the socket that
  // wants to receive on it. bzfs answers `MsgUDPLinkEstablished` over TCP and
  // a `MsgUDPLinkRequest` back over UDP (`sendUDPupdate`, bzfs.cxx:329).
  //
  // A proxy opens one because a good client does, not only because it is
  // forced to: bzfs refuses a shot from a player whose end is not on UDP and
  // disconnects them for it (bzfs.cxx:5596), and the bulk messages -- player
  // updates, shots -- are the ones that ride it. Co-location is what makes it
  // cheap: over loopback there is neither the loss nor the head-of-line
  // blocking UDP exists to dodge.
  openUdpLink() {
    if (this.udp || this.playerId === null) return;
    const socket = dgram.createSocket('udp4');
    this.udp = socket;
    socket.on('error', () => this.closeUdpLink());
    // Frames arrive here the same way they do on TCP, except that a datagram
    // is a whole number of them -- no reassembly, so they are walked in place.
    socket.on('message', (datagram) => {
      let at = 0;
      while (at + 4 <= datagram.length) {
        const length = datagram.readUInt16BE(at);
        const code = datagram.toString('ascii', at + 2, at + 4);
        if (at + 4 + length > datagram.length) break;
        const payload = datagram.subarray(at + 4, at + 4 + length);
        at += 4 + length;
        this.handleFrame(code, payload);
      }
    });
    socket.bind(0, () => {
      // The request names this player, because it is the only thing tying the
      // datagram's source address to a connection bzfs already has.
      const payload = Buffer.alloc(1);
      payload.writeUInt8(this.playerId, 0);
      this.sendUdp('of', payload);
    });
  }

  closeUdpLink() {
    if (!this.udp) return;
    const socket = this.udp;
    this.udp = null;
    this.udpOut = false;
    try { socket.close(); } catch { /* already closed */ }
  }

  sendUdp(code, payload = Buffer.alloc(0)) {
    if (!this.udp) return;
    const header = Buffer.alloc(4);
    header.writeUInt16BE(payload.length, 0);
    header.write(code, 2, 2, 'ascii');
    try {
      this.udp.send(Buffer.concat([header, payload]), this.port, this.host);
    } catch {
      /* the link drops back to TCP on its own */
    }
  }

  // MsgAlive, which a client sends empty: where a tank spawns is the server's
  // to decide, and it answers with the position (`ServerLink::sendAlive`).
  // Only a session that entered on a playing team has anything to spawn.
  sendAlive() {
    this.send('al');
  }

  // MsgPlayerUpdate, in its full form: the timestamp, this player's id, then
  // `PlayerState::pack`'s long encoding. bzo sends the long one whatever the
  // numbers, since the short one is a size optimisation and this end is not
  // where the bytes are scarce.
  sendPlayerUpdate({ pos, velocity = [0, 0, 0], azimuth = 0, angVel = 0, status = PLAYER_STATUS.ALIVE }) {
    this.order += 1;
    const payload = Buffer.alloc(4 + 1 + 4 + 2 + 12 + 12 + 4 + 4);
    let at = 0;
    payload.writeFloatBE((Date.now() - this.startedAt) / 1000, at); at += 4;
    payload.writeUInt8(this.playerId, at); at += 1;
    payload.writeInt32BE(this.order, at); at += 4;
    payload.writeInt16BE(status, at); at += 2;
    for (const value of [...pos, ...velocity]) { payload.writeFloatBE(value, at); at += 4; }
    payload.writeFloatBE(azimuth, at); at += 4;
    payload.writeFloatBE(angVel, at); at += 4;
    this.send('pu', payload);
  }

  // Which messages ride UDP once the link is up, and it is upstream's own
  // list (`ServerLink::send`): the ones sent constantly, plus the link
  // messages themselves. Everything else goes over TCP, where order and
  // delivery are the point.
  // MsgShotBegin: `FiringInfo::pack`, the declaration upstream lets a client
  // make for itself. The shot id is the slot in its low byte and a counter in
  // its high one, so that reusing a slot is a different shot.
  sendShot({ slot = 0, pos, velocity, flag = '', lifetime = 3.5, team = 0 }) {
    const salt = (this.shotSalt.get(slot) || 0) + 1;
    this.shotSalt.set(slot, salt & 0xff);
    const payload = Buffer.alloc(4 + 1 + 2 + 12 + 12 + 4 + 2 + 2 + 4);
    let at = 0;
    payload.writeFloatBE((Date.now() - this.startedAt) / 1000, at); at += 4;
    payload.writeUInt8(this.playerId, at); at += 1;
    payload.writeUInt16BE((slot & 0xff) | ((salt & 0xff) << 8), at); at += 2;
    for (const value of [...pos, ...velocity]) { payload.writeFloatBE(value, at); at += 4; }
    payload.writeFloatBE(0, at); at += 4;
    payload.writeInt16BE(team, at); at += 2;
    payload.write(flag.padEnd(2, '\0'), at, 2, 'ascii'); at += 2;
    payload.writeFloatBE(lifetime, at);
    this.send('sb', payload);
    return (slot & 0xff) | ((salt & 0xff) << 8);
  }

  send(code, payload) {
    if (this.closed || !this.socket || this.socket.destroyed) return;
    if (this.udpOut && UDP_CODES.has(code)) {
      this.sendUdp(code, payload);
      return;
    }
    try {
      sendFrame(this.socket, code, payload);
    } catch {
      /* the close handler has it */
    }
  }

  handleClose(err) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', err || null);
  }

  destroy() {
    this.closed = true;
    this.closeUdpLink();
    if (this.socket) this.socket.destroy();
  }

  // MsgExit, then the socket. Telling the target is what frees the slot now
  // rather than when it times the connection out, and it is what puts the
  // part message in everyone's chat the way leaving should.
  close() {
    if (this.socket && !this.socket.destroyed) {
      // Over TCP whatever the link says: this is the message that frees the
      // slot, and it is the one thing here that must not be dropped.
      try { sendFrame(this.socket, 'ex'); } catch { /* already gone */ }
    }
    this.closeUdpLink();
    this.closed = true;
    if (this.socket) this.socket.destroy();
  }
}

module.exports = {
  BzfsSession,
  CTF_TEAMS,
  PLAYER_STATUS,
  MESSAGE_LEN,
  NO_PLAYER,
  ALL_PLAYERS,
  SERVER_PLAYER_ID,
  ADMIN_PLAYERS,
  FIRST_TEAM,
  LAST_REAL_PLAYER,
  CHAT_MESSAGE,
  ACTION_MESSAGE,
  decodePlayerUpdate,
  decodeAlive,
  decodeKilled,
  decodeScores,
  decodePlayerInfo,
  decodeAddPlayer,
  decodeTeamUpdate,
  decodeFlagUpdate,
  decodeFlagHolder,
  decodeFlagTransfer,
  decodeCapture,
  decodeShotBegin,
  decodeShotEnd,
  decodeMessage,
};
