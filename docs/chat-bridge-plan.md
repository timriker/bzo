# Chat bridges -- plan

Issue #193. A game server's public chat carried both ways to a chat platform,
and members there proving which BZFlag account is theirs. Built: Discord's
Linked Roles, callsign nicknames and chat both ways (`docs/discord.md`), and
Matrix chat both ways, links, and power levels and rooms from groups
(`docs/matrix.md`), and commands from linked members on both. Still to come
is IRC.
Voice is not planned on any of them.

GitHub events reach the BZFlag Discord's #bzo-dev channel through a repository
webhook pointed at Discord's `/github` endpoint, and `#bzo-dev:matrix.org`
through `.github/workflows/matrix-notify.yml`, which posts each as a notice
with the bridge account's token (secret `MATRIX_TOKEN`). Neither is part of
this plan.

## Who runs what

Linking proves a fact about a person -- this account is this BZID -- and that
fact is the same whichever game they play on. One bzo server can do it for a
whole Discord server, Matrix space or IRC network: bz.rikers.org for the
BZFlag Discord.

A bridge is different. A bzo server sees only its own chat; neither the list
server nor any other bzo server does. So every server whose chat goes out runs
its own bridge, into its own channel or room. Several servers can share one
bot account and one community, one channel each.

## One bridge, several transports

Each transport is a plugin (`docs/plugins.md`), doing only what its platform
needs: how a line is sent, how one arrives, and who sent it. The rules they
share are `plugins/bridge/lines.cjs`: colour codes removed, three lines of 200
characters into the game, commands kept out. What is left to share is the
outgoing queue, which Discord's and Matrix's each keep for themselves, and the
links.

What every transport does:

- **Out of the game:** public chat only -- team chat, private messages and the
  admin channel never leave. Never a muted player, never a command line, and
  the sender marked `@` for an admin and `+` for a signed-in player.
- **No pings:** a line from the game can never notify everyone, a role or a
  member on the far side. Each transport has its own way to say so.
- **Batched:** lines queue and go together when a game is busy, at the rate
  the transport allows.
- **Into the game:** a server message, `[Discord] name: text`, `[Matrix]` or
  `[IRC]`, so native BZFlag clients see it as well as bzo's. The name is the
  sender's linked callsign where there is one. Three lines at most, each up to
  200 characters.
- **No echo:** the bridge's own lines, and other bots', never come back.
- **Moderation:** each side moderates its own. A member muted or banned there
  sends nothing to the game; a player muted or banned here sends nothing out.
  A ban by BZID can also shut out every far-side account linked to that BZID;
  that is the one thing linking adds, and it is decided once for all
  transports.

### Links

Every platform links the same way bzo's Discord links do: the member gets a
one-time bzo URL, signs in through BZFlag's `weblogin` (`docs/login.md`), and
bzo stores the pair. The far-side identity is what the platform vouches for --
a Discord user ID, a Matrix user ID, an IRC services account -- never a
display name. Where the platform can hold them, the links live there, for
every bzo server in the community: Matrix's are state events in the space
(`docs/matrix.md`). Discord's are still one server's file,
`discord-links.json`.

## Discord

Built, and documented in `docs/discord.md`. Its links are still one server's
file; moving them where every server in the community can read them, as
Matrix's are, is left.

## Matrix

Chat both ways, links, callsigns in game, power levels and rooms from
groups, server commands, and operators' own bots are built
(`docs/matrix.md`). Left are a bzfs plugin and an application service,
below.

A Matrix space gathers a community's rooms: `#bzo:matrix.org` holds
`#bzo-chat`, `#bzo-dev` and one room per bzo server, named for it like
`#bz-rikers-org:matrix.org`.

### A bzfs plugin

A C++ plugin for upstream's bzfs, so a BZFlag server joins the space as a
bzo one does with its own bot (`docs/matrix.md`, "Your own bot"), without a
bzo server in front of it. The same conventions: chat both ways through
`bz_eFilteredChatMessageEvent` and server messages, links read from the
space's `org.bzflag.link` state, the server announced in its own room's
`org.bzflag.server` state, and commands from linked members run as their
account in its bridged room and direct chats.

