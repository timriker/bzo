#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Covers the two voice levels and where a voice is heard from: remote
// playback, which starts on the media element and moves onto a panner once the
// graph is proven to carry the peer's audio, and the microphone, which is a
// gain node spliced between capture and the track sent to peers.

import assert from 'node:assert/strict';
import { volumeLevelToGain } from '../public/volume.mjs';
import {
  VOICE_DISTANCE_MODEL,
  VOICE_PANNING_MODEL,
  VOICE_REF_DISTANCE,
  VOICE_ROLLOFF_FACTOR,
} from '../public/audio.js';
import { createVoiceManager } from '../public/voice.js';

const audios = [];
const body = {
  appendChild(audio) {
    audio.parentNode = body;
    audios.push(audio);
  },
  removeChild(audio) {
    const index = audios.indexOf(audio);
    if (index >= 0) audios.splice(index, 1);
    audio.parentNode = null;
  },
};

globalThis.document = {
  body,
  createElement(tagName) {
    assert.equal(tagName, 'audio');
    return {
      autoplay: false,
      playsInline: false,
      volume: 1,
      dataset: {},
      style: {},
      parentNode: null,
      srcObject: null,
      setAttribute() {},
      pause() {},
      play: () => Promise.resolve(),
    };
  },
};

class FakePeerConnection {
  connectionState = 'new';
  iceConnectionState = 'new';

  addTransceiver() {
    return { sender: { replaceTrack: async () => {} }, setCodecPreferences() {} };
  }

  close() {}
}

function makeTrack(label) {
  return { kind: 'audio', label, enabled: true, stopped: false, stop() { this.stopped = true; } };
}

function makeStream(track) {
  return { getTracks: () => [track], getAudioTracks: () => [track] };
}

const captureTrack = makeTrack('capture');
const captureStream = makeStream(captureTrack);
const sentTrack = makeTrack('sent');

const gainNode = { gain: { value: 1 }, connect() {}, disconnect() {} };
const audioContext = {
  state: 'running',
  createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
  createGain: () => gainNode,
  createMediaStreamDestination: () => ({ stream: makeStream(sentTrack) }),
};

// Node 21 added a built-in `navigator`, defined as a getter, so assigning to it
// throws on 24 while working fine on 18. defineProperty replaces it on both --
// the property is configurable either way, and absent entirely on 18. `document`
// above needs no such care: Node has never had one.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: {
    mediaDevices: {
      getUserMedia: async () => captureStream,
      enumerateDevices: async () => [],
      addEventListener() {},
      removeEventListener() {},
    },
  },
});

const manager = createVoiceManager({
  autoStart: false,
  localPlayerId: '1',
  team: 'rogue',
  voiceVolumeLevel: 5,
  microphoneVolumeLevel: 4,
  getAudioContext: () => audioContext,
  RTCPeerConnection: FakePeerConnection,
});

// A remote peer's element opens at the stored playback level, not at full.
assert.equal(manager.handleServerMessage({
  type: 'voiceRoster',
  peers: [{ id: '2', team: 'rogue' }],
}), true);
assert.equal(audios.length, 1);
assert.equal(audios[0].volume, volumeLevelToGain(5));

assert.equal(manager.setVoiceVolumeLevel(8), 8);
assert.equal(audios[0].volume, volumeLevelToGain(8));
assert.equal(manager.setVoiceVolumeLevel(99), 10);
assert.equal(audios[0].volume, 1);
assert.equal(manager.setVoiceVolumeLevel(-1), 0);
assert.equal(audios[0].volume, 0);
assert.equal(manager.getState().voiceVolumeLevel, 0);

// Playback level must never reach the microphone.
assert.equal(captureTrack.enabled, true);

assert.equal(await manager.requestMicrophone({ enable: true }), true);
assert.equal(gainNode.gain.value, volumeLevelToGain(4));
assert.equal(manager.setMicrophoneVolumeLevel(9), 9);
assert.equal(gainNode.gain.value, volumeLevelToGain(9));
assert.equal(manager.getState().microphoneVolumeLevel, 9);

// /silence's own half of playback: a muted peer stays silent regardless of
// the shared volume level, and unmuting returns it to that level rather than
// to full.
manager.setPeerMuted('2', true);
assert.equal(audios[0].volume, 0);
assert.equal(manager.setVoiceVolumeLevel(6), 6);
assert.equal(audios[0].volume, 0);
manager.setPeerMuted('2', false);
assert.equal(audios[0].volume, volumeLevelToGain(6));

// Muting an id before its peer connection exists has to stick: the host
// silences by callsign or verification, which it can know about well before
// signaling ever reaches that id.
manager.setPeerMuted('3', true);
assert.equal(manager.handleServerMessage({
  type: 'voiceRoster',
  peers: [{ id: '2', team: 'rogue' }, { id: '3', team: 'rogue' }],
}), true);
assert.equal(audios.length, 2);
const preMuted = audios.find((audio) => audio.dataset.voicePeerId === '3');
assert.equal(preMuted.volume, 0);
manager.setPeerMuted('3', false);
assert.equal(preMuted.volume, volumeLevelToGain(6));

// Muting has to reach both ends of the gain stage: a live output track would
// keep forwarding the gain node's silence to every peer.
await manager.toggleMicrophone(false);
assert.equal(captureTrack.enabled, false);
assert.equal(sentTrack.enabled, false);
await manager.toggleMicrophone(true);
assert.equal(captureTrack.enabled, true);
assert.equal(sentTrack.enabled, true);

