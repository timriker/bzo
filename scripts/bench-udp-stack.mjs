/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// What the server's half of a browser's UDP path costs on each stack (#189):
// libdatachannel on its own port, as server/udp-channel.cjs runs it; werift
// with a socket per peer; werift on one shared socket; WebTransport datagrams
// (HTTP/3, @fails-components/webtransport) on that same socket; and both at
// once, half the tanks on each. The shared socket sorts every datagram by its
// first byte (RFC 9443) -- STUN, DTLS, QUIC, BZFlag -- which is what serving
// them all on the BZFlag port needs.
//
//   node scripts/bench-udp-stack.mjs                          # every stack, 2/8/16 tanks
//   node scripts/bench-udp-stack.mjs --stack wt-shared --tanks 16 --seconds 20
//
// The server is a child process, so its CPU (utime+stime, every thread, from
// /proc) is its own. It relays each move to every peer, gathered once per
// turn of the event loop and split to fit a packet, as bzo's
// `flushChannelMoves` does. The tanks are node-datachannel peers in this
// process, opened through public/udp-channel.mjs, the browser's own code;
// WebTransport tanks are the library's Node client, trusting a throwaway
// certificate by its hash as a browser's `serverCertificateHashes` does.
// Latency is send to receive on this process's clock.

import { execFileSync, fork } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => {
  if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]);
  return pairs;
}, []));

const STACKS = ['ndc', 'werift-own', 'werift-shared', 'wt-shared', 'mixed'];
const PORT = Number(args.port || 5160);
const RATE = Number(args.rate || 30);
const SECONDS = Number(args.seconds || 20);
const MOVE_BYTES = 120;
// A packet's worth, as server.js's UDP_CHANNEL_CHUNK_BYTES.
const CHUNK_BYTES = 1100;

// --- server (child) ---------------------------------------------------------

async function runServer(stack) {
  const peers = new Map();
  let pending = [];
  let n = 0;

  function flush() {
    const moves = pending;
    pending = [];
    n += 1;
    const chunks = [];
    let parts = [];
    let size = 0;
    for (const move of moves) {
      if (parts.length && size + move.length + 1 > CHUNK_BYTES) {
        chunks.push(`{"n":${n},"moves":[${parts.join(',')}]}`);
        parts = [];
        size = 0;
      }
      parts.push(move);
      size += move.length + 1;
    }
    if (parts.length) chunks.push(`{"n":${n},"moves":[${parts.join(',')}]}`);
    for (const peer of peers.values()) for (const chunk of chunks) peer.send(chunk);
  }
  function onMove(text) {
    if (pending.length === 0) setImmediate(flush);
    pending.push(text);
  }

  if (stack === 'wt-shared' || stack === 'mixed') await wtStack(peers, onMove);
  const open = stack === 'ndc' ? await ndcStack() : await weriftStack(stack !== 'werift-own');

  process.on('message', (message) => {
    if (message.type === 'open') {
      const peer = open({
        sendSignal: (signal) => process.send({ type: 'signal', id: message.id, signal }),
        onMessage: onMove,
      });
      peers.set(message.id, peer);
    } else if (message.type === 'signal') {
      peers.get(message.id)?.signal(message.signal);
    } else if (message.type === 'exit') {
      process.exit(0);
    }
  });
  process.send({ type: 'ready' });
}

// libdatachannel, through bzo's own server/udp-channel.cjs.
async function ndcStack() {
  const { createUdpChannels } = require('../server/udp-channel.cjs');
  const channels = createUdpChannels({ listen: `127.0.0.1:${PORT}` });
  return ({ sendSignal, onMessage }) => {
    const session = channels.open({ name: 'bench', sendSignal, onMessage });
    return { send: (text) => session.send(text), signal: (signal) => session.signal(signal) };
  };
}

