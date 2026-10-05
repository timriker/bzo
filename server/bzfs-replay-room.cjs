/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// A bzfs recording played to everyone watching it at once: one clock per
// file, and per browser a `ReplaySession`, which is a `BzfsSession` that
// never dials. The room hands each session the packets bzfs would have sent
// it, so the proxy's decoding and translation run unchanged on a replay
// (`handleProxyConnection` in server.js). See docs/replay-plan.md.
//
// What upstream's `bzfs -replay` does, and where this differs:
//
// - A viewer always watches, with an id from `FIRST_VIEWER_ID` up
//   (`ReplayObservers`, RecordReplay.h:21), so a recorded player's id never
//   collides with a live one.
// - A viewer who joins midway gets the latest snapshot at once, and the real
//   packets since it, rather than waiting up to 10 s for the next one
//   (`Replay::sendPackets`, RecordReplay.cxx:1299).
// - Viewers' chat goes to the other viewers, as it does on a replay server.
//   Recorded chat plays back alongside it.
// - With nobody watching the room closes, and the next viewer starts it from
//   the beginning. At the end it restarts after `RESTART_DELAY_MS`.

const { BzfsSession, OBSERVER_TEAM } = require('./bzfs-session.cjs');
const { PACKET_MODE, snapshotAt } = require('./bzfs-replay.cjs');

// `MaxPlayers` (global.h:28) and `ReplayObservers` (RecordReplay.h:21).
const FIRST_VIEWER_ID = 200;
const MAX_VIEWERS = 16;
// `ServerPlayer`, `AllPlayers` (global.h).
const SERVER_PLAYER = 253;
const ALL_PLAYERS = 254;
const TANK_PLAYER = 0;
const CALLSIGN_LEN = 32;
const MOTTO_LEN = 128;
const MESSAGE_LEN = 128;
// `ChatMessage` (global.h): the only kind a viewer sends.
const CHAT_MESSAGE = 0;
// How often the clock is read: bzo's own move broadcast rate, and finer than
// any packet's timing a viewer could notice.
const TICK_MS = 20;
const RESTART_DELAY_MS = 10_000;

function fixed(text, len) {
  const out = Buffer.alloc(len);
  out.write(String(text || ''), 0, len - 1, 'latin1');
  return out;
}

// MsgAddPlayer (`packPlayerUpdate`, GameKeeper.cxx): an observer with no score.
function addPlayerPayload(id, callsign, motto) {
  const head = Buffer.alloc(11);
  head.writeUInt8(id, 0);
  head.writeUInt16BE(TANK_PLAYER, 1);
  head.writeUInt16BE(OBSERVER_TEAM, 3);
  return Buffer.concat([head, fixed(callsign, CALLSIGN_LEN), fixed(motto, MOTTO_LEN)]);
}

// MsgMessage as bzfs sends it: sender, destination, kind, then the text.
function messagePayload(from, to, text) {
  return Buffer.concat([Buffer.from([from, to, CHAT_MESSAGE]), fixed(text, MESSAGE_LEN)]);
}

// C's `ctime`, which upstream's stats line prints, less its trailing newline:
// "Mon Oct  5 00:34:56 2026", in the server's own time zone.
function ctime(ms) {
  const d = new Date(ms);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const two = (n) => String(n).padStart(2, '0');
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')}`
    + ` ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`;
}

// `MaxListOutput` (RecordReplay.cxx:88).
const MAX_LIST_OUTPUT = 100;

// `Replay::sendHelp` (RecordReplay.cxx:1438).
const REPLAY_USAGE = Object.freeze([
  'usage:',
  '  /replay list [-t | -n | --] [pattern]',
  '  /replay load <filename|#index>',
  '  /replay play',
  '  /replay loop',
  '  /replay skip [+/-seconds]',
  '  /replay stats',
]);

// `parseListOptions` (RecordReplay.cxx): options, then a glob, `*` when none.
// Null for an option it does not know, which upstream answers with the usage.
function parseListOptions(text) {
  let rest = String(text || '').trim();
  let sort = null;
  for (;;) {
    const option = /^-(\S*)\s*/.exec(rest);
    if (!option) break;
    rest = rest.slice(option[0].length);
    if (option[1] === '-') break;
    if (option[1] === 't') sort = 'time';
    else if (option[1] === 'n') sort = 'name';
    else return null;
  }
  const glob = rest.trim() || '*';
  const pattern = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return { sort, match: (name) => pattern.test(name) };
}

