#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Covers the two voice levels: remote playback, which is the media element's
// own gain, and the microphone, which is a gain node spliced between capture
// and the track sent to peers.

import assert from 'node:assert/strict';
import { volumeLevelToGain } from '../public/volume.mjs';
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
