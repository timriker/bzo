# Matrix

The bundled `matrix` plugin (`plugins/matrix.cjs`, `docs/plugins.md`): a game
server's public chat and one Matrix room, both ways, through a Matrix account
of the bridge's own, and Matrix accounts linked to BZFlag ones, with power
levels and rooms from their bzflag.org groups, and server commands from
linked members. An application service is `docs/chat-bridge-plan.md`.

## Setting it up

1. Make a Matrix account for the bridge, on matrix.org or any homeserver, in
   a private browser window so it stays apart from your own: at
   <https://app.element.io>, Create Account.
2. Get the bridge's access token with a password login of its own, which
   lasts until that session is signed out. A token copied from Element's
   Help & About may not: where a homeserver signs Element in through OAuth,
   as matrix.org does, Element's tokens expire and refresh themselves.

   ```bash
   read -rsp 'Matrix password: ' PW; echo
   curl -s -X POST https://matrix-client.matrix.org/_matrix/client/v3/login \
     -H 'Content-Type: application/json' \
     -d "$(jq -n --arg pw "$PW" '{type:"m.login.password",
           identifier:{type:"m.id.user",user:"bzo-bridge"},
           password:$pw, initial_device_display_name:"bzo bridge"}')" | jq .
   unset PW
   ```

   The reply's `access_token` is the token; its `device_id` is not needed.
   The session shows as "bzo bridge" in the account's Sessions list, where
   signing it out ends the token.
3. As yourself, make the room: an unencrypted public room, which is what
   Element makes a public one, named for the game server --
   `#bz-rikers-org:matrix.org` for bz.rikers.org, with the port where the
   server needs one. Put it in your space if you have one: the space's menu,
   Add, Add existing room.
4. Invite the bridge's account to the room.
5. Turn the plugin on in `server.json`:

```json
"plugins": {
  "matrix": {
    "homeserver": "https://matrix-client.matrix.org",
    "accessToken": "...",
    "room": "#bz-rikers-org:matrix.org"
  }
}
```

`homeserver` is the account's client-server API: for matrix.org,
`https://matrix-client.matrix.org`. `room` is the room's alias or its id. On
start the bridge joins the room, which accepts the invite, and the server
logs `matrix: bridging <room> as <account>`. An encrypted room is refused,
and the log says so: the bridge cannot read or write end-to-end encryption.

## Game to Matrix

What goes is what every player in the game sees: chat to all, and `/me`, as
`bz_eFilteredChatMessageEvent` reports it. Team chat, private messages, the
admin channel, a muted player's lines and every command never leave the game.
A BZFlag client's colour codes are removed.

A person joining or leaving is said too, in italics with who is in after:
`Foo joined, p 2 o 1 b 1` -- players, observers and bots, each left out at
none. Bots coming and going are not. Who the room was last told is in is
kept beside `server.json` (`matrix-roster.json`), so after a restart the people
coming back are not announced again, and two minutes on anyone who did not
is said to have left.

Lines go at most one message every two seconds, each led by its speaker in
bold, with BZFlag's scoreboard mark: `@` for an admin, `+` for a signed-in
player. Every message has its mentions off, so `@room` and names show as
text. When the homeserver asks the bridge to slow down, the lines wait and go
when it says, up to 200 of them.

## Matrix to game

What members say in the room comes back into the game as server messages,
`[Matrix] name: text`, which native BZFlag clients see too; bzo's own client
puts them on the Chat tab (`bz_sendRelayMessage`). The name is the member's
display name in the room. Three lines of a message at most, each up to 200
characters; a reply shows only the answer, not what it quotes, and `/me` is
`* text`. The bridge's own messages, notices (which Matrix bots send), edits,
and lines that start with `/` or `!`, which are commands, never come in.

The bridge reads the room with a `/sync` long poll. Where it has read to is
kept in `matrix-sync.json` beside `server.json`, so a restart picks up where
it left off and lines said meanwhile arrive late rather than never. With none
kept, as on the first start, the room's past is skipped, and so is the past
a room arrives with when the bot joins it, or joins again after leaving.

## Links

A member types `!link` in the bridged room -- or, with a `space`, in any room
the bot is in. The bot answers in a direct message -- never the room --
with a URL to `/plugins/matrix/link`, good once
and for ten minutes. The page signs them in at bzflag.org (`eBZID`,
`docs/plugins.md`), asking about the server's `adminGroups` and every group
the options below name, and pairs the Matrix user ID the URL was made for
with their BZID. The bot then says in the room who is who: `@tim:matrix.org is
BZFlag Tim Riker`. `!unlink` undoes it. The URL needs `publicUrl` in
`server.json`; without one, `!link` is only logged.

`!whois` says who someone is: `!whois @tim:matrix.org`, `!whois Tim Riker` by
callsign, `!whois *` for everyone linked, or `!whois` alone for yourself.

A linked member reads in the game by callsign, marked `@` for an admin and
`+` otherwise, not by their Matrix name. Matrix does not let a bot set
anyone's display name, so in Matrix they keep the name they chose.

