/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// bzflag-server.cjs - The bzfs side of the wire, for native BZFlag clients
// (issue #174). It answers what a server browser, bzfquery and the list
// server ask -- the handshake, MsgQueryGame and MsgQueryPlayers -- and turns
// a join away with MsgReject naming where to play instead. It also publishes
// the server to the BZFlag list server as bzfs's ListServerLink does. See
// docs/bzflag-clients.md.

'use strict';

const https = require('https');
const dgram = require('dgram');
const net = require('net');
const {
  PROTOCOL_VERSION, GAME_STYLES, sendFrame,
} = require('./remote-world-import.cjs');

// BZ_CONNECT_HEADER (version.h:31): what a client says first.
const CONNECT_HEADER = 'BZFLAG\r\n\r\n';
// MessageLen (Protocol.h): the reject reason's fixed field.
const MESSAGE_LEN = 128;
const CALLSIGN_LEN = 32;
const MOTTO_LEN = 128;
// NumTeams (global.h): rogue, red, green, blue, purple, observer, rabbit,
// hunter.
const NUM_TEAMS = 8;
// RejectBadRequest (Protocol.h).
const REJECT_BAD_REQUEST = 0;
// `RejectIPBanned` and `RejectIDBanned` (Protocol.h:168).
const REJECT_IP_BANNED = 0x0009;
const REJECT_ID_BANNED = 0x000B;
// A connection that never finishes its handshake or asks anything is closed.
const IDLE_TIMEOUT_MS = 30000;
// Connections held at once; past it a client gets 0xff, bzfs's "full".
const MAX_CONNECTIONS = 32;
// The ping packet's hex form (Ping.cxx `packHex`): eight u16s, thirteen u8s.
const PING_HEX_LENGTH = 4 * 8 + 2 * 13;

const u16 = (value) => Math.max(0, Math.min(0xffff, Math.round(Number(value) || 0)));
const u8 = (value) => Math.max(0, Math.min(0xff, Math.round(Number(value) || 0)));

function styleIndex(style) {
  const index = GAME_STYLES.indexOf(style);
  return index >= 0 ? index : GAME_STYLES.indexOf('OpenFFA');
}

// `PingPacket::packHex`: the `gameinfo` an ADD carries.
function packPingHex(status) {
  const hex16 = (value) => u16(value).toString(16).padStart(4, '0');
  const hex8 = (value) => u8(value).toString(16).padStart(2, '0');
  const counts = status.teamCounts || [];
  const maximums = status.teamMaximums || [];
  let out = [
    styleIndex(status.style), status.gameOptionsBits, status.maxShots,
    status.shakeWins, status.shakeTimeout, status.maxPlayerScore,
    status.maxTeamScore, status.maxTime,
  ].map(hex16).join('');
  out += hex8(status.maxPlayers);
  for (let team = 0; team < 6; team += 1) out += hex8(counts[team]) + hex8(maximums[team]);
  return out;
}

// `sendQueryGame` (bzfs.cxx:3113).
function packQueryGame(status, elapsedSeconds) {
  const counts = status.teamCounts || [];
  const maximums = status.teamMaximums || [];
  const values = [
    styleIndex(status.style), status.gameOptionsBits, status.maxPlayers, status.maxShots,
    ...Array.from({ length: 6 }, (_, team) => counts[team]),
    ...Array.from({ length: 6 }, (_, team) => maximums[team]),
    status.shakeWins, status.shakeTimeout, status.maxPlayerScore,
    status.maxTeamScore, status.maxTime, elapsedSeconds,
  ];
  const payload = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => payload.writeUInt16BE(u16(value), index * 2));
  return payload;
}

// What rides UDP once the link is up (`ServerLink::send`, ServerLink.cxx:428):
// the messages sent constantly, and the link's own.
const UDP_CODES = new Set(['sb', 'se', 'pu', 'ps', 'gm', 'of', 'og']);

// MsgPingCodeRequest and MsgPingCodeReply (Protocol.h), bzfs's UDP ping on
// its game port (bzfs.cxx:7690).
const PING_REQUEST = 0x0404;
const PING_REPLY = 0x0303;
// `PingPacket::PacketSize`: ServerIdPLen + 52, zero padded past the body.
const PING_PACKET_SIZE = 8 + 52;

