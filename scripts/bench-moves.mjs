/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// How long a bzo client's move takes to reach the other bzo clients, over the
// WebSocket or over the UDP channel (#8) -- scripts/bench-relay.mjs's
// question for browsers rather than BZFlag clients.
//
//   node scripts/bench-moves.mjs                       # moves on the WebSocket
//   node scripts/bench-moves.mjs --channel             # moves on the data channel
//   node scripts/bench-moves.mjs --url wss://host --tanks 6 --seconds 20
//
// Each tank joins as a browser does and spins on the spot at --rate moves a
// second, the turn the server allows, with its sequence number in its
// azimuth. --channel opens the channel through public/udp-channel.mjs, the
// browser's own code, on node-datachannel's RTCPeerConnection. Server bots
// shoot, so a quiet server measures cleaner.
import WebSocket from 'ws';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { createUdpChannel } from '../public/udp-channel.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => {
  if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]);
  return pairs;
}, []));
const URL_ = args.url || 'ws://127.0.0.1:5154/';
const TANKS = Number(args.tanks || 6);
const RATE = Number(args.rate || 30);
const SECONDS = Number(args.seconds || 20);
const CHANNEL = args.channel === 'true';
const TEAMS = ['red', 'green', 'blue', 'purple'];
// A step a little over 0.026 radian: well clear of the 0.01 a move's azimuth
// is rounded to, and at 30 a second the tank's own turn rate (rs 1).
const STEPS = 240;
const STEP = (2 * Math.PI) / STEPS;
const BASE_TURN_RATE = 0.785398;

function percentile(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : NaN;
}

const tanks = [];
const latencies = [];
let sent = 0;
let received = 0;
// One delivery per receiver, sender and send.
const seen = new Set();
const origin = performance.now();

// Where the server put the tank. The spin carries on from the heading it was
// given, so its first move is not a jump the angular drift check reports.
function adopt(tank, record) {
  const a = record.azimuth ?? 0;
  Object.assign(tank, { x: record.x, y: record.y, z: record.z, a, alive: true });
  tank.seq = Math.round((((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / STEP);
}

function join(index) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_);
    const tank = { ws, id: null, x: 0, y: 0, z: 0, a: 0, alive: false, seq: 0, sentAt: new Map(), channel: null };
    const onMessage = (message) => {
      if (message.type === 'init') {
        tank.id = message.player?.id ?? null;
        if (CHANNEL && message.udpChannel) {
          tank.channel = createUdpChannel({
            sendSignal: (signal) => ws.send(JSON.stringify({ type: 'rtc', ...signal })),
            onMessage: (text) => onMessage(JSON.parse(text)),
            PeerConnection: RTCPeerConnection,
          });
          void tank.channel.start();
        }
        resolve(tank);
      } else if ((message.type === 'alive' || message.type === 'playerJoined')
        && message.player?.id === tank.id && message.player.alive) {
        // A tank spawns as it joins, in its own `playerJoined`, and again
        // after each death in `alive`.
        adopt(tank, message.player);
      } else if (message.type === 'killed' && message.victimId === tank.id) {
        tank.alive = false;
      } else if (message.type === 'rtc') {
        void tank.channel?.signal(message);
      } else if (message.type === 'pmBatch') {
        for (const move of message.moves || []) {
          const sender = tanks.find((t) => t.id === move.id);
          if (!sender || sender === tank) continue;
          const turn = ((move.a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
          const slot = Math.round(turn / STEP) % STEPS;
          const at = sender.sentAt.get(slot);
          if (at === undefined) continue;
          const key = `${tank.id}:${sender.id}:${slot}:${at}`;
          if (seen.has(key)) continue;
          seen.add(key);
          received += 1;
          latencies.push(performance.now() - at);
        }
      }
    };
    ws.on('message', (data) => onMessage(JSON.parse(data)));
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'joinGame', name: `bench${index}`, team: TEAMS[index % TEAMS.length] })));
  });
}

for (let i = 0; i < TANKS; i += 1) tanks.push(await join(i));
// Spawning waits on the server's respawn delay, and a channel on ICE.
for (let waited = 0; waited < 20000; waited += 250) {
  if (tanks.every((t) => t.alive && (!t.channel || t.channel.isOpen()))) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
const onChannel = tanks.filter((t) => t.channel?.isOpen()).length;
console.log(`${URL_} ${TANKS} tanks (${tanks.filter((t) => t.alive).length} alive, ${onChannel} on a data channel), ${RATE}/s each, ${SECONDS}s`);

latencies.length = 0;
received = 0;
let expected = 0;
const timer = setInterval(() => {
  const alive = tanks.filter((t) => t.alive);
  for (const tank of alive) {
    tank.seq += 1;
    const slot = tank.seq % STEPS;
    tank.sentAt.set(slot, performance.now());
    const move = {
      type: 'm', id: tank.id,
      x: Number(tank.x.toFixed(2)), y: Number(tank.y.toFixed(2)), z: Number(tank.z.toFixed(2)),
      a: Number((slot * STEP).toFixed(2)), fs: 0, rs: Number(((STEP * RATE) / BASE_TURN_RATE).toFixed(2)), vv: 0,
      ct: Number(((performance.now() - origin) / 1000).toFixed(3)),
    };
    const text = JSON.stringify(move);
    if (!tank.channel?.send(text)) tank.ws.send(text);
    sent += 1;
    expected += tanks.length - 1;
  }
}, 1000 / RATE);

await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000));
clearInterval(timer);
await new Promise((resolve) => setTimeout(resolve, 500));
const sorted = [...latencies].sort((a, b) => a - b);
const fmt = (ms) => `${ms.toFixed(1)}ms`;
console.log(`sent ${sent}, delivered ${received}/${expected} (${((100 * received) / Math.max(1, expected)).toFixed(1)}%)`);
console.log(`latency p50 ${fmt(percentile(sorted, 0.5))} p90 ${fmt(percentile(sorted, 0.9))} p99 ${fmt(percentile(sorted, 0.99))} max ${fmt(sorted[sorted.length - 1] ?? NaN)}`);
for (const tank of tanks) {
  tank.channel?.close();
  tank.ws.close();
}
setTimeout(() => process.exit(0), 300);
