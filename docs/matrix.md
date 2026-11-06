# Matrix

The bundled `matrix` plugin (`plugins/matrix.cjs`, `docs/plugins.md`): a game
server's public chat and one Matrix room, both ways, through a Matrix account
of the bridge's own. Links, commands from linked members and an application
service are `docs/chat-bridge-plan.md`.

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
kept, as on the first start, the room's past is skipped.