It speaks Matrix with libcurl, which bzfs already links: `bz_addURLJob`
sends only GET and POST, and Matrix sends messages and state with PUT. A
thread of its own, or the multi interface polled from `bz_eTickEvent`, keeps
the `/sync` long poll from stalling the game. It answers no links -- the link
page needs bzo's web login -- so a member links through a bzo server in the
space. bzfs has no way to run a command as an account not in the game; a
server-side player's `sendServerCommand` runs as that player, so commands
from Matrix would be limited to what such a player may do, or left out.

### An application service (later)

An operator who runs their own homeserver can register bzo with it as an
application service: a registration file holding two tokens and a namespace,
`@_bzo_.*:example.org`, that the homeserver gives bzo alone. The homeserver
then pushes the room's events to bzo over HTTPS
(`PUT /_matrix/app/v1/transactions/{txnId}`) instead of bzo polling, and bzo
can act as any user in its namespace. Each player shows up in Matrix as a user
of their own with their callsign as display name, rather than as lines from
one bot. It needs a homeserver the operator controls; matrix.org will not
register one.

### A bzo server as a homeserver (not planned)

bzo implementing federation itself -- event signing, the room's event graph,
state resolution, key publishing, backfill, the authorization rules -- is a
second server's worth of security-sensitive code that has to follow the spec
for good. The server's name also becomes its Matrix identity for good: users
and rooms on it can never move to another name.

An operator who wants their game server to be a Matrix endpoint gets one
without that: a small homeserver (continuwuity, Conduit's descendant) beside
bzo, offered as an optional container in the Docker setup, with bzo registered
to it as an application service. bzo already answers HTTPS for its host, so
it serves `/.well-known/matrix/server` to point federation at the homeserver.

## IRC

As upstream's `bzflag-ircRelay` plugin
(<https://github.com/d03n3rfr1tz3/bzflag-ircRelay>) does for bzfs. A TLS
connection on 6697, signing in to services by SASL with a password from
`server.json`, joining one channel per game server with its key.

Its server commands take `!`, as Matrix's do, since IRC clients take `/`
for their own.

- **Game to IRC:** `PRIVMSG`, a line at most 512 bytes with its prefix, so
  long chat is split; and slow, about one line every two seconds, which a busy
  game outruns. Batching matters most here.
- **IRC to game:** the same connection. A restart drops what was said while it
  was down: IRC keeps no history to catch up from.
- **Links:** IRC nicknames prove nothing, but a network with the IRCv3
  `account-tag` capability, Libera.Chat among them, labels each line with the
  sender's services account. That account is what a link records, and
  commands run only on a network that has it.

## Voice (not planned)

A Discord voice channel joined to bzo's voice is possible on Discord, and
Matrix calls and IRC have their own answers, but every one costs far more
than everything above together.

bzo's voice is peer to peer: each browser sends to the others over WebRTC
(`public/js/voice.js`), All, Nearby and Team decide who hears whom, and the server
only introduces the peers -- it never carries or hears audio. A bridge would
have to be a participant on both sides at once: a voice peer in bzo, most
simply a headless browser on the All channel, mixing every bzo speaker into one
stream for the far side, and a client there mixing its speakers into one
stream played into bzo as if one player were talking. Discord's voice is
end-to-end encrypted (its DAVE protocol), so its client needs a voice library
that speaks it, such as `@discordjs/voice`; Matrix calls need a LiveKit media
server.

What makes it heavier than the text bridge:

- it is a process decoding, mixing and encoding audio for as long as anyone
  talks, on servers where the main thread is already the limit;
- Nearby and Team do not map onto one channel, so it would carry All only, or
  need one bridge and one channel per team;
- each hop adds delay, and with the voices mixed, the far side shows the
  bridge as the one talking rather than the person;
- a headless browser per bridged server is a large, fragile thing to keep
  running.

Voice waits until the text bridges are in use and somebody asks for it.

## Order

1. The bzfs Matrix plugin.
2. IRC, if it is wanted.
3. A Matrix application service, and the optional homeserver container.