// `PingPacket::write`: the version, a ServerId (address, port, number), the
// source Address (a length byte and four address bytes), then the same
// fields `packHex` carries, as binary.
function packPingReply(status, port) {
  const packet = Buffer.alloc(PING_PACKET_SIZE);
  packet.writeUInt16BE(PING_PACKET_SIZE - 4, 0);
  packet.writeUInt16BE(PING_REPLY, 2);
  packet.write(PROTOCOL_VERSION, 4, 8, 'latin1');
  packet.writeUInt16BE(u16(port), 16);
  packet.writeUInt8(4, 20);
  const hex = packPingHex(status);
  Buffer.from(hex, 'hex').copy(packet, 25);
  return packet;
}

// `makeGameSettings` (bzfs.cxx:3074), header included: bzfs writes the whole
// prebuilt message.
const PLAYER_SLOT = 200 + 16;
function packGameSettings(settings) {
  const payload = Buffer.alloc(30);
  payload.writeFloatBE(settings.worldSize, 0);
  payload.writeUInt16BE(styleIndex(settings.style), 4);
  payload.writeUInt16BE(u16(settings.gameOptionsBits), 6);
  payload.writeUInt16BE(PLAYER_SLOT, 8);
  payload.writeUInt16BE(u16(settings.maxShots), 10);
  payload.writeUInt16BE(u16(settings.numFlags), 12);
  payload.writeFloatBE(Number(settings.linearAcceleration) || 0, 14);
  payload.writeFloatBE(Number(settings.angularAcceleration) || 0, 18);
  payload.writeUInt16BE(u16(settings.shakeTimeout), 22);
  payload.writeUInt16BE(u16(settings.shakeWins), 24);
  return payload;
}

// `sendWorld` (bzfs.cxx:3050): a byte count, then the chunk.
const WORLD_CHUNK = 1024 - (2 * 2) - 4;
function packWorldChunk(blob, offset) {
  const start = Math.min(offset, blob.length);
  const end = Math.min(blob.length, start + WORLD_CHUNK);
  const payload = Buffer.alloc(4 + (end - start));
  // What was left before this chunk, or 0 once it is the last.
  payload.writeUInt32BE(end >= blob.length ? 0 : blob.length - start, 0);
  blob.copy(payload, 4, start, end);
  return payload;
}

// MsgGameTime (`GameTime::pack`, GameTime.cxx:235): the server's clock in
// microseconds, plus half the lag -- 75ms where there is no measure of it --
// as two u32s. The client's animations run on it.
function packGameTime() {
  const now = (BigInt(Date.now()) * 1000n) + 75000n;
  const payload = Buffer.alloc(8);
  payload.writeUInt32BE(Number(now >> 32n), 0);
  payload.writeUInt32BE(Number(now & 0xffffffffn), 4);
  return payload;
}
// `updateNextGameTime` (GameKeeper.cxx:188): a second at first, a quarter
// longer each time, then every ten.
const GAME_TIME_START_RATE = 1.0;
const GAME_TIME_FINAL_RATE = 10.0;
function sendGameTime(connection, rate) {
  if (connection.socket.destroyed) return;
  sendFrame(connection.socket, 'gt', packGameTime());
  const next = Math.min(GAME_TIME_FINAL_RATE, rate * 1.25);
  connection.gameTimeTimer = setTimeout(() => sendGameTime(connection, next), rate * 1000);
}

// MsgTeamUpdate: a count, then (team, size, wins, losses) for each.
function packTeamUpdate(teams) {
  const payload = Buffer.alloc(1 + (teams.length * 8));
  payload.writeUInt8(teams.length, 0);
  teams.forEach((team, index) => {
    const at = 1 + (index * 8);
    payload.writeUInt16BE(u16(team.team), at);
    payload.writeUInt16BE(u16(team.size), at + 2);
    payload.writeUInt16BE(u16(team.wins), at + 4);
    payload.writeUInt16BE(u16(team.losses), at + 6);
  });
  return payload;
}

// MsgAddPlayer: `packPlayerUpdate` -- id, type, team, wins, losses, tks,
// callsign and motto in their fixed fields.
function packAddPlayer(player) {
  const payload = Buffer.alloc(1 + (2 * 5) + CALLSIGN_LEN + MOTTO_LEN);
  payload.writeUInt8(u8(player.id), 0);
  payload.writeUInt16BE(u16(player.type), 1);
  payload.writeUInt16BE(u16(player.team), 3);
  payload.writeUInt16BE(u16(player.wins), 5);
  payload.writeUInt16BE(u16(player.losses), 7);
  payload.writeUInt16BE(u16(player.tks), 9);
  payload.write(String(player.callsign || ''), 11, CALLSIGN_LEN - 1, 'latin1');
  payload.write(String(player.motto || ''), 11 + CALLSIGN_LEN, MOTTO_LEN - 1, 'latin1');
  return payload;
}