// `Replay::sendFileList` (RecordReplay.cxx:1088), which `/record list` and
// `/replay list` both answer with: `-t` sorts by length, `-n` by name, `--`
// ends the options, and a glob picks names. Listed in name order otherwise,
// which is what a directory listing usually is. `files` is `{ name, seconds }`.
function fileListLines(files, options, directory) {
  const parsed = parseListOptions(options);
  if (!parsed) return null;
  const shown = files.filter((file) => parsed.match(file.name));
  if (parsed.sort === 'time') shown.sort((a, b) => a.seconds - b.seconds);
  else shown.sort((a, b) => a.name.localeCompare(b.name));
  const lines = [`dir:  ${directory}`];
  shown.slice(0, MAX_LIST_OUTPUT).forEach((file, index) => {
    lines.push(`#${String(index + 1).padStart(2, '0')}:  ${file.name.padEnd(30)}`
      + `  [${file.seconds.toFixed(1).padStart(9)} seconds]`);
  });
  if (shown.length > MAX_LIST_OUTPUT) {
    lines.push(`Not listing more then ${MAX_LIST_OUTPUT} entries, try using pattern matching.`);
  }
  return lines;
}

class ReplayRoom {
  // `now` is milliseconds; injectable so a test can run the clock itself.
  // `listFiles` answers `/replay list`: resolves to every recording this
  // instance holds, as `{ name, seconds }`.
  constructor({
    name, replay, now = () => Date.now(), restartDelayMs = RESTART_DELAY_MS,
    listFiles = async () => [], directory = 'replays/',
  }) {
    this.name = name;
    this.listFiles = listFiles;
    this.directory = directory;
    this.replay = replay;
    this.now = now;
    this.restartDelayMs = restartDelayMs;
    this.packets = replay.packets;
    this.start = this.packets.length > 0 ? this.packets[0].time : 0;
    this.end = this.packets.length > 0 ? this.packets[this.packets.length - 1].time : 0;
    this.sessions = new Set();
    // Sessions that have had no snapshot yet: the clock's next state packets
    // are for them, as upstream sends state packets only to a viewer not yet
    // stateful (RecordReplay.cxx:1360).
    this.unrestored = new Set();
    this.restoring = false;
    this.timer = null;
    this.startedAt = null;
    this.cursor = 0;
    this.restartAt = null;
    this.onEmpty = null;
  }

  // Where playback is, in the recording's own microseconds.
  position() {
    if (this.startedAt === null) return this.start;
    return Math.min(this.end, this.start + (this.now() - this.startedAt) * 1000);
  }

  // Seconds played and seconds in all, for a list row.
  progress() {
    return {
      played: (this.position() - this.start) / 1e6,
      length: (this.end - this.start) / 1e6,
      viewers: this.sessions.size,
    };
  }

  freeViewerId() {
    const taken = new Set([...this.sessions].map((session) => session.playerId));
    for (let id = FIRST_VIEWER_ID; id < FIRST_VIEWER_ID + MAX_VIEWERS; id += 1) {
      if (!taken.has(id)) return id;
    }
    return null;
  }

  // Everything a session needs to stand where playback is now: the latest
  // snapshot's state packets, then the real packets since. Chat before the
  // join is left out, as a viewer joining a live game would not have seen it.
  // Returns whether there was a snapshot to restore from.
  catchUp(session) {
    const marker = snapshotAt(this.replay, this.position());
    if (marker === -1 || marker >= this.cursor) return false;
    for (let i = marker + 1; i < this.cursor; i += 1) {
      const packet = this.packets[i];
      if (packet.mode === PACKET_MODE.STATE || (packet.mode === PACKET_MODE.REAL && packet.code !== 'mg')) {
        session.handleFrame(packet.code, packet.payload);
      }
    }
    return true;
  }

  join(session) {
    const id = this.freeViewerId();
    if (id === null) throw new Error(`replay ${this.name} has ${MAX_VIEWERS} viewers already`);
    session.playerId = id;
    const fresh = this.startedAt === null;
    if (fresh) this.begin();
    if (!this.catchUp(session)) this.unrestored.add(session);
    for (const other of this.sessions) {
      session.handleFrame('ap', addPlayerPayload(other.playerId, other.callsign, other.motto));
    }
    this.sessions.add(session);
    const own = addPlayerPayload(id, session.callsign, session.motto);
    for (const viewer of this.sessions) viewer.handleFrame('ap', own);
    // A room starting now has its opening snapshot due, and the first
    // viewer's `init` should carry it rather than have it follow. Its packets
    // are stamped microseconds apart, so the clock alone would not reach them
    // all yet.
    if (fresh) this.restoreOpening();
  }

