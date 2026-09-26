/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Speaks just enough of the real BZFS wire protocol to fetch a live server's
// world database and turn it into a `.bzw` bzo can load -- the guts behind
// both `scripts/survey-live-maps.mjs` (a CLI survey across many servers) and
// server.js's `importMap` (one operator, one server, loaded straight into
// bzo's own maps/ for Map Viewer). This file is the single source of truth
// for the wire format so the two never drift apart; see the script for the
// long version of how the protocol and the binary world format work.
//
// The world download itself never sends MsgEnter, so it never occupies a
// player slot -- bzfs answers MsgQueryGame/MsgWantSettings/MsgWantWHash/
// MsgGetWorld to any connection, entered or not, same as bzfquery.py.
//
// The server's BZDB is the exception, and it costs something. A bzfs sends
// its world variables (MsgSetVar) only from `addPlayer`, after the player has
// actually been accepted (`bzfs.cxx:2361-2365`), so there is no way to read
// `_tankSpeed` or `_gravity` off a server without briefly being on it: one
// observer slot, one join and one part in everybody's chat. That is the whole
// price of knowing what a map is really played at, and an import that skips
// it silently writes a map that plays by bzo's defaults instead of the
// server's -- so it is done by default, as a momentary observer that leaves
// again the instant the variables arrive, and `enterForVariables: false`
// turns it off for a caller that would rather stay invisible.

const net = require('node:net');
const { BZDB_DEFAULTS } = require('./bzdb-defaults.cjs');
const zlib = require('node:zlib');

const PROTOCOL_VERSION = 'BZFS0221';
const DEFAULT_LIST_SERVER = 'https://my.bzflag.org/db/';

// A malformed or hostile "server" could claim an endless `bytesLeft` on every
// MsgGetWorld reply; this is the only thing standing between that and
// unbounded memory growth in the live bzo process (the CLI script has no such
// guard -- a runaway `node` process there is the user's own problem to Ctrl-C).
const MAX_WORLD_DATABASE_BYTES = 64 * 1024 * 1024;

// MsgEnter's fixed-width fields (`include/global.h`, `ServerLink::sendEnter`).
const CALLSIGN_LEN = 32;
const MOTTO_LEN = 128;
const TOKEN_LEN = 22;
const VERSION_LEN = 60;
const PLAYER_ID_LEN = 1;
const OBSERVER_TEAM = 5;
const TANK_PLAYER = 0;
// Who the remote server sees for the moment this is joined. The version
// string is read with `sscanf(..., "%d.%d.%d", ...)` upstream, so it leads
// with digits an operator's logs can sort, and says what it is after them.
const IMPORT_CALLSIGN = 'bzo-import';
const IMPORT_MOTTO = 'bzo map import -- https://github.com/timriker/bzo';
const IMPORT_CLIENT_VERSION = `0.0.0 bzo`;
// Long enough for a busy server to get through MsgAccept and its BZDB dump,
// short enough that a server which answers neither does not hold the import
// open. Failure here is never fatal: the map still imports, without `-set`.
const ENTER_TIMEOUT_MS = 8000;

function findPublicServer(servers, host, port) {
  if (!Array.isArray(servers) || typeof host !== 'string' || host === ''
    || !Number.isInteger(port)) return null;
  const wantedHost = host.toLowerCase();
  return servers.find((server) =>
    typeof server?.host === 'string'
    && server.host.toLowerCase() === wantedHost
    && server.port === port) || null;
}

// ---------------------------------------------------------------------------
// Wire-format reader: a cursor over a Buffer, matching nboUnpack* semantics
// (big-endian, as bzflag's `nbo` -- network byte order -- helpers pack them).
// ---------------------------------------------------------------------------

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.o = 0;
  }

  u8() { const v = this.buf.readUInt8(this.o); this.o += 1; return v; }
  u16() { const v = this.buf.readUInt16BE(this.o); this.o += 2; return v; }
  i32() { const v = this.buf.readInt32BE(this.o); this.o += 4; return v; }
  u32() { const v = this.buf.readUInt32BE(this.o); this.o += 4; return v; }
  f32() { const v = this.buf.readFloatBE(this.o); this.o += 4; return v; }
  vec3() { return [this.f32(), this.f32(), this.f32()]; }
  skip(n) { this.o += n; }
  bytes(n) { const b = this.buf.subarray(this.o, this.o + n); this.o += n; return b; }

  str() {
    const len = this.u32();
    const s = this.buf.toString('utf8', this.o, this.o + len);
    this.o += len;
    return s;
  }

  flagAbbv() {
    return this.bytes(2).toString('latin1').replace(/\0+$/, '');
  }

  get remaining() { return this.buf.length - this.o; }
}

// ---------------------------------------------------------------------------
// Server list: POST action=LIST to the list server and parse the plain-text
// reply ($HOME/bzflag/src/game/ServerList.cxx, readServerList/checkEchos).
// Each line is "host:port version pingInfoHex address title...". The hex
// blob is PingPacket::packHex ($HOME/bzflag/src/net/Ping.cxx) -- 8 uint16's
// then 13 uint8's -- which already carries game type, options and every
// team's current/max player count. Decoding it here means the whole running
// server list, with live player counts, comes from one HTTP request; no
// server in the list is actually connected to until an operator picks one.
// ---------------------------------------------------------------------------

function decodePingHex(hex) {
  if (typeof hex !== 'string' || hex.length !== 58) return null;
  let o = 0;
  const u16 = () => { const v = parseInt(hex.slice(o, o + 4), 16); o += 4; return v; };
  const u8 = () => { const v = parseInt(hex.slice(o, o + 2), 16); o += 2; return v; };
  const gameType = u16();
  const gameOptionsBits = u16();
  const maxShots = u16();
  const shakeWins = u16();
  const shakeTimeout = u16();
  const maxPlayerScore = u16();
  const maxTeamScore = u16();
  const maxTime = u16();
  const maxPlayers = u8();
  // Rogue, red, green, blue, purple, observer -- the same order `-mp
  // a,b,c,d,e,f` already takes (`BZFLAG_MP_TEAM_ORDER`, server/teams.cjs),
  // so `teamMaximums` can be written back out unchanged.
  const rogueCount = u8(); const rogueMax = u8();
  const redCount = u8(); const redMax = u8();
  const greenCount = u8(); const greenMax = u8();
  const blueCount = u8(); const blueMax = u8();
  const purpleCount = u8(); const purpleMax = u8();
  const observerCount = u8(); const observerMax = u8();
  if (Number.isNaN(gameType) || Number.isNaN(observerMax)) return null;
  const players = rogueCount + redCount + greenCount + blueCount + purpleCount;
  return {
    style: GAME_STYLES[gameType] || `type${gameType}`,
    gameOptionsBits, maxShots, shakeWins, shakeTimeout,
    maxPlayerScore, maxTeamScore, maxTime, maxPlayers,
    players, observerCount,
    teamMaximums: [rogueMax, redMax, greenMax, blueMax, purpleMax, observerMax],
  };
}

async function fetchServerList(url, version) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `action=LIST&version=${encodeURIComponent(version)}`,
  });
  const text = await res.text();
  const servers = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('NOTICE:')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;
    const [nameport, ver, infoHex, , ...titleParts] = parts;
    if (ver !== version) continue;
    let host = nameport;
    let port = 5154;
    const idx = nameport.lastIndexOf(':');
    if (idx !== -1) {
      host = nameport.slice(0, idx);
      port = parseInt(nameport.slice(idx + 1), 10) || 5154;
    }
    servers.push({ host, port, title: titleParts.join(' '), info: decodePingHex(infoHex) });
  }
  return servers;
}

// ---------------------------------------------------------------------------
// Protocol: connect, skip MsgEnter entirely (bzfs answers world-download
// messages before a player has entered -- see the `!isCompletelyAdded()`
// switch in bzfs.cxx's handleCommand), and page through the world database.
// ---------------------------------------------------------------------------

function sendFrame(socket, codeStr, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(payload.length, 0);
  header.write(codeStr, 2, 2, 'ascii');
  socket.write(Buffer.concat([header, payload]));
}

// The other direction: bzfs frames everything the same way, so one buffered
// reader serves every connection this file makes. `readExact` hands back
// whole slices in arrival order, which is why the waiters are a queue rather
// than a single pending read.
function createFrameReader(socket) {
  let buffer = Buffer.alloc(0);
  const waiters = [];

  function pump() {
    while (waiters.length && buffer.length >= waiters[0].n) {
      const w = waiters.shift();
      const out = buffer.subarray(0, w.n);
      buffer = buffer.subarray(w.n);
      w.resolve(out);
    }
  }
  socket.on('data', (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    pump();
  });

  function readExact(n) {
    return new Promise((res) => {
      waiters.push({ n, resolve: res });
      pump();
    });
  }
  async function readFrame() {
    const header = await readExact(4);
    const len = header.readUInt16BE(0);
    const code = header.toString('ascii', 2, 4);
    const payload = len > 0 ? await readExact(len) : Buffer.alloc(0);
    return { code, payload };
  }
  return { readExact, readFrame };
}

