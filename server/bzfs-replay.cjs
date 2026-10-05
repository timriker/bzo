/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// A bzfs recording (`/record`, `src/bzfs/RecordReplay.cxx`) read into memory
// and written back out. Nothing here plays one: the packets are bzfs messages
// exactly as they were broadcast, and `BzfsSession.handleFrame` is what reads
// those. See docs/replay-plan.md.

// "rrBZ" (RecordReplay.cxx:84). Version 1 is the only one upstream writes.
const REPLAY_MAGIC = 0x7272425A;
const REPLAY_VERSION = 1;
// `CallSignLen`, `MottoLen`, the protocol string, `MessageLen` (global.h), the
// world hash, and four bytes plus `WorldSettingsSize` of game settings
// (RecordReplay.h:144). `HEADER_SIZE_STUFFING` is 0.
const CALLSIGN_LEN = 32;
const MOTTO_LEN = 128;
const PROTOCOL_LEN = 8;
const APP_VERSION_LEN = 128;
const HASH_LEN = 64;
const WORLD_SETTINGS_LEN = 4 + 30;
const HEADER_SIZE = 6 * 4 + 8 + CALLSIGN_LEN + MOTTO_LEN + PROTOCOL_LEN
  + APP_VERSION_LEN + HASH_LEN + WORLD_SETTINGS_LEN;
// Mode, code, length, next and previous file position, timestamp, and the
// eight bytes of `PACKET_SIZE_STUFFING` that follow them unused.
const PACKET_HEADER_SIZE = 2 + 2 + 4 + 4 + 4 + 8 + 8;

// `PacketMode` (RecordReplay.h:23). Real packets are what a viewer is sent;
// state packets restore a viewer who has not seen the game yet; an update
// packet is the empty marker before each set of state packets, written every
// `DefaultUpdateRate` (10 s); hidden packets are never sent at all, and are
// where private chat, `/` commands and players' addresses live.
const PACKET_MODE = Object.freeze({ REAL: 0, STATE: 1, UPDATE: 2, HIDDEN: 3 });

// An `RRtime` is microseconds in an int64, packed as two u32s, high first.
// A Number holds one exactly until the year 2255.
function readTime(buf, at) {
  return buf.readUInt32BE(at) * 2 ** 32 + buf.readUInt32BE(at + 4);
}

function writeTime(buf, at, value) {
  buf.writeUInt32BE(Math.floor(value / 2 ** 32), at);
  buf.writeUInt32BE(value % 2 ** 32, at + 4);
}

function readFixed(buf, at, len) {
  return buf.toString('latin1', at, at + len).replace(/\0.*$/s, '');
}

// `nboPackString` copies the whole field, so a string is NUL-padded to its
// width, and `strncpy(..., sizeof - 1)` keeps the last byte a NUL.
function writeFixed(buf, at, len, text) {
  buf.write(String(text || ''), at, len - 1, 'latin1');
}

function codeName(code) {
  return String.fromCharCode(code >> 8, code & 0xff);
}

function codeNumber(name) {
  return (name.charCodeAt(0) << 8) | name.charCodeAt(1);
}

// The whole file. Throws on anything that is not a recording, or one cut off
// mid-header; a file cut off mid-packet keeps the packets before the cut, as
// `loadPacket` stops at the first short read.
function readReplay(buf) {
  if (buf.length < HEADER_SIZE) throw new Error('not a bzfs recording: too short');
  if (buf.readUInt32BE(0) !== REPLAY_MAGIC) throw new Error('not a bzfs recording: bad magic');
  const version = buf.readUInt32BE(4);
  if (version !== REPLAY_VERSION) throw new Error(`unsupported recording version ${version}`);
  const fileTime = readTime(buf, 12);
  const player = buf.readUInt32BE(20);
  const flagsSize = buf.readUInt32BE(24);
  const worldSize = buf.readUInt32BE(28);
  let o = 32;
  const callsign = readFixed(buf, o, CALLSIGN_LEN); o += CALLSIGN_LEN;
  const motto = readFixed(buf, o, MOTTO_LEN); o += MOTTO_LEN;
  const protocol = readFixed(buf, o, PROTOCOL_LEN); o += PROTOCOL_LEN;
  // bzfs 2.4.12 to 2.4.13 packed the app version 14 bytes short, shifting
  // what follows; `loadHeader` spots it by the NUL and the "t" or "p" of the
  // next field landing here.
  const shortAppVersion = buf[313] === 0 && (buf[314] === 0x74 || buf[314] === 0x70);
  const appVersionLen = shortAppVersion ? APP_VERSION_LEN - 14 : APP_VERSION_LEN;
  const appVersion = readFixed(buf, o, appVersionLen); o += appVersionLen;
  const worldHash = readFixed(buf, o, HASH_LEN); o += HASH_LEN;
  const worldSettings = Buffer.from(buf.subarray(o, o + WORLD_SETTINGS_LEN));

  o = HEADER_SIZE;
  if (o + flagsSize + worldSize > buf.length) throw new Error('bzfs recording cut off in its header');
  const flagTypes = Buffer.from(buf.subarray(o, o + flagsSize)); o += flagsSize;
  const world = Buffer.from(buf.subarray(o, o + worldSize)); o += worldSize;

  const packets = [];
  while (o + PACKET_HEADER_SIZE <= buf.length) {
    const len = buf.readUInt32BE(o + 4);
    if (o + PACKET_HEADER_SIZE + len > buf.length) break;
    packets.push({
      mode: buf.readUInt16BE(o),
      code: codeName(buf.readUInt16BE(o + 2)),
      time: readTime(buf, o + 16),
      payload: Buffer.from(buf.subarray(o + PACKET_HEADER_SIZE, o + PACKET_HEADER_SIZE + len)),
    });
    o += PACKET_HEADER_SIZE + len;
  }

  return {
    fileTime, player, callsign, motto, protocol, appVersion, worldHash,
    worldSettings, flagTypes, world, packets,
    snapshots: snapshotIndex(packets),
  };
}

