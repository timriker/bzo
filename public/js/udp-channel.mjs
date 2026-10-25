/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The UDP channel: upstream's UDP over a WebRTC data channel (#8;
// server/udp-channel.cjs has why).
// This end offers; the server answers and lists its IPv4 address and port,
// and hears this end's address from the checks. The server's TURN relays,
// over UDP, are this end's last resort: ICE prefers a direct pair and takes
// the relayed one only when none works, for a network that passes UDP to the
// relay but not to the game. `relayOnly` holds it to the relay, for testing.
//
// Until the channel opens, and for good if it never does, its messages stay
// on the WebSocket. Nothing here is required for play.

const CHANNEL_LABEL = 'udp';
const CHANNEL_OPTIONS = { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 };
// Long enough for ICE to try every pair; a channel not open by then is
// behind something that will not pass it.
const OPEN_TIMEOUT_MS = 10000;
// How often a WebTransport session repeats its token until the server answers.
const CLAIM_REPEAT_MS = 250;

export function createUdpChannel({
  sendSignal, onMessage, log = () => {}, PeerConnection = globalThis.RTCPeerConnection,
}) {
  let pc = null;
  let channel = null;
  let remoteSet = false;
  let queued = [];
  let timer = null;

  function close() {
    clearTimeout(timer);
    timer = null;
    try { channel?.close(); } catch { /* already closed */ }
    try { pc?.close(); } catch { /* already closed */ }
    channel = null;
    pc = null;
    remoteSet = false;
    queued = [];
  }

  return {
    isOpen: () => channel?.readyState === 'open',

    async start({ iceServers = [], relayOnly = false } = {}) {
      close();
      if (typeof PeerConnection !== 'function') return;
      const peer = new PeerConnection({ iceServers, iceTransportPolicy: relayOnly ? 'relay' : 'all' });
      pc = peer;
      channel = peer.createDataChannel(CHANNEL_LABEL, CHANNEL_OPTIONS);
      channel.onopen = () => {
        clearTimeout(timer);
        log('open');
        // The DTLS cipher the browser settled on, for the server's log.
        peer.getStats().then((stats) => {
          for (const report of stats.values()) {
            if (report.type === 'transport' && report.dtlsCipher && pc === peer) {
              sendSignal({ cipher: report.dtlsCipher });
              return;
            }
          }
        }).catch(() => {});
      };
      channel.onclose = () => {
        if (pc === peer) {
          log('closed');
          close();
        }
      };
      channel.onmessage = (event) => {
        if (typeof event.data === 'string') onMessage(event.data);
      };
      peer.onicecandidate = (event) => {
        if (event.candidate?.candidate && pc === peer) {
          sendSignal({ candidate: event.candidate.candidate, mid: event.candidate.sdpMid ?? '0' });
        }
      };
      peer.onconnectionstatechange = () => {
        if (pc === peer && (peer.connectionState === 'failed' || peer.connectionState === 'closed')) close();
      };
      timer = setTimeout(() => {
        if (pc === peer && channel?.readyState !== 'open') {
          log('timed out');
          close();
        }
      }, OPEN_TIMEOUT_MS);
      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        if (pc === peer) sendSignal({ sdp: offer.sdp, sdpType: 'offer' });
      } catch (error) {
        log(`data channel offer failed: ${error.message}`);
        close();
      }
    },

    // The server's answer, or one of its candidates.
    async signal(message) {
      const peer = pc;
      if (!peer) return;
      try {
        if (typeof message.sdp === 'string' && message.sdpType === 'answer') {
          await peer.setRemoteDescription({ type: 'answer', sdp: message.sdp });
          remoteSet = true;
          for (const candidate of queued) await peer.addIceCandidate(candidate);
          queued = [];
        } else if (typeof message.candidate === 'string') {
          const candidate = { candidate: message.candidate, sdpMid: message.mid ?? '0' };
          if (remoteSet) await peer.addIceCandidate(candidate);
          else queued.push(candidate);
        }
      } catch (error) {
        log(`data channel signalling failed: ${error.message}`);
      }
    },

    // False when the channel is not open, so the caller sends it the other way.
    send(text) {
      if (channel?.readyState !== 'open') return false;
      try {
        channel.send(text);
        return true;
      } catch {
        return false;
      }
    },

    close,
  };
}

// The same channel over WebTransport (HTTP/3 datagrams, #189), straight to
// the BZFlag port: tried first where the browser has it and the server offers
// it. The page may have come through a reverse proxy, which QUIC does not
// pass, so `url` names the port. The session says which player it is with
// the server's token in a datagram, `token:` and the token, repeated until
// the server answers `ok` -- not on a stream, which Safari never opens here.
export function createWebTransportChannel({
  onMessage, log = () => {}, WebTransportImpl = globalThis.WebTransport,
}) {
  let transport = null;
  let writer = null;
  let open = false;
  const encoder = new globalThis.TextEncoder();
  const decoder = new globalThis.TextDecoder();

  function close() {
    open = false;
    writer = null;
    try { transport?.close(); } catch { /* already closed */ }
    transport = null;
  }

  return {
    available: () => typeof WebTransportImpl === 'function',
    isOpen: () => open,

    // True once the server has taken the token; false when it never opens.
    // The attempt races its own timeout rather than trusting a closed
    // session to settle `ready`, which Safari's did not, so the caller always
    // gets an answer and can go on to WebRTC.
    async start({ url, token }) {
      close();
      if (typeof WebTransportImpl !== 'function') return false;
      let session;
      try {
        session = new WebTransportImpl(url);
      } catch (error) {
        log(`webtransport failed: ${error.message || error}`);
        return false;
      }
      transport = session;
      let accepted = null;
      let repeat = null;
      const attempt = (async () => {
        await session.ready;
        // `createWritable` is the current API and Safari's only one; Chrome
        // still has the older `writable` too.
        writer = (session.datagrams.createWritable?.() ?? session.datagrams.writable).getWriter();
        const heard = new Promise((resolve) => { accepted = resolve; });
        // Driven by the stream, which ends this when the session goes.
        session.datagrams.readable.pipeTo(new globalThis.WritableStream({
          write(value) {
            const text = decoder.decode(value);
            if (text === 'ok') accepted?.();
            else if (open) onMessage(text);
          },
        })).catch(() => {});
        const claim = encoder.encode(`token:${token}`);
        repeat = setInterval(() => writer?.write(claim).catch(() => {}), CLAIM_REPEAT_MS);
        writer.write(claim).catch(() => {});
        await heard;
        return true;
      })();
      attempt.catch(() => {});
      let outcome;
      try {
        outcome = await Promise.race([
          attempt,
          new Promise((resolve) => { setTimeout(() => resolve('timed out'), OPEN_TIMEOUT_MS); }),
        ]);
      } catch (error) {
        outcome = error.message || String(error);
      }
      clearInterval(repeat);
      if (outcome !== true || transport !== session) {
        if (transport === session) {
          log(`webtransport ${outcome === 'timed out' ? 'timed out' : `failed: ${outcome}`}`);
          close();
        }
        return false;
      }
      open = true;
      log('webtransport open');
      session.closed.catch(() => {}).finally(() => {
        if (transport === session) {
          log('webtransport closed');
          close();
        }
      });
      return true;
    },

    // False when it is not open, so the caller sends it the other way.
    send(text) {
      if (!open || !writer) return false;
      writer.write(encoder.encode(text)).catch(() => {});
      return true;
    },

    close,
  };
}
