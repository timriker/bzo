/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The voice manager deliberately uses browser-native WebRTC. The existing
// WebSocket is used only for signaling and state; audio bytes never go through
// the WebSocket connection.

import { normalizePlayerTeam } from './teams.mjs';
import {
  DEFAULT_VOLUME_LEVEL,
  clampVolumeLevel,
  volumeLevelToGain,
} from './volume.mjs';
import { DEFAULT_VOICE_CHANNEL, normalizeVoiceChannel } from './voice-channels.mjs';

function normalizePlayerId(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function normalizeDeviceId(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function comparePlayerIds(left, right) {
  const leftId = normalizePlayerId(left);
  const rightId = normalizePlayerId(right);
  if (leftId === null || rightId === null) return 0;

  const leftNumber = Number(leftId);
  const rightNumber = Number(rightId);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return leftId.localeCompare(rightId);
}

function getMessagePeerId(message) {
  if (!message || typeof message !== 'object') return null;
  return normalizePlayerId(
    message.from ??
    message.fromId ??
    message.playerId ??
    message.peerId ??
    message.sourceId ??
    message.senderId ??
    message.source,
  );
}

function getRosterItems(message) {
  const value = message && (
    message.peers ??
    message.players ??
    message.roster ??
    message.nearby ??
    message.ids
  );

  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([id, details]) => {
      if (details && typeof details === 'object') return { ...details, id: details.id ?? id };
      return { id };
    });
  }
  return [];
}

function normalizeRosterItem(item) {
  if (item && typeof item === 'object') {
    const id = normalizePlayerId(item.id ?? item.playerId ?? item.peerId);
    return id ? { ...item, id } : null;
  }
  const id = normalizePlayerId(item);
  return id ? { id } : null;
}

function serializeDescription(description) {
  if (!description) return description;
  return {
    type: description.type,
    sdp: description.sdp,
  };
}

function createVoiceError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

/**
 * Create a dependency-free nearby voice manager.
 *
 * The manager does not create UI. Consumers own buttons, settings, and help
 * text, and can use the state callbacks or getState() to render them.
 *
 * @param {object} options
 * @param {Function} options.sendToServer Sends one JSON-serializable message.
 * @param {string|number} options.localPlayerId The server-assigned player ID.
 * @param {string} [options.team='rogue'] Player team.
 * @param {object} [options.callbacks] State, peer, audio, device, and error callbacks.
 * @param {RTCConfiguration} [options.rtcConfig] RTCPeerConnection configuration.
 * @param {RTCPeerConnection} [options.RTCPeerConnection] Test/browser constructor override.
 * @param {boolean} [options.startMuted=true] Keep the microphone disabled after capture.
 * @param {number} [options.voiceVolumeLevel=10] Playback level, 0..10, for remote voice.
 * @param {number} [options.microphoneVolumeLevel=10] Capture level, 0..10, for the local microphone.
 * @param {Function} [options.getAudioContext] Supplies the AudioContext the microphone gain runs in.
 * @param {string} [options.channel='nearby'] Which players to talk to: all, nearby, or team.
 * @returns {object} Voice manager API.
 */