// MsgEnter's payload: `ServerLink::sendEnter`'s own fixed-width layout, with
// the trailing PlayerId-sized slack it also sends. Every string is NUL-padded
// to its field width rather than length-prefixed, which is why this is built
// as one zeroed buffer and written into.
//
// The token field is the one a forwarded global login is written into. An
// import leaves it zeroed: `bzo-import` is an unregistered callsign, which is
// what an anonymous join is, and a server that demands registration rejects
// it and the import goes on without variables. Every field is NUL-terminated,
// so each write is capped a byte short of its slot.
function buildEnterPayload({
  callsign = IMPORT_CALLSIGN,
  motto = IMPORT_MOTTO,
  token = '',
  version = IMPORT_CLIENT_VERSION,
  team = OBSERVER_TEAM,
} = {}) {
  const payload = Buffer.alloc(
    2 + 2 + CALLSIGN_LEN + MOTTO_LEN + TOKEN_LEN + VERSION_LEN + PLAYER_ID_LEN
  );
  payload.writeUInt16BE(TANK_PLAYER, 0);
  payload.writeUInt16BE(team, 2);
  let at = 4;
  payload.write(callsign, at, CALLSIGN_LEN - 1, 'ascii'); at += CALLSIGN_LEN;
  payload.write(motto, at, MOTTO_LEN - 1, 'ascii'); at += MOTTO_LEN;
  payload.write(token, at, TOKEN_LEN - 1, 'ascii'); at += TOKEN_LEN;
  payload.write(version, at, VERSION_LEN - 1, 'ascii');
  return payload;
}

// MsgSetVar: a u16 pair count, then that many (u8 length, bytes) pairs. Sent
// in as many frames as it takes to stay under MaxPacketLen (`PackVars.h`), so
// every frame between MsgAccept and the first non-MsgSetVar reply counts.
function decodeSetVars(payload, into) {
  const r = new Reader(payload);
  const count = r.u16();
  for (let i = 0; i < count; i += 1) {
    const name = r.bytes(r.u8()).toString('latin1');
    const value = r.bytes(r.u8()).toString('latin1');
    if (name) into.set(name, value);
  }
  return into;
}