async function weriftStack(shared) {
  const werift = require('werift');
  // Not an export of the package; the same file werift's ICE loads.
  if (shared) shareWithWerift(require(fileURLToPath(new URL('../node_modules/werift/lib/common/src/transport.js', import.meta.url))));
  return ({ sendSignal, onMessage }) => {
    const pc = new werift.RTCPeerConnection({
      iceUseIpv4: true,
      iceUseIpv6: false,
      iceInterfaceAddresses: { udp4: '127.0.0.1' },
    });
    const channel = pc.createDataChannel('udp', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    channel.onMessage.subscribe((data) => onMessage(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')));
    pc.onIceCandidate.subscribe((candidate) => {
      if (candidate?.candidate) sendSignal({ candidate: `candidate:${candidate.candidate.replace(/^candidate:/, '')}`, mid: candidate.sdpMid ?? '0' });
    });
    let remoteSet = false;
    const queued = [];
    return {
      send(text) {
        if (channel.readyState !== 'open') return false;
        channel.send(text);
        return true;
      },
      async signal(signal) {
        if (signal.sdpType === 'offer') {
          await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
          remoteSet = true;
          for (const candidate of queued.splice(0)) await pc.addIceCandidate(candidate);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          if (shared) claimUsername(pc);
          sendSignal({ sdp: pc.localDescription.sdp, sdpType: 'answer' });
        } else if (typeof signal.candidate === 'string') {
          const candidate = { candidate: signal.candidate, sdpMid: signal.mid ?? '0' };
          if (remoteSet) await pc.addIceCandidate(candidate);
          else queued.push(candidate);
        }
      },
    };
  };
}

// One socket for every peer. A datagram is sorted by its first byte: 0-3 is
// STUN when bytes 2-3 are its length and 4-7 its magic cookie, else BZFlag
// (bytes 0-1 its length, 2-3 an ASCII code); 20-63 DTLS; 64-127 and 192-255
// QUIC. STUN finds its werift peer by the ICE username it carries (this end's
// ufrag first), and from then on that peer owns the sender's address. QUIC
// goes to the one HTTP/3 server, which keeps its own connections by ID.
const byUfrag = new Map();
const byAddress = new Map();
const unclaimed = new Set();
let socket = null;
let socketReady = null;
let quicHandler = null;

function openSharedSocket() {
  if (socket) return;
  const dgram = require('node:dgram');
  socket = dgram.createSocket('udp4');
  socketReady = new Promise((resolve) => socket.bind(PORT, '127.0.0.1', resolve));
  socket.on('message', (data, rinfo) => {
    const key = `${rinfo.address}:${rinfo.port}`;
    const first = data[0];
    let view = null;
    if (first <= 3) {
      const isStun = data.length >= 20 && data.readUInt32BE(4) === 0x2112a442 && data.readUInt16BE(2) + 20 === data.length;
      if (!isStun) return; // BZFlag's, for its own handler
      view = byAddress.get(key) || byUfrag.get(stunLocalUfrag(data));
      if (view) byAddress.set(key, view);
    } else if (first >= 20 && first <= 63) {
      view = byAddress.get(key);
    } else if ((first >= 64 && first <= 127) || first >= 192) {
      quicHandler?.(data, rinfo);
      return;
    }
    view?.onData?.(data, [rinfo.address, rinfo.port]);
  });
}

// werift's own transport swapped for a view of the shared socket.
function shareWithWerift(transportModule) {
  openSharedSocket();
  transportModule.UdpTransport.init = async () => {
    await socketReady;
    const view = {
      type: 'udp',
      closed: false,
      onData: () => {},
      send: async (data, addr) => { socket.send(data, addr[1], addr[0]); },
      close: async () => { view.closed = true; },
      get address() { return socket.address(); },
      addressFamily: 4,
      get host() { return socket.address().address; },
      get port() { return socket.address().port; },
    };
    unclaimed.add(view);
    return view;
  };
}

// HTTP/3 on the shared socket: the quiche transport's server socket keeps
// its packet handling and sends, and takes the shared socket in place of
// binding its own. Each WebTransport session is a peer; datagrams carry the
// moves both ways.
async function wtStack(peers, onMessage) {
  openSharedSocket();
  const quiche = await import('@fails-components/webtransport-transport-http3-quiche');
  quiche.Http3WebTransportServerSocket.prototype.init = function init() {
    this.address = { address: '127.0.0.1', family: 4 };
    this.socketInt = socket;
    quicHandler = (msg, rinfo) => {
      const haschlos = this.cobj.recvPaket({ msg, rinfo, selfaddress: socket.address() });
      if (!this.chlosSched && haschlos) {
        setImmediate(this.doProcessBufferedChlos);
        this.chlosSched = true;
      }
    };
    void socketReady.then(() => {
      const { address, port } = socket.address();
      this.jsobj.onServerListening({ port, host: address });
      this.cobj.onCanWrite();
    });
  };
  const { Http3Server } = await import('@fails-components/webtransport');
  const server = new Http3Server({
    port: PORT,
    host: '127.0.0.1',
    secret: 'bench',
    cert: readFileSync(args.cert, 'utf8'),
    privKey: readFileSync(args.key, 'utf8'),
  });
  const sessions = server.sessionStream('/udp');
  server.startServer();
  await server.ready;
  let count = 0;
  void (async () => {
    const reader = sessions.getReader();
    for (;;) {
      const { done, value: session } = await reader.read();
      if (done) return;
      const key = `wt${count++}`;
      session.closed.finally(() => peers.delete(key)).catch(() => {});
      session.ready.then(async () => {
        const writer = session.datagrams.createWritable().getWriter();
        peers.set(key, {
          send(text) {
            writer.write(Buffer.from(text)).catch(() => {});
            return true;
          },
        });
        const datagrams = session.datagrams.readable.getReader();
        for (;;) {
          const { done: ended, value } = await datagrams.read();
          if (ended) return;
          onMessage(Buffer.from(value).toString('utf8'));
        }
      }).catch(() => {});
    }
  })();
}

// After the answer, this peer's ICE username is known; its transports are
// the ones its gathering just made.
function claimUsername(pc) {
  for (const transport of pc.iceTransports ?? []) {
    const connection = transport.connection;
    for (const protocol of connection.protocols ?? []) {
      if (unclaimed.delete(protocol.transport)) byUfrag.set(connection.localUsername, protocol.transport);
    }
  }
}

// USERNAME (0x0006) is "receiver:sender"; on a check to this end the
// receiver is this end's ufrag.
function stunLocalUfrag(data) {
  let at = 20;
  while (at + 4 <= data.length) {
    const type = data.readUInt16BE(at);
    const length = data.readUInt16BE(at + 2);
    if (type === 0x0006) return data.toString('utf8', at + 4, at + 4 + length).split(':')[0];
    at += 4 + length + ((4 - (length % 4)) % 4);
  }
  return '';
}

// --- bench (parent) ---------------------------------------------------------

// A throwaway ECDSA P-256 certificate, under the 14 days a browser allows
// for `serverCertificateHashes`, and its SHA-256.
function makeCertificate() {
  const dir = mkdtempSync(join(tmpdir(), 'bench-udp-stack-'));
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', '10', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  const der = execFileSync('openssl', ['x509', '-in', cert, '-outform', 'der']);
  const hash = execFileSync('openssl', ['dgst', '-sha256', '-binary'], { input: der });
  return { dir, cert, key, hash: new Uint8Array(hash) };
}

// A WebTransport tank, shaped like public/udp-channel.mjs's channel.
function createWtClient({ hash, onMessage }) {
  let transport = null;
  let writer = null;
  let open = false;
  return {
    async start() {
      const { WebTransport, quicheLoaded } = await import('@fails-components/webtransport');
      await quicheLoaded;
      transport = new WebTransport(`https://127.0.0.1:${PORT}/udp`, {
        serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }],
      });
      await transport.ready;
      writer = transport.datagrams.createWritable().getWriter();
      open = true;
      void (async () => {
        const reader = transport.datagrams.readable.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          onMessage(Buffer.from(value).toString('utf8'));
        }
      })().catch(() => {});
    },
    isOpen: () => open,
    send(text) {
      writer?.write(Buffer.from(text)).catch(() => {});
      return open;
    },
    signal() {},
    close() {
      open = false;
      try { transport?.close(); } catch { /* already closed */ }
    },
  };
}

