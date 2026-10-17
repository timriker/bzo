# Discord

Linked Roles, which let a Discord member prove which BZFlag account is theirs
so a Discord server can make roles that require it; their callsign as their
nickname; and a game server's public chat both ways. Commands from linked
members, Matrix and IRC are `docs/chat-bridge-plan.md` (issue #193).

## Setting it up

In the Discord developer portal, create an application, and from it:

- General Information: the application ID and public key, and the Linked
  Roles Verification URL, `https://<your server>/discord/link`.
- OAuth2: the client secret, and a redirect,
  `https://<your server>/discord/link/callback`.
- Bot: add a bot and copy its token. Linked Roles does not put the bot in any
  server; the token is what declares the role requirements below.

Then give `server.json` a `discord` block:

```json
"discord": {
  "applicationId": "...",
  "publicKey": "...",
  "clientSecret": "...",
  "botToken": "...",
  "guildId": "..."
}
```

Without `applicationId`, `clientSecret` and `botToken` all set, none of this
runs. On start the server logs `Discord: Linked Roles on, <n> linked` and
declares to Discord what it can vouch for, logging `[DISCORD] role metadata:
verified, bzflag_admin`.

In the Discord server, make a role and under its Links tab require the app.
Two things can be required:

| Key | Shown as | Set when |
| --- | --- | --- |
| `verified` | BZFlag player | the member signed in at bzflag.org |
| `bzflag_admin` | BZFlag admin | they are in one of the server's `adminGroups` |

## The round trip

A member picks the role's requirement in Discord, which opens
`/discord/link`:

1. bzo sends them to Discord's consent page, asking for `identify` and
   `role_connections.write`, with a random `state`.
2. Discord sends them back to `/discord/link/callback` with a code. bzo checks
   the `state`, trades the code for a token, and asks Discord who they are.
3. bzo sends them to bzflag.org's `weblogin`, as `/login` does
   (`docs/login.md`), with a random key in the path of the way back.
4. bzflag.org sends them to `/discord/link/bzflag/<key>`. bzo checks the token
   with `CHECKTOKENS`, asking about the same `adminGroups` as a login, writes
   their role connection to Discord -- platform "BZFlag", their callsign, and
   the two values above -- and saves the link.

Each `state` and key is good once and for ten minutes. The three routes share
`/login`'s rate limit. Every refusal is one of bzo's own fixed sentences in
plain text, never anything the query string carried.

The links are kept in `discord-links.json` beside `server.json`: Discord ID,
BZID, callsign, whether an admin, and when. The Discord token is used for the
role connection and then dropped, so nothing kept can act on a member's
account. Admin is a snapshot, as a login session's groups are: it changes when
the member links again.

## Nicknames

With `guildId` in the `discord` block, a member who links gets their callsign
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
webhook's URL in the `discord` block:

```json
"bridge": { "webhookUrl": "https://discord.com/api/webhooks/..." }
```

It needs no bot and none of the Linked Roles keys. On start the server logs
`Discord: public chat mirrored to a channel`.

What goes is what every player in the game sees: chat to all, and `/me`. Team
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
clients see too; bzo's own client puts them on the Chat tab, not Server. The
bot holds a gateway connection for it, so the app needs the Message Content
Intent (developer portal, Bot), and the bot needs to see and read the channel.
The channel is the one the bridge webhook posts to; there is nothing else to
set. The server logs `Discord: channel messages relayed into the game` and then
`[DISCORD] gateway ready as <bot>`.

The name is a linked member's callsign, marked `@` if their link found them in
an admin group and `+` otherwise; anyone else goes by their nickname in the
server. Mentions, channels and custom emoji read as names. Three lines of a
message at most, each up to 200 characters, and an attachment alone reads as
`[attachment]`. A bot's posts and the mirror's own never come back. A line
that starts with `/` is a command and is not relayed: running commands for
linked members is still to come (`docs/chat-bridge-plan.md`).

The gateway session is kept in `discord-gateway.json` beside `server.json`, so
a restart resumes it, and Discord then sends what was said while the server
was down.
