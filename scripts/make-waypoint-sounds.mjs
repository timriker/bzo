#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Writes the waypoint's two sounds, synthesized here rather than recorded, in
// the format every other game sample is in (16-bit stereo PCM, 22050 Hz):
//
//   public/audio/waypoint_ping.wav    a soft bell, sounded at the waypoint
//   public/audio/waypoint_arrive.wav  "dee-deep", rising, on reaching it
//
// Both peak well under a shot (fire.wav peaks near full scale): they are a
// guide, heard over the game rather than through it.
//
//   node scripts/make-waypoint-sounds.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 22050;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A struck tone: a few milliseconds of rise, then an exponential fade, with a
// faint octave above for a bell's edge.
function tone(seconds, frequency, peak, decay) {
  const count = Math.round(seconds * RATE);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const t = i / RATE;
    const rise = Math.min(1, t / 0.006);
    const envelope = rise * Math.exp(-t * decay);
    const wave = Math.sin(2 * Math.PI * frequency * t) + (0.18 * Math.sin(4 * Math.PI * frequency * t));
    samples[i] = peak * envelope * (wave / 1.18);
  }
  return samples;
}

const silence = (seconds) => new Float32Array(Math.round(seconds * RATE));
const join = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

function writeWav(file, samples) {
  const data = Buffer.alloc(samples.length * 4);
  samples.forEach((v, i) => {
    const s = Math.max(-1, Math.min(1, v));
    const value = Math.round(s * 32767);
    data.writeInt16LE(value, i * 4);
    data.writeInt16LE(value, (i * 4) + 2);
  });
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(path.join(root, 'public', 'audio', file), Buffer.concat([header, data]));
}

writeWav('waypoint_ping.wav', tone(0.35, 1318.5, 0.28, 14));
writeWav('waypoint_arrive.wav', join(
  tone(0.12, 784, 0.32, 18),
  silence(0.03),
  tone(0.3, 1175, 0.32, 9),
));
console.log('wrote public/audio/waypoint_ping.wav and waypoint_arrive.wav');
