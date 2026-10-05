# BZFlag clients

Issue #174: native BZFlag clients on a bzo server. Configured by server.json's
`bzflag` block ([installation.md](installation.md)); the code is
`server/bzflag-server.cjs`.

## What works

- **The port.** bzo answers on `listen` as bzfs does on its game port: the
  `BZFLAG\r\n\r\n` handshake, `MsgQueryGame`, `MsgQueryPlayers`, and the UDP
  ping. A server browser, `bzfquery` and the list server's check all get
  their answers.
- **The list.** bzo adds itself to my.bzflag.org with the `bzfs` key once it
  can answer the list's connect test (see **Ready** in
  [list-server.md](list-server.md)), then on every join and part and every
  15 minutes, one request at a time as bzfs sends them, and removes itself on
  shutdown. The request goes over IPv4, since the list checks that
  `publicAddr` resolves to the address it came from. The title is
  server.json's `title` with the live map's name after it, `- bzo` on bzo.bzw, held
  to bzfs's 127 characters.
- **The counts.** They follow bzfs's ping: humans only, the rabbit and hunters
  counted as rogues.

- **Watching.** A client that joins goes through bzfs's own sequence
  (`MsgNegotiateFlags`, `MsgWantSettings`, `MsgWantWHash`, `MsgGetWorld`,
  `MsgEnter`) and is seated as an observer, whatever team it asked for. It
  becomes an ordinary bzo player through the door a bot uses: its socket's
  `send` is `server/bzflag-native.cjs`, which turns bzo's messages into
  bzfs's -- roster, moves, spawns, deaths, shots, flags, chat, scores, the
  rabbit and the clock. Its chat reaches bzo's players.
- **The world** is compiled from the map's `.bzw` by
  `server/bzw-compile.cjs`, which follows bzfs's own reader and obstacle
  code, drawInfo meshes included, and is packed by
  `server/bzflag-world.cjs`. `npm run test:bzflag-world` holds every map in
  `maps/` to bzfs's own `-cacheout` output byte for byte where bzfs is
  installed. A construct the compiler cannot reproduce (a tinted group
  instance placing an arc, cone, sphere or tetra) falls back to bzfs
  `-cacheout`, and is turned away where bzfs is not installed. A generated
  world is generated as a `.bzw` in the first place (see **Generated worlds**
  in [bzw.md](bzw.md)) and compiled from that text, with a `t` hash, as bzfs
  gives a world it made up, so a client keeps it only for the session.
- **Compass letters.** bzo's own N/S/E/W markers, which its browsers draw for
  themselves, are added to the world a BZFlag client gets
  (`server/bzflag-extras.cjs`) and to nobody else's: the four letters in bzo's
  colours, white edged, just beyond the middle of each wall at bzo's height,
  tilted back 45° so they read from inside the arena and show their shape on
  the radar. Built from flat strokes and material colour, since a stock
  client only loads images from images.bzflag.org; emissive, so they read at
  night. Passable and beyond the wall, so the client's physics never meet
  them and still agree with bzo's server. The radar draws every face one
  colour, so the letters are its usual grey-cyan, except N, red there through
  a death physics driver nothing can reach; the white edge is kept off it.
  Added after the compile, so `test:bzflag-world` still holds the compile to
  bzfs, and the world hash differs from bzfs's for the same map.
- **Downloading it over HTTPS.** bzo sends `MsgCacheURL`, as bzfs does with
  `-cacheurl` or its `fastmap` plugin, naming its own copy at
  `<publicUrl>/bzflag/world/<md5>.bwc`. The client fetches that, checks its
  MD5 against the world hash, and falls back to `MsgGetWorld`, a kilobyte a
  round trip, if it can't. `cacheUrl` in the `bzflag` block names another URL,
  or `false` turns it off. The hash matches bzfs's for the same map, so a
  world cached from either serves both.
- **Updates once a second.** A BZFlag client hears from every tank at least
  once a second (`MaxUpdateTime`) and dead-reckons from that, so with the
  listener on, bzo's clients send their idle heartbeat every second rather
  than every five.