// Where each set of state packets starts: the index of every update marker.
// Joining or seeking to a time restores from the last one at or before it,
// as `Replay::skip` does by stepping state packet to state packet.
function snapshotIndex(packets) {
  const out = [];
  packets.forEach((packet, index) => {
    if (packet.mode === PACKET_MODE.UPDATE) out.push(index);
  });
  return out;
}

// The snapshot to restore from for `time`: the index of its update marker, or
// -1 before the first one.
function snapshotAt(replay, time) {
  let found = -1;
  for (const index of replay.snapshots) {
    if (replay.packets[index].time > time) break;
    found = index;
  }
  return found;
}

// A recording as `saveHeader` and `savePacket` write it. `packets` may be any
// subset of a read one -- the hidden ones dropped, say -- because each packet's
// file positions are worked out here rather than carried over.
function writeReplay(replay) {
  const flagTypes = replay.flagTypes || Buffer.alloc(0);
  const world = replay.world || Buffer.alloc(0);
  const packets = replay.packets || [];
  const start = HEADER_SIZE + flagTypes.length + world.length;
  const total = packets.reduce((sum, p) => sum + PACKET_HEADER_SIZE + p.payload.length, start);
  const buf = Buffer.alloc(total);

  buf.writeUInt32BE(REPLAY_MAGIC, 0);
  buf.writeUInt32BE(REPLAY_VERSION, 4);
  buf.writeUInt32BE(start, 8);
  const fileTime = replay.fileTime ?? (packets.length > 0
    ? packets[packets.length - 1].time - packets[0].time : 0);
  writeTime(buf, 12, fileTime);
  buf.writeUInt32BE(replay.player ?? 0, 20);
  buf.writeUInt32BE(flagTypes.length, 24);
  buf.writeUInt32BE(world.length, 28);
  let o = 32;
  writeFixed(buf, o, CALLSIGN_LEN, replay.callsign); o += CALLSIGN_LEN;
  writeFixed(buf, o, MOTTO_LEN, replay.motto); o += MOTTO_LEN;
  // The protocol field is the eight bytes of `getServerVersion()` with no
  // terminator, copied rather than strncpy'd.
  buf.write(String(replay.protocol || ''), o, PROTOCOL_LEN, 'latin1'); o += PROTOCOL_LEN;
  writeFixed(buf, o, APP_VERSION_LEN, replay.appVersion); o += APP_VERSION_LEN;
  writeFixed(buf, o, HASH_LEN, replay.worldHash); o += HASH_LEN;
  if (replay.worldSettings) replay.worldSettings.copy(buf, o, 0, WORLD_SETTINGS_LEN);

  o = HEADER_SIZE;
  flagTypes.copy(buf, o); o += flagTypes.length;
  world.copy(buf, o); o += world.length;

  // `nextFilePos` is where the next packet starts; `prevFilePos` is where the
  // previous one did, 0 for the first (`RecordFilePrevPos` starts at 0).
  let prev = 0;
  for (const packet of packets) {
    const next = o + PACKET_HEADER_SIZE + packet.payload.length;
    buf.writeUInt16BE(packet.mode, o);
    buf.writeUInt16BE(codeNumber(packet.code), o + 2);
    buf.writeUInt32BE(packet.payload.length, o + 4);
    buf.writeUInt32BE(next, o + 8);
    buf.writeUInt32BE(prev, o + 12);
    writeTime(buf, o + 16, packet.time);
    packet.payload.copy(buf, o + PACKET_HEADER_SIZE);
    prev = o;
    o = next;
  }
  return buf;
}

module.exports = {
  PACKET_MODE,
  HEADER_SIZE,
  PACKET_HEADER_SIZE,
  readReplay,
  writeReplay,
  snapshotAt,
};
