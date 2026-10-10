#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Fills a server with parked tanks, so a change to how a tank looks can be
// looked at across every team at once.
//
// scripts/headless-client.mjs drives a real browser and is the probe to reach
// for when the question is about the client -- rendering, input, what a player
// sees. It costs a headless Chrome and a GL context each, about 1.6GB, so a
// dozen of them will take down the machine the server is on before they answer
// anything. This joins over the wire instead: no browser, no renderer, just a
// socket holding a roster slot, which is all a tank somebody else is looking at
// has to be.
//
//   node scripts/crowd-client.mjs --teams red,green,blue,purple,rogue --each 3 --spin
//
// The tanks are parked in a grid with one team per row, and they stay until the
// script is killed. `/mv` does the parking, so the server has to accept it from
// here -- it is OPERATOR, which a loopback connection gets with `localAdmin`.

import WebSocket from 'ws';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const url = args.get('url') || 'ws://127.0.0.1:5154';
const teams = (args.get('teams') || 'red,green,blue,purple,rogue').split(',').filter(Boolean);
const each = Number(args.get('each') || 3);
const prefix = args.get('prefix') || '';
// Far enough apart that two tanks do not overlap, close enough that a row fits
// in one screen from a sensible distance.
const spacing = Number(args.get('spacing') || 9);
const rowGap = Number(args.get('rowgap') || 14);
// Whether the parked tanks also turn on the spot, and how many input changes a
// second each one makes.
//
// A tank that holds still sends almost nothing: client.js only puts a packet on
// the wire when a speed crosses VELOCITY_THRESHOLD, or every MAX_UPDATE_INTERVAL
// of 5s as a heartbeat -- so fifteen parked tanks are close to fifteen idle
// sockets and measure nothing. A player working the keys crosses that threshold
// every time they tap, which is a few times a second rather than once a frame.
const spin = args.get('spin') !== undefined && args.get('spin') !== '0';
const spinRate = Number(args.get('rate') || 3);

// Turning rather than driving, on purpose. A tank that only turns never leaves
// the spot it was parked on, so the position it reports is the position the
// server already predicted and the drift checks stay silent -- where a tank
// driving blind into a wall would diverge from the server's own collision
// result and fill the log with warnings that are the probe's fault rather than
// the server's. Rotation still crosses VELOCITY_THRESHOLD on every change, so
// the packet rate is a real one; what the server does per packet -- validate it
// and fan it out to every other client -- is the same either way.
const TURN_RATE = 0.785398;
// client.js's own MAX_UPDATE_INTERVAL. A driving bot never reaches it, but one
// that has stopped has to keep the heartbeat up like a real client does.
const HEARTBEAT_MS = 5000;
// How far the server's idea of where a tank is may differ from the tank's own
// before the tank gives way. Below a tank length there is nothing to argue
// about; above it, something moved us and we missed it.
const POSITION_RESYNC = 6;

const sockets = [];
const seats = [];
let joined = 0;

// A tank is parked by chatting `/mv` at the server, the same way a player would.
// There is no REST equivalent -- see the note in headless-client.mjs.
const chat = (ws, text) => ws.send(JSON.stringify({ type: 'message', text }));

// Rejoining is the point of this rather than a nicety. The server this is aimed
// at reloads on every source edit -- its own name says so -- and each reload
// drops every socket, so without this the field empties the first time anyone
// saves a file and the crowd has to be started again by hand.
// Take the server's word for where this tank is. Every path that moves a tank
// without the client asking -- the spawn, `/mv`, a respawn -- arrives as one of
// these records, and the position in it is the one the next move packet has to
// agree with.
function adopt(self, record) {
  if (Number.isFinite(record.id)) self.id = record.id;
  if (!Number.isFinite(record.x)) return;
  self.x = record.x;
  self.y = record.y;
  self.z = record.z;
  if (Number.isFinite(record.rotation)) self.r = record.rotation;
}

// One tank's turning, sent the way client.js sends it: a packet when a speed
// changes and a heartbeat when nothing has for MAX_UPDATE_INTERVAL. The
// rotation is integrated at the moment it changes rather than on a frame timer,
// which is exact -- the speed was constant across the whole gap, so one
// multiply covers it and there is no frame loop to run.
function startSpinning(ws, self) {
  const origin = Date.now();
  let lastSend = origin;
  let lastChange = origin;
  let rotationSpeed = 0;

  const step = () => {
    if (ws.readyState !== WebSocket.OPEN || self.dead) return;
    const now = Date.now();
    self.r += rotationSpeed * ((now - lastChange) / 1000);
    lastChange = now;
    // What a player's hands do: hold a turn, let go, turn back. Picked fresh
    // each time so the fleet does not move as one.
    const choice = Math.random();
    rotationSpeed = choice < 0.4 ? TURN_RATE : (choice < 0.8 ? -TURN_RATE : 0);
    const sinceSend = (now - lastSend) / 1000;
    ws.send(JSON.stringify({
      type: 'm',
      id: self.id,
      x: Number(self.x.toFixed(2)),
      y: Number(self.y.toFixed(2)),
      z: Number(self.z.toFixed(2)),
      r: Number(self.r.toFixed(2)),
      fs: 0,
      rs: Number(rotationSpeed.toFixed(2)),
      vv: 0,
      vx: 0,
      vz: 0,
      dt: 0.033,
      sdt: Number(sinceSend.toFixed(3)),
      ct: Number(((now - origin) / 1000).toFixed(3)),
    }));
    lastSend = now;
    self.sent += 1;
  };

  // Jittered, so fifteen bots do not land every packet on the same tick and
  // report a burst the server would never see from real players.
  const period = 1000 / spinRate;
  const tick = () => {
    step();
    setTimeout(tick, period * (0.5 + Math.random()));
  };
  setTimeout(tick, Math.random() * period);
  setInterval(() => {
    if (Date.now() - lastSend >= HEARTBEAT_MS) step();
  }, 1000);
}

