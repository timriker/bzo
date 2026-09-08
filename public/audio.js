/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// audio.js - Gameplay sound manifest and loading.
//
// Samples come from upstream BZFlag (bzflag/data/*.wav) so bzo sounds like the
// game it mirrors. The `sfx` column below is BZFlag's sound code from
// src/bzflag/sound.h, resolved through the soundFiles[] table in
// src/bzflag/sound.cxx.
//
// Both the server and the client ship from this repo, so these files are always
// present. Do not add fallbacks for missing audio -- a failed load is a broken
// build and should surface as an error.

export const AUDIO_BASE_PATH = '/audio';

// BZFlag's attenuation, from getWorldStuff()/recalcEventDistance() in
// src/bzflag/sound.cxx:
//
//   minEventDist = 20.0f * 4.32f            // 20 tank radii = 86.4
//   amplitude = (d < minEventDist) ? 1.0f : minEventDist / d
//
// That is inverse-distance rolloff with a rolloff factor of 1, clamped to full
// volume inside the reference distance -- exactly the Web Audio "inverse"
// distance model. bzo's world is 1:1 with BZFlag's (both 800 units across), so
// the constant transfers unchanged. Note it is deliberately BZFlag's tank
// radius of 4.32 and not bzo's 2: the figure scales with the world, not with
// the vehicle, so a shot 200 units away sounds the same in both games.
export const SOUND_REF_DISTANCE = 20 * 4.32;
export const SOUND_ROLLOFF_FACTOR = 1;
export const SOUND_DISTANCE_MODEL = 'inverse';

// BZFlag has no per-sound volume. Every sample plays at its recorded level,
// scaled only by the global setting (volumeAtten in sound.cxx) and by distance.
// The samples are pre-mixed relative to each other, so adding per-sound gain
// here would undo that balance. The player's Game volume is applied once, to
// the AudioListener's master gain; this is the per-sound level underneath it.
export const MASTER_VOLUME = 1;

export const GAME_SOUNDS = Object.freeze({
  // A shot is fired.
  fire: { file: 'fire.wav', sfx: 'SFX_FIRE' },
  // A shot expires or hits an obstacle.
  shotBoom: { file: 'boom.wav', sfx: 'SFX_SHOT_BOOM' },
  // A laser is fired. Upstream picks the firing sound off the flag rather than
  // playing SFX_FIRE for everything (playing.cxx:2956); Laser is the first flag
  // bzo has that does.
  laser: { file: 'laser.wav', sfx: 'SFX_LASER' },
  // A shock wave is fired. The wave itself makes no other sound: it fades when
  // it reaches full size rather than ending on anything.
  shock: { file: 'shock.wav', sfx: 'SFX_SHOCK' },
  // A guided missile is fired.
  missile: { file: 'missile.wav', sfx: 'SFX_MISSILE' },
  // A guided missile has locked onto *me*. The one shot sound played for the
  // tank being shot at rather than for the tank shooting: upstream plays it when
  // a MsgGMUpdate naming you arrives (playing.cxx:3537), which is a missile
  // already in the air, not somebody's finger on the lock button.
  lock: { file: 'lock.wav', sfx: 'SFX_LOCK' },
  // A shot bounces off a building.
  ricochet: { file: 'ricochet.wav', sfx: 'SFX_RICOCHET' },
  // A team message arrives. Upstream's own trigger: only when somebody else sent
  // it, and at most once every two seconds (playing.cxx:3296).
  messageTeam: { file: 'message_team.wav', sfx: 'SFX_MESSAGE_TEAM' },
  // A tank is destroyed.
  explosion: { file: 'explosion.wav', sfx: 'SFX_EXPLOSION' },
  // A tank is run over by a Steamroller. Upstream plays this in place of the
  // explosion rather than on top of it (playing.cxx:3933), so a squish sounds
  // like a squish and nothing else.
  runOver: { file: 'steamroller.wav', sfx: 'SFX_RUNOVER' },
  // A tank jumps.
  jump: { file: 'jump.wav', sfx: 'SFX_JUMP' },
  // A tank flaps its Wings. Upstream tells the other clients about this one
  // explicitly, through PlayerState::WingsSound; bzo already knows who is
  // carrying what, so the flag answers instead.
  flap: { file: 'flap.wav', sfx: 'SFX_FLAP' },
  // A tank lands.
  land: { file: 'land.wav', sfx: 'SFX_LAND' },
  // A tank passes through a teleporter.
  teleport: { file: 'teleport.wav', sfx: 'SFX_TELEPORT' },
  // A tank appears. BZFlag's SFX_POP is the tank-appeared sound.
  pop: { file: 'pop.wav', sfx: 'SFX_POP' },
  // A flag is picked up. BZFlag plays the same sample for a bad flag through
  // SFX_GRAB_BAD, so there is one entry rather than two.
  flagGrab: { file: 'flag_grab.wav', sfx: 'SFX_GRAB_FLAG' },
  // A flag is dropped.
  flagDrop: { file: 'flag_drop.wav', sfx: 'SFX_DROP_FLAG' },
  // My team captured an enemy team's flag.
  flagWon: { file: 'flag_won.wav', sfx: 'SFX_CAPTURE' },
  // My team's flag was captured.
  flagLost: { file: 'flag_lost.wav', sfx: 'SFX_LOSE' },
  // An enemy picked up my team's flag.
  flagAlert: { file: 'flag_alert.wav', sfx: 'SFX_ALERT' },
  // A team mate picked up an enemy team's flag. The one flag sound BZFlag plays
  // positionally rather than in the ear.
  teamGrab: { file: 'teamgrab.wav', sfx: 'SFX_TEAMGRAB' },
  // I captured my own team's flag.
  killTeam: { file: 'killteam.wav', sfx: 'SFX_KILL_TEAM' },
});

export const GAME_SOUND_NAMES = Object.freeze(Object.keys(GAME_SOUNDS));

export function getSoundPath(name) {
  const sound = GAME_SOUNDS[name];
  if (!sound) throw new Error(`Unknown sound "${name}"`);
  return `${AUDIO_BASE_PATH}/${sound.file}`;
}

export function getSoundPaths() {
  return GAME_SOUND_NAMES.map(getSoundPath);
}

export async function loadAudioBuffer(audioContext, url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to load audio buffer from ${url}: ${response.status}`);
  }
  const audioData = await response.arrayBuffer();
  return await audioContext.decodeAudioData(audioData);
}
