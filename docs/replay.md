# bzfs recordings

What bzo supports for bzfs recordings (`/record`). `docs/replay-plan.md` is
what is still unbuilt; issue #172. Upstream references are paths under
`$HOME/bzflag/`.

## Reading and writing

`server/bzfs-replay.cjs` reads a whole recording into memory
(`readReplay`) and writes one back (`writeReplay`). It does not play one.
Each packet is a bzfs message exactly as it was broadcast, and
`BzfsSession.handleFrame` (`server/bzfs-session.cjs`) is what decodes those.
The world is `MsgGetWorld`'s database, which `parseWorldDatabase`
(`server/remote-world-import.cjs`) reads.

- `snapshots` lists the index of every update marker. `snapshotAt(replay,
  time)` is the one to restore from for a join or a seek.
- `writeReplay` works out each packet's file positions itself, so it can
  write any subset of a read file: a copy without the hidden packets is still
  a valid recording.
- Rewriting a file reproduces every byte except the 8 stuffing bytes per
  packet, which bzfs leaves uninitialised.

`replays/hix-robots.rec` is a sample: 91 s of four `bzflag -solo` robots on
`maps/hix.bzw`, recorded on bzfs 2.4.30 by an observer with `/record file`.
Every address in it is 127.0.0.1.

`npm run test:bzfs-replay` reads the sample, and also builds its own recording
from `NativeTranslator` packets to check what the sample does not exercise.
Pass it a file to read a real recording:

```
node scripts/test-bzfs-replay.mjs ~/.bzf/recordings/<name>
```

## Watching a replay

`/?replay=<name>` plays `replays/<name>.rec` to everyone who opens it, on one
clock per file. Anyone may watch; nobody plays. The room
(`server/bzfs-replay-room.cjs`) gives each browser a `ReplaySession`, a
`BzfsSession` that never dials, and feeds it the packets bzfs would have sent.
`handleProxyConnection` in `server.js` then runs as it does for `?proxy=`, so
every translation a proxied match gets, a replay gets: the browser
dead-reckons tanks between recorded updates as it does for any proxied tank,
since bzfs only relayed what the clients sent.

- **World:** the recording's own, written as
  `maps/import-replay-<world hash>.bzw` and registered like an import. Two
  recordings of one map share it. Both sweeps keep it while a room plays it,
  and remove it an hour after the last viewer leaves; the next viewer has it
  rebuilt from the recording. It is not listed under Local maps.
- **Viewers:** ids from 200, as upstream's replay observers
  (`ReplayObservers`, 16 of them), so a recorded id never collides with a
  live one. A viewer may share a recorded player's callsign, as upstream
  allows: callsigns are checked only against live connections.
- **Scoreboard:** the recorded players with their recorded scores, then the
  recording's own observers, then the live viewers under a "Watching"
  heading, on the flat board and the headset's panel alike. A viewer's
  record carries `watching: true` (`ReplaySession`, `proxyPlayerRecord`);
  upstream lists viewers among the observers, unmarked.
- **Joining:** the first viewer starts the clock with the opening snapshot in
  its `init`. A later one gets the latest snapshot and the real packets since
  it at once, where upstream makes it wait for the next snapshot. Recorded
  chat from before the join is left out.
- **Chat:** a viewer's chat reaches the other viewers, alongside the recorded
  chat. `/replay stats` answers as upstream's does (`Replay::sendStats`):
  the file, the recorded date, percent and seconds played. Any other command
  is refused.
- **End:** "End of replay <name>", then after 10 s every recorded player
  leaves and it plays again from the start.
- **Last viewer out:** the room closes; the next viewer starts it again.

No on-screen timer: upstream shows none either. A recorded game with a time
limit plays its own countdown back, since its clock updates are in the file.

## Finding replays

A replay is local to the instance that holds it; instances do not share
replay files through the list server.

- **`/list`:** "Local replays", after "Local maps", in the same layout. A row
  is the date (UTC, the first packet's time), length, players, file name and
  map; the pane adds the map picture, each player's final score and team,
  observers, who recorded it, the bzfs version, the file size, and how many
  are watching now. Watch opens `/?replay=<name>`; View map opens the local
  map where there is one.
- **View dialog:** a "Local replays" table after "Local maps", from
  `GET /api/replays`, fetched over HTTP since a proxied or replay connection
  answers only what its target would. A row is the way in.
- **`/replay list [-t | -n | --] [pattern]`:** in a room, worded as upstream's
  (`Replay::sendFileList`), for operators: upstream's REPLAY permission. The
  rest of `/replay` answers with upstream's usage until it is built.
- **Summaries** (`summarizeReplay`): the recording played through a session at
  once, cached per file by modification time and size. A player who left
  early keeps the score they left with. A file that is not a recording is
  listed with the reason.
- **Map name:** the local map whose world bzfs would hash the same. The map
  worker computes each map's bzfs hash (`bzfsWorldHashOfBzw`,
  `server/bzflag-world.cjs`) and the map index keeps it; the live map's is its
  file's, not the world bzo serves native clients, which adds compass
  letters. Failing a local map, a server last seen running that world
  (`serversWithWorld`).
