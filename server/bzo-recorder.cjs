/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// bzo's own games as bzfs recordings: upstream's `/record` (RecordReplay.cxx),
// buffered the way `-recbuf` buffers. What bzo broadcasts is kept as the JSON
// it already sent, with a snapshot of the game every `rate`; nothing is
// converted as the game runs. Saving runs a slice of the buffer through
// `NativeTranslator`, which already speaks bzfs to native clients, and the
// result is a recording bzo and `bzfs -replay` both play. See
// docs/replay-plan.md, "Recording".

const { NativeTranslator } = require('./bzflag-native.cjs');
const { PACKET_MODE } = require('./bzfs-replay.cjs');

// `DefaultMaxBytes` and `DefaultUpdateRate` (RecordReplay.cxx:86).
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_RATE_MS = 10_000;
// `ServerPlayer` (global.h): who a server-side recording is by.
const SERVER_PLAYER = 253;
// What one buffered entry costs beyond its text: the object holding it.
const ENTRY_OVERHEAD = 64;

class BroadcastBuffer {
  // `snapshot()` returns the game as an `init`-shaped object: `bzdb`,
  // `flags`, `players`, `teamScores`, `rabbitId`. `now` is milliseconds.
  constructor({ snapshot, now = () => Date.now(), maxBytes = DEFAULT_MAX_BYTES, rateMs = DEFAULT_RATE_MS }) {
    this.snapshot = snapshot;
    this.now = now;
    this.maxBytes = maxBytes;
    this.rateMs = rateMs;
    this.entries = [];
    this.bytes = 0;
    this.lastSnapshotAt = -Infinity;
    this.recording = false;
  }

  start() {
    if (this.recording) return;
    this.recording = true;
    this.takeSnapshot();
  }

  stop() {
    this.recording = false;
    this.entries = [];
    this.bytes = 0;
    this.lastSnapshotAt = -Infinity;
  }

  // `/record size`: the cap, and the buffer cut to it at once.
  setMaxBytes(maxBytes) {
    this.maxBytes = maxBytes;
    this.trim();
  }

  setRateMs(rateMs) {
    this.rateMs = rateMs;
  }

  takeSnapshot() {
    const at = this.now();
    this.push({ at, snapshot: JSON.stringify(this.snapshot()) });
    this.lastSnapshotAt = at;
  }

  // One broadcast, as the JSON text every client was sent. Returns the entry,
  // so a caller can add to it what only the moment knows (`extra`).
  record(data) {
    if (!this.recording) return null;
    if (this.now() - this.lastSnapshotAt >= this.rateMs) this.takeSnapshot();
    const entry = { at: this.now(), data };
    this.push(entry);
    return entry;
  }

  push(entry) {
    this.entries.push(entry);
    this.bytes += sizeOf(entry);
    this.trim();
  }

  // Oldest first, a snapshot at a time: what is kept always starts at a
  // snapshot, so it can be played from its first entry. The newest snapshot
  // is never dropped, whatever the cap.
  trim() {
    while (this.bytes > this.maxBytes) {
      const next = this.entries.findIndex((entry, index) => index > 0 && entry.snapshot);
      if (next === -1) break;
      for (const entry of this.entries.splice(0, next)) this.bytes -= sizeOf(entry);
    }
  }

  // The last `seconds` of it, from the snapshot at or before their start;
  // all of it without `seconds`.
  slice(seconds = null) {
    if (!Number.isFinite(seconds) || seconds <= 0) return this.entries.slice();
    const from = this.now() - seconds * 1000;
    let start = 0;
    this.entries.forEach((entry, index) => {
      if (entry.snapshot && entry.at <= from) start = index;
    });
    return this.entries.slice(start);
  }

  stats() {
    const first = this.entries[0];
    return {
      recording: this.recording,
      seconds: first ? (this.now() - first.at) / 1000 : 0,
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      entries: this.entries.length,
      rateMs: this.rateMs,
    };
  }
}

function sizeOf(entry) {
  return (entry.data || entry.snapshot || '').length + ENTRY_OVERHEAD;
}

// A slice of the buffer as a recording `writeReplay` writes. Each snapshot is
// an update marker and state packets; every broadcast between is the real
// packets a native client would have been sent for it, at its own time.
// `translator` is `NativeTranslator`'s options less `send`; `scoreOf` and
// `guidedShots` are answered from what each entry captured (`extra`), since
// the live game has moved on since.
function bufferToReplay(entries, { header, translator: options }) {
  const packets = [];
  let mode = PACKET_MODE.REAL;
  let entry = null;
  const time = () => Math.round(entry.at * 1000);
  const scores = new Map();
  const translator = new NativeTranslator({
    ...options,
    selfSlot: SERVER_PLAYER,
    send: (code, payload) => packets.push({ mode, code, time: time(), payload: Buffer.from(payload) }),
    addressOf: () => null,
    selfIsAdmin: () => false,
    scoreOf: (id) => entry.extra?.scores?.[id] ?? scores.get(String(id)) ?? null,
    guidedShots: (id) => entry.extra?.guided?.[id] ?? [],
  });
  const firstAt = entries.length > 0 ? entries[0].at : 0;
  // `PlayerState::pack`'s timestamp, as the game clock had it then.
  translator.timestamp = () => (entry.at - firstAt) / 1000;
  const noteScores = (records) => {
    for (const record of records || []) {
      if (record && record.id !== undefined) {
        scores.set(String(record.id), { wins: record.wins || 0, losses: record.losses || 0, tks: record.tks || 0 });
      }
    }
  };
  for (entry of entries) {
    if (entry.snapshot) {
      const state = JSON.parse(entry.snapshot);
      noteScores(state.players);
      packets.push({ mode: PACKET_MODE.UPDATE, code: '\0\0', time: time(), payload: Buffer.alloc(0) });
      mode = PACKET_MODE.STATE;
      translator.writeState(state);
      mode = PACKET_MODE.REAL;
      continue;
    }
    const message = JSON.parse(entry.data);
    if (message.player) noteScores([message.player]);
    translator.handle(message);
  }
  const first = packets[0];
  const last = packets[packets.length - 1];
  return {
    ...header,
    fileTime: first && last ? last.time - first.time : 0,
    packets,
  };
}

module.exports = {
  BroadcastBuffer,
  bufferToReplay,
  DEFAULT_MAX_BYTES,
  DEFAULT_RATE_MS,
  SERVER_PLAYER,
};