- **The game clock.** `MsgGameTime` at the handshake and then every second,
  stretching to every ten, as bzfs sends it; the client's texture
  animations and drawInfo spins run on it.
- **The version.** bzo calls itself `bzo-<release>-<build>` where bzfs gives
  its own version: the list server's `build` and `/serverquery`.
- **Sign-in.** The token a client sends with `MsgEnter` is checked with
  bzflag.org (`checkGlobalToken`) before it is seated, as bzfs checks every
  callsign. A good one gives the player its BZID, global callsign and admin
  groups, as a browser login does, and each answer is said in bzfs's words:
  "Global login approved!", "Global login rejected, bad token.", or "This
  callsign is not registered." Unlike bzfs, the check leaves out the
  player's address, as the browser login does. The login is a session, as a
  browser's is, removed when the client leaves; so the same account joining
  from a browser too is a second device, and the newer one wins.

A restart, which a map change is in bzo, drops every native client, and it
has to rejoin: bzfs does the same, and the client has no reconnect of its
own. Browsers rejoin by themselves; a BZFlag client does not.

- **Driving.** A client joins on the team it asks for, bzo's to assign where it
  asks for automatic, the rabbit or a hunter. bzo spawns it as it joins and
  after each death, and the client starts its tank where `MsgAlive` says. Its
  `MsgPlayerUpdate`s become bzo moves (`moveFromBzfs`), so every other player
  sees it drive. Its physics are its own client's, which bzo cannot correct and
  does not yet match, so a movement finding about it is logged and not refused,
  whatever the anti-cheat mode. A spawn request while bzo has it alive means it
  died on its own screen only, and is answered with where it is.

- **Shooting.** A client's `MsgShotBegin` becomes the `shoot` a browser
  sends (`shootFromBzfs`), and bzo's server flies it and decides what it
  hits among bzo's players, as for any shot. bzo names the shot its own way,
  so the client's id for it is kept and everything bzo says about it after --
  its end, a kill -- names it as the client does. Its own shot is not sent
  back to it.

- **Dying.** bzo's server decides hits for every shot, a native player's
  included, and tells the client with `MsgKilled`, which it takes
  (`GotKilledMsg`). A BZFlag client also decides its own: its `MsgKilled`
  names the shot that hit it, and bzo ends that shot on it as if its own
  server had found the hit (`applyNativeDeath`), crediting the shooter. Run
  over, self-destruct, water and a death touch are taken too, the last by
  upstream's driver index, which bzo's own `killed` carries as well.
  Whichever decides first wins; the other's word is about a tank already
  dead. The report is only ever about its sender, so it costs nobody else a
  life -- but for Genocide, which bzfs reads off the flag the report names:
  bzo takes it when bzo's shot has already ended, and only when the killer
  is firing Genocide.
  An exploding tank keeps reporting as its pieces fly, alive bit clear, and
  those reports are not moves. bzo respawns it as any player, and a spawn
  request is answered only where the client died on its own screen and bzo
  still has it alive.