- **Picture:** `/overviews/bzfs-<hash>.svg` where this server has drawn that
  world, else the replay world's own once a room has registered it.

## Uploading and deleting

The Operator panel's "Upload Replay" takes a `.rec`, sent base64 over the
socket, read as a recording before it is kept, up to 32 MB, into the runtime
`replays/` (`REPLAYS_PATH`, else beside `server.json`). "Delete Upload"
offers only what the panel uploaded, maps and replays alike, as recorded in
`uploads.json` beside `server.json` (`server/uploads.cjs`): by default the
runtime directories are the bundled ones, so a file's place does not say
whether it shipped with bzo. It refuses the map being played and a replay
being watched, and takes two presses.

## Recording bzo's own games

bzo records the way upstream's `-recbuf` does, from boot: everything it
broadcasts goes into a buffer (`server/bzo-recorder.cjs`), kept as the JSON
every client was sent, with a snapshot of the game every 10 s. Nothing is
converted as the game runs. Saving runs a slice of the buffer through
`NativeTranslator` (`server/bzflag-native.cjs`), which already speaks bzfs to
native clients, and writes a recording to the runtime `replays/` that bzo and
`bzfs -replay` both play. A saved file counts as an upload, so the Operator
panel can delete it.

- **What goes in:** what `broadcast`, `broadcastAll` and
  `broadcastPlayerRecord` (everyone's view) send. Private and team chat do
  not, as upstream keeps them out of playback, and no address does at all.
- **Captured on the way in:** what converting later needs that the game will
  have forgotten -- the scores a kill left (tallied before the kill is sent)
  and the guided missiles a `gmUpdate` steers.
- **Snapshots:** `NativeTranslator.writeState`, the join burst less the
  arrival's own parts: variables, flags, players and their spawns, teams, the
  rabbit. Each is an update marker and state packets, as `Record::sendStates`
  writes them.
- **Size:** capped at 16 MB by default (`DefaultMaxBytes`), trimmed from the
  front a snapshot at a time, so what is kept always starts at one.
- **Header:** the world is the map file's own as bzfs would load it, not the
  world bzo serves native clients (which adds compass letters), so its hash
  names the map, and a recording of bzo matches one made by bzfs on the same
  file. Settings are the `MsgGameSettings` frame native clients get; flag
  types are the types in play; the player is `ServerPlayer` and the callsign
  the operator who saved it.

`/record`, for operators, worded as upstream's (`RecordCommand`):

- `start`, `stop`: the buffer, on by default.
- `size <Mbytes>`, `rate <seconds>`: the cap and the snapshot interval.
- `stats`: `Buffered:  <bytes> bytes / <entries> packets / <seconds> seconds`.
- `save <filename> [seconds]`: the buffer, or its last `seconds`, to
  `replays/<filename>.rec`.
- `file <filename>`: marks where a file starts and writes it at
  `/record stop`, out of the same buffer, so it is only as long as the buffer
  holds; upstream streams it to disk as it goes.
- `list [-t | -n | --] [pattern]`: the saved files, as `/replay list`.

The Operator panel's "Save Recording" is `/record save`: a name, and the last
N seconds or, left empty, the whole buffer.

Measured on port 3000, hix and three bots: 86.8 s saved to 160 KB. Two thirds
of it is snapshot flag state (hix has about 200 flags), as in a bzfs-made
recording; in the buffer a snapshot is about 80 KB of JSON.

## The file

`src/bzfs/RecordReplay.cxx`, `RecordReplay.h`. All integers are big-endian.

- **Header**, 426 bytes: magic `rrBZ` (`0x7272425A`), version 1, total header
  size (`offset`), file time (an `RRtime`, two u32s, microseconds), the
  recording player's index, flag-types size, world size, callsign (32), motto
  (128), protocol (8, `BZFS0221`), app version (128), world hash (64), then
  4 + `WorldSettingsSize` (30) bytes of game settings.
- **Flag types**, `flagsSize` bytes.
- **World**, `worldSize` bytes: the same database a joining client gets from
  `MsgGetWorld`. `parseWorldDatabase` in `server/remote-world-import.cjs`
  reads it unchanged.
- **Packets**, to the end of the file. Each has a 32-byte header: mode (u16),
  code (u16), len (u32), next/prev file position (u32 each), timestamp
  (`RRtime`), and 8 bytes of stuffing (`PACKET_SIZE_STUFFING`). The payload
  follows: the bzfs message exactly as it was broadcast.

Packet modes:

- **0, real**: played back.
- **1, state**: a snapshot of players, flags, teams and vars. It goes to a
  viewer who is not yet stateful, on joining or after a seek.
- **2, update**: the marker between snapshots, every 10 s
  (`DefaultUpdateRate`).
- **3, hidden**: stored for admins only, never played back. Private chat is
  here.

Only what bzfs broadcast is recorded. The player updates are as sparse as the
clients made them: a bzflag client sends one only when its own dead reckoning
drifts, so about 1.4 per second per tank is normal. bzfs itself does not
predict; it only relays.