With `space` set, the space keeps the links: an `org.bzflag.link` state
event per member, holding their callsign, BZID, whether an admin, and what
the link granted -- never their other groups. On start the bot lets only the
space's admins (100) send that event, so nobody can write a link for
themselves. Every bzo server bridging a room in the space reads the same
links, so a member links once and is known on every one, including a server
added later. Give each server's `matrix` options the same `space`, with the
bot account admin there; every server can use the same account, each with a
token of its own. One of them -- the list server, say -- also has `"links":
true`: it answers `!link`, `!unlink` and `!whois` in every room of the space
its account is in, and serves the link page, so only it needs a `publicUrl`
for links. The others only read the links, and answer none of them.
Without `space`, links are this server's own, in `matrix-links.json` beside
`server.json`; that file also keeps the direct rooms the bot made, either
way. A server moves its file's links into the space the first time it
starts with one.

### Power levels and rooms from groups

```json
"matrix": {
  "space": "#bzo:matrix.org",
  "powerLevels": { "linked": 20, "admin": 50, "SOME.GROUP": 30 },
  "groupRooms": { "admin": "#bzo-admins:matrix.org" }
}
```

`powerLevels` maps a bzflag.org group, `admin` for any of the server's
`adminGroups`, or `linked` for every linked member, to a power level; `admin`
is moderator (50) unless it says otherwise. A level is only a number: Matrix
has no way to name one, so Element calls 100 Admin and 50 Moderator and shows
any other, such as 20 for `linked`, as a custom level. A link sets the
highest level the member's groups give in the `space` and every
room in it -- or the bridged room alone, without `space` -- wherever the bot
can: it needs the power to change power levels there (admin, 100, by
default), never grants more than it holds, and never changes anyone it does
not outrank. `groupRooms` maps a group to a room its linked members are
invited to.

Groups are what bzflag.org named when the member signed in: it answers about
groups only for a fresh login, so linking again is what refreshes them. What
a group no longer named gave is taken back -- a level lowered, a group's room
left -- but only a level the bot set: one raised by hand since is kept.
`!unlink` takes back all of it.

The server that answers links (`"links": true`, or any server without a
space) also raises every existing link to what `linked` and `admin` give
each time it starts, so a level set after people linked, or a room added to
the space since, reaches them. That never lowers anyone: a link does not
keep the member's other groups, so only their next `!link` can take back
what those gave.

## Server commands

A linked member talks to the game servers in their direct room with the bot.
To start one, open a direct chat with the bot's account in Element; the bot
joins, keeps the room as theirs, and says what it is for. `!link` and
`!whois` answer there too. Element encrypts a new direct chat unless told
not to, and the bot reads no encrypted message: invited to an encrypted
chat, or sent an encrypted message in one, it says so there and opens an
unencrypted chat with the member in its place.

- `!servers` lists every server whose `matrix` options name the same
  `space`: each announces itself in its own room, by its `name` -- the host
  of its `publicUrl` unless the options set one -- its room, and the account
  it answers as.
- `!use <server>` picks the one their commands go to, by its name, its name
  without the port, or its room's alias -- or the start or any part of one,
  if that names only one server; `!use` alone says which, and
  `!use none` drops the choice.
- `!playerlist`, or any server command with `!` for its slash, runs on that
  server; `/playerlist` works too, where Element is told to send it as a
  message. With nothing picked, the server with `"links": true` runs it.
- `!shelp` runs `/help` on that server.
- `!help` says all this in the room.

`!servers` and `!help` answer in any room of the space too, from the server
with `"links": true`, since neither says anything private. Any other `!`
command there gets a pointer to the direct room -- opened for the member if
they have none -- and never runs where others could read its answer.

A command runs as the member's linked account: their callsign, and admin as
their link found it, so an admin command works for admins alone, and a BZID
banned there runs nothing. The answer, led by the server's name, comes back
in the same room. A plugin's own commands, which need a player in the game,
answer that they are only for players there.

Servers sharing a bot account all see its direct rooms; they agree on which
answers through their rooms and the account. A member's choice is kept in
the account's `org.bzflag.targets` data, the direct rooms in its `m.direct`,
and each server in its own room's `org.bzflag.server` state, which only that
room's admins may send. The server with `"links": true` joins every public
room of the space, and each new one as it is added, to read them.

A `!` command typed in a server's bridged room runs on that server, with the
answer in the member's direct room, never the bridged one, since an answer
may name addresses.

## Your own bot

Another operator's server can join the space without the space's bot
account, whose token would let it act as every server and the link page.
They make a bot account of their own, as in "Setting it up", and:

1. Make the server's room, public and unencrypted, with their bot admin
   there.
2. Ask an admin of the space to add the room to it.
3. Give the server's `matrix` options the same `space`, without `"links":
   true`.

Their bot joins the space, as anyone may a public one, and reads the links
there; it writes nothing in the space and needs no power in it. It bridges
and runs commands in its own room, as any server does, and answers its own
direct chats, since no server on its account answers links. `!servers` from
any bot lists it, as `-- message @their-bot:server`: a member talks to it in
a direct chat with that account. Levels from `powerLevels` are set only
where the space's bot is admin, so not in their room.

One bot account can bridge several servers, each with its own token and
room, as the space's bot does. Its direct chats are then answered by the
first of them by name, until a member picks another with `!use`.
