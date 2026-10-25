# Chat bridges -- plan

Issue #193. A game server's public chat carried both ways to a chat platform,
and members there proving which BZFlag account is theirs. Discord is built:
Linked Roles, callsign nicknames and the chat mirror both ways, all in
`docs/discord.md`. Still to come are commands from linked members, Matrix and
IRC. Voice is not planned on any of them.

GitHub events reach the BZFlag Discord's #bzo-dev channel through a repository
webhook pointed at Discord's `/github` endpoint. That needs nothing from bzo
and is not part of this plan.

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

`server/discord-bridge.cjs` holds rules that are not Discord's. They move to a
shared bridge with Discord, Matrix and IRC as transports under it, each doing
only what its platform needs: how a line is sent, how one arrives, and who
sent it.

What the bridge decides, the same for every transport:

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

### Commands from linked members

A command line from the far side runs only for a linked member, as their BZID:
the permission each command carries in `commands.cjs`, checked as it is for a
signed-in player, with the groups their link recorded. An admin in game is an
admin from Discord, Matrix or IRC, and nobody else is. The reply goes to that
member alone. An unlinked member's command is refused, not relayed as chat.

The prefix is the platform's: Discord's `/bzo` slash command answers
ephemerally; on Matrix and IRC a line starting `!` is the command, since
Element takes `/` for its own commands and IRC clients do too, and the reply
goes as a private message.

### Links

Every platform links the same way bzo's Discord links do: the member gets a
one-time bzo URL, signs in through BZFlag's `weblogin` (`docs/login.md`), and
bzo stores the pair. The far-side identity is what the platform vouches for --
a Discord user ID, a Matrix user ID, an IRC services account -- never a
display name. Each platform keeps its own file beside `discord-links.json`, in
the same shape.

## Discord

Built, and documented in `docs/discord.md`. What is left is commands from
linked members, above, answering a `/bzo` slash command through the
interactions endpoint, `https://<server>/discord/interactions`, signed with the
app's `publicKey`.

## Matrix

Matrix is open and federated: anyone can run a homeserver, and a room is
shared by every homeserver with a member in it. There are three ways for bzo
to take part, in rising cost.

### A bot account (first)

The operator makes a Matrix account for the bridge on any homeserver --
matrix.org or their own -- and puts its access token in `server.json`:

```json
"matrix": {
  "homeserver": "https://matrix.example.org",
  "userId": "@bzo:example.org",
  "accessToken": "...",
  "roomId": "!abc:example.org"
}
```

bzo is then an ordinary Matrix client: the client-server API over HTTPS, no
SDK needed.

- **Game to Matrix:** `PUT /rooms/{roomId}/send/m.room.message/{txnId}`, a
  `body` and an HTML `formatted_body` with the callsign in bold, and an empty
  `m.mentions` so nothing pings. A unique `txnId` per line makes a retry safe.
- **Matrix to game:** a `/sync` long poll, which the server keeps open as it
  keeps Discord's gateway. Its `next_batch` token is kept in
  `matrix-sync.json`, so a restart picks up where it left off and the lines
  said meanwhile arrive late rather than never.
- **Unencrypted rooms only.** Matrix's end-to-end encryption needs a full
  Olm/Megolm implementation and its keys kept safe on the server. A bridged
  room is a public one, which Element creates unencrypted.
- **Names:** every game line comes from the bot, with the callsign in bold, as
  a Discord webhook line would without its per-message name. A bot cannot set
  another member's display name, so a linked member's callsign shows only in
  the game, not as their Matrix name.
- **Admins:** a link that found the member in an admin group raises their
  power level in the room to moderator, which the bot can do once it has
  enough power itself.

A Matrix space can gather a community's game rooms -- one per bzo server,
named for it like `#bz-rikers-org-5154:example.org`.

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

1. Split `server/discord-bridge.cjs` into the shared bridge and a Discord
   transport, with no change in behaviour.
2. Commands from linked members, through Discord first.
3. Matrix as a bot account: chat both ways, then links and power levels.
4. IRC, if it is wanted.
5. A Matrix application service, and the optional homeserver container.
