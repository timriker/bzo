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

// Voice is placed in the world the gameplay sounds are already placed in, so a
// player heard over voice comes from where their tank is standing. The numbers
// are a voice's, not a shot's: a talking tank is audible well past the 86.4 a
// shot carries, and a voice that faded on the same curve would be inaudible
// across a street.
//
// Only the Nearby channel is placed at the speaker's real distance -- All and
// Team reach across the whole map, so `voiceChannelUsesDistance` puts those
// peers on the bearing to the speaker at exactly VOICE_REF_DISTANCE, where the
// inverse model is still unity. One panner configuration then covers all three
// channels: the distance the caller supplies is the whole difference.
export const VOICE_REF_DISTANCE = 10;
export const VOICE_ROLLOFF_FACTOR = 1;
export const VOICE_DISTANCE_MODEL = 'inverse';
// The same model three.js gives every PositionalAudio, and for the same
// reason: equalpower is a left/right pan and nothing more, so a voice directly
// behind would read as one directly ahead -- which is the case the issue
// asking for this is really about.
export const VOICE_PANNING_MODEL = 'HRTF';

// Game sound ducks while somebody is talking. -6 dB is enough to hear a voice
// over a firefight without the game going quiet, and the hold keeps the gain
// from pumping between words: speaking is sampled every 200 ms, so anything
// shorter would flap on the gaps inside a sentence.
export const VOICE_DUCK_GAIN = 0.5;
export const VOICE_DUCK_HOLD_MS = 600;

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
  // A Thief's beam is fired. It is played for the shot rather than for the
  // theft: upstream has no sound for a flag changing hands, and the shot is
  // fired far more often than it hits anything.
  thief: { file: 'thief.wav', sfx: 'SFX_THIEF' },
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
  // A direct message arrives, addressed to me by somebody who is not me
  // (playing.cxx:3261). Upstream also refuses it for a message from the server
  // unless `beepOnServerMsg` is set, which is one of the settings bzo does not
  // ship -- so a server message is silent here, which is its default there.
  messagePrivate: { file: 'message_private.wav', sfx: 'SFX_MESSAGE_PRIVATE' },
  // A message on the admin channel arrives, from somebody rather than from the
  // server (playing.cxx:3279).
  messageAdmin: { file: 'message_admin.wav', sfx: 'SFX_MESSAGE_ADMIN' },
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
  // A tank is standing on a face whose physics driver pushes upward -- a jump
  // pad. Upstream sounds this in place of the landing sound rather than on top
  // of it, and ahead of the burrow sound in the same else-chain
  // (LocalPlayer.cxx:803-816), so a tank thrown off a pad rings once. Its
  // remote half, `PlayerState::BounceSound` (Player.cxx:1386), has nothing to
  // attach to here: bzo tracks which face is under the local tank, not which
  // is under everyone else's, so only the tank that bounced hears it.
  bounce: { file: 'bounce.wav', sfx: 'SFX_BOUNCE' },
  // A tank passes through a teleporter.
  teleport: { file: 'teleport.wav', sfx: 'SFX_TELEPORT' },
  // A tank digs itself in. Upstream plays this the frame a Burrow tank crosses
  // from ground level to below it (LocalPlayer.cxx:808), in place of the landing
  // sound -- and its remote counterpart admits it "probably never gets played",
  // because a remote tank's dead reckoning rarely reports the crossing frame.
  // bzo plays it for the tank that burrowed, which is the one that hears it.
  burrow: { file: 'burrow.wav', sfx: 'SFX_BURROW' },
  // A Phantom Zone tank crosses a teleporter, which zones it rather than moving
  // it. Upstream plays this instead of SFX_TELEPORT (LocalPlayer.cxx:734), so
  // the two are never heard together.
  phantom: { file: 'phantom.wav', sfx: 'SFX_PHANTOM' },
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
  // Every step of a hunt that is not its first or its last: moving a target on
  // or off the hunted set, opening and closing the scoreboard cursor, and
  // Rabbit Chase's own anointing (playing.cxx:2878), which upstream treats as
  // one more hunt selection.
  huntSelect: { file: 'hunt_select.wav', sfx: 'SFX_HUNT_SELECT' },
  // Hunting begins or ends: the first target marked, the last one gone, and
  // hunting turned off. It is also the bearing itself -- while a hunted tank is
  // in your sights it pings once a second, positioned at that tank, which is
  // the one thing in bzo that says which way to drive with a sound alone.
  hunt: { file: 'hunt.wav', sfx: 'SFX_HUNT' },
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

// A plain fetch, because the service worker is what decides how fresh a sound
// has to be: `/audio/` is served cache-first out of a cache keyed to the build,
// and a miss there revalidates. A `no-store` fetch would be kept out of the HTTP
// cache as well, leaving that revalidation nothing to validate against -- the
// first load the worker controls would re-download every sound in full.
export async function loadAudioBuffer(audioContext, url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load audio buffer from ${url}: ${response.status}`);
  }
  const audioData = await response.arrayBuffer();
  return await audioContext.decodeAudioData(audioData);
}