export function createVoiceManager(options = {}) {
  const sendToServer = typeof options.sendToServer === 'function'
    ? options.sendToServer
    : () => {};
  const callbacks = options.callbacks || {};
  const PeerConnection = options.RTCPeerConnection
    || (typeof globalThis !== 'undefined' ? globalThis.RTCPeerConnection : null);
  let rtcConfig = options.rtcConfig || {
    iceServers: Array.isArray(options.iceServers) ? options.iceServers : [],
  };

  let started = false;
  let closed = false;
  let localPlayerId = normalizePlayerId(options.localPlayerId);
  let team = normalizePlayerTeam(options.team);
  let inputDeviceId = normalizeDeviceId(options.inputDeviceId);
  let audioConstraints = {
    channelCount: 1,
    echoCancellation: options.audioConstraints?.echoCancellation !== false,
    noiseSuppression: options.audioConstraints?.noiseSuppression !== false,
    autoGainControl: options.audioConstraints?.autoGainControl !== false,
  };
  // The raw getUserMedia stream, and the stream actually sent to peers. They
  // differ whenever the microphone gain stage below is in place.
  let captureStream = null;
  let localStream = null;
  let microphoneGraph = null;
  let channel = normalizeVoiceChannel(options.channel ?? DEFAULT_VOICE_CHANNEL);
  let voiceVolumeLevel = clampVolumeLevel(options.voiceVolumeLevel, DEFAULT_VOLUME_LEVEL);
  let microphoneVolumeLevel = clampVolumeLevel(options.microphoneVolumeLevel, DEFAULT_VOLUME_LEVEL);
  const getAudioContext = typeof options.getAudioContext === 'function'
    ? options.getAudioContext
    : () => null;
  let microphonePermission = 'prompt';
  let microphoneEnabled = options.startMuted === false
    ? Boolean(options.microphoneEnabled)
    : false;
  let serverAllowsTransmission = true;
  let microphoneRequest = null;
  let lifecycleGeneration = 0;
  let lastError = null;

  const roster = new Map();
  const peers = new Map();
  const listeners = [];
  // `/silence`'s bzo-specific half: upstream has no voice to silence, but a
  // text-only /silence here would be surprising when the same player's voice
  // keeps coming through. The host decides who belongs in this set (a
  // callsign match, or bzo's own answer to upstream's "-" -- unauthenticated)
  // and just tells us the id; this module only ever answers "is this peer
  // muted" at the one place playback volume is set.
  const mutedPeerIds = new Set();

  function invoke(name, ...args) {
    const callback = callbacks[name];
    if (typeof callback !== 'function') return;
    try {
      callback(...args);
    } catch (error) {
      // UI callbacks must not break signaling or media cleanup.
      console.error(`[Voice] ${name} callback failed`, error);
    }
  }

  function getTransmitting() {
    return serverAllowsTransmission
      && microphoneEnabled
      && Boolean(localStream && localStream.getAudioTracks().length);
  }

  // Remote voice arrives as an HTMLMediaElement, outside the Three.js audio
  // graph the Game volume controls, so its level is the element's own gain.
  // That is playback only: it never touches the track sent to peers.
  function applyVoicePlaybackVolume(audio) {
    const entries = audio
      ? [[audio.dataset.voicePeerId, audio]]
      : Array.from(peers.entries(), ([peerId, entry]) => [peerId, entry.remoteAudio]);
    const gain = volumeLevelToGain(voiceVolumeLevel);
    entries.forEach(([peerId, element]) => {
      if (!element) return;
      try {
        element.volume = mutedPeerIds.has(normalizePlayerId(peerId)) ? 0 : gain;
      } catch {
        // A host may supply a media-element double with a read-only volume.
      }
    });
  }

  // The host calls this whenever its own reason to silence a peer changes --
  // `/silence`/`/unsilence`, or a join that matches an existing rule -- rather
  // than this module knowing anything about callsigns or verification. Safe to
  // call before a peer connection exists: the set is what `createRemoteAudio`
  // and every volume change consult, so a peer that connects after being
  // muted starts silent rather than needing a second pass.
  function setPeerMuted(peerId, muted) {
    const normalized = normalizePlayerId(peerId);
    if (normalized === null) return;
    if (muted) mutedPeerIds.add(normalized); else mutedPeerIds.delete(normalized);
    const entry = peers.get(normalized);
    if (entry) applyVoicePlaybackVolume(entry.remoteAudio);
  }

  // Microphone level is a gain node between capture and the sent track, because
  // getUserMedia has no volume control of its own. Building it always -- rather
  // than only below unity -- keeps one code path, and one GainNode costs
  // nothing next to the encoder already running on that stream.
  function buildMicrophoneGraph(stream) {
    const context = getAudioContext();
    if (!context || typeof context.createMediaStreamSource !== 'function') return null;
    try {
      const source = context.createMediaStreamSource(stream);
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      source.connect(gain);
      gain.connect(destination);
      gain.gain.value = volumeLevelToGain(microphoneVolumeLevel);
      // A context suspended by the browser's autoplay policy would send silence.
      if (context.state === 'suspended') context.resume?.().catch(() => {});
      return { context, source, gain, destination };
    } catch (error) {
      // Without the graph the microphone still works; only its level is fixed.
      console.error('[Voice] Microphone gain unavailable:', error);
      return null;
    }
  }

  function teardownMicrophoneGraph() {
    if (!microphoneGraph) return;
    try {
      microphoneGraph.source.disconnect();
      microphoneGraph.gain.disconnect();
    } catch {
      // Already torn down by a context that closed underneath us.
    }
    microphoneGraph = null;
  }

  // Muting disables the capture track; the graph output track has to follow, or
  // the gain node keeps forwarding a silent-but-live stream to every peer.
  function setMicrophoneTracksEnabled(enabled) {
    [captureStream, localStream].forEach((stream) => {
      stream?.getAudioTracks().forEach((track) => { track.enabled = enabled; });
    });
  }

  function getState() {
    return {
      started,
      localPlayerId,
      team,
      channel,
      canTransmit: serverAllowsTransmission,
      transmitting: getTransmitting(),
      microphoneEnabled,
      microphonePermission,
      inputDeviceId,
      voiceVolumeLevel,
      microphoneVolumeLevel,
      hasLocalStream: Boolean(localStream),
      peerIds: Array.from(peers.keys()),
      rosterIds: Array.from(roster.keys()),
      lastError,
    };
  }

  function emitState() {
    invoke('onStateChange', getState());
  }

  function reportError(error) {
    lastError = {
      code: error && error.code ? error.code : 'voice_error',
      message: error && error.message ? error.message : String(error),
    };
    invoke('onError', error);
    emitState();
  }

  function sendVoiceState() {
    if (!started || closed) return;
    sendToServer({
      type: 'voiceState',
      channel,
      team,
      enabled: getTransmitting(),
      transmitting: getTransmitting(),
    });
  }

  function setRtcConfig(nextConfig = {}) {
    if (!nextConfig || typeof nextConfig !== 'object' || Array.isArray(nextConfig)) return false;
    const nextIceServers = Array.isArray(nextConfig.iceServers)
      ? nextConfig.iceServers
      : [];
    rtcConfig = {
      ...nextConfig,
      iceServers: nextIceServers,
    };

    // A new ICE policy applies to newly-created connections. Recreate current
    // peers so a server-side configuration update cannot leave stale routes.
    const currentRoster = Array.from(roster.entries());
    Array.from(peers.keys()).forEach(closePeer);
    currentRoster.forEach(([peerId, metadata]) => {
      const entry = ensurePeer(peerId, metadata);
      if (entry && shouldInitiateOffer(peerId, metadata)) void createOffer(entry);
    });
    return true;
  }

  function addListener(target, eventName, handler) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(eventName, handler);
    listeners.push({ target, eventName, handler });
  }

  function removeListeners() {
    while (listeners.length > 0) {
      const { target, eventName, handler } = listeners.pop();
      target.removeEventListener(eventName, handler);
    }
  }

  function createRemoteAudio(peerId) {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      return null;
    }
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    audio.setAttribute('aria-hidden', 'true');
    audio.dataset.voicePeerId = peerId;
    audio.style.display = 'none';
    applyVoicePlaybackVolume(audio);
    if (document.body) document.body.appendChild(audio);
    invoke('onRemoteAudio', { peerId, element: audio });
    return audio;
  }

  function removeRemoteAudio(entry) {
    if (!entry.remoteAudio) return;
    try {
      entry.remoteAudio.pause();
    } catch {
      // The element may already be detached by the host application.
    }
    entry.remoteAudio.srcObject = null;
    invoke('onRemoteAudioRemoved', { peerId: entry.peerId, element: entry.remoteAudio });
    if (entry.remoteAudio.parentNode) entry.remoteAudio.parentNode.removeChild(entry.remoteAudio);
    entry.remoteAudio = null;
  }

  function updatePeerState(entry, state = {}) {
    invoke('onPeerChange', {
      peerId: entry.peerId,
      state,
      connection: entry.pc,
    });
  }

  function setTransceiverDirection(entry) {
    if (!entry.transceiver) return;
    try {
      entry.transceiver.direction = 'sendrecv';
    } catch (error) {
      reportError(createVoiceError('voice_direction_failed', `Could not set voice direction for ${entry.peerId}`, error));
    }
  }

  async function replacePeerTrack(entry, track) {
    if (entry.sender && typeof entry.sender.replaceTrack === 'function') {
      try {
        await entry.sender.replaceTrack(track || null);
        setTransceiverDirection(entry);
        return;
      } catch (error) {
        reportError(createVoiceError('voice_track_replace_failed', `Could not update voice track for ${entry.peerId}`, error));
      }
    }

    // Modern browsers use the transceiver sender above. This fallback keeps
    // the manager usable with older WebRTC implementations and test doubles.
    if (track && !entry.sender && entry.pc && typeof entry.pc.addTrack === 'function') {
      try {
        entry.sender = entry.pc.addTrack(track, localStream);
      } catch (error) {
        reportError(createVoiceError('voice_track_add_failed', `Could not add voice track for ${entry.peerId}`, error));
      }
    }
  }

  async function replaceLocalTrack() {
    const track = getTransmitting() ? localStream.getAudioTracks()[0] : null;
    await Promise.all(Array.from(peers.values()).map((entry) => replacePeerTrack(entry, track)));
    emitState();
  }

  function shouldInitiateOffer(peerId) {
    return comparePlayerIds(localPlayerId, peerId) < 0;
  }

  function preferOpusCodec(transceiver) {
    if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return;
    const sender = typeof globalThis !== 'undefined' ? globalThis.RTCRtpSender : null;
    if (!sender || typeof sender.getCapabilities !== 'function') return;
    const capabilities = sender.getCapabilities('audio');
    const codecs = Array.isArray(capabilities?.codecs) ? capabilities.codecs : [];
    const opusCodecs = codecs.filter((codec) => String(codec.mimeType || '').toLowerCase() === 'audio/opus');
    if (opusCodecs.length === 0) return;
    const fallbackCodecs = codecs.filter((codec) => !opusCodecs.includes(codec));
    try {
      transceiver.setCodecPreferences([...opusCodecs, ...fallbackCodecs]);
    } catch (error) {
      console.warn('[Voice] Could not prioritize the native Opus codec.', error);
    }
  }

  function createPeer(peerId, metadata = {}) {
    if (!PeerConnection) {
      reportError(createVoiceError('webrtc_unavailable', 'RTCPeerConnection is not available in this browser.'));
      return null;
    }

    let pc;
    try {
      pc = new PeerConnection(rtcConfig);
    } catch (error) {
      reportError(createVoiceError('peer_create_failed', `Could not create a voice peer for ${peerId}`, error));
      return null;
    }

    const entry = {
      peerId,
      metadata,
      pc,
      sender: null,
      transceiver: null,
      remoteAudio: createRemoteAudio(peerId),
      remoteStream: null,
      pendingCandidates: [],
      makingOffer: false,
      initialOfferSent: false,
      closed: false,
      disconnectedTimer: null,
    };
    peers.set(peerId, entry);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendToServer({
          type: 'voiceIceCandidate',
          channel,
          to: peerId,
          candidate: event.candidate,
        });
      }
    };

    pc.ontrack = (event) => {
      let stream = event.streams && event.streams[0];
      if (!stream && typeof globalThis !== 'undefined' && typeof globalThis.MediaStream === 'function') {
        if (!entry.remoteStream) entry.remoteStream = new globalThis.MediaStream();
        stream = entry.remoteStream;
        if (event.track && typeof stream.addTrack === 'function') stream.addTrack(event.track);
      }
      if (!stream || !entry.remoteAudio) return;
      entry.remoteAudio.srcObject = stream;
      const playPromise = entry.remoteAudio.play && entry.remoteAudio.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((error) => {
          reportError(createVoiceError('remote_audio_playback_failed', `Could not play nearby voice from ${peerId}`, error));
        });
      }
      invoke('onRemoteTrack', { peerId, stream, track: event.track, element: entry.remoteAudio });
    };

    pc.onconnectionstatechange = () => {
      const connectionState = pc.connectionState || pc.iceConnectionState || 'unknown';
      updatePeerState(entry, { connectionState });
      if (entry.disconnectedTimer) {
        clearTimeout(entry.disconnectedTimer);
        entry.disconnectedTimer = null;
      }
      if (connectionState === 'failed' || connectionState === 'closed') {
        closePeer(peerId);
      } else if (connectionState === 'disconnected') {
        entry.disconnectedTimer = setTimeout(() => {
          if (!entry.closed && (pc.connectionState === 'disconnected' || pc.iceConnectionState === 'disconnected')) {
            closePeer(peerId);
          }
        }, 5000);
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      updatePeerState(entry, { iceConnectionState: state });
      if (state === 'failed' || state === 'closed') closePeer(peerId);
    };

    pc.onnegotiationneeded = () => {
      // The lower player ID owns initial offer creation. This deterministic
      // rule avoids both active peers racing to create the first offer.
      if (shouldInitiateOffer(peerId)) void createOffer(entry);
    };

    if (typeof pc.addTransceiver === 'function') {
      try {
        entry.transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
        preferOpusCodec(entry.transceiver);
        entry.sender = entry.transceiver.sender || null;
      } catch (error) {
        reportError(createVoiceError('voice_transceiver_failed', `Could not prepare voice media for ${peerId}`, error));
      }
    } else if (getTransmitting() && localStream && typeof pc.addTrack === 'function') {
      entry.sender = pc.addTrack(localStream.getAudioTracks()[0], localStream);
    }

    updatePeerState(entry, { connectionState: pc.connectionState || 'new' });
    return entry;
  }

  function ensurePeer(peerId, metadata = {}) {
    const normalizedId = normalizePlayerId(peerId);
    if (!normalizedId || normalizedId === localPlayerId) return null;
    const existing = peers.get(normalizedId);
    if (existing) {
      existing.metadata = { ...existing.metadata, ...metadata };
      return existing;
    }
    return createPeer(normalizedId, metadata);
  }

  function closePeer(peerId) {
    const entry = peers.get(peerId);
    if (!entry || entry.closed) return;
    entry.closed = true;
    if (entry.disconnectedTimer) clearTimeout(entry.disconnectedTimer);
    try {
      entry.pc.close();
    } catch {
      // A peer can already be closed by the browser after a network failure.
    }
    removeRemoteAudio(entry);
    peers.delete(peerId);
    invoke('onPeerRemoved', { peerId });
    emitState();
  }

  async function flushCandidates(entry) {
    if (!entry.pc.remoteDescription || typeof entry.pc.addIceCandidate !== 'function') return;
    const pending = entry.pendingCandidates.splice(0);
    for (const candidate of pending) {
      try {
        await entry.pc.addIceCandidate(candidate);
      } catch (error) {
        reportError(createVoiceError('voice_ice_failed', `Could not add an ICE candidate for ${entry.peerId}`, error));
      }
    }
  }

  async function createOffer(entry) {
    if (!entry || entry.closed || entry.makingOffer || !entry.pc || typeof entry.pc.createOffer !== 'function') return;
    if (!shouldInitiateOffer(entry.peerId, entry.metadata)) return;
    if (entry.pc.signalingState && entry.pc.signalingState !== 'stable') return;

    entry.makingOffer = true;
    try {
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      sendToServer({
        type: 'voiceOffer',
        channel,
        to: entry.peerId,
        description: serializeDescription(entry.pc.localDescription || offer),
      });
      entry.initialOfferSent = true;
    } catch (error) {
      reportError(createVoiceError('voice_offer_failed', `Could not create a voice offer for ${entry.peerId}`, error));
    } finally {
      entry.makingOffer = false;
    }
  }

  function extractDescription(message, type) {
    const description = message && (message[type] || message.description || message.sdp);
    if (description && typeof description === 'object') return description;
    if (typeof description === 'string') return { type, sdp: description };
    return null;
  }

  async function handleOffer(message) {
    const peerId = getMessagePeerId(message);
    const offer = extractDescription(message, 'offer');
    if (!peerId || !offer) return;
    const entry = ensurePeer(peerId, message.peer || {});
    if (!entry) return;

    try {
      // A lower-ID peer wins an unexpected offer collision. The normal server
      // flow has only the lower ID initiating, but this keeps reconnects safe.
      if (entry.makingOffer || (entry.pc.signalingState && entry.pc.signalingState !== 'stable')) {
        if (comparePlayerIds(localPlayerId, peerId) < 0) return;
        if (typeof entry.pc.setLocalDescription === 'function') {
          await entry.pc.setLocalDescription({ type: 'rollback' });
        }
      }
      await entry.pc.setRemoteDescription(offer);
      await flushCandidates(entry);
      const answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
      sendToServer({
        type: 'voiceAnswer',
        channel,
        to: peerId,
        description: serializeDescription(entry.pc.localDescription || answer),
      });
      updatePeerState(entry, { signalingState: entry.pc.signalingState });
    } catch (error) {
      reportError(createVoiceError('voice_offer_handling_failed', `Could not handle a voice offer from ${peerId}`, error));
    }
  }

  async function handleAnswer(message) {
    const peerId = getMessagePeerId(message);
    const answer = extractDescription(message, 'answer');
    if (!peerId || !answer) return;
    const entry = peers.get(peerId) || ensurePeer(peerId, message.peer || {});
    if (!entry) return;
    try {
      await entry.pc.setRemoteDescription(answer);
      await flushCandidates(entry);
      updatePeerState(entry, { signalingState: entry.pc.signalingState });
    } catch (error) {
      reportError(createVoiceError('voice_answer_handling_failed', `Could not handle a voice answer from ${peerId}`, error));
    }
  }

  async function handleIceCandidate(message) {
    const peerId = getMessagePeerId(message);
    const candidate = message && (message.candidate ?? message.iceCandidate);
    if (!peerId || candidate === undefined) return;
    const entry = peers.get(peerId) || ensurePeer(peerId, message.peer || {});
    if (!entry) return;
    if (!entry.pc.remoteDescription) {
      entry.pendingCandidates.push(candidate);
      return;
    }
    try {
      await entry.pc.addIceCandidate(candidate);
    } catch (error) {
      reportError(createVoiceError('voice_ice_failed', `Could not add an ICE candidate from ${peerId}`, error));
    }
  }

  function applyRoster(message) {
    const nextRoster = new Map();
    for (const rawItem of getRosterItems(message)) {
      const item = normalizeRosterItem(rawItem);
      if (!item || item.id === localPlayerId) continue;
      nextRoster.set(item.id, item);
    }

    for (const peerId of roster.keys()) {
      if (!nextRoster.has(peerId)) closePeer(peerId);
    }
    roster.clear();
    nextRoster.forEach((item, peerId) => roster.set(peerId, item));

    for (const [peerId, item] of roster) {
      const entry = ensurePeer(peerId, item);
      if (entry && shouldInitiateOffer(peerId, item)) void createOffer(entry);
    }
    invoke('onRosterChange', Array.from(roster.values()));
    emitState();
  }

  function handleVoiceState(message) {
    const peerId = getMessagePeerId(message);
    if (!peerId || peerId === localPlayerId) {
      if (message && message.team !== undefined) {
        const nextTeam = normalizePlayerTeam(message.team);
        if (nextTeam !== team) {
          team = nextTeam;
          void replaceLocalTrack();
        }
      }
      if (message && typeof message.canTransmit === 'boolean') {
        serverAllowsTransmission = message.canTransmit;
        if (!serverAllowsTransmission) {
          microphoneEnabled = false;
          setMicrophoneTracksEnabled(false);
          void replaceLocalTrack();
        }
      }
      emitState();
      return;
    }

    if (message.present === false || message.inRange === false || message.nearby === false) {
      roster.delete(peerId);
      closePeer(peerId);
      invoke('onRosterChange', Array.from(roster.values()));
      return;
    }

    const metadata = { ...message, id: peerId };
    roster.set(peerId, metadata);
    ensurePeer(peerId, metadata);
    emitState();
  }

  async function requestMicrophone({ enable = false } = {}) {
    if (microphoneRequest) return microphoneRequest;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      const error = createVoiceError('microphone_unavailable', 'This browser does not provide microphone capture.');
      microphonePermission = 'unavailable';
      reportError(error);
      return false;
    }

    const audio = { ...audioConstraints };
    if (inputDeviceId) audio.deviceId = { exact: inputDeviceId };

    const requestGeneration = lifecycleGeneration;
    microphoneRequest = navigator.mediaDevices.getUserMedia({ audio })
      .then(async (stream) => {
        if (closed || requestGeneration !== lifecycleGeneration) {
          stream.getTracks().forEach((track) => track.stop());
          return false;
        }
        if (captureStream) captureStream.getTracks().forEach((track) => track.stop());
        teardownMicrophoneGraph();
        captureStream = stream;
        microphonePermission = 'granted';
        const track = stream.getAudioTracks()[0];
        if (!track) {
          captureStream = null;
          localStream = null;
          microphoneEnabled = false;
          const error = createVoiceError('microphone_track_missing', 'The selected input device has no audio track.');
          reportError(error);
          return false;
        }
        microphoneGraph = buildMicrophoneGraph(stream);
        localStream = microphoneGraph ? microphoneGraph.destination.stream : stream;
        track.onended = () => {
          microphoneEnabled = false;
          teardownMicrophoneGraph();
          captureStream = null;
          localStream = null;
          void replaceLocalTrack();
          sendVoiceState();
          emitState();
        };
        microphoneEnabled = Boolean(enable);
        setMicrophoneTracksEnabled(microphoneEnabled);
        await replaceLocalTrack();
        await refreshInputDevices();
        sendVoiceState();
        emitState();
        return true;
      })
      .catch((cause) => {
        const denied = cause && (cause.name === 'NotAllowedError' || cause.name === 'SecurityError');
        microphonePermission = denied ? 'denied' : 'unavailable';
        reportError(createVoiceError(
          denied ? 'microphone_permission_denied' : 'microphone_capture_failed',
          denied ? 'Microphone permission was denied.' : 'Could not start microphone capture.',
          cause,
        ));
        return false;
      })
      .finally(() => {
        microphoneRequest = null;
      });

    return microphoneRequest;
  }

  async function setInputDevice(deviceId) {
    inputDeviceId = normalizeDeviceId(deviceId);
    if (!localStream) {
      emitState();
      return true;
    }
    return requestMicrophone({ enable: microphoneEnabled });
  }

  async function setAudioConstraints(nextConstraints = {}) {
    if (!nextConstraints || typeof nextConstraints !== 'object') return false;
    audioConstraints = {
      ...audioConstraints,
      echoCancellation: nextConstraints.echoCancellation !== false,
      noiseSuppression: nextConstraints.noiseSuppression !== false,
      autoGainControl: nextConstraints.autoGainControl !== false,
    };
    if (!localStream) {
      emitState();
      return true;
    }
    return requestMicrophone({ enable: microphoneEnabled });
  }

  // Switching rooms. The server recomputes the roster and sends a fresh one;
  // applyRoster then closes whatever peer is no longer in it, so there is no
  // separate teardown here. Peers common to both rooms keep their connection.
  function setChannel(nextChannel) {
    const normalized = normalizeVoiceChannel(nextChannel);
    if (normalized === channel) return channel;
    channel = normalized;
    sendVoiceState();
    emitState();
    return channel;
  }

  function setVoiceVolumeLevel(level) {
    voiceVolumeLevel = clampVolumeLevel(level, voiceVolumeLevel);
    applyVoicePlaybackVolume();
    emitState();
    return voiceVolumeLevel;
  }

  function setMicrophoneVolumeLevel(level) {
    microphoneVolumeLevel = clampVolumeLevel(level, microphoneVolumeLevel);
    if (microphoneGraph) microphoneGraph.gain.gain.value = volumeLevelToGain(microphoneVolumeLevel);
    emitState();
    return microphoneVolumeLevel;
  }

  async function toggleMicrophone(forceState) {
    if (!localStream || !localStream.getAudioTracks().length) {
      return requestMicrophone({ enable: forceState === undefined ? true : Boolean(forceState) });
    }
    microphoneEnabled = forceState === undefined ? !microphoneEnabled : Boolean(forceState);
    setMicrophoneTracksEnabled(microphoneEnabled);
    await replaceLocalTrack();
    sendVoiceState();
    emitState();
    return microphoneEnabled;
  }

  async function refreshInputDevices() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
      invoke('onInputDevices', []);
      return [];
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices
        .filter((device) => device.kind === 'audioinput')
        .map((device) => ({
          deviceId: device.deviceId,
          label: device.label || 'Microphone',
          groupId: device.groupId,
        }));
      invoke('onInputDevices', inputs);
      return inputs;
    } catch (error) {
      reportError(createVoiceError('microphone_devices_failed', 'Could not enumerate microphone devices.', error));
      return [];
    }
  }

  async function stopLocalStream({ notify = true } = {}) {
    microphoneEnabled = false;
    teardownMicrophoneGraph();
    if (captureStream) {
      captureStream.getTracks().forEach((track) => track.stop());
      captureStream = null;
    }
    localStream = null;
    await replaceLocalTrack();
    if (notify) sendVoiceState();
    emitState();
  }

  function updateLocalIdentity(identity = {}, nextTeam) {
    const requestedId = typeof identity === 'object' ? identity.localPlayerId ?? identity.playerId : identity;
    const requestedTeam = typeof identity === 'object' ? identity.team : nextTeam;
    const normalizedId = requestedId === undefined ? localPlayerId : normalizePlayerId(requestedId);
    if (normalizedId !== localPlayerId) {
      Array.from(peers.keys()).forEach(closePeer);
      roster.clear();
      localPlayerId = normalizedId;
    }
    if (requestedTeam !== undefined) {
      const next = normalizePlayerTeam(requestedTeam);
      if (next !== team) {
        team = next;
        void replaceLocalTrack();
      }
    }
    sendVoiceState();
    emitState();
    return getState();
  }

  function handleServerMessage(message) {
    if (!message || typeof message.type !== 'string') return false;
    if (message.channel && normalizeVoiceChannel(message.channel) !== channel) return false;
    switch (message.type) {
      case 'voiceRoster':
        applyRoster(message);
        return true;
      case 'voiceState':
        handleVoiceState(message);
        return true;
      case 'voiceOffer':
        void handleOffer(message);
        return true;
      case 'voiceAnswer':
        void handleAnswer(message);
        return true;
      case 'voiceIceCandidate':
        void handleIceCandidate(message);
        return true;
      case 'voicePeerLeft':
        if (getMessagePeerId(message)) {
          const peerId = getMessagePeerId(message);
          roster.delete(peerId);
          closePeer(peerId);
          invoke('onRosterChange', Array.from(roster.values()));
        }
        return true;
      case 'playerLeft':
        if (message.id !== undefined) {
          const peerId = normalizePlayerId(message.id);
          roster.delete(peerId);
          closePeer(peerId);
        }
        return false;
      default:
        return false;
    }
  }

  async function reset() {
    if (closed) return;
    lifecycleGeneration += 1;
    started = false;
    removeListeners();
    Array.from(peers.keys()).forEach(closePeer);
    await stopLocalStream({ notify: false });
    roster.clear();
    microphonePermission = 'prompt';
    microphoneEnabled = false;
    serverAllowsTransmission = true;
    lastError = null;
    emitState();
  }

  async function shutdown() {
    if (closed) return;
    await reset();
    closed = true;
    started = false;
    emitState();
  }

  function start() {
    if (started || closed) return api;
    started = true;
    if (typeof document !== 'undefined') {
      addListener(document, 'visibilitychange', () => {
        if (document.hidden && microphoneEnabled) void toggleMicrophone(false);
      });
    }
    if (typeof window !== 'undefined') {
      addListener(window, 'pagehide', () => { void shutdown(); });
    }
    if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
      addListener(navigator.mediaDevices, 'devicechange', () => { void refreshInputDevices(); });
    }
    sendVoiceState();
    emitState();
    return api;
  }

  const api = {
    start,
    requestMicrophone,
    setInputDevice,
    setAudioConstraints,
    setChannel,
    setVoiceVolumeLevel,
    setMicrophoneVolumeLevel,
    setPeerMuted,
    setRtcConfig,
    toggleMicrophone,
    handleServerMessage,
    updateLocalIdentity,
    updateLocalPlayer: updateLocalIdentity,
    refreshInputDevices,
    shutdown,
    reset,
    getState,
  };

  if (options.autoStart !== false) start();
  return api;
}

export default createVoiceManager;