// `rejectPlayer` (bzfs.cxx:1770): a code and the reason in a MessageLen field.
function packReject(reason, code = REJECT_BAD_REQUEST) {
  const payload = Buffer.alloc(2 + MESSAGE_LEN);
  payload.writeUInt16BE(code, 0);
  payload.write(String(reason), 2, MESSAGE_LEN - 1, 'latin1');
  return payload;
}

// `getStatus()` is this server's list row (`computeListServerStatus`), and
// `getPingStatus()` the same with robots in the team counts, which is what a
// UDP ping and MsgQueryGame answer with (bzfs.cxx:1466, :3123);
// `getPlayers()` and `getTeams()` are what MsgQueryPlayers sends, already in
// upstream's numbering. `rejectReason` is what a client that tries to join is
// told.
// `getGameSettings()` is MsgGameSettings' fields; `getWorld()` resolves to
// `{ blob, hash }` or null when this world cannot be sent; `onEnter(link,
// payload)` seats a client that sent MsgEnter, and `link.onFrame` then takes
// every frame it sends.
function createBzflagServer({
  getStatus, getPingStatus = getStatus, getPlayers, getTeams, getGameSettings, getWorld, getCacheUrl = () => null, onEnter,
  reserveId, releaseId, rejectReason, log = () => {},
}) {
  const startedAt = Date.now();
  const connections = new Set();

  // A connection's id is the player id it will have if it joins
  // (`reserveId`), handed back when it closes.
  function freeId() {
    if (connections.size >= MAX_CONNECTIONS) return 0xff;
    return reserveId();
  }

  function reject(connection, reason, code) {
    log(`[BZFLAG] ${connection.address} rejected: ${reason}`);
    connection.rejected = true;
    sendFrame(connection.socket, 'rj', packReject(reason, code));
    connection.socket.end();
    return false;
  }

  // MsgSuperKill, which bzfs sends a player it drops (`removePlayer`,
  // bzfs.cxx:2907) and every player as it shuts down (bzfs.cxx:1029), so the
  // client says the server cut it off rather than that it lost the link.
  // Not to one that said MsgExit, as bzfs leaves those unnotified.
  function superKill(connection) {
    if (connection.socket.writableEnded || connection.exited) return;
    sendFrame(connection.socket, 'sk');
    connection.socket.end();
  }

  function answer(connection, code, payload) {
    const { socket } = connection;
    if (code === 'ex') connection.exited = true;
    if (connection.link) {
      connection.link.onFrame?.(code, payload);
      return !connection.link.closed;
    }
    if (code === 'qg') {
      sendFrame(socket, 'qg', packQueryGame(getPingStatus(), (Date.now() - startedAt) / 1000));
    } else if (code === 'qp') {
      const players = getPlayers();
      const head = Buffer.alloc(4);
      head.writeUInt16BE(NUM_TEAMS, 0);
      head.writeUInt16BE(u16(players.length), 2);
      sendFrame(socket, 'qp', head);
      sendFrame(socket, 'tu', packTeamUpdate(getTeams()));
      for (const player of players) sendFrame(socket, 'ap', packAddPlayer(player));
    } else if (code === 'nf') {
      // MsgNegotiateFlags: the flags it lacks. bzo's are all upstream's.
      sendFrame(socket, 'nf');
    } else if (code === 'ws') {
      sendFrame(socket, 'gs', packGameSettings(getGameSettings()));
    } else if (code === 'wh') {
      connection.worldPromise = connection.worldPromise || Promise.resolve(getWorld());
      connection.worldPromise.then((world) => {
        if (socket.destroyed) return;
        if (!world) {
          reject(connection, rejectReason());
          return;
        }
        connection.world = world;
        // MsgCacheURL first, as bzfs sends it (bzfs.cxx:4828): the client
        // tries the URL and falls back to MsgGetWorld.
        const cacheUrl = getCacheUrl(world);
        if (cacheUrl) sendFrame(socket, 'cu', Buffer.from(`${cacheUrl}\0`, 'latin1'));
        sendFrame(socket, 'wh', Buffer.from(`${world.hash}\0`, 'latin1'));
      }).catch((error) => reject(connection, `world unavailable: ${error.message}`));
    } else if (code === 'gw') {
      const { world } = connection;
      if (!world || payload.length < 4) return reject(connection, 'world asked for before its hash');
      sendFrame(socket, 'gw', packWorldChunk(world.blob, payload.readUInt32BE(0)));
    } else if (code === 'en') {
      if (!connection.world) return reject(connection, 'joined before the world');
      const link = {
        id: connection.id,
        address: connection.address,
        remoteAddress: socket.remoteAddress,
        closed: false,
        send: (frameCode, body) => {
          if (socket.destroyed) return;
          // The constant messages ride UDP once both ends have heard each
          // other there (`NetHandler::pwrite`); everything else stays on TCP.
          if (connection.udpOut && UDP_CODES.has(frameCode)) sendUdp(connection.udpAddr, frameCode, body);
          else sendFrame(socket, frameCode, body);
        },
        reject: (reason, code) => reject(connection, reason, code),
        // `getPlayerHostInfo`'s ` udp` and `+` (NetHandler.cxx:831): heard
        // from on UDP, and sent to on UDP.
        udpIn: () => Boolean(connection.udpAddr),
        udpOut: () => Boolean(connection.udpOut),
        close: () => { link.closed = true; superKill(connection); },
        onFrame: null,
        onClose: null,
      };
      connection.link = link;
      socket.setTimeout(0);
      onEnter(link, payload);
    } else if (code === 'lp' || code === 'ec' || code === 'pi') {
      // Lag and echo pings need no answer before a client has entered.
    } else {
      return reject(connection, rejectReason());
    }
    return true;
  }

  function accept(socket) {
    const connection = {
      socket, id: 0xff, address: `${socket.remoteAddress}:${socket.remotePort}`, buffer: Buffer.alloc(0), greeted: false,
      asked: [],
    };
    socket.setNoDelay(true);
    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(connection.gameTimeTimer);
      connections.delete(connection);
      if (connection.id !== 0xff) releaseId(connection.id);
      if (connection.link) {
        connection.link.closed = true;
        connection.link.onClose?.();
        return;
      }
      if (!connection.rejected) {
        log(`[BZFLAG] ${connection.address} ${connection.greeted ? 'asked'
          : `hung up before the handshake, having sent ${connection.opening
            || JSON.stringify(connection.buffer.toString('latin1', 0, 40))}`}`
          + `${connection.asked.length ? ` ${connection.asked.join(',')}` : ''}`);
      }
    });
    socket.on('data', (chunk) => {
      connection.buffer = Buffer.concat([connection.buffer, chunk]);
      if (!connection.greeted) {
        if (connection.buffer.length < CONNECT_HEADER.length) return;
        if (connection.buffer.toString('latin1', 0, CONNECT_HEADER.length) !== CONNECT_HEADER) {
          connection.opening = JSON.stringify(connection.buffer.toString('latin1', 0, 40));
          socket.destroy();
          return;
        }
        connection.buffer = connection.buffer.subarray(CONNECT_HEADER.length);
        connection.greeted = true;
        connection.id = freeId();
        // `MakePlayer` (bzfs.cxx:1398): the version and a player id, 0xff
        // when full.
        const hello = Buffer.alloc(9);
        hello.write(PROTOCOL_VERSION, 0, 8, 'latin1');
        hello.writeUInt8(connection.id, 8);
        socket.write(hello);
        if (connection.id === 0xff) {
          socket.end();
          return;
        }
        connections.add(connection);
        sendGameTime(connection, GAME_TIME_START_RATE);
      }
      while (connection.buffer.length >= 4) {
        const length = connection.buffer.readUInt16BE(0);
        if (connection.buffer.length < 4 + length) return;
        const code = connection.buffer.toString('latin1', 2, 4);
        const frame = Buffer.from(connection.buffer.subarray(4, 4 + length));
        connection.buffer = connection.buffer.subarray(4 + length);
        connection.asked.push(code);
        if (!answer(connection, code, frame)) return;
      }
    });
  }

  const server = net.createServer(accept);
  let udp = null;

  function sendUdp(to, code, body = Buffer.alloc(0)) {
    const header = Buffer.alloc(4);
    header.writeUInt16BE(body.length, 0);
    header.write(code, 2, 2, 'latin1');
    udp?.send(Buffer.concat([header, body]), to.port, to.address);
  }

  // The client's half of the UDP link, the same handshake a bzfs answers
  // (`sendUDPupdate`, bzfs.cxx:329). It sends `MsgUDPLinkRequest` naming its
  // player id from the socket it will listen on, straight after the
  // handshake; that address is kept for it -- only from the address its TCP
  // connection came from -- and answered with `MsgUDPLinkEstablished` over
  // TCP and a `MsgUDPLinkRequest` back over UDP. Its own
  // `MsgUDPLinkEstablished`, over UDP, says it heard that; from then on the
  // constant messages go both ways on UDP. A datagram is whole frames, walked
  // in place.
  function receiveUdp(datagram, from) {
    const sameHost = (a, b) => String(a).replace(/^::ffff:/i, '') === String(b).replace(/^::ffff:/i, '');
    let at = 0;
    while (at + 4 <= datagram.length) {
      const length = datagram.readUInt16BE(at);
      const code = datagram.toString('latin1', at + 2, at + 4);
      if (at + 4 + length > datagram.length) return;
      const body = Buffer.from(datagram.subarray(at + 4, at + 4 + length));
      at += 4 + length;
      if (code === 'of') {
        if (body.length < 1) continue;
        const id = body.readUInt8(0);
        const connection = [...connections].find((c) => c.id === id && sameHost(c.socket.remoteAddress, from.address));
        if (!connection) continue;
        connection.udpAddr = { address: from.address, port: from.port };
        sendFrame(connection.socket, 'og');
        sendUdp(connection.udpAddr, 'of');
        continue;
      }
      const connection = [...connections]
        .find((c) => c.udpAddr && c.udpAddr.address === from.address && c.udpAddr.port === from.port);
      if (!connection) continue;
      if (code === 'og') {
        if (!connection.udpOut) log(`[BZFLAG] ${connection.address} on UDP`);
        connection.udpOut = true;
      } else if (UDP_CODES.has(code) && connection.link) {
        connection.link.onFrame?.(code, body);
      }
    }
  }
  return {
    async listen(host, port) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      // The UDP half of the same port. Only the ping is answered; a client's
      // UDP link comes with play.
      udp = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
      udp.on('message', (message, from) => {
        if (message.length < 4) return;
        if (message.readUInt16BE(2) === PING_REQUEST) {
          udp.send(packPingReply(getPingStatus(), port), from.port, from.address);
          return;
        }
        receiveUdp(message, from);
      });
      udp.on('error', (error) => log(`[BZFLAG] UDP: ${error.message}`));
      await new Promise((resolve, reject) => {
        udp.once('error', reject);
        udp.bind(port, host, () => {
          udp.off('error', reject);
          resolve();
        });
      });
    },
    close() {
      for (const connection of connections) superKill(connection);
      server.close();
      udp?.close();
    },
  };
}

