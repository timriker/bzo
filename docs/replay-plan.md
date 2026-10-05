# Replaying bzfs recordings -- the plan

Issue #172. What is built is in `docs/replay.md` and is deleted from here.
Upstream references are paths under `$HOME/bzflag/`.

## The ask

bzo should be able to replay bzfs sessions. The client should render them
completely, so the server delivers the file, or a converted file, and the
client views the replay.

Running a replay on the server could add voice chat for multiple viewers, but
might require shutting down the server instance, much as the proxy does today.
A client menu could then show the replays available, and the replays in
progress to join and watch.

Replays should be in bzfs format so they can be shared: bzfs geometry and
bzfs messages.

## The file

`docs/replay.md` describes the format and the reader for it,
`server/bzfs-replay.cjs`.

## What has been tested

On the local bzfs (port 5155):

- An admin observer started recording with `/record file robots1`. Four
  native robots supplied the game: `bzflag -solo 4` under `xvfb-run`, with its
  own `-configdir`. Then `/record stop`. The result was
  `~/.bzf/recordings/robots1`: 91 s, 214 KB, 1004 packets.
- The world decoded with `parseWorldDatabase`.
- All 981 mode 0/1 packets went into `BzfsSession.handleFrame`
  (`server/bzfs-session.cjs`) with no socket, with 0 errors. It rebuilt 6
  players, 650 player updates, shots, 8 kills, scores and flags.
- `bzfs -replay -recdir ~/.bzf/recordings`, then `/replay load robots1` and
  `/replay play`, streamed the game to a `BzfsSession` observer. Loading a file
  whose world differs from the server's kicks everyone with "please rejoin".

## Order

Built so far: reading and writing recordings, the replay room behind
`/?replay=<name>`, the "Watching" scoreboard group, finding replays ("Local
replays" on `/list` and in the View dialog, `/replay list`, the Operator
panel's upload and delete), and recording bzo's own games with `/record`
(`docs/replay.md`). Next, in this order:

1. **Recording's rest:** the debug detail ("Recording").
2. **Sharing:** the "download to share" copy ("Storage").
3. **Chat:** mark live viewers' chat ("Viewers and the scoreboard").
4. **Playback controls:** `/replay play`, `loop`, `pause` and `skip` in a
   room ("Commands").
5. **Native clients:** a native connection moved from bzo's game to a replay
   and back ("Native BzFlag clients").

## Viewers and the scoreboard

`docs/replay.md` has what upstream does and what the room does now, the
"Watching" group included. Still to build:

- **Chat:** mark live viewer chat, so a viewer sharing a recorded name isn't
  mistaken for the recorded player.

## Native BzFlag clients

bzo's native port seats a bzflag client in bzo's own game, with one world
for the connection, and the protocol cannot switch worlds on a connected
client. Upstream's `bzfs -replay` gets around this by removing everyone with
"Please rejoin the replay server" when `/replay load` changes the world.

- **Now:** a recording is a bzfs file, so a native player watches one with a
  stock `bzfs -replay` and `/replay load`. The "download to share" copy is
  that path.
- **Later:** a native connection on bzo's port moved from the game into a
  replay room and back. `/replay load <name>` removes the client with "please
  rejoin", as upstream does, and its next connection is seated in that room
  with the recorded world; leaving the replay brings it back to the game the
  same way. This is what lets the same `/replay` commands a native player
  uses on a `bzfs -replay` server work on bzo.

## Recording

Built (`docs/replay.md`). Left:

- **Debug detail:** optional on save. What each client sent and what only bzo
  has (position corrections, validation rejections), as hidden packets
  (mode 3), which replay ignores, so the file stays a valid recording. A plain
  bzo JSON dump of the buffer is the other option, if hidden packets turn out
  awkward to read back.
- **`/record file` to disk as it goes,** rather than out of the buffer at
  `/record stop`, for a recording longer than the buffer.
- **Snapshot size:** a snapshot's flag state is most of the buffer and of the
  file on a map with many flags; one that only says what changed would be
  smaller, though bzfs writes them whole.

## Commands

Upstream's slash commands, so a native client's player and a browser's do a
match and record it the same way (`src/bzfs/commands.cxx:3594`). `/record`,
`/record list`, `/replay stats` and `/replay list` are built
(`docs/replay.md`). Left:

- `/replay load <filename|#index>`, `play`, `loop`, `pause`,
  `skip [+/-seconds]`: needing REPLAY, which is bzo's operators. In a shared
  room these move everyone watching, as on upstream's replay server, which is
  why they are gated. Until then a room answers them with upstream's usage.

## Storage

`docs/replay.md` has the directory, uploads and deletes. What is left is
sharing, and it rests on a raw recording being private: its hidden packets
(mode 3) hold more than private chat:

- every `/` command typed (`bzfs.cxx:1530`);
- server messages addressed to one player (`bzfs.cxx:1768`);
- `MsgAdminInfo`, which carries players' IP addresses (`bzfs.cxx:640`).

`/password` is not stored. A browser gets only the played-back packets
(modes 0 and 1), through the room, and the file itself is never served.

- **Sharing:** a "download to share" button writes a clean copy without the
  hidden packets (`writeReplay` with them filtered out, which rewrites the
  file positions). It is still a valid recording, and the way a native player
  watches one (`bzfs -replay`).

## Open questions

- Whether a viewer may start a replay of their own rather than join the
  shared one, so `/replay skip` moves only them, or must ask an operator.
- XR: the replay room needs the same view and follow controls as a proxied
  match.