function seat(name, team, x, z) {
  const self = { id: null, x, y: 0, z, r: 0, sent: 0, dead: false, spinning: false };
  seats.push(self);
  const connect = () => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    let live = false;
    self.spinning = false;
    self.dead = false;
    ws.on('open', () => ws.send(JSON.stringify({
      type: 'joinGame', name, team, tankModel: 'bzflag', bot: true,
    })));
    ws.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message.error) console.error(`${name}: ${message.error}`);
      // The join is only done when the server says who we are. Parking before
      // that is the same too-early no-op `/mv` has from a browser.
      // `init` carries our own record as `player` -- there is no bare id field
      // on it -- and that record is where our id comes from. Getting it is not
      // optional: every `alive` and `killed` below is matched on it, so a bot
      // that never learned its id never notices being shot, keeps reporting
      // where it died, and drags itself back there against the respawn.
      if (message.type === 'init') {
        if (live) return;
        live = true;
        adopt(self, message.player || {});
        joined += 1;
        console.log(`${name} joined (${joined}/${teams.length * each}) -> ${x},${z}`);
        setTimeout(() => chat(ws, `/mv ${x},${z} n`), 1500);
        // Ask where `/mv` actually put us before reporting a position of our
        // own. It resolves a height we did not give it, and a spawn may have
        // placed us somewhere else entirely -- a first move packet built on the
        // coordinates we asked for rather than the ones we got is a tank that
        // teleports, which is exactly what the linear drift check is for.
        if (spin) {
          setTimeout(() => ws.send(JSON.stringify({ type: 'queryPlayers' })), 2500);
          setTimeout(() => { self.spinning = true; startSpinning(ws, self); }, 4000);
        }
        return;
      }
      // Being shot and put back. The server respawns on its own after
      // RESPAWN_DELAY and says so with `alive`; nothing is asked of the client
      // but to notice. Noticing matters, because a tank that kept reporting
      // where it stood before it died would drag itself back there -- its own
      // move packets say where it is, and the server has just moved it.
      if (message.type === 'alive' && message.player?.id === self.id) {
        adopt(self, message.player);
        self.dead = false;
        return;
      }
      // `killed` names its victim directly rather than carrying a player record
      // the way `alive` does, so it is matched on `victimId`. A dead tank has
      // nothing to report -- one that kept sending is a tank arguing with the
      // respawn about where it is. Spinning resumes on `alive`.
      if (message.type === 'killed' && message.victimId === self.id) {
        self.dead = true;
        return;
      }
      // Only before the spin starts. Once it is turning, this tank's own move
      // packets are what the server is tracking it by, and taking a position
      // back out of a routine roster broadcast overwrites the rotation it has
      // been integrating -- which reads to the server as a tank that jumped,
      // and fills the log with angular drift warnings the probe caused.
      // A respawn is the exception, and it is handled above.
      const roster = message.players || (message.type === 'playerList' ? message.list : null);
      if (!roster) return;
      const mine = roster.find((entry) => entry.name === name);
      if (!mine) return;
      if (!self.spinning) {
        adopt(self, mine);
        return;
      }
      // Already turning, so the rotation is ours to keep -- but the position is
      // the server's, and if it has us somewhere else then it is right and we
      // are wrong. Anything that moves a tank without asking lands here: a
      // spawn we had not seen, a correction, a `/mv` from an operator. Taking
      // it is what a real client does; arguing with it is a tank that appears
      // to teleport on every packet, which is the drift the log fills up with.
      if (!Number.isFinite(mine.x)) return;
      if (Math.hypot(mine.x - self.x, mine.z - self.z) > POSITION_RESYNC) {
        self.x = mine.x;
        self.y = mine.y;
        self.z = mine.z;
      }
    });
    ws.on('error', (error) => console.error(`${name}: ${error.message}`));
    ws.on('close', () => {
      if (live) joined -= 1;
      // Staggered, or fifteen of these stampede the reload they are waiting on.
      setTimeout(connect, 2000 + Math.floor(Math.random() * 3000));
    });
  };
  connect();
}

teams.forEach((team, row) => {
  for (let seatIndex = 0; seatIndex < each; seatIndex += 1) {
    const name = `${prefix}${team}-${seatIndex + 1}`;
    const x = (seatIndex - ((each - 1) / 2)) * spacing;
    const z = (row - ((teams.length - 1) / 2)) * rowGap;
    // Staggered, because a server that sees a dozen joins in one tick answers
    // them all with a full roster broadcast each.
    setTimeout(() => seat(name, team, x, z), ((row * each) + seatIndex) * 350);
  }
});

// What the fleet is actually putting on the wire, which is the number the load
// question is about -- reported rather than assumed, since the send rule is
// threshold-driven and a bot that stopped turning falls back to the heartbeat.
if (spin) {
  let previous = 0;
  setInterval(() => {
    const total = seats.reduce((sum, s2) => sum + s2.sent, 0);
    const rate = (total - previous) / 10;
    previous = total;
    console.log(`spin: ${rate.toFixed(1)} packets/s from ${seats.length} tanks `
      + `(${(rate / Math.max(1, seats.length)).toFixed(1)} each), ${total} total`);
  }, 10000);
}

const shutdown = () => {
  sockets.forEach((ws) => { try { ws.close(); } catch { /* already gone */ } });
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