  // The recording's first marker and the state packets after it, to everyone
  // still waiting for a snapshot.
  restoreOpening() {
    while (this.cursor < this.packets.length) {
      const packet = this.packets[this.cursor];
      if (packet.mode === PACKET_MODE.STATE) {
        for (const viewer of this.unrestored) viewer.handleFrame(packet.code, packet.payload);
        this.restoring = this.unrestored.size > 0;
      } else if (packet.mode !== PACKET_MODE.UPDATE && packet.mode !== PACKET_MODE.HIDDEN) {
        break;
      }
      this.cursor += 1;
    }
  }

  leave(session) {
    if (!this.sessions.delete(session)) return;
    this.unrestored.delete(session);
    const payload = Buffer.from([session.playerId]);
    for (const viewer of this.sessions) viewer.handleFrame('rp', payload);
    if (this.sessions.size === 0) {
      this.stop();
      if (this.onEmpty) this.onEmpty(this);
    }
  }

  // A viewer's own chat, to every viewer or to one of them. The recording's
  // players are not here to hear it, and a `/` command has nothing to run on.
  chat(session, payload) {
    const to = payload.readUInt8(0);
    const text = payload.toString('latin1', 1).replace(/\0.*$/s, '');
    if (text.startsWith('/')) {
      const reply = (lines) => {
        if (session.closed) return;
        for (const line of lines) {
          session.handleFrame('mg', messagePayload(SERVER_PLAYER, session.playerId, line));
        }
      };
      Promise.resolve(this.command(session, text)).then(reply, (error) => reply([`Error: ${error.message}`]));
      return;
    }
    const line = messagePayload(session.playerId, to, text);
    for (const viewer of this.sessions) {
      if (to === ALL_PLAYERS || viewer.playerId === to || viewer === session) {
        viewer.handleFrame('mg', line);
      }
    }
  }

  // A viewer's `/` command, answered as upstream's replay server answers it
  // (`ReplayCommand`, commands.cxx:3705): `/replay stats` for anyone, the
  // rest of `/replay` for the REPLAY permission, which bzo gives its
  // operators. Resolves to the lines to send back.
  async command(session, text) {
    const replay = /^\/replay(?:\s+(.*))?$/i.exec(text.trim());
    if (!replay) return ['Commands are not available while watching a replay, except /replay.'];
    const args = (replay[1] || '').trim();
    if (/^stats\b/i.test(args)) return this.stats();
    if (!session.operator) return ['You do not have permission to run the /replay command'];
    if (/^list\b/i.test(args)) return (await this.fileList(args.slice(4))) || REPLAY_USAGE;
    return REPLAY_USAGE;
  }

  async fileList(options) {
    return fileListLines(await this.listFiles(), options, this.directory);
  }

  // `/replay stats`, worded as upstream's (`Replay::sendStats`,
  // RecordReplay.cxx:1204): the file, then the recorded moment playback is at,
  // how far through it is, and the seconds played of the whole.
  stats() {
    const at = this.position();
    const { played, length } = this.progress();
    const percent = length > 0 ? (100 * played) / length : 0;
    return [
      `Replay File:  ${this.name}`,
      `Replay Date:  ${ctime(at / 1000)} [${percent.toFixed(2)} %]`
        + `  (${played.toFixed(1)} secs / ${length.toFixed(1)} secs)`,
    ];
  }

  announce(text) {
    for (const viewer of this.sessions) {
      viewer.handleFrame('mg', messagePayload(SERVER_PLAYER, ALL_PLAYERS, text));
    }
  }

  begin() {
    this.startedAt = this.now();
    this.cursor = 0;
    this.restartAt = null;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.startedAt = null;
    this.cursor = 0;
    this.restartAt = null;
    this.unrestored.clear();
    this.restoring = false;
  }

  // Every real packet now due, to everyone; a state packet only to a session
  // still waiting for its first snapshot, which the next real packet ends.
  tick() {
    if (this.restartAt !== null) {
      if (this.now() >= this.restartAt) this.restart();
      return;
    }
    const at = this.start + (this.now() - this.startedAt) * 1000;
    while (this.cursor < this.packets.length && this.packets[this.cursor].time <= at) {
      const packet = this.packets[this.cursor];
      this.cursor += 1;
      if (packet.mode === PACKET_MODE.STATE) {
        for (const viewer of this.unrestored) viewer.handleFrame(packet.code, packet.payload);
        this.restoring = this.unrestored.size > 0;
      } else if (packet.mode === PACKET_MODE.REAL) {
        if (this.restoring) this.unrestored.clear();
        this.restoring = false;
        for (const viewer of this.sessions) viewer.handleFrame(packet.code, packet.payload);
      }
    }
    if (this.cursor >= this.packets.length) {
      this.restartAt = this.now() + this.restartDelayMs;
      this.announce(`End of replay ${this.name}. It restarts in`
        + ` ${Math.round(this.restartDelayMs / 1000)} seconds.`);
    }
  }

