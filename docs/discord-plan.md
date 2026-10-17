# Discord -- plan

Issue #193. Linked Roles, nicknames for linked members and a game's public chat
both ways are built and are `docs/discord.md`; commands from Discord, IRC and
voice are not. This is how bzo connects to a Discord server: members proving
which BZFlag account is theirs, and a channel that carries a game's public chat
both ways. The BZFlag Discord (<https://discord.gg/6DHkggcXM9>) is the first
one it is for, with bz.rikers.org the server doing the work.

GitHub events already reach the BZFlag Discord's #bzo-dev channel through a
repository webhook pointed at Discord's `/github` endpoint. That needs nothing
from bzo and is not part of this plan.

## One Discord app per operator

Everything below runs as one Discord application, created by the operator in
the Discord developer portal and added to their Discord server. It is free and
needs no review from Discord, which reviews an app only once it is in 75 or
more servers; below 100, even the message-content intent is a switch in the
portal. Adding it to a server takes Manage Server there.

Its credentials live in `server.json` -- never in the repository -- as a
`discord` block:

```json
"discord": {
  "applicationId": "...",
  "publicKey": "...",
  "clientSecret": "...",
  "botToken": "...",
  "guildId": "...",
  "bridge": { "channelId": "...", "webhookUrl": "..." }
}
```

A server without the block has none of this. Each part below says which keys
it needs.

### Who runs what

Linking proves a fact about a person -- this Discord account is this BZID --
and that fact is the same whichever game they play on. One bzo server can do
it for a whole Discord server: bz.rikers.org for the BZFlag Discord.

The chat bridge is different. A bzo server sees only its own chat; neither the
list server nor any other bzo server does. So every server whose chat goes to
Discord runs its own bridge, with its own `bridge` channel. Several servers
can share one Discord app and one Discord server, one channel each, as long as
the operator gives each the same app's credentials. An operator running a bzo
server elsewhere who wants a bridge into the BZFlag Discord needs a channel
and a bridge webhook from its admins, and a bot of their own to read the
channel back (**Discord to game** below).

## Linking a Discord account to a BZFlag account

The proof is BZFlag's own global login, which bzo already uses
(`docs/login.md`): `my.bzflag.org/weblogin.php` hands back a token,
`CHECKTOKENS` confirms it, and the reply carries the callsign, the BZID and
membership of the groups asked about. Nothing on the forum needs changing.

### Linked Roles (first)

Discord's Linked Roles let a server require an account elsewhere for a role,
with Discord's own menu doing the asking -- no bot in the server and no
command to type. The app declares what it can vouch for (role connection
metadata) and gives Discord a verification URL:

1. A member picks the role's requirement in Discord, which sends them to
   bzo's `/discord/link`.
2. bzo sends them through Discord's OAuth2 (`identify` and
   `role_connections.write` scopes) to learn their Discord ID, then through
   `weblogin` to learn their callsign and BZID.
3. bzo stores the pair and writes the member's role connection: platform name
   "BZFlag", username their callsign, and metadata such as `verified` and
   `bzflag_admin` from the groups `CHECKTOKENS` returned.
4. The Discord server's admins make roles that require that metadata.

Keys: `applicationId`, `clientSecret`. The verification URL is set in the
developer portal to `https://<server>/discord/link`.

The links are kept as `discord-links.json` beside `bans.json` and
`sessions.json`: Discord ID, BZID, callsign at link time, when. A member
unlinks from Discord's menu, which bzo hears about on their next visit, or by
`/discord unlink` in Discord once the bot exists.

Group membership is a snapshot, as a login session's is (`docs/login.md`): a
role from a forum group lasts until the member links again. A refresh would
need the member to sign in again, so there is none; a role that matters can be
re-checked by asking for a fresh link.

### A bot command (later, if wanted)

A bot can do what Linked Roles cannot: set a member's nickname to their
callsign, or hand out roles without the member choosing them. It is the same
app with a bot user added to the server, holding Manage Roles and Manage
Nicknames, and answering a `/link` slash command with a one-time bzo link that
runs the same two logins.

It needs no running process of its own. A slash command can arrive as an HTTPS
request to an interactions endpoint, `https://<server>/discord/interactions`,
which bzo's server answers like any other route, checking the request's
signature with `publicKey`. Roles and nicknames are then set with ordinary
calls to Discord's REST API using `botToken`. A dev-server restart loses only
the commands that arrive while it is down, and Discord tells the member so.

Keys: `publicKey`, `botToken`, `guildId`.

## Chat bridge

One Discord channel per game server, named for it -- Discord allows no dots or
colons, so bz.rikers.org:5154 is `#bz-rikers-org-5154`.

### Game to Discord

No bot needed: the channel's own webhook takes a POST per message, and each
can carry a sender name, so a line shows in Discord under the player's
callsign. It hangs off `deliverChatMessage` (`server.js`), after its own
checks, for messages addressed to all players only:

