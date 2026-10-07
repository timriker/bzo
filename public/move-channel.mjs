/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Moves over a WebRTC data channel (#8; server/move-channel.cjs has why).
// This end offers; the server answers and lists its IPv4 address and port,
// so this end needs no ICE servers of its own -- the server is the one that
// has to be reachable, and it hears this end's address from the checks.
//
// Until the channel opens, and for good if it never does, moves stay on
// the WebSocket. Nothing here is required for play.

const CHANNEL_LABEL = 'moves';
const CHANNEL_OPTIONS = { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 };
// Long enough for ICE to try every pair; a channel not open by then is
// behind something that will not pass it.
const OPEN_TIMEOUT_MS = 10000;

export function createMoveChannel({
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

    async start() {
      close();
      if (typeof PeerConnection !== 'function') return;
      const peer = new PeerConnection({ iceServers: [] });
      pc = peer;
      channel = peer.createDataChannel(CHANNEL_LABEL, CHANNEL_OPTIONS);
      channel.onopen = () => {
        clearTimeout(timer);
        log('open');
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