  // Back to the start: every recorded player leaves, as the game they were in
  // is over, and the recording plays again from its first packet.
  restart() {
    for (const viewer of this.sessions) {
      for (const id of [...viewer.state.players.keys()]) {
        if (id < FIRST_VIEWER_ID) viewer.handleFrame('rp', Buffer.from([id]));
      }
    }
    this.startedAt = this.now();
    this.cursor = 0;
    this.restartAt = null;
    for (const viewer of this.sessions) this.unrestored.add(viewer);
    this.announce(`Replay ${this.name} restarted.`);
  }
}

// A viewer's end of a room, shaped as a `BzfsSession` so the proxy cannot tell
// the difference. Only chat goes anywhere; everything else a browser could say
// is about playing, and nobody plays in a replay.
class ReplaySession extends BzfsSession {
  // `operator`: whether this viewer has upstream's REPLAY permission.
  constructor({ room, callsign, motto = '', operator = false }) {
    super({ host: 'replay', port: 0, callsign, motto, team: OBSERVER_TEAM });
    this.room = room;
    this.operator = operator;
    // MsgGameSettings, which a live session asks for before joining: the
    // header keeps the whole frame, four bytes of length and code first.
    this.state.gameSettings = room.replay.worldSettings.subarray(4);
  }

  // A viewer's record says so as it is decoded, before anything hears of it:
  // the proxy's `proxyPlayerRecord` passes `watching` on to the browser's
  // scoreboard, which puts viewers in a group of their own.
  emit(event, value) {
    if (event === 'player' && value.id >= FIRST_VIEWER_ID) value.watching = true;
    super.emit(event, value);
  }

  connect() {
    try {
      this.room.join(this);
    } catch (err) {
      return Promise.reject(err);
    }
    return Promise.resolve(this.state);
  }

  send(code, payload) {
    if (this.closed) return;
    if (code === 'mg') this.room.chat(this, payload);
  }

  openUdpLink() {}

  sendUdp() {}

  close() {
    if (this.closed) return;
    this.closed = true;
    this.room.leave(this);
  }

  destroy() {
    this.close();
  }
}

// What a list row says about a recording, read by playing it through a
// session at once: when it was, how long, who played and how they finished,
// and who watched. A player who left early keeps the score they left with.
// Viewers of a replay server's own recordings, if there are any, are left out
// like any other id from `FIRST_VIEWER_ID` up.
function summarizeReplay(replay) {
  const session = new BzfsSession({ host: 'replay', port: 0, callsign: 'summary' });
  const left = new Map();
  session.on('playerLeft', (player) => left.set(player.id, { ...player }));
  for (const packet of replay.packets) {
    if (packet.mode === PACKET_MODE.REAL || packet.mode === PACKET_MODE.STATE) {
      session.handleFrame(packet.code, packet.payload);
    }
  }
  const everyone = new Map(left);
  for (const [id, player] of session.state.players) everyone.set(id, player);
  const roster = [...everyone.values()]
    .filter((player) => player.id < FIRST_VIEWER_ID)
    .map(({ id, callsign, team, wins, losses, tks }) => ({ id, callsign, team, wins, losses, tks }));
  const first = replay.packets.length > 0 ? replay.packets[0].time : 0;
  const last = replay.packets.length > 0 ? replay.packets[replay.packets.length - 1].time : 0;
  return {
    // Milliseconds since the epoch, as the recording's own clock had it.
    start: first / 1000,
    seconds: (last - first) / 1e6,
    players: roster.filter((player) => player.team !== OBSERVER_TEAM)
      .sort((a, b) => (b.wins - b.losses) - (a.wins - a.losses) || b.wins - a.wins),
    observers: roster.filter((player) => player.team === OBSERVER_TEAM).map((player) => player.callsign),
    recordedBy: replay.callsign,
    protocol: replay.protocol,
    appVersion: replay.appVersion,
    worldHash: replay.worldHash,
  };
}

module.exports = {
  ReplayRoom,
  ReplaySession,
  summarizeReplay,
  fileListLines,
  FIRST_VIEWER_ID,
  MAX_VIEWERS,
};
