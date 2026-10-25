# Video

Plan for issue #188: a player's camera, shown to the players they talk to.
Nothing here is built. Upstream has no voice or video; this is one of the
places bzo is a web game first.

## What is there to build on

Voice (`public/js/voice.js`) is peer to peer: each browser holds one WebRTC
connection to every player in its voice channel (`public/js/voice-channels.mjs`:
All, Nearby, Team), signalled over the WebSocket, with no server in the
media path. Phones relay through the IPv4 TURN servers
(`voiceIceServersIpv4`). Who is talking is read off each incoming track's
level. Video is one more track on the same connections.

## What it costs

- **Upload.** A sender sends a copy to every viewer. Voice is about 30 kbps
  a copy; a small video is 100-300 kbps, so eight viewers is 1-2 Mbps up
  from a phone.
- **The relay.** Every phone's media goes through the TURN server, so video
  multiplies what the operator's coturn carries.
- **Decoding.** Each stream on screen is decoded; the Orin runs out of one
  core already. One stream at a time keeps it cheap.

## Step 1: the speaker's picture

- **A camera button** beside the mic button, off until pressed, each
  session. Pressing it is the only way a camera opens; nothing asks for it
  at join.
- **Sent only while talking.** A sender's own level decides when its track
  is live; a silent player sends nothing. In practice one or two streams at
  a time.
- **Small:** 160x120, about 12 frames a second, about 100 kbps.
- **To the voice channel only:** whoever hears the voice sees the video.
- **One tile:** the current speaker's picture over the scoreboard, and on
  the headset's panel in XR.
- **Saying no:** per-player video mute next to the voice mute, and
  `"video": false` in `server.json` to turn it off for the server, which
  also hides the button.
- **Never recorded:** replays carry game messages only, and video stays out
  of them.

## Step 2: over the tank

- **A billboard** above each tank whose player has video: a video texture
  while it plays, and **the last frame it showed** while it does not, so a
  player who has spoken once keeps a face without a stream.
- **Shown as the name label is:** not over a Cloaked tank, not where the
  label is hidden, so the picture never says where a tank is that the game
  does not.
- **Small and capped:** a still costs nothing to draw; only the tanks
  actually streaming are decoded.

## Later, if it is used

- **A forwarding server (SFU).** With a sender uploading once to the server
  and the server fanning out, a phone's upload stops growing with the room.
  werift already runs on the BZFlag port and could forward; its CPU cost per
  stream is the thing to measure first.
- **Lower frame rate for the far ones**, or stills only beyond Nearby.

## Questions

- Default for incoming video: shown, or off until a player opts in to
  seeing it as well as sending it?
- Whether a phone on a cellular network sends at all, or only on Wi-Fi.