function cpuTicks(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return Number(fields[11]) + Number(fields[12]);
}

async function runOnce(stack, tanks) {
  const { RTCPeerConnection } = await import('node-datachannel/polyfill');
  const { createUdpChannel } = await import('../public/udp-channel.mjs');
  const certificate = makeCertificate();
  const child = fork(fileURLToPath(import.meta.url), ['--role', 'server', '--stack', stack, '--port', String(PORT),
    '--cert', certificate.cert, '--key', certificate.key], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  child.once('exit', (code) => {
    if (code) {
      console.error(`${stack}: server exited ${code}`);
      process.exit(1);
    }
  });
  await new Promise((resolve) => child.on('message', (m) => m.type === 'ready' && resolve()));

  const clients = [];
  const latencies = [];
  let received = 0;
  let measuring = false;
  for (let id = 0; id < tanks; id += 1) {
    const onMessage = (text) => {
      if (!measuring) return;
      const batch = JSON.parse(text);
      const now = performance.now();
      for (const move of batch.moves) {
        if (move.id === id) continue;
        received += 1;
        latencies.push(now - move.t);
      }
    };
    const wt = stack === 'wt-shared' || (stack === 'mixed' && id % 2 === 1);
    const client = { id, seq: 0, sent: 0, wt };
    client.channel = wt
      ? createWtClient({ hash: certificate.hash, onMessage })
      : createUdpChannel({
        sendSignal: (signal) => child.send({ type: 'signal', id, signal }),
        onMessage,
        PeerConnection: RTCPeerConnection,
      });
    clients.push(client);
  }
  child.on('message', (m) => {
    if (m.type === 'signal') void clients[m.id].channel.signal(m.signal);
  });
  for (const client of clients) {
    if (!client.wt) child.send({ type: 'open', id: client.id });
    await client.channel.start();
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !clients.every((c) => c.channel.isOpen())) await new Promise((r) => setTimeout(r, 100));
  const open = clients.filter((c) => c.channel.isOpen()).length;

  // Each tank's moves on its own timer, spread across the interval, as
  // players' frames are.
  const pad = 'x'.repeat(MOVE_BYTES - 40);
  const timers = clients.map((client, i) => setTimeout(() => {
    client.timer = setInterval(() => {
      if (!measuring) return;
      client.seq += 1;
      client.sent += 1;
      client.channel.send(JSON.stringify({ id: client.id, s: client.seq, t: performance.now(), p: pad }));
    }, 1000 / RATE);
  }, (i * 1000) / RATE / tanks));

  await new Promise((r) => setTimeout(r, 1500));
  measuring = true;
  const before = cpuTicks(child.pid);
  const startedAt = performance.now();
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  measuring = false;
  const elapsed = (performance.now() - startedAt) / 1000;
  const cpu = (cpuTicks(child.pid) - before) / elapsed;
  await new Promise((r) => setTimeout(r, 300));

  timers.forEach(clearTimeout);
  for (const client of clients) {
    clearInterval(client.timer);
    client.channel.close();
  }
  child.send({ type: 'exit' });
  await new Promise((r) => child.once('exit', r));
  rmSync(certificate.dir, { recursive: true, force: true });

  const sent = clients.reduce((sum, c) => sum + c.sent, 0);
  const expected = sent * (tanks - 1);
  latencies.sort((a, b) => a - b);
  const pct = (p) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))].toFixed(1) : '-');
  return {
    stack,
    tanks,
    open,
    cpu: `${cpu.toFixed(0)}%`,
    relayed: Math.round(received / elapsed),
    delivered: expected ? `${((100 * received) / expected).toFixed(1)}%` : '-',
    p50: pct(0.5),
    p99: pct(0.99),
  };
}

async function runBench() {
  const stacks = args.stack ? [args.stack] : STACKS;
  const counts = args.tanks ? [Number(args.tanks)] : [2, 8, 16];
  console.log(`${RATE} moves/s per tank, ${SECONDS}s each; cpu is the server process, 100% = one core`);
  console.log('stack          tanks open  cpu  relayed/s delivered  p50ms  p99ms');
  for (const tanks of counts) {
    for (const stack of stacks) {
      const r = await runOnce(stack, tanks);
      console.log(`${r.stack.padEnd(14)} ${String(r.tanks).padStart(5)} ${String(r.open).padStart(4)} ${r.cpu.padStart(4)} ${String(r.relayed).padStart(9)} ${r.delivered.padStart(9)} ${String(r.p50).padStart(6)} ${String(r.p99).padStart(6)}`);
    }
  }
  process.exit(0);
}

if (args.role === 'server') await runServer(args.stack);
else await runBench();