// The list server checks that `nameport` resolves to the address the ADD
// came from, and bzfs is IPv4 only, so the request goes over IPv4 even where
// this host would reach my.bzflag.org over IPv6.
function postIpv4(url, body, userAgent) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'POST',
      family: 4,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': userAgent,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(text);
        else reject(new Error(`HTTP ${response.statusCode}: ${text.slice(0, 200)}`));
      });
    });
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

// bzfs's ListServerLink: ADD with the ping hex, the key and the title, and
// REMOVE on the way out. The reply is plain text; bzfs prints it.
async function publishToBzflagList({ listUrl, action, nameport, key, title, status, build, userAgent }) {
  const params = action === 'REMOVE'
    ? `action=REMOVE&nameport=${encodeURIComponent(nameport)}`
    : `action=ADD&nameport=${encodeURIComponent(nameport)}`
      + `&version=${PROTOCOL_VERSION}`
      + `&gameinfo=${packPingHex(status)}`
      + `&build=${encodeURIComponent(build)}`
      + '&checktokens=&groups='
      // bzfs's default (CmdLineOptions.h:66). The list server stores a
      // server's groups when it first adds it, and an empty list advertises
      // it to nobody.
      + `&advertgroups=EVERYONE&title=${encodeURIComponent(title)}`;
  return postIpv4(listUrl, `${params}&key=${encodeURIComponent(key)}`, userAgent);
}

module.exports = {
  REJECT_IP_BANNED,
  REJECT_ID_BANNED,
  createBzflagServer,
  publishToBzflagList,
  packPingHex,
  packQueryGame,
  packGameSettings,
  PING_HEX_LENGTH,
  NUM_TEAMS,
};
