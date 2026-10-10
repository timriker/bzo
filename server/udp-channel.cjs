/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The UDP channel (#8): upstream's UDP for a browser, over a WebRTC data
// channel. A WebSocket is TCP, and one lost packet holds back every message
// behind it -- the stalls `[LAG]` reports. A channel that neither retries nor
// orders loses that one message and delivers the next on time, which is what
// UDP does for a BZFlag client.
//
// It carries what bzfs sends over UDP: moves and shots. Everything else, and
// all of it for a player whose channel never opened, stays on the WebSocket,
// which also carries the signalling.
//
// Every peer shares one UDP port (ICE UDP mux), so a firewall or router
// needs one rule. IPv4 only: a phone on Verizon loses its data session
// within a second of WebRTC over its IPv6 (see `voiceIceServersIpv4`), and a
// server that binds and offers IPv4 alone leaves no IPv6 pair to form.
//
// node-datachannel is an optional dependency; without it this is off and
// says why once.

const { splitHostPort } = require('./listen-address.cjs');

// The channel both ends create, negotiated rather than announced, so neither
// waits for the other to open it.
const CHANNEL_LABEL = 'udp';
const CHANNEL_OPTIONS = { negotiated: true, id: 0, unordered: true, maxRetransmits: 0 };

// What one signalling message may carry. An offer from a browser is a few
// kilobytes; a candidate line is under two hundred bytes.
const MAX_SDP_LENGTH = 16384;
const MAX_CANDIDATE_LENGTH = 512;
// Candidates that arrive before the offer has been applied, held until it is.
const MAX_QUEUED_CANDIDATES = 32;
// A move or a shot is a little over a hundred bytes; anything far larger is
// neither.
const MAX_INCOMING_MESSAGE = 2048;

// A candidate's connection address is its fifth field. An IPv6 one cannot
// pair with an IPv4-only server, and a `.local` mDNS name is a browser hiding
// its LAN address, which this end has no way to resolve.
function candidateIsUsable(candidate) {
  const address = String(candidate).replace(/^a=/, '').split(/\s+/)[4] || '';
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(address);
}

function createUdpChannels({ listen, iceServers = [], log = () => {}, load = () => require('node-datachannel') }) {
  const { host, port } = splitHostPort(String(listen));
  const bindAddress = host || '0.0.0.0';
  const udpPort = Number(port);
  if (!Number.isInteger(udpPort) || udpPort <= 0 || udpPort > 65535) {
    log(`[RTC] webrtc.listen "${listen}" names no port; off`);
    return null;
  }
  if (bindAddress.includes(':')) {
    log(`[RTC] webrtc.listen "${listen}" is IPv6; off (IPv4 only, see docs/network.md)`);
    return null;
  }
  let ndc;
  try {
    ndc = load();
  } catch (error) {
    log(`[RTC] node-datachannel unavailable (${error.message}); off`);
    return null;
  }
  const config = {
    iceServers,
    bindAddress,
    enableIceUdpMux: true,
    portRangeBegin: udpPort,
    portRangeEnd: udpPort,
  };
  const sessions = new Set();
  log(`[RTC] UDP ${bindAddress}:${udpPort}`);

  // libdatachannel calls back from its own threads, and a throw inside one
  // of those aborts the process. Each callback is moved onto the event loop
  // and guarded there.
  function deferred(fn) {
    return (...args) => setImmediate(() => {
      try {
        fn(...args);
      } catch (error) {
        log(`[RTC] ${error.message}`);
      }
    });
  }

  return {
    port: udpPort,

    // One player's peer. `sendSignal` carries an answer or a candidate back
    // over the WebSocket; `onMessage` gets each message the channel brings.
    open({ name, sendSignal, onMessage, onOpen = () => {}, onClose = () => {} }) {
      const pc = new ndc.PeerConnection(`bzo-${name}`, config);
      let channel = null;
      let remoteSet = false;
      let closed = false;
      let queued = [];

      const session = {
        isOpen: () => Boolean(channel && !closed && channel.isOpen()),
        send(text) {
          if (!session.isOpen()) return false;
          try {
            return channel.sendMessage(text);
          } catch {
            return false;
          }
        },
        // The browser's offer, or one of its candidates.
        signal(message) {
          if (closed) return;
          if (typeof message.sdp === 'string') {
            if (remoteSet || message.sdpType !== 'offer' || message.sdp.length > MAX_SDP_LENGTH) return;
            pc.setRemoteDescription(message.sdp, 'offer');
            remoteSet = true;
            // After the offer, so this end answers rather than offering too.
            channel = pc.createDataChannel(CHANNEL_LABEL, CHANNEL_OPTIONS);
            channel.onOpen(deferred(() => {
              const pair = pc.getSelectedCandidatePair();
              onOpen(pair ? `${pair.remote.address}:${pair.remote.port}` : '');
            }));
            channel.onMessage(deferred((data) => {
              const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
              if (text.length <= MAX_INCOMING_MESSAGE) onMessage(text);
            }));
            channel.onClosed(deferred(() => session.close()));
            for (const [candidate, mid] of queued) pc.addRemoteCandidate(candidate, mid);
            queued = [];
            return;
          }
          if (typeof message.candidate !== 'string' || message.candidate.length > MAX_CANDIDATE_LENGTH) return;
          if (!candidateIsUsable(message.candidate)) return;
          const mid = typeof message.mid === 'string' ? message.mid : '0';
          if (remoteSet) pc.addRemoteCandidate(message.candidate, mid);
          else if (queued.length < MAX_QUEUED_CANDIDATES) queued.push([message.candidate, mid]);
        },
        close() {
          if (closed) return;
          closed = true;
          sessions.delete(session);
          try { channel?.close(); } catch { /* already closing */ }
          try { pc.close(); } catch { /* already closed */ }
          onClose();
        },
      };

      pc.onLocalDescription(deferred((sdp, type) => {
        if (!closed) sendSignal({ sdp, sdpType: type });
      }));
      pc.onLocalCandidate(deferred((candidate, mid) => {
        if (!closed && candidateIsUsable(candidate)) sendSignal({ candidate, mid });
      }));
      pc.onStateChange(deferred((state) => {
        if (state === 'failed' || state === 'closed') session.close();
      }));
      sessions.add(session);
      return session;
    },

    close() {
      for (const session of [...sessions]) session.close();
    },
  };
}

module.exports = { createUdpChannels, candidateIsUsable };