function fetchWorldFromServer(host, port, timeout, options = {}) {
  return new Promise((resolve, reject) => {
    // Upstream bzfs does not support IPv6; force IPv4 so dual-stack hosts
    // (e.g. AAAA + A records) don't route the connection over IPv6.
    const socket = net.createConnection({ host, port, family: 4 });
    const { readExact, readFrame } = createFrameReader(socket);
    let settled = false;

    const watchdog = setTimeout(() => fail(new Error('timed out')), timeout);

    function cleanup() {
      clearTimeout(watchdog);
      socket.destroy();
    }
    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }
    function succeed(value) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }

    socket.on('error', fail);
    socket.on('close', () => fail(new Error('connection closed')));

    // Enter as an observer, take the BZDB dump bzfs sends every accepted
    // player, and leave. Bounded by its own clock rather than the outer
    // watchdog: a server that accepts the join and then says nothing must not
    // strand a world that has already arrived.
    async function collectVariables() {
      sendFrame(socket, 'en', buildEnterPayload());
      const deadline = Date.now() + ENTER_TIMEOUT_MS;
      const vars = new Map();
      let accepted = false;
      for (;;) {
        if (Date.now() > deadline) break;
        const { code, payload } = await Promise.race([
          readFrame(),
          new Promise((res) => setTimeout(() => res({ code: '', payload: null }), deadline - Date.now())),
        ]);
        if (!code) break;
        if (code === 'rj' || code === 'sk') break;
        if (code === 'ac') { accepted = true; continue; }
        if (code === 'sv') { decodeSetVars(payload, vars); continue; }
        // MsgTeamUpdate is the first thing after the variables (`addPlayer`,
        // bzfs.cxx:2385-2387), so anything else once they have started
        // arriving means there are no more coming.
        if (accepted && vars.size > 0) break;
      }
      // Leave whether or not anything arrived. The socket is destroyed
      // immediately after this resolves, but a server that is told is a
      // server that does not wait out a timeout on an empty slot.
      try { sendFrame(socket, 'ex'); } catch { /* already gone */ }
      return vars.size > 0 ? vars : null;
    }

    socket.on('connect', async () => {
      try {
        socket.write('BZFLAG\r\n\r\n');
        const version = (await readExact(8)).toString('ascii');
        const playerId = (await readExact(1)).readUInt8(0);
        if (version !== PROTOCOL_VERSION) {
          throw new Error(`protocol ${version} (bzo speaks ${PROTOCOL_VERSION})`);
        }
        if (playerId === 0xff) throw new Error('rejected (full, banned, or closed)');

        // MsgQueryGame is the same admin-style query bzfquery.py uses (also
        // without ever sending MsgEnter) -- it carries maxPlayerScore/
        // maxTeamScore/maxTime and the game style, none of which are in
        // MsgGameSettings below.
        sendFrame(socket, 'qg');
        let queryGame = null;
        for (;;) {
          const { code, payload } = await readFrame();
          if (code === 'qg') { queryGame = payload; break; }
          if (code === 'sk' || code === 'rj') throw new Error(`server sent ${code} querying game`);
        }

        // Declare zero known flag types; we never look at the server's reply,
        // so it does not matter that it will call every flag "missing".
        sendFrame(socket, 'nf');
        for (;;) {
          const { code } = await readFrame();
          if (code === 'nf') break;
          if (code === 'sk' || code === 'rj') throw new Error(`server sent ${code} negotiating flags`);
        }

        sendFrame(socket, 'ws');
        let gameSettings = null;
        for (;;) {
          const { code, payload } = await readFrame();
          if (code === 'gs') { gameSettings = payload; break; }
          if (code === 'sk' || code === 'rj') throw new Error(`server sent ${code} requesting settings`);
        }

        sendFrame(socket, 'wh');
        for (;;) {
          const { code } = await readFrame();
          if (code === 'wh') break;
          if (code === 'cu') continue; // cache URL offered; we always pull direct
          if (code === 'sk' || code === 'rj') throw new Error(`server sent ${code} requesting world hash`);
        }

        const parts = [];
        let ptr = 0;
        for (;;) {
          const req = Buffer.alloc(4);
          req.writeUInt32BE(ptr, 0);
          sendFrame(socket, 'gw', req);
          let chunk, bytesLeft;
          for (;;) {
            const { code, payload } = await readFrame();
            if (code === 'gw') { bytesLeft = payload.readUInt32BE(0); chunk = payload.subarray(4); break; }
            if (code === 'sk' || code === 'rj') throw new Error(`server sent ${code} downloading world`);
          }
          parts.push(chunk);
          ptr += chunk.length;
          if (ptr > MAX_WORLD_DATABASE_BYTES) throw new Error('world database exceeded the size limit');
          if (bytesLeft === 0) break;
        }

        // Last, so that a rejected join costs the import nothing it has not
        // already got: everything above is answered to an un-entered
        // connection, and only the variables need a seat.
        let variables = null;
        if (options.enterForVariables !== false) {
          try {
            variables = await collectVariables();
          } catch {
            variables = null;
          }
        }

        succeed({ worldDatabase: Buffer.concat(parts), gameSettings, queryGame, variables });
      } catch (err) {
        fail(err);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// The global-login probe: one MsgEnter carrying a token my.bzflag.org just
// issued to a browser, sent by something that is not that browser. Whether
// bzfs accepts it is the single assumption the proxy design rests on --
// docs/proxy.md, "A proxy runs inside its target's network".
//
// bzfs does not decide this itself. It queues the list-server ADD on the same
// main-loop pass as the join and holds the player out of the game until the
// reply lands, then says which way it went as a chat message from the server:
// "Global login approved!", "Global login rejected, bad token.", or, for a
// callsign nobody has registered, that it is not registered
// (`ListServerConnection.cxx:280-295`). So the probe's whole job is to join,
// read the server's own messages, and leave.
//
// Unlike the world import this occupies a real player slot, and a verified
// join takes the callsign from any session already using it
// (`bzfs.cxx:2167`) -- so it leaves the moment a verdict lands, and is run
// under your own callsign while you are not otherwise on the target.
// ---------------------------------------------------------------------------

const SERVER_PLAYER_ID = 253;
const PROBE_CALLSIGN_MOTTO = 'bzo global-login probe -- https://github.com/timriker/bzo';
// Long enough for bzfs to reach my.bzflag.org and hear back on its own
// schedule, short enough that a target which never answers is an error rather
// than a hung request.
const PROBE_TIMEOUT_MS = 20000;
// How long to keep reading after the verdict, for the MsgAccept that follows
// it. Only bounds the wait for something bzfs sends in the same breath.
const PROBE_ACCEPT_GRACE_MS = 2000;

// The three endings bzfs writes, in the words it writes them. Matched as
// prefixes because only the first is punctuated the same way every time.
const PROBE_VERDICTS = Object.freeze([
  { prefix: 'Global login approved', verdict: 'approved' },
  { prefix: 'Global login rejected', verdict: 'rejected' },
  { prefix: 'This callsign is not registered', verdict: 'unregistered' },
]);

function probeGlobalToken({ host, port, callsign, token, timeout = PROBE_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port, family: 4 });
    const { readExact, readFrame } = createFrameReader(socket);
    let settled = false;
    const messages = [];

    const watchdog = setTimeout(() => fail(new Error('timed out')), timeout);
    function cleanup() {
      clearTimeout(watchdog);
      socket.destroy();
    }
    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }
    function succeed(value) {
      if (settled) return;
      settled = true;
      // Say goodbye before hanging up, so the target frees the slot now
      // rather than waiting out a timeout on it.
      try { sendFrame(socket, 'ex'); } catch { /* already gone */ }
      cleanup();
      resolve(value);
    }

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

        sendFrame(socket, 'en', buildEnterPayload({
          callsign,
          motto: PROBE_CALLSIGN_MOTTO,
          token,
        }));

        // The verdict arrives before the join does: bzfs writes it the moment
        // the list server answers and only then finishes adding the player,
        // so MsgAccept follows it rather than preceding it. Both are wanted --
        // a token that verifies and a seat on the server are two different
        // facts -- so reading carries on past the verdict for a moment.
        let accepted = false;
        let verdict = null;
        let deadline = Date.now() + timeout;
        for (;;) {
          let timer = null;
          const { code, payload } = await Promise.race([
            readFrame(),
            new Promise((res) => {
              timer = setTimeout(() => res({ code: '', payload: null }),
                Math.max(0, deadline - Date.now()));
            }),
          ]);
          clearTimeout(timer);
          // Nothing more is coming in the time allowed. Whatever has arrived
          // is the answer, and the read queue is abandoned with the socket.
          if (!code) break;
          if (code === 'ac') {
            accepted = true;
            if (verdict) break;
            continue;
          }
          if (code === 'rj') {
            // MsgReject: a u16 reason code, then the server's own sentence.
            const reason = payload.length > 2
              ? payload.toString('latin1', 2).replace(/\0.*$/s, '') : '';
            succeed({ accepted: false, verdict: 'refused', reason, messages });
            return;
          }
          if (code === 'sk') {
            succeed({ accepted, verdict: 'superkilled', messages });
            return;
          }
          if (code !== 'mg') continue;
          // MsgMessage: from, to, type, then a NUL-terminated string
          // (`sendMessage`, bzfs.cxx:1701).
          const from = payload.readUInt8(0);
          const text = payload.toString('latin1', 3).replace(/\0.*$/s, '');
          if (from !== SERVER_PLAYER_ID) continue;
          messages.push(text);
          const hit = verdict ? null : PROBE_VERDICTS.find((v) => text.startsWith(v.prefix));
          if (hit) {
            verdict = hit.verdict;
            if (accepted) break;
            deadline = Date.now() + PROBE_ACCEPT_GRACE_MS;
          }
        }
        succeed({ accepted, verdict: verdict || 'silent', messages });
      } catch (err) {
        fail(err);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Game settings and rules: MsgGameSettings (makeGameSettings in bzfs.cxx) and
// MsgQueryGame (sendQueryGame; the same message bzfquery.py's queryGame()
// reads). Between the two we get everything an `options` block in a bzw file
// can express: which flag/physics switches are on, shot count, superflag
// count, shake timeout/wins, world acceleration, and the score/time limits
// that only MsgQueryGame carries.
// ---------------------------------------------------------------------------

const GAME_STYLES = ['TeamFFA', 'ClassicCTF', 'OpenFFA', 'RabbitChase'];
const GAME_OPTION_BITS = {
  flags: 0x0002, jumping: 0x0008, inertia: 0x0010, ricochet: 0x0020,
  shaking: 0x0040, antidote: 0x0080, handicap: 0x0100, noTeamKills: 0x0400,
};

function decodeGameSettings(buf) {
  const r = new Reader(buf);
  const worldSize = r.f32();
  const gameType = r.u16();
  const gameOptionsBits = r.u16();
  r.u16(); // PlayerSlot -- a client-side workaround value, not a real player count
  const maxShots = r.u16();
  const numFlags = r.u16();
  const linearAcceleration = r.f32();
  const angularAcceleration = r.f32();
  const shakeTimeout = r.u16();
  const shakeWins = r.u16();
  return {
    worldSize, gameType, gameOptionsBits, maxShots, numFlags,
    linearAcceleration, angularAcceleration, shakeTimeout, shakeWins,
  };
}

function decodeQueryGame(buf) {
  const r = new Reader(buf);
  const style = r.u16();
  r.u16(); // options (duplicate of MsgGameSettings' bitmask)
  r.u16(); // maxPlayers (duplicate of decodePingHex's own, and just the sum
  // of teamMaximums below plus its own observer slot -- CmdLineOptions.cxx:458)
  r.u16(); // maxShots (duplicate)
  for (let i = 0; i < 6; i++) r.u16(); // per-team current sizes -- live player
  // counts at the moment of the query, not a map property, so left unread
  // the same way a snapshot of who is playing right now always is.
  // Rogue, red, green, blue, purple, observer, in that order -- the same
  // order `-mp a,b,c,d,e,f` already takes (`BZFLAG_MP_TEAM_ORDER`,
  // server/teams.cjs), so this can be written back out unchanged.
  const teamMaximums = Array.from({ length: 6 }, () => r.u16());
  r.u16(); // shakeWins (duplicate)
  r.u16(); // shakeTimeout (duplicate)
  const maxPlayerScore = r.u16();
  const maxTeamScore = r.u16();
  const maxTime = r.u16();
  return {
    style, maxPlayerScore, maxTeamScore, maxTime, teamMaximums,
  };
}

// ---------------------------------------------------------------------------
// World database parser. Field order and widths follow, in this order:
// WorldBuilder::unpack, DynamicColorManager/TextureMatrixManager/
// BzMaterialManager/PhysicsDriverManager/MeshTransformManager::unpack,
// GroupDefinitionMgr/GroupDefinition/GroupInstance::unpack, LinkManager::unpack,
// Weapon::unpack, EntryZone::unpack (all under $HOME/bzflag/src). Every field
// that survives is kept (not just tallied), so the same tree can drive both
// a feature-usage report and the .bzw re-export.
// ---------------------------------------------------------------------------

const OBSTACLE_ORDER = ['wall', 'box', 'pyr', 'base', 'tele', 'mesh', 'arc', 'cone', 'sphere', 'tetra'];

function parseDynamicColor(r) {
  const name = r.str();
  const channels = [];
  for (let c = 0; c < 4; c++) {
    const min = r.f32();
    const max = r.f32();
    const sinCount = r.u32();
    const sinusoids = Array.from({ length: sinCount }, () => ({ period: r.f32(), offset: r.f32(), weight: r.f32() }));
    const upCount = r.u32();
    const clampUps = Array.from({ length: upCount }, () => ({ period: r.f32(), offset: r.f32(), width: r.f32() }));
    const downCount = r.u32();
    const clampDowns = Array.from({ length: downCount }, () => ({ period: r.f32(), offset: r.f32(), width: r.f32() }));
    const seqCount = r.u32();
    let sequence = { period: 0, offset: 0, list: [] };
    if (seqCount > 0) {
      const period = r.f32();
      const offset = r.f32();
      const list = Array.from({ length: seqCount }, () => r.u8());
      sequence = { period, offset, list };
    }
    channels.push({ min, max, sinusoids, clampUps, clampDowns, sequence });
  }
  return { name, channels };
}

function parseTextureMatrix(r) {
  const name = r.str();
  const state = r.u8();
  const useStatic = !!(state & 1);
  const useDynamic = !!(state & 2);
  const t = { name, useStatic, useDynamic };
  if (useStatic) {
    t.rotation = r.f32();
    t.uFixedShift = r.f32(); t.vFixedShift = r.f32();
    t.uFixedScale = r.f32(); t.vFixedScale = r.f32();
    t.uFixedCenter = r.f32(); t.vFixedCenter = r.f32();
  }
  if (useDynamic) {
    t.spinFreq = r.f32();
    t.uShiftFreq = r.f32(); t.vShiftFreq = r.f32();
    t.uScaleFreq = r.f32(); t.vScaleFreq = r.f32();
    t.uScale = r.f32(); t.vScale = r.f32();
    t.uCenter = r.f32(); t.vCenter = r.f32();
  }
  return t;
}

function parseMaterial(r) {
  const name = r.str();
  const mode = r.u8();
  const dynamicColor = r.i32();
  const ambient = [r.f32(), r.f32(), r.f32(), r.f32()];
  const diffuse = [r.f32(), r.f32(), r.f32(), r.f32()];
  const specular = [r.f32(), r.f32(), r.f32(), r.f32()];
  const emission = [r.f32(), r.f32(), r.f32(), r.f32()];
  const shininess = r.f32();
  const alphaThreshold = r.f32();
  const textureCount = r.u8();
  const textures = [];
  for (let i = 0; i < textureCount; i++) {
    const texName = r.str();
    const matrix = r.i32();
    const combineMode = r.i32();
    const texState = r.u8();
    textures.push({
      name: texName, matrix, combineMode,
      useAlpha: !!(texState & 1), useColor: !!(texState & 2), useSphereMap: !!(texState & 4),
    });
  }
  const shaderCount = r.u8();
  const shaders = Array.from({ length: shaderCount }, () => ({ name: r.str() }));
  return {
    name,
    noCulling: !!(mode & 1), noSorting: !!(mode & 2), noRadar: !!(mode & 4), noShadow: !!(mode & 8),
    occluder: !!(mode & 16), groupAlpha: !!(mode & 32), noLighting: !!(mode & 64),
    dynamicColor, ambient, diffuse, specular, emission, shininess, alphaThreshold, textures, shaders,
  };
}

function parsePhysicsDriver(r) {
  const name = r.str();
  const linear = r.vec3();
  const angularVel = r.f32();
  const angularPos = [r.f32(), r.f32()];
  const radialVel = r.f32();
  const radialPos = [r.f32(), r.f32()];
  const slideTime = r.f32();
  const deathMsg = r.str();
  return { name, linear, angularVel, angularPos, radialVel, radialPos, slideTime, deathMsg };
}

// MeshTransform::unpack: a named, ordered list of shift/scale/shear/spin/index
// operations. Used both for the manager's own named transforms and inline
// wherever an arc/cone/sphere/tetra/group carries its own anonymous one.
function parseTransform(r) {
  const name = r.str();
  const count = r.u32();
  const ops = [];
  for (let i = 0; i < count; i++) {
    const type = r.u8();
    if (type === 4) { ops.push({ type, index: r.i32() }); continue; }
    const data = r.vec3();
    const spin = type === 3 ? r.f32() : 0;
    ops.push({ type, data, spin });
  }
  return { name, ops };
}

function parseBoxLike(r) {
  const pos = r.vec3();
  const angle = r.f32();
  const size = r.vec3();
  const state = r.u8();
  return {
    pos, angle, size,
    driveThrough: !!(state & 1), shootThrough: !!(state & 2),
    flipZ: !!(state & 4), ricochet: !!(state & 8),
  };
}

function parseBase(r) {
  const team = r.u16();
  return { team, ...parseBoxLike(r) };
}

function parseTeleporter(r) {
  const name = r.str();
  const pos = r.vec3();
  const angle = r.f32();
  const size = r.vec3();
  const border = r.f32();
  const horizontal = r.u8() !== 0;
  const state = r.u8();
  return {
    name, pos, angle, size, border, horizontal,
    driveThrough: !!(state & 1), shootThrough: !!(state & 2), ricochet: !!(state & 8),
  };
}

function parseWall(r) {
  const pos = r.vec3();
  const angle = r.f32();
  const y = r.f32();
  const z = r.f32();
  const state = r.u8();
  return { pos, angle, y, z, ricochet: !!(state & 8) };
}

function parseMeshFace(r) {
  const state = r.u8();
  const useNormals = !!(state & 1);
  const useTexcoords = !!(state & 2);
  const vcount = r.i32();
  const vertexIdx = Array.from({ length: vcount }, () => r.i32());
  const normalIdx = useNormals ? Array.from({ length: vcount }, () => r.i32()) : null;
  const texcoordIdx = useTexcoords ? Array.from({ length: vcount }, () => r.i32()) : null;
  const matindex = r.i32();
  const phydrv = r.i32();
  return {
    vertexIdx, normalIdx, texcoordIdx, matindex, phydrv,
    driveThrough: !!(state & 4), shootThrough: !!(state & 8),
    smoothBounce: !!(state & 16), noclusters: !!(state & 32), ricochet: !!(state & 64),
  };
}

// A mesh built with BZFlag's MeshDrawInfo optimization (`-meshbox`, or a
// mapper's own `drawInfo` block) hides its real render geometry in this same
// texcoord region -- MeshObstacle::pack (~MeshObstacle.cxx:672-694) inflates
// texcoordCount to also cover the packed MeshDrawInfo blob plus alignment
// padding, then appends a trailing `afvec2` slot holding `rewindLen`: the
// byte count to step back from the end of this region to find where that
// blob actually starts. `unpackCorner`, next, mirrors `Corner::unpack`
// (MeshDrawInfo.cxx:1518).
function unpackCorner(r) {
  const tag = r.u8();
  if (tag === 0) return { vertex: r.i32(), normal: r.i32(), texcoord: r.i32() };
  return { vertex: r.u16(), normal: r.u16(), texcoord: r.u16() };
}

// OpenGL index type constants a `DrawCmd` tags its indices with
// (DrawCmd::DrawIndexUShort / DrawIndexUInt, MeshDrawInfo.h).
const DRAW_INDEX_USHORT = 0x1403;

function unpackDrawCmd(r) {
  const drawMode = r.u32();
  const count = r.i32();
  const indexType = r.u32();
  const indices = indexType === DRAW_INDEX_USHORT
    ? Array.from({ length: count }, () => r.u16())
    : Array.from({ length: count }, () => r.u32());
  return { drawMode, indices };
}

// `DrawCmd::DrawModes` (MeshDrawInfo.h) -- expands one OpenGL-style draw
// command's index list into individual triangles (each a triple of *corner*
// indices, still one step removed from real vertex/normal/texcoord indices).
// Points/lines carry no surface to draw and are skipped.
function drawCmdToTriangles(cmd) {
  const idx = cmd.indices;
  const tris = [];
  switch (cmd.drawMode) {
    case 4: // DrawTriangles
      for (let i = 0; i + 2 < idx.length; i += 3) tris.push([idx[i], idx[i + 1], idx[i + 2]]);
      break;
    case 5: // DrawTriangleStrip
      for (let i = 0; i + 2 < idx.length; i++) {
        tris.push(i % 2 === 0 ? [idx[i], idx[i + 1], idx[i + 2]] : [idx[i + 1], idx[i], idx[i + 2]]);
      }
      break;
    case 6: // DrawTriangleFan
    case 9: // DrawPolygon (assumed convex, same fan triangulation)
      for (let i = 1; i + 1 < idx.length; i++) tris.push([idx[0], idx[i], idx[i + 1]]);
      break;
    case 7: // DrawQuads
      for (let i = 0; i + 3 < idx.length; i += 4) {
        tris.push([idx[i], idx[i + 1], idx[i + 2]]);
        tris.push([idx[i], idx[i + 2], idx[i + 3]]);
      }
      break;
    case 8: // DrawQuadStrip
      for (let i = 0; i + 3 < idx.length; i += 2) {
        tris.push([idx[i], idx[i + 1], idx[i + 3]]);
        tris.push([idx[i], idx[i + 3], idx[i + 2]]);
      }
      break;
    default:
      break;
  }
  return tris;
}

function unpackDrawSet(r) {
  const cmdCount = r.i32();
  const cmds = Array.from({ length: cmdCount }, () => unpackDrawCmd(r));
  const material = r.i32();
  r.skip((4 * 4) + 1); // sphere (afvec3 + radius) and state bits, unused here
  return { cmds, material };
}

function unpackDrawLod(r) {
  const setCount = r.i32();
  const sets = Array.from({ length: setCount }, () => unpackDrawSet(r));
  const lengthPerPixel = r.f32();
  return { sets, lengthPerPixel };
}

// `MeshDrawInfo::unpack` (MeshDrawInfo.cxx:1386). `radarLods` and the
// trailing sphere/extents are read (to stay aligned) but not kept -- bzo has
// no distance-based LOD system, so only the highest-resolution `lods` entry
// (post-sort, the smallest `lengthPerPixel`) ever gets used.
function unpackMeshDrawInfo(r) {
  const name = r.str();
  const optionCount = r.i32();
  for (let i = 0; i < optionCount; i++) r.str();
  const stateBits = r.u32();
  // `AnimationInfo::unpack` (angvel, dummy) -- a continuous spin bzo has no
  // per-obstacle animation system to apply (#88). Read so the cursor stays
  // aligned, same as ever, but the value now survives the call (`angvel`,
  // below) instead of being thrown away right here -- `applyMeshDrawInfo`
  // needs it to decide whether this mesh's own name is worth reporting.
  const angvel = (stateBits & 1) ? r.f32() : 0;
  if (stateBits & 1) r.str();
  const cornerCount = r.i32();
  const corners = Array.from({ length: cornerCount }, () => unpackCorner(r));
  const rawVertCount = r.i32();
  const rawVerts = Array.from({ length: rawVertCount }, () => r.vec3());
  const rawNormCount = r.i32();
  const rawNorms = Array.from({ length: rawNormCount }, () => r.vec3());
  const rawTxcdCount = r.i32();
  const rawTxcds = Array.from({ length: rawTxcdCount }, () => [r.f32(), r.f32()]);
  const lodCount = r.i32();
  const lods = Array.from({ length: lodCount }, () => unpackDrawLod(r));
  const radarCount = r.i32();
  for (let i = 0; i < radarCount; i++) unpackDrawLod(r);
  r.skip(10 * 4); // sphere (vec4) + extents mins/maxs (vec3 each), unused here
  return { name, angvel, corners, rawVerts, rawNorms, rawTxcds, lods };
}

// Reconstructs the triangles a drawInfo-optimized mesh's own `face` list
// never carries (#87): only when that list came back empty, since a mesh
// with real faces already renders and collides normally, and a mapper who
// wrote both a `face` list and a `drawInfo` block meant the faces to still be
// what collides. These triangles never do -- `CustomMesh.cxx`'s own
// decorative/passable hack means upstream itself never gave a *zero-face*
// drawInfo mesh any collision either, so `driveThrough`/`shootThrough` are
// forced true here rather than left at the mesh's own state-byte flags.
function applyMeshDrawInfo(r, texcoordStart, texcoordEnd, fakeTexcoordCount, mesh) {
  if (mesh.vertices.length >= 1) mesh.vertices.pop(); // CustomMesh.cxx's extraneous vertex, tacked on only when a drawInfo owner
  if (fakeTexcoordCount < 2) return;
  const rewindLen = r.buf.readInt32BE(texcoordEnd - 8);
  if (rewindLen <= 0 || rewindLen > fakeTexcoordCount * 8) return;
  const dr = new Reader(r.buf);
  dr.o = texcoordEnd - rewindLen;
  let drawInfo;
  try {
    drawInfo = unpackMeshDrawInfo(dr);
  } catch {
    return; // malformed drawInfo blob -- keep the (bogus) texcoords already read, nothing else to lose
  }

  const fakeTxcds = rewindLen / 8;
  const tr = new Reader(r.buf);
  tr.o = texcoordStart;
  mesh.texcoords = Array.from({ length: fakeTexcoordCount - fakeTxcds }, () => [tr.f32(), tr.f32()]);

  if (drawInfo.name) mesh.name = drawInfo.name; // MeshObstacle::unpack: "get the proxied name" -- a mesh has no name of its own on the wire otherwise
  // `MeshDrawInfo::updateAnimation`/`MeshDrawMgr::executeSet` (#88): a
  // continuous spin about the mesh's own placement, degrees/sec. Carried
  // straight onto the mesh object so `printMesh` can re-state it as bzo's own
  // mesh-level `angvel` line -- there is no per-mesh pivot upstream itself
  // (a hand-authored `drawInfo { angvel N }` spins about world origin), so
  // stating it as a plain mesh property rather than nesting a whole unused
  // `drawInfo` sub-grammar loses nothing real.
  if (drawInfo.angvel) mesh.angvel = drawInfo.angvel;
  if (mesh.faces.length > 0 || drawInfo.lods.length === 0 || drawInfo.corners.length === 0) return;

  // A raw pool of its own means the drawInfo's corners index into it, not
  // into the mesh's regular vertex/normal/texcoord lists -- append it so a
  // single index space covers both (`printMesh` below writes every vertex it
  // is given, whether or not this mesh's own text ever names the extra ones).
  const usesRawPool = drawInfo.rawVerts.length > 0;
  const vertexOffset = usesRawPool ? mesh.vertices.length : 0;
  const normalOffset = usesRawPool ? mesh.normals.length : 0;
  const texcoordOffset = usesRawPool ? mesh.texcoords.length : 0;
  if (usesRawPool) {
    mesh.vertices = mesh.vertices.concat(drawInfo.rawVerts);
    mesh.normals = mesh.normals.concat(drawInfo.rawNorms);
    mesh.texcoords = mesh.texcoords.concat(drawInfo.rawTxcds);
  }

  // `compareLengthPerPixel` (MeshDrawInfo.cxx): smaller lengthPerPixel is
  // higher resolution, meant for a closer camera -- bzo picks that one
  // always, the highest-detail LOD a distance-aware client would only use up
  // close.
  const lod0 = [...drawInfo.lods].sort((a, b) => a.lengthPerPixel - b.lengthPerPixel)[0];
  const newFaces = [];
  for (const drawSet of lod0.sets) {
    for (const cmd of drawSet.cmds) {
      for (const tri of drawCmdToTriangles(cmd)) {
        if (tri.some((ci) => !drawInfo.corners[ci])) continue;
        newFaces.push({
          vertexIdx: tri.map((ci) => drawInfo.corners[ci].vertex + vertexOffset),
          normalIdx: tri.map((ci) => drawInfo.corners[ci].normal + normalOffset),
          texcoordIdx: tri.map((ci) => drawInfo.corners[ci].texcoord + texcoordOffset),
          matindex: drawSet.material, phydrv: -1,
          driveThrough: true, shootThrough: true,
          smoothBounce: false, noclusters: false, ricochet: false,
        });
      }
    }
  }
  mesh.faces = newFaces;
}

function parseMesh(r) {
  const checkCount = r.i32();
  const checks = Array.from({ length: checkCount }, () => ({ type: r.u8(), point: r.vec3() }));
  const vertexCount = r.i32();
  const vertices = Array.from({ length: vertexCount }, () => r.vec3());
  const normalCount = r.i32();
  const normals = Array.from({ length: normalCount }, () => r.vec3());
  const texcoordCount = r.i32();
  const texcoordStart = r.o;
  const texcoords = Array.from({ length: texcoordCount }, () => [r.f32(), r.f32()]);
  const texcoordEnd = r.o;
  const faceSize = r.i32();
  const faces = Array.from({ length: faceSize }, () => parseMeshFace(r));
  const state = r.u8();
  const mesh = {
    checks, vertices, normals, texcoords, faces,
    driveThrough: !!(state & 1), shootThrough: !!(state & 2),
    smoothBounce: !!(state & 4), noclusters: !!(state & 8), ricochet: !!(state & 32),
  };
  // Bit 1<<4, `drawInfoOwner` (MeshObstacle::unpack) -- a mesh built with
  // BZFlag's MeshDrawInfo render optimization; see `applyMeshDrawInfo` (#87).
  if (state & 16) applyMeshDrawInfo(r, texcoordStart, texcoordEnd, texcoordCount, mesh);
  return mesh;
}

function parseCurved(r, kind) {
  const transform = parseTransform(r);
  const pos = r.vec3();
  const size = r.vec3();
  const angle = r.f32();
  const sweepAngle = kind === 'sphere' ? null : r.f32();
  const ratio = kind === 'arc' ? r.f32() : null;
  const divisions = r.i32();
  const phydrv = r.i32();
  const texCount = kind === 'arc' ? 4 : 2;
  const texsize = Array.from({ length: texCount }, () => r.f32());
  const materialCount = kind === 'arc' ? 6 : kind === 'cone' ? 4 : 2;
  const materials = Array.from({ length: materialCount }, () => r.i32());
  const state = r.u8();
  const hemisphere = kind === 'sphere' ? !!(state & 16) : false;
  const ricochet = kind === 'sphere' ? !!(state & 32) : !!(state & 16);
  return {
    transform, pos, size, angle, sweepAngle, ratio, divisions, phydrv, texsize, materials,
    driveThrough: !!(state & 1), shootThrough: !!(state & 2), smoothBounce: !!(state & 4),
    useNormals: !!(state & 8), hemisphere, ricochet,
  };
}

function parseTetra(r) {
  const state = r.u8();
  const transform = parseTransform(r);
  const vertices = Array.from({ length: 4 }, () => r.vec3());
  const useNormalsByte = r.u8();
  const normals = [];
  for (let v = 0; v < 4; v++) normals.push((useNormalsByte & (1 << v)) ? Array.from({ length: 3 }, () => r.vec3()) : null);
  const useTexByte = r.u8();
  const texcoords = [];
  for (let v = 0; v < 4; v++) texcoords.push((useTexByte & (1 << v)) ? Array.from({ length: 3 }, () => [r.f32(), r.f32()]) : null);
  const materials = Array.from({ length: 4 }, () => r.i32());
  return {
    transform, vertices, normals, texcoords, materials,
    driveThrough: !!(state & 1), shootThrough: !!(state & 2), ricochet: !!(state & 4),
  };
}

// The instance name is what every teleporter placed through this group is
// named after -- `GroupDefinition::appendGroupName` prefixes it onto each
// contained teleporter's own name, and a `link` block's endpoints are those
// full names. Drop it and every group-placed teleporter link in the map
// names something that no longer exists.
//
// `GroupInstance::pack` also stuffs the instance's material remap table into
// the tail of the same string, behind a NUL terminator, when it has one;
// `unpack` spots that by the string being longer than its own C string and
// reads an int32 count plus that many src/dst material index pairs.
function parseGroupInstance(r) {
  const groupdef = r.str();
  const raw = r.bytes(r.u32());
  const nul = raw.indexOf(0);
  const name = (nul < 0 ? raw : raw.subarray(0, nul)).toString('utf8');
  const matMap = [];
  if (nul >= 0) {
    const tail = new Reader(raw.subarray(nul + 1));
    const count = tail.i32();
    for (let i = 0; i < count && tail.remaining >= 8; i++) {
      matMap.push([tail.i32(), tail.i32()]);
    }
  }
  const transform = parseTransform(r);
  const bits = r.u8();
  const inst = {
    groupdef, name, matMap, transform,
    modifyTeam: !!(bits & 1), modifyColor: !!(bits & 2),
    modifyPhysicsDriver: !!(bits & 4), modifyMaterial: !!(bits & 8),
    driveThrough: !!(bits & 16), shootThrough: !!(bits & 32), ricochet: !!(bits & 64),
  };
  if (inst.modifyTeam) inst.team = r.u16();
  if (inst.modifyColor) inst.tint = [...r.vec3(), r.f32()];
  if (inst.modifyPhysicsDriver) inst.phydrv = r.i32();
  if (inst.modifyMaterial) inst.material = r.i32();
  return inst;
}

const OBSTACLE_PARSERS = {
  wall: parseWall, box: parseBoxLike, pyr: parseBoxLike, base: parseBase, tele: parseTeleporter,
  mesh: parseMesh, arc: (r) => parseCurved(r, 'arc'), cone: (r) => parseCurved(r, 'cone'),
  sphere: (r) => parseCurved(r, 'sphere'), tetra: parseTetra,
};

function parseGroupDefinition(r, isWorld) {
  const name = r.str();
  const obstacles = {};
  for (const kind of OBSTACLE_ORDER) {
    const count = r.u32();
    obstacles[kind] = Array.from({ length: count }, () => OBSTACLE_PARSERS[kind](r));
  }
  // A spinning mesh with no `drawInfo.name` of its own (`applyMeshDrawInfo`)
  // falls back to this enclosing definition's name -- "SpinTank" itself, for
  // the mesh that gave #88 its name, since the mesh had none of its own.
  for (const mesh of obstacles.mesh) {
    if (mesh.angvel && !mesh.name) mesh.name = name || null;
  }
  const groupInstanceCount = r.u32();
  const groupInstances = Array.from({ length: groupInstanceCount }, () => parseGroupInstance(r));
  return { name, isWorld, obstacles, groupInstances };
}

function parseGroupDefinitionMgr(r) {
  const world = parseGroupDefinition(r, true);
  const count = r.u32();
  const groupDefs = Array.from({ length: count }, () => parseGroupDefinition(r, false));
  return { world, groupDefs };
}

function parseWeapon(r) {
  const flagAbbv = r.flagAbbv();
  const pos = r.vec3();
  const dir = r.f32();
  const initDelay = r.f32();
  const delayCount = r.u16();
  const delay = Array.from({ length: delayCount }, () => r.f32());
  return { flagAbbv, pos, dir, initDelay, delay };
}

function parseEntryZone(r) {
  const pos = r.vec3();
  const size = r.vec3();
  const rot = r.f32();
  const flagCount = r.u16();
  const teamCount = r.u16();
  const safetyCount = r.u16();
  const flags = Array.from({ length: flagCount }, () => r.flagAbbv());
  const teams = Array.from({ length: teamCount }, () => r.u16());
  const safety = Array.from({ length: safetyCount }, () => r.u16());
  return { pos, size, rot, flags, teams, safety };
}

function parseWorldDatabase(fullBuf) {
  const header = new Reader(fullBuf);
  header.u16(); // length (legacy field, unused by this reader)
  const code = header.u16();
  if (code !== 0x6865) throw new Error('missing world header (not a WorldBuilder blob)');
  const mapVersion = header.u16();
  const uncompressedSize = header.u32();
  const compressedSize = header.u32();
  const compressed = header.bytes(compressedSize);
  const inflated = zlib.inflateSync(compressed);
  if (inflated.length !== uncompressedSize) {
    throw new Error(`decompressed to ${inflated.length} bytes, expected ${uncompressedSize}`);
  }

  const r = new Reader(inflated);

  const dynamicColors = Array.from({ length: r.u32() }, () => parseDynamicColor(r));
  const textureMatrices = Array.from({ length: r.u32() }, () => parseTextureMatrix(r));
  const materials = Array.from({ length: r.u32() }, () => parseMaterial(r));
  const physicsDrivers = Array.from({ length: r.u32() }, () => parsePhysicsDriver(r));
  const meshTransforms = Array.from({ length: r.u32() }, () => parseTransform(r));

  const { world, groupDefs } = parseGroupDefinitionMgr(r);

  const links = Array.from({ length: r.u32() }, () => ({ src: r.str(), dst: r.str() }));

  const waterLevel = r.f32();
  const waterMaterial = waterLevel >= 0 ? r.i32() : -1;

  const weapons = Array.from({ length: r.u32() }, () => parseWeapon(r));
  const zones = Array.from({ length: r.u32() }, () => parseEntryZone(r));

  return {
    mapVersion,
    trailingBytes: r.remaining,
    managers: { dynamicColors, textureMatrices, materials, physicsDrivers, meshTransforms },
    world, groupDefs, links, waterLevel, waterMaterial, weapons, zones,
  };
}

// ---------------------------------------------------------------------------
// .bzw re-export -- mirrors what each obstacle/manager's own print() writes
// in the upstream client (BoxBuilding::print, MeshObstacle::print,
// BzMaterial::print, GroupDefinition::printGrouped, World::writeWorld, ...),
// which is the same text BZFlag's "Save World" menu item produces.
// ---------------------------------------------------------------------------

function fmt(n) {
  if (Object.is(n, -0)) n = 0;
  if (Number.isInteger(n)) return String(n);
  return String(parseFloat(n.toFixed(6)));
}
function fmt3(v) { return `${fmt(v[0])} ${fmt(v[1])} ${fmt(v[2])}`; }

// Everything an `options` block can carry that parseBZWServerOptions in
// server.js actually reads, derived from the server's own MsgGameSettings/
// MsgQueryGame answers -- so a map loaded into bzo plays by close to the same
// rules it was surveyed under, not just the same geometry.
// Which of the server's world variables it actually chose. A bzfs sends its
// whole BZDB to a player who enters -- all of upstream's own defaults
// included -- so the ones that differ from `BZDB_DEFAULTS`, plus any name
// upstream does not define at all (a map's or a plugin's own variable, which
// cannot have a default to match), are the whole of what this server says
// that a stock one does not. Deliberately not filtered down to the variables
// bzo itself reads: a map that is played at `_tankSpeed 40` should say so in
// the file even while bzo is still playing it at 25, both so the gap is
// visible and so `-set` shows up in the unread-keyword tally that
// `docs/bzw-plan.md` is prioritized from.
// Two names a server always sends that are not settings:
//
// `poll` is not a value at all -- bzfs stores the VotingArbiter's *pointer*
// there (`BZDB.setPointer("poll", ...)`, bzfs.cxx:6770), so it arrives as a
// decimal memory address that differs on every import of the same server and
// means nothing anywhere else. Upstream's own recorder skips it by name for
// the same reason (`RecordReplay.cxx:1486`).
//
// `_worldSize` is real, but the `world` block in the very file this is
// writing already states it; recording it twice only invites the two to
// disagree.
const NON_SETTING_VARIABLES = new Set(['poll', '_worldSize']);

function collectNonDefaultVariables(variables) {
  if (!variables) return [];
  const out = [];
  for (const [name, value] of variables) {
    if (typeof name !== 'string' || typeof value !== 'string') continue;
    if (NON_SETTING_VARIABLES.has(name)) continue;
    // A name or value carrying a newline or a quote would not survive the
    // round trip through a `.bzw` line, and nothing upstream defines one.
    if (/[\s"]/.test(name) || /[\n\r"]/.test(value)) continue;
    if (BZDB_DEFAULTS[name] === value) continue;
    out.push([name, value]);
  }
  out.sort((a, b) => a[0].localeCompare(b[0]));
  return out;
}

function buildOptionsLines(gameSettings, queryGame, listInfo, variables) {
  const lines = [];
  const has = (bit) => (gameSettings.gameOptionsBits & bit) !== 0;
  // GameType (`include/global.h:94`) is its own axis from the GameOptions
  // bitmask below, and bzo's own parser already reads all three switches
  // that select it (docs/bzw.md, "The `options` block"; how bzo reaches
  // each type from them is in docs/game-modes-plan.md, "What bzo has").
  // TeamFFA (0) is upstream's own default and needs no switch -- and, like
  // upstream itself, there is no switch to *force* it either, so a TeamFFA
  // source loaded onto a server whose own config defaults elsewhere plays
  // by that config's default instead, the same gap a real bzfs's own "Save
  // World" has.
  if (gameSettings.gameType === 1) lines.push('  -c');
  else if (gameSettings.gameType === 2) lines.push('  -offa');
  else if (gameSettings.gameType === 3) lines.push('  -rabbit');
  if (has(GAME_OPTION_BITS.jumping)) lines.push('  -j');
  if (has(GAME_OPTION_BITS.ricochet)) lines.push('  +r');
  if (has(GAME_OPTION_BITS.antidote)) lines.push('  -sa');
  if (has(GAME_OPTION_BITS.shaking)) {
    lines.push(`  -st ${fmt(gameSettings.shakeTimeout / 10)}`);
    lines.push(`  -sw ${gameSettings.shakeWins}`);
  }
  // `-handicap` (`CmdLineOptions.cxx:830-833`) -- recorded faithfully even
  // though bzo does not act on it yet (`docs/game-modes-plan.md`,
  // "Handicap"): the source server's own setting belongs in the file
  // regardless of whether bzo's own parser does anything with it today.
  if (has(GAME_OPTION_BITS.handicap)) lines.push('  -handicap');
  if (has(GAME_OPTION_BITS.noTeamKills)) lines.push('  -noTeamKills');
  if (gameSettings.linearAcceleration !== 0 || gameSettings.angularAcceleration !== 0) {
    lines.push(`  -a ${fmt(gameSettings.linearAcceleration)} ${fmt(gameSettings.angularAcceleration)}`);
  }
  lines.push(`  -ms ${gameSettings.maxShots}`);
  if (has(GAME_OPTION_BITS.flags) && gameSettings.numFlags > 0) {
    lines.push(`  -s ${gameSettings.numFlags}`);
  } else if (has(GAME_OPTION_BITS.antidote) || has(GAME_OPTION_BITS.shaking)) {
    // Antidote and Shakable only mean anything with a bad flag actually in
    // play, so the source server must have superflags on even when this
    // snapshot's `numFlags` came back 0 or the `flags` bit itself did not --
    // upstream's own default count for a bare `+s`/`-s 0`
    // (`CmdLineOptions.cxx:1174-1178`). The exact count isn't known, but
    // that flags exist at all is, from these two bits alone.
    lines.push('  -s 16');
  }
  // `-mp a,b,c,d,e,f` (rogue, red, green, blue, purple, observer -- the same
  // order `BZFLAG_MP_TEAM_ORDER` in `server/teams.cjs` already expects).
  // `queryGame`'s own live answer is preferred; the list server's cached
  // ping-hex (`listInfo`) is the fallback for a server that did not answer
  // `MsgQueryGame` on this particular import.
  const teamMaximums = queryGame?.teamMaximums || listInfo?.teamMaximums || null;
  if (teamMaximums && teamMaximums.some((n) => n > 0)) {
    lines.push(`  -mp ${teamMaximums.join(',')}`);
  }
  if (queryGame) {
    if (queryGame.maxPlayerScore > 0) lines.push(`  -mps ${queryGame.maxPlayerScore}`);
    if (queryGame.maxTeamScore > 0) lines.push(`  -mts ${queryGame.maxTeamScore}`);
    if (queryGame.maxTime > 0) lines.push(`  -time ${fmt(queryGame.maxTime / 10)}`);
  }
  // `-set` last, after every switch above: a reader looking for what makes
  // this server unusual finds the ordinary options first, in the order a
  // hand-written map states them. A value with a space in it -- upstream has
  // several, `_ambientLight` among them -- is quoted, which is how bzo's own
  // parser reads it back.
  for (const [name, value] of collectNonDefaultVariables(variables)) {
    lines.push(`  -set ${name} ${/\s/.test(value) || value === '' ? `"${value}"` : value}`);
  }
  return lines;
}

function buildBZWText(serverMeta, tree, fetchedAt) {
  const {
    managers, world, groupDefs, links, waterLevel, waterMaterial, weapons, zones, worldSize,
    gameSettings, queryGame, variables,
  } = tree;
  const { dynamicColors, textureMatrices, materials, physicsDrivers, meshTransforms } = managers;

  function ref(list, idx) {
    if (idx == null || idx < 0) return '-1';
    const item = list[idx];
    return item && item.name ? item.name : String(idx);
  }

  function printTransformOps(lines, ops, indent) {
    for (const op of ops) {
      if (op.type === 0) lines.push(`${indent}  shift ${fmt3(op.data)}`);
      else if (op.type === 1) lines.push(`${indent}  scale ${fmt3(op.data)}`);
      else if (op.type === 2) lines.push(`${indent}  shear ${fmt3(op.data)}`);
      else if (op.type === 3) lines.push(`${indent}  spin ${fmt(op.spin * 180 / Math.PI)} ${fmt3(op.data)}`);
      else if (op.type === 4) lines.push(`${indent}  xform ${ref(meshTransforms, op.index)}`);
    }
  }

  function printBoxLike(lines, keyword, o, indent) {
    lines.push(`${indent}${keyword}`);
    lines.push(`${indent}  position ${fmt3(o.pos)}`);
    lines.push(`${indent}  size ${fmt3(o.size)}`);
    lines.push(`${indent}  rotation ${fmt(o.angle * 180 / Math.PI)}`);
    if (keyword === 'pyramid' && o.flipZ) lines.push(`${indent}  flipz`);
    if (o.driveThrough && o.shootThrough) lines.push(`${indent}  passable`);
    else {
      if (o.driveThrough) lines.push(`${indent}  drivethrough`);
      if (o.shootThrough) lines.push(`${indent}  shootthrough`);
    }
    if (o.ricochet) lines.push(`${indent}  ricochet`);
    lines.push(`${indent}end`);
  }

  function printBase(lines, o, indent) {
    lines.push(`${indent}base`);
    lines.push(`${indent}  position ${fmt3(o.pos)}`);
    lines.push(`${indent}  size ${fmt3(o.size)}`);
    lines.push(`${indent}  rotation ${fmt(o.angle * 180 / Math.PI)}`);
    lines.push(`${indent}  color ${o.team}`);
    if (o.driveThrough && o.shootThrough) lines.push(`${indent}  passable`);
    else {
      if (o.driveThrough) lines.push(`${indent}  drivethrough`);
      if (o.shootThrough) lines.push(`${indent}  shootthrough`);
    }
    if (o.ricochet) lines.push(`${indent}  ricochet`);
    lines.push(`${indent}end`);
  }

  function printTeleporter(lines, o, indent) {
    lines.push(`${indent}teleporter${o.name ? ` ${o.name}` : ''}`);
    lines.push(`${indent}  position ${fmt3(o.pos)}`);
    lines.push(`${indent}  size ${fmt3(o.size)}`);
    lines.push(`${indent}  rotation ${fmt(o.angle * 180 / Math.PI)}`);
    lines.push(`${indent}  border ${fmt(o.border)}`);
    if (o.horizontal) lines.push(`${indent}  horizontal`);
    if (o.ricochet) lines.push(`${indent}  ricochet`);
    lines.push(`${indent}end`);
  }

  function printMeshFace(lines, f, indent) {
    lines.push(`${indent}  face`);
    lines.push(`${indent}    vertices ${f.vertexIdx.join(' ')}`);
    if (f.normalIdx) lines.push(`${indent}    normals ${f.normalIdx.join(' ')}`);
    if (f.texcoordIdx) lines.push(`${indent}    texcoords ${f.texcoordIdx.join(' ')}`);
    lines.push(`${indent}    matref ${ref(materials, f.matindex)}`);
    if (f.phydrv >= 0 && physicsDrivers[f.phydrv]) lines.push(`${indent}    phydrv ${ref(physicsDrivers, f.phydrv)}`);
    if (f.noclusters) lines.push(`${indent}    noclusters`);
    if (f.smoothBounce) lines.push(`${indent}    smoothBounce`);
    if (f.driveThrough && f.shootThrough) lines.push(`${indent}    passable`);
    else {
      if (f.driveThrough) lines.push(`${indent}    driveThrough`);
      if (f.shootThrough) lines.push(`${indent}    shootThrough`);
    }
    if (f.ricochet) lines.push(`${indent}    ricochet`);
    lines.push(`${indent}  endface`);
  }

  function printMesh(lines, o, indent) {
    lines.push(`${indent}mesh`);
    if (o.name) lines.push(`${indent}  name ${o.name}`);
    // `MeshDrawInfo`'s own `angvel` (#88), re-stated as a plain mesh property
    // rather than the unused `drawInfo { ... }` sub-block it travelled in
    // upstream -- bzo's own mesh parser reads it directly (see
    // `docs/bzw.md`'s Mesh section).
    if (o.angvel) lines.push(`${indent}  angvel ${fmt(o.angvel)}`);
    for (const c of o.checks) lines.push(`${indent}  ${c.type === 0 ? 'inside' : 'outside'} ${fmt3(c.point)}`);
    for (const v of o.vertices) lines.push(`${indent}  vertex ${fmt3(v)}`);
    for (const n of o.normals) lines.push(`${indent}  normal ${fmt3(n)}`);
    for (const t of o.texcoords) lines.push(`${indent}  texcoord ${fmt(t[0])} ${fmt(t[1])}`);
    if (o.noclusters) lines.push(`${indent}  noclusters`);
    if (o.smoothBounce) lines.push(`${indent}  smoothBounce`);
    if (o.driveThrough && o.shootThrough) lines.push(`${indent}  passable`);
    else {
      if (o.driveThrough) lines.push(`${indent}  driveThrough`);
      if (o.shootThrough) lines.push(`${indent}  shootThrough`);
    }
    if (o.ricochet) lines.push(`${indent}  ricochet`);
    for (const f of o.faces) printMeshFace(lines, f, indent);
    lines.push(`${indent}end`);
  }

  function printCurved(lines, kind, o, indent) {
    lines.push(`${indent}${kind}`);
    lines.push(`${indent}  position ${fmt3(o.pos)}`);
    lines.push(`${indent}  size ${fmt3(o.size)}`);
    lines.push(`${indent}  rotation ${fmt(o.angle * 180 / Math.PI)}`);
    if (o.sweepAngle != null) lines.push(`${indent}  angle ${fmt(o.sweepAngle)}`);
    if (o.ratio != null) lines.push(`${indent}  ratio ${fmt(o.ratio)}`);
    lines.push(`${indent}  divisions ${o.divisions}`);
    if (kind === 'sphere' && o.hemisphere) lines.push(`${indent}  hemisphere`);
    printTransformOps(lines, o.transform.ops, indent);
    lines.push(`${indent}  texsize ${o.texsize.map(fmt).join(' ')}`);
    const sideNames = kind === 'arc' ? ['top', 'bottom', 'inside', 'outside', 'startside', 'endside']
      : kind === 'cone' ? ['edge', 'bottom', 'startside', 'endside'] : ['edge', 'bottom'];
    sideNames.forEach((side, i) => lines.push(`${indent}  ${side} matref ${ref(materials, o.materials[i])}`));
    if (o.phydrv >= 0 && physicsDrivers[o.phydrv]) lines.push(`${indent}  phydrv ${ref(physicsDrivers, o.phydrv)}`);
    if (o.smoothBounce) lines.push(`${indent}  smoothBounce`);
    if (o.driveThrough) lines.push(`${indent}  driveThrough`);
    if (o.shootThrough) lines.push(`${indent}  shootThrough`);
    if (o.ricochet) lines.push(`${indent}  ricochet`);
    if (!o.useNormals) lines.push(`${indent}  flatshading`);
    lines.push(`${indent}end`);
  }

  function printTetra(lines, o, indent) {
    lines.push(`${indent}tetra`);
    printTransformOps(lines, o.transform.ops, indent);
    for (let i = 0; i < 4; i++) {
      lines.push(`${indent}  vertex ${fmt3(o.vertices[i])}`);
      if (o.normals[i]) for (const n of o.normals[i]) lines.push(`${indent}  normal ${fmt3(n)}`);
      if (o.texcoords[i]) for (const t of o.texcoords[i]) lines.push(`${indent}  texcoord ${fmt(t[0])} ${fmt(t[1])}`);
      lines.push(`${indent}  matref ${ref(materials, o.materials[i])}`);
    }
    if (o.driveThrough && o.shootThrough) lines.push(`${indent}  passable`);
    else {
      if (o.driveThrough) lines.push(`${indent}  drivethrough`);
      if (o.shootThrough) lines.push(`${indent}  shootthrough`);
    }
    if (o.ricochet) lines.push(`${indent}  ricochet`);
    lines.push(`${indent}end`);
  }

  function printGroupInstance(lines, inst, indent) {
    lines.push(`${indent}group ${inst.groupdef}`);
    if (inst.name) lines.push(`${indent}  name ${inst.name}`);
    printTransformOps(lines, inst.transform.ops, indent);
    if (inst.modifyTeam) lines.push(`${indent}  team ${inst.team}`);
    if (inst.modifyColor) lines.push(`${indent}  tint ${inst.tint.map(fmt).join(' ')}`);
    if (inst.modifyPhysicsDriver) lines.push(`${indent}  phydrv ${ref(physicsDrivers, inst.phydrv)}`);
    if (inst.modifyMaterial) lines.push(`${indent}  matref ${ref(materials, inst.material)}`);
    else for (const [src, dst] of inst.matMap) lines.push(`${indent}  matswap ${ref(materials, src)} ${ref(materials, dst)}`);
    if (inst.driveThrough) lines.push(`${indent}  driveThrough`);
    if (inst.shootThrough) lines.push(`${indent}  shootThrough`);
    if (inst.ricochet) lines.push(`${indent}  ricochet`);
    lines.push(`${indent}end`);
    lines.push('');
  }

  function printGroupDefinitionBody(lines, def, indent) {
    for (const kind of OBSTACLE_ORDER) {
      if (kind === 'wall') continue; // the world border, never a mapper-placed obstacle
      for (const o of def.obstacles[kind]) {
        if (kind === 'box') printBoxLike(lines, 'box', o, indent);
        else if (kind === 'pyr') printBoxLike(lines, 'pyramid', o, indent);
        else if (kind === 'base') printBase(lines, o, indent);
        else if (kind === 'tele') printTeleporter(lines, o, indent);
        else if (kind === 'mesh') printMesh(lines, o, indent);
        else if (kind === 'arc' || kind === 'cone' || kind === 'sphere') printCurved(lines, kind, o, indent);
        else if (kind === 'tetra') printTetra(lines, o, indent);
        lines.push('');
      }
    }
    for (const inst of def.groupInstances) printGroupInstance(lines, inst, indent);
  }

  function printDynamicColorBlock(lines, d) {
    lines.push('dynamicColor');
    if (d.name) lines.push(`  name ${d.name}`);
    const names = ['red', 'green', 'blue', 'alpha'];
    d.channels.forEach((p, c) => {
      const label = names[c];
      if (p.min !== 0 || p.max !== 1) lines.push(`  ${label} limits ${fmt(p.min)} ${fmt(p.max)}`);
      if (p.sequence.list.length) lines.push(`  ${label} sequence ${fmt(p.sequence.period)} ${fmt(p.sequence.offset)} ${p.sequence.list.join(' ')}`);
      for (const s of p.sinusoids) lines.push(`  ${label} sinusoid ${fmt(s.period)} ${fmt(s.offset)} ${fmt(s.weight)}`);
      for (const c2 of p.clampUps) lines.push(`  ${label} clampup ${fmt(c2.period)} ${fmt(c2.offset)} ${fmt(c2.width)}`);
      for (const c2 of p.clampDowns) lines.push(`  ${label} clampdown ${fmt(c2.period)} ${fmt(c2.offset)} ${fmt(c2.width)}`);
    });
    lines.push('end');
    lines.push('');
  }

  function printTextureMatrixBlock(lines, t) {
    lines.push('textureMatrix');
    if (t.name) lines.push(`  name ${t.name}`);
    if (t.useStatic) {
      if (t.rotation !== 0) lines.push(`  fixedspin ${fmt(t.rotation)}`);
      if (t.uFixedShift !== 0 || t.vFixedShift !== 0) lines.push(`  fixedshift ${fmt(t.uFixedShift)} ${fmt(t.vFixedShift)}`);
      if (t.uFixedScale !== 1 || t.vFixedScale !== 1) lines.push(`  fixedscale ${fmt(t.uFixedScale)} ${fmt(t.vFixedScale)}`);
      if (t.uFixedCenter !== 0.5 || t.vFixedCenter !== 0.5) lines.push(`  fixedcenter ${fmt(t.uFixedCenter)} ${fmt(t.vFixedCenter)}`);
    }
    if (t.useDynamic) {
      if (t.spinFreq !== 0) lines.push(`  spin ${fmt(t.spinFreq)}`);
      if (t.uShiftFreq !== 0 || t.vShiftFreq !== 0) lines.push(`  shift ${fmt(t.uShiftFreq)} ${fmt(t.vShiftFreq)}`);
      if (t.uScaleFreq !== 0 || t.vScaleFreq !== 0 || t.uScale !== 1 || t.vScale !== 1) {
        lines.push(`  scale ${fmt(t.uScaleFreq)} ${fmt(t.vScaleFreq)} ${fmt(t.uScale)} ${fmt(t.vScale)}`);
      }
      if (t.uCenter !== 0.5 || t.vCenter !== 0.5) lines.push(`  center ${fmt(t.uCenter)} ${fmt(t.vCenter)}`);
    }
    lines.push('end');
    lines.push('');
  }

  function printMaterialBlock(lines, m) {
    lines.push('material');
    if (m.name) lines.push(`  name ${m.name}`);
    if (m.dynamicColor >= 0) lines.push(`  dyncol ${ref(dynamicColors, m.dynamicColor)}`);
    lines.push(`  ambient ${m.ambient.map(fmt).join(' ')}`);
    lines.push(`  diffuse ${m.diffuse.map(fmt).join(' ')}`);
    lines.push(`  specular ${m.specular.map(fmt).join(' ')}`);
    lines.push(`  emission ${m.emission.map(fmt).join(' ')}`);
    lines.push(`  shininess ${fmt(m.shininess)}`);
    lines.push(`  alphathresh ${fmt(m.alphaThreshold)}`);
    if (m.occluder) lines.push('  occluder');
    if (m.groupAlpha) lines.push('  groupAlpha');
    if (m.noRadar) lines.push('  noradar');
    if (m.noShadow) lines.push('  noshadow');
    if (m.noCulling) lines.push('  noculling');
    if (m.noSorting) lines.push('  nosorting');
    if (m.noLighting) lines.push('  nolighting');
    for (const tex of m.textures) {
      lines.push(`  addtexture ${tex.name}`);
      if (tex.matrix !== -1) lines.push(`    texmat ${ref(textureMatrices, tex.matrix)}`);
      if (!tex.useAlpha) lines.push('    notexalpha');
      if (!tex.useColor) lines.push('    notexcolor');
      if (tex.useSphereMap) lines.push('    spheremap');
    }
    for (const sh of m.shaders) lines.push(`  addshader ${sh.name}`);
    lines.push('end');
    lines.push('');
  }

  function printPhysicsDriverBlock(lines, p) {
    lines.push('physics');
    if (p.name) lines.push(`  name ${p.name}`);
    if (p.linear.some((v) => v !== 0)) lines.push(`  linear ${fmt3(p.linear)}`);
    if (p.angularVel !== 0) lines.push(`  angular ${fmt(p.angularVel / (Math.PI * 2))} ${fmt(p.angularPos[0])} ${fmt(p.angularPos[1])}`);
    if (p.radialVel !== 0) lines.push(`  radial ${fmt(p.radialVel)} ${fmt(p.radialPos[0])} ${fmt(p.radialPos[1])}`);
    if (p.slideTime !== 0) lines.push(`  slide ${fmt(p.slideTime)}`);
    if (p.deathMsg) lines.push(`  death ${p.deathMsg}`);
    lines.push('end');
    lines.push('');
  }

  function printMeshTransformBlock(lines, t) {
    lines.push('transform');
    if (t.name) lines.push(`  name ${t.name}`);
    printTransformOps(lines, t.ops, '');
    lines.push('end');
    lines.push('');
  }

  const lines = [];
  lines.push(`# downloaded by bzo (https://github.com/timriker/bzo) from ${serverMeta.host}:${serverMeta.port}${serverMeta.title ? ` -- ${serverMeta.title}` : ''}`);
  lines.push(`# fetched ${fetchedAt}`);
  lines.push('#');
  lines.push('# this is a reconstruction of the world bzfs sent over the wire, not the');
  lines.push('# original .bzw source -- the server never transmits map file text, only the');
  lines.push('# compiled obstacle/material data (same as BZFlag\'s own "Save World" menu item,');
  lines.push('# World::writeWorld), so no comments or authorship from the original map survive.');
  lines.push('');

  if (worldSize != null) {
    lines.push('world');
    lines.push(`  size ${fmt(worldSize / 2)}`);
    // `BZWReader::defineWorldFromFile` only calls `makeWalls()` (the four
    // border `WallObstacle`s) when `noWalls` was never set -- so a `nowalls`
    // map's own compiled world simply has none, on the wire or in
    // `world.obstacles.wall` here, same as an ordinary mapper-placed
    // obstacle a map chose not to include. Nothing else on the wire says
    // `nowalls` directly; an empty `wall` array is the only signal left once
    // the world is already compiled, so it is read back the same way.
    if (world.obstacles.wall.length === 0) lines.push('  nowalls');
    lines.push('end');
    lines.push('');
  }

  if (gameSettings) {
    lines.push('options');
    for (const line of buildOptionsLines(gameSettings, queryGame, serverMeta.listInfo, variables)) lines.push(line);
    lines.push('end');
    lines.push('');
  }

  for (const d of dynamicColors) printDynamicColorBlock(lines, d);
  for (const t of textureMatrices) printTextureMatrixBlock(lines, t);
  for (const m of materials) printMaterialBlock(lines, m);
  for (const p of physicsDrivers) printPhysicsDriverBlock(lines, p);
  for (const t of meshTransforms) printMeshTransformBlock(lines, t);

  for (const def of groupDefs) {
    lines.push(`define ${def.name}`);
    printGroupDefinitionBody(lines, def, '  ');
    lines.push('enddef');
    lines.push('');
  }

  printGroupDefinitionBody(lines, world, '');

  for (const link of links) {
    lines.push('link');
    lines.push(`  from ${link.src}`);
    lines.push(`  to   ${link.dst}`);
    lines.push('end');
    lines.push('');
  }

  if (waterLevel >= 0) {
    lines.push('waterLevel');
    lines.push(`  height ${fmt(waterLevel)}`);
    lines.push(`  matref ${ref(materials, waterMaterial)}`);
    lines.push('end');
    lines.push('');
  }

  for (const w of weapons) {
    lines.push('weapon');
    if (w.flagAbbv) lines.push(`  type ${w.flagAbbv}`);
    lines.push(`  position ${fmt3(w.pos)}`);
    lines.push(`  rotation ${fmt(w.dir * 180 / Math.PI)}`);
    lines.push(`  initdelay ${fmt(w.initDelay)}`);
    if (w.delay.length) lines.push(`  delay ${w.delay.map(fmt).join(' ')}`);
    lines.push('end');
    lines.push('');
  }

  for (const z of zones) {
    lines.push('zone');
    lines.push(`  position ${fmt3(z.pos)}`);
    lines.push(`  size ${fmt3(z.size)}`);
    lines.push(`  rotation ${fmt(z.rot * 180 / Math.PI)}`);
    if (z.flags.length) lines.push(`  flag ${z.flags.join(' ')}`);
    if (z.teams.length) lines.push(`  team ${z.teams.join(' ')}`);
    if (z.safety.length) lines.push(`  safety ${z.safety.join(' ')}`);
    lines.push('end');
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  PROTOCOL_VERSION,
  // The wire plumbing, for `bzfs-session.cjs`: a proxy speaks the same
  // protocol to the same servers, and there is one implementation of it.
  Reader,
  sendFrame,
  createFrameReader,
  buildEnterPayload,
  decodeSetVars,
  DEFAULT_LIST_SERVER,
  OBSTACLE_ORDER,
  GAME_STYLES,
  GAME_OPTION_BITS,
  decodePingHex,
  findPublicServer,
  fetchServerList,
  fetchWorldFromServer,
  probeGlobalToken,
  collectNonDefaultVariables,
  decodeGameSettings,
  decodeQueryGame,
  parseWorldDatabase,
  buildBZWText,
};
