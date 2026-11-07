# Discord

The bundled `discord` plugin (`plugins/discord.cjs`, `docs/plugins.md`):
Linked Roles, which let a Discord member prove which BZFlag account is theirs
so a Discord server can make roles that require it; their callsign as their
nickname; and a game server's public chat both ways. Commands from linked
members, Matrix and IRC are `docs/chat-bridge-plan.md` (issue #193).

## Setting it up

In the Discord developer portal, create an application, and from it:

- General Information: the application ID and public key, and the Linked
  Roles Verification URL, `https://<your server>/plugins/discord/link`.
- OAuth2: the client secret, and a redirect,
  `https://<your server>/plugins/discord/callback`.
- Bot: add a bot and copy its token. Linked Roles does not put the bot in any
  server; the token is what declares the role requirements below.

Then turn the plugin on in `server.json` with them as its options:

```json
"plugins": {
  "discord": {
    "applicationId": "...",
    "publicKey": "...",
    "clientSecret": "...",
    "botToken": "...",
    "guildId": "...",
    "webhookUrl": "https://discord.com/api/webhooks/..."
  }
}
```

Each part runs when its options are there. Linked Roles needs
`applicationId`, `clientSecret` and `botToken`. On start the server logs
`discord: Linked Roles on, <n> linked` and declares to Discord what it can
vouch for, logging `discord: role metadata: verified, bzflag_admin`.

In the Discord server, make a role and under its Links tab require the app.
Two things can be required:

| Key | Shown as | Set when |
| --- | --- | --- |
| `verified` | BZFlag player | the member signed in at bzflag.org |
| `bzflag_admin` | BZFlag admin | they are in one of the server's `adminGroups` |

## The round trip

A member picks the role's requirement in Discord, which opens
`/plugins/discord/link`, a plugin page that asks for a BZID login (`eBZID`,
`docs/plugins.md`):

1. bzo sends them to bzflag.org's `weblogin`, as `/login` does
   (`docs/login.md`), and checks the token that comes back with
   `CHECKTOKENS`, asking about the same `adminGroups` as a login. The login is
   kept behind a cookie for the rest of the round trip.
2. The page sends them to Discord's consent page, asking for `identify` and
   `role_connections.write`, with a random `state`.
3. Discord sends them back to `/plugins/discord/callback` with a code. bzo
   checks the `state` was given to the same BZID, trades the code for a
   token, asks Discord who they are, writes their role connection to Discord
   -- platform "BZFlag", their callsign, and the two values above -- and saves
   the link.

Each `state` and each way back from bzflag.org is good once and for ten
minutes. A way back from bzflag.org shares `/login`'s rate limit. Every
refusal is one of bzo's own fixed sentences in plain text, never anything the
query string carried.

The links are kept in `discord-links.json` beside `server.json`: Discord ID,
BZID, callsign, whether an admin, and when. The Discord token is used for the
role connection and then dropped, so nothing kept can act on a member's
account. Admin is a snapshot, as a login session's groups are: it changes when
the member links again.

## Nicknames

With `guildId` in the plugin's options, a member who links gets their callsign
as their nickname in that server, cut to Discord's 32 characters. The bot sets
it, so it needs Manage Nicknames, and its role must sit above the roles of the
members it renames. Discord never lets a bot rename the server's owner. A
nickname that is not set leaves the link made and the roles given, and the log
says why. Turning off Change Nickname for @everyone leaves callsigns as the
only nicknames members did not get from a moderator.

## Chat mirror

A game's public chat can be mirrored into a Discord channel, one channel per
game server -- `#bz-rikers-org-5154` for bz.rikers.org:5154. Make the channel,
give it a webhook (channel settings, Integrations, Webhooks), and put the
webhook's URL in the plugin's `webhookUrl`. It needs no bot and none of the
Linked Roles keys. On start the server logs `discord: public chat mirrored to
a channel`.

What goes is what every player in the game sees: chat to all, and `/me`, as
`bz_eFilteredChatMessageEvent` reports it. Team
chat, private messages, the admin channel, a muted player's lines and every
command never leave the game. Each post is sent with mentions off, so
`@everyone` and the like show as text. A BZFlag client's colour codes are
removed.

Lines go at most one post every two seconds, within a webhook's 30 a minute.
One speaker's lines go under their callsign as the sender; several speakers'
go together under the server's title, each line led by its speaker. A name
carries BZFlag's scoreboard mark: `@` for an admin, `+` for a signed-in
player. When
Discord asks bzo to slow down, the lines wait and go when it says, up to 200
of them.

## Discord to game

With `botToken` set as well, what members say in that channel comes back into
the game as server messages, `[Discord] name: text`, which native BZFlag
clients see too; bzo's own client puts them on the Chat tab, not Server
(`bz_sendRelayMessage`). The
bot holds a gateway connection for it, so the app needs the Message Content
Intent (developer portal, Bot), and the bot needs to see and read the channel.
The channel is the one the bridge webhook posts to; there is nothing else to
set. The server logs `discord: channel messages relayed into the game` and
then `discord: gateway ready as <bot>`.

The name is a linked member's callsign, marked `@` if their link found them in
an admin group and `+` otherwise; anyone else goes by their nickname in the
server. Mentions, channels and custom emoji read as names. Three lines of a
message at most, each up to 200 characters, and an attachment alone reads as
`[attachment]`. A bot's posts and the mirror's own never come back. A line
that starts with `/` is a command and is not relayed: running commands for
linked members is still to come (`docs/chat-bridge-plan.md`).

The gateway session is kept in `discord-gateway.json` beside `server.json`, so
a restart resumes it, as does switching the plugin off and on, and Discord
then sends what was said while it was off.

## Server commands

A linked member runs a server command in the bridged channel either way:
`/bzo playerlist`, Discord's own slash command, or `!playerlist`, as in a
Matrix room. It runs as their linked BZFlag account (Linked Roles, above):
their callsign, and admin as their link found it, so an admin command works
for admins alone, and a BZID banned there runs nothing. A `!` line never
reaches the game as chat.

The answer comes in a direct message from the bot, never the channel, since
an answer may name addresses. A member who takes no direct messages from the
server's members gets `/bzo`'s answer in the reply only they see instead, and
nothing for a `!` line. The server registers `/bzo` with the app when the
channel relay starts -- in `guildId`'s server, or everywhere the app is
without one -- and logs `discord: /bzo registered`; it answers through the
bot's gateway, so there is no interactions URL to set.