- **Flags.** A client asks to grab (`MsgGrabFlag`, the flag's index), drop
  and capture, as bzo's own browser does, and bzo decides and tells every
  player; the client holds a flag only once bzo says so, and runs its
  effects itself. A drop lands where bzo reckons the tank to be. Identify is
  searched on each of its holder's updates, as bzfs does, and `MsgNearFlag`
  sent only when the answer changes. A native guided missile's target
  (`MsgGMUpdate`) becomes the shooter's lock, which steers its missiles on
  bzo's server.

- **Phantom Zone.** Zoning rides on the holder's updates as `FlagActive`,
  as upstream's client sends it, and on bzo's flag as `zoned`: a change of
  the bit zones or unzones a BZFlag tank, and a zoned bzo tank's updates
  carry it. A browser names the teleporter face it crossed and a BZFlag
  client does not, so bzo finds the face along the tank's path and checks
  the crossing as it checks a browser's; a finding is logged. The proxy does
  the same with a bzfs, both ways.
- **Antidote.** A BZFlag client picks and draws its own antidote spot and
  asks to drop there, as with bzfs, so bzo gives it none of its own.

- **Teleports.** A client's `MsgTeleport` names the faces it went through,
  upstream's teleporter index times two plus the face, as bzo numbers them;
  the update after it is where it came out, taken as given and sent to every
  browser as bzo's own teleport move, so it is drawn as one rather than a
  slide (`applyNativeTeleport`). A bzo player's teleport reaches a BZFlag
  client as `MsgTeleport` and the position.
- **Pause.** A client counts its own five seconds down and then sends
  `MsgPause`, so bzo pauses it at once, and a bzo player's pause reaches it as
  `MsgPause` too.
- **bzo's guided missiles.** bzo announces a lock per shooter; a BZFlag
  client wants a `MsgGMUpdate` per missile, with where it is. So a missile
  fired locked carries one after its `MsgShotBegin`, and a shooter's lock
  moving sends one for each of its missiles in the air, from where bzo's
  server has them; the client steers each from there, as bzo's server does.
- **UDP.** The client asks for the link straight after the handshake, a
  `MsgUDPLinkRequest` naming its id from the socket it listens on; bzo keeps
  that address -- only from the host its TCP came from -- and answers as
  bzfs does (`sendUDPupdate`), `MsgUDPLinkEstablished` over TCP and a
  request back over UDP. Once the client says it heard that, player
  updates, shots and guided missile updates go both ways on UDP, as
  `ServerLink::send` lists them; everything else stays on TCP.
  `/playerlist` shows it after the address as bzfs does: ` udp` once bzo has
  heard the client on UDP, ` udp+` once it sends to it there too.
- **`/mv`.** Upstream has no message that moves a client's own tank but its
  spawn, so an operator moving a BZFlag player sends it `MsgAlive` at the
  new spot.
- **Lag.** bzo's keep-alive ping is bzfs's `MsgLagPing` for a native
  client, a sequence number it echoes, so its lag is measured as a
  browser's is and shows in `/lagstats`.
- **Admin addresses.** A BZFlag client an admin is on gets every player's
  address (`MsgAdminInfo`), each as it arrives, for its scoreboard -- IPv4
  only, as upstream packs it, so an IPv6 player is left out. `/clientquery`
  (an operator's, as bzfs's needs `clientQuery`) lists every playing tank's
  client: a BZFlag client's own version from `MsgEnter`, a browser's as bzo's
  build and the browser, a bot's as bzo's build and its pilot.
- **Player scores.** bzo's browsers tally scores themselves from `killed`
  with the server's own rule (`server/scoring.cjs`, mirrored to
  `public/scoring.mjs`). A BZFlag client tallies nothing, so the translator
  sends it bzfs's `MsgScore` for killer and victim after every kill, from
  the server's tally, and everybody's zeros when a match starts.
- **Team scores and the match's end.** `MsgTeamUpdate` on arrival and on
  every change, as bzfs sends it; `MsgScoreOver` naming who reached the limit
  and the team, `NoTeam` where a player's own score did. The end blowing every
  tank up is the server's word, `GotKilledMsg`.
- **Autopilot.** `MsgAutoPilot` both ways: a BZFlag client's own, which it
  calls Roger, turns on bzo's autopilot mark for that player, and a bzo
  player's autopilot reaches a BZFlag client's scoreboard as `[auto]`,
  including on arrival. A server bot always shows `[auto]`: the machine is
  always driving it.
- **Being dropped.** A restart, a shutdown, or the same account signing in
  on another device sends `MsgSuperKill` before the connection closes, as
  bzfs does, so the client says the server cut it off rather than that the
  link was lost. `MsgSuperKill` carries no reason, so the reason goes first
  as a server message ("Server restarting: map file change"). A browser gets
  the same two, the second as `superKill`, and shows upstream's words for
  it. A client that left on its own (`MsgExit`) gets none, as from bzfs.

## What doesn't yet

1. **Handicap.** `MsgHandicap`, which only a handicap game sends.
2. **Trust.** A native player's movement findings are logged, not yet
   refused, while bzo's physics still differ from the client's. A hacked client's
   illegal moves are to be refused once a finding means cheating.