- public chat only -- team chat, private messages and the admin channel never
  leave the game;
- never a muted player (`player.muted`), since `deliverChatMessage` refuses
  them first;
- never a command line, which `deliverChatMessage` never sees;
- sent with `allowed_mentions` empty, so a line cannot ping `@everyone`, a role
  or a member;
- batched: a webhook takes about 30 messages a minute, so lines queue and go
  together when a game is busy.

Whether joins, parts, kills and captures go too is a choice for the operator,
off by default -- they would drown the chat.

Keys: `bridge.webhookUrl`.

### Discord to game

This half needs the bot, because bzo must read the channel. Reading message
content takes the message-content intent, a switch in the developer portal for
an app in fewer than 100 servers, and a gateway connection: a WebSocket to
Discord that the server keeps open.

It runs inside bzo's server process. When the dev server restarts, it
reconnects and resumes, and Discord delivers what was said meanwhile, so
nothing is lost; the lines arrive late instead.

A message in the channel arrives in game as a server message,
`[Discord] name: text`, so native BZFlag clients see it as well as bzo's. The
name is the member's linked callsign where there is one and their Discord name
otherwise.

A line that starts with `/` is a command, and runs only for a linked member, as
their BZID: the permission each command carries in `commands.cjs`, checked as
it is for a signed-in player, with the groups their link recorded, so an admin
in game is an admin from Discord and nobody else is. The reply goes back to
that member alone, as an ephemeral answer to the bot's own `/bzo` slash command
rather than a channel message. An unlinked member's `/` line is refused, not
relayed as chat. This is what #193 means by identifying users on the far side:
administration from Discord works because the link says who is asking.

Messages from the bridge's own webhook are ignored, or the game's lines would
come straight back.

Keys: `botToken`, `bridge.channelId`.

### Moderation

Each side moderates its own. A member muted or banned in Discord cannot post
in the channel, so nothing of theirs reaches the game. A player muted or
banned in the game sends nothing to Discord. A ban by BZID could also block a
Discord member linked to that BZID from the bridge; that is the one thing
linking adds here, and it is worth deciding before building rather than after.

## IRC

Issue #193 asks for IRC as well, as upstream's `bzflag-ircRelay` plugin
(<https://github.com/d03n3rfr1tz3/bzflag-ircRelay>) does for bzfs. The bridge
above is written so the far end is a transport: game to it, it to game, and who
is asking. IRC is a second transport with the same rules, joining a channel
with its key and identifying to NickServ with a password from `server.json`.
IRC has no account to link the way Discord has, so commands from IRC would need
a nickname registered to a BZID by hand in the config, or none at all. It comes
after Discord, and only if it is wanted.

## Voice (not planned)

A Discord voice channel joined to bzo's voice is possible, and put off because
it costs far more than everything above together.

bzo's voice is peer to peer: each browser sends to the others over WebRTC
(`public/voice.js`), All, Nearby and Team decide who hears whom, and the server
only introduces the peers -- it never carries or hears audio. A bridge would
have to be a participant on both sides at once: a voice peer in bzo, most
simply a headless browser on the All channel, mixing every bzo speaker into one
stream for Discord, and a bot in the Discord voice channel mixing Discord's
speakers into one stream played into bzo as if one player were talking.
Discord's voice is end-to-end encrypted (its DAVE protocol), so the bot needs a
voice library that speaks it, such as `@discordjs/voice`.

What makes it heavier than the text bridge:

- it is a process decoding, mixing and encoding audio for as long as anyone
  talks, on servers where the main thread is already the limit;
- Nearby and Team do not map onto one Discord channel, so it would carry All
  only, or need one bridge and one Discord channel per team;
- each hop adds delay, and with the voices mixed, Discord shows the bridge as
  the one talking rather than the person;
- a headless browser per bridged server is a large, fragile thing to keep
  running.

Text chat, linking and administration from Discord answer most of #193. Voice
waits until those are in use and somebody asks for it.

## What the operator does in Discord

1. Create the application; note its application ID, public key and client
   secret.
2. For Linked Roles: set the verification URL, and once bzo has registered the
   metadata, make roles that require it.
3. For the bot: add a bot user, copy its token, turn on the message-content
   intent if the bridge reads the channel, and invite it with Manage Roles and
   Manage Nicknames (linking) or View Channel, Read Message History and Send
   Messages (bridge).
4. For each bridged server: make the channel and a webhook on it.
5. Put the IDs, secrets and webhook URL in `server.json`'s `discord` block.

## Order

1. Linked Roles: OAuth2, `weblogin`, `discord-links.json`, role connection
   metadata. Useful on its own, and everything after builds on the link.
2. Game to Discord: one webhook, no bot.
3. The bot and Discord to game.
4. `/link` for nicknames and roles, if Linked Roles turns out not to be enough.