// Shutdown stops the hardware capture, not just the graph output.
await manager.shutdown();
assert.equal(captureTrack.stopped, true);
assert.equal(audios.length, 0);

console.log('voice volume tests passed');

// ---------------------------------------------------------------------------
// Placement: a peer's voice moves from the <audio> element onto the panner,
// but only once the graph has been proven to carry their audio. A browser that
// cannot route a WebRTC track into Web Audio reads as one that never proves
// it, and must keep playing them on the element instead of going silent.

const spatialAudios = [];
globalThis.document.createElement = () => {
  const element = {
    autoplay: false,
    playsInline: false,
    volume: 1,
    dataset: {},
    style: {},
    parentNode: null,
    srcObject: null,
    setAttribute() {},
    pause() {},
    play: () => Promise.resolve(),
  };
  spatialAudios.push(element);
  return element;
};

let analyserSample = 128; // 128 is the zero line of time-domain byte data.
const createdGains = [];
let createdPanner = null;

const spatialContext = {
  state: 'running',
  currentTime: 0,
  destination: { name: 'destination' },
  createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
  createGain() {
    const node = {
      gain: {
        value: 1,
        setTargetAtTime(value) { this.value = value; },
      },
      connect() {},
      disconnect() {},
    };
    createdGains.push(node);
    return node;
  },
  createAnalyser: () => ({
    fftSize: 512,
    smoothingTimeConstant: 0,
    connect() {},
    disconnect() {},
    getByteTimeDomainData(data) { data.fill(analyserSample); },
  }),
  createPanner() {
    createdPanner = {
      panningModel: '',
      distanceModel: '',
      refDistance: 0,
      rolloffFactor: 0,
      positionX: { value: 0 },
      positionY: { value: 0 },
      positionZ: { value: 0 },
      connect() {},
      disconnect() {},
    };
    return createdPanner;
  },
  createMediaStreamDestination: () => ({ stream: makeStream(makeTrack('sent2')) }),
};

const connections = [];
class TrackedPeerConnection extends FakePeerConnection {
  constructor() {
    super();
    connections.push(this);
  }
}

const spatial = createVoiceManager({
  autoStart: false,
  localPlayerId: '1',
  team: 'rogue',
  voiceVolumeLevel: 7,
  getAudioContext: () => spatialContext,
  RTCPeerConnection: TrackedPeerConnection,
});

assert.equal(spatial.handleServerMessage({
  type: 'voiceRoster',
  peers: [{ id: '9', team: 'rogue' }],
}), true);
const peerElement = spatialAudios.find((element) => element.dataset.voicePeerId === '9');
assert.ok(peerElement);
assert.equal(connections.length, 1);

// No track yet: the element is the only stage there is.
assert.equal(peerElement.volume, volumeLevelToGain(7));
assert.equal(createdPanner, null);

connections[0].ontrack({ streams: [makeStream(makeTrack('remote'))], track: makeTrack('remote') });

// The panner is built and configured, and is silent until it is proven.
assert.ok(createdPanner);
assert.equal(createdPanner.panningModel, VOICE_PANNING_MODEL);
assert.equal(createdPanner.distanceModel, VOICE_DISTANCE_MODEL);
assert.equal(createdPanner.refDistance, VOICE_REF_DISTANCE);
assert.equal(createdPanner.rolloffFactor, VOICE_ROLLOFF_FACTOR);
const peerGain = createdGains[createdGains.length - 1];
assert.equal(peerGain.gain.value, 0);
assert.equal(peerElement.volume, volumeLevelToGain(7));

// The host places the voice in world coordinates.
assert.equal(spatial.setPeerPosition('9', { x: 12, y: 3, z: -40 }), true);
assert.equal(createdPanner.positionX.value, 12);
assert.equal(createdPanner.positionY.value, 3);
assert.equal(createdPanner.positionZ.value, -40);
assert.equal(spatial.setPeerPosition('9', { x: NaN, y: 0, z: 0 }), false);
assert.equal(createdPanner.positionX.value, 12);
assert.equal(spatial.setPeerPosition('404', { x: 1, y: 1, z: 1 }), false);

spatial.start();
const pollTwice = () => new Promise((resolve) => setTimeout(resolve, 450));

// Digital silence proves nothing: a graph that carries no audio is exactly
// what a browser that cannot route the track looks like.
await pollTwice();
assert.equal(peerGain.gain.value, 0);
assert.equal(peerElement.volume, volumeLevelToGain(7));

// The first real sample hands playback over, for good.
analyserSample = 200;
await pollTwice();
assert.equal(peerGain.gain.value, volumeLevelToGain(7));
assert.equal(peerElement.volume, 0);

// Both /silence and the volume slider now reach the gain node instead, and
// the element stays out of it.
spatial.setPeerMuted('9', true);
assert.equal(peerGain.gain.value, 0);
assert.equal(peerElement.volume, 0);
spatial.setPeerMuted('9', false);
assert.equal(peerGain.gain.value, volumeLevelToGain(7));
assert.equal(spatial.setVoiceVolumeLevel(3), 3);
assert.equal(peerGain.gain.value, volumeLevelToGain(3));
assert.equal(peerElement.volume, 0);

await spatial.shutdown();

console.log('voice placement tests passed');
