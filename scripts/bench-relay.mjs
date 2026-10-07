/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// How long a player update takes to reach the other players, and how much
// server CPU each one costs -- the same load against bzfs and against bzo, so
// the two can be compared on one number.
//
//   node scripts/bench-relay.mjs --port 5155 --pid <bzfs pid>
//   node scripts/bench-relay.mjs --port 5154 --pid <bzo pid>
//
// Each tank joins, one team after another so no team fills, over the BZFlag protocol (server/bzfs-session.cjs), spawns,
// and spins on the spot at --rate updates a second over UDP, the way a BZFlag
// client sends. The update's sequence number rides in its azimuth, which both
// servers pass on, so every copy a peer receives is matched to the moment it
// was sent. Latency is that send-to-receive time, in one process on one clock.
// CPU is the server process's utime+stime over the run, from /proc.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { BzfsSession, PLAYER_STATUS, decodePlayerUpdate } = require('../server/bzfs-session.cjs');

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => {
  if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1]?.startsWith('--') ? 'true' : all[i + 1]]);
  return pairs;
}, []));
const HOST = args.host || '127.0.0.1';
const PORT = Number(args.port || 5154);
const TANKS = Number(args.tanks || 8);
const RATE = Number(args.rate || 30);
const SECONDS = Number(args.seconds || 30);
const PID = args.pid ? Number(args.pid) : null;
// One full turn every STEPS updates. A step must be well over 0.01 radian,
// the precision bzo keeps a native client's azimuth to (`moveFromBzfs`), and
// this one is also the tank's own turn rate at 30 updates a second.
const STEPS = 240;
const STEP = (2 * Math.PI) / STEPS;

function cpuSeconds(pid) {
  const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  return (Number(fields[11]) + Number(fields[12])) / 100;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

const tanks = [];
const latencies = [];
let sent = 0;
let received = 0;

async function join(index) {
  const session = new BzfsSession({
    host: HOST, port: PORT, callsign: `bench${index}`, motto: 'bench-relay', team: index % 5, worldHash: true,
  });
  const tank = { session, seq: 0, sentAt: new Map(), pos: [0, 0, 0], alive: false };
  session.on('alive', (spawn) => {
    if (spawn.id !== session.playerId) return;
    tank.pos = spawn.pos;
    tank.alive = true;
  });
  session.on('killed', (death) => {
    if (death.victim === session.playerId) {
      tank.alive = false;
      setTimeout(() => session.sendAlive(), 100);
    }
  });
  session.on('frame', ({ code, payload }) => {
    if (code !== 'pu' && code !== 'ps') return;
    const update = decodePlayerUpdate(payload, code === 'ps');
    const sender = tanks.find((t) => t.session.playerId === update.id);
    if (!sender || sender === tank) return;
    const turn = ((update.azimuth % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const slot = Math.round(turn / STEP) % STEPS;
    const at = sender.sentAt.get(slot);
    if (at === undefined) return;
    received++;
    latencies.push(performance.now() - at);
  });
  await session.connect();
  session.openUdpLink();
  session.sendAlive();
  return tank;
}

for (let i = 0; i < TANKS; i++) tanks.push(await join(i));
await new Promise((resolve) => setTimeout(resolve, 2000));
const live = tanks.filter((t) => t.alive).length;
const onUdp = tanks.filter((t) => t.session.udpOut).length;
console.log(`${HOST}:${PORT} ${TANKS} tanks (${live} spawned, ${onUdp} on UDP), ${RATE}/s each, ${SECONDS}s`);

const cpuStart = PID ? cpuSeconds(PID) : null;
const wallStart = performance.now();
latencies.length = 0;
received = 0;
const timer = setInterval(() => {
  for (const tank of tanks) {
    if (!tank.alive) continue;
    tank.seq++;
    const slot = tank.seq % STEPS;
    tank.sentAt.set(slot, performance.now());
    tank.session.sendPlayerUpdate({
      pos: tank.pos, velocity: [0, 0, 0], azimuth: slot * STEP, angVel: STEP * RATE,
      status: PLAYER_STATUS.ALIVE,
    });
    sent++;
  }
}, 1000 / RATE);

await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000));
clearInterval(timer);
await new Promise((resolve) => setTimeout(resolve, 500));
const wall = (performance.now() - wallStart) / 1000;
const cpu = PID ? cpuSeconds(PID) - cpuStart : null;

const sorted = [...latencies].sort((a, b) => a - b);
const expected = sent * (live - 1);
const fmt = (ms) => `${ms.toFixed(1)}ms`;
console.log(`sent ${sent}, delivered ${received}/${expected} (${((100 * received) / expected).toFixed(1)}%)`);
console.log(`latency p50 ${fmt(percentile(sorted, 0.5))} p90 ${fmt(percentile(sorted, 0.9))} p99 ${fmt(percentile(sorted, 0.99))} max ${fmt(sorted[sorted.length - 1] ?? NaN)}`);
if (cpu !== null) {
  console.log(`server cpu ${(100 * cpu / wall).toFixed(1)}% of a core, ${((cpu * 1e6) / sent).toFixed(0)}us per update in`);
}
for (const tank of tanks) tank.session.close();
setTimeout(() => process.exit(0), 300);
