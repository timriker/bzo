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
const CALLSIGN_LEN = 32;
const MOTTO_LEN = 128;
const SERVER_PLAYER_ID = 253;

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
function decodeFlagUpdate(payload) {
  const r = new Reader(payload);
  const count = r.u16();
  const flags = [];
  for (let i = 0; i < count && r.remaining >= 57; i += 1) {
    const index = r.u16();
    const type = r.flagAbbv();
    const status = r.u16();
    const endurance = r.u16();
    const owner = r.u8();
    flags.push({
      index,
      type,
      status,
      endurance,
      owner,
      position: r.vec3(),
      launchPosition: r.vec3(),
      landingPosition: r.vec3(),
      flightTime: r.f32(),
      flightEnd: r.f32(),
      initialVelocity: r.f32(),
    });
  }
  return flags;
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

// A live connection to one bzfs. `connect()` resolves with the state bzfs
// describes to a joining player; after that the events carry what changes.
// Nothing here simulates: a session holds what it was told and nothing more.
class BzfsSession {
  constructor({ host, port, callsign, motto = '', token = '', version, timeout = JOIN_TIMEOUT_MS }) {
    this.host = host;
    this.port = port;
    this.callsign = callsign;
    this.motto = motto;
    this.token = token;
    this.version = version;
    this.timeout = timeout;
    // Ours on the target, handed over in the handshake before anything else.
    // Every player in this session is named by a bzfs id, this one included.
    this.playerId = null;
    this.state = {
      vars: new Map(),
      teams: [],
      flags: [],
      players: new Map(),
      rabbitId: null,
      timeLeft: null,
      messages: [],
    };
    this.socket = null;
    this.closed = false;
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

          sendFrame(socket, 'en', buildEnterPayload({
            callsign: this.callsign,
            motto: this.motto,
            token: this.token,
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
        if (player) this.emit('playerLeft', player);
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
      default:
        break;
    }
    this.emit('frame', { code, payload });
  }

  send(code, payload) {
    if (this.closed || !this.socket || this.socket.destroyed) return;
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
    if (this.socket) this.socket.destroy();
  }

  // MsgExit, then the socket. Telling the target is what frees the slot now
  // rather than when it times the connection out, and it is what puts the
  // part message in everyone's chat the way leaving should.
  close() {
    if (this.socket && !this.socket.destroyed) {
      this.send('ex');
    }
    this.closed = true;
    if (this.socket) this.socket.destroy();
  }
}

module.exports = {
  BzfsSession,
  CTF_TEAMS,
  decodeAddPlayer,
  decodeTeamUpdate,
  decodeFlagUpdate,
  decodeMessage,
};
